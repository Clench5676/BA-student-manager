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
