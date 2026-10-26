// UIPopup_Mulligan badges expand only their byte-identical middle columns. Text measurement uses a stand-in
// canvas (CJK one em, Thai bases .55 em and combining marks zero, Latin .5 em); native font appearance is owner UAT.
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
const { BADGE_FONT_MIN, badgeCaptionBox, fitBadgeCaptions, selectedFrame, SELECTION_BADGE_SLICES, SELECTION_SLOT } =
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
const CARDS = [{ w: 312, h: 480 }, { w: 320, h: 704 }, { w: 790, h: 444.375 },
  { w: 360, h: 360 }, { w: 250, h: 226 }, { w: 250, h: 250 }];
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
  for (const card of CARDS) {
    document.documentElement.lang = locale;
    const captions = fitBadgeCaptions(slot(), [ui.status.applied, ui.status.selected], fitGroup, glyphWidth, card);
    assert.equal(captions[0].fontSize, captions[1].fontSize, "both states share one size across sibling cards");
    const caption = captions[applied ? 0 : 1], text = applied ? ui.status.applied : ui.status.selected;
    const frame = selectedFrame(slot(), card, applied, previewed, caption);
    if (!applied && !previewed) { assert.equal(frame, null); continue; }
    assert.equal(caption.text, text, "one line, every character kept");
    assert.ok(!caption.overflow, `${locale} overflows its box`);
    assert.ok(caption.fontSize >= BADGE_FONT_MIN && caption.fontSize <= box.fontSize, `${locale} size ${caption.fontSize}`);
    assert.ok(glyphWidth(caption.text, caption.fontSize) <= caption.labelWidth + 1e-9, `${locale}: ${glyphWidth(caption.text, caption.fontSize)} wide in ${caption.labelWidth}`);

    const label = frame.children.find((n) => n.name === (applied ? "AppliedLabel" : "PreviewLabel"));
    assert.deepEqual([label.widgets[0].text, label.widgets[0].fontSize], [text, caption.fontSize]);
    assert.equal(label.widgets[0].color, "#7a4800/1.00", "the prefab defines only this label ink");
    assert.equal(walk(frame).filter(n => n.widgets.some(w => "text" in w)).length, 1);
    assert.deepEqual(walk(frame).flatMap(n => n.widgets.filter(w => w.sprite?.startsWith("Common_Icon_Mulligan_")).map(w => w.sprite)),
      [applied ? "Common_Icon_Mulligan_1" : "Common_Icon_Mulligan_2"]);
    assert.equal(walk(frame).filter((n) => n.widgets.some((w) => w.sprite?.includes("Check"))).length, 0, "no second check");
    const badge = frame.children.find(n => n.name === (applied ? "AppliedBadge" : "PreviewBadge")), bw = badge.widgets[0];
    const cuts = SELECTION_BADGE_SLICES[bw.sprite];
    const original = selectedFrame(slot(), card, applied, previewed).children.find(n => n.name === badge.name);
    const right = badge.pos[0] + bw.w_ / 2, left = badge.pos[0] - bw.w_ / 2;
    assert.equal(bw.w_, caption.badgeWidth);
    assert.ok(bw.w_ <= card.w, "the badge cannot exceed the card body's width");
    const cardLeftAtBadge = -card.w / 2 + (badge.pos[1] + frame.pos[1]) * Math.tan(Math.PI / 18);
    assert.ok(left >= cardLeftAtBadge - 1e-9, "width limit keeps the left end within the card at badge height");
    assert.ok(bw.w_ > 76, "widen the badge before shrinking the caption");
    assert.ok(Math.abs(right - original.pos[0] - 38) < 1e-9, "the right edge stays fixed");
    assert.equal(badge.pos[1], original.pos[1]); assert.equal(bw.h_, 74, "top and height stay fixed");
    assert.deepEqual(bw.sliceScale, [76 / 64, 74 / 69], "native prefab scale, independent of growth");
    assert.deepEqual(bw.sliceBorders, { borderLeft: 14, borderRight: 36, borderTop: 0, borderBottom: 0 });
    const innerLeft = left + cuts.borderLeft * bw.sliceScale[0], innerRight = right - cuts.borderRight * bw.sliceScale[0];
    assert.ok(Math.abs(label.pos[0] - (innerLeft + innerRight) / 2) < 1e-9);
    assert.equal(label.pos[1], badge.pos[1]);
    assert.ok(label.pos[0] - label.widgets[0].w_ / 2 >= innerLeft - 1e-9);
    assert.ok(label.pos[0] + label.widgets[0].w_ / 2 <= innerRight + 1e-9);
    const desired = Math.max(...[ui.status.applied, ui.status.selected].map(text => glyphWidth(text, box.fontSize)))
      + (cuts.borderLeft + cuts.borderRight) * bw.sliceScale[0];
    if (caption.fontSize < box.fontSize) assert.ok(desired > card.w, "shrink only at the card width limit");
    else assert.equal(caption.fontSize, 42);
    // The official Python test verifies fully opaque fill rows [3, 61). Test the entire line box, not only glyph width.
    const innerTop = badge.pos[1] + 37 - 3 * bw.sliceScale[1], innerBottom = badge.pos[1] + 37 - 61 * bw.sliceScale[1];
    const lineHeight = fontSizeFor(text, caption.fontSize) * LINE_PITCH;
    assert.ok(label.pos[1] + lineHeight / 2 <= innerTop);
    assert.ok(label.pos[1] - lineHeight / 2 >= innerBottom);
    // Minimum, default and large windows; the 1920 stage maps the prefab's 2960 units uniformly at every density.
    for (const width of [960, 1600, 2560]) for (const density of [1, 2, 3]) {
      const scale = width / 2960 * density;
      assert.ok(glyphWidth(text, caption.fontSize) * scale <= caption.labelWidth * scale + 1e-9);
      assert.ok(fontSizeFor(text, caption.fontSize) * LINE_PITCH * scale <= (innerTop - innerBottom) * scale + 1e-9);
    }
  }
});

test("Simplified Chinese reads exactly the owner's word", () => {
  assert.equal(strings.get("zh-CN").webui.status.applied, "已应用");
  assert.equal(strings.get("zh-CN").webui.status.selected, "已选择");
});

test("each locale uses the largest shared font size, expanding before the card width limit", () => {
  for (const locale of LOCALES) for (const card of CARDS) {
    document.documentElement.lang = locale;
    const ui = strings.get(locale).webui, texts = [ui.status.applied, ui.status.selected];
    const captions = fitBadgeCaptions(slot(), texts, fitGroup, glyphWidth, card), box = badgeCaptionBox(slot());
    const size = captions[0].fontSize, maxWidth = card.w - (14 + 36) * 76 / 64;
    assert.equal(captions[0].badgeWidth, captions[1].badgeWidth);
    assert.ok(size >= BADGE_FONT_MIN);
    assert.ok(size === box.fontSize || texts.some(text => glyphWidth(text, size + 2) > maxWidth));
  }
});

test("long captions shrink together only after the badge reaches its card-derived limit", () => {
  const captions = fitBadgeCaptions(slot(), ["A".repeat(40), "Selected"], fitGroup, glyphWidth, { w: 250 });
  assert.ok(captions[0].fontSize < 42);
  assert.equal(captions[0].fontSize, captions[1].fontSize);
  assert.ok(captions.every(c => glyphWidth(c.text, c.fontSize) <= c.labelWidth && !c.overflow));
  assert.ok(captions.every(c => c.badgeWidth <= 250));
});
