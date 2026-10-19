// Tests for web/js/chibi-materials.js (the game's shaders on the 3D chibi): which textures, colours and variants a
// material gets. Run by tests/test_chibi_materials.py with Node's test runner; "three" resolves to the bundled copy.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

const THREE_URL = new URL("../../src/ba_modding_toolkit/web/vendor/three-0.160.0/build/three.module.min.js", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  return spec === "three" ? { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true } : next(spec, ctx); }`)}`);
const THREE = await import("three");
const { AMBIENT, CHARACTER_LIGHT_DIR, EMPTY_SCENE_AMBIENT, LIGHT, ambientAt, characterLight, chibiMaterial, outlineMaterial,
  slotSpace, trilightProbe } = await import("../../src/ba_modding_toolkit/web/js/chibi-materials.js");

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const tex = (name) => Object.assign(new THREE.Texture(), { name });
const transparent = { cull: 2, zwrite: 0, src: 5, dst: 10, queue: 3000 };

test("Matcap: its own texture, colour and matcap, the colour's alpha, the vertex colour", () => {
  // police_valkyrie_sg's riot shield: a see-through shield, not a white disc
  const ex = { shader: "DSFX/FX_SHADER_Matcap", kind: "matcap", outline: false, state: transparent,
    colors: { _Color: [1, 1, 1, 1], _BaseColor: [1, 1, 1, 1], _Main_Color: [0.30189, 0.05561, 0, 0.77255] } };
  const main = tex("Shield"), matcap = tex("Shield_Alpha");
  const { material, outline, queue } = chibiMaterial(ex, { _Main_Tex: main, _Matcap_Tex: matcap });
  assert.ok("KIND_MATCAP" in material.defines && "VERTEX_TINT" in material.defines);
  assert.equal(material.uniforms.mainMap.value, main);
  assert.equal(material.uniforms.matcapMap.value, matcap);
  const t = material.uniforms.tint.value;
  near(t.x, linear(0.30189));
  near(t.y, linear(0.05561));
  near(t.w, 0.77255);
  assert.ok(material.transparent && !("OPAQUE" in material.defines));
  assert.equal(outline, false);
  assert.equal(queue, 3000);
});

test("E-Water: the surface colour and its alpha", () => {
  // ch0123's hot spring tub
  const ex = { shader: "MX/E-Water-V2", kind: "water", outline: false, state: { ...transparent, queue: 2000 },
    colors: { _Color: [1, 1, 1, 1], _BaseColor: [1, 1, 1, 1], _SurfaceColor: [0.77296, 0.84906, 0.81124, 0.36078] } };
  const { material } = chibiMaterial(ex, {});
  assert.ok("KIND_WATER" in material.defines);
  near(material.uniforms.tint.value.y, linear(0.84906));
  near(material.uniforms.tint.value.w, 0.36078);
  assert.ok(material.transparent);
});

test("unlit and effect shaders read their own slot and colour", () => {
  const map = tex("Main");
  // FX/General Unlit Texture: _MainTex x _Color (a stale _Tint is not read)
  let r = chibiMaterial({ shader: "FX/General Unlit Texture", kind: "unlit", state: transparent,
    colors: { _Color: [1, 1, 1, 0.65], _Tint: [1, 0.4, 0, 0.7] } }, { _MainTex: map });
  assert.equal(r.material.uniforms.mainMap.value, map);
  near(r.material.uniforms.tint.value.y, 1);
  near(r.material.uniforms.tint.value.w, 0.65);
  // Unlit/Texture draws its texture alone
  r = chibiMaterial({ shader: "Unlit/Texture", kind: "unlit", colors: { _Color: [0.5, 0.5, 0.5, 1], _BaseColor: [0.5, 0.5, 0.5, 1] } },
    { _MainTex: map });
  assert.deepEqual(r.material.uniforms.tint.value.toArray(), [1, 1, 1, 1]);
  // MX/Unlit Outline: _MainTex x _Tint, with the outline its shader draws
  r = chibiMaterial({ shader: "MX/Unlit Outline", kind: "unlit", outline: true,
    colors: { _Color: [0.2, 0.2, 0.2, 1], _Tint: [1, 1, 1, 1] } }, { _MainTex: map });
  near(r.material.uniforms.tint.value.x, 1);
  assert.equal(r.outline, true);
  // DSFX/FX_SHADER_AlphaBlend_Add: its _Texture slot, _Color x _Multiply, alpha from the red channel by default
  const glow = tex("Glow");
  r = chibiMaterial({ shader: "DSFX/FX_SHADER_AlphaBlend_Add", kind: "unlit",
    state: { cull: 2, zwrite: 0, src: 1, dst: 10, queue: 3000 }, colors: { _Color: [1, 1, 1, 0.5] }, floats: { _Multiply: 2 } },
  { _Texture: glow });
  assert.equal(r.material.uniforms.mainMap.value, glow);
  assert.ok(["ALPHA_BLEND_ADD", "VERTEX_TINT", "RED_ALPHA"].every((d) => d in r.material.defines));
  near(r.material.uniforms.tint.value.x, 2);
  near(r.material.uniforms.tint.value.w, 1);
  // a shader the table does not know: the first slot and colour it has
  r = chibiMaterial({ shader: "FX/Something Else", kind: "unlit", colors: { _BaseColor: [1, 0, 0, 1] } }, { _BaseMap: map });
  assert.equal(r.material.uniforms.mainMap.value, map);
  near(r.material.uniforms.tint.value.y, 0);
});

test("HDR Color properties as stored, other Color properties from sRGB, Vector properties as stored", () => {
  // Kurumi's hair (ch0173): the shadow tint is an HDR Color, used as stored (not darkened by an sRGB decode)
  const hair = chibiMaterial({ shader: "MX/C-Hair", kind: "hair", hdr: ["_ShadowTint", "_Tint"],
    colors: { _Tint: [1, 1, 1, 1], _ShadowTint: [0.72549, 0.61064, 0.5451, 1], _GlowTint: [0.2, 0.2, 0.2, 1] } }, {});
  const s = hair.material.uniforms.shadowTint.value;
  near(s.x, 0.72549);
  near(s.z, 0.5451);
  // a Color without the HDR flag (here _GlowTint, as listed) is decoded
  near(hair.material.uniforms.glowTint.value.x, linear(0.2));
  // the weapon's _ShadowTint is a plain Color: decoded
  const weapon = chibiMaterial({ shader: "MX/C-Weapon", kind: "weapon", hdr: ["_GlowTint0"],
    colors: { _Color: [1, 1, 1, 1], _ShadowTint: [0.5, 0.5, 0.5, 1] } }, {});
  near(weapon.material.uniforms.shadowTint.value.x, linear(0.5));
  // Aru's halo: an HDR tint above 1 keeps its hue (no 2.2 power that would push every channel past white)
  const halo = chibiMaterial({ shader: "MX/C-Halo/UnlitTextured", kind: "halo", hdr: ["_Tint"],
    colors: { _Tint: [3.68861, 1.7574, 1.52565, 1] } }, { _MainTex: tex("Halo") });
  assert.deepEqual(halo.material.uniforms.tint.value.toArray().map((v) => +v.toFixed(5)), [3.68861, 1.7574, 1.52565, 1]);
  // Layer4's per-layer tints are Vector properties: as stored
  const body = chibiMaterial({ shader: "MX/C-General/Layer4", kind: "body", vectors: ["_ShadowTintR4"],
    colors: { _ShadowTintR4: [0.93333, 0.72307, 0.59434, 0.52661] } }, {});
  near(body.material.uniforms.layerTintR.value.y, 0.72307);
});

test("the character light ForwardLights derives from the main light", () => {
  // the formation screen's white light, intensity 1
  assert.deepEqual(characterLight([1, 1, 1]), { tone: [1, 1, 1], shadowTone: [1, 1, 1], data: [1, 1] });
  // a brighter blue light: tone and shadow tone from the hue, the brightness in data
  const blue = characterLight([0.5, 0.6, 1.2]);
  [0.5625, 0.625, 1].forEach((v, i) => near(blue.tone[i], v));
  [0.593611, 0.615, 0.743333].forEach((v, i) => near(blue.shadowTone[i], v));
  near(blue.data[0], 1.17);
  near(blue.data[1], 0.85);
});

test("the ambient probe: EmptyScene's Trilight as Unity 2021.3 projects it", () => {
  // values of an independent port of UnityPlayer's cube map projection
  const p = trilightProbe(EMPTY_SCENE_AMBIENT);
  const row = (v) => v.toArray().map((x) => +x.toFixed(5));
  assert.deepEqual(row(p[0]), [0, 0.06913, 0, 0.66539]);
  assert.deepEqual(row(p[1]), [0, 0.1293, 0, 0.70862]);
  assert.deepEqual(row(p[2]), [0, 0.25312, 0, 0.7979]);
  assert.deepEqual(row(p[3]), [0, 0, 0.13565, 0]);
  assert.deepEqual(row(p[6]), [0.13565, 0.11813, 0.08193, 1]);
  // the shaders' ambient: a channel sum of 0.3, bluer facing the sky
  [0.07853, 0.09439, 0.12708].forEach((v, i) => near(ambientAt(p, [0, 1, 0])[i], v, 2e-5));
  [0.0998, 0.09992, 0.10028].forEach((v, i) => near(ambientAt(p, [0, -1, 0])[i], v, 2e-5));
  // a uniform environment comes back as its linear colour; a dim one is not scaled up
  const grey = trilightProbe({ sky: [0.5, 0.5, 0.5], equator: [0.5, 0.5, 0.5], ground: [0.5, 0.5, 0.5] });
  near(ambientAt(grey, [0.3, 0.5, 0.81])[1], 0.1);
  const dim = trilightProbe({ sky: [0.1, 0.1, 0.1], equator: [0.1, 0.1, 0.1], ground: [0.1, 0.1, 0.1] });
  near(ambientAt(dim, [0, 0, 1])[0], linear(0.1));
  // the materials share the module's probe
  assert.deepEqual(AMBIENT.ambientSH.value.map(row), p.map(row));
});

test("the lit shaders add the ambient probe, the unlit ones do not", () => {
  for (const kind of ["body", "hair", "face", "weapon", "general"]) {
    const { material } = chibiMaterial({ shader: "MX/C-Test", kind }, {});
    assert.ok("AMBIENT_SH" in material.defines, kind);
    assert.equal(material.uniforms.ambientSH, AMBIENT.ambientSH);
  }
  for (const kind of ["transparent", "simple", "eyemouth", "eyebrow", "halo", "matcap", "water", "unlit"]) {
    const { material } = chibiMaterial({ shader: "MX/C-Test", kind }, {});
    assert.ok(!("AMBIENT_SH" in material.defines), kind);
  }
});

test("the formation screen's light falls on the character from its slot's side", () => {
  // UIFormation's slots turn the character 180 degrees about an axis 0.415 degrees off the vertical: a world
  // direction comes into the character's space with x and z flipped (and a slight lean), then mirrored to glTF
  const w = slotSpace([0.1, 0.65, 0]);
  [0.0905737, 0.6513804, 0].forEach((v, i) => near(w.getComponent(i), v));
  // the character light (CharacterLightFallback, from above, a little toward the screen's right and away from the
  // camera): in the character's glTF space toward +x (its left, the screen's right) and -z (behind it)
  assert.deepEqual(CHARACTER_LIGHT_DIR, [0.10158, 0.9941, 0.03812]);
  const l = LIGHT.charLightDir.value;
  [0.087169, 0.995464, -0.03812].forEach((v, i) => near(l.getComponent(i), v));
  // the weapons' fixed light (_FakeLightDir, world space, not normalised) likewise
  const weapon = chibiMaterial({ shader: "MX/C-Weapon", kind: "weapon", vectors: ["_FakeLightDir"],
    colors: { _FakeLightDir: [0.1, 0.65, 0, 0] } }, {});
  [0.0905737, 0.6513804, 0].forEach((v, i) => near(weapon.material.uniforms.fakeLightDir.value.getComponent(i), v));
});

test("MX/C-Weapon and the outline work per vertex, as the game's programs do", () => {
  const weapon = chibiMaterial({ shader: "MX/C-Weapon", kind: "weapon" }, {});
  // N.V and N.H come from the vertex program; the fragment program thresholds them
  assert.match(weapon.material.vertexShader, /vWeaponLight = vec2\( dot\( vWorldNormal, toCamera \)/);
  assert.match(weapon.material.fragmentShader, /vWeaponLight\.y - weapon\.x/);
  // the outline's colour: the texture sampled at the vertex, times _OutlineTint and the light colour
  const outline = outlineMaterial({ colors: { _OutlineTint: [0.5, 0.5, 0.5, 1] }, hdr: ["_OutlineTint"] }, tex("Body"));
  assert.match(outline.vertexShader, /vColor = texture2D\( mainMap, uv \)\.rgb \* outlineTint \* charLightTone/);
  assert.ok(!/texture2D/.test(outline.fragmentShader));
  near(outline.uniforms.outlineTint.value.x, 0.5);
});
