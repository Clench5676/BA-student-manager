// Tests for the text fitting in web/js/ngui.js (fitText, fitLabel): the CJK line-breaking rules in every UI language.
// Run by tests/test_ngui_fit.py with Node's test runner: node --test tests/js/ngui_fit.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");

// a canvas that measures a CJK character (Han, kana, Hangul, full-width forms) 1 em wide and anything else half an em
const WIDE = /[⺀-鿿　-ヿ＀-￯가-힯]/;
const ctx = {
  font: "",
  measureText(s) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
    // metrics for inkShift: ink 0.72 above the baseline (0.2 below for a letter with a descender), the font's box 1.16 above and 0.29 below
    return { width: [...s].reduce((w, c) => w + (WIDE.test(c) ? fs : fs / 2), 0), actualBoundingBoxAscent: 0.72 * fs, actualBoundingBoxDescent: /[gjpqy]/.test(s) ? 0.2 * fs : 0,
      fontBoundingBoxAscent: 1.16 * fs, fontBoundingBoxDescent: 0.29 * fs };
  },
};
globalThis.document = {
  createElement: () => ({ getContext: () => ctx, remove() {} }),
  documentElement: { lang: "ja-JP", appendChild() {} },
};
globalThis.getComputedStyle = (el) => ({ getPropertyValue: () => /^th(?:-|$)/.test(el.lang)
  ? /:lang\(th\)\s*\{\s*--font:\s*([^;]+);/.exec(css)?.[1] || "" : "" });
const { LINE_PITCH, fitGroup, fitLabel, fitLabels, fitRow, fitText, fontSizeFor, glyphWidth, inkBand, inkReference, inkShift, textWidth } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");

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

test("add confirmations preserve comma adjacency through fitting and wrapping", () => {
  document.documentElement.lang = "zh-CN";
  const text = "\u8be5 Mod \u5c5e\u4e8e \u7231\u4e3d\u4e1d\uff08\u5973\u4ec6\uff09\uff0c\u5df2\u6dfb\u52a0";
  for (const width of [1460, 700, 450, 300]) {
    const fitted = fitText(text, 52, 44, width, 4).text;
    assert.equal(fitted.replace(/\s/g, ""), text.replace(/\s/g, ""));
    assert.ok(fitted.includes("\uff09\uff0c"));
    assert.ok(!/[ \t]\uff0c|\uff0c[ \t]/.test(fitted));
  }
});

test("single-line values shrink independently and stop at their size floor", () => {
  const values = ["azusa_swimsuit_spr", "Replaced", "2024-11-18", "Fixed"];
  const fitted = values.map((value) => fitText(value, 42, 28, 250, 1));
  assert.ok(fitted[0].fs < 42);
  assert.deepEqual(fitted.slice(1).map((f) => f.fs), [42, 42, 42]);
  const full = "azusa_swimsuit_spr".repeat(20);
  assert.deepEqual(fitText(full, 42, 28, 250, 1), { text: full, fs: 28, lines: 1 });
});

test("Thai uses system fonts and keeps its size when measured on a Thai or English page", () => {
  document.documentElement.lang = "th-TH";
  assert.equal(fontSizeFor("ล็อบบี้ความทรงจำ", 40), 40);
  assert.equal(fontSizeFor("Mod นักเรียน", 40), 40);
  assert.equal(fontSizeFor("Mod", 40), 44.800000000000004);
  textWidth("ไทย", 40);
  assert.match(ctx.font, /^500 40px "RHR Latin",/);
  for (const family of ["Thonburi", "Sukhumvit Set", "Leelawadee UI", "Tahoma", "Noto Sans Thai"]) {
    assert.ok(ctx.font.includes(`"${family}"`), family);
  }
  document.documentElement.lang = "en-US";
  const widget = { text: "", fontSize: 40, w_: 200, lang: "th-TH" };
  fitLabel(widget, "ไทย", 40, 32, 200);
  assert.match(ctx.font, /Thonburi/);
  textWidth("English", 40);
  assert.doesNotMatch(ctx.font, /Thonburi/, "the label's language does not leak into the next measurement");
});

test("Thai wraps at word boundaries without separating vowels and tone marks", () => {
  document.documentElement.lang = "th-TH";
  const text = "เพิ่มล็อบบี้ความทรงจำของนักเรียน";
  const boundaries = new Set([...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map((s) => s.index));
  for (const width of [220, 260, 300]) {
    const lines = assertBreaks(text, "th-TH", width);
    let index = 0;
    for (const line of lines.slice(0, -1)) {
      index += line.length;
      assert.ok(boundaries.has(index), `word boundary at ${index}: ${JSON.stringify(lines)}`);
    }
    assert.ok(lines.every((line) => !/^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/.test(line)));
  }
});

test("without Intl.Segmenter Thai runs stay intact", () => {
  document.documentElement.lang = "th-TH";
  const segmenter = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    const text = "ล็อบบี้ความทรงจำ";
    assert.equal(fitText(text, 40, 32, 50, 4).text, text);
  } finally {
    Intl.Segmenter = segmenter;
  }
});

test("one long word goes below the size range instead of running past its box", () => {
  document.documentElement.lang = "en-US";
  // "Compatibility" is 7.28 em wide on this mock: 100 wide needs 13 or smaller, below fsMin - 8 (18)
  const f = fitText("Compatibility", 40, 26, 100, 2);
  assert.equal(f.lines, 1);
  assert.ok(f.fs < 18, `shrunk below the range: ${f.fs}`);
  assert.ok(glyphWidth(f.text, f.fs) <= 100);
  // a word that fits at the range's own floor is unchanged
  assert.equal(fitText("Compatibility", 40, 26, 140, 2).fs, 18);
  // a one-line cell still keeps its floor (its caller clips)
  assert.equal(fitText("Compatibility", 40, 26, 100, 1).fs, 26);
  // and where not even half the minimum fits, the old floor stays
  assert.equal(fitText("Compatibility", 40, 26, 40, 2).fs, 18);
});

// --- groups of widgets of one kind: one size for all (fitGroup, fitLabels, fitRow) ---
const ROW = ["Apply", "Show in Finder", "Check Compatibility", "Update", "Delete"];
const fits = (f, widths, maxH = Infinity) => f.every((x, i) => x.text.split("\n").every((l) => glyphWidth(l, x.fs) <= widths[i] + 1e-9)
  && x.lines * fontSizeFor(x.text, x.fs) * LINE_PITCH <= maxH);

// the narrowest the label gets at fs on one line or on two (broken at a space): what its box has to hold
const narrowest = (label, fs) => {
  const words = label.split(" "), one = glyphWidth(label, fs);
  let best = one;
  for (let k = 1; k < words.length; k++) best = Math.min(best, Math.max(glyphWidth(words.slice(0, k).join(" "), fs), glyphWidth(words.slice(k).join(" "), fs)));
  return best;
};
test("a group shares one size, the largest at which every label fits after wrapping", () => {
  document.documentElement.lang = "en-US";
  for (const width of [100, 116, 144, 200, 300]) {
    const group = fitGroup(ROW, 40, 26, width, 2);
    assert.equal(new Set(group.map((f) => f.fs)).size, 1, `one size at ${width}`);
    assert.ok(fits(group, ROW.map(() => width)), `every label fits ${width}`);
    // the size is the largest: every label fits its narrowest wrapping at it, and one step larger fails for some label
    const fs = group[0].fs;
    assert.ok(ROW.every((s) => narrowest(s, fs) <= width + 1e-9), `all fit at ${fs}`);
    if (fs < 40) assert.ok(ROW.some((s) => narrowest(s, fs + 2) > width), `${fs + 2} does not fit at ${width}`);
  }
});

test("a long caption wraps at its spaces and a word is never split", () => {
  document.documentElement.lang = "en-US";
  const [a, b, c] = fitGroup(["Update", "Show in Finder", "Check Compatibility"], 40, 26, 140, 2);
  assert.equal(a.text, "Update");
  assert.equal(b.lines, 2);
  assert.deepEqual(c.text.split("\n"), ["Check", "Compatibility"]);
  for (const f of [a, b, c]) assert.ok(f.text.split("\n").every((l) => !/^\s|\s$/.test(l)));
  // a word wider than the box makes the size smaller, not the word split
  const narrow = fitGroup(["Compatibility", "OK"], 40, 26, 100, 2);
  assert.equal(narrow[0].text, "Compatibility");
  assert.ok(glyphWidth("Compatibility", narrow[0].fs) <= 100);
  assert.ok(narrow[0].fs < 26, "below the minimum only where nothing else fits");
  // and where not even half the minimum holds the word, the group says so instead of pretending
  assert.ok(fitGroup(["Compatibility"], 40, 26, 60, 2).every((f) => f.overflow));
});

test("the height budget keeps wrapped lines inside the widget", () => {
  document.documentElement.lang = "en-US";
  const tall = fitGroup(["Show in Finder"], 40, 26, 160, 2);
  const capped = fitGroup(["Show in Finder"], 40, 26, 160, 2, { maxH: 60 });
  assert.ok(tall[0].fs > capped[0].fs || tall[0].lines === 1);
  assert.ok(fits(capped, [160], 60));
});

test("wrapping that wins only a step of size is not used", () => {
  document.documentElement.lang = "en-US";
  // "Error Report" on one line fits at 52 here, two lines would give 54: one line stays
  const [a] = fitGroup(["Error Report"], 64, 40, 420, 2, { maxH: 140 });
  assert.equal(a.lines, 1);
});

test("a group of CJK and Thai labels wraps by words and shares a size", async () => {
  for (const locale of ["th-TH", "zh-CN", "ko-KR", "ja-JP"]) {
    const ui = JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    const labels = [ui.popup.apply, ui.compatibility.check, ui.btn.delete];
    document.documentElement.lang = locale;
    const group = fitGroup(labels, 40, 26, 170, 2);
    assert.equal(new Set(group.map((f) => f.fs)).size, 1, locale);
    assert.ok(fits(group, labels.map(() => 170)), `${locale} fits`);
    assert.equal(group.map((f) => f.text.replace(/\s/g, "")).join("|"), labels.map((l) => l.replace(/\s/g, "")).join("|"), "every character kept");
  }
});

test("fitLabels puts one size into every label widget and never narrows a box", () => {
  document.documentElement.lang = "en-US";
  const widgets = [{ text: "", fontSize: 72, w_: 600 }, { text: "", fontSize: 72, w_: 100 }];
  const group = fitLabels(widgets, ["Error Report", "OK"], 64, 40, 420, 2, { maxH: 140 });
  assert.deepEqual(widgets.map((w) => w.fontSize), [group[0].fs, group[0].fs]);
  assert.deepEqual(widgets.map((w) => w.w_), [600, 420]);
  assert.deepEqual(widgets.map((w) => w.text), group.map((f) => f.text));
});

test("a row keeps equal bodies until they would force the size below the prefab's range", () => {
  document.documentElement.lang = "en-US";
  const clear = 28, gap = 14;
  // equal bodies reach 26 or more: nothing moves, even where unequal bodies could win a few units of size
  const plain = ["Apply", "Show in Finder", "Extract"], room = 3 * 249;
  const even = fitRow(plain, 40, 26, room, clear, 2, { maxH: 96 });
  assert.ok(even[0].fs >= 26);
  assert.deepEqual(even.map((f) => f.width), [249, 249, 249]);
  assert.equal(new Set(even.map((f) => f.fs)).size, 1);
  assert.equal(even[0].fs, fitGroup(plain, 40, 26, 249 - clear, 2, { maxH: 96 })[0].fs);
  // five captions in 144 each: the long word "Compatibility" sends equal bodies under 26
  const total = 5 * (158 - gap);
  const equal = fitGroup(ROW, 40, 26, total / 5 - clear, 2, { maxH: 96 });
  assert.ok(equal[0].fs < 26, `equal bodies are cramped: ${equal[0].fs}`);
  const row = fitRow(ROW, 40, 26, total, clear, 2, { maxH: 96 });
  assert.ok(row[0].fs > equal[0].fs, `unequal bodies buy size: ${row[0].fs} against ${equal[0].fs}`);
  assert.equal(new Set(row.map((f) => f.fs)).size, 1);
  assert.ok(Math.abs(row.reduce((n, f) => n + f.width, 0) - total) < 1e-6, "the row keeps its width");
  row.forEach((f, i) => assert.ok(fits([f], [f.width - clear], 96), `${ROW[i]} fits its body`));
  // the widest caption has the widest body
  assert.equal(row.reduce((a, f, i) => (f.width > row[a].width ? i : a), 0), 2);
  // every body is its caption's need or the one level the others share: as equal as the captions allow
  const needs = row.map((f) => Math.max(...f.text.split("\n").map((l) => glyphWidth(l, f.fs))) + clear);
  const level = new Set(row.filter((f, i) => f.width > needs[i] + 1e-6).map((f) => f.width.toFixed(6)));
  assert.ok(level.size <= 1, `one shared level, got ${[...level]}`);
  row.forEach((f, i) => assert.ok(f.width >= needs[i] - 1e-6));
});

test("a single caption row is just the group", () => {
  document.documentElement.lang = "en-US";
  const [only] = fitRow(["Extract"], 40, 26, 300, 28, 2, { maxH: 96 });
  assert.equal(only.width, 300);
  assert.equal(only.fs, fitGroup(["Extract"], 40, 26, 272, 2, { maxH: 96 })[0].fs);
});

// --- ink centring (inkShift, inkReference) ---
test("ink centring is measured from the font, for one line and for two, without computed style", () => {
  document.documentElement.lang = "en-US";
  const px = 20, near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // ink 0.72 above the baseline and none below; the font's own box 1.16 above and 0.29 below
  near(inkShift("Occlusion", px), (0.72 - 0 - 1.16 + 0.29) * px / 2);
  // two lines: the first line's top and the last line's bottom decide (a descender in the last line lifts the text)
  near(inkShift("Occlusion\nGuide", px), inkShift("Occlusion", px));
  near(inkShift("Occlusion\nGrid by", px), (0.72 - 0.2 - 1.16 + 0.29) * px / 2);
  // a metric the browser does not give leaves the text where the box puts it
  const measure = ctx.measureText;
  ctx.measureText = () => ({ width: 10 });
  try { assert.equal(inkShift("x", px), 0); } finally { ctx.measureText = measure; }
});

test("a reference glyph gives every Latin or Thai title of a script one baseline; CJK uses its own ink", () => {
  document.documentElement.lang = "en-US";
  assert.equal(inkReference("Students"), "H");
  assert.equal(inkReference("Batch Import"), "H");
  assert.equal(inkReference("Mod \u0e19\u0e31\u0e01\u0e40\u0e23\u0e35\u0e22\u0e19"), "\u0e01");
  for (const text of ["\u5b66\u751f", "\u5b78\u751f", "\u751f\u5f92", "\ud559\uc0dd", "\u4e00\u62ec\u30a4\u30f3\u30dd\u30fc\u30c8"]) assert.equal(inkReference(text), null, text);
  const px = 40, near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // a descender does not move a Latin title
  const a = inkShift("Students", px, { reference: true });
  near(a, inkShift("Batch Import", px, { reference: true }));
  near(a, inkShift("gyp", px, { reference: true }));
  near(a, (0.72 - 0 - 1.16 + 0.29) * px / 2);
  // without the option the letters' own ink counts
  assert.ok(inkShift("gyp", px) !== a);
});

test("inkBand gives the ink's top and bottom around the box centre, lines at the 1.15 pitch", () => {
  const px = 20, near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  // stand-in metrics: ink 0.72 px above the baseline, 0.2 px below for a descender; the font box 1.16 above, 0.29 below
  const band = inkBand("Hg", px), shift = inkShift("Hg", px);
  near(band.top, -shift - (0.72 + 0.2) * px / 2); near(band.bottom, -shift + (0.72 + 0.2) * px / 2);
  const two = inkBand("H\ng", px);
  near(two.bottom - two.top, (0.72 + 0.2 + 1.15) * px); near((two.top + two.bottom) / 2, -inkShift("H\ng", px));
});
