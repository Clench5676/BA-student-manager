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

// the expression overlay slots (eyes, "0N_" attachments) mark the face on Blue Archive portraits
function faceBox(skeleton) {
  const verts = new Float32Array(4096);
  let box = null;
  for (const slot of skeleton.slots) {
    const att = slot.attachment;
    if (!att || !/eye|face|^0\d_|default/i.test(`${slot.data.name} ${att.name}`)) continue;
    let count = 0;
    if (att instanceof spine.RegionAttachment) { att.computeWorldVertices(slot, verts, 0, 2); count = 8; }
    else if (att instanceof spine.MeshAttachment) { count = att.worldVerticesLength; if (count > verts.length) continue; att.computeWorldVertices(slot, 0, count, verts, 0, 2); }
    for (let i = 0; i < count; i += 2) {
      box = box || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      box.x0 = Math.min(box.x0, verts[i]); box.x1 = Math.max(box.x1, verts[i]);
      box.y0 = Math.min(box.y0, verts[i + 1]); box.y1 = Math.max(box.y1, verts[i + 1]);
    }
  }
  return box;
}

function viewFor(p, frame, aspect) {
  const offset = new spine.Vector2(), size = new spine.Vector2();
  p.skeleton.getBounds(offset, size, []);
  const face = faceBox(p.skeleton);
  const faceW = face ? face.x1 - face.x0 : size.x * 0.17;
  const cx = face ? (face.x0 + face.x1) / 2 : offset.x + size.x / 2;
  const cyFace = face ? (face.y0 + face.y1) / 2 : offset.y + size.y * 0.8;
  // face: head and hair; bust and roster: head down to the waist; card: framed on the face only, so every skeleton
  // gets the same head size whatever it holds
  const w = frame === "bust" || frame === "roster" ? Math.max(faceW * 3.8, size.x * 0.42) : frame === "card" ? faceW * 3.4 : Math.max(faceW * 2.9, size.x * 0.34);
  const h = w / aspect;
  const cy = frame === "bust" || frame === "roster" ? cyFace - h * 0.2 : frame === "card" ? cyFace - h * 0.06 : cyFace + h * 0.12;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} };
}

const frames = (n) => new Promise((resolve) => {
  const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
});

function loadPlayer(base, el) {
  return new Promise((resolve, reject) => {
    const p = new spine.SpinePlayer(el, {
      skeleton: `${base}.skel`, atlas: `${base}.atlas`, animation: "Idle_01",
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
  const state = player.animationState;
  state.setAnimation(0, player.skeleton.data.findAnimation("Idle_01") ? "Idle_01" : player.skeleton.data.animations[0].name, true);
  state.clearTrack(1);
  if (expr && player.skeleton.data.findAnimation(expr)) state.setAnimation(1, expr, true);
  state.apply(player.skeleton);
  player.skeleton.updateWorldTransform(spine.Physics.update);
  player.config.viewport = viewFor(player, frame, w / h);
  player.setViewport(state.tracks[0]?.animation?.name || "Idle_01");
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
