// Tests for web/js/slot-colours.js (the slot colours as each atlas page's shader takes them) and its hook in
// linear.js tint(). Run by tests/test_slot_colours.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

// a WebGL2 context that answers every call (linear.js only needs one to attach)
class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
const fakeGL = () => new Proxy(new FakeGL(), {
  get(t, name) {
    if (name in t || typeof name !== "string") return t[name];
    if (/^[A-Z0-9_]+$/.test(name)) return name;
    return (...args) => (name.startsWith("create") ? {} : /Parameter$/.test(name) ? true
      : name === "checkFramebufferStatus" ? "FRAMEBUFFER_COMPLETE" : name === "isContextLost" ? false : null);
  },
});
class Batcher { setBlendMode() {} }
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1 },
  PolygonBatcher: { blendModesGL: [{ srcRgb: 1, srcRgbPma: 1, dstRgb: 2, srcAlpha: 1 }, { srcRgb: 1, srcRgbPma: 1, dstRgb: 1, srcAlpha: 1 }] } };

const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");
const SlotColours = await import("../../src/ba_modding_toolkit/web/js/slot-colours.js");

const dec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const close = (got, want, msg) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${msg}: ${got} != ${want}`));

class Color {
  constructor(r = 1, g = 1, b = 1, a = 1) { this.set(r, g, b, a); }
  set(r, g, b, a) { Object.assign(this, { r, g, b, a }); return this; }
  get rgba() { return [this.r, this.g, this.b, this.a]; }
}
const texture = () => ({ texture: {}, useMipMaps: false, update() {}, getImage: () => ({}) });
const attachment = (page, color = new Color()) => ({ color, region: { page: { name: `${page}.png` }, texture: texture() } });
const slot = (att, color, blendMode = 0) => ({ color, data: { blendMode }, getAttachment: () => att });

// Takane's skeleton: every page on Spine/Skeleton MX Standard; a page drawn with spine-unity's own shader beside it
const LAYER = { name: "CH0229_home", shaders: { CH0229_home: "Spine/Skeleton MX Standard", CH0229_home_2: "Spine/Skeleton MX Standard",
  Other_home: "Spine/Skeleton" } };

function player(slots) {
  return { context: { gl: fakeGL() }, sceneRenderer: { batcher: new Batcher() },
    skeleton: { drawOrder: slots, data: { skins: [{ getAttachments: () => slots.map((s) => ({ attachment: s.getAttachment() })) }] } } };
}

test("MX Standard and its noise flow variant take the colour as it is; spine-unity's shaders decode it with UnityCG's cubic", () => {
  const { curveOf, CURVES } = SlotColours;
  assert.equal(curveOf("Spine/Skeleton MX Standard"), CURVES.asIs);
  assert.equal(curveOf("Spine/Skeleton MX Standard - NoiseFlowAnimation"), CURVES.asIs);
  assert.equal(curveOf("Spine/Skeleton"), CURVES.cubic);
  assert.equal(curveOf("Spine/Blend Modes/Skeleton PMA Multiply"), CURVES.cubic);
  for (const shader of ["Spine/Skeleton MX Portrait", "Unknown", undefined]) assert.equal(curveOf(shader), CURVES.exact);
  // MX Portrait Noise reads only the alpha: its tints never show
  assert.equal(curveOf("Spine/Skeleton MX Portrait Noise"), CURVES.unread);
  assert.equal(CURVES.unread(0.2), 1);
  assert.equal(CURVES.asIs(0.5), 0.5);
  assert.ok(Math.abs(CURVES.exact(0.5) - 0.214041) < 1e-6);
  // GammaToLinearSpace: white stays white, mid grey within a hair of the sRGB curve, dark tints darker
  assert.equal(CURVES.cubic(0), 0);
  assert.ok(Math.abs(CURVES.cubic(1) - 1) < 1e-7);
  assert.ok(Math.abs(CURVES.cubic(0.5) - 0.214967) < 1e-6);
  assert.ok(Math.abs(CURVES.cubic(12 / 255) - 0.002132) < 1e-6 && CURVES.exact(12 / 255) > 0.0036);
});

test("a layer's curve follows the page each attachment lies on", () => {
  const curves = SlotColours.curvesOf(LAYER), { CURVES } = SlotColours;
  assert.equal(curves(attachment("CH0229_home")), CURVES.asIs);
  assert.equal(curves(attachment("CH0229_home_2")), CURVES.asIs);
  assert.equal(curves(attachment("Other_home")), CURVES.cubic);
  // a page the prefab does not list, or an attachment without a page (clipping), is decoded
  assert.equal(curves(attachment("Mod_page")), CURVES.exact);
  assert.equal(curves({}), CURVES.exact);
  assert.equal(curves(null), CURVES.exact);
  // without page shaders (no prefab data) there is nothing to hand linear.js
  assert.equal(SlotColours.curvesOf({ name: "A_home", shaders: {} }), null);
  assert.equal(SlotColours.curvesOf({ name: "A_home" }), null);
});

test("tint: MX Standard slots keep their gamma colour, additive ones their colour times alpha; Spine/Skeleton's are decoded", () => {
  const grey = slot(attachment("CH0229_home"), new Color(0.5, 0.5, 0.5, 0.8));
  // Takane's aurora: green, additive, faded by its alpha timeline
  const aurora = slot(attachment("CH0229_home_2"), new Color(0.125, 0.851, 0.129, 0.42), 1);
  // a tinted attachment on an MX page: the slot and attachment colours multiplied, the attachment's put back after
  const tinted = slot(attachment("CH0229_home", new Color(1, 0.82, 0.271, 0.5)), new Color(0.5, 1, 1, 1));
  const other = slot(attachment("Other_home"), new Color(0.5, 0.5, 0.5, 0.8));
  const otherAdd = slot(attachment("Other_home"), new Color(1, 1, 1, 0.42), 1);
  const p = player([grey, aurora, tinted, other, otherAdd]);
  assert.equal(Linear.attach(p), true);
  Linear.setCurves(p, SlotColours.curvesOf(LAYER));
  Linear.tint(p);
  close(grey.color.rgba, [0.5, 0.5, 0.5, 0.8], "MX normal");
  close(aurora.color.rgba, [0.125 * 0.42, 0.851 * 0.42, 0.129 * 0.42, 1], "MX additive");
  close(tinted.color.rgba, [0.5, 0.82, 0.271, 0.5], "MX tinted attachment");
  close(tinted.getAttachment().color.rgba, [1, 1, 1, 1], "attachment colour folded into the slot");
  const cubic = SlotColours.CURVES.cubic;
  close(other.color.rgba, [cubic(0.5), cubic(0.5), cubic(0.5), 0.8], "standard normal");
  close(otherAdd.color.rgba, [cubic(0.42), cubic(0.42), cubic(0.42), 1], "standard additive");
  // end() gives every slot and attachment its own colour back
  Linear.end(p);
  close(grey.color.rgba, [0.5, 0.5, 0.5, 0.8], "restored");
  close(aurora.color.rgba, [0.125, 0.851, 0.129, 0.42], "restored");
  close(tinted.color.rgba, [0.5, 1, 1, 1], "restored");
  close(tinted.getAttachment().color.rgba, [1, 0.82, 0.271, 0.5], "restored");
  Linear.detach(p);
});

test("for checks, and without page shaders, every slot is decoded as before", () => {
  const grey = slot(attachment("CH0229_home"), new Color(0.5, 0.5, 0.5, 1));
  const p = player([grey]);
  Linear.attach(p);
  Linear.setCurves(p, SlotColours.curvesOf(LAYER));
  SlotColours.setByShader(false);
  try {
    Linear.tint(p);
    close(grey.color.rgba, [dec(0.5), dec(0.5), dec(0.5), 1], "switched off");
    Linear.end(p);
  } finally {
    SlotColours.setByShader(true);
  }
  Linear.setCurves(p, null);
  Linear.tint(p);
  close(grey.color.rgba, [dec(0.5), dec(0.5), dec(0.5), 1], "no curves");
  Linear.end(p);
  Linear.detach(p);
});
