// Linear-light drawing for a spine-player, the way the game draws its memorial lobbies. Blue Archive renders in
// Unity's linear colour space (PlayerSettings m_ActiveColorSpace 1) and its Spine atlas textures are sRGB, so every
// blend happens in linear light: an additive glow over a bright scene adds little, a soft white veil over a dark one
// adds more. Drawn in sRGB values instead, the same glow washes the scene out (Kurumi's photo booth light turned her
// face white).
// Here the atlas pages are sampled as sRGB (decoded before filtering, as the GPU does in the game), the skeleton is
// blended into an sRGB framebuffer (blending in linear light) and one pass copies the result to the canvas, encoded
// again. Additive slots add colour only, never coverage, like the game's premultiplied vertex colours with alpha 0.
// That pass is also the game camera's post-processing (setPost): the lobby prefab's URP volumes (lobby.json "post")
// with URP 12's Panini projection, chromatic aberration and LDR colour grading, in that order and in linear light.
// Without WebGL2 the player keeps drawing as before.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
// the framebuffer holds linear, premultiplied colour; the canvas gets sRGB, premultiplied (the page composites the
// layers' canvases). Light beyond the coverage (additive over a transparent part of an upper layer) is passed on as
// it is, so it still brightens the layer below.
// The post-processing as URP 12 runs it for the lobby's camera (Unity 2021.3, colour grading in LDR mode):
// - Panini projection, its own pass (PaniniProjection.shader): the picture bent onto a cylinder, cropped to fit.
// - chromatic aberration in the uber pass (UberPost.shader, the fast three-sample version): red at the pixel, green
//   and blue a third and two thirds of the way to uv - coords * |coords|^2 * intensity * 0.05.
// - colour grading (ApplyColorGrading, LutBuilderLdr.shader): post exposure, clamped to 0..1, then what the LUT holds:
//   contrast in LogC around ACEScc mid grey, the colour filter, lift / gamma / gain, the hue shift, saturation.
//   The other LUT stages (white balance, split toning, channel mixer, shadows / midtones / highlights, curves) are at
//   their defaults in every lobby and leave the colour as it is. The LUT's 32-step interpolation is not modelled.
// A layer above another one is post-processed on its own (one canvas per layer); the colour steps are affine but for
// gamma, and the shifts are sub-pixel where characters stand, so the composite is the game's within a hair.
// Panini and the aberration are placed in the game's screen, the camera's 16:9 view G (screen: G on the canvas, in
// canvas uv), never in the canvas's own: the left view and a zoomed or panned fullscreen view show the game's picture
// with its shifts where the game puts them on the art, magnified with it. Past G's edge (a view zoomed out beyond it)
// the game shows nothing to match, so both shifts are held at those of the nearest point of G's edge instead of
// growing with the distance. With crop to fit (every lobby's Panini) neither reads past G from inside it, as in the
// game, whose camera target ends there.
// The bottom layer (clear) is drawn over the camera's clear colour, black, before the colour steps, as the game's
// camera target holds it: where the art leaves the target clear, and at its alpha edges, the grade runs over black too
// (lift shows there). The layers above stay transparent where they draw nothing.
const FS = `#version 300 es
precision highp float;
uniform sampler2D t;
uniform vec2 size;
uniform vec4 screen;
uniform float ca, clear;
uniform vec4 panini;
uniform float grade, exposure;
uniform vec3 filt, hsc, lift, gamma, gain;
out vec4 o;
const vec3 LUM = vec3(0.2126729, 0.7151522, 0.0721750);
vec3 enc(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// a point of the game's screen (uv) on the canvas texture
vec2 canvas(vec2 s) { return screen.xy + s * screen.zw; }
// Panini: where a point of the screen reads the picture; past the screen's edge, the shift of the nearest edge point
vec2 bend(vec2 s) {
  if (panini.z <= 0.0) return s;
  vec2 q = clamp(s, 0.0, 1.0), v = (2.0 * q - 1.0) * panini.xy * panini.w;
  float d = panini.z, vd = 1.0 + d, hyp = v.x * v.x + vd * vd, id = v.x * d;
  float cyl = (-id * v.x + vd * sqrt(hyp - id * id)) / hyp + d;
  return v * (cyl / vd) / (cyl - d) / panini.xy * 0.5 + 0.5 + (s - q);
}
vec3 logc(vec3 x) { return 0.244161 * log2(max(5.555556 * x + 0.047996, 0.0)) * 0.30103 + 0.386036; }
vec3 unlogc(vec3 x) { return (exp2((x - 0.386036) / 0.244161 * 3.321928) - 0.047996) / 5.555556; }
vec3 hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-4)), d / (q.x + 1e-4), q.x);
}
vec3 rgb(vec3 c) { return c.z * mix(vec3(1.0), clamp(abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0), c.y); }
vec3 graded(vec3 c) {
  c = clamp(c * exposure, 0.0, 1.0);
  if (hsc.z != 1.0) c = unlogc((logc(c) - 0.4135884) * hsc.z + 0.4135884);
  c = max(c * filt, 0.0);
  c = c * gain + lift;
  c = sign(c) * pow(abs(c), gamma);
  if (hsc.x != 0.0) { vec3 h = hsv(c); h.x = fract(h.x + hsc.x); c = rgb(h); }
  float luma = dot(c, LUM);
  return clamp(luma + hsc.y * (c - luma), 0.0, 1.0);
}
void main() {
  vec2 s = (gl_FragCoord.xy / size - screen.xy) / screen.zw;
  vec4 r = texture(t, canvas(bend(s))), g = r, b = r;
  if (ca > 0.0) {
    vec2 k = clamp(2.0 * s - 1.0, -1.0, 1.0), step3 = -k * dot(k, k) * ca / 3.0;
    g = texture(t, canvas(bend(s + step3)));
    b = texture(t, canvas(bend(s + 2.0 * step3)));
  }
  // premultiplied samples: each channel from its own, the coverage of the pixel's own place
  vec3 c = vec3(r.r, g.g, b.b), a3 = vec3(r.a, g.a, b.a);
  if (clear > 0.5) {
    // over black: the camera target's colour, graded as a whole, and opaque
    c = min(c, 1.0);
    o = vec4(enc(grade > 0.5 ? graded(c) : c), 1.0);
    return;
  }
  vec3 col = min(c / max(a3, 1e-6), 1.0) * step(1e-6, a3);
  vec3 cover = r.a > 0.0 ? enc(grade > 0.5 ? graded(col) : col) * r.a : vec3(0.0);
  o = vec4(min(cover + max(c - a3, 0.0), 1.0), r.a);
}`;
const UNIFORMS = ["t", "size", "screen", "ca", "clear", "panini", "grade", "exposure", "filt", "hsc", "lift", "gamma", "gain"];

const states = new WeakMap();

function compile(gl) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(prog, s);
    const log = gl.getShaderParameter(s, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(s) || "shader";
    gl.deleteShader(s); // freed with the program
    if (log) { gl.deleteProgram(prog); throw new Error(log); }
  }
  gl.bindAttribLocation(prog, 0, "p");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || "program";
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  // one triangle over the whole target, in its own vertex array so spine's attribute state stays untouched
  const vao = gl.createVertexArray(), buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const u = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(prog, name)]));
  return { prog, vao, buf, u, fbo: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
}

// the program, the triangle and the drawing-buffer-sized framebuffer and texture (a lost context has freed them)
function release(gl, res) {
  if (!res || gl.isContextLost()) return;
  gl.deleteFramebuffer(res.fbo);
  gl.deleteTexture(res.tex);
  gl.deleteVertexArray(res.vao);
  gl.deleteBuffer(res.buf);
  gl.deleteProgram(res.prog);
}

// an atlas page as an sRGB texture: the same pixels, decoded to linear light when sampled
function srgbPage(gl, texture) {
  const image = texture.getImage?.() || texture._image;
  if (!image || !texture.texture) return;
  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  if (texture.useMipMaps) gl.generateMipmap(gl.TEXTURE_2D);
}

function pagesOf(player) {
  const out = new Set(), data = player.skeleton?.data;
  for (const skin of data?.skins || []) {
    for (const entry of skin.getAttachments()) {
      const t = entry.attachment?.region?.texture;
      if (t) out.add(t);
    }
  }
  return out;
}

// switch a loaded player to linear light; false (and nothing changed) without WebGL2
export function attach(player) {
  const gl = player?.context?.gl;
  if (!gl || typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext) || states.has(player)) return false;
  let st;
  try {
    st = { gl, res: compile(gl), on: true, pages: [] };
  } catch (err) {
    console.warn("linear light unavailable", err);
    return false;
  }
  for (const texture of pagesOf(player)) {
    srgbPage(gl, texture);
    // a lost and restored context uploads the page again: keep it sRGB
    const own = Object.prototype.hasOwnProperty.call(texture, "update") ? texture.update : undefined;
    const update = texture.update.bind(texture);
    texture.update = (mips) => { update(mips); if (st.on) srgbPage(gl, texture); };
    st.pages.push([texture, own]);
  }
  // the program and the framebuffer are rebuilt after a context loss (spine restores its own objects first)
  st.restorable = { restore: () => { try { st.res = compile(gl); } catch { st.on = false; } } };
  player.context.addRestorable?.(st.restorable);
  // additive slots add colour, not coverage
  const batcher = player.sceneRenderer?.batcher, table = spine.PolygonBatcher?.blendModesGL;
  if (batcher && table) {
    st.batcher = batcher;
    batcher.setBlendMode = function (mode, pma) {
      const m = table[mode], src = pma ? m.srcRgbPma : m.srcRgb, dst = m.dstRgb;
      const srcA = mode === spine.BlendMode.Additive ? gl.ZERO : m.srcAlpha;
      if (this.srcColorBlend === src && this.srcAlphaBlend === srcA && this.dstBlend === dst) return;
      this.srcColorBlend = src;
      this.srcAlphaBlend = srcA;
      this.dstBlend = dst;
      if (this.isDrawing) this.flush();
      gl.blendFuncSeparate(src, dst, srcA, dst);
    };
  }
  states.set(player, st);
  return true;
}

// before the player is disposed: free the framebuffer, its drawing-buffer-sized texture and the program at once, and
// give the pages and the batcher their own methods back. spine-player's dispose frees only what spine made, and a
// context that is never lost keeps the rest on the GPU until the browser happens to collect it.
export function detach(player) {
  const st = states.get(player);
  if (!st) return;
  states.delete(player);
  st.on = false;
  if (st.saved) untint(st);
  const { gl } = st;
  if (st.bound && !gl.isContextLost()) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  st.bound = false;
  for (const [texture, own] of st.pages) {
    if (own === undefined) delete texture.update;
    else texture.update = own;
  }
  if (st.batcher) delete st.batcher.setBlendMode;
  player.context?.removeRestorable?.(st.restorable);
  release(gl, st.res);
  st.res = null;
}

// in the player's frame hook, before it clears and draws: draw into the linear framebuffer
export function begin(player) {
  const st = states.get(player);
  if (!st?.on) return;
  const { gl, res } = st, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  if (!w || !h || gl.isContextLost()) { st.bound = false; return; }
  if (w !== res.w || h !== res.h) {
    gl.bindTexture(gl.TEXTURE_2D, res.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // filtered in linear light and clamped at the edges, as URP samples its camera targets (sampler_LinearClamp);
    // without post-processing every read is a texel centre
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      // no sRGB render target: back to plain drawing, the pages as they came
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      st.on = false;
      for (const texture of pagesOf(player)) texture.update(texture.useMipMaps);
      return;
    }
    res.w = w;
    res.h = h;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
  st.bound = true;
}

// the slot colours as the game's shader sees them: spine-unity hands its shader premultiplied vertex colours and,
// in linear colour space, converts them from gamma to linear (PMAGammaToTargetSpace). A tint is decoded; an additive
// slot carries alpha 0 there, so its colour times its alpha is decoded as a whole: a glow at alpha 0.42 adds 0.15 of
// its texture, not 0.42. In the player's update hook (after the animation, before drawing); end() puts them back.
const dec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export let vertexColours = true; // for checks
export const setVertexColours = (on) => { vertexColours = !!on; };
export function tint(player) {
  const st = states.get(player);
  if (!st?.on || !vertexColours || !player.skeleton) return;
  const saved = (st.saved = []), additive = spine.BlendMode.Additive;
  for (const slot of player.skeleton.drawOrder) {
    const c = slot.color, att = slot.getAttachment(), ac = att?.color;
    const white = !ac || (ac.r === 1 && ac.g === 1 && ac.b === 1 && ac.a === 1);
    if (white && c.r === 1 && c.g === 1 && c.b === 1 && (c.a === 1 || slot.data.blendMode !== additive)) continue;
    saved.push([c, c.r, c.g, c.b, c.a, white ? null : ac, ac?.r, ac?.g, ac?.b, ac?.a]);
    let [r, g, b, a] = [c.r, c.g, c.b, c.a];
    if (!white) { r *= ac.r; g *= ac.g; b *= ac.b; a *= ac.a; ac.set(1, 1, 1, 1); }
    if (slot.data.blendMode === additive) c.set(dec(r * a), dec(g * a), dec(b * a), 1);
    else c.set(dec(r), dec(g), dec(b), a);
  }
}
function untint(st) {
  for (const [c, r, g, b, a, ac, ar, ag, ab, aa] of st.saved || []) {
    c.set(r, g, b, a);
    if (ac) ac.set(ar, ag, ab, aa);
  }
  st.saved = null;
}

// --- the game camera's post-processing ---
// The memorial lobby is drawn by the PC client's main Camera (level0 / level1): the one whose culling mask has the
// lobby's layer 12 and whose volume mask has the volumes' layer 30 (UICamera has neither), perspective with a field of
// view of 10 degrees (LobbyCameraConfigPP leaves it as it is), which is all URP's Panini projection reads.
const FOV = 10;
const lum = (c) => c[0] * 0.2126729 + c[1] * 0.7151522 + c[2] * 0.072175;
// Mathf.GammaToLinearSpace (Color.linear): the sRGB curve, a 2.2 power above 1 (HDR colours)
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : v < 1 ? Math.pow((v + 0.055) / 1.055, 2.4) : Math.pow(v, 2.2));
const IDENTITY = Object.freeze({ ca: 0, panini: [1, 1, 0, 1], grade: false, exposure: 1, filt: [1, 1, 1],
  hsc: [0, 1, 1], lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });
// What the shader gets for a lobby's post-processing (lobby.json "post", lobby.py post_processing) on a target of the
// given aspect, as URP 12's PostProcessPass, ColorGradingLutPass and ColorUtils.PrepareLiftGammaGain work it out;
// null when there is nothing to do.
export function postParams(post, aspect = 16 / 9) {
  if (!post) return null;
  const out = { ...IDENTITY };
  if (post.chromaticAberration > 0) out.ca = post.chromaticAberration * 0.05;
  const pn = post.panini;
  if (pn?.distance > 0) {
    const ey = Math.tan((FOV * Math.PI) / 360), ex = aspect * ey, d = pn.distance;
    // CalcCropExtents over CalcViewExtents: the same ratio across and down
    const near = 1 / Math.hypot(ex, 1), crop = (near * (1 + d)) / (near + d);
    out.panini = [ex, ey, d, 1 + (Math.min(1, Math.max(0, crop)) - 1) * (pn.cropToFit ?? 1)];
  }
  const lgg = post.liftGammaGain;
  if (lgg) {
    const part = (v, k) => { const c = v.slice(0, 3).map((x) => toLinear(x) * k); return [c, lum(c)]; };
    const [l, ll] = part(lgg.lift, 0.15), [g, gl] = part(lgg.gamma, 0.8), [n, nl] = part(lgg.gain, 0.8);
    out.lift = l.map((x) => x - ll + lgg.lift[3]);
    out.gamma = g.map((x) => 1 / Math.max(x - gl + lgg.gamma[3] + 1, 1e-3));
    out.gain = n.map((x) => x - nl + lgg.gain[3] + 1);
    out.grade = true;
  }
  const adj = post.colorAdjustments;
  if (adj) {
    out.exposure = Math.pow(2, adj.postExposure || 0);
    out.filt = (adj.colorFilter || [1, 1, 1]).slice(0, 3).map(toLinear);
    out.hsc = [(adj.hueShift || 0) / 360, (adj.saturation || 0) / 100 + 1, (adj.contrast || 0) / 100 + 1];
    out.grade = true;
  }
  return out.ca > 0 || out.panini[2] > 0 || out.grade ? out : null;
}
export let postOn = true; // for checks: false draws every lobby without its post-processing
export const setPostEnabled = (on) => { postOn = !!on; };
// the lobby's post-processing for an attached player (lobby.json "post"; null: none)
export function setPost(player, post) {
  const st = states.get(player);
  if (st) { st.post = post || null; st.params = null; }
}
// the game camera's view (G) in the player's skeleton units, as a spine-player viewport {x, y, width, height}: the
// screen the post-processing is placed in (null: the canvas is the screen)
export function setScreen(player, view) {
  const st = states.get(player);
  if (st) st.screen = view?.width > 0 && view?.height > 0 ? { x: view.x, y: view.y, w: view.width, h: view.height } : null;
}
// true for the bottom layer: drawn over the camera's clear colour (black, graded with the rest), opaque
export function setClear(player, on) {
  const st = states.get(player);
  if (st) st.clear = !!on;
}
const CANVAS = Object.freeze([0, 0, 1, 1]);
// the screen on the canvas this frame, [x, y, w, h] in canvas uv (y up), from the camera the skeleton was just drawn
// with; the canvas itself (exactly) when they are the same within a millionth
export function screenOnCanvas(screen, camera) {
  const vw = camera?.zoom * camera?.viewportWidth, vh = camera?.zoom * camera?.viewportHeight;
  if (!screen || !(vw > 0) || !(vh > 0)) return CANVAS;
  const x0 = camera.position.x - vw / 2, y0 = camera.position.y - vh / 2;
  const out = [(screen.x - x0) / vw, (screen.y - y0) / vh, screen.w / vw, screen.h / vh];
  return out.every((v, i) => Math.abs(v - CANVAS[i]) < 1e-6) ? CANVAS : out;
}

// in the player's draw hook, after the skeleton: the linear framebuffer, encoded, onto the canvas
export function end(player) {
  const st = states.get(player);
  if (st?.saved) untint(st);
  if (!st?.on || !st.bound) return;
  const { gl, res } = st, w = res.w, h = res.h;
  st.bound = false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.BLEND);
  gl.useProgram(res.prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, res.tex);
  const u = res.u;
  gl.uniform1i(u.t, 0);
  gl.uniform2f(u.size, w, h);
  const screen = screenOnCanvas(st.screen, player.sceneRenderer?.camera);
  gl.uniform4f(u.screen, ...screen);
  gl.uniform1f(u.clear, st.clear ? 1 : 0);
  // Panini's extents: the game screen's aspect, the canvas's when the canvas is the screen
  const aspect = screen === CANVAS ? w / h : st.screen.w / st.screen.h;
  if (st.post && (!st.params || st.params.aspect !== aspect)) st.params = { aspect, p: postParams(st.post, aspect) };
  const p = (postOn && st.params?.p) || IDENTITY;
  gl.uniform1f(u.ca, p.ca);
  gl.uniform4f(u.panini, ...p.panini);
  gl.uniform1f(u.grade, p.grade ? 1 : 0);
  gl.uniform1f(u.exposure, p.exposure);
  for (const k of ["filt", "hsc", "lift", "gamma", "gain"]) gl.uniform3f(u[k], ...p[k]);
  gl.bindVertexArray(res.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null); // blending stays off, as spine's batcher leaves it after a frame
}

export const active = (player) => !!states.get(player)?.on;

// for checks: draw an attached player in linear light (true) or in plain sRGB values as before (false)
export function set(player, on) {
  const st = states.get(player);
  if (!st || st.on === !!on) return;
  st.on = !!on;
  for (const texture of pagesOf(player)) texture.update(texture.useMipMaps);
}
