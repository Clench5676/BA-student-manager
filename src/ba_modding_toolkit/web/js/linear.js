// Linear-light drawing for a spine-player, the way the game draws its memorial lobbies. Blue Archive renders in
// Unity's linear colour space (PlayerSettings m_ActiveColorSpace 1) and its Spine atlas textures are sRGB, so every
// blend happens in linear light: an additive glow over a bright scene adds little, a soft white veil over a dark one
// adds more. Drawn in sRGB values instead, the same glow washes the scene out (Kurumi's photo booth light turned her
// face white).
// Here the atlas pages are sampled as sRGB (decoded before filtering, as the GPU does in the game), the skeleton is
// blended into an sRGB framebuffer (blending in linear light) and one pass copies the result to the canvas, encoded
// again. Additive slots add colour only, never coverage, like the game's premultiplied vertex colours with alpha 0.
// Without WebGL2 the player keeps drawing as before.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
// the framebuffer holds linear, premultiplied colour; the canvas gets sRGB, premultiplied (the page composites the
// layers' canvases). Light beyond the coverage (additive over a transparent part of an upper layer) is passed on as
// it is, so it still brightens the layer below.
const FS = `#version 300 es
precision highp float;
uniform sampler2D t;
out vec4 o;
vec3 enc(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 c = texelFetch(t, ivec2(gl_FragCoord.xy), 0);
  vec3 cover = c.a > 0.0 ? enc(min(c.rgb / c.a, 1.0)) * c.a : vec3(0.0);
  o = vec4(min(cover + max(c.rgb - c.a, 0.0), 1.0), c.a);
}`;

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
  return { prog, vao, buf, sampler: gl.getUniformLocation(prog, "t"), fbo: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
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

// in the player's draw hook, after the skeleton: the linear framebuffer, encoded, onto the canvas
export function end(player) {
  const st = states.get(player);
  if (st?.saved) untint(st);
  if (!st?.on || !st.bound) return;
  const { gl, res } = st;
  st.bound = false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.BLEND);
  gl.useProgram(res.prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, res.tex);
  gl.uniform1i(res.sampler, 0);
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
