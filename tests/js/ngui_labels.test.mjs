import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { labelEffect, labelBaselineInset, loadingLabel } from "../../src/ba_modding_toolkit/web/js/ngui-label.js";
const n = (name, pos, widgets = [], children = []) => ({ name, pos, widgets, children, scale: [1, 1], active: true });
const letter = { text: "Now Loading", fontSize: 46, w_: 300, h_: 70, pivot: 4, color: "#ffffff/1.00",
  effect: 2, effectColor: "#123456/0.90", effectDistance: [2, -3] };
const repeater = n("UIRepeater", [0, 0], [], [n("Widget", [0, -600], [], [n("Loading", [900, 0], [], [n("Label", [0, 0], [letter])])])]);
test("loading progress clones the prefab label effect and NGUI renders its exact colour and distance", () => {
  const tree = loadingLabel(repeater, null, "Applying Mods", 1920 / 2960), w = tree.widgets[0];
  for (const key of ["effect", "effectColor", "effectDistance", "color", "fontSize"]) assert.deepEqual(w[key], letter[key]);
  assert.equal(labelEffect(w, 0.5), "1px -1.5px 0 rgba(18, 52, 86, 0.9), -1px 1.5px 0 rgba(18, 52, 86, 0.9), 1px 1.5px 0 rgba(18, 52, 86, 0.9), -1px -1.5px 0 rgba(18, 52, 86, 0.9)");
  const renderer = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/ngui.js", import.meta.url), "utf8");
  assert.match(renderer, /textShadow: labelEffect\(w, sy \* S\)/);
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  assert.match(css, /\.loading-progress\.prefab-label \{ inset: 0/);
  assert.match(css, /\.loading-edge \{[^}]*z-index: 0/);
});
test("progress baselines match Now Loading after the stage-bottom shift in Latin, CJK and Thai", () => {
  for (const scale of [1920 / 2960, 0.54, 1]) for (const text of ["Applying Mods", "\u6b63\u5728\u52a0\u5165", "\u0e01\u0e33\u0e25\u0e31\u0e07"]) {
    const tree = loadingLabel(repeater, null, text, scale), w = tree.widgets[0];
    const expected = 1080 - (720 - 600) * scale + letter.h_ * scale / 2 - labelBaselineInset(letter.text, letter.fontSize) * scale;
    const actual = -tree.pos[1] * scale - labelBaselineInset(text, w.fontSize) * scale;
    assert.ok(Math.abs(expected - actual) < 1e-8);
    assert.equal(tree.pos[0] * scale, 84);
  }
});
test("the loading tip supplies its effect when repeater letters lack one", () => {
  const plain = structuredClone(repeater); plain.children[0].children[0].children[0].widgets[0].effect = 0;
  const tip = n("UILoading", [0, 0], [], [n("Tip", [0, 0], [letter])]);
  assert.equal(loadingLabel(plain, tip, "Updating", 1).widgets[0].effectColor, letter.effectColor);
});

test("sprite letter ink, excluding g and Arona, defines the progress baseline", () => {
  const r = n("UIRepeater", [0, 0], [], [n("Widget", [1480, -720], [], [
    n("Loading", [-303.6, 134], [], [
      n("N", [-491, -43.4], [{ sprite: "Loading_n1", w_: 60, h_: 80, pivot: 7 }]),
      n("o", [-443.2, -43.4], [{ sprite: "Loading_o", w_: 58, h_: 68, pivot: 7 }]),
      n("g", [-88, -58], [{ sprite: "Loading_g", w_: 54, h_: 80, pivot: 7 }]),
    ]), n("Arona", [0, 0], [{ sprite: "bunny", w_: 116, h_: 136 }]),
  ])]);
  const ink = { Loading_n1: { height: 80, bottom: 68 }, Loading_o: { height: 67, bottom: 55 }, Loading_g: { height: 79, bottom: 68 } };
  const style = n("ProgressStyle", [0, 0], [letter]);
  for (const scale of [1920 / 2960, 0.54, 1]) {
    const tree = loadingLabel(r, style, "Reading game files", scale, ink);
    assert.ok(tree, "the real sprite-based prefab must produce a progress label");
    const expected = 1080 - (134 - 43.4) * scale - (80 - 68) * scale;
    const baseline = -tree.pos[1] * scale - labelBaselineInset(tree.widgets[0].text, tree.widgets[0].fontSize) * scale;
    assert.ok(Math.abs(expected - baseline) < 1e-8);
  }
});

test("ellipsis glyph canvas includes font descent and outline on every side", async () => {
  const { labelClipPadding } = await import("../../src/ba_modding_toolkit/web/js/ngui-label.js");
  for (const text of ["Import List", "gjpy", "\u6e05\u55ae", "\u4e00\u89a7", "\ubaa9\ub85d", "\u0e19\u0e33\u0e40\u0e02\u0e49\u0e32"]) {
    const fs = 62, metrics = { actualBoundingBoxAscent: 72, actualBoundingBoxDescent: 18, fontBoundingBoxAscent: 72, fontBoundingBoxDescent: 18 };
    const padding = labelClipPadding({ ...letter, text }, fs, metrics);
    const baseline = (fs * 1.15 + 72 - 18) / 2;
    assert.ok(padding.top + baseline >= 72 + 3);
    assert.ok(fs * 1.15 + padding.bottom - baseline >= 18 + 3);
    assert.ok(padding.left >= 2 && padding.right >= 2);
  }
});


test("Thai combining marks use the font baseline rather than moving it to the ink center", async () => {
  const { labelClipPadding } = await import("../../src/ba_modding_toolkit/web/js/ngui-label.js");
  const fs = 62, baseline = (fs * 1.15 + 72 - 18) / 2;
  const pad = labelClipPadding(letter, fs, { actualBoundingBoxAscent: 90, actualBoundingBoxDescent: 25,
    fontBoundingBoxAscent: 72, fontBoundingBoxDescent: 18 });
  assert.ok(pad.top + baseline >= 93);
  assert.ok(fs * 1.15 + pad.bottom - baseline >= 28);
});
