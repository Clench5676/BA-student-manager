// Thumbnails rendered in the page from the portrait skeletons: faces for the expression cards, busts for the switch
// card and the roster, cards for the popups. One hidden Spine player at a time (one WebGL context); results are
// in-memory blob URLs, never written anywhere.
import { artBounds, settle } from "./lobby-health.js";
import { specialView } from "./special-view.js";
import { withTimeout } from "./async.js";
import { loadPlayer as spinePlayer } from "./spine-load.js";
import { ensureSpine, spineAllowed } from "./spine-runtime.js";

import { spineAssetBase, forgetSpineAssets } from "./api.js";
import { lobbyIdle } from "./rest-pose.js";
import { lobbyStillViewport } from "./lobby-still.js";
import { previewError } from "./preview-error.js";

const FRAMES = {
  // [width, height] of the rendered picture in CSS px: about what the cards show (a list card's window is 234 x 200
  // units, 150 CSS px wide on a 1920 px screen, so 384 px covers a 2x display and up to a 2560 px screen), never more
  face: [320, 277],
  bust: [480, 480],
  card: [384, 352],
  roster: [404, 456],
  portrait: [480, 880],
  landscape: [640, 360],
};
// the frame a card's other use shows: the list card and the big picture of the same skeleton are drawn in one load
const COMPANION = { card: "bust", bust: "card" };

// the looping idle of a portrait skeleton: Idle_01, else its first idle-like animation; null when it has none (a few
// NPC portraits only carry the "00" face), which leaves the setup pose under the face
export function idleAnimation(data) {
  if (data.findAnimation("Idle_01")) return "Idle_01";
  return data.animations.find((a) => /^idle/i.test(a.name))?.name || null;
}

const cache = new Map();   // key -> cached picture or a request with its consumers
const queue = [];
const scopes = new Set();
let running = false, active = null, preferred = "";
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
  const bust = frame === "bust" || frame === "roster" || frame === "portrait";
  const w = bust ? faceW * 3.8 : frame === "card" ? faceW * 3.4 : faceW * 3.3;
  const h = w / aspect;
  const cy = bust ? cyFace - h * 0.2 : frame === "card" ? cyFace - h * 0.06 : cyFace + h * 0.07;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

function viewFor(p, frame, aspect, framing, lobby = false) {
  if (lobby && !framing) return lobbyStillViewport(p.bamtLobbyFrame, aspect);
  if (framing || frame === "landscape") {
    const r = specialView(artBounds(p.skeleton), framing || "scene", aspect);
    return { x: r.x, y: r.y, width: r.w, height: r.h, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} };
  }
  const offset = new spine.Vector2(), size = new spine.Vector2();
  p.skeleton.getBounds(offset, size, []);
  const rect = thumbFrame(faceBox(p.skeleton), { x: offset.x, y: offset.y, w: size.x, h: size.y }, frame, aspect);
  return { ...rect, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} };
}

function loadPlayer(base, el, signal, onError) {
  return spinePlayer((config) => new spine.SpinePlayer(el, config), {
    skeleton: `${base}.skel`, atlas: `${base}.atlas`, animation: undefined,
    premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000",
    showControls: false, showLoading: false, preserveDrawingBuffer: true,
    // capture() supplies the actual frame. Do not sample the first animation's bounds a hundred times first.
    viewport: { x: 0, y: 0, width: 1, height: 1, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} },
  }, { signal, onError, manual: true });
}

async function capture(player, el, frame, expr, lobby, framing, background, signal) {
  const [w, h] = FRAMES[frame];
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const state = player.animationState, data = player.skeleton.data;
  // Stills own their frame clock, including in an unfocused window or an off-screen host.
  player.stopRendering();
  player.paused = true;
  // the pose a still shows is the one the skeleton settles into: a lobby's idle as the lobby player chooses it, a
  // portrait's idle. The player starts the skeleton's first animation (a lobby's is its intro, Start_Idle_*), and an
  // animation set on top of it would mix in from it: the first frames would show the intro's first frame, mostly.
  const idle = lobby ? lobbyIdle(data) : idleAnimation(data);
  state.clearTracks();
  player.skeleton.setToSetupPose();
  let entry = idle ? state.setAnimation(0, idle, true) : state.setEmptyAnimation(0, 0);
  if (framing) { settle(player, { name: "thumbnail" }, null, () => {}); entry = state.getCurrent(0); }
  // The main portrait also applies 00. Some story portraits attach their entire body on that track;
  // an empty setup pose cannot produce a still, however often the same frame is drawn.
  const expression = expr || (!lobby && !framing ? "00" : null);
  if (expression && data.findAnimation(expression)) state.setAnimation(1, expression, true);
  state.apply(player.skeleton);
  player.skeleton.updateWorldTransform(spine.Physics.update);
  player.config.viewport = viewFor(player, frame, w / h, framing, lobby);
  player.setViewport(entry.animation);
  let valid = false;
  // drawFrame(false) resizes and renders synchronously without scheduling a visibility-dependent RAF.
  // Inspect that exact frame before adding a background; a transparent framebuffer is never art.
  for (let attempt = 0; attempt < 6 && !signal.aborted; attempt++) {
    player.drawFrame(false);
    const gl = player.context?.gl;
    if (!gl || gl.isContextLost?.()) continue;
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (!(width > 0 && height > 0)) continue;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (hasThumbnailInk(pixels)) { valid = true; break; }
  }
  if (signal.aborted) return null;
  if (!valid) throw new Error(`No visible pixels (frame=${frame}, idle=${idle || "setup"}, expression=${expression || "none"}, viewport=${JSON.stringify(player.config.viewport)})`);
  // Freeze the validated draw before background loading or encoding can yield to the running player.
  const portrait = el.querySelector("canvas"), still = document.createElement("canvas");
  still.width = portrait.width; still.height = portrait.height;
  still.getContext("2d").drawImage(portrait, 0, 0);
  const canvas = await collectionStill(still, background, signal).catch((err) => {
    if (!signal.aborted) console.warn("Thumbnail background unavailable", background, err);
    return still;
  });
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b && !signal.aborted ? URL.createObjectURL(b) : null)));
}

// The capture buffer is cleared transparent before drawing. Uniform opaque pixels may be a solid-colour Mod;
// colour variation is not evidence of a valid source. Validate before compositing any collection background.
export function hasThumbnailInk(pixels) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) return true;
  return false;
}

// Collection portraits fill their texture with the variant background before the transparent Spine still.
export async function collectionStill(portrait, background, signal, load = (url, options) => import("./ngui.js").then((ui) => ui.load(url, options))) {
  if (!background) return portrait;
  const image = await load(background, { signal });
  if (signal?.aborted) return portrait;
  const canvas = document.createElement("canvas");
  canvas.width = portrait.width; canvas.height = portrait.height;
  const g = canvas.getContext("2d"), scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  g.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  g.drawImage(portrait, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const keyOf = (base, frame, expr, lobby = false, framing = null, background = null) => `${base}|${frame}|${expr || ""}|${lobby}|${framing || ""}|${background || ""}`;

// A fallback retains queue priority and cancellation: an abandoned view must never publish a late image.
export function withThumbnailFallback(picture, fallback) {
  const result = Promise.resolve(picture).catch(() => null).then((url) => picture?.signal?.aborted ? null : url || fallback());
  result.thumbnail = true;
  result.signal = picture?.signal;
  result.bump = () => picture?.bump?.();
  result.failure = () => picture?.failure?.();
  return result;
}

// Consumers share a render, but cancelling one view must not cancel another view's use of it.
function subscribe(item, signal) {
  if (!signal && item.promise) return item.promise;
  let client;
  const promise = new Promise((resolve) => {
    const finish = (url) => {
      signal?.removeEventListener("abort", cancel);
      item.clients.delete(client);
      resolve(url);
    };
    const cancel = () => {
      finish(null);
      if (!item.settled && !item.clients.size) {
        complete(item, null);
        if (active?.base === item.base && !queue.some((q) => q.base === item.base && !q.settled)) active.controller.abort();
      }
    };
    client = finish;
    if (signal?.aborted) { cancel(); return; }
    if (item.settled) { resolve(item.url); return; }
    item.clients.add(client);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  promise.bump = () => bump(item);
  promise.thumbnail = true;
  promise.signal = signal;
  promise.failure = () => item.error;
  if (!signal) item.promise = promise;
  return promise;
}

function complete(item, url, error = null) {
  if (item.settled) { if (url) URL.revokeObjectURL(url); return; }
  item.settled = true;
  item.url = url;
  item.error = error;
  const at = queue.indexOf(item);
  if (at >= 0) queue.splice(at, 1);
  if (!url && cache.get(item.key) === item) cache.delete(item.key);
  if (error) previewError(error, item.base, `thumbnail:${item.frame}`);
  for (const done of [...item.clients]) done(url);
  if (url && item.forgotten) URL.revokeObjectURL(url);
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      try {
        if (!await ensureSpine()) {
          for (const item of [...queue]) complete(item, null);
          break;
        }
      } catch (err) {
        for (const item of [...queue]) complete(item, null, err);
        break;
      }
      const first = queue[0], base = first.base, controller = new AbortController(), { signal } = controller;
      active = { base, controller, items: new Set(queue.filter((q) => q.base === base)) };
      const el = document.createElement("div");
      el.className = "thumb-player";
      const [w, h] = FRAMES[queue[0].frame];
      Object.assign(el.style, { width: `${w}px`, height: `${h}px` });
      hostEl().appendChild(el);
      // One skeleton gets one budget, including all its captures. A broken encoder cannot cost 15 s per face.
      const timer = setTimeout(() => controller.abort(new Error(`Thumbnail ${base}: timed out`)), 8000);
      let load;
      try {
        load = loadPlayer(base, el, signal, (err) => controller.abort(err));
        const player = await load.ready;
        if (!player || signal.aborted) {
          for (const q of active.items) complete(q, null, signal.reason?.name === "AbortError" ? null : signal.reason);
          continue;
        }
        if (first.lobby && !first.framing) {
          const url = `${base.slice(0, base.lastIndexOf("/"))}/framing.json`;
          player.bamtLobbyFrame = await withTimeout(fetch(url, { signal }).then((r) => {
            if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
            return r.json();
          }), 15000, "Lobby still camera", { signal }).catch((err) => {
            if (signal.aborted) throw err;
            console.warn("Lobby still camera unavailable; using standard game placement", err);
            return null;
          });
        }
        const batch = [];
        let q = first.settled ? queue.find((q) => q.base === base) : first;
        while (!signal.aborted && q && !q.settled) {
          const url = await withTimeout(capture(player, el, q.frame, q.expr, q.lobby, q.framing, q.background, signal), 3000, `Thumbnail capture ${base}`, { signal });
          batch.push(q);
          complete(q, url, !url && !signal.aborted ? new Error(`PNG encoding failed (frame=${q.frame})`) : null);
          // Let a visible card's bump take effect before the next capture.
          await Promise.resolve();
          q = queue[0]?.base === base ? queue[0] : null;
        }
        if (!signal.aborted) await companions(player, el, base, batch, signal);
      } catch (err) {
        for (const q of active.items) complete(q, null, signal.aborted && signal.reason?.name === "AbortError" ? null : err);
      } finally {
        clearTimeout(timer);
        controller.abort();
        load?.dispose();
        el.remove();
        active = null;
      }
    }
  } finally { running = false; }
}

// Take the other frame while the skeleton is loaded, unless visible work for another skeleton is waiting.
async function companions(player, el, base, batch, signal) {
  for (const q of batch) {
    const frame = COMPANION[q.frame];
    if (!frame || queue.length) continue;
    const key = keyOf(base, frame, null, q.lobby, q.framing, q.background);
    if (cache.has(key)) continue;
    const url = await withTimeout(capture(player, el, frame, null, q.lobby, q.framing, q.background, signal), 3000, `Thumbnail companion ${base}`, { signal });
    if (!url) continue;
    const waiting = cache.get(key);
    if (waiting && !waiting.settled) complete(waiting, url);
    else if (waiting) URL.revokeObjectURL(url);
    else cache.set(key, { key, base, frame, lobby: q.lobby, framing: q.framing, background: q.background, url, settled: true, clients: new Set() });
  }
}

// A detail generation shares each manifest answer until it changes. Re-entering the page revalidates the source;
// cancelling also stops manifest deadlines, queued renders and the active player when nobody else needs it.
export function thumbnailScope() {
  const controller = new AbortController(), manifests = new Map();
  scopes.add(manifests);
  return {
    signal: controller.signal,
    thumb: (base, frame = "bust", expr = null, lobby = false, framing = null, background = null) => request(base, frame, expr, lobby, framing, background, { signal: controller.signal, manifests }),
    cancel: () => {
      controller.abort(); manifests.clear();
      scopes.delete(manifests);
      if (active && !queue.some((q) => q.base === active.base)) active.controller.abort();
    },
  };
}

// thumb(base, frame) -> Promise<blob url | null>; expr selects a face, lobby selects its idle, framing a special fit.
// bump() puts a visible card before queued work. Scopes add cancellation and share the source's manifest.
export function thumb(base, frame = "bust", expr = null, lobby = false, framing = null, background = null) {
  return request(base, frame, expr, lobby, framing, background);
}

function request(base, frame = "bust", expr = null, lobby = false, framing = null, background = null, { signal, manifests } = {}) {
  if (!base || signal?.aborted || !spineAllowed()) return Promise.resolve(null);
  if (!/\/[a-f0-9]{64}\/skeleton$/.test(base)) {
    const resolveBase = () => {
      if (!manifests) return spineAssetBase(base);
      if (!manifests.has(base)) {
        const asking = spineAssetBase(base, { signal }).catch((err) => { if (manifests.get(base) === asking) manifests.delete(base); throw err; });
        manifests.set(base, asking);
      }
      return manifests.get(base);
    };
    const refreshBase = async (resolved) => {
      if (manifests) {
        const previous = manifests.get(base);
        if (previous && await previous !== resolved) return previous;
        // Faces rejected together must join the first refresh, rather than invalidating each other's requests.
        if (manifests.get(base) === previous) manifests.delete(base);
      } else forgetSpineAssets(base.slice(0, base.lastIndexOf("/")));
      return resolveBase();
    };
    let inner = null, first = false;
    const outer = resolveBase().then(async (resolved) => {
      for (let attempt = 0; resolved && !signal?.aborted && attempt < 2; attempt++) {
        inner = request(resolved, frame, expr, lobby, framing, background, { signal });
        if (first) inner.bump?.();
        const url = await inner;
        if (signal?.aborted || url || attempt) return url;
        if (!/status 404|HTTP 404/.test(String(inner.failure?.()))) return null;
        const fresh = await refreshBase(resolved);
        if (fresh === resolved) return null;
        resolved = fresh;
      }
      return null;
    }).catch((err) => { if (!signal?.aborted) previewError(err, base, `thumbnail:${frame}`); return null; });
    outer.bump = () => { first = true; inner?.bump?.(); };
    outer.thumbnail = true;
    outer.signal = signal;
    return outer;
  }
  const key = keyOf(base, frame, expr, lobby, framing, background);
  if (!cache.has(key)) {
    const item = { key, base, frame, expr, lobby, framing, background, clients: new Set(), settled: false };
    cache.set(key, item);
    queue.push(item);
    if (active?.base === base && !active.controller.signal.aborted) active.items.add(item);
    if (preferred) queue.sort((a, b) => b.base.startsWith(preferred) - a.base.startsWith(preferred));
    queueMicrotask(pump);
  }
  const picture = subscribe(cache.get(key), signal);
  if (frame !== "portrait") return picture;
  // Reuse only a still of these exact source bytes. Never borrow the other similarly named variant's art,
  // a face-only crop, or a thumbnail from before an install/update changed the revision.
  return withThumbnailFallback(picture, () => {
    for (const otherFrame of ["roster", "bust", "card"]) {
      const still = cache.get(keyOf(base, otherFrame, expr, lobby, framing, background));
      if (still?.url) return still.url;
    }
    return null;
  });
}

function bump(item) {
  const at = queue.indexOf(item);
  if (at > 0) queue.unshift(...queue.splice(at, 1));
}

// Remember the preference before asynchronous manifests have populated the queue.
export function prioritise(base) {
  preferred = base ? `${base.slice(0, base.lastIndexOf("/"))}/` : "";
  queue.sort((a, b) => b.base.startsWith(preferred) - a.base.startsWith(preferred));
}

// Drop cached pictures of changed files; comparisons ignore the catalog's core spelling.
export function forget(prefix = "") {
  forgetSpineAssets(prefix);
  const want = prefix.toLowerCase();
  for (const manifests of scopes) for (const base of manifests.keys()) if (base.toLowerCase().startsWith(want)) manifests.delete(base);
  for (const [key, item] of cache) {
    if (!key.toLowerCase().startsWith(want)) continue;
    if (item.url) URL.revokeObjectURL(item.url);
    else item.forgotten = true;
    cache.delete(key);
  }
}
