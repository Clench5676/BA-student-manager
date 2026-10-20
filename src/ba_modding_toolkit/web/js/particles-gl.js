// Draws a memorial lobby's particle effects (particles.js) inside its skeleton players, in linear light like them:
// each system goes into the WebGL2 context of the layer it sorts after (or before the bottom one), blended into that
// player's linear framebuffer (linear.js) between the frame's clear and the skeleton, between two parts of the
// skeleton (one per render queue of its atlas pages, skeleton-parts.js) or after the skeleton. The
// shaders port the game's compiled DSFX programs; their textures come from the lobby's own route (fx_<id>.png, memory
// only) and are sampled as sRGB where the game imports them so. Without linear light (no WebGL2) nothing is drawn.
import * as Linear from "./linear.js";
import { Effects, STRIDE, drawOrder, geometry, queuesOf, slotOf, spriteGeometry } from "./particles.js";
import { toLinear } from "./touch-fx.js";

const VS_HEAD = `#version 300 es
in vec2 a_pos;
in vec4 a_t0;
in vec4 a_t1;
in vec4 a_t2;
in vec4 a_col;
in vec3 a_n;
uniform mat4 u_proj;
out vec4 v_t0;
out vec4 v_t1;
out vec4 v_t2;
out vec4 v_col;
out vec3 v_n;
`;
// The DSFX *_1a vertex programs route the particle's custom data into each UV: per UV, CustomData_<UV>Tiling_CD1XYXY
// and _CD2XYXY pick components of custom data 1 (TEXCOORD1) and 2 (TEXCOORD2) that scale the UV, and
// CustomData_<UV>Offset_CD1XYXY and _CD2XYXY the ones that are added to it; the fragment program adds the plain
// tiled UV and the scrolling.
const CD_UV = `vec2 cdUv(vec2 base, vec4 t1, vec4 t2, vec4 o1, vec4 o2) {
  vec4 a = a_t1 * t1, b = a_t2 * t2, c = a_t1 * o1, d = a_t2 * o2;
  return base * (a.xy + a.zw + b.xy + b.zw) + c.xy + c.zw + d.xy + d.zw;
}`;
// the selector vectors of one UV in a *_1a material (the double distortion's per channel: DistortTilingR_CD1XYXY)
const cd = (uv, ch = "") => [`_CustomData_${uv}Tiling${ch}_CD1XYXY`, `_CustomData_${uv}Tiling${ch}_CD2XYXY`,
  `_CustomData_${uv}Offset${ch}_CD1XYXY`, `_CustomData_${uv}Offset${ch}_CD2XYXY`];
const cdUv = (base, uv, ch = "") => `cdUv(${base}, ${cd(uv, ch).join(", ")})`;
const tiled = (t) => `uv * ${t}_ST.xy + ${t}_ST.zw`;

const HEAD = `#version 300 es
precision highp float;
in vec4 v_t0;
in vec4 v_t1;
in vec4 v_t2;
in vec4 v_col;
in vec3 v_n;
uniform float _TimeY;
out vec4 o;
`;
const on = (name) => `(${name} != 0.0)`;
// The fragment programs, from the game's D3D11 bytecode (DSFX/FX_SHADER_*): TEXCOORD0.xy is the UV, TEXCOORD1 and
// TEXCOORD2 the custom data where the renderer's streams put them (0 otherwise), COLOR the particle colour.
export const PROGRAMS = {
  // DSFX/FX_SHADER_Additive_0 (One One)
  additive: {
    tex: ["_Texture"], floats: ["_Custom_Data_Offset_Use"], colors: ["_Color"],
    src: `void main() {
  vec2 uv = v_t0.xy * _Texture_ST.xy + _Texture_ST.zw;
  if ${on("_Custom_Data_Offset_Use")} uv += v_t1.xy;
  vec4 t = texture(_Texture, uv);
  o = vec4(t.rgb * v_col.rgb * _Color.rgb * v_col.a * t.a, 1.0);
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_0 (SrcAlpha OneMinusSrcAlpha)
  alphaBlend: {
    tex: ["_Texture"], floats: ["_Custom_Data_Offset_Use", "_Main_Texture_No", "_Multiply", "_RGBRGBA"], colors: ["_Color"],
    src: `void main() {
  vec2 uv = v_t0.xy * _Texture_ST.xy + _Texture_ST.zw;
  if ${on("_Custom_Data_Offset_Use")} uv += v_t1.xy;
  vec4 t = texture(_Texture, uv);
  vec3 rgb = ${on("_Main_Texture_No")} ? vec3(1.0) : t.rgb;
  float a = ${on("_RGBRGBA")} ? t.a : t.r;
  o = vec4(rgb * _Color.rgb * v_col.rgb * _Multiply, clamp(a * v_col.a * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_Add (One OneMinusSrcAlpha)
  alphaBlendAdd: {
    tex: ["_Texture"], floats: ["_Custom_Data_Offset_Use", "_Main_Texture_No", "_Multiply", "_RGBRGBA"], colors: ["_Color"],
    src: `void main() {
  vec2 uv = v_t0.xy * _Texture_ST.xy + _Texture_ST.zw;
  if ${on("_Custom_Data_Offset_Use")} uv += v_t1.xy;
  vec4 t = texture(_Texture, uv);
  float a = ${on("_RGBRGBA")} ? t.a : t.r;
  vec3 rgb = ${on("_Main_Texture_No")} ? vec3(1.0) : t.rgb;
  o = vec4(rgb * v_col.rgb * _Color.rgb * _Multiply * a, clamp(a * v_col.a * _Color.a * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_Add_Mask_0 (One OneMinusSrcAlpha)
  mask: {
    tex: ["_Tex_Main", "_Tex_Mask"], colors: ["_Color"],
    floats: ["_Custom_Data_MainMask_Offset_Use", "_Main_Speed_X", "_Main_Speed_Y", "_Mask_Speed_X", "_Mask_Speed_Y", "_Multiply", "_RGBRGBA"],
    src: `void main() {
  vec4 off = ${on("_Custom_Data_MainMask_Offset_Use")} ? v_t1 : vec4(0.0);
  vec4 m = texture(_Tex_Main, v_t0.xy * _Tex_Main_ST.xy + _Tex_Main_ST.zw + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y) + off.xy);
  float k = texture(_Tex_Mask, v_t0.xy * _Tex_Mask_ST.xy + _Tex_Mask_ST.zw + _TimeY * vec2(_Mask_Speed_X, _Mask_Speed_Y) + off.zw).r;
  vec3 sel = ${on("_RGBRGBA")} ? vec3(m.a) : m.rgb;
  o = vec4(sel * m.rgb * v_col.rgb * _Color.rgb * k * _Multiply, clamp(v_col.a * v_col.a * sel.x * _Color.a * k * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_Add_Distort_0 (One OneMinusSrcAlpha)
  distort: {
    tex: ["_Tex_Main", "_Tex_Mask", "_Tex_Distort"], colors: ["_Color"],
    floats: ["_Custom_Data_Distort_Power_Use", "_Custom_Data_MainMask_Offset_Use", "_Main_Distortion_Use", "_Mask_Distortion_Use",
      "_Distortion_Power_X", "_Distortion_Power_Y", "_Dis_Speed_X", "_Dis_Speed_Y", "_Main_Speed_X", "_Main_Speed_Y",
      "_Mask_Speed_X", "_Mask_Speed_Y", "_Multiply", "_RGBRGBA"],
    src: `void main() {
  vec2 uv = v_t0.xy;
  vec4 d = texture(_Tex_Distort, uv * _Tex_Distort_ST.xy + _Tex_Distort_ST.zw + _TimeY * vec2(_Dis_Speed_X, _Dis_Speed_Y));
  vec2 power = (${on("_Custom_Data_Distort_Power_Use")} ? v_t2.xy : vec2(0.0)) + vec2(_Distortion_Power_X, _Distortion_Power_Y);
  vec2 dd = d.xy * power;
  vec4 off = ${on("_Custom_Data_MainMask_Offset_Use")} ? v_t1 : vec4(0.0);
  vec2 uvMain = (${on("_Main_Distortion_Use")} ? dd : vec2(0.0)) + off.xy + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y) + uv * _Tex_Main_ST.xy + _Tex_Main_ST.zw;
  vec4 m = texture(_Tex_Main, uvMain);
  vec2 uvMask = uv * _Tex_Mask_ST.xy + _Tex_Mask_ST.zw + off.zw + _TimeY * vec2(_Mask_Speed_X, _Mask_Speed_Y) + (${on("_Mask_Distortion_Use")} ? dd : vec2(0.0));
  float k = texture(_Tex_Mask, uvMask).r;
  float sel = ${on("_RGBRGBA")} ? m.a : m.r;
  o = vec4(m.a * k * m.rgb * v_col.rgb * _Color.rgb * _Multiply, clamp(k * sel * v_col.a * v_col.a * _Color.a * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_Add_Distort_1a (the material's blend; ch0334's boosters add, One One): the distortion
  // texture's xy times its power (custom data 2 through _CustomData_DistortPower_CD2XYXY, plus the material's) shifts
  // the main UV and the mask UV, each by its keyword (_Main_Distort_Use, _Mask_Distort_Use). The vertex program puts
  // the custom data's share of the distortion UV in v_t3.zw, of the main and mask UVs in v_t5; v_t4 is custom data 2.
  // Only the alpha takes the main texture's red with RGB (_RGBRGBA 0); the colour is always times its alpha.
  distort1a: {
    tex: ["_Tex_Main", "_Tex_Mask", "_Tex_Distort"], colors: ["_Color"],
    vectors: [...cd("Main"), ...cd("Mask"), ...cd("Distort"), "_CustomData_DistortPower_CD2XYXY"],
    floats: ["_Main_Distort_Use", "_Mask_Distort_Use", "_RGBRGBA", "_AlphaPremultiplyOn", "_Alphaclip_Value", "_Multiply",
      "_Dis_Speed_X", "_Dis_Speed_Y", "_Distortion_Power_X", "_Distortion_Power_Y", "_Main_Speed_X", "_Main_Speed_Y",
      "_Tex_Mask_Speed_X", "_Tex_Mask_Speed_Y"],
    vertex: {
      outs: 3,
      src: `  vec2 uv = a_t0.xy;
  v_t3 = vec4(uv, ${cdUv(tiled("_Tex_Distort"), "Distort")});
  v_t4 = a_t2;
  v_t5 = vec4(${cdUv(tiled("_Tex_Main"), "Main")}, ${cdUv(tiled("_Tex_Mask"), "Mask")});`,
    },
    src: `void main() {
  vec2 uv = v_t3.xy, dd = vec2(0.0);
  bool toMain = ${on("_Main_Distort_Use")}, toMask = ${on("_Mask_Distort_Use")};
  if (toMain || toMask) {
    vec4 p = v_t4 * _CustomData_DistortPower_CD2XYXY;
    vec4 d = texture(_Tex_Distort, ${tiled("_Tex_Distort")} + fract(_TimeY * vec2(_Dis_Speed_X, _Dis_Speed_Y)) + v_t3.zw);
    dd = (p.xy + p.zw + vec2(_Distortion_Power_X, _Distortion_Power_Y)) * d.xy;
  }
  vec4 m = texture(_Tex_Main, ${tiled("_Tex_Main")} + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y) + (toMain ? dd : vec2(0.0)) + v_t5.xy);
  float k = texture(_Tex_Mask, ${tiled("_Tex_Mask")} + _TimeY * vec2(_Tex_Mask_Speed_X, _Tex_Mask_Speed_Y) + (toMask ? dd : vec2(0.0)) + v_t5.zw).x;
  float a = clamp((${on("_RGBRGBA")} ? m.a : m.r) * v_col.a * _Color.a * k, 0.0, 1.0);
  if (a < _Alphaclip_Value) discard;
  vec3 rgb = m.rgb * _Color.rgb * k * _Multiply * m.a * v_col.rgb;
  o = vec4(${on("_AlphaPremultiplyOn")} ? rgb * a : rgb, a);
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_Add_Double_Distort_1a (One OneMinusSrcAlpha in the lobbies: ch0188's and ch0356's water
  // splashes): two distortions from one texture, its red and its green channel, each with its own tiling, scroll and
  // power; _Tex_Main_Distort and _Tex_Mask_Distort (Off, R, G, RG) say which shift the main and the mask UV. Custom
  // data as in distort1a: v_t3.zw red, v_t5.xy green, v_t5.zw main, v_t6.xy mask; the vertex program tiles the custom
  // data's distortion UVs by _Tex_DistortRG_ST, the fragment program the plain ones by _R / _GTilingxyOffsetzw.
  doubleDistort: {
    tex: ["_Tex_Main", "_Tex_Mask", "_Tex_DistortRG"], colors: ["_Color"],
    vectors: [...cd("Main"), ...cd("Mask"), ...cd("Distort", "R"), ...cd("Distort", "G"), "_CustomData_DistortPowerR_CD2XYXY",
      "_CustomData_DistortPowerG_CD2XYXY", "_RTilingxyOffsetzw", "_GTilingxyOffsetzw"],
    floats: ["_Tex_Main_Distort", "_Tex_Mask_Distort", "_RGBRGBA", "_AlphaPremultiplyOn", "_Alphaclip_Value", "_Multiply",
      "_Main_Speed_X", "_Main_Speed_Y", "_Mask_Speed_X", "_Mask_Speed_Y", "_RDistort_Speed_X", "_RDistort_Speed_Y",
      "_RDistort_Power_X", "_RDistort_Power_Y", "_GDistort_Speed_X", "_GDistort_Speed_Y", "_GDistort_Power_X", "_GDistort_Power_Y"],
    vertex: {
      outs: 4,
      src: `  vec2 uv = a_t0.xy, base = ${tiled("_Tex_DistortRG")};
  v_t3 = vec4(uv, ${cdUv("base", "Distort", "R")});
  v_t4 = a_t2;
  v_t5 = vec4(${cdUv("base", "Distort", "G")}, ${cdUv(tiled("_Tex_Main"), "Main")});
  v_t6 = vec4(${cdUv(tiled("_Tex_Mask"), "Mask")}, 0.0, 0.0);`,
    },
    src: `// KeywordEnum(Off, R, G, RG): does the mode take the channel (1 red, 2 green)
bool takes(float mode, float channel) { float m = floor(mode + 0.5); return m == channel || m == 3.0; }
void main() {
  vec2 uv = v_t3.xy, r = vec2(0.0), g = vec2(0.0);
  if (takes(_Tex_Main_Distort, 1.0) || takes(_Tex_Mask_Distort, 1.0)) {
    vec4 p = v_t4 * _CustomData_DistortPowerR_CD2XYXY;
    float d = texture(_Tex_DistortRG, uv * _RTilingxyOffsetzw.xy + _RTilingxyOffsetzw.zw + fract(_TimeY * vec2(_RDistort_Speed_X, _RDistort_Speed_Y)) + v_t3.zw).r;
    r = (p.xy + p.zw + vec2(_RDistort_Power_X, _RDistort_Power_Y)) * d;
  }
  if (takes(_Tex_Main_Distort, 2.0) || takes(_Tex_Mask_Distort, 2.0)) {
    vec4 p = v_t4 * _CustomData_DistortPowerG_CD2XYXY;
    float d = texture(_Tex_DistortRG, uv * _GTilingxyOffsetzw.xy + _GTilingxyOffsetzw.zw + fract(_TimeY * vec2(_GDistort_Speed_X, _GDistort_Speed_Y)) + v_t5.xy).g;
    g = (p.xy + p.zw + vec2(_GDistort_Power_X, _GDistort_Power_Y)) * d;
  }
  vec2 dMain = (takes(_Tex_Main_Distort, 1.0) ? r : vec2(0.0)) + (takes(_Tex_Main_Distort, 2.0) ? g : vec2(0.0));
  vec2 dMask = (takes(_Tex_Mask_Distort, 1.0) ? r : vec2(0.0)) + (takes(_Tex_Mask_Distort, 2.0) ? g : vec2(0.0));
  vec4 m = texture(_Tex_Main, ${tiled("_Tex_Main")} + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y) + dMain + v_t5.zw);
  float k = texture(_Tex_Mask, ${tiled("_Tex_Mask")} + _TimeY * vec2(_Mask_Speed_X, _Mask_Speed_Y) + dMask + v_t6.xy).x;
  float a = clamp(v_col.a * v_col.a * (${on("_RGBRGBA")} ? m.a : m.r) * _Color.a * _Multiply * k, 0.0, 1.0);
  if (a < _Alphaclip_Value) discard;
  vec3 rgb = m.rgb * v_col.rgb * _Color.rgb * _Multiply * m.a * k;
  o = vec4(${on("_AlphaPremultiplyOn")} ? rgb * a : rgb, a);
}`,
  },
  // DSFX/FX_SHADER_Step_0 (One OneMinusSrcAlpha): the mask against a threshold cuts the main texture; also
  // DSFX/FX_SHADER_Step_0_MXChar, the same program with dither and grayscale variants (the material's blend)
  step: {
    tex: ["_Tex_Main", "_Tex_Mask"], colors: ["_Color"],
    floats: ["_Custom_Data_Mask_Offset_Use", "_Custom_Data_Main_Offset_Use", "_Step_Custom_DataVertex_color_Use", "_Step_Power",
      "_Step_Scroll_Use", "_Main_Speed_X", "_Main_Speed_Y", "_Mask_Speed_X", "_Mask_Speed_Y", "_Multiply", "_RGBRGBA", "_Vertex_Alpha_Use"],
    src: `void main() {
  vec2 uv = v_t0.xy;
  float mk = texture(_Tex_Mask, uv * _Tex_Mask_ST.xy + _Tex_Mask_ST.zw + _TimeY * vec2(_Mask_Speed_X, _Mask_Speed_Y)
    + (${on("_Custom_Data_Mask_Offset_Use")} ? v_t2.xy : vec2(0.0))).x;
  float thr = ${on("_Step_Scroll_Use")} ? (${on("_Step_Custom_DataVertex_color_Use")} ? 1.0 - v_col.a : v_t1.x) : _Step_Power;
  float st = mk >= thr ? 1.0 : 0.0;
  vec4 m = texture(_Tex_Main, uv * _Tex_Main_ST.xy + _Tex_Main_ST.zw + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y)
    + (${on("_Custom_Data_Main_Offset_Use")} ? v_t1.zw : vec2(0.0)));
  float sel = ${on("_RGBRGBA")} ? m.a : m.r;
  float a = st * _Color.a * sel * (${on("_Vertex_Alpha_Use")} ? 1.0 : v_col.a);
  o = vec4(st * m.rgb * v_col.rgb * _Color.rgb * _Multiply * sel, clamp(a * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_Step_Distort_0 (One OneMinusSrcAlpha)
  stepDistort: {
    tex: ["_Tex_Main", "_Tex_Mask", "_Tex_Distort"], colors: ["_Color"], vectors: ["_UV_Add_TilingOffset"],
    floats: ["_Custom_Data_Mask_Offset_Usecustom78", "_Custom_Data_Main_Offset_Use", "_Custom_Data_Distort_Power_Use", "_UV_Add_Use",
      "_Step_Custom_DataVertex_color_Use", "_Step_Power", "_Step_Scroll_Use", "_Distortion_Power_X", "_Distortion_Power_Y",
      "_Dis_Speed_X", "_Dis_Speed_Y", "_Main_Speed_X", "_Main_Speed_Y", "_Mask_Speed_X", "_Mask_Speed_Y", "_Multiply", "_RGBRGBA",
      "_Vertex_Alpha_Use"],
    src: `void main() {
  vec2 uv = v_t0.xy;
  vec2 maskUv = uv * _Tex_Mask_ST.xy + _Tex_Mask_ST.zw + _TimeY * vec2(_Mask_Speed_X, _Mask_Speed_Y);
  vec4 d = texture(_Tex_Distort, uv * _Tex_Distort_ST.xy + _Tex_Distort_ST.zw + _TimeY * vec2(_Dis_Speed_X, _Dis_Speed_Y) + vec2(0.0, 1.0));
  vec2 dd = d.xy * ((${on("_Custom_Data_Distort_Power_Use")} ? v_t2.xy : vec2(0.0)) + vec2(_Distortion_Power_X, _Distortion_Power_Y));
  vec2 add = uv * _UV_Add_TilingOffset.xy + _UV_Add_TilingOffset.zw;
  float k = ${on("_UV_Add_Use")} ? add.x + add.y : 1.0;
  maskUv += dd * k + (${on("_Custom_Data_Mask_Offset_Usecustom78")} ? v_t2.zw : vec2(0.0));
  float mk = texture(_Tex_Mask, maskUv).x;
  float thr = ${on("_Step_Scroll_Use")} ? (${on("_Step_Custom_DataVertex_color_Use")} ? 1.0 - v_col.a : v_t1.x) : _Step_Power;
  float st = mk >= thr ? 1.0 : 0.0;
  vec2 mainUv = uv * _Tex_Main_ST.xy + _Tex_Main_ST.zw + _TimeY * vec2(_Main_Speed_X, _Main_Speed_Y)
    + (${on("_Custom_Data_Main_Offset_Use")} ? v_t1.zw : vec2(0.0)) + dd * k;
  vec4 m = texture(_Tex_Main, mainUv);
  float sel = ${on("_RGBRGBA")} ? m.a : m.r;
  float a = st * _Color.a * sel * (${on("_Vertex_Alpha_Use")} ? 1.0 : v_col.a);
  o = vec4(sel * st * m.rgb * v_col.rgb * _Color.rgb * _Multiply, clamp(a * _Multiply, 0.0, 1.0));
}`,
  },
  // DSFX/FX_SHADER_AlphaBlend_2_Roz (SrcAlpha OneMinusSrcAlpha)
  alphaBlend2: {
    tex: ["_Texture"], floats: ["_Float0"], colors: ["_Color0"],
    src: `void main() {
  vec4 t = texture(_Texture, v_t0.xy * _Texture_ST.xy + _Texture_ST.zw) * v_col;
  o = vec4(t.rgb * _Color0.rgb * _Float0, t.a * _Color0.a);
}`,
  },
  // DSFX/FX_SHADER_AlwaysView_Add (SrcAlpha One)
  alwaysViewAdd: {
    tex: ["_FX_TEX_FocusLine", "_TextureSample0"], floats: [], colors: ["_Color"],
    src: `void main() {
  float k = texture(_TextureSample0, v_t0.xy * _TextureSample0_ST.xy + _TextureSample0_ST.zw).a;
  vec4 f = texture(_FX_TEX_FocusLine, v_t0.xy * _FX_TEX_FocusLine_ST.xy + _FX_TEX_FocusLine_ST.zw) * _Color;
  o = vec4(f.rgb * v_col.rgb, k * f.a * v_col.a);
}`,
  },
  // DSFX/FX_SHADER_Matcap_0 (the material's blend): the matcap looked up by the normal in view space (the camera's
  // axes are the world's, its view matrix only turns z round)
  matcap: {
    tex: ["_Main_Tex", "_Matcap_Tex"], floats: ["_Multiply"], colors: ["_Main_Color"],
    src: `void main() {
  vec3 m = texture(_Main_Tex, v_t0.xy * _Main_Tex_ST.xy + _Main_Tex_ST.zw).rgb * _Main_Color.rgb * v_col.rgb;
  vec4 c = texture(_Matcap_Tex, v_n.xy * 0.5 + 0.5);
  o = vec4(m * c.rgb, c.a * v_col.a * _Main_Color.a) * _Multiply;
}`,
  },
  // FX/General Unlit VertexColor (the material's blend)
  vertexColor: { tex: [], floats: [], colors: [], src: "void main() { o = v_col; }" },
  // Unity's Sprites/Default (One OneMinusSrcAlpha): the sprite's texture times the renderer's colour and the material's,
  // premultiplied; the intro's flash and fade sprites
  sprite: {
    tex: ["_MainTex"], floats: [], colors: ["_Color"],
    src: `void main() {
  vec4 c = texture(_MainTex, v_t0.xy * _MainTex_ST.xy + _MainTex_ST.zw) * v_col * _Color;
  o = vec4(c.rgb * c.a, c.a);
}`,
  },
  // Unity's Mobile/Particles/Additive (SrcAlpha One): the texture times the vertex colour
  particleAdd: {
    tex: ["_MainTex"], floats: [], colors: [],
    src: "void main() { o = texture(_MainTex, v_t0.xy * _MainTex_ST.xy + _MainTex_ST.zw) * v_col; }",
  },
};

// a program's own vertex outputs past TEXCOORD0..2 (v_t3...), which its fragment program reads
const extra = (p, dir) => Array.from({ length: p.vertex?.outs || 0 }, (_, i) => `${dir} vec4 v_t${3 + i};`);

// the vertex GLSL of a program: the particle's position, its vertex streams passed on as they are and, for the
// programs that port their vertex program too, what that computes (with the textures' _ST and the vectors)
export function vertexSource(kind) {
  const p = PROGRAMS[kind], v = p.vertex;
  const lines = [VS_HEAD];
  if (v) {
    for (const t of p.tex) lines.push(`uniform vec4 ${t}_ST;`);
    for (const c of p.vectors || []) lines.push(`uniform vec4 ${c};`);
    lines.push(...extra(p, "out"), CD_UV);
  }
  lines.push(`void main() {
  gl_Position = u_proj * vec4(a_pos, 0.0, 1.0);
  v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2; v_col = a_col; v_n = a_n;${v ? `\n${v.src}` : ""}
}`);
  return lines.join("\n");
}

// the fragment GLSL of a program: its uniforms (textures with their _ST, floats, colours, vectors) and body
export function fragmentSource(kind) {
  const p = PROGRAMS[kind];
  const lines = [HEAD, ...extra(p, "in")];
  for (const t of p.tex) lines.push(`uniform sampler2D ${t};`, `uniform vec4 ${t}_ST;`);
  for (const f of p.floats) lines.push(`uniform float ${f};`);
  for (const c of [...p.colors, ...(p.vectors || [])]) lines.push(`uniform vec4 ${c};`);
  lines.push(p.src);
  return lines.join("\n");
}

// Unity's built-in default textures, for a texture property a material leaves empty
const DEFAULT_TEXEL = { white: [255, 255, 255, 255], black: [0, 0, 0, 0], gray: [128, 128, 128, 128], grey: [128, 128, 128, 128],
  bump: [128, 128, 255, 128], red: [255, 0, 0, 0] };
const ATTRS = [["a_pos", 2, 0], ["a_t0", 4, 2], ["a_t1", 4, 6], ["a_t2", 4, 10], ["a_col", 4, 14], ["a_n", 3, 18]];
// UnityEngine.Rendering.BlendMode -> GL factors
const FACTOR = (gl) => [gl.ZERO, gl.ONE, gl.DST_COLOR, gl.SRC_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA,
  gl.ONE_MINUS_SRC_COLOR, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.SRC_ALPHA_SATURATE, gl.ONE_MINUS_SRC_ALPHA];

function compile(gl, kind) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vertexSource(kind)], [gl.FRAGMENT_SHADER, fragmentSource(kind)]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(prog, s);
    const log = gl.getShaderParameter(s, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(s) || "shader";
    gl.deleteShader(s);
    if (log) { gl.deleteProgram(prog); throw new Error(`${kind}: ${log}`); }
  }
  ATTRS.forEach(([name], i) => gl.bindAttribLocation(prog, i, name));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || "program";
    gl.deleteProgram(prog);
    throw new Error(`${kind}: ${log}`);
  }
  const loc = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(prog, i);
    if (u) loc[u.name] = gl.getUniformLocation(prog, u.name);
  }
  return { prog, loc };
}

// the GL objects of one player's context: programs, the vertex array and buffer, textures by id
class Context {
  constructor(gl) {
    this.gl = gl;
    this.programs = new Map();
    this.textures = new Map();
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.size = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    ATTRS.forEach(([, n, offset], i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, n, gl.FLOAT, false, STRIDE * 4, offset * 4);
    });
    gl.bindVertexArray(null);
  }

  program(kind) {
    if (!this.programs.has(kind)) {
      try {
        this.programs.set(kind, compile(this.gl, kind));
      } catch (err) {
        console.warn("particle program", err);
        this.programs.set(kind, null);
      }
    }
    return this.programs.get(kind);
  }

  // a texture of this context: the image as the game samples it (sRGB or not, filter, mipmaps, wrap), flipped so UV
  // (0, 0) is its bottom-left corner as in Unity; a default texture by name
  texture(meta, image) {
    const gl = this.gl, key = meta.id || `default:${meta.default}`;
    if (this.textures.has(key)) return this.textures.get(key);
    if (!meta.default && !image) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (meta.default) {
      const px = new Uint8Array(DEFAULT_TEXEL[meta.default] || DEFAULT_TEXEL.white);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, meta.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    const mips = !meta.default && meta.mips;
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    const point = meta.filter === 0;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, point ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, !mips ? (point ? gl.NEAREST : gl.LINEAR)
      : point ? gl.NEAREST_MIPMAP_NEAREST : meta.filter === 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST);
    const wrap = (w) => (w === 1 || w === 3 ? gl.CLAMP_TO_EDGE : w === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(meta.wrap?.[0] ?? 0));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(meta.wrap?.[1] ?? 0));
    this.textures.set(key, tex);
    return tex;
  }

  upload(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (data.byteLength > this.size) {
      this.size = Math.max(data.byteLength, this.size * 2, 64 * 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.size, gl.STREAM_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  release() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const p of this.programs.values()) if (p) gl.deleteProgram(p.prog);
    for (const t of this.textures.values()) gl.deleteTexture(t);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    this.programs.clear();
    this.textures.clear();
  }
}

// for checks: draw the effects (true) or leave them out (false); they keep simulating either way
export let shown = true;
export const show = (on) => { shown = !!on; };

// column-major 4 x 4 product a * b
function mat4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// A lobby's effects: create() once its lobby.json is in, layers() once its players are, then every player calls
// below() in its update hook (after the clear, before the skeleton; the bottom player also advances the simulation),
// between() after each part of its skeleton but the last (drawsAfter() says whether that draws anything) and above()
// in its draw hook (after the skeleton, before linear.js copies the frame out). dispose() frees it all.
export function create(fx, { base, bone, load = loadImage } = {}) {
  const effects = new Effects(fx, { bone });
  // the prefab's sprites (fx.sprites: the intro's flash and fade), drawn like a system with one quad; lobby-intro.js
  // shows them (visible), colours (color) and moves (M) them
  const sprites = (fx?.sprites || []).map((def, i) => ({ def, index: 1e6 + i, sprite: true, visible: def.rest !== 0,
    color: def.color, M: def.static }));
  const images = new Map(); // texture id -> HTMLImageElement once loaded (null while loading)
  const contexts = new Map(); // player -> Context
  const restorables = new Map(); // player -> what its context calls once restored after a loss
  let slots = new Map(), bottom = null, disposed = false;
  const cpu = { ms: 0, frames: 0 };
  const materials = fx?.materials || {}, meshes = fx?.meshes || {};

  // every texture of the effects, fetched once; the systems draw once theirs are in
  for (const t of Object.values(fx?.textures || {})) {
    images.set(t.id, null);
    load(`${base}fx_${encodeURIComponent(t.id)}.png`).then((img) => { if (!disposed) images.set(t.id, img); }, () => {});
  }

  // the player's GL objects, made on its first draw; a lost context has freed them, so once it is restored (spine's
  // context calls its restorables, as linear.js rebuilds its own) the next draw makes them again: the programs, the
  // vertex array and buffer, and the textures from the images in memory
  function contextOf(player) {
    const gl = player?.context?.gl;
    if (!gl || !Linear.active(player)) return null;
    if (!restorables.has(player)) {
      const restorable = { restore: () => { contexts.delete(player); } };
      restorables.set(player, restorable);
      player.context.addRestorable?.(restorable);
    }
    if (!contexts.has(player)) contexts.set(player, new Context(gl));
    return contexts.get(player);
  }

  // forget a player: its restorable, and its GL objects (freed unless its context has lost them)
  function release(player) {
    player.context?.removeRestorable?.(restorables.get(player));
    restorables.delete(player);
    contexts.get(player)?.release();
    contexts.delete(player);
  }

  // the player's projection for lobby units: spine's camera (in the layer's skeleton units) after the layer's place
  function projection(player, layer) {
    const cam = player.sceneRenderer.camera;
    cam.update();
    const s = layer.scale || 1;
    return mat4(cam.projectionView.values, new Float32Array([1 / s, 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, 1, 0, -layer.x / s, -layer.y / s, 0, 1]));
  }

  function draw(player, list) {
    if (!list?.length || !shown) return;
    const ctx = contextOf(player);
    const layer = player.bamtLayer;
    if (!ctx || !layer) return;
    const gl = ctx.gl, F = FACTOR(gl), proj = projection(player, layer);
    gl.bindVertexArray(ctx.vao);
    gl.enable(gl.BLEND);
    for (const s of list) {
      const mat = materials[s.def.material];
      const prog = mat && ctx.program(mat.program);
      if (!prog || (s.sprite ? !s.visible || !(s.color[3] > 0) : !s.particles.length)) continue;
      // every texture of the program loaded (or a default)
      const texs = [];
      let ready = true;
      for (const name of PROGRAMS[mat.program].tex) {
        const meta = mat.tex?.[name] || { default: mat.defaults?.[name] || "white" };
        const tex = meta.id ? ctx.texture(meta, images.get(meta.id)) : ctx.texture({ default: meta.default || "white" });
        if (!tex) { ready = false; break; }
        texs.push([name, tex, meta.st || [1, 1, 0, 0]]);
      }
      if (!ready) continue;
      const geo = s.sprite ? spriteGeometry(s.def, s.M, s.color) : geometry(effects, s, { meshes, linear: true });
      if (!geo.count) continue;
      ctx.upload(geo.data);
      gl.useProgram(prog.prog);
      const L = prog.loc;
      gl.uniformMatrix4fv(L.u_proj, false, proj);
      if (L._TimeY) gl.uniform1f(L._TimeY, effects.time);
      texs.forEach(([name, tex, st], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (L[name]) gl.uniform1i(L[name], unit);
        if (L[`${name}_ST`]) gl.uniform4f(L[`${name}_ST`], st[0], st[1], st[2], st[3]);
      });
      for (const f of PROGRAMS[mat.program].floats) if (L[f]) gl.uniform1f(L[f], mat.floats?.[f] ?? 0);
      for (const c of PROGRAMS[mat.program].colors) {
        // Color properties reach the shader in linear light (HDR above 1 by a 2.2 power), alpha as stored; the
        // intro animates some (s.colors, the renderer's property block)
        const v = s.colors?.[c] || mat.colors?.[c] || [1, 1, 1, 1];
        if (L[c]) gl.uniform4f(L[c], toLinear(v[0]), toLinear(v[1]), toLinear(v[2]), v[3]);
      }
      for (const c of PROGRAMS[mat.program].vectors || []) {
        const v = mat.colors?.[c] || [1, 1, 0, 0];
        if (L[c]) gl.uniform4f(L[c], v[0], v[1], v[2], v[3]);
      }
      // the game's blend for colour; coverage only where the game's blend covers what is behind (additive light adds
      // none, as linear.js does for additive slots)
      const src = F[mat.src] ?? gl.ONE, dst = F[mat.dst] ?? gl.ZERO;
      const additive = dst === gl.ONE;
      gl.blendFuncSeparate(src, dst, additive ? gl.ZERO : gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, geo.count);
    }
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // what draws after a part of a player's skeleton (none: nothing, or after the dispose)
  const after = (player, part) => (disposed ? null : slots.get(player)?.after[part]);
  const timed = (fn) => { const t0 = performance.now(); fn(); cpu.ms += performance.now() - t0; };
  function between(player, part) {
    const list = after(player, part);
    if (list?.length) timed(() => draw(player, list));
  }

  return {
    effects, sprites,
    // players: the lobby's skeleton players in stacking order, each with its layer (bamtLayer: order, queue, pages, z)
    // and drawn in the parts of its pages' queues (skeleton-parts.js)
    layers(players) {
      bottom = players[0] || null;
      slots = new Map(players.map((p) => [p, { below: [], after: queuesOf(p.bamtLayer).map(() => []) }]));
      for (const s of drawOrder([...effects.systems, ...sprites])) {
        if (!s.def.material && !s.def.subs) continue;
        const { layer, part } = slotOf(s.def, players.map((p) => p.bamtLayer || {}));
        const slot = slots.get(players[layer]);
        if (slot) (part < 0 ? slot.below : slot.after[part]).push(s);
      }
    },
    // before the player's skeleton (the bottom player also advances the simulation)
    below(player, dt) {
      if (disposed) return;
      timed(() => {
        if (player === bottom) { effects.update(dt); cpu.frames++; }
        draw(player, slots.get(player)?.below);
      });
    },
    // whether anything draws after that part of the player's skeleton
    drawsAfter: (player, part) => !!after(player, part)?.length,
    // after a part of the player's skeleton, before the next one
    between,
    // after the player's whole skeleton
    above(player) {
      const list = slots.get(player)?.after;
      if (list) between(player, list.length - 1);
    },
    // free one player's GL objects (before it is disposed)
    detach: release,
    dispose() {
      disposed = true;
      for (const player of new Set([...contexts.keys(), ...restorables.keys()])) release(player);
      images.clear();
      effects.clear();
      slots = new Map();
      bottom = null;
    },
    // for checks: live particles, systems, textures loaded, GL contexts in use and the main-thread time the effects
    // took per frame (simulation, geometry and draw calls) since the last reset
    stats: ({ reset = false } = {}) => {
      const out = { particles: effects.count(), systems: effects.systems.length, textures: [...images.values()].filter(Boolean).length,
        contexts: contexts.size, frames: cpu.frames, msPerFrame: cpu.frames ? +(cpu.ms / cpu.frames).toFixed(3) : 0 };
      if (reset) cpu.ms = cpu.frames = 0;
      return out;
    },
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
