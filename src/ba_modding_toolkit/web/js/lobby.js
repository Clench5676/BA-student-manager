// Memorial lobby for the detail screen's second tab, framed like the game.
// The lobby's UILobbyElement prefab (lobby.json, read by the server) places every skeleton in NGUI units around the
// prefab root, the screen centre; at 16:9 the game shows the 2960 x 1665 units G around it. Fullscreen shows exactly G.
// The left view puts the head-pat point (Touch_Point) left of the panel and stays inside the painted rect P, the
// largest rectangle around G that the lobby's opaque art covers, so neither view shows a blank edge; switching between
// them crossfades. Dialogue sequences play the talk animations (Talk_NN_M with Talk_NN_A), their voices and a subtitle.
// The lines and voices come from Kivo (setLines), matched by the voice clip names the talk animations carry as Spine
// events. The edge extension (border pixels stretched outwards and blurred) is only a fallback for mods whose art does
// not cover the view.
import { spineFiles } from "./api.js";

const STAGE = { w: 1920, h: 1080 };
const GAME = { x: -1480, y: -832.5, w: 2960, h: 1665 };  // lobby.json "view": the game's 16:9 view in NGUI units
const FADE_MS = 450;        // the switch crossfade, in step with the UI slide (app.css .45s)

let players = [], current = null, mode = "left", extendTimer = null, chain = null, token = 0;
let lines = {}, muted = false, volume = 0.8, cueTimers = [], audios = [], subtitleTimer = null, lineOf = (l) => l?.["zh-CN"] || "";

const base = (core) => `/asset/spine/lobby/${encodeURIComponent(core)}/`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isBg = (n) => /background|_bg\b|bg_/i.test(n);
const game = () => (current?.info?.view ? { ...current.info.view } : { ...GAME });

// the layers of a lobby in the prefab's draw order with its offsets and scales; skeletons the prefab keeps inactive
// (talk-only scenes) are left out. Without prefab data every skeleton sits at the standard place, backgrounds first.
async function layersOf(core) {
  const [files, info] = await Promise.all([
    fetch(spineFiles("lobby", core)).then((r) => (r.ok ? r.json() : [])),
    fetch(`${base(core)}lobby.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const skels = new Set(files.filter((f) => f.endsWith(".skel")).map((f) => f.slice(0, -5)));
  const atlases = new Set(files.filter((f) => f.endsWith(".atlas")).map((f) => f.slice(0, -6)));
  const ok = (n) => skels.has(n) && atlases.has(n);
  // equal sorting orders (akari_home before akari_bg in the prefab): background-named skeletons first
  let list = (info?.layers || []).filter((l) => l.active && ok(l.name))
    .sort((a, b) => a.order - b.order || isBg(b.name) - isBg(a.name) || a.index - b.index);
  if (!list.length) {
    list = [...skels].filter(ok).sort((a, b) => isBg(b) - isBg(a) || a.localeCompare(b))
      .map((name, index) => ({ name, x: 0, y: -962, scale: 1, index, skin: null, animation: null }));
  }
  return { info, layers: list.map((l) => ({ ...l, spine: `${base(core)}${encodeURIComponent(l.name)}` })) };
}

// voice clip names as Kivo keys them: "Images/sound/Hoshino_MemorialLobby_3_1.ogg" -> "hoshino_memoriallobby_3_1"
const clipId = (name) => name.toLowerCase().replace(/\\/g, "/").split("/").pop().replace(/\.(ogg|wav|mp3)$/, "").replace(/_new$/, "");
// the looping idle: the SpineCharacter's idle clip, else Idle_01, else the prefab's start animation; never an intro
// (Hasumi_home's prefab starts "Start_Idle", which must not loop)
function idleOf(data, layer) {
  const ok = (n) => n && !/^start_/i.test(n) && data.findAnimation(n);
  return [current?.info?.idle?.[layer.name], "Idle_01", layer.animation].find(ok)
    || data.animations.find((a) => ok(a.name) && a.name !== "Dummy")?.name || data.animations[0]?.name;
}

// --- painted rect P: opaque, normal-blend triangles of every layer, over a few idle poses, on a 16-unit grid ---
const CELL = 16, SAMPLES = 6;
function paintedRect(loaded, G) {
  const X0 = G.x - G.w, Y0 = G.y - G.h, gw = Math.ceil((G.w * 3) / CELL), gh = Math.ceil((G.h * 3) / CELL);
  const acc = new Uint8Array(gw * gh).fill(1), cur = new Uint8Array(gw * gh);
  const tri = (ax, ay, bx, by, cx, cy) => {
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) return;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - X0) / CELL)), i1 = Math.min(gw - 1, Math.floor((Math.max(ax, bx, cx) - X0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - Y0) / CELL)), j1 = Math.min(gh - 1, Math.floor((Math.max(ay, by, cy) - Y0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = X0 + (i + 0.5) * CELL, py = Y0 + (j + 0.5) * CELL;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area, w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) cur[j * gw + i] = 1;
    }
  };
  const QUAD = [0, 1, 2, 2, 3, 0];
  for (let k = 0; k < SAMPLES; k++) {
    cur.fill(0);
    for (const l of loaded) {
      const data = l.player.skeleton.data, sk = new spine.Skeleton(data), anim = idleOf(data, l);
      if (l.skin) try { sk.setSkinByName(l.skin); } catch { /* the default skin */ }
      sk.setToSetupPose();
      if (anim) {
        const st = new spine.AnimationState(new spine.AnimationStateData(data));
        st.setAnimation(0, anim, true);
        st.update((data.findAnimation(anim).duration * k) / SAMPLES);
        st.apply(sk);
      }
      sk.updateWorldTransform(spine.Physics.update);
      for (const slot of sk.drawOrder) {
        const a = slot.getAttachment();
        // additive FX and see-through parts never count as painted
        if (!a || !slot.bone.active || slot.data.blendMode !== spine.BlendMode.Normal) continue;
        if (slot.color.a * (a.color ? a.color.a : 1) < 0.9) continue;
        let v, tris;
        if (a instanceof spine.RegionAttachment) { v = new Float32Array(8); a.computeWorldVertices(slot, v, 0, 2); tris = QUAD; }
        else if (a instanceof spine.MeshAttachment) { v = new Float32Array(a.worldVerticesLength); a.computeWorldVertices(slot, 0, a.worldVerticesLength, v, 0, 2); tris = a.triangles; }
        else continue;
        const X = (n) => l.x + v[n * 2] * l.scale, Y = (n) => l.y + v[n * 2 + 1] * l.scale;
        for (let t = 0; t < tris.length; t += 3) tri(X(tris[t]), Y(tris[t]), X(tris[t + 1]), Y(tris[t + 1]), X(tris[t + 2]), Y(tris[t + 2]));
      }
    }
    for (let i = 0; i < acc.length; i++) acc[i] &= cur[i];
  }
  const full = (i0, i1, j0, j1) => { for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!acc[j * gw + i]) return false; return true; };
  const r = { i0: Math.floor((G.x + 1 - X0) / CELL), i1: Math.floor((G.x + G.w - 1 - X0) / CELL), j0: Math.floor((G.y + 1 - Y0) / CELL), j1: Math.floor((G.y + G.h - 1 - Y0) / CELL) };
  const covered = full(r.i0, r.i1, r.j0, r.j1);
  // art that does not cover the game view (a mod): start from the covered middle of it
  while (!full(r.i0, r.i1, r.j0, r.j1) && r.i1 - r.i0 > 8 && r.j1 - r.j0 > 8) { r.i0++; r.i1--; r.j0++; r.j1--; }
  // then grow each side while the next column or row is fully painted; parts parked off screen behind a transparent
  // gap (intro props, a second stage set) are never reached
  for (let moved = true; moved;) {
    moved = false;
    if (r.i0 > 0 && full(r.i0 - 1, r.i0 - 1, r.j0, r.j1)) { r.i0--; moved = true; }
    if (r.i1 < gw - 1 && full(r.i1 + 1, r.i1 + 1, r.j0, r.j1)) { r.i1++; moved = true; }
    if (r.j0 > 0 && full(r.i0, r.i1, r.j0 - 1, r.j0 - 1)) { r.j0--; moved = true; }
    if (r.j1 < gh - 1 && full(r.i0, r.i1, r.j1 + 1, r.j1 + 1)) { r.j1++; moved = true; }
  }
  return { x0: X0 + r.i0 * CELL, x1: X0 + (r.i1 + 1) * CELL, y0: Y0 + r.j0 * CELL, y1: Y0 + (r.j1 + 1) * CELL, covered };
}
// the layers' setup-pose bounds, the painted area of the fallback for art that hardly covers the view
function boundsRect(loaded) {
  const out = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const l of loaded) {
    const sk = new spine.Skeleton(l.player.skeleton.data), o = new spine.Vector2(), s = new spine.Vector2();
    sk.setToSetupPose();
    sk.updateWorldTransform(spine.Physics.update);
    sk.getBounds(o, s, []);
    if (!Number.isFinite(o.x) || !s.x) continue;
    out.x0 = Math.min(out.x0, l.x + o.x * l.scale); out.x1 = Math.max(out.x1, l.x + (o.x + s.x) * l.scale);
    out.y0 = Math.min(out.y0, l.y + o.y * l.scale); out.y1 = Math.max(out.y1, l.y + (o.y + s.y) * l.scale);
  }
  return Number.isFinite(out.x0) ? out : { x0: GAME.x, x1: GAME.x + GAME.w, y0: GAME.y, y1: GAME.y + GAME.h };
}

// --- views: {x, y, w, h} in NGUI units, y up ---
// the largest 16:9 view no wider than w that fits P, centred on (cx, cy) as far as P allows
function fit(P, w, cx, cy) {
  const W = Math.min(w, P.x1 - P.x0, ((P.y1 - P.y0) * 16) / 9), H = (W * 9) / 16;
  return { x: clamp(cx - W / 2, P.x0, P.x1 - W), y: clamp(cy - H / 2, P.y0, P.y1 - H), w: W, h: H };
}
// left view: the head-pat point T near 28 % across and 34 % down, as wide as possible without leaving P. A first pass
// keeps T within 16-34 % across (zoom up to 1.6 x the game's view), a second allows 44 % and 1.9 x; else 1.9 x as near
// as P allows.
function leftView(P, T, G) {
  const pass = (fxMax, zoomIn) => {
    const maxW = Math.min(G.w, P.x1 - P.x0, ((P.y1 - P.y0) * 16) / 9), minW = Math.min(maxW, G.w / zoomIn);
    for (let W = maxW; W >= minW - 1e-6; W -= G.w / 200) {
      const H = (W * 9) / 16;
      const xa = Math.max(P.x0, T.x - fxMax * W), xb = Math.min(P.x1 - W, T.x - 0.16 * W);
      const ya = Math.max(P.y0, T.y - 0.78 * H), yb = Math.min(P.y1 - H, T.y - 0.54 * H);
      if (xa <= xb && ya <= yb) return { x: clamp(T.x - 0.28 * W, xa, xb), y: clamp(T.y - 0.66 * H, ya, yb), w: W, h: H };
    }
    return null;
  };
  const found = pass(0.34, 1.6) || pass(0.44, 1.9);
  if (found) return found;
  const W = Math.min(G.w / 1.9, P.x1 - P.x0, ((P.y1 - P.y0) * 16) / 9), H = (W * 9) / 16;
  return { x: clamp(T.x - 0.28 * W, P.x0, P.x1 - W), y: clamp(T.y - 0.66 * H, P.y0, P.y1 - H), w: W, h: H };
}
const viewOf = (m, md = mode) => ({ ...(md === "full" ? m.full : m.left) });
// a layer's spine-player viewport for a view: the view in that skeleton's own units
const layerViewport = (v, l) => ({
  x: (v.x - l.x) / l.scale, y: (v.y - l.y) / l.scale, width: v.w / l.scale, height: v.h / l.scale,
  padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {},
});
// the shared view of this frame (every player asks in its frame hook)
const viewNow = () => current?.view || null;
function setView(view) {
  current.view = view;
}

// the lobby's frame, head-pat point and talk sequences
function measure(loaded) {
  const info = current.info, G = game();
  const main = loaded.find((l) => l.name === info?.main) || loaded.find((l) => l.player.skeleton.data.findBone("Touch_Point")) || loaded[loaded.length - 1];
  const data = main.player.skeleton.data;
  const painted = paintedRect(loaded, G);
  // a lobby whose art covers less than half the view (a character-only mod): the game view with the old edge
  // extension and feather, measured on the skeletons' bounds
  const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
  const sparse = !painted.covered && area(painted) < 0.5 * G.w * G.h;
  const edge = sparse ? boundsRect(loaded) : painted;
  // the head-pat point in the idle pose (Touch_Point, else the prefab's pat box, else the top third of the view)
  const sk = new spine.Skeleton(data), idle = idleOf(data, main);
  sk.setToSetupPose();
  if (idle) { const st = new spine.AnimationState(new spine.AnimationStateData(data)); st.setAnimation(0, idle, true); st.update(0); st.apply(sk); }
  sk.updateWorldTransform(spine.Physics.update);
  const bone = sk.findBone("Touch_Point") || sk.findBone("Touch_Eye");
  const pat = info?.drags?.find((d) => d.kind === "pat")?.rect;
  const touch = bone ? { x: main.x + bone.worldX * main.scale, y: main.y + bone.worldY * main.scale }
    : pat ? { x: (pat[0] + pat[2]) / 2, y: (pat[1] + pat[3]) / 2 } : { x: 0, y: G.y + G.h * 0.66 };
  const full = sparse ? G : fit(painted, G.w, G.x + G.w / 2, G.y + G.h / 2);
  const sequences = data.animations
    .map((a) => /^Talk_(\d+)_M$/.exec(a.name))
    .filter(Boolean)
    .map((m) => {
      const anim = m[0], sync = `Talk_${m[1]}_A`;
      const a = data.findAnimation(anim);
      // the voice clips: events named after them (e.g. "Images/sound/Hoshino_MemorialLobby_1"), with their times
      const cues = a.timelines.filter((tl) => tl instanceof spine.EventTimeline).flatMap((tl) => tl.events)
        .filter((e) => /memoriallobby/i.test(e.data.name)).map((e) => ({ t: e.time, clip: clipId(e.data.name) }))
        .sort((x, y) => x.t - y.t);
      return { anim, sync: data.findAnimation(sync) ? sync : null, n: Number(m[1]), duration: a.duration, cues };
    })
    .sort((a, b) => a.n - b.n);
  return { main: main.name, painted, edge, sparse, touch, full, left: leftView(edge, touch, G), sequences };
}

// switch between the left view and fullscreen: the old framing fades out over the new one, in step with the UI slide
export function frame(m) {
  const changed = m !== mode;
  mode = m;
  if (!current?.meta) return;
  if (changed) crossfade();
  setView(viewOf(current.meta));
  feather(current.view);
}
function crossfade() {
  const fade = current.host?.querySelector(".lobby-fade");
  if (!fade) return;
  const g = fade.getContext("2d");
  g.clearRect(0, 0, fade.width, fade.height);
  const ext = current.host.querySelector(".lobby-extend");
  if (ext && !ext.hidden) g.drawImage(ext, 0, 0, fade.width, fade.height);
  for (const p of players) if (p.canvas) g.drawImage(p.canvas, 0, 0, fade.width, fade.height);
  fade.style.transition = "none";
  fade.style.opacity = "1";
  void getComputedStyle(fade).opacity; // start the fade from 1 in this frame, together with the UI slide
  fade.style.transition = `opacity ${FADE_MS}ms ease`;
  fade.style.opacity = "0";
}

// for checks: the rects involved and the current view
export const limits = () => current?.meta && {
  game: game(), painted: current.meta.painted, full: current.meta.full, left: current.meta.left, view: current.view,
  touch: current.meta.touch, mode,
};

// the switch card's still: a 450 x 253 crop around the face inside the left view (so fully painted), returned in
// canvas pixels; the card's mask fades its edges, and its text covers the right third
export function stillRect(canvasW, canvasH) {
  const m = current?.meta;
  if (!m) return null;
  const v = m.left, T = m.touch, G = game();
  const w = clamp(G.w * 0.5, v.w * 0.5, v.w), h = (w * 253) / 450;
  // the head-pat point (top of the head) at 32 % across and 20 % down the crop: the face in the card's clear part
  const x = clamp(T.x - 0.32 * w, v.x, v.x + v.w - w), top = clamp(T.y + 0.2 * h, v.y + h, v.y + v.h);
  return { x: ((x - v.x) / v.w) * canvasW, y: ((v.y + v.h - top) / v.h) * canvasH, w: (w / v.w) * canvasW, h: (h / v.h) * canvasH };
}

function makePlayer(host, layer, onReady, onError = () => {}) {
  const div = document.createElement("div");
  div.className = "lobby-layer";
  host.appendChild(div);
  return new spine.SpinePlayer(div, {
    skeleton: `${layer.spine}.skel`, atlas: `${layer.spine}.atlas`, animation: undefined,
    premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000", showControls: false, showLoading: false,
    preserveDrawingBuffer: true, defaultMix: isBg(layer.name) ? 0.2 : 0.4,
    viewport: layerViewport(game(), layer),
    // every frame: the shared view, no spine-player viewport transitions of its own
    frame: (p) => {
      const v = viewNow();
      if (v) { p.currentViewport = layerViewport(v, layer); p.previousViewport = null; }
    },
    success: (player) => {
      player.bamtLayer = layer;
      if (layer.skin) try { player.skeleton.setSkinByName(layer.skin); player.skeleton.setSlotsToSetupPose(); } catch { /* the default skin */ }
      const idle = idleOf(player.skeleton.data, layer);
      if (idle) player.animationState.setAnimation(0, idle, true);
      onReady(player);
    },
    error: (_p, message) => { console.error(message); onError(); },
  });
}

// --- fallback only (art that does not cover the view): edge pixels stretched outwards and blurred ---
const EXT_W = 480, EXT_H = 270;
const inside = (v, P) => v.x >= P.x0 - 0.5 && v.x + v.w <= P.x1 + 0.5 && v.y >= P.y0 - 0.5 && v.y + v.h <= P.y1 + 0.5;
function rectOnStage(view, w, h) {
  const P = current.meta.edge;
  return { l: ((P.x0 - view.x) / view.w) * w, r: ((P.x1 - view.x) / view.w) * w,
    t: ((view.y + view.h - P.y1) / view.h) * h, b: ((view.y + view.h - P.y0) / view.h) * h };
}
function drawExtension(canvas, view) {
  const g = canvas.getContext("2d");
  const src = document.createElement("canvas");
  src.width = EXT_W; src.height = EXT_H;
  const sg = src.getContext("2d");
  for (const p of players) if (p.canvas) sg.drawImage(p.canvas, 0, 0, EXT_W, EXT_H);
  const r = rectOnStage(view, EXT_W, EXT_H);
  const L0 = Math.max(0, Math.ceil(r.l)), R0 = Math.min(EXT_W, Math.floor(r.r)), T0 = Math.max(0, Math.ceil(r.t)), B0 = Math.min(EXT_H, Math.floor(r.b));
  g.clearRect(0, 0, EXT_W, EXT_H);
  g.drawImage(src, 0, 0);
  // clamp: the last column or row inside the painted area is repeated out to the edge
  if (R0 < EXT_W && R0 > 2) g.drawImage(src, R0 - 2, 0, 2, EXT_H, R0, 0, EXT_W - R0, EXT_H);
  if (L0 > 0 && L0 < EXT_W - 2) g.drawImage(src, L0, 0, 2, EXT_H, 0, 0, L0, EXT_H);
  const mid = document.createElement("canvas");
  mid.width = EXT_W; mid.height = EXT_H;
  mid.getContext("2d").drawImage(canvas, 0, 0);
  if (B0 < EXT_H && B0 > 2) g.drawImage(mid, 0, B0 - 2, EXT_W, 2, 0, B0, EXT_W, EXT_H - B0);
  if (T0 > 0 && T0 < EXT_H - 2) g.drawImage(mid, 0, T0, EXT_W, 2, 0, 0, EXT_W, T0);
}
// a view inside the painted area needs nothing; otherwise the sharp lobby fades out over the last stretch before its
// painted border, into the blurred extension
function feather(view) {
  const el = current?.host?.querySelector(".lobby-view"), ext = current?.host?.querySelector(".lobby-extend");
  if (!el || !current?.meta) return;
  clearInterval(extendTimer);
  const off = inside(view, current.meta.edge);
  if (ext) ext.hidden = off;
  if (off) { el.style.webkitMaskImage = el.style.maskImage = "none"; return; }
  const r = rectOnStage(view, STAGE.w, STAGE.h), f = 90, parts = [];
  if (r.r < STAGE.w) parts.push(`linear-gradient(90deg, #000 ${r.r - f}px, transparent ${r.r}px)`);
  if (r.l > 0) parts.push(`linear-gradient(270deg, #000 ${STAGE.w - r.l - f}px, transparent ${STAGE.w - r.l}px)`);
  if (r.b < STAGE.h) parts.push(`linear-gradient(180deg, #000 ${r.b - f}px, transparent ${r.b}px)`);
  if (r.t > 0) parts.push(`linear-gradient(0deg, #000 ${STAGE.h - r.t - f}px, transparent ${STAGE.h - r.t}px)`);
  const mask = parts.join(", ") || "none";
  el.style.webkitMaskImage = mask;
  el.style.maskImage = mask;
  el.style.webkitMaskComposite = parts.length > 1 ? "source-in" : "";
  el.style.maskComposite = parts.length > 1 ? "intersect" : "";
  // keep the extension in step with the animation (cheap: a 480 x 270 canvas a few times a second)
  const tick = () => current?.view && drawExtension(ext, current.view);
  tick();
  extendTimer = setInterval(tick, 200);
}

// show(core, host) -> Promise<meta> (frame, sequences); resolves once every layer is in and framed
export async function show(core, host, variant) {
  if (current?.core === core && players.length) return current.ready;
  hide(host);
  const my = ++token;
  host.innerHTML = '<canvas class="lobby-extend" hidden></canvas><div class="lobby-view"></div><canvas class="lobby-fade"></canvas><div class="lobby-frost"></div><div class="lobby-subtitle" hidden></div>';
  const ext = host.querySelector(".lobby-extend"), viewHost = host.querySelector(".lobby-view"), fade = host.querySelector(".lobby-fade");
  ext.width = EXT_W; ext.height = EXT_H;
  fade.width = STAGE.w; fade.height = STAGE.h;
  current = { core, variant, host, info: null, meta: null, view: null };
  current.ready = (async () => {
    const { info, layers } = await layersOf(core);
    if (my !== token || !layers.length) return null;
    current.info = info;
    setView(game()); // the first frames are already in the game's framing
    const loaded = (await Promise.all(layers.map((layer) => new Promise((resolve) => {
      players.push(makePlayer(viewHost, layer, (player) => resolve({ ...layer, player }), () => resolve(null)));
    })))).filter(Boolean);
    if (my !== token || !loaded.length) return null;
    current.meta = measure(loaded);
    setView(viewOf(current.meta));
    feather(current.view);
    return current.meta;
  })();
  return current.ready;
}

export function hide(host) {
  token += 1;
  for (const p of players) p.dispose();
  players = [];
  current = null;
  clearInterval(extendTimer);
  chain = null;
  silence();
  clearTimeout(subtitleTimer);
  if (host) host.innerHTML = "";
}

// the character: the layer with the head-pat point, not just the last one by name
const mainPlayer = () => players.find((p) => p.bamtLayer?.name === current?.meta?.main) || players[players.length - 1];

// a dialogue sequence: the talk animation and its sync on tracks 1 and 2, its voices on their cue times, the subtitle;
// then back to idle. Starts at once, cutting off whatever was playing.
export function play(anim, { fromChain = false } = {}) {
  if (!current?.meta) return null;
  if (!fromChain) chain = null;
  const seq = current.meta.sequences.find((s) => s.anim === anim);
  const character = mainPlayer();
  if (!seq || !character?.animationState) return null;
  silence();
  for (const cue of muted ? [] : seq.cues) {
    if (!lines[cue.clip]?.voice) continue;
    cueTimers.push(setTimeout(() => {
      const a = new Audio(`/asset/voice/${encodeURIComponent(current.variant)}/${encodeURIComponent(cue.clip)}.ogg`);
      a.volume = volume;
      audios.push(a);
      a.play().catch(() => {});
    }, cue.t * 1000));
  }
  subtitle(textOf(seq), seq.duration);
  const state = character.animationState;
  state.setAnimation(1, seq.anim, false).mixDuration = 0.25;
  if (seq.sync) state.setAnimation(2, seq.sync, false).mixDuration = 0.25;
  state.addEmptyAnimation(1, 0.2, seq.duration);
  if (seq.sync) state.addEmptyAnimation(2, 0.2, seq.duration);
  return seq;
}

// stop at once: talk tracks fade back to idle, voices and subtitle go
export function stop() {
  chain = null;
  silence();
  subtitle([], 0);
  const character = mainPlayer();
  if (character?.animationState) {
    character.animationState.setEmptyAnimation(1, 0.25);
    character.animationState.setEmptyAnimation(2, 0.25);
  }
}

// every dialogue in order, each starting when the previous one ends
export function playAll(onStep, onEnd) {
  if (!current?.meta) return;
  const run = { i: 0 };
  chain = run;
  const next = () => {
    if (chain !== run || !current?.meta) return;
    const seq = current.meta.sequences[run.i++];
    if (!seq) { chain = null; onEnd?.(); return; }
    play(seq.anim, { fromChain: true });
    onStep?.(seq.anim);
    setTimeout(next, (seq.duration + 0.5) * 1000);
  };
  next();
}
export const playingAll = () => !!chain;
export const meta = () => current?.meta || null;

function silence() {
  for (const t of cueTimers) clearTimeout(t);
  cueTimers = [];
  for (const a of audios) a.pause();
  audios = [];
}

// lines by clip id ({clip: {"zh-CN", ja, voice}}) and the language picker for them
export function setLines(table, pick) {
  lines = table || {};
  if (pick) lineOf = pick;
}
// the voice volume (0 to 1); muted never plays voices
export function setVolume(value, mute) {
  volume = Math.max(0, Math.min(1, value));
  muted = !!mute;
  for (const a of audios) a.volume = volume;
  if (muted) silence();
}
// a sequence's lines, one per voice clip
export const textOf = (seq) => seq.cues.map((c) => lineOf(lines[c.clip])).filter(Boolean);

// subtitles leave upwards and the next one rises in from below
function subtitle(textLines, duration) {
  const box = document.querySelector(".lobby-subtitle");
  if (!box) return;
  clearTimeout(subtitleTimer);
  const showNew = () => {
    box.textContent = textLines.join("\n");
    box.hidden = !textLines.length;
    box.classList.remove("out");
    box.classList.add("in");
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.remove("in")));
    if (textLines.length) subtitleTimer = setTimeout(() => subtitle([], 0), (duration || 6) * 1000 + 300);
  };
  if (!box.hidden && box.textContent) {
    box.classList.add("out");
    subtitleTimer = setTimeout(() => { box.hidden = true; if (textLines.length) showNew(); }, 260);
  } else if (textLines.length) showNew();
  else box.hidden = true;
}
