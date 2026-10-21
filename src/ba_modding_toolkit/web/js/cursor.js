// The game's own mouse pointer and its touch effect.
//
// Pointer: the PC client (ControllerMouse.SetPCCursorStyle, by its MousePoint option: this or the system arrow) sets
// PCIcon_MousePoint (UIs/GLPC_Cursor, 64 x 64) with Cursor.SetCursor, hotspot (0, 0), CursorMode.Auto: a hardware
// cursor, which Windows shows at the system cursor size (32 px at 100 %).
// Here it is a CSS cursor of 32 CSS px with the texture as its 2x image, on everything the game would show it on
// (buttons too: the game has no hover or pressed pointer); drag handles keep grab and grabbing, text fields the text
// cursor. Cursor_1 (the halo crosshair, hotspot in its middle, a software cursor) is the controller's pointer.
// The window must leave body's cursor alone: pywebview's text_select=False adds "body { cursor: default }" after
// app.css (webui/main.py keeps it True).
// WebKit (WKWebView) drops a cursor image whose box would cross the window's right or bottom edge and shows the system
// arrow instead (Style::Cursor::selectImageCursor): the image is cut to the texture's opaque part, and smaller cuts of
// it follow in the list for the last pixels at those edges (the first one that fits is shown). Other engines take the
// first, the whole pointer.
//
// Touch effect: touch-fx.js simulates FX_Touch; this draws it on two canvases over the whole window, below the
// pointer and above everything else, idle (hidden, no frame loop, no bitmap) while nothing animates. The light goes to
// a canvas screened over the page, what the flash disc hides to a multiplied one under it (touch-fx.js overBlend: the
// page blends in sRGB values, the game in linear light). Sizes follow the stage (the game's screen is 2 units high).
//
// Both use the game's textures from the light /asset/ui/texture route; without a game the system cursor stays and
// there is no effect.
import * as FX from "./touch-fx.js";
import { textureUrl } from "./api.js";

const POINTER = "PCIcon_MousePoint";
const TEXTURES = { ring: "FX_TEX_Grad_Ring3", disc: "FX_TEX_Circle_01", tri: "FX_TEX_Triangle_02_1", trail: "FX_TEX_Trail_03" };
const SIZE = 32; // CSS px
const STEP = 4; // CSS px between the cuts kept for the window's right and bottom edges

function image(name) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = textureUrl(name);
  });
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// the pointer at `scale` times its CSS size, cut to a box of w x h CSS px from its top left (the hotspot), as an object
// URL: the cursor value stays short (every button resolves it), unlike with data: URLs
function cut(img, scale, w, h) {
  const c = canvas(w * scale, h * scale), g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, SIZE * scale, SIZE * scale);
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob && URL.createObjectURL(blob)), "image/png"));
}

// the opaque part of the pointer's texture (an ImageData) from its top left, in CSS px at `size`
export function opaqueBox({ data, width, height }, size = SIZE) {
  let w = 0, h = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]) { w = Math.max(w, x + 1); h = y + 1; }
    }
  }
  return w ? [Math.ceil(w * size / width), Math.ceil(h * size / height)] : [size, size];
}

// the pointer's boxes in the order WebKit tries them: the whole pointer, then narrower ones for the right edge,
// shorter ones for the bottom edge and smaller squares for the corner, `step` CSS px apart
export function pointerBoxes([w, h], step = STEP) {
  const cuts = (n) => Array.from({ length: Math.ceil(n / step) - 1 }, (_, i) => (Math.ceil(n / step) - 1 - i) * step);
  return [[w, h], ...cuts(w).map((x) => [x, h]), ...cuts(h).map((y) => [w, y]), ...cuts(Math.min(w, h)).map((s) => [s, s])];
}

// the pointer as a CSS cursor value, in the first syntax the engine takes (image-set keeps it sharp on HiDPI): sets
// lists each box's 1x and 2x image, the system cursor comes last
export function cursorValue(sets, supports = (v) => CSS.supports("cursor", v)) {
  const list = (one) => [...sets.map((set) => `${one(set)} 0 0`), "auto"].join(", ");
  return [
    list(([a, b]) => `image-set(url("${a}") 1x, url("${b}") 2x)`),
    list(([a, b]) => `-webkit-image-set(url("${a}") 1x, url("${b}") 2x)`),
    list(([a]) => `url("${a}")`),
  ].find(supports) || null;
}

async function initPointer() {
  const img = await image(POINTER);
  if (!img) return;
  const boxes = pointerBoxes(opaqueBox(pixels(img)));
  const sets = await Promise.all(boxes.map(([w, h]) => Promise.all([cut(img, 1, w, h), cut(img, 2, w, h)])));
  if (sets.flat().some((url) => !url)) return;
  const value = cursorValue(sets);
  if (!value) return;
  const root = document.documentElement.style;
  root.setProperty("--cursor", value);
  root.setProperty("--cursor-press", value);
}

// --- touch effect ---

let tex = null, shade = null, glow = null, raf = 0, shown = false;
const effects = new Map(); // pointerId -> effect (a released one moves to a fresh key)
let released = 0, reduced = null;

// world units -> CSS px: the stage's height is the game's 2 units
const unit = () => 540 * Math.min(innerWidth / 1920, innerHeight / 1080);

function pixels(img) {
  const c = canvas(img.width, img.height), g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height);
}

// one canvas per colour channel (red, green, blue) and a black one, each with the mask as alpha: drawn with
// "lighter" and a global alpha per channel they add any colour, the black one hides
function channels(mask, w, h) {
  return [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0]].map((rgb) => {
    const c = canvas(w, h), g = c.getContext("2d"), data = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      data.data.set(rgb, i * 4);
      data.data[i * 4 + 3] = mask[i];
    }
    g.putImageData(data, 0, 0);
    return c;
  });
}

async function loadTextures() {
  const imgs = await Promise.all(Object.values(TEXTURES).map(image));
  if (imgs.some((x) => !x)) return null;
  const [ring, disc, tri, trail] = imgs.map(pixels);
  // Grad_Ring3: its alpha along the ring (u), the mean over its width
  const ringAlpha = new Float32Array(ring.width);
  for (let x = 0; x < ring.width; x++) {
    let sum = 0;
    for (let y = 0; y < ring.height; y++) sum += ring.data[(y * ring.width + x) * 4 + 3];
    ringAlpha[x] = sum / ring.height / 255;
  }
  // Trail_03: its red (sRGB, decoded) along the trail, in the middle of its width
  const trailU = new Float32Array(trail.width), mid = Math.floor(trail.height / 2);
  for (let x = 0; x < trail.width; x++) trailU[x] = FX.toLinear(trail.data[(mid * trail.width + x) * 4] / 255);
  // Circle_01: the disc is in the colour (alpha is opaque); the shader takes red as the mask
  const discMask = new Uint8ClampedArray(disc.width * disc.height);
  for (let i = 0; i < discMask.length; i++) discMask[i] = Math.round(FX.toLinear(disc.data[i * 4] / 255) * 255);
  // Triangle_02_1: two frames side by side, white with the shape in alpha
  const tw = tri.width / 2, frames = [0, 1].map((f) => {
    const mask = new Uint8ClampedArray(tw * tri.height);
    for (let y = 0; y < tri.height; y++) for (let x = 0; x < tw; x++) mask[y * tw + x] = tri.data[(y * tri.width + f * tw + x) * 4 + 3];
    return channels(mask, tw, tri.height);
  });
  // the flash's multiplied disc is tinted on this one
  const tint = canvas(disc.width, disc.height);
  return { ringAlpha, trailU, disc: channels(discMask, disc.width, disc.height), frames, tint };
}

const sample = (arr, u) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(u * arr.length)))];
const rgb = (c, k = 1) => `rgb(${c.map((x) => Math.round(FX.toSrgb(x * k) * 255)).join(",")})`;

function layer(cls) {
  const c = document.createElement("canvas");
  c.className = `touch-fx ${cls}`;
  c.setAttribute("aria-hidden", "true");
  c.hidden = true;
  c.width = c.height = 0; // no bitmap until the first press
  document.body.appendChild(c);
  return c;
}

function fit(c) {
  const dpr = devicePixelRatio || 1, w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.clearRect(0, 0, w, h);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

// an additive sprite: one draw per colour channel (sRGB values); the alpha is back at 1 after it (the rings and the
// trails fold their alpha into the colour)
function addSprite(g, set, color, x, y, w, h) {
  for (let ch = 0; ch < 3; ch++) {
    const a = color[ch];
    if (a <= 0.002) continue;
    g.globalAlpha = a;
    g.drawImage(set[ch], x, y, w, h);
  }
  g.globalAlpha = 1;
}

function drawTrail(g, fx, U, t) {
  const { points, segments } = FX.trailState(fx);
  if (!segments.length) return;
  g.lineCap = "round";
  g.lineWidth = Math.max(1, FX.FX.trail.width * U);
  for (const s of segments) {
    const k = sample(t.trailU, s.u);
    if (k <= 0) continue;
    const a = points[s.from], b = points[s.to];
    g.strokeStyle = rgb(s.color, k);
    g.beginPath();
    g.moveTo(a.x * U, a.y * U);
    g.lineTo(b.x * U, b.y * U);
    g.stroke();
  }
}

function drawArc(g, p, fx, now, U, t) {
  const st = FX.arcState(p, now), A = t.ringAlpha, n = A.length;
  // the dissolve keeps the part of the ring whose alpha reaches the threshold: one stretch around u = 0.5
  let lo = 0, hi = n - 1;
  while (lo < n && A[lo] < st.threshold) lo++;
  while (hi > lo && A[hi] < st.threshold) hi--;
  if (lo > hi) return;
  const a = FX.FX.arc, r = st.size * (a.inner + a.outer) / 2 * U, cx = fx.ox * U, cy = fx.oy * U;
  g.lineWidth = Math.max(0.75, st.size * (a.outer - a.inner) * U);
  g.lineCap = "butt";
  // its colour along u, in pieces; neighbours of one colour (most of it: the light saturates) are one stroke
  const pieces = 48, u0 = lo / n, u1 = (hi + 1) / n, at = (i) => u0 + (u1 - u0) * i / pieces;
  const angle = (u) => st.rot + (u - 0.5) * Math.PI * 2;
  let start = 0, style = null;
  for (let i = 0; i <= pieces; i++) {
    const next = i < pieces ? rgb(st.color, sample(A, (at(i) + at(i + 1)) / 2) * st.alpha) : null;
    if (next === style) continue;
    if (style) {
      g.strokeStyle = style;
      g.beginPath();
      g.arc(cx, cy, r, angle(at(start)), angle(at(i)));
      g.stroke();
    }
    start = i;
    style = next;
  }
}

// the effects (list) at now on the light's context (front) and the multiplied one (back), U CSS px to a world unit;
// t: the textures (loadTextures, with the tint canvas)
export function paint(front, back, list, now, U, t = tex) {
  // the trails first, plainly (a trail does not add onto itself), then everything else added
  for (const fx of list) drawTrail(front, fx, U, t);
  front.globalCompositeOperation = "lighter";
  for (const fx of list) {
    for (const p of fx.items) {
      if (p.kind === "arc") drawArc(front, p, fx, now, U, t);
      else if (p.kind === "flash") {
        const st = FX.flashState(p, now), d = st.size * U, x = fx.ox * U - d / 2, y = fx.oy * U - d / 2;
        const { add, keep } = FX.overBlend(st.color, st.alpha);
        addSprite(front, t.disc, add, x, y, d, d);
        // what is behind keeps (1 - alpha) of itself: the disc's mask in that colour, multiplied
        const tg = t.tint.getContext("2d");
        tg.globalCompositeOperation = "copy";
        tg.drawImage(t.disc[3], 0, 0);
        tg.globalCompositeOperation = "source-in";
        tg.fillStyle = `rgb(${keep.map((k) => Math.round(k * 255)).join(",")})`;
        tg.fillRect(0, 0, t.tint.width, t.tint.height);
        back.drawImage(t.tint, x, y, d, d);
      } else {
        const st = FX.sparkState(p, now), d = st.size * U;
        if (d > 0.1) addSprite(front, t.frames[st.frame], st.color.map(FX.toSrgb), st.x * U - d / 2, st.y * U - d / 2, d, d);
      }
    }
  }
}

function draw(now) {
  const back = fit(shade), front = fit(glow);
  paint(front, back, [...effects.values()], now, unit());
}

function show(on) {
  if (shown === on) return;
  shown = on;
  shade.hidden = glow.hidden = !on;
}

function frame() {
  raf = 0;
  const now = performance.now() / 1000;
  let live = false;
  for (const [id, fx] of effects) {
    if (FX.step(fx, now)) live = true;
    else if (!fx.pressed) effects.delete(id);
  }
  if (!live) {
    // nothing to draw: hide, give back the two window-sized bitmaps (fit sizes them again on the next press) and wait
    // for the next press or drag
    show(false);
    for (const c of [shade, glow]) c.width = c.height = 0;
    return;
  }
  show(true);
  draw(now);
  raf = requestAnimationFrame(frame);
}

const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };
const world = (e) => { const U = unit(); return [e.clientX / U, e.clientY / U]; };

function down(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const now = performance.now() / 1000, [x, y] = world(e);
  const fx = FX.press(x, y, now);
  const old = effects.get(e.pointerId);
  if (old) { FX.release(old, now); effects.set(`r${released++}`, old); }
  effects.set(e.pointerId, fx);
  wake();
}

function move(e) {
  const fx = effects.get(e.pointerId);
  if (!fx?.pressed) return;
  const now = performance.now() / 1000, moves = e.getCoalescedEvents?.() || [];
  // reduced motion: the press still answers (the burst), the drag leaves no trail and no sparks
  const calm = !!reduced?.matches, opts = { trail: !calm, sparks: !calm };
  for (const m of moves.length ? moves : [e]) { const [x, y] = world(m); FX.drag(fx, x, y, now, Math.random, opts); }
  wake();
}

function up(e) {
  const fx = effects.get(e.pointerId);
  if (!fx) return;
  FX.release(fx, performance.now() / 1000);
  effects.delete(e.pointerId);
  effects.set(`r${released++}`, fx);
  wake();
}

async function initTouch() {
  tex = await loadTextures();
  if (!tex) return;
  reduced = matchMedia("(prefers-reduced-motion: reduce)");
  shade = layer("shade");
  glow = layer("glow");
  for (const [type, fn] of [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]]) {
    addEventListener(type, fn, { capture: true, passive: true });
  }
}

export function init() {
  return Promise.all([initPointer(), initTouch()]).catch((err) => console.warn("cursor", err));
}
