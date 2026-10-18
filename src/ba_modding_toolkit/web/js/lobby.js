// Memorial lobby for the detail screen's second tab. The lobby bundle's own skeletons (background layers, then the
// character) play their idle tracks; the view is framed so the head-pat point (Touch_Point bone) sits at the
// left-centre of the stage, and the right side fades into a frosted blur behind the panel. Dialogue sequences play
// the talk animations (Talk_NN_M with Talk_NN_A). Where the view reaches past the lobby's painted area, the lobby's own
// edge colours are stretched outwards and blurred, so the lobby never runs into an unrelated picture.
// Everything about a lobby is read from its skeletons at load time.
import { spineFiles } from "./api.js";

let players = [], current = null, mode = "left", extendTimer = null, chain = null, token = 0;

const base = (core) => `/asset/spine/lobby/${encodeURIComponent(core)}/`;

// the layers of a lobby: every skeleton in its bundle, backgrounds first
async function layersOf(core) {
  const files = await fetch(spineFiles("lobby", core)).then((r) => (r.ok ? r.json() : []));
  const skels = files.filter((f) => f.endsWith(".skel")).map((f) => f.slice(0, -5));
  const atlases = new Set(files.filter((f) => f.endsWith(".atlas")).map((f) => f.slice(0, -6)));
  const isBg = (n) => /background|_bg\b|bg_/i.test(n);
  return skels.filter((n) => atlases.has(n)).sort((a, b) => isBg(b) - isBg(a) || a.localeCompare(b))
    .map((n) => ({ name: n, role: isBg(n) ? "background" : "character", spine: `${base(core)}${encodeURIComponent(n)}` }));
}

// the lobby's frame and talk sequences, measured on the character skeleton in its setup pose
function measure(character) {
  const sk = character.skeleton, data = sk.data;
  sk.setToSetupPose();
  sk.updateWorldTransform(spine.Physics.update);
  const offset = new spine.Vector2(), size = new spine.Vector2();
  sk.getBounds(offset, size, []);
  const touch = sk.findBone("Touch_Point") || sk.findBone("Touch_Eye") || null;
  const w = size.x, h = (w * 9) / 16, cx = offset.x + size.x / 2, cy = offset.y + size.y / 2;
  const previewView = [cx - w / 2, cy - h / 2, w, h];
  const sequences = data.animations
    .map((a) => /^Talk_(\d+)_M$/.exec(a.name))
    .filter(Boolean)
    .map((m) => {
      const anim = m[0], sync = `Talk_${m[1]}_A`;
      return { anim, sync: data.findAnimation(sync) ? sync : null, n: Number(m[1]), duration: data.findAnimation(anim).duration };
    })
    .sort((a, b) => a.n - b.n);
  return {
    size: [size.x, size.y], offset: [offset.x, offset.y], previewView,
    touch: touch ? { cx: touch.worldX, cy: touch.worldY } : { cx, cy: offset.y + size.y * 0.75 },
    idle: data.findAnimation("Idle_01") ? "Idle_01" : data.animations[0]?.name,
    sequences,
  };
}

// the view in skeleton units: a little wider than the game's own framing so the upper body shows, the head-pat
// point at 28 % from the left and 34 % from the top; fullscreen uses the game's own framing
function viewOf(d, m = mode) {
  if (m === "full") { const [x, y, width, height] = d.previewView; return { x, y, width, height }; }
  const h = d.previewView[3] * 1.12, w = (h * 16) / 9;
  return { x: d.touch.cx - 0.28 * w, y: d.touch.cy - 0.66 * h, width: w, height: h };
}
const vp = (view, transitionTime) => ({ ...view, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime, animations: {} });

// pan and zoom between the two framings
export function frame(m) {
  mode = m;
  if (!current?.meta) return;
  const view = viewOf(current.meta);
  for (const p of players) {
    if (!p.skeleton) continue;
    p.config.viewport = vp(view, 0.6);
    p.setViewport(p.animationState.tracks[0]?.animation.name || current.meta.idle);
  }
  feather(view);
}

function makePlayer(host, layer, onReady) {
  const div = document.createElement("div");
  div.className = "lobby-layer";
  host.appendChild(div);
  return new spine.SpinePlayer(div, {
    skeleton: `${layer.spine}.skel`, atlas: `${layer.spine}.atlas`, animation: undefined,
    premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000", showControls: false, showLoading: false,
    preserveDrawingBuffer: true, defaultMix: layer.role === "character" ? 0.4 : 0.2,
    viewport: vp({ x: 0, y: 0, width: 1920, height: 1080 }, 0),
    success: (player) => {
      const idle = player.skeleton.data.findAnimation("Idle_01") ? "Idle_01" : player.skeleton.data.animations[0]?.name;
      if (idle) player.animationState.setAnimation(0, idle, true);
      onReady(player);
    },
    error: (_p, message) => console.error(message),
  });
}

// --- edge extension: the painted area's border pixels stretched to the stage edges, then blurred ---
const EXT_W = 480, EXT_H = 270;
function paintedRect(view, w, h) {
  const [ox, oy] = current.meta.offset, [sw, sh] = current.meta.size;
  return {
    l: ((ox - view.x) / view.width) * w, r: ((ox + sw - view.x) / view.width) * w,
    t: ((view.y + view.height - (oy + sh)) / view.height) * h, b: ((view.y + view.height - oy) / view.height) * h,
  };
}
function drawExtension(canvas, view) {
  const g = canvas.getContext("2d");
  const src = document.createElement("canvas");
  src.width = EXT_W; src.height = EXT_H;
  const sg = src.getContext("2d");
  for (const p of players) if (p.canvas) sg.drawImage(p.canvas, 0, 0, EXT_W, EXT_H);
  const r = paintedRect(view, EXT_W, EXT_H);
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
// the sharp lobby fades out over the last stretch before its painted border, into the blurred extension
function feather(view) {
  const el = document.querySelector(".lobby-view");
  if (!el || !current?.meta) return;
  const r = paintedRect(view, 1920, 1080), f = 90;
  const parts = [];
  if (r.r < 1920) parts.push(`linear-gradient(90deg, #000 ${r.r - f}px, transparent ${r.r}px)`);
  if (r.l > 0) parts.push(`linear-gradient(270deg, #000 ${1920 - r.l - f}px, transparent ${1920 - r.l}px)`);
  if (r.b < 1080) parts.push(`linear-gradient(180deg, #000 ${r.b - f}px, transparent ${r.b}px)`);
  if (r.t > 0) parts.push(`linear-gradient(0deg, #000 ${1080 - r.t - f}px, transparent ${1080 - r.t}px)`);
  const mask = parts.join(", ") || "none";
  el.style.webkitMaskImage = mask;
  el.style.maskImage = mask;
  el.style.webkitMaskComposite = parts.length > 1 ? "source-in" : "";
  el.style.maskComposite = parts.length > 1 ? "intersect" : "";
}

// show(core, host) -> Promise<meta> (frame, sequences); resolves once every layer is in
export async function show(core, host) {
  if (current?.core === core && players.length) return current.ready;
  hide(host);
  const my = ++token;
  host.innerHTML = '<canvas class="lobby-extend"></canvas><div class="lobby-view"></div><div class="lobby-frost"></div>';
  const ext = host.querySelector(".lobby-extend"), viewHost = host.querySelector(".lobby-view");
  ext.width = EXT_W; ext.height = EXT_H;
  current = { core, meta: null };
  current.ready = (async () => {
    const layers = await layersOf(core);
    if (my !== token || !layers.length) return null;
    const loaded = await Promise.all(layers.map((layer) => new Promise((resolve) => {
      players.push(makePlayer(viewHost, layer, resolve));
    })));
    if (my !== token) return null;
    const character = loaded[loaded.length - 1];
    current.meta = measure(character);
    const view = viewOf(current.meta);
    for (const p of loaded) { p.config.viewport = vp(view, 0); p.setViewport(p.animationState.tracks[0]?.animation?.name || current.meta.idle); }
    feather(view);
    // keep the extension in step with the animation (cheap: a 480 x 270 canvas a few times a second)
    const tick = () => drawExtension(ext, players[0]?.currentViewport?.width ? players[0].currentViewport : viewOf(current.meta));
    tick();
    clearInterval(extendTimer);
    extendTimer = setInterval(tick, 200);
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
  if (host) host.innerHTML = "";
}

// a dialogue sequence: the talk animation and its sync on tracks 1 and 2, then back to idle; starts at once.
// The game's voices and subtitles are not read yet, so dialogue plays silently.
export function play(anim, { fromChain = false } = {}) {
  if (!current?.meta) return null;
  if (!fromChain) chain = null;
  const seq = current.meta.sequences.find((s) => s.anim === anim);
  const character = players[players.length - 1];
  if (!seq || !character?.animationState) return null;
  const state = character.animationState;
  state.setAnimation(1, seq.anim, false).mixDuration = 0.25;
  if (seq.sync) state.setAnimation(2, seq.sync, false).mixDuration = 0.25;
  state.addEmptyAnimation(1, 0.2, seq.duration);
  if (seq.sync) state.addEmptyAnimation(2, 0.2, seq.duration);
  return seq;
}

// stop at once: talk tracks fade back to idle
export function stop() {
  chain = null;
  const character = players[players.length - 1];
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
