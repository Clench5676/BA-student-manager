// The depth of field a memorial lobby's intro turns on (its PPV_D volume), as URP 12 draws Gaussian depth of field
// (PostProcessPass.DoGaussianDepthOfField, GaussianDepthOfField.shader), before the colour steps of the camera's
// post-processing (linear.js setPrepass). The lobby's Spine art is transparent and writes no depth, so the depth
// texture holds the far plane everywhere: past the volume's far blur end (0 in every lobby's profile) the circle of
// confusion is 1 all over the screen, and the whole picture is blurred: downsampled to half size, blurred across and
// then down with the 3-tap kernel (taps 1.333 radii apart, weights 0.353, 0.294, 0.353), and taken instead of the
// sharp picture (the composite's non-linear blend is 1 at that circle of confusion). The radius is the volume's max
// radius (blended by its weight) at 1080p: taps 1.333 x radius x (the game screen's width / 1080) pixels apart, here
// in canvas pixels of the game's screen, so the blur keeps its size on the art in the left view and when zoomed.
// No lobby uses Bokeh depth of field: the five profiles that set its lens leave the mode Off.

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D t;
in vec2 uv;
out vec4 o;
void main() { o = texture(t, uv); }`;
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D t;
uniform vec2 dir;
in vec2 uv;
out vec4 o;
void main() { o = texture(t, uv - dir) * 0.35294118 + texture(t, uv) * 0.29411765 + texture(t, uv + dir) * 0.35294118; }`;

const states = new WeakMap();

function program(gl, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(prog, s);
    const log = gl.getShaderParameter(s, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(s) || "shader";
    gl.deleteShader(s);
    if (log) { gl.deleteProgram(prog); throw new Error(log); }
  }
  gl.bindAttribLocation(prog, 0, "p");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || "program";
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  return { prog, t: gl.getUniformLocation(prog, "t"), dir: gl.getUniformLocation(prog, "dir") };
}

function resources(gl) {
  const vao = gl.createVertexArray(), buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buf, copy: program(gl, FS_COPY), blur: program(gl, FS_BLUR), tex: [], fbo: [], w: 0, h: 0 };
}

function release(gl, r) {
  if (!r || gl.isContextLost()) return;
  for (const t of r.tex) gl.deleteTexture(t);
  for (const f of r.fbo) gl.deleteFramebuffer(f);
  gl.deleteVertexArray(r.vao);
  gl.deleteBuffer(r.buf);
  gl.deleteProgram(r.copy.prog);
  gl.deleteProgram(r.blur.prog);
}

// two half-size sRGB targets (decoded when sampled, filtered linearly, clamped)
function targets(gl, r, w, h) {
  if (r.w === w && r.h === h && r.tex.length) return true;
  for (const t of r.tex) gl.deleteTexture(t);
  for (const f of r.fbo) gl.deleteFramebuffer(f);
  r.tex = [];
  r.fbo = [];
  for (let i = 0; i < 2; i++) {
    const t = gl.createTexture(), f = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    r.tex.push(t);
    r.fbo.push(f);
  }
  r.w = w;
  r.h = h;
  return true;
}

// the blur's tap spacing in canvas pixels for a game screen `screenW` canvas pixels wide (URP: 1.333 taps of a half
// resolution texel times the max radius scaled from 1080p)
export const tapPixels = (radius, screenW) => 1.33333333 * radius * (screenW / 1080);

function pass(gl, src, st, w, h, screen) {
  if (!st.on) return null;
  if (!st.res) {
    try { st.res = resources(gl); } catch (err) { console.warn("depth of field", err); st.on = false; return null; }
  }
  const res = st.res, hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
  if (!targets(gl, res, hw, hh)) { st.on = false; return null; }
  const step = tapPixels(st.radius, (screen?.[2] || 1) * w);
  gl.disable(gl.BLEND);
  gl.viewport(0, 0, hw, hh);
  gl.bindVertexArray(res.vao);
  gl.activeTexture(gl.TEXTURE0);
  // downsample (bilinear at the half-size texel centres: the 2 x 2 average), then across, then down
  const run = (prog, from, dst, dir) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo[dst]);
    gl.useProgram(prog.prog);
    gl.bindTexture(gl.TEXTURE_2D, from);
    gl.uniform1i(prog.t, 0);
    if (dir) gl.uniform2f(prog.dir, dir[0], dir[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  run(res.copy, src, 0, null);
  run(res.blur, res.tex[0], 1, [step / w, 0]);
  run(res.blur, res.tex[1], 0, [0, step / h]);
  gl.bindVertexArray(null);
  gl.viewport(0, 0, w, h);
  return res.tex[0];
}

// the depth of field on a player ({radius}: the volume's max radius) or off (null); Linear's pass draws with it
export function set(player, dof, Linear) {
  const gl = player?.context?.gl;
  if (!gl || typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return;
  let st = states.get(player);
  if (!dof) {
    if (st?.installed) { Linear.setPrepass(player, null); st.installed = false; }
    return;
  }
  if (!st) {
    st = { on: true, res: null, radius: 1, installed: false };
    st.restorable = { restore: () => { st.res = null; } }; // a lost context freed them: made again on the next frame
    player.context.addRestorable?.(st.restorable);
    states.set(player, st);
  }
  st.radius = dof.radius;
  if (!st.installed) {
    Linear.setPrepass(player, (g, tex, w, h, screen) => pass(g, tex, st, w, h, screen));
    st.installed = true;
  }
}

// before the player is disposed: its targets and programs
export function detach(player, Linear) {
  const st = states.get(player);
  if (!st) return;
  states.delete(player);
  if (st.installed) Linear?.setPrepass(player, null);
  player.context?.removeRestorable?.(st.restorable);
  if (player.context?.gl) release(player.context.gl, st.res);
}
