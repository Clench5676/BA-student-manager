// Thumbnails rendered in the page from the portrait skeletons: faces for the expression cards, busts for the switch
// card and the roster, cards for the popups. One hidden Spine player at a time (one WebGL context); results are
// in-memory blob URLs, never written anywhere.
import { withTimeout } from "./async.js";
import { applyAtlasAlpha } from "./spine-alpha.js";

import { spineAssetBase, forgetSpineAssets } from "./api.js";
import { lobbyIdle } from "./rest-pose.js";

const FRAMES = {
  // [width, height] of the rendered picture in CSS px: about what the cards show (a list card's window is 234 x 200
  // units, 150 CSS px wide on a 1920 px screen, so 384 px covers a 2x display and up to a 2560 px screen), never more
  face: [320, 277],
  bust: [480, 480],
  card: [384, 352],
  roster: [404, 456],
};
// the frame a card's other use shows: the list card and the big picture of the same skeleton are drawn in one load
const COMPANION = { card: "bust", bust: "card" };

// the looping idle of a portrait skeleton: Idle_01, else its first idle-like animation; null when it has none (a few
// NPC portraits only carry the "00" face), which leaves the setup pose under the face
export function idleAnimation(data) {
  if (data.findAnimation("Idle_01")) return "Idle_01";
  return data.animations.find((a) => /^idle/i.test(a.name))?.name || null;
}

const cache = new Map();   // key -> Promise<url>
const queue = [];          // { base, frame, expr, lobby, resolve, reject }
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
      success: (player) => { applyAtlasAlpha(player); resolve(player); },
      error: (_p, message) => { reject(new Error(message)); },
    });
    el.player = p;
  });
}

async function capture(player, el, frame, expr, lobby = false) {
  const [w, h] = FRAMES[frame];
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const state = player.animationState, data = player.skeleton.data;
  // the pose a still shows is the one the skeleton settles into: a lobby's idle as the lobby player chooses it, a
  // portrait's idle. The player starts the skeleton's first animation (a lobby's is its intro, Start_Idle_*), and an
  // animation set on top of it would mix in from it: the first frames would show the intro's first frame, mostly.
  const idle = lobby ? lobbyIdle(data) : idleAnimation(data);
  state.clearTracks();
  player.skeleton.setToSetupPose();
  const entry = idle ? state.setAnimation(0, idle, true) : state.setEmptyAnimation(0, 0);
  if (expr && player.skeleton.data.findAnimation(expr)) state.setAnimation(1, expr, true);
  state.apply(player.skeleton);
  player.skeleton.updateWorldTransform(spine.Physics.update);
  player.config.viewport = viewFor(player, frame, w / h);
  player.setViewport(entry.animation);
  await frames(3);
  const canvas = el.querySelector("canvas");
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null)));
}

const keyOf = (base, frame, expr) => `${base}|${frame}|${expr || ""}`;

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
        const player = await withTimeout(loadPlayer(base, el), 15000, `Thumbnail ${base}`);
        for (const q of batch) {
          try { q.resolve(await withTimeout(capture(player, el, q.frame, q.expr, q.lobby), 15000, `Thumbnail capture ${base}`)); } catch (err) { q.reject(err); }
        }
        await companions(player, el, base, batch);
      } catch (err) {
        for (const q of batch) q.reject(err);
      } finally {
        try { el.player?.dispose(); } catch (err) { console.error("Thumbnail dispose failed", base, err); }
        el.remove();
      }
    }
  } finally {
    running = false;
  }
}

// the other frame of a card, taken while the skeleton and its textures are loaded: asking for the big picture of a
// card later does not load them again. A request already queued for it is answered from this load; a failure here
// costs nothing, the frame is loaded when it is asked for.
async function companions(player, el, base, batch) {
  for (const frame of new Set(batch.map((q) => COMPANION[q.frame]).filter(Boolean))) {
    const key = keyOf(base, frame, null);
    const waiting = queue.find((q) => q.base === base && q.frame === frame && !q.expr);
    if (cache.has(key) && !waiting) continue;
    let url = null;
    try { url = await withTimeout(capture(player, el, frame, null, batch[0].lobby), 15000, `Thumbnail companion ${base}`); } catch { /* loaded when asked for */ }
    if (!url) continue;
    if (waiting && queue.includes(waiting)) { queue.splice(queue.indexOf(waiting), 1); waiting.resolve(url); }
    else if (!cache.has(key)) cache.set(key, Promise.resolve(url));
    else URL.revokeObjectURL(url);
  }
}

// thumb(base, "bust") -> Promise<blob url | null>; expr picks an expression for "face"; lobby: a memorial lobby's
// skeleton, which rests in its lobby idle (rest-pose.js). The promise has bump(): render this one before the rest of the
// queue (a card that scrolled into view).
export function thumb(base, frame = "bust", expr = null, lobby = false) {
  if (!base) return Promise.resolve(null);
  if (!/\/[a-f0-9]{64}\/skeleton$/.test(base)) {
    // the revision the files carry now is part of the key: a picture made before a switch is never reused after it,
    // and one made again for the same files comes from memory
    let inner = null, first = false;
    const outer = spineAssetBase(base).then(async (resolved) => {
      for (let attempt = 0; resolved && attempt < 2; attempt++) {
        inner = thumb(resolved, frame, expr, lobby);
        if (first) inner.bump?.(); // asked to go first before the files were resolved
        const url = await inner;
        if (url || attempt) return url;
        // A switch after the manifest can reject the revision's assets. Ask afresh and try the new files once.
        forgetSpineAssets(base.slice(0, base.lastIndexOf("/")));
        const fresh = await spineAssetBase(base);
        if (fresh === resolved) return null;
        resolved = fresh;
      }
      return null;
    }).catch((err) => { console.warn("thumbnail failed", base, err); return null; });
    outer.bump = () => { first = true; inner?.bump?.(); };
    return outer;
  }
  const key = keyOf(base, frame, expr);
  if (!cache.has(key)) {
    let item;
    const pending = new Promise((resolve, reject) => {
      item = { base, frame, expr, lobby, resolve, reject };
      queue.push(item);
      pump();
    }).catch((err) => {
      console.warn("thumbnail failed", base, err);
      if (cache.get(key) === pending) cache.delete(key);
      return null;
    });
    pending.bump = () => bump(item);
    cache.set(key, pending);
  }
  return cache.get(key);
}

function bump(item) {
  const at = queue.indexOf(item);
  if (at > 0) queue.unshift(...queue.splice(at, 1));
}

// render the requested ones of a skeleton first (e.g. the faces of the portrait being shown)
export function prioritise(base) {
  const prefix = base?.slice(0, base.lastIndexOf("/")) || "";
  queue.sort((a, b) => b.base.startsWith(prefix) - a.base.startsWith(prefix));
}

// drop cached thumbnails of skeletons whose files changed (after applying or updating a mod, or a library.changed
// event, whose cores are lower case while the catalog's keep the game's case): any case matches
export function forget(prefix = "") {
  forgetSpineAssets(prefix);
  const want = prefix.toLowerCase();
  for (const [key, p] of cache) {
    if (!key.toLowerCase().startsWith(want)) continue;
    p.then((url) => url && URL.revokeObjectURL(url));
    cache.delete(key);
  }
}
