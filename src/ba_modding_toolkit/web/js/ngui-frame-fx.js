// The stationary UV particle in FX_UI_Mulligan_03 / FX_UI_Mulligan_Sub_03.
// Its actual mesh and material come from UIPopup_Mulligan. The mask shader scrolls FX_TEX_Bulletline_03;
// no TweenAlpha, UISpriteAnimation or CSS animation is involved.
import { fragmentSource } from './particles-gl.js';
import { toLinear } from './touch-fx.js';
import { uiExportUrl } from './api.js';
import { applyDir, euler } from './particles.js';

export function frameMesh(effect) {
  const { mesh, system, uvScale, width, height, sourceWidth, sourceHeight, incline } = effect;
  const size = system.main.size[0], lean = Math.tan(incline * Math.PI / 180);
  const color = system.main.color.col;
  const rotation = system.main.rotation;
  const turn = euler(...rotation.map(v => v * 180 / Math.PI));
  const data = [];
  for (const i of mesh.i) {
    const point = applyDir(turn, ...mesh.v.slice(i * 3, i * 3 + 3));
    const px = point[0] * size * uvScale[0], py = point[1] * size * uvScale[1];
    // Stretch the straight spans like the frame's sliced UISprite, retaining its authored corner radii.
    const y = py + Math.sign(py) * (height - sourceHeight) / 2;
    const x = px + Math.sign(px) * (width - sourceWidth) / 2 + y * lean;
    data.push(x, y, mesh.uv[i * 2], mesh.uv[i * 2 + 1], ...color);
  }
  return new Float32Array(data);
}

const live = new Set();
const pending = new WeakMap();
let observer, request = null;
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
function refresh() {
  for (const item of live) {
    if (item.canvas.isConnected) item.connected = true;
    else if (item.connected) { item.dispose(); live.delete(item); }
  }
  if (request === null && !reduced?.matches && [...live].some(item => item.canvas.isConnected && !item.canvas.closest('[hidden]'))) {
    request = requestAnimationFrame(tick);
  }
}
function observe(records) {
  for (const record of records) for (const node of record.addedNodes || []) {
    for (const canvas of [node, ...(node.querySelectorAll?.('canvas') || [])]) {
      const item = pending.get(canvas);
      if (item && canvas.isConnected) { pending.delete(canvas); item.connected = true; live.add(item); }
    }
  }
  refresh();
}
function tick(now) {
  request = null;
  for (const item of live) if (item.canvas.isConnected && !item.canvas.closest('[hidden]')) item.draw(now / 1000);
  refresh();
}
reduced?.addEventListener?.('change', () => {
  if (reduced.matches && request !== null) { cancelAnimationFrame(request); request = null; }
  refresh();
});

export async function renderFrameEffect(effect, host, { x, y, sx, sy, z, load }) {
  const canvas = document.createElement('canvas');
  // Include the mesh's actual extents, rather than clipping its glow to the UISprite dimensions.
  const data = frameMesh(effect), points = Array.from({ length: data.length / 8 }, (_, i) => [data[i * 8], data[i * 8 + 1]]);
  const halfW = Math.max(...points.map(p => Math.abs(p[0]))), halfH = Math.max(...points.map(p => Math.abs(p[1])));
  const width = halfW * 2 * sx, height = halfH * 2 * sy;
  const density = Math.max(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.ceil(width * density); canvas.height = Math.ceil(height * density);
  Object.assign(canvas.style, { position: 'absolute', left: `${x - width / 2}px`, top: `${y - height / 2}px`,
    width: `${width}px`, height: `${height}px`, zIndex: String(z + effect.depth), pointerEvents: 'none' });
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
  if (!gl?.createShader) return; // The prefab's static frame and check remain available without WebGL2.
  const shader = (type, source) => {
    const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, `#version 300 es
in vec2 a_pos; in vec2 a_uv; in vec4 a_color;
uniform vec2 u_half; out vec4 v_t0; out vec4 v_t1; out vec4 v_t2; out vec4 v_col; out vec3 v_n;
void main(){gl_Position=vec4(a_pos/u_half,0.,1.);v_t0=vec4(a_uv,0.,0.);v_t1=vec4(0.);v_t2=vec4(0.);v_col=a_color;v_n=vec3(0.,0.,1.);}`);
  // Reuse the App's port of DSFX/FX_SHADER_AlphaBlend_Add_Mask_0. NGUI's panel clipping is the list viewport.
  const fs = shader(gl.FRAGMENT_SHADER, fragmentSource('mask').replace('void main()', 'void frameMain()') + `
vec3 displayColor(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){frameMain();o.rgb=displayColor(o.rgb/max(o.a,.00001));}`);
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(), vao = gl.createVertexArray();
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  for (const [name, count, offset] of [['a_pos', 2, 0], ['a_uv', 2, 2], ['a_color', 4, 4]]) {
    const at = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, count, gl.FLOAT, false, 32, offset * 4);
  }
  const loc = name => gl.getUniformLocation(program, name), material = effect.material;
  gl.uniform2f(loc('u_half'), halfW, halfH);
  for (const [name, value] of Object.entries(material.floats)) gl.uniform1f(loc(name), value);
  const color = material.colors._Color;
  gl.uniform4f(loc('_Color'), ...color.map((v, i) => i < 3 ? toLinear(v) : v));
  const textures = [];
  const dispose = () => { for (const tex of textures) gl.deleteTexture(tex); gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); };
  try { await Promise.all(['_Tex_Main', '_Tex_Mask'].map(async(name, unit) => {
    const meta = material.tex[name], image = meta.id ? await load(uiExportUrl(`/asset/ui/selection-frame/${encodeURIComponent(meta.id)}.png`)) : null;
    const tex = gl.createTexture(); textures.push(tex); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, meta.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(loc(name), unit); gl.uniform4f(loc(`${name}_ST`), ...(meta.st || [1, 1, 0, 0]));
  })); } catch (error) { dispose(); throw error; }
  host.appendChild(canvas);
  const item = { canvas, connected: false,
    draw(time) { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc('_TimeY'), time); gl.drawArrays(gl.TRIANGLES, 0, data.length / 8); },
    dispose,
  };
  item.draw(0);
  if (canvas.isConnected) { item.connected = true; live.add(item); }
  else pending.set(canvas, item);
  if (!observer && globalThis.MutationObserver) {
    observer = new MutationObserver(observe); observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  refresh();
}
