// Materials for the 3D chibi: ports of the game's character shaders (MX/C-*, compiled for D3D11 in the shader
// bundles), read from their disassembly. Every term follows the game's ForwardLit and Outline passes:
//   light term  N.L + 0.77 N.V + (1 - 2 mask.g) * _MaskGSensitivity, against the threshold (+0.15 * (1 - data.y))
//   diffuse     lerp(light tone, shadow tint * shadow tone, shadow) * data.x + ambient
//   rim         saturate((1 - N.V) * multiplier - leveler) * colour.a * strength, tinted by the light tone
//   Layer4      the mask alpha picks one of four layers (cut at 0.25, 0.5, 0.75), each with its own tint, threshold
//               and view light
//   face        its own light direction (_ShadowLightDir, in the renderer's space: the root bone), a softer edge
//   hair        the light term plus a highlight band from the direction map (_HairSpecTex)
//   weapon      a half vector of the view and a fixed light (_FakeLightDir), a mask for shadow and highlight
//   eyes/mouth  unlit, blended over the face; the bottom-left quarter of the atlas shows the mouth tile
//   outline     an inverted hull along the smoothed normal (tangent), 0.1 % of the screen width times colour.a
//   props       DSFX/FX_SHADER_Matcap (a matcap at the view-space normal), MX/E-Water-* (the surface colour) and the
//               unlit and effect shaders, each with its own texture slot and colour
// The game runs in linear colour space: colour textures are decoded from sRGB, masks are not, Color properties are
// converted to linear, and HDR Color properties (most of the character shaders' tints) and Vector properties are used
// as stored. The light is the formation screen's (see LIGHT and AMBIENT below): the character light's direction from
// above, taken into the space of the character's slot, its colour from the screen's white directional light, and the
// ambient probe of the scene the screen runs in.
import * as THREE from "three";

// glTF space mirrors Unity's x axis
const mirror = (v) => new THREE.Vector3(-v[0], v[1], v[2]);

// Unity's GammaToLinearSpace (HDR values above 1 by a 2.2 power)
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : c < 1 ? Math.pow((c + 0.055) / 1.055, 2.4) : Math.pow(c, 2.2));

// The character light globals the game's modified URP sets from the main light (ForwardLights.SetupMainLightConstants,
// GameAssembly.dll): rgb is the main light's linear colour times its intensity, or CharacterLightColor's override.
// tone = n * 0.75 + 0.25 with n = rgb / max(max(rgb), 1e-4); shadow tone = lerp(1, n / 2, t) with
// t = saturate((max - min) / max * 0.88); data = (max * 0.85 + 0.15, (max + min) / 2).
export function characterLight(rgb) {
  const hi = Math.max(...rgb), lo = Math.min(...rgb), d = Math.max(hi, 1e-4);
  const n = rgb.map((c) => c / d);
  const t = Math.min(Math.max(((hi - lo) / d) * 0.88, 0), 1);
  return { tone: n.map((c) => c * 0.75 + 0.25), shadowTone: n.map((c) => 1 + t * (c * 0.5 - 1)),
    data: [hi * 0.85 + 0.15, (hi + lo) / 2] };
}

// The formation screen turns every character to face its camera: UIFormation's slots (UnitPositions/Position1-4)
// are rotated 180 degrees about an axis 0.4 degrees off the vertical. The game's light directions are world space;
// the viewer shows the character in its own space, so they are taken into the slot's space (the inverse rotation),
// then into glTF's (Unity's x mirrored). The light then falls on the character from the side it does in the game.
export const FORMATION_SLOT = [0.007243064697831869, 0.9999737739562988, -3.166044e-10, -4.371024e-8];
export function slotSpace(v, q = FORMATION_SLOT) {
  const r = new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(new THREE.Quaternion(...q).normalize().invert());
  return mirror([r.x, r.y, r.z]);
}

// The formation screen's light: UIFormation's directional light (white, intensity 1) is the main light; the
// direction (_MxCharLightDir) is the top CharacterLight's, here GameMain's CharacterLightFallback, from above
// (Unity world space, toward the light: a little toward the screen's right and away from the camera).
export const CHARACTER_LIGHT_DIR = [0.10158, 0.9941, 0.03812];
const FORMATION = characterLight([1, 1, 1]);
export const LIGHT = {
  charLightDir: { value: slotSpace(CHARACTER_LIGHT_DIR).normalize() },
  charLightTone: { value: new THREE.Vector3(...FORMATION.tone) },
  charShadowTone: { value: new THREE.Vector3(...FORMATION.shadowTone) },
  charLightData: { value: new THREE.Vector2(...FORMATION.data) },
};

// The ambient light: the ambient probe as the engine passes it to a renderer (unity_SHAr ... unity_SHC), which the
// character shaders evaluate per vertex at the world normal, clamp at 0 and scale to a channel sum of at most 0.3.
// Outside battle the active scene is EmptyScene (Persistent.GameStart loads it alone; the lobby, formation and other
// screens open over it): Trilight ambient, the colours below, which are also SceneLightingLoader's defaults.
export const EMPTY_SCENE_AMBIENT = {
  sky: [0.5457247, 0.7230554, 0.9734455], equator: [1, 1, 1], ground: [0.0592293, 0.0740774, 0.1037736],
};

// Unity 2021.3's Trilight probe (UnityPlayer.dll, m_UseRadianceAmbientProbe off): a cube map of 2 x 2 texels a face
// (+Y sky, -Y ground, the sides equator; colours linearised, the intensity unused) projected face by face onto L2
// spherical harmonics (each face weighted to 4 pi / 6), each coefficient then scaled by the cosine lobe. Returns the
// shader constants in Unity space: [SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC].
const SQRT_PI = Math.sqrt(Math.PI);
const L0 = 1 / (2 * SQRT_PI), L1 = Math.sqrt(3) / (3 * SQRT_PI);
const L2 = Math.sqrt(15) / (8 * SQRT_PI), L3 = Math.sqrt(5) / (16 * SQRT_PI);
const LOBE = [L0, -L1, L1, -L1, L2, -L2, L3, -L2, L2 / 2];
// per face: its u and v axes and its normal (+X, -X, +Y, -Y, +Z, -Z)
const CUBE = [
  [[0, 0, -1], [0, -1, 0], [1, 0, 0]], [[0, 0, 1], [0, -1, 0], [-1, 0, 0]], [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]], [[1, 0, 0], [0, -1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, -1]],
];
export function trilightProbe({ sky, equator, ground }) {
  const faces = [equator, equator, sky, ground, equator, equator].map((c) => c.map(toLinear));
  const sh = [0, 1, 2].map(() => new Array(9).fill(0));
  faces.forEach((color, f) => {
    const [ua, va, na] = CUBE[f];
    const acc = [0, 1, 2].map(() => new Array(9).fill(0));
    let weights = 0;
    for (const v of [-0.5, 0.5]) for (const u of [-0.5, 0.5]) {
      const t = 1 + u * u + v * v, w = 4 / (t * Math.sqrt(t));
      const d = [0, 1, 2].map((k) => na[k] + u * ua[k] + v * va[k]);
      const len = Math.hypot(...d);
      const [x, y, z] = d.map((c) => c / len);
      const basis = [0.2820948, -0.4886025 * y, 0.4886025 * z, -0.4886025 * x, 1.0925485 * x * y, -1.0925485 * y * z,
        0.9461747 * (z * z - 1 / 3), -1.0925485 * x * z, 0.5462742 * (x * x - y * y)];
      for (let c = 0; c < 3; c++) for (let k = 0; k < 9; k++) acc[c][k] += color[c] * w * basis[k];
      weights += w;
    }
    const s = (4 * Math.PI) / weights / 6;
    for (let c = 0; c < 3; c++) for (let k = 0; k < 9; k++) sh[c][k] += acc[c][k] * LOBE[k] * s;
  });
  // the engine's packing: constant and linear, quadratic, final quadratic
  const A = sh.map((c) => new THREE.Vector4(c[3], c[1], c[2], c[0] - c[6]));
  const B = sh.map((c) => new THREE.Vector4(c[4], c[5], 3 * c[6], c[7]));
  return [...A, ...B, new THREE.Vector4(sh[0][8], sh[1][8], sh[2][8], 1)];
}

// the shared ambient probe (Unity space; the vertex shader mirrors the normal)
export const AMBIENT = { ambientSH: { value: trilightProbe(EMPTY_SCENE_AMBIENT) } };

// the character shaders' ambient term at a world normal (Unity space), as the vertex shader computes it
export function ambientAt(probe, n) {
  const [x, y, z] = n, b = [x * y, y * z, z * z, z * x];
  const v = [0, 1, 2].map((c) => {
    const a = probe[c], q = probe[3 + c];
    return Math.max(a.x * x + a.y * y + a.z * z + a.w + q.x * b[0] + q.y * b[1] + q.z * b[2] + q.w * b[3]
      + [probe[6].x, probe[6].y, probe[6].z][c] * (x * x - y * y), 0);
  });
  const s = Math.max(v[0] + v[1] + v[2], 0.3);
  return v.map((c) => (c * 0.3) / s);
}

// a material colour as the game's shader sees it: Color properties converted from sRGB, Vector properties and HDR
// Color properties (stored linear) as stored
function colorOf(ex, name, fallback) {
  const c = (ex.colors || {})[name] || fallback;
  const asStored = (ex.vectors || []).includes(name) || (ex.hdr || []).includes(name);
  if (asStored) return new THREE.Vector4(c[0], c[1], c[2], c[3] ?? 1);
  return new THREE.Vector4(toLinear(c[0]), toLinear(c[1]), toLinear(c[2]), c[3] ?? 1);
}
const floatOf = (ex, name, fallback) => (ex.floats || {})[name] ?? fallback;

// Unity's default textures for an unassigned slot
let defaults = null;
function defaultTexture(name) {
  defaults ||= {};
  if (!defaults[name]) {
    const v = { black: [0, 0, 0, 0], gray: [128, 128, 128, 128], linearGrey: [128, 128, 128, 128], white: [255, 255, 255, 255] }[name];
    const t = new THREE.DataTexture(new Uint8Array(v), 1, 1);
    t.needsUpdate = true;
    defaults[name] = t;
  }
  return defaults[name];
}
export function disposeDefaults() {
  for (const t of Object.values(defaults || {})) t.dispose();
  defaults = null;
}

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRim;
#ifdef VERTEX_TINT
varying vec4 vTint;
#endif
#ifdef Z_CORRECTION
uniform float zCorrection;
#endif
varying vec3 vAmbient;
#ifdef AMBIENT_SH
// unity_SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC
uniform vec4 ambientSH[ 7 ];
#endif
void main() {
  #ifdef VERTEX_TINT
  // the effect shaders multiply by the whole vertex colour
  #if defined( USE_COLOR_ALPHA )
  vTint = color;
  #elif defined( USE_COLOR )
  vTint = vec4( color, 1.0 );
  #else
  vTint = vec4( 1.0 );
  #endif
  #endif
  vec3 objectNormal = normal;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = position;
  #include <skinning_vertex>
  vec4 world = modelMatrix * vec4( transformed, 1.0 );
  #ifdef Z_CORRECTION
  // MX/C-Eyebrow: moved toward the camera (drawn over the fringe), so only the depth changes
  world.xyz += normalize( cameraPosition - world.xyz ) * zCorrection;
  #endif
  vWorldPos = world.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
  #ifdef AMBIENT_SH
  // the ambient probe at the world normal (Unity space), clamped at 0, scaled to a channel sum of at most 0.3
  vec4 n4 = vec4( -vWorldNormal.x, vWorldNormal.yz, 1.0 );
  vec4 b4 = n4.xyzz * n4.yzzx;
  vec3 sh = vec3( dot( ambientSH[ 0 ], n4 ), dot( ambientSH[ 1 ], n4 ), dot( ambientSH[ 2 ], n4 ) )
    + vec3( dot( ambientSH[ 3 ], b4 ), dot( ambientSH[ 4 ], b4 ), dot( ambientSH[ 5 ], b4 ) )
    + ambientSH[ 6 ].rgb * ( n4.x * n4.x - n4.y * n4.y );
  sh = max( sh, 0.0 );
  vAmbient = sh * ( 0.3 / max( sh.r + sh.g + sh.b, 0.3 ) );
  #else
  vAmbient = vec3( 0.0 );
  #endif
  vUv = uv;
  #ifdef USE_COLOR_ALPHA
  vRim = color.a;
  #else
  vRim = 1.0;
  #endif
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 charLightDir;
uniform vec3 charLightTone;
uniform vec3 charShadowTone;
uniform vec2 charLightData;
varying vec3 vAmbient;
uniform sampler2D mainMap;
uniform sampler2D maskMap;
uniform vec4 tint;
uniform vec4 shadowTint;
uniform vec4 twoSideTint;
uniform vec4 glowTint;
uniform vec4 codeAdd;
uniform vec4 codeMultiply;
uniform vec4 codeAddRim;
uniform float maskG;
uniform float threshold;
uniform float rimMultiplier;
uniform float rimLeveler;
uniform float rimStrength;
uniform float cutoff;
// Layer4: one value per layer
uniform vec4 layerTintR;
uniform vec4 layerTintG;
uniform vec4 layerTintB;
uniform vec4 layerThreshold;
uniform vec4 layerBrightness;
uniform vec4 layerViewOffset;
uniform vec4 layerViewPower;
uniform vec4 layerViewStrength;
uniform vec4 layerInvViewPower;
uniform vec4 layerInvViewStrength;
uniform vec4 layerViewEdge;
uniform vec4 layerRimMultiplier;
uniform vec4 layerRimStrength;
// General/Single: the view light, one layer
uniform vec4 viewLight; // offset, power, strength, base brightness
uniform vec4 invViewLight; // power, strength, edge
// face and hair: the renderer's space (its root bone), for directions given in it
uniform mat3 objectToWorld;
uniform vec3 shadowLightDir;
uniform float adjustShadow;
// hair highlight
uniform sampler2D specMap;
uniform vec4 specDir; // xyz: _SpecDirMultiplier, w: _SpecTopMultiplier
uniform vec4 spec; // top leveler, bottom area, bottom multiplier, strength
// weapon
uniform vec3 fakeLightDir;
uniform vec4 weapon; // shadow threshold, shadow strength, light value, light strength
uniform vec4 specColor; // rgb, a: _SpecStrong
uniform vec4 glowMask; // rgb, a: strictness
uniform vec4 glow; // rgb tint, a: strength
// eyes and mouth
uniform sampler2D mouthMap;
uniform vec4 mouthST;
uniform vec4 eyeTint;
uniform vec4 mouthTint;
// matcap
uniform sampler2D matcapMap;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRim;
#ifdef VERTEX_TINT
varying vec4 vTint;
#endif

// pow as the game computes it (exp of log): 0 for 0, whatever the power
float spow( float x, float p ) {
  return exp2( log2( max( x, 1e-8 ) ) * p );
}

vec3 rimColor( float NdotL ) {
  return ( clamp( 4.0 * NdotL + 0.25, 0.0, 1.0 ) * 0.4 + 0.3 ) * charLightTone;
}

void main() {
  vec3 V = normalize( cameraPosition - vWorldPos );
  vec3 N = normalize( vWorldNormal );
  #ifdef DOUBLE_SIDED_LIGHT
  if ( ! gl_FrontFacing ) N = -N;
  #endif
  float NdotV = dot( N, V );
  float NdotL = dot( N, charLightDir );
  float fresnel = 1.0 - NdotV;
  vec4 albedo = texture2D( mainMap, vUv ) * tint;
  float alpha = albedo.a;
  vec3 col;

  #if defined( KIND_BODY )
  vec4 mk = texture2D( maskMap, vUv );
  float gTerm = 1.0 - 2.0 * mk.g;
  vec3 a = vec3( mk.a ) + vec3( -0.25, -0.5, -0.75 );
  vec3 fl = floor( a ), ce = ceil( a );
  vec4 layer = vec4( -fl.x, -fl.y * ce.x, -fl.z * ce.y, ce.z );
  float edge = dot( layerViewEdge, layer );
  vec3 h = normalize( charLightDir * dot( layerViewOffset, layer ) + V );
  float view = clamp( gTerm * maskG + spow( clamp( dot( N, h ), 0.0, 1.0 ), dot( layerViewPower, layer ) ), 0.0, 1.0 );
  view = ( 1.0 - edge ) * view + edge * clamp( ( view - 0.5 ) * 10.0, 0.0, 1.0 );
  float inv = clamp( gTerm * maskG + spow( clamp( fresnel, 0.0, 1.0 ), dot( layerInvViewPower, layer ) ), 0.0, 1.0 );
  inv = ( 1.0 - edge ) * inv + edge * min( inv * 4000.0, 1.0 );
  float bright = view * dot( layerViewStrength, layer ) + inv * dot( layerInvViewStrength, layer ) + dot( layerBrightness, layer );
  vec3 shadowCol = vec3( dot( layerTintR, layer ), dot( layerTintG, layer ), dot( layerTintB, layer ) ) * charShadowTone;
  float th = dot( layerThreshold, layer ) + ( 1.0 - charLightData.y ) * 0.15;
  float lt = NdotL + 0.77 * NdotV + gTerm * maskG;
  float sh = clamp( ( th - lt ) * 10.0, 0.0, 1.0 );
  vec3 diffuse = mix( charLightTone, shadowCol, sh ) * charLightData.x + vAmbient;
  float rimM = dot( layerRimMultiplier, layer );
  float rim = clamp( fresnel * rimM - max( rimM - 1.0, 0.0 ), 0.0, 1.0 ) * vRim * dot( layerRimStrength, layer ) * charLightData.x;
  col = ( diffuse + rim * rimColor( NdotL ) + bright * charLightTone ) * albedo.rgb + mk.b * glowTint.rgb * glowTint.a;
  if ( ! gl_FrontFacing ) col = albedo.rgb * twoSideTint.rgb * ( 0.33 * NdotL + 0.5 ) * shadowCol;

  #elif defined( KIND_SINGLE ) || defined( KIND_HAIR )
  vec4 mk = texture2D( maskMap, vUv );
  vec3 shadowCol = shadowTint.rgb * charShadowTone;
  float th = threshold + ( 1.0 - charLightData.y ) * 0.15;
  #ifdef KIND_HAIR
  float gTerm = -( 2.0 * mk.g - 1.0 - mk.r * adjustShadow );
  #else
  float gTerm = 1.0 - 2.0 * mk.g;
  #endif
  float lt = NdotL + 0.77 * NdotV + gTerm * maskG;
  float rim = clamp( fresnel * rimMultiplier - rimLeveler, 0.0, 1.0 ) * vRim * rimStrength;
  #ifdef KIND_HAIR
  // the highlight band: the direction map (in the renderer's space) against the half vector of view and light
  vec4 st = texture2D( specMap, vUv );
  vec3 sd = st.xyz * 2.0 - 1.0;
  vec3 sw = normalize( objectToWorld * vec3( -sd.x, sd.y, sd.z ) );
  float x = dot( sd, specDir.xyz ) + dot( sw, normalize( V + charLightDir ) );
  float bottom = pow( max( x, -spec.y ) + spec.y, 2.0 ) * spec.z;
  float top = ( 1.0 - x ) * specDir.w - spec.x;
  float hl = max( ( x >= 0.0 ? top : bottom ) - ( 1.0 - st.a ), 0.0 ) * spec.w;
  hl *= clamp( ( lt - th ) * 5.0 - 0.5, 0.0, 1.0 );
  float sh = clamp( ( th - lt ) * 20.0, 0.0, 1.0 );
  float lit = ( rim + hl ) * charLightData.x;
  vec3 extra = vec3( 0.0 );
  #else
  float sh = clamp( ( th - lt ) * 10.0, 0.0, 1.0 );
  float lit = rim * charLightData.x;
  float edge = invViewLight.z;
  float view = clamp( gTerm * maskG + spow( clamp( dot( N, normalize( charLightDir * viewLight.x + V ) ), 0.0, 1.0 ), viewLight.y ), 0.0, 1.0 );
  view = ( 1.0 - edge ) * view + edge * clamp( ( view - 0.5 ) * 10.0, 0.0, 1.0 );
  float inv = clamp( gTerm * maskG + spow( clamp( fresnel, 0.0, 1.0 ), invViewLight.x ), 0.0, 1.0 );
  inv = ( 1.0 - edge ) * inv + edge * min( inv * 4000.0, 1.0 );
  vec3 extra = ( view * viewLight.z + inv * invViewLight.y + viewLight.w ) * charLightTone;
  #endif
  vec3 diffuse = mix( charLightTone, shadowCol, sh ) * charLightData.x + vAmbient;
  col = ( diffuse + lit * rimColor( NdotL ) + extra ) * albedo.rgb + mk.b * glowTint.rgb * glowTint.a;
  if ( ! gl_FrontFacing ) col = albedo.rgb * twoSideTint.rgb * ( 0.33 * NdotL + 0.5 ) * shadowCol;

  #elif defined( KIND_FACE )
  vec4 mk = texture2D( maskMap, vUv );
  vec3 SL = normalize( objectToWorld * shadowLightDir );
  float lt = dot( N, SL ) + 0.77 * NdotV - ( ( 2.0 * mk.g - 1.0 ) - mk.r * adjustShadow ) * maskG;
  float th = threshold + ( 1.0 - charLightData.y ) * 0.15;
  float sh = clamp( ( th - lt ) * 2.0, 0.0, 1.0 );
  vec3 diffuse = mix( charLightTone, shadowTint.rgb * charShadowTone, sh ) * charLightData.x + vAmbient;
  float rim = clamp( fresnel * rimMultiplier - rimLeveler, 0.0, 1.0 ) * vRim * rimStrength * charLightData.x;
  col = ( diffuse + rim * rimColor( NdotL ) ) * albedo.rgb;

  #elif defined( KIND_WEAPON )
  vec3 H = normalize( V + fakeLightDir );
  vec4 mk = texture2D( maskMap, vUv );
  float lit = clamp( ( clamp( dot( N, H ) - weapon.x, 0.0, 1.0 ) - clamp( mk.g * 2.0 - weapon.x - 1.0, 0.0, 1.0 ) ) * weapon.y, 0.0, 1.0 );
  float hl = clamp( ( mk.r * NdotV - weapon.z ) * weapon.w, 0.0, 1.0 ) * specColor.a * charLightData.x;
  vec3 light = mix( shadowTint.rgb * charShadowTone, charLightTone, lit ) * charLightData.x + vAmbient + hl * specColor.rgb * charLightTone;
  vec4 tex = texture2D( mainMap, vUv );
  col = light * tex.rgb * tint.rgb;
  #ifdef GLOW
  vec3 d = tex.rgb - glowMask.rgb;
  col += ( 1.0 - clamp( dot( d, d ) * glowMask.a, 0.0, 1.0 ) ) * glow.a * glow.rgb;
  #endif
  alpha = 1.0;

  #elif defined( KIND_TRANSPARENT )
  float th = threshold + ( 1.0 - charLightData.y ) * 0.15;
  float sh = clamp( ( th - ( NdotL + 0.77 * NdotV ) ) * 20.0, 0.0, 1.0 );
  float rim = clamp( fresnel * rimMultiplier - max( rimMultiplier - 1.0, 0.0 ), 0.0, 1.0 ) * vRim * rimStrength;
  col = ( mix( charLightTone, shadowTint.rgb * charShadowTone, sh ) + rim * rimColor( NdotL ) ) * albedo.rgb * charLightData.x;

  #elif defined( KIND_EYEMOUTH )
  // Unity uv (origin bottom-left): the mouth is the quarter below 0.25, 0.25, sampled from the shared mouth atlas
  vec2 u = vec2( vUv.x, 1.0 - vUv.y );
  vec4 c;
  #ifdef MOUTH_TILE
  if ( u.x <= 0.25 && u.y <= 0.25 ) {
    vec2 m = u * mouthST.xy + mouthST.zw;
    c = texture2D( mouthMap, vec2( m.x, 1.0 - m.y ) ) * vec4( mouthTint.rgb * charLightTone * charLightData.x, mouthTint.a );
  } else
  #endif
  c = texture2D( mainMap, vUv ) * vec4( eyeTint.rgb * charLightTone * charLightData.x, eyeTint.a );
  col = c.rgb;
  alpha = c.a;

  #elif defined( KIND_EYEBROW )
  #ifdef ONE_COLOR
  col = tint.rgb * charLightTone * charLightData.x;
  alpha = tint.a;
  #else
  col = albedo.rgb * charLightTone * charLightData.x;
  #endif

  #elif defined( KIND_HALO )
  #ifdef SIMPLE
  col = tint.rgb;
  alpha = tint.a;
  #else
  col = albedo.rgb;
  #ifdef GLOW
  vec3 d = texture2D( mainMap, vUv ).rgb - glowMask.rgb;
  col += ( 1.0 - clamp( dot( d, d ) * glowMask.a, 0.0, 1.0 ) ) * glow.a * glow.rgb;
  #endif
  #endif

  #elif defined( KIND_MATCAP )
  // DSFX/FX_SHADER_Matcap: texture x colour x vertex colour x the matcap at the view-space normal; the alpha is the
  // matcap's, the vertex colour's and the colour's, not the texture's
  vec3 vn = normalize( mat3( viewMatrix ) * normalize( vWorldNormal ) );
  vec2 m = vn.xy * 0.5 + 0.5;
  vec4 mc = texture2D( matcapMap, vec2( m.x, 1.0 - m.y ) );
  col = albedo.rgb * vTint.rgb * mc.rgb;
  alpha = mc.a * vTint.a * tint.a;

  #elif defined( KIND_WATER )
  // MX/E-Water-*: the surface colour lit by the light. The game deepens it toward _DepthColor and fades it in by how
  // far the scene lies behind the surface (the camera depth texture); a chibi alone has nothing behind it, so it
  // shows the surface, as a thin layer of water
  col = tint.rgb * clamp( dot( N, charLightDir ), 0.0, 1.0 ) * charLightTone * charLightData.x;
  alpha = tint.a;

  #else // unlit
  #ifdef ALPHA_BLEND_ADD
  // DSFX/FX_SHADER_AlphaBlend_Add: premultiplied by the texture's alpha (its red with _RGBRGBA off), blended One,
  // OneMinusSrcAlpha: transparent parts add their colour
  vec4 tx = texture2D( mainMap, vUv );
  #ifdef RED_ALPHA
  float ta = tx.r;
  #else
  float ta = tx.a;
  #endif
  #ifdef NO_MAIN_RGB
  tx.rgb = vec3( 1.0 );
  #endif
  col = tx.rgb * vTint.rgb * tint.rgb * ta;
  alpha = clamp( ta * vTint.a * tint.a, 0.0, 1.0 );
  #else
  col = albedo.rgb;
  #endif
  #endif

  #ifdef CUTOUT
  if ( alpha < cutoff ) discard;
  #endif
  #ifdef CODE_COLORS
  col = col * codeMultiply.rgb + codeAdd.rgb + fresnel * fresnel * codeAddRim.rgb;
  #endif
  #ifdef OPAQUE
  alpha = 1.0;
  #endif
  gl_FragColor = vec4( col, alpha );
  #include <colorspace_fragment>
}`;

const OUTLINE_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
attribute vec3 _outline;
uniform vec2 outlineScale;
varying vec2 vUv;
void main() {
  vec3 objectNormal = _outline;
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  vec3 transformed = position;
  #include <skinning_vertex>
  gl_Position = projectionMatrix * modelViewMatrix * vec4( transformed, 1.0 );
  // the smoothed normal in view space, projected: a direction on screen of a fixed pixel length
  vec3 vn = normalMatrix * objectNormal;
  vec2 d = vec2( vn.x * projectionMatrix[ 0 ][ 0 ], vn.y * projectionMatrix[ 1 ][ 1 ] );
  d *= inversesqrt( max( dot( d, d ), 6.10352e-05 ) );
  #ifdef USE_COLOR_ALPHA
  float width = color.a;
  #else
  float width = 1.0;
  #endif
  gl_Position.xy += d * outlineScale * width * gl_Position.w;
  vUv = uv;
}`;

const OUTLINE_FRAGMENT = /* glsl */ `
uniform sampler2D mainMap;
uniform vec3 outlineTint;
uniform vec3 charLightTone;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4( texture2D( mainMap, vUv ).rgb * outlineTint * charLightTone, 1.0 );
  #include <colorspace_fragment>
}`;

// the offset of one outline unit in clip space, x and y: 0.002 of the stage width (the game's screen), per the
// canvas size in stage pixels; shared by every outline and set on resize
export const OUTLINE = { outlineScale: { value: new THREE.Vector2(0.002, 0.002) } };
export function setOutlineScale(width, height, stageWidth = 1920) {
  OUTLINE.outlineScale.value.set(0.002 * stageWidth / Math.max(1, width), 0.002 * stageWidth / Math.max(1, height));
}

const SIDES = { 0: THREE.DoubleSide, 1: THREE.BackSide, 2: THREE.FrontSide };
// UnityEngine.Rendering.BlendMode -> three.js blend factors
const FACTORS = { 0: THREE.ZeroFactor, 1: THREE.OneFactor, 2: THREE.DstColorFactor, 3: THREE.SrcColorFactor,
  4: THREE.OneMinusDstColorFactor, 5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcColorFactor, 7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor, 9: THREE.SrcAlphaSaturateFactor, 10: THREE.OneMinusSrcAlphaFactor };
// the colour pass's state where the GLB has none (older exports): what the shaders usually do
const FIXED = { transparent: { src: 5, dst: 10, zwrite: 0, queue: 3000 }, eyemouth: { src: 5, dst: 10, zwrite: 1, cull: 2, queue: 2001 },
  weapon: { src: 1, dst: 0, zwrite: 1, cull: 2 } };

// the unlit and effect shaders, from their compiled programs: the texture slot and the colour property they read
// (null: none; Unlit/Texture draws its texture alone). Any other one, such as FX/General Unlit (Texture) or
// Unlit/TexColorHDR, reads the first of these it has.
const UNLIT = { "Unlit/Texture": { color: null }, "MX/Unlit Outline": { color: "_Tint" },
  "DSFX/FX_SHADER_AlphaBlend_Add": { map: "_Texture", color: "_Color" } };
const UNLIT_MAPS = ["_MainTex", "_Main_Tex", "_BaseMap", "_Texture"];
const UNLIT_COLORS = ["_Color", "_Main_Color", "_BaseColor", "_Tint"];

// cull, depth write, blend and queue of the material's colour pass (resolved against its floats by the exporter)
function renderState(ex, kind) {
  if (ex.state) return ex.state;
  const f = ex.floats || {};
  return { cull: f._Cull ?? 2, zwrite: f._ZWrite ?? 1, src: f._SrcBlend ?? 1, dst: f._DstBlend ?? 0, queue: 2000, ...FIXED[kind] };
}

function applyState(mat, state) {
  mat.side = SIDES[state.cull] ?? THREE.FrontSide;
  mat.depthWrite = state.zwrite !== 0;
  if (state.src === 1 && state.dst === 0) return;
  mat.transparent = true;
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = FACTORS[state.src] ?? THREE.OneFactor;
  mat.blendDst = FACTORS[state.dst] ?? THREE.ZeroFactor;
  // the canvas is composited over the page: its alpha accumulates like coverage
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
}

// the shading kinds whose vertex programs do not read the ambient probe (Layer4, Single, Hair, Face and Weapon do)
const NO_AMBIENT = new Set(["transparent", "simple", "eyemouth", "eyebrow", "halo", "matcap", "water", "unlit"]);

// chibiMaterial(ex, textures, mouth): the game shader of a material (ex: the GLB material extras, textures: its
// textures by slot name, mouth: the shared mouth tile state). Returns {material, objectSpace, outline, queue}:
// objectSpace is set when the shader reads directions in the renderer's space (face, hair), and the caller keeps its
// objectToWorld current; outline whether the shader draws one; queue the render queue, for the draw order.
export function chibiMaterial(ex, textures, mouth) {
  const kind = ex.kind || "general";
  const shader = ex.shader || "";
  const keywords = ex.keywords || [];
  const defines = {};
  const map = textures._MainTex || null;
  const uniforms = {
    ...LIGHT,
    ...AMBIENT,
    mainMap: { value: map || defaultTexture("white") },
    maskMap: { value: defaultTexture("black") },
    tint: { value: colorOf(ex, "_Tint", [1, 1, 1, 1]) },
    shadowTint: { value: colorOf(ex, "_ShadowTint", [0.5, 0.5, 0.5, 1]) },
    twoSideTint: { value: colorOf(ex, "_TwoSideTint", [1, 1, 1, 1]) },
    glowTint: { value: colorOf(ex, "_GlowTint", [0, 0, 0, 1]) },
    codeAdd: { value: colorOf(ex, "_CodeAddColor", [0, 0, 0, 0]) },
    codeMultiply: { value: colorOf(ex, "_CodeMultiplyColor", [1, 1, 1, 1]) },
    codeAddRim: { value: colorOf(ex, "_CodeAddRimColor", [0, 0, 0, 0]) },
    maskG: { value: floatOf(ex, "_MaskGSensitivity", 1) },
    threshold: { value: floatOf(ex, "_ShadowThreshold", 0.5) },
    rimMultiplier: { value: floatOf(ex, "_RimAreaMultiplier", 3) },
    rimLeveler: { value: floatOf(ex, "_RimAreaLeveler", 2) },
    rimStrength: { value: floatOf(ex, "_RimStrength", 1) },
    cutoff: { value: floatOf(ex, "_Cutoff", 0.5) },
    objectToWorld: { value: new THREE.Matrix3() },
    zCorrection: { value: 0 },
  };
  // the glow tint is scaled by _GlowStrength (Layer4, Single, Hair: mask.b * tint * strength)
  uniforms.glowTint.value.w = floatOf(ex, "_GlowStrength", 0);
  let objectSpace = false, outline = ex.outline ?? false;
  const state = renderState(ex, kind);
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, vertexColors: true });
  applyState(mat, state);
  // an opaque pass writes its colour only; the canvas alpha stays covered
  if (!mat.transparent) defines.OPAQUE = "";
  if (mat.side !== THREE.FrontSide) defines.DOUBLE_SIDED_LIGHT = "";
  if (keywords.includes("_CHAR_CUTOUT_MODE")) defines.CUTOUT = "";
  if (!NO_AMBIENT.has(kind)) defines.AMBIENT_SH = "";
  if (kind === "body") {
    defines.KIND_BODY = "";
    defines.CODE_COLORS = "";
    uniforms.maskMap.value = textures._MaskTex || defaultTexture("gray");
    const v4 = (name, fallback) => ({ value: colorOf(ex, name, fallback) });
    Object.assign(uniforms, {
      layerTintR: v4("_ShadowTintR4", [1, 1, 1, 1]), layerTintG: v4("_ShadowTintG4", [1, 1, 1, 1]),
      layerTintB: v4("_ShadowTintB4", [1, 1, 1, 1]), layerThreshold: v4("_ShadowThreshold4", [0, 0, 0, 0]),
      layerBrightness: v4("_BaseBrightness4", [0, 0, 0, 0]), layerViewOffset: v4("_ViewOffset4", [0, 0, 0, 0]),
      layerViewPower: v4("_ViewPower4", [1, 1, 1, 1]), layerViewStrength: v4("_ViewStrength4", [0, 0, 0, 0]),
      layerInvViewPower: v4("_InvViewPower4", [1, 1, 1, 1]), layerInvViewStrength: v4("_InvViewStrength4", [0, 0, 0, 0]),
      layerViewEdge: v4("_ViewLightEdge4", [0, 0, 0, 0]), layerRimMultiplier: v4("_RimAreaMultiplier4", [3, 3, 3, 3]),
      layerRimStrength: v4("_RimStrength4", [1, 1, 1, 1]),
    });
  } else if (kind === "hair") {
    defines.KIND_HAIR = "";
    defines.CODE_COLORS = "";
    objectSpace = true;
    uniforms.maskMap.value = textures._MaskTex || defaultTexture("black");
    const d = colorOf(ex, "_SpecDirMultiplier", [0, 0, 0, 0]);
    Object.assign(uniforms, {
      specMap: { value: textures._HairSpecTex || defaultTexture("black") },
      specDir: { value: new THREE.Vector4(d.x, d.y, d.z, floatOf(ex, "_SpecTopMultiplier", 3)) },
      spec: { value: new THREE.Vector4(floatOf(ex, "_SpecTopLeveler", 2), floatOf(ex, "_SpecBotArea", 0.3),
        floatOf(ex, "_SpecBotMultiplier", 11), floatOf(ex, "_SpecStrength", 1)) },
      adjustShadow: { value: floatOf(ex, "_AdjustiveHairShadow", 0) },
    });
    uniforms.glowTint.value.w = floatOf(ex, "_GlowStrength", 1);
  } else if (kind === "face") {
    defines.KIND_FACE = "";
    defines.CODE_COLORS = "";
    objectSpace = true;
    uniforms.maskMap.value = textures._MaskTex || defaultTexture("linearGrey");
    uniforms.shadowLightDir = { value: mirror(ex.colors?._ShadowLightDir || [0, -0.94, 0.342]) };
    uniforms.adjustShadow = { value: floatOf(ex, "_AdjustiveFaceShadow", 0) };
  } else if (kind === "weapon") {
    defines.KIND_WEAPON = "";
    defines.CODE_COLORS = "";
    uniforms.tint.value = colorOf(ex, "_Color", [1, 1, 1, 1]);
    // ProjectMX/WeaponTest1Damage names its slots in lower camel case
    uniforms.mainMap.value = map || textures._mainTex || defaultTexture("white");
    uniforms.maskMap.value = textures._SourceTex || textures._sourceTex || defaultTexture("white");
    // world space (not normalised) in the game: on the formation screen, a light from the screen's right
    uniforms.fakeLightDir = { value: slotSpace(ex.colors?._FakeLightDir || [0.1, 0.65, 0]) };
    uniforms.weapon = { value: new THREE.Vector4(floatOf(ex, "_ShadowThreshold", 0.5), floatOf(ex, "_ShadowStrong", 10),
      floatOf(ex, "_LightValue", 0.5), floatOf(ex, "_LightStrong", 10)) };
    const s = colorOf(ex, "_SpecColor", [1, 1, 1, 1]);
    uniforms.specColor = { value: new THREE.Vector4(s.x, s.y, s.z, floatOf(ex, "_SpecStrong", 0.1)) };
    glowUniforms(ex, uniforms, defines);
  } else if (kind === "transparent" || kind === "simple") {
    // MX/C-Simple and its alpha-blended variants: one light term, a sharp edge, rim
    defines.KIND_TRANSPARENT = "";
    defines.CODE_COLORS = "";
  } else if (kind === "eyemouth") {
    defines.KIND_EYEMOUTH = "";
    defines.CODE_COLORS = "";
    uniforms.eyeTint = { value: colorOf(ex, "_EyeTint", [1, 1, 1, 1]) };
    uniforms.mouthTint = { value: colorOf(ex, "_MouthTint", [1, 1, 1, 1]) };
    if (mouth && textures._MouthTileTex) {
      defines.MOUTH_TILE = "";
      uniforms.mouthMap = { value: textures._MouthTileTex };
      uniforms.mouthST = mouth.st; // shared: SetMouthTile moves its offset
    }
    outline = false;
  } else if (kind === "eyebrow") {
    defines.KIND_EYEBROW = "";
    defines.CODE_COLORS = "";
    defines.Z_CORRECTION = "";
    uniforms.zCorrection.value = floatOf(ex, "_ZCorrection", 0);
    if (shader.endsWith("OneColor") || !map) defines.ONE_COLOR = "";
    outline = false;
  } else if (kind === "halo") {
    defines.KIND_HALO = "";
    if (shader.endsWith("Simple") || !map) {
      defines.SIMPLE = "";
      uniforms.tint.value = colorOf(ex, "_SimpleBaseColor", ex.colors?._Tint || [1, 1, 1, 1]);
    }
    glowUniforms(ex, uniforms, defines);
    mat.toneMapped = false;
    outline = false;
  } else if (kind === "matcap") {
    defines.KIND_MATCAP = "";
    defines.VERTEX_TINT = "";
    uniforms.mainMap.value = textures._Main_Tex || map || defaultTexture("white");
    uniforms.tint.value = colorOf(ex, "_Main_Color", [0, 0, 0, 0]);
    uniforms.matcapMap = { value: textures._Matcap_Tex || defaultTexture("white") };
  } else if (kind === "water") {
    defines.KIND_WATER = "";
    uniforms.tint.value = colorOf(ex, "_SurfaceColor", [0.1, 0.6, 1, 0.3]);
  } else if (kind === "unlit") {
    // the effect and unlit shaders: their own texture slot and colour (the exporter tells whether one draws an
    // outline: MX/Unlit Outline does)
    const fx = UNLIT[shader] || {}, slot = fx.map || UNLIT_MAPS.find((name) => textures[name]);
    uniforms.mainMap.value = (slot && textures[slot]) || defaultTexture("white");
    const color = fx.color === undefined ? UNLIT_COLORS.find((name) => ex.colors?.[name]) : fx.color;
    uniforms.tint.value = color ? colorOf(ex, color, [1, 1, 1, 1]) : new THREE.Vector4(1, 1, 1, 1);
    if (shader === "DSFX/FX_SHADER_AlphaBlend_Add") {
      defines.ALPHA_BLEND_ADD = "";
      defines.VERTEX_TINT = "";
      if (!floatOf(ex, "_RGBRGBA", 0)) defines.RED_ALPHA = "";
      if (floatOf(ex, "_Main_Texture_No", 0)) defines.NO_MAIN_RGB = "";
      uniforms.tint.value.multiplyScalar(floatOf(ex, "_Multiply", 1));
    }
  } else {
    // MX/C-General/Single and the shaders built on it
    defines.KIND_SINGLE = "";
    defines.CODE_COLORS = "";
    uniforms.maskMap.value = textures._MaskTex || defaultTexture("black");
    uniforms.viewLight = { value: new THREE.Vector4(floatOf(ex, "_ViewOffset", 0), floatOf(ex, "_ViewPower", 1),
      floatOf(ex, "_ViewStrength", 0), floatOf(ex, "_BaseBrightness", 0)) };
    uniforms.invViewLight = { value: new THREE.Vector4(floatOf(ex, "_InvViewPower", 1), floatOf(ex, "_InvViewStrength", 0),
      floatOf(ex, "_ViewLightEdge", 0), 0) };
  }
  mat.defines = defines;
  return { material: mat, objectSpace, outline, queue: state.queue ?? 2000 };
}

// the glow replacement (keyword _GLOW_0): texels near the mask colour light up in the glow tint
function glowUniforms(ex, uniforms, defines) {
  const strength = floatOf(ex, "_GlowStrength0", 0);
  if (!(ex.keywords || []).includes("_GLOW_0") || strength <= 0) return;
  defines.GLOW = "";
  const m = colorOf(ex, "_GlowMaskColor0", [1, 1, 1, 1]), g = colorOf(ex, "_GlowTint0", [0, 0, 0, 1]);
  uniforms.glowMask = { value: new THREE.Vector4(m.x, m.y, m.z, floatOf(ex, "_GlowStrictness0", 3)) };
  uniforms.glow = { value: new THREE.Vector4(g.x, g.y, g.z, strength) };
}

// the inverted hull: the texture times _OutlineTint (and the light colour), back faces only
export function outlineMaterial(ex, map) {
  const t = colorOf(ex, "_OutlineTint", [0.5, 0.5, 0.5, 1]);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...OUTLINE, charLightTone: LIGHT.charLightTone, mainMap: { value: map || defaultTexture("white") },
      outlineTint: { value: new THREE.Vector3(t.x, t.y, t.z) } },
    vertexShader: OUTLINE_VERTEX, fragmentShader: OUTLINE_FRAGMENT, side: THREE.BackSide, vertexColors: true,
  });
  mat.name = "outline";
  return mat;
}
