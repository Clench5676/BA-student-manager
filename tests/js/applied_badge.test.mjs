// The applied source card's badge (selected-frames.js, UIPopup_Mulligan's Mulligan_IndexBg with its number label
// Mulligan_IndexLabel): the label reads the game's word for "Selected" in every shipped language and fits the prefab label's
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
const { BADGE_FONT_MIN, badgeCaptionBox, fitBadgeCaption, selectedFrame, SELECTION_SLOT } =
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

test("the badge's label box is the prefab number label's", () => {
  assert.deepEqual(badgeCaptionBox(slot()), { fontSize: 42, width: 70, height: 52 });
  assert.equal(badgeCaptionBox({ children: [] }), null);
  assert.equal(fitBadgeCaption({ children: [] }, "Selected", fitGroup), null);
});

for (const locale of LOCALES) test(`${locale}: the label reads the game's word and fits the prefab label's box`, () => {
  const ui = strings.get(locale).webui, text = ui.status.selected;
  assert.equal(text, WORDS[locale]);
  assert.notEqual(text, ui.status.applied, "the badge's word is not the Applied wording");
  const box = badgeCaptionBox(slot());
  document.documentElement.lang = locale;
  const caption = fitBadgeCaption(slot(), text, fitGroup);
  assert.equal(caption.text, text, "one line, every character kept");
  assert.ok(!caption.overflow, `${locale} overflows its box`);
  assert.ok(caption.fontSize >= BADGE_FONT_MIN && caption.fontSize <= box.fontSize, `${locale} size ${caption.fontSize}`);
  assert.ok(glyphWidth(caption.text, caption.fontSize) <= box.width + 1e-9, `${locale}: ${glyphWidth(caption.text, caption.fontSize)} wide in ${box.width}`);
  assert.ok(fontSizeFor(caption.text, caption.fontSize) * LINE_PITCH <= box.height + 1e-9, `${locale} is too tall`);
  const frame = selectedFrame(slot(), { w: 312, h: 480 }, true, false, caption);
  const label = frame.children.find((n) => n.name === "AppliedLabel");
  assert.deepEqual([label.widgets[0].text, label.widgets[0].fontSize], [text, caption.fontSize]);
  assert.equal(walk(frame).filter((n) => n.widgets.some((w) => w.sprite?.includes("Check"))).length, 0, "no second check");
});

test("Simplified Chinese reads exactly the owner's word", () => {
  assert.equal(strings.get("zh-CN").webui.status.selected, "已选择");
});

test("the longest word, English, takes the smallest size, still above the legibility floor", () => {
  const sizes = LOCALES.map((locale) => {
    document.documentElement.lang = locale;
    return fitBadgeCaption(slot(), strings.get(locale).webui.status.selected, fitGroup).fontSize;
  });
  // CJK words are the widest per size: three characters fill 70 at 22; the Latin word needs the smallest size
  assert.equal(Math.min(...sizes), sizes[0]);
  assert.ok(sizes.every((size) => size >= BADGE_FONT_MIN));
});
