// The photography toolbar's text buttons (Occlusion Guide, Grid) share one caption size and wrap inside their bodies in
// every shipped language; the ink centring needs no computed style. Run by tests/test_photography_js.py.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const WIDE = /[\u2e80-\u9fff\u3000-\u30ff\uff00-\uffef\uac00-\ud7af\u0e00-\u0e7f]/;
const em = (c) => (WIDE.test(c) ? 1 : 0.55);
const ctx = {
  font: "",
  measureText(s) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
    return { width: [...s].reduce((w, c) => w + em(c) * fs, 0), actualBoundingBoxAscent: 0.75 * fs, actualBoundingBoxDescent: /[gjpqy]/.test(s) ? 0.2 * fs : 0,
      fontBoundingBoxAscent: 1.16 * fs, fontBoundingBoxDescent: 0.29 * fs };
  },
};
globalThis.document = {
  createElement: () => ({ getContext: () => ctx, remove() {} }),
  documentElement: { lang: "en-US", appendChild() {} },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const { TOOLBAR_CAPTION, OCCLUSION_BUTTON } = await import("../../src/ba_modding_toolkit/web/js/photography/camera.js");
const S = 1920 / 2960;
const LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"];

for (const locale of LOCALES) test(`the toolbar captions share one size and fit the 196 x 76 bodies in ${locale}`, async () => {
  const ui = JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui.photo;
  document.documentElement.lang = locale;
  const captions = [ui.occlusion, ui.gridOn, ui.gridOff];
  assert.ok(captions.every(Boolean));
  const fits = NGUI.fitGroup(captions, TOOLBAR_CAPTION.size, TOOLBAR_CAPTION.min, TOOLBAR_CAPTION.width / S, 2, { maxH: TOOLBAR_CAPTION.height / S });
  assert.equal(new Set(fits.map((f) => f.fs)).size, 1, "one size for every caption and both grid states");
  assert.ok(fits[0].fs <= TOOLBAR_CAPTION.size);
  for (const f of fits) {
    assert.ok(!f.overflow, `${locale} fits`);
    assert.ok(f.lines <= 2);
    for (const line of f.text.split("\n")) assert.ok(NGUI.glyphWidth(line, f.fs) * S <= TOOLBAR_CAPTION.width + 1e-9, `${JSON.stringify(f.text)} wide`);
    assert.ok(f.lines * NGUI.fontSizeFor(f.text, f.fs) * NGUI.LINE_PITCH * S <= TOOLBAR_CAPTION.height + 1e-9, `${JSON.stringify(f.text)} tall`);
    assert.equal(f.text.replace(/\s/g, ""), captions[fits.indexOf(f)].replace(/\s/g, ""), "every character kept");
  }
});

test("a caption wider than the body wraps at its space instead of shrinking or spilling", () => {
  document.documentElement.lang = "en-US";
  // the widest Latin caption of the toolbar on the mock font: wider than one line
  const wide = "Occlusion Guide";
  assert.ok(NGUI.glyphWidth(wide, TOOLBAR_CAPTION.size) * S > TOOLBAR_CAPTION.width, "does not fit one line at full size");
  const [fit] = NGUI.fitGroup([wide, "Hide Grid", "Show Grid"], TOOLBAR_CAPTION.size, TOOLBAR_CAPTION.min, TOOLBAR_CAPTION.width / S, 2, { maxH: TOOLBAR_CAPTION.height / S });
  assert.deepEqual(fit.text.split("\n"), ["Occlusion", "Guide"]);
  assert.ok(fit.fs >= TOOLBAR_CAPTION.min, "within the font range");
});

test("the button keeps its compact box while its caption wraps", () => {
  assert.deepEqual([...OCCLUSION_BUTTON], [1352, 25, 196, 76]);
  assert.deepEqual([TOOLBAR_CAPTION.width, TOOLBAR_CAPTION.height], [160, 60]);
});

test("the toolbar button code no longer depends on computed style", async () => {
  const source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/photography/controller.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getComputedStyle/);
  assert.match(source, /inkShift/);
  assert.match(source, /fitGroup/);
});
