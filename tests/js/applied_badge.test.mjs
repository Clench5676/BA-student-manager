// Source card badges (selected-frames.js, UIPopup_Mulligan's Mulligan_IndexBg with its number label
// Mulligan_IndexLabel): Applied on yellow, Selected on blue, in every shipped language, fitting the prefab label's
// box (70 x 52, font 42, ShrinkContent) on one line, with no second check beside the badge sprite's own. The captions are the
// locale files' own; text is measured on a stand-in canvas (a CJK character one em wide, a Thai base letter .55, its vowel and
// tone marks above and below none, anything else half an em), so what is asserted is the logic, not a font. The fit is in
// prefab units, so it does not change with the window size or the display density: the stage scales as a whole.
// Run by node --test tests/js/applied_badge.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { selectionPrefab } from "./selection_prefabs.mjs";

const WIDE = /[⺀-鿿　-〿＀-￯぀-ヿ가-힯ᄀ-ᇿ㄰-㆏]/;
const THAI_MARK = /[ัิ-ฺ็-๎]/;
const THAI = /[฀-๿]/;
const em = (c) => (WIDE.test(c) ? 1 : THAI_MARK.test(c) ? 0 : THAI.test(c) ? 0.55 : 0.5);
const ctx = {
  font: "",
  measureText(s) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
    return { width: [...s].reduce((w, c) => w + em(c) * fs, 0) };
  },
};
globalThis.document = {
  createElement: () => ({ getContext: () => ctx, remove() {} }),
  documentElement: { lang: "en-US", appendChild() {} },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const { LINE_PITCH, fitGroup, fontSizeFor, glyphWidth } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const { BADGE_FONT_MIN, badgeCaptionBox, fitBadgeCaptions, selectedFrame, SELECTION_SLOT } =
  await import("../../src/ba_modding_toolkit/web/js/selected-frames.js");

const LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"];
// The game's own word for "Selected": the Global client's text for it in English, Traditional Chinese, Japanese, Korean and
// Thai; Simplified Chinese follows the owner's wording.
const WORDS = { "en-US": "Selected", "zh-CN": "已选择", "zh-TW": "選擇中", "ja-JP": "選択中",
  "ko-KR": "선택 중", "th-TH": "เลือกอยู่" };
const strings = new Map();
for (const locale of LOCALES) strings.set(locale, JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
const at = (tree, path) => path.split("/").reduce((n, part) => n.children.find((c) => c.name === part), tree);
const slot = () => at(selectionPrefab(), SELECTION_SLOT);
const walk = (n) => [n, ...(n.children || []).flatMap(walk)];
const states = [[false, false], [false, true], [true, false], [true, true]];

test("the badge's label box is the prefab number label's", () => {
  assert.deepEqual(badgeCaptionBox(slot()), { fontSize: 42, width: 70, height: 52 });
  assert.equal(badgeCaptionBox({ children: [] }), null);
  assert.equal(fitBadgeCaptions({ children: [] }, ["Applied", "Selected"], fitGroup), null);
});

for (const locale of LOCALES) for (const [applied, previewed] of states) test(`${locale}: badge applied=${applied} previewed=${previewed}`, () => {
  const ui = strings.get(locale).webui;
  assert.equal(ui.status.selected, WORDS[locale]);
  assert.ok(ui.status.applied);
  const box = badgeCaptionBox(slot());
  document.documentElement.lang = locale;
  const captions = fitBadgeCaptions(slot(), [ui.status.applied, ui.status.selected], fitGroup);
  assert.equal(captions[0].fontSize, captions[1].fontSize, "both states share one size across sibling cards");
  const caption = captions[applied ? 0 : 1], text = applied ? ui.status.applied : ui.status.selected;
  const frame = selectedFrame(slot(), { w: 312, h: 480 }, applied, previewed, caption);
  if (!applied && !previewed) { assert.equal(frame, null); return; }
  assert.equal(caption.text, text, "one line, every character kept");
  assert.ok(!caption.overflow, `${locale} overflows its box`);
  assert.ok(caption.fontSize >= BADGE_FONT_MIN && caption.fontSize <= box.fontSize, `${locale} size ${caption.fontSize}`);
  assert.ok(glyphWidth(caption.text, caption.fontSize) <= box.width + 1e-9, `${locale}: ${glyphWidth(caption.text, caption.fontSize)} wide in ${box.width}`);
  assert.ok(fontSizeFor(caption.text, caption.fontSize) * LINE_PITCH <= box.height + 1e-9, `${locale} is too tall`);
  const label = frame.children.find((n) => n.name === (applied ? "AppliedLabel" : "PreviewLabel"));
  assert.deepEqual([label.widgets[0].text, label.widgets[0].fontSize], [text, caption.fontSize]);
  assert.equal(label.widgets[0].color, "#7a4800/1.00", "the prefab defines only this label ink");
  assert.equal(walk(frame).filter(n => n.widgets.some(w => "text" in w)).length, 1);
  assert.deepEqual(walk(frame).flatMap(n => n.widgets.filter(w => w.sprite?.startsWith("Common_Icon_Mulligan_")).map(w => w.sprite)),
    [applied ? "Common_Icon_Mulligan_1" : "Common_Icon_Mulligan_2"]);
  assert.equal(walk(frame).filter((n) => n.widgets.some((w) => w.sprite?.includes("Check"))).length, 0, "no second check");
  // Minimum, default and large windows; the 1920 stage maps the prefab's 2960 units uniformly at every density.
  for (const width of [960, 1600, 2560]) for (const density of [1, 2, 3]) {
    const scale = width / 2960 * density;
    assert.ok(glyphWidth(text, caption.fontSize) * scale <= box.width * scale + 1e-9);
    assert.ok(fontSizeFor(text, caption.fontSize) * LINE_PITCH * scale <= box.height * scale + 1e-9);
  }
});

test("Simplified Chinese reads exactly the owner's word", () => {
  assert.equal(strings.get("zh-CN").webui.status.applied, "已应用");
  assert.equal(strings.get("zh-CN").webui.status.selected, "已选择");
});

test("each locale uses the largest shared size that fits both captions above the legibility floor", () => {
  for (const locale of LOCALES) {
    document.documentElement.lang = locale;
    const ui = strings.get(locale).webui, texts = [ui.status.applied, ui.status.selected];
    const captions = fitBadgeCaptions(slot(), texts, fitGroup), box = badgeCaptionBox(slot());
    const size = captions[0].fontSize;
    assert.ok(size >= BADGE_FONT_MIN);
    assert.ok(size === box.fontSize || texts.some(text => glyphWidth(text, size + 2) > box.width
      || fontSizeFor(text, size + 2) * LINE_PITCH > box.height));
  }
});
