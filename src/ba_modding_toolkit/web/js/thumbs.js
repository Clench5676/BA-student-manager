// Thumbnails rendered in the page from the portrait skeletons: faces for the expression cards, busts for the switch
// card and the roster, cards for the popups. One hidden Spine player at a time (one WebGL context); results are
// in-memory blob URLs, never written anywhere.

const FRAMES = {
  // [width, height] of the rendered picture in CSS px
  face: [320, 277],
  bust: [480, 480],
  card: [480, 440],
  roster: [404, 456],
};

// the looping idle of a portrait skeleton: Idle_01, else its first idle-like animation; null when it has none (a few
// NPC portraits only carry the "00" face), which leaves the setup pose under the face
export function idleAnimation(data) {
  if (data.findAnimation("Idle_01")) return "Idle_01";
  return data.animations.find((a) => /^idle/i.test(a.name))?.name || null;
}

const cache = new Map();   // key -> Promise<url>
const queue = [];          // { base, frame, expr, resolve, reject }
let running = false;
let host = null;

function hostEl() {
  if (!host) {
    host = document.createElement("div");
    host.className = "thumb-host";
    document.body.appendChild(host);
  }
  return host;
}

// the expression overlay slots (eyes, "0N_" attachments) mark the face on Blue Archive portraits; halos are named
// like them on some ("01_halo" on Hina) and are left out
export const isFacePart = (slot, attachment) => {
  const names = `${slot} ${attachment}`;
  return /eye|face|^0\d_|default/i.test(names) && !/halo/i.test(names);
};
const isHalo = (part) => /halo/i.test(`${part.slot} ${part.attachment}`);

// faceOf(parts) -> the face box {x0, y0, x1, y1} or null. parts: the skeleton's shown attachments in its idle,
// { slot, attachment, box, expr }, expr when an expression animation ("00", "01", ...) switches the slot. The parts
// named like a face, else the parts the expressions switch (many NPC portraits name their face slot "0", "00" or
// "defalt"), each no larger than a face can be and halos left out: a whole body some NPCs (citizen_animal1) swap per
// expression is no face.
export function faceOf(parts) {
  const union = (list) => list.reduce((b, { box: p }) => (b
    ? { x0: Math.min(b.x0, p.x0), y0: Math.min(b.y0, p.y0), x1: Math.max(b.x1, p.x1), y1: Math.max(b.y1, p.y1) } : { ...p }), null);
  const named = parts.filter((p) => isFacePart(p.slot, p.attachment));
  if (named.length) return union(named);
  const faceSized = ({ box: b }) => b.x1 - b.x0 <= NOT_FACE && b.y1 - b.y0 <= NOT_FACE;
  return union(parts.filter((p) => p.expr && !isHalo(p) && faceSized(p)));
}

function faceBox(skeleton) {
  const verts = new Float32Array(4096);
  // the slots the expression animations switch attachments on
  const expr = new Set();
  for (const a of skeleton.data.animations) {
    if (!/^\d{2}$/.test(a.name)) continue;
    for (const t of a.timelines) if (t instanceof spine.AttachmentTimeline) expr.add(t.slotIndex);
  }
  const parts = [];
  skeleton.slots.forEach((slot, i) => {
    const att = slot.attachment;
    if (!att) return;
    let count = 0;
    if (att instanceof spine.RegionAttachment) { att.computeWorldVertices(slot, verts, 0, 2); count = 8; }
    else if (att instanceof spine.MeshAttachment) { count = att.worldVerticesLength; if (count > verts.length) return; att.computeWorldVertices(slot, 0, count, verts, 0, 2); }
    if (!count) return;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let k = 0; k < count; k += 2) {
      box.x0 = Math.min(box.x0, verts[k]); box.x1 = Math.max(box.x1, verts[k]);
      box.y0 = Math.min(box.y0, verts[k + 1]); box.y1 = Math.max(box.y1, verts[k + 1]);
    }
    parts.push({ slot: slot.data.name, attachment: att.name, box, expr: expr.has(i) });
  });
  return faceOf(parts);
}

// a face's width in skeleton units, held within what faces measure: every portrait has the game's scale and faces are
// 170 to 400 units wide (most 190 to 260), so eyes alone frame like a whole face. A "face" wider than NOT_FACE is a
// body part named like one (a few NPCs): the bounds stand in.
export const FACE_W = [170, 400];
export const NOT_FACE = 600;

// thumbFrame(found, bounds, frame, aspect) -> the skeleton rect {x, y, width, height} a thumbnail shows. found: the
// face box {x0, y0, x1, y1} or null; bounds: the skeleton's {x, y, w, h}. Every frame is sized on the face, never on the
// bounds, so a weapon, wings or a prop beside the character never shrink her; the bounds only stand in without a face.
// face: the whole head (face and hair), the face a little below the centre; bust and roster: head down to the waist;
// card: the head.
export function thumbFrame(found, bounds, frame, aspect) {
  const face = found && found.x1 - found.x0 <= NOT_FACE ? found : null;
  const faceW = face ? Math.min(Math.max(face.x1 - face.x0, FACE_W[0]), FACE_W[1]) : bounds.w * 0.17;
  const cx = face ? (face.x0 + face.x1) / 2 : bounds.x + bounds.w / 2;
  const cyFace = face ? (face.y0 + face.y1) / 2 : bounds.y + bounds.h * 0.8;
  const bust = frame === "bust" || frame === "roster";
  const w = bust ? faceW * 3.8 : frame === "card" ? faceW * 3.4 : faceW * 3.3;
  const h = w / aspect;
  const cy = bust ? cyFace - h * 0.2 : frame === "card" ? cyFace - h * 0.06 : cyFace + h * 0.07;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

function viewFor(p, frame, aspect) {
  const offset = new spine.Vector2(), size = new spine.Vector2();
  p.skeleton.getBounds(offset, size, []);
  const rect = thumbFrame(faceBox(p.skeleton), { x: offset.x, y: offset.y, w: size.x, h: size.y }, frame, aspect);
  return { ...rect, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} };
}

const frames = (n) => new Promise((resolve) => {
  const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

function loadPlayer(base, el) {
  return new Promise((resolve, reject) => {
    const p = new spine.SpinePlayer(el, {
      skeleton: `${base}.skel`, atlas: `${base}.atlas`, animation: undefined, // capture() sets the idle (some NPCs have no Idle_01)
      premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000",
      showControls: false, showLoading: false, preserveDrawingBuffer: true,
      viewport: { padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0 },
      success: (player) => resolve(player),
      error: (_p, message) => { reject(new Error(message)); },
    });
    el.player = p;
  });
}

async function capture(player, el, frame, expr) {
  const [w, h] = FRAMES[frame];
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const state = player.animationState, idle = idleAnimation(player.skeleton.data);
  const entry = idle ? state.setAnimation(0, idle, true) : state.setEmptyAnimation(0, 0);
  state.clearTrack(1);
  if (expr && player.skeleton.data.findAnimation(expr)) state.setAnimation(1, expr, true);
  state.apply(player.skeleton);
  player.skeleton.updateWorldTransform(spine.Physics.update);
  player.config.viewport = viewFor(player, frame, w / h);
  player.setViewport(entry.animation);
  await frames(3);
  const canvas = el.querySelector("canvas");
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null)));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const base = queue[0].base;
      const batch = queue.filter((q) => q.base === base);
      for (const q of batch) queue.splice(queue.indexOf(q), 1);
      const el = document.createElement("div");
      el.className = "thumb-player";
      const [w, h] = FRAMES[batch[0].frame];
      Object.assign(el.style, { width: `${w}px`, height: `${h}px` });
      hostEl().appendChild(el);
      try {
        const player = await loadPlayer(base, el);
        for (const q of batch) {
          try { q.resolve(await capture(player, el, q.frame, q.expr)); } catch (err) { q.reject(err); }
        }
      } catch (err) {
        for (const q of batch) q.reject(err);
      } finally {
        el.player?.dispose();
        el.remove();
      }
    }
  } finally {
    running = false;
  }
}

// thumb(base, "bust") -> Promise<blob url | null>; expr picks an expression for "face"
export function thumb(base, frame = "bust", expr = null) {
  const key = `${base}|${frame}|${expr || ""}`;
  if (!cache.has(key)) {
    cache.set(key, new Promise((resolve, reject) => {
      queue.push({ base, frame, expr, resolve, reject });
      pump();
    }).catch((err) => { console.warn("thumbnail failed", base, err); cache.delete(key); return null; }));
  }
  return cache.get(key);
}

// render the requested ones of a skeleton first (e.g. the faces of the portrait being shown)
export function prioritise(base) {
  queue.sort((a, b) => (b.base === base) - (a.base === base));
}

// drop cached thumbnails of skeletons whose files changed (after applying or updating a mod)
export function forget(prefix = "") {
  for (const [key, p] of cache) {
    if (!key.startsWith(prefix)) continue;
    p.then((url) => url && URL.revokeObjectURL(url));
    cache.delete(key);
  }
}
