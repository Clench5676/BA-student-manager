// Tests for the text fitting in web/js/ngui.js (fitText, fitLabel): the CJK line-breaking rules in every UI language.
// Run by tests/test_ngui_fit.py with Node's test runner: node --test tests/js/ngui_fit.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

// a canvas that measures a CJK character (Han, kana, Hangul, full-width forms) 1 em wide and anything else half an em
const WIDE = /[⺀-鿿　-ヿ＀-￯가-힯]/;
const ctx = {
  font: "",
  measureText(s) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
    return { width: [...s].reduce((w, c) => w + (WIDE.test(c) ? fs : fs / 2), 0) };
  },
};
globalThis.document = { createElement: () => ({ getContext: () => ctx }), documentElement: { lang: "ja-JP" } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const { fitLabel, fitText } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");

const BAD_START = /^[、。，．：；！？）」』】〉》…‥ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ〜～,.!?)]/;
const BAD_END = /[（「『【〈《(]$/;

function assertBreaks(text, lang, maxW, maxLines = 4) {
  document.documentElement.lang = lang;
  const f = fitText(text, 40, 32, maxW, maxLines);
  const lines = f.text.split("\n");
  assert.ok(lines.length > 1, `${text} should wrap`);
  assert.equal(lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""), "every character kept");
  lines.slice(1).forEach((l) => assert.ok(!BAD_START.test(l), `line starts with ${l[0]}: ${JSON.stringify(f.text)}`));
  lines.slice(0, -1).forEach((l) => assert.ok(!BAD_END.test(l), `line ends with ${l.at(-1)}: ${JSON.stringify(f.text)}`));
  return lines;
}

test("an ellipsis or a question mark never starts a line (zh-TW lobby line)", () => {
  assertBreaks("我一個人這麼開心是可以的嗎… 你說這擔心是多餘的？…是…", "zh-TW", 7 * 32);
});

test("Japanese: no small kana, prolonged sound mark or closing bracket starts a line, no opening bracket ends one", () => {
  for (const w of [8, 9, 10, 11, 12]) {
    assertBreaks("先生、「ありがとう」って言ってくれる？", "ja-JP", w * 32);
    assertBreaks("メモリアルロビーのプレビューを、ちょっとだけ見せてね！", "ja-JP", w * 32);
  }
});

test("Korean breaks at spaces and keeps its punctuation on the line before", () => {
  const lines = assertBreaks("메모리얼 로비를 전환할까요? 원래 파일은 보관됩니다.", "ko-KR", 7 * 32);
  assert.ok(lines.every((l) => !/^\s|\s$/.test(l)));
});

test("Simplified Chinese still breaks at its separators first", () => {
  document.documentElement.lang = "zh-CN";
  assert.equal(fitText("星野（一年级，学校泳装）", 40, 32, 6 * 32).text, "星野（一年级，\n学校泳装）");
});

test("a fitted label's box is at least as wide as the width it was fitted to", () => {
  const widget = { text: "", fontSize: 72, w_: 400 };
  const f = fitLabel(widget, "Finder에서 보기", 64, 40, 420);
  assert.deepEqual([widget.text, widget.fontSize, widget.w_], [f.text, f.fs, 420]);
  const wide = { text: "", fontSize: 72, w_: 600 };
  fitLabel(wide, "OK", 64, 40, 420);
  assert.equal(wide.w_, 600);
});

test("single-line values shrink independently and stop at their size floor", () => {
  const values = ["azusa_swimsuit_spr", "Replaced", "2024-11-18", "Fixed"];
  const fitted = values.map((value) => fitText(value, 42, 28, 250, 1));
  assert.ok(fitted[0].fs < 42);
  assert.deepEqual(fitted.slice(1).map((f) => f.fs), [42, 42, 42]);
  const full = "azusa_swimsuit_spr".repeat(20);
  assert.deepEqual(fitText(full, 42, 28, 250, 1), { text: full, fs: 28, lines: 1 });
});
