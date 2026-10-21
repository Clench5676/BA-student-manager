// A lobby skeleton drawn with the materials the game's spine-unity gives it (lobby.json layer "materials",
// gameassets/spine_materials.py), in spine-player's batch:
// - the atlas pages that the game draws with a shader of its own: Aru's third page multiplies (Spine/Blend Modes/
//   Skeleton PMA Multiply), the water and river pages of CH0319, CH0326 and CH0355 scroll a noise distortion
//   (Spine/Skeleton MX Standard - NoiseFlowAnimation), CH0310's game screen glitches in two passes (Spine/Skeleton MX
//   Portrait Noise). Their slots draw with ports of those compiled programs, from the game's own vertex colours
//   (premultiplied, alpha 0 for an additive slot) and with the shader's blend. The other pages keep spine-player's
//   drawing, which is the game's Spine/Skeleton.
// - slot blend modes: Multiply and Screen slots of a skeleton without replacement materials for that mode keep their
//   page's material and draw as Normal (ch0163's light_01, Hiyori's R_eye_ligth_02, airi0's FX_Light_01); with them
//   (Hina's multiply light), the replacement's shader.
// - the dark colour (two-colour tint) never reaches the screen: the renderer's tintBlack is off in every lobby and no
//   lobby shader reads it (CH0205's wing and Neru's halo animate one).
// Hooks spine-player's PolygonBatcher (the page of each draw is its texture) and SkeletonRenderer; needs linear.js.
import * as Linear from "./linear.js";
import { toLinear } from "./touch-fx.js";

// Runtime hooks run only on players created after lobby.js awaits ensureSpine().

const states = new WeakMap(), attached = new Set();

// for checks: draw with the game's materials (true) or as spine-player alone does (false: the slots' own blend modes,
// the dark colour, spine-player's shader on every page)
export let shown = true;
export const show = (on) => { shown = !!on; };
// UnityEngine.Rendering.BlendMode -> GL factors
const FACTOR = (gl) => [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.SRC_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA,
  gl.ONE_MINUS_SRC_COLOR, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.SRC_ALPHA_SATURATE, gl.ONE_MINUS_SRC_ALPHA];
const MODE = { 2: "multiply", 3: "screen", 1: "additive" }; // spine.BlendMode -> the blend lists' names

// spine-player's batch vertex: position, light colour, UV, dark colour (all four are bound by name, so every program
// takes them)
const VS = `#version 300 es
in vec4 a_position;
in vec4 a_color;
in vec2 a_texCoords;
in vec4 a_color2;
uniform mat4 u_projTrans;
uniform float u_shift;
out vec4 v_light;
out vec4 v_dark;
out vec2 v_uv;
out vec2 v_pos;
void main() {
  v_light = a_color;
  v_dark = a_color2;
  v_uv = a_texCoords;
  v_pos = a_position.xy;
  gl_Position = u_projTrans * vec4(a_position.x + u_shift, a_position.yzw);
}`;
// What every program shares: the page, and the game's vertex colour from spine-player's. linear.js tints the slots as
// their page's shader takes them (u_tinted; slot-colours.js): straight colour through that shader's curve (UnityCG's
// cubic for Spine/Skeleton and the blend-mode shaders, none for the MX ones), an additive slot's colour times its
// alpha as a whole with alpha 1. The game's mesh carries it premultiplied, an additive slot with alpha 0
// (u_additive). Untinted (spine-player's straight colour), programs that convert it to linear light take it decoded
// with the cubic (lin), the MX ones as stored (raw).
const HEAD = `#version 300 es
precision highp float;
in vec4 v_light;
in vec4 v_dark;
in vec2 v_uv;
in vec2 v_pos;
uniform sampler2D u_texture;
uniform float u_tinted, u_additive, u_time, u_dark;
out vec4 o;
// UnityCG's GammaToLinearSpace, the cubic fit of the sRGB curve
vec3 cubic(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
vec4 vertexColour(bool lin) {
  vec3 c = v_light.rgb;
  float a = v_light.a;
  // linear.js: as the page's shader takes it (an additive slot: its colour times its alpha, alpha 1); else as
  // spine-player passes it
  vec3 g = u_additive > 0.5 ? c * a : c;
  vec3 rgb = u_tinted > 0.5 ? c : (lin ? cubic(g) : g);
  return u_additive > 0.5 ? vec4(rgb, 0.0) : vec4(rgb * a, a);
}
// a point of 0..1 squared, as the MX programs test it (0.001 to 0.999)
bool inside(vec2 q) { return all(greaterThanEqual(q, vec2(0.001))) && all(lessThanEqual(q, vec2(0.999))); }
// the dark colour is never drawn (u_dark is never set); the read keeps its attribute in the program
float unused() { return u_dark > 0.5 ? v_dark.a : 0.0; }
`;

// The programs, from the game's D3D11 bytecode. pma: Spine/Skeleton and the Spine/Blend Modes shaders (the vertex
// colour converted to linear light, premultiplied, times _Color premultiplied; with _STRAIGHT_ALPHA_INPUT the texture
// premultiplied first). noiseFlow, portraitNoise: below.
export const PROGRAMS = {
  pma: {
    floats: ["straight"], colors: ["_Color"],
    src: `uniform float straight;
uniform vec4 _Color;
void main() {
  vec4 t = texture(u_texture, v_uv);
  if (straight > 0.5) t.rgb *= t.a;
  o = t * vertexColour(true) * vec4(_Color.rgb * _Color.a, _Color.a) + unused();
}`,
  },
  // Spine/Skeleton MX Standard - NoiseFlowAnimation: the page's UV shifted along both axes by a scrolling noise,
  // inside a square (0.001 to 0.999 around the centre) of a plane in the skeleton's space: the vertex position less
  // _CenterX / Y (Unity units: the skeleton's times its data scale), times 0.01, turned by _Rotate, skewed by
  // _SkewedX / Y, and bent towards a vanishing line by _SlopeForward and _SlopeSide (two sides of the line, each
  // clamped to its half). The shift is (2 noise - 1) x _PixelNoisePower x 0.001 x the vertex alpha; the texture is
  // premultiplied by its alpha and times the vertex colour as stored.
  noiseFlow: {
    tex: ["_NoiseTex"],
    floats: ["_CenterX", "_CenterY", "_Rotate", "_SkewedX", "_SkewedY", "_SlopeForward", "_SlopeSide", "_NoiseTexTillingX",
      "_NoiseTexTillingY", "_PixelNoiseSpeedX", "_PixelNoiseSpeedY", "_PixelNoisePower", "u_ds"],
    src: `uniform sampler2D _NoiseTex;
uniform float _CenterX, _CenterY, _Rotate, _SkewedX, _SkewedY, _SlopeForward, _SlopeSide, _NoiseTexTillingX, _NoiseTexTillingY,
  _PixelNoiseSpeedX, _PixelNoiseSpeedY, _PixelNoisePower, u_ds;
void main() {
  // the vertex program's plane coordinates (z, w of its TEXCOORD0)
  vec2 d = (v_pos * u_ds - vec2(_CenterX, _CenterY)) * 0.01;
  float r = radians(_Rotate), s = sin(r), c = cos(r);
  float side = s * d.x + c * d.y;
  float z = c * d.x - s * d.y + side * _SkewedX;
  float w = z * _SkewedY + side;
  // the bend: divided by a = 1 - 25 w _SlopeForward, then by b = 1 - 25 _SlopeSide x (its x); the program takes the
  // side a < 0 (b < 0) when that lands inside, else the side a > 0 (b > 0); a division by a zero side saturates
  // outside there (D3D's saturate of an infinity or NaN)
  float a = 1.0 - w * _SlopeForward * 25.0, k = 25.0 * _SlopeSide;
  vec2 p = vec2(z, w), q = vec2(0.0);
  bool ok = false;
  if (a < 0.0) {
    vec2 pn = p / a;
    float bn = 1.0 - pn.x * k;
    if (bn < 0.0) { q = clamp(pn / bn + 0.5, 0.0, 1.0); ok = inside(q); }
  }
  if (!ok && a > 0.0) {
    vec2 pp = p / a;
    float bp = 1.0 - pp.x * k;
    if (bp > 0.0) { q = clamp(pp / bp + 0.5, 0.0, 1.0); ok = inside(q); }
  }
  float m = ok ? 1.0 : 0.0;
  float n = texture(_NoiseTex, fract(q * vec2(_NoiseTexTillingX, _NoiseTexTillingY) + u_time * vec2(_PixelNoiseSpeedX, _PixelNoiseSpeedY))).r;
  vec4 col = vertexColour(false);
  float shift = (2.0 * n * m - 1.0) * _PixelNoisePower * 0.001 * col.a * m;
  vec4 t = texture(u_texture, v_uv + shift);
  o = vec4(t.rgb * t.a, t.a) * col + unused();
}`,
  },
  // Spine/Skeleton MX Portrait Noise, its two passes (Glitch, then ForwardLit): each draws the horizontal bands where
  // sin(screen v x _GlitchThickness + time) is at or above 0 (the first) or at or below it (the second), shifted
  // across by _GlitchOffset (the first right, the second left, in the camera's clip space) on the frames a hash of the
  // time passes _GlitchFreq; colour: the page (_Black lifting its darks) times _Color, 0.72 x the scan line texture's
  // red, plus _PortraitNoiseTint times (its red x luminance + its green x 0.03); alpha the page's times the vertex
  // alpha times _Color.a (0 for an additive slot). The vertex colour's rgb is never read.
  portraitNoise: {
    tex: ["_PortraitNoiseTex"], passes: 2,
    floats: ["_GlitchThickness", "_ScanLineSpeed", "u_pass"], colors: ["_Color", "_Black", "_PortraitNoiseTint"],
    vectors: ["u_screen"],
    src: `uniform sampler2D _PortraitNoiseTex;
uniform float _GlitchThickness, _ScanLineSpeed, u_pass;
uniform vec4 _Color, _Black, _PortraitNoiseTint, u_screen;
void main() {
  float v = (v_pos.y - u_screen.y) / u_screen.w;
  float band = sin(v * _GlitchThickness + u_time);
  if ((u_pass < 0.5 ? band : -band) < 0.0) discard;
  vec2 nt = texture(_PortraitNoiseTex, vec2(0.5, v * 10.0 + u_time * _ScanLineSpeed)).rg;
  vec4 t = texture(u_texture, v_uv);
  vec3 c = (_Black.rgb * (1.0 - t.rgb) + t.rgb) * _Color.rgb;
  float lum = dot(c, vec3(0.17008, 0.57216, 0.05776));
  vec3 rgb = nt.r * 0.72 * c + (nt.r * lum + nt.g * 0.03) * _PortraitNoiseTint.rgb;
  float a = clamp(u_additive > 0.5 ? 0.0 : v_light.a * _Color.a, 0.0, 1.0) * t.a;
  o = vec4(rgb * a, a) + unused();
}`,
  },
};

// the frame's glitch of a Portrait Noise pass: frac(sin(t x (12.9898 + 78.233)) x 43758.5) at or above _GlitchFreq,
// t being _Time.y for the first pass and _Time.w (3 t) for the second
export function glitch(t, pass, freq) {
  const x = Math.sin((pass ? 3 * t : t) * 91.2228) * 43758.5;
  return x - Math.floor(x) >= freq;
}

// a uniform of one of these programs, set only where the compiled program kept it (spine's Shader throws for the
// others); by program, which spine's Shader compiles again after a lost context
const locations = new WeakMap();
function uniform(gl, sh, name) {
  const prog = sh.getProgram();
  let m = locations.get(prog);
  if (!m) locations.set(prog, (m = new Map()));
  if (!m.has(name)) m.set(name, gl.getUniformLocation(sh.getProgram(), name));
  return m.get(name);
}
const setF = (gl, sh, name, v) => { const l = uniform(gl, sh, name); if (l) gl.uniform1f(l, v); };
const setI = (gl, sh, name, v) => { const l = uniform(gl, sh, name); if (l) gl.uniform1i(l, v); };
const set4 = (gl, sh, name, a, b, c, d) => { const l = uniform(gl, sh, name); if (l) gl.uniform4f(l, a, b, c, d); };

function shaderFor(context, kind) {
  const p = PROGRAMS[kind];
  return new spine.Shader(context, VS, HEAD + p.src);
}

// a material texture as the game samples it (sRGB or not, filter, wrap), flipped so UV (0, 0) is its bottom left
function uploadTexture(gl, meta, image) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  if (image) gl.texImage2D(gl.TEXTURE_2D, 0, meta.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  else {
    const px = { white: [255, 255, 255, 255], black: [0, 0, 0, 0], gray: [128, 128, 128, 128], grey: [128, 128, 128, 128] }[meta.default] || [255, 255, 255, 255];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px));
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  const mips = !!image && !!meta.mips, point = meta.filter === 0;
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, point ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? (meta.filter === 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) : point ? gl.NEAREST : gl.LINEAR);
  const wrap = (w) => (w === 1 || w === 3 ? gl.CLAMP_TO_EDGE : w === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(meta.wrap?.[0] ?? 0));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(meta.wrap?.[1] ?? 0));
  return tex;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// the slot blend modes drawn as Normal: Multiply and Screen without replacement materials (lobby.json layer
// materials.blend), whose slots keep their page's material. The slots keep their blend mode (the painted area still
// leaves such lights out); only their draws change. slotBlends keeps the declared modes for an explicit NPC exception.
export function fallbackModes(materials, slotBlends = false) {
  const out = new Set();
  if (slotBlends) return out;
  for (const mode of [spine.BlendMode.Multiply, spine.BlendMode.Screen]) if (!(materials?.blend && MODE[mode] in materials.blend)) out.add(mode);
  return out;
}

// the material a draw takes: a replacement material for its slot's blend mode on its page, else its page's own when a
// ported program draws it. BlendModeMaterials.CloneAtlasRegionWithMaterial takes the list's entry whose pageName is
// the page's and gives a page the list does not name no material, as a null reference does: both draw as
// spine-player's own (in today's lobbies every Multiply slot with a list is on a page it names: Hina's on Hina_home3)
export function materialOf(materials, page, mode) {
  const name = MODE[mode];
  const by = name && materials?.blend?.[name];
  if (by) return by[page] || null;
  return materials?.pages?.[page] || null;
}

// switch a loaded player (linear.js attached) to its layer's materials; screen() gives the game's view in the layer's
// skeleton units (lobby.js layerViewport), base the lobby's route for the materials' own textures
export function attach(player, layer, { screen = () => null, base = "", load = loadImage, slotBlends = false } = {}) {
  const mats = layer?.materials;
  if (!mats || !Linear.active(player) || states.has(player)) return false;
  const gl = player.context.gl, renderer = player.sceneRenderer, batcher = renderer?.batcher, sr = renderer?.skeletonRenderer;
  if (!batcher || !sr) return false;
  const data = player.skeleton.data;
  const fallback = fallbackModes(mats, slotBlends);
  const st = { gl, mats, fallback, normal: (data.slots || []).filter((slot) => fallback.has(slot.blendMode)).map((slot) => slot.name),
    pages: new Map(), shaders: new Map(), textures: new Map(), images: new Map(), mode: 0, pma: false, run: null, disposed: false };
  states.set(player, st);
  attached.add(st);
  // the dark colour is never drawn (tintBlack off): spine-player draws a slot without one as without a tint
  if (!mats.tintBlack) {
    st.draw = sr.draw;
    sr.draw = function (...args) {
      const saved = [];
      if (shown) for (const slot of args[1]?.slots || []) if (slot.darkColor) { saved.push([slot, slot.darkColor]); slot.darkColor = null; }
      try { return st.draw.apply(this, args); } finally { for (const [slot, dark] of saved) slot.darkColor = dark; }
    };
  }
  const custom = [...Object.values(mats.pages || {}), ...Object.values(mats.blend || {}).flatMap((b) => Object.values(b))]
    .filter((m) => m && PROGRAMS[m.program]);
  if (!custom.length && !st.normal.length) return true;
  // the pages by their GL texture (the page's file name without its extension, as the prefab names it)
  for (const skin of data.skins) {
    for (const entry of skin.getAttachments()) {
      const region = entry.attachment?.region;
      if (region?.texture && region.page?.name) st.pages.set(region.texture, region.page.name.replace(/\.[^./]+$/, ""));
    }
  }
  // a lost context has freed the material textures: made again from the images in memory (spine's Shader compiles
  // its programs again itself)
  st.restorable = { restore: () => st.textures.clear() };
  player.context.addRestorable?.(st.restorable);
  for (const m of custom) {
    for (const meta of Object.values(m.tex || {})) {
      if (!meta.id || st.images.has(meta.id)) continue;
      st.images.set(meta.id, null);
      load(`${base}fx_${encodeURIComponent(meta.id)}.png`).then((img) => { if (!st.disposed) st.images.set(meta.id, img); }, () => {});
    }
  }
  const F = FACTOR(gl);
  // the batcher's methods it replaces: linear.js's setBlendMode (its own property), spine-player's others
  const own = {}, hooked = ["setBlendMode", "draw", "flush", "begin"];
  for (const k of hooked) own[k] = batcher[k];
  st.own = own;
  st.ownProps = hooked.filter((k) => Object.prototype.hasOwnProperty.call(batcher, k));
  st.batcher = batcher;
  const restoreBlend = () => {
    batcher.srcColorBlend = -1; // the cached blend is not what GL has
    own.setBlendMode.call(batcher, st.mode, st.pma);
  };
  const time = () => player.time?.totalTime ?? performance.now() / 1000;
  // start drawing with a material (null: spine-player's own shader and blend)
  const use = (mat, additive) => {
    if (!mat) {
      batcher.shader = renderer.batcherShader;
      renderer.batcherShader.bind();
      restoreBlend();
      return;
    }
    const kind = mat.program, shaders = st.shaders.get(kind) || [];
    if (!shaders.length) {
      for (let i = 0; i < (PROGRAMS[kind].passes || 1); i++) shaders.push(shaderFor(player.context, kind));
      st.shaders.set(kind, shaders);
    }
    const t = time(), view = screen(), proj = renderer.camera.projectionView.values;
    shaders.forEach((sh, pass) => {
      sh.bind();
      { const l = uniform(gl, sh, spine.Shader.MVP_MATRIX); if (l) gl.uniformMatrix4fv(l, false, proj); }
      setI(gl, sh, spine.Shader.SAMPLER, 0);
      setF(gl, sh, "u_tinted", Linear.vertexColours ? 1 : 0);
      setF(gl, sh, "u_additive", additive ? 1 : 0);
      setF(gl, sh, "u_time", t);
      setF(gl, sh, "u_pass", pass);
      setF(gl, sh, "u_ds", mats.scale || 0.01);
      setF(gl, sh, "straight", mat.straight ? 1 : 0);
      for (const f of PROGRAMS[kind].floats || []) if (f in (mat.floats || {})) setF(gl, sh, f, mat.floats[f]);
      for (const c of PROGRAMS[kind].colors || []) {
        const v = mat.colors?.[c] || [1, 1, 1, 1];
        set4(gl, sh, c, toLinear(v[0]), toLinear(v[1]), toLinear(v[2]), v[3]);
      }
      if (view) set4(gl, sh, "u_screen", view.x, view.y, view.width, view.height);
      // the glitch frames shift each pass across by _GlitchOffset in the camera's clip space (half the screen per unit)
      const shift = kind === "portraitNoise" && view && glitch(t, pass, mat.floats?._GlitchFreq ?? 1)
        ? (pass ? -1 : 1) * (mat.floats?._GlitchOffset || 0) * view.width * 0.5 : 0;
      setF(gl, sh, "u_shift", shift);
      (PROGRAMS[kind].tex || []).forEach((name, i) => {
        const meta = mat.tex?.[name] || { default: "white" }, key = meta.id || `default:${meta.default}`;
        let tex = st.textures.get(key);
        if (!tex && (!meta.id || st.images.get(meta.id))) st.textures.set(key, (tex = uploadTexture(gl, meta, meta.id ? st.images.get(meta.id) : null)));
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex || null);
        setI(gl, sh, name, 1 + i);
      });
      gl.activeTexture(gl.TEXTURE0);
    });
    batcher.shader = shaders[shaders.length - 1];
    // the shader's blend for colour and coverage, as the game's pass sets it
    gl.blendFuncSeparate(F[mat.src] ?? gl.ONE, F[mat.dst] ?? gl.ONE_MINUS_SRC_ALPHA, F[mat.srcA] ?? gl.ONE, F[mat.dstA] ?? gl.ONE_MINUS_SRC_ALPHA);
  };
  batcher.setBlendMode = function (mode, pma) {
    st.mode = shown && st.fallback.has(mode) ? spine.BlendMode.Normal : mode;
    st.pma = pma;
    if (!st.run) own.setBlendMode.call(this, st.mode, pma); // a ported material sets its own blend when it starts
  };
  batcher.begin = function (shader) {
    st.run = null; // spine-player's shader again (between the parts of a skeleton too), with the slot's blend
    const out = own.begin.call(this, shader);
    restoreBlend();
    return out;
  };
  batcher.draw = function (texture, vertices, indices) {
    const mat = materialOf(st.mats, st.pages.get(texture), st.mode);
    const additive = st.mode === spine.BlendMode.Additive;
    const want = shown && mat && PROGRAMS[mat.program] ? mat : null;
    if (want !== (st.run?.mat ?? null) || (want && st.run.additive !== additive)) {
      this.flush();
      st.run = want ? { mat: want, additive } : null;
      use(want, additive);
    }
    return own.draw.call(this, texture, vertices, indices);
  };
  // a two-pass material draws the batch once per pass
  batcher.flush = function () {
    const shaders = st.run && st.shaders.get(st.run.mat.program);
    if (shaders?.length > 1 && this.verticesLength > 0 && this.lastTexture) {
      for (let i = 0; i < shaders.length - 1; i++) {
        shaders[i].bind();
        this.lastTexture.bind();
        this.mesh.draw(shaders[i], gl.TRIANGLES);
      }
      shaders[shaders.length - 1].bind();
    }
    return own.flush.call(this);
  };
  return true;
}

// before the player is disposed (and before linear.js lets go): spine-player's own methods, blend modes and objects back
export function detach(player) {
  const st = states.get(player);
  if (!st) return;
  states.delete(player);
  attached.delete(st);
  st.disposed = true;
  const sr = player.sceneRenderer?.skeletonRenderer;
  if (st.draw && sr) sr.draw = st.draw;
  if (st.restorable) player.context?.removeRestorable?.(st.restorable);
  if (st.batcher) {
    for (const [k, fn] of Object.entries(st.own)) {
      if (st.ownProps.includes(k)) st.batcher[k] = fn;
      else delete st.batcher[k];
    }
    if (st.batcher.shader !== player.sceneRenderer.batcherShader && !st.batcher.isDrawing) st.batcher.shader = player.sceneRenderer.batcherShader;
  }
  const gl = st.gl;
  if (!gl.isContextLost()) {
    for (const list of st.shaders.values()) for (const sh of list) sh.dispose();
    for (const tex of st.textures.values()) gl.deleteTexture(tex);
  }
  st.shaders.clear();
  st.textures.clear();
  st.images.clear();
}

// for checks: what each attached player draws with ported materials (pages by program, the programs compiled) and
// which slots fell back to Normal
export const stats = () => [...attached].map((st) => ({
  pages: Object.fromEntries(Object.entries(st.mats.pages || {}).map(([p, m]) => [p, m.program])),
  normal: st.normal, tintBlack: !!st.mats.tintBlack, shaders: [...st.shaders.keys()] }));
