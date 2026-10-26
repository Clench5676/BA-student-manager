// The top bar's vertical alignment and title size (top-bar-layout.js, ngui.js inkShift / fontSizeFor): the numbers, in every
// shipped language. Run by tests/test_top_bar.py.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const WIDE = /[\u2e80-\u9fff\u3000-\u30ff\uff00-\uffef\uac00-\ud7af\u0e00-\u0e7f]/;
const ctx = {
  font: "",
  measureText(s) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)[1]);
    return { width: [...s].reduce((w, c) => w + (WIDE.test(c) ? fs : fs / 2), 0), actualBoundingBoxAscent: 0.72 * fs, actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 1.16 * fs, fontBoundingBoxDescent: 0.29 * fs };
  },
};
globalThis.document = {
  createElement: () => ({ getContext: () => ctx, remove() {} }),
  documentElement: { lang: "en-US", appendChild() {} },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const Layout = await import("../../src/ba_modding_toolkit/web/js/top-bar-layout.js");
const S = 1920 / 2960;
const LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("the bar's centre is the fill's: the light rows of Common_Top_Menu_Bg, not the dark lip under them", () => {
  // rows 0 to 96 of 105 are the fill, drawn 64 px high; a centre on the whole height would be 32
  near(Layout.barCentre(), 97 / 2 / 105 * 64);
  assert.ok(Layout.barCentre() < 32 && Layout.barCentre() > 29);
  near(Layout.barPadding(Layout.barCentre()), 64 - 2 * Layout.barCentre());
  // the fill's rows scale with the bar
  near(Layout.barCentre(Layout.FILL, 128), 2 * Layout.barCentre());
  // a bar that is all fill is centred on its middle and needs no padding
  near(Layout.barCentre({ top: 0, bottom: 10, height: 10 }), 32);
  assert.equal(Layout.barPadding(32), 0);
  assert.equal(Layout.barPadding(40), 0, "never negative");
});

test("a drawn bitmap's ink is its box scaled by the rows that draw something", () => {
  const ink = Layout.inkRect({ top: 12, bottom: 52 }, { top: 0, bottom: 76, height: 80 });
  near(ink.top, 12);
  near(ink.bottom, 12 + 38);
  const union = Layout.extent([ink, Layout.inkRect({ top: 12, bottom: 50 }, { top: 0, bottom: 25, height: 25 }), null, { top: 3, bottom: 3 }]);
  assert.deepEqual(union, { top: 12, bottom: 50 });
  assert.equal(Layout.extent([]), null);
  assert.equal(Layout.extent([null]), null);
});

test("moving an element puts the centre of its ink on the bar's centre", () => {
  const centre = Layout.barCentre();
  // the "?" badge: ink 12.2 to 43.6; Settings: ink is its whole box
  for (const ink of [{ top: 12.2, bottom: 43.6 }, { top: 6.41, bottom: 46.62 }, { top: 7, bottom: 45.27 }, { top: 11.8, bottom: 43.6 }]) {
    const dy = Layout.moveBy(centre, ink);
    near((ink.top + dy + ink.bottom + dy) / 2, centre);
  }
  assert.equal(Layout.moveBy(centre, null), 0);
});

test("every element's ink lands on the bar's centre, from the prefab's geometry and the sprites' drawn rows", () => {
  const centre = Layout.barCentre();
  // NUITop_Scenes/Top/Right: Lobby (Home) 62 x 59 at y -51.8, Option 60 x 62 at -52.4, Line (1) 4 x 49 at -54.2; nav.js puts
  // Home's top at 7 and the others at the prefab's offsets from it (units to stage px: 1920 / 2960). Their sprites are drawn
  // to the edge (alpha rows 0 to the last), so the ink is the box.
  const home = { y: -51.8, h: 59 }, option = { y: -52.4, h: 62 }, line = { y: -54.2, h: 49 };
  const box = (part) => { const top = 7 + (home.y - part.y + (home.h - part.h) / 2) * S, height = part.h * S; return { top, bottom: top + height }; };
  const expected = { home: 7 + 38.27 / 2, option: 6.42 + 40.2 / 2, line: 11.8 + 31.78 / 2 };
  for (const [name, part] of Object.entries({ home, option, line })) {
    const ink = box(part), at = (ink.top + ink.bottom) / 2;
    near(at, expected[name], 0.02);
    // before: Settings, Home and the divider sat above the centre by these (the owner's "a few pixels high")
    assert.ok(at < centre - 1.5, `${name} was ${(centre - at).toFixed(2)} above`);
    const dy = Layout.moveBy(centre, ink);
    near((ink.top + dy + ink.bottom + dy) / 2, centre);
  }
  // Left side: flex centres each box on the bar's centre; what is left to move is the ink's own offset inside its box.
  // The switch: segments 38 (pressed) and 40 (normal, its last 4 of 80 rows are shadow) high, all drawn from the box's top.
  const toggle = Layout.extent([Layout.inkRect({ top: 12, bottom: 50 }, { top: 0, bottom: 25, height: 25 }), Layout.inkRect({ top: 12, bottom: 52 }, { top: 0, bottom: 76, height: 80 })]);
  near(toggle.top, 12); near(toggle.bottom, 50);
  const insideBox = (ink, boxTop, boxBottom) => (ink.top + ink.bottom) / 2 - (boxTop + boxBottom) / 2;
  near(insideBox(toggle, 12, 52), -1);
  // the "?" badge: Common_Btn_Information 70 x 72 (rows 0 to 57 drawn) and its 55 x 55 square, both at 0.55
  const help = Layout.extent([Layout.inkRect({ top: 12.2, bottom: 12.2 + 39.6 }, { top: 0, bottom: 57, height: 72 }), Layout.inkRect({ top: 14.4, bottom: 14.4 + 27.5 }, { top: 0, bottom: 55, height: 55 })]);
  near(help.top, 12.2); near(help.bottom, 12.2 + 57 / 72 * 39.6);
  near(insideBox(help, 12, 52), (12.2 + 12.2 + 57 / 72 * 39.6) / 2 - 32);
  for (const [ink, boxTop, boxBottom] of [[toggle, 12, 52], [help, 12, 52]]) {
    // the box is centred on `centre`; moving by -offset puts the ink there
    const offset = insideBox(ink, boxTop, boxBottom), dy = Layout.moveBy(centre, { top: centre + offset - 1, bottom: centre + offset + 1 });
    near(dy, -offset);
  }
  // the two sit within a few pixels of the line, as the pill's and the badge's art are: they were not the ones far off
  assert.ok(Math.abs(insideBox(toggle, 12, 52)) < 1.5);
  assert.ok(Math.abs(insideBox(help, 12, 52)) < 4.5);
});

for (const locale of LOCALES) test(`the title uses the caption's drawn size on every page in ${locale}`, async () => {
  const ui = JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
  document.documentElement.lang = locale;
  for (const title of [ui.top.students, ui.hall.title, ui.nav.import]) {
    assert.ok(title);
    for (const captionPx of [20, 23, 26]) assert.equal(Layout.titlePx(captionPx), captionPx);
  }
  assert.equal(Layout.titlePx(), 26);
});

test("the title is centred by its script's reference glyph, not by its own letters", async () => {
  const nav = await readFile(new URL("../../src/ba_modding_toolkit/web/js/top-bar.js", import.meta.url), "utf8");
  assert.match(nav, /inkShift\(el\.textContent, parseFloat\(getComputedStyle\(el\)\.fontSize\), \{ reference: true \}\)/);
  // the same title on every page keeps one baseline: capital H for Latin
  document.documentElement.lang = "en-US";
  const px = Layout.titlePx();
  const shifts = ["Students", "Student Hall", "Batch Import"].map((t) => NGUI.inkShift(t, px, { reference: true }));
  assert.ok(shifts.every((v) => Math.abs(v - shifts[0]) < 1e-9));
});

test("the bar's padding and the title size come from the code, not fixed numbers in the style sheet alone", async () => {
  const css = await readFile(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  assert.match(css, /padding-bottom: var\(--bar-padding, 4\.88px\)/);
  near(Layout.barPadding(Layout.barCentre()), 4.88, 0.01);
  const nav = await readFile(new URL("../../src/ba_modding_toolkit/web/js/nav.js", import.meta.url), "utf8");
  assert.match(nav, /sizeTitle\(title\)/);
  assert.match(nav, /watchTopBar\(\)/);
});
