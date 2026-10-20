import assert from "node:assert/strict";
import { test } from "node:test";
import { cardColours, colourSwitchCard, edgeColours } from "../../src/ba_modding_toolkit/web/js/switch-card.js";

const imageData = (pixels) => ({ width: pixels[0].length, height: pixels.length, data: new Uint8ClampedArray(pixels.flat(2)) });
const blend = (a, b, t) => a.map((v, c) => v * (1 - t) + b[c] * t);
const relativeLuminance = (rgb) => {
  const linear = rgb.map((v) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};
const contrast = (text, background) => {
  const a = text === "#ffffff" ? 1 : 0, b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
function checkFade(rows, palette) {
  for (let y = 0; y < rows.length; y++) for (let v = 0; v <= 10; v++) for (let x = 0; x <= 10; x++) {
    const edge = blend(rows[y], rows[Math.min(y + 1, rows.length - 1)], v / 10);
    const faded = blend(edge, [239, 243, 247], x / 10);
    const background = blend(faded, palette.backing, palette.alpha);
    assert.ok(contrast(palette.color, background) >= 4.5, `name contrast on ${background} with ${palette.color}`);
    assert.ok(contrast(palette.color, background.map(Math.round)) >= 4.5, "8-bit colour rounding keeps the name readable");
  }
}

test("the last painted edge pixels determine the colours, rather than the picture's left side", () => {
  const edge = [12, 34, 56, 255], left = [250, 220, 190, 255];
  assert.deepEqual(edgeColours(imageData([[left, edge, edge, edge, edge]])), [[12, 34, 56]]);
});

test("portrait alpha margins and empty rows extend painted colours without transparent black fringes", () => {
  const clear = [0, 0, 0, 0], edge = [80, 120, 180, 128];
  const rows = edgeColours(imageData([[clear, clear, clear], [edge, edge, clear], [clear, clear, clear]]));
  assert.deepEqual(rows, Array.from({ length: 3 }, () => [80, 120, 180]));
  assert.deepEqual(edgeColours(imageData([[clear]])), [[239, 243, 247]]);
  assert.equal(cardColours([]).color, "#000000");
});

test("right edge colours vary down the card and are smoothed before fading", () => {
  const rows = edgeColours(imageData(Array.from({ length: 8 }, (_, y) => [[y < 4 ? 20 : 180, 60, 100, 255]])));
  assert.deepEqual(rows[0], [20, 60, 100]);
  assert.deepEqual(rows.at(-1), [180, 60, 100]);
  assert.ok(rows[3][0] > 20 && rows[3][0] < 180);
  assert.ok(cardColours(rows).backgroundImage.includes("rgb(20.000, 60.000, 100.000)"));
  assert.ok(cardColours(rows).backgroundImage.includes("rgb(180.000, 60.000, 100.000)"));
});

for (const [name, rows, needsBacking] of [
  ["dark", [[8, 18, 40], [25, 30, 60]], true],
  ["light", [[220, 235, 255], [245, 240, 225]], false],
]) test(`${name} edges choose text that remains readable through the light end`, () => {
  const palette = cardColours(rows);
  assert.equal(palette.color, "#000000");
  assert.equal(palette.alpha > 0, needsBacking);
  assert.ok(palette.backgroundImage.includes("rgb(239.000, 243.000, 247.000) 100%"));
  checkFade(rows, palette);
});

test("all single greys keep readable text across the entire fade to light", () => {
  for (let grey = 0; grey <= 255; grey++) {
    const rows = [[grey, grey, grey]], palette = cardColours(rows);
    if (grey >= 118) assert.equal(palette.alpha, 0);
    checkFade(rows, palette);
  }
});

test("mixed light and dark edges get the smaller backing needed for the entire fade", () => {
  const rows = [[0, 0, 0], [255, 255, 255]], palette = cardColours(rows);
  assert.equal(palette.color, "#000000");
  assert.ok(palette.alpha > 0 && palette.alpha < 0.5);
  checkFade(rows, palette);
});

test("saturated colours and their interpolated midpoints retain at least 4.5:1 name contrast", () => {
  const palettes = [
    [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
    [[255, 0, 255], [0, 255, 255]],
    [[0, 0, 80], [255, 255, 150], [120, 20, 180]],
  ];
  let seed = 1234;
  for (let i = 0; i < 30; i++) palettes.push(Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  })));
  for (const rows of palettes) checkFade(rows, cardColours(rows));
});

for (const [kind, top, height] of [["lobby", -26, 253], ["special L2D", -26, 253]]) {
  test(`${kind} sampling follows its crop and applies matching fill and text together`, async () => {
    const draws = [], samples = [], image = { naturalWidth: 900, naturalHeight: 506 };
    const previous = globalThis.document;
    globalThis.document = { createElement(tag) {
      assert.equal(tag, "canvas");
      return { getContext(type) {
        assert.equal(type, "2d");
        return {
          drawImage(...args) { draws.push(args); },
          getImageData(...args) { samples.push(args); return imageData([[[20, 30, 40, 255]]]); },
        };
      } };
    } };
    try {
      const picture = { style: { width: "766px", height: "201px" } }, text = { style: {} };
      let resolve, loads = 0;
      const source = new Promise((done) => { resolve = done; });
      const ready = colourSwitchCard(picture, text, {
        clipImage: source, imgLeft: "-9px", imgWidth: "450px", imgTop: `${top}px`, imgHeight: `${height}px`, imgEdge: 0.7,
      }, async (url) => {
        loads++;
        assert.equal(url, `blob:${kind}`);
        return image;
      }, { kind: "lobby", background: "/portrait-background.png" });
      await Promise.resolve();
      assert.equal(loads, 0, "the still may arrive asynchronously");
      assert.equal(picture.style.backgroundImage, undefined);
      resolve(`blob:${kind}`);
      await ready;
      assert.deepEqual(draws[0], [image, 0, 0, 630, 506, 0, top / 201 * 24, 64, height / 201 * 24]);
      assert.deepEqual(samples, [[0, 0, 64, 24]]);
      assert.ok(picture.style.backgroundImage.includes("linear-gradient"));
      assert.ok(picture.style.backgroundImage.includes("transparent 39.948%"), "the fade starts at the visible thumbnail edge");
      assert.ok(picture.style.backgroundImage.includes("247.000) 100%"), "the sampled colours reach the light end");
      assert.ok(!picture.style.backgroundImage.includes("portrait-background"));
      assert.equal(text.style.color, "#000000");
    } finally { globalThis.document = previous; }
  });
}

test("portrait artwork appears behind the thumbnail without waiting for or sampling it", async () => {
  const thumbnail = { style: { backgroundImage: 'url("blob:bust")' } };
  const picture = { style: {}, children: [thumbnail] }, text = { style: { color: "#2d4664" } };
  const load = () => assert.fail("portrait colours must not replace its original background");
  await colourSwitchCard(picture, text, { clipImage: new Promise(() => {}) }, load, { kind: "portrait", background: "/original.png" });
  assert.equal(picture.style.backgroundImage, 'url("/original.png")');
  assert.equal(picture.style.backgroundSize, "cover");
  assert.equal(thumbnail.style.backgroundImage, 'url("blob:bust")');
  assert.equal(text.style.color, "#2d4664");
});

test("without portrait artwork the prefab card background stays visible", async () => {
  const picture = { style: {} }, text = { style: {} };
  await colourSwitchCard(picture, text, { clipImage: "blob:bust" }, () => assert.fail("no sampling"), { kind: "portrait" });
  assert.deepEqual(picture.style, {});
  assert.deepEqual(text.style, {});
});

test("abandoned cards do not change their artwork or text", async () => {
  const controller = new AbortController(), picture = { style: {} }, text = { style: {} };
  controller.abort();
  for (const kind of ["portrait", "lobby"]) await colourSwitchCard(picture, text, { clipImage: "blob:gone" },
    () => assert.fail("cancelled cards do not load"), { kind, background: "/original.png", signal: controller.signal });
  assert.deepEqual(picture.style, {});
  assert.deepEqual(text.style, {});
});

test("an absent or failed still leaves the fallback card and text usable", async () => {
  const picture = { style: {} }, text = { style: {} };
  const load = async () => { throw new Error("Image unavailable"); };
  await colourSwitchCard(picture, text, { clipImage: Promise.resolve(null) }, load);
  await assert.rejects(colourSwitchCard(picture, text, { clipImage: "blob:failed" }, load), /Image unavailable/);
  await assert.rejects(colourSwitchCard(picture, text, { clipImage: Promise.reject(new Error("Still failed")) }, load), /Still failed/);
  assert.deepEqual(picture.style, {});
  assert.deepEqual(text.style, {});
});
