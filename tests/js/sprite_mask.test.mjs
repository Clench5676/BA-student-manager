import assert from "node:assert/strict";
import { test } from "node:test";
import { maskWithSprite, spriteMaskTransform, spriteSurface } from "../../src/ba_modding_toolkit/web/js/sprite-mask.js";
import { clipButtonPatterns } from "../../src/ba_modding_toolkit/web/js/button-layout.js";
import { maskCanvas } from "./sprite_mask_fixture.mjs";

const style = (x, y, w, h, transform = "") => ({ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transform });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const deferred = () => { let resolve; return { promise: new Promise((r) => { resolve = r; }), resolve: (value) => resolve(value) }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("sprite masks use transformed local coordinates for non-square and fractional widgets", () => {
  for (const scale of [.34, .5, 1920 / 2960, 1.25]) for (const flipX of [-1, 1]) for (const flipY of [-1, 1]) {
    const body = style(16.23 * scale, 30.17 * scale, 300.16 * scale, 112.1 * scale, "skewX(-10deg)");
    const target = style(45.51 * scale, 42.8 * scale, 126.3 * scale, 70.6 * scale, `skewX(3deg) scale(${flipX}, ${flipY})`);
    const result = spriteMaskTransform(body, target);
    for (const [x, y] of [[0, 0], [300.16 * scale, 112.1 * scale], [23 * scale, 50 * scale]]) {
      const [u, v] = point(result, x, y);
      const tx = (u - 126.3 * scale / 2) * flipX, ty = (v - 70.6 * scale / 2) * flipY;
      const stageX = 45.51 * scale + 126.3 * scale / 2 + tx + Math.tan(3 * Math.PI / 180) * ty;
      const stageY = 42.8 * scale + 70.6 * scale / 2 + ty;
      near(stageX, 16.23 * scale + x - Math.tan(10 * Math.PI / 180) * (y - 112.1 * scale / 2));
      near(stageY, 30.17 * scale + y);
    }
  }
});

test("the official painted surface excludes grey bevels and shadows, preserving a rounded notch", () => {
  for (const tint of [[255, 255, 255], [141, 228, 255], [214, 214, 214]]) {
    const colors = [[...tint, 255], [...tint.map((c) => Math.round(c * .98)), 255],
      [...tint.map((c) => Math.round(c * .8)), 255], [...tint, 128], [0, 0, 0, 0],
      [...tint, 255], [...tint, 230], [...tint, 255], [...tint, 255]];
    const pixels = { width: 3, height: 3, data: new Uint8ClampedArray(colors.flat()) };
    const before = new Uint8ClampedArray(pixels.data), out = spriteSurface(pixels);
    assert.deepEqual(pixels.data, before, "source pixels never change");
    const alpha = Array.from(out.data).filter((_, i) => i % 4 === 3);
    assert.deepEqual(alpha.slice(0, 6), [255, 255, 0, 0, 0, 255]);
    assert.ok(alpha[6] > 0 && alpha[6] < 255, "the source's antialiased corner retains fractional coverage");
    assert.deepEqual(alpha.slice(7), [255, 255]);
  }
});

test("surface extraction retains a non-square sprite's rounded and diagonal corner geometry", () => {
  const width = 37, height = 23, radius = 6, data = new Uint8ClampedArray(width * height * 4);
  const inside = (x, y) => {
    const cx = Math.max(radius, Math.min(width - radius, x)), cy = Math.max(radius, Math.min(height - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 && x + y >= 11 && x + y <= width + height - 11;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const paint = inside(x + .5, y + .5) ? 249 : 204;
    data.set([paint, paint, paint, 255], (y * width + x) * 4);
  }
  const result = spriteSurface({ width, height, data });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    assert.equal(result.data[(y * width + x) * 4 + 3], inside(x + .5, y + .5) ? 255 : 0);
  }
});

test("equal translated cards reuse a mask without resampling their portrait pixels", async () => {
  const previous = globalThis.document, fake = maskCanvas(); globalThis.document = fake.document;
  try {
    let loads = 0;
    const apply = async (shift) => {
      const source = { style: { ...style(shift, 10, 280.13, 317.84), backgroundImage: 'url("shared-mask")' } };
      const target = { style: { ...style(shift + 10, 20, 262.1, 295.7), backgroundImage: 'url("full-quality-portrait")' } };
      await maskWithSprite(source, target, async () => { loads++; return { naturalWidth: 560, naturalHeight: 636 }; }, { surface: true });
      assert.equal(target.style.backgroundImage, 'url("full-quality-portrait")');
      assert.equal(target.style.maskSize, "100% 100%");
      return target.style.maskImage;
    };
    assert.equal(await apply(0), await apply(456)); assert.equal(loads, 1);
    const output = fake.canvases.at(-1);
    assert.equal(output.width, Math.ceil(262.1 * 2)); assert.equal(output.height, Math.ceil(295.7 * 2));
    assert.deepEqual(output.transform, [1, 0, 0, 1, -10, -10]);
  } finally { globalThis.document = previous; }
});

test("button masks wait for deferred body and decoration painting but not generated thumbnails", async () => {
  const previous = globalThis.document, fake = maskCanvas(); globalThis.document = fake.document;
  try {
    const bodyPaint = deferred(), decorationPaint = deferred(), thumbnail = deferred(), imageLoad = deferred();
    const body = { style: style(0, 0, 193.59, 72.65, "skewX(-10deg)") };
    const pattern = { style: style(34.23, 5.5, 158.27, 88.22, "scale(-1, -1)") };
    const view = { nodes: new Map([
      ["Body", { node: { widgets: [{ sprite: "Common_Btn_BG", incline: 10 }] }, els: [body] }],
      ["Body/Pattern", { node: { widgets: [{ sprite: "Common_Btn_Normal_B_S_Pt", flip: 3 }] }, els: [pattern] }],
    ]), images: [bodyPaint.promise, decorationPaint.promise], thumbnails: [thumbnail.promise] };
    let loaded = false, done = false;
    const pending = clipButtonPatterns(view, { load: (url) => { loaded = true; assert.equal(url, "deferred-body"); return imageLoad.promise; } }).then(() => { done = true; });
    assert.match(pattern.style.clipPath, /^polygon/); await flush(); assert.equal(loaded, false);
    body.style.backgroundImage = 'url("deferred-body")'; bodyPaint.resolve(); await flush(); assert.equal(loaded, false);
    decorationPaint.resolve(); await flush(); assert.equal(loaded, true); assert.equal(done, false);
    imageLoad.resolve({ naturalWidth: 388, naturalHeight: 146 }); await pending;
    assert.match(pattern.style.maskImage, /^url\("data:image\/png/);
    assert.equal(done, true, "an unresolved thumbnail is not a clipping barrier");
    const before = pattern.style.maskImage; await clipButtonPatterns(view); assert.equal(pattern.style.maskImage, before);
  } finally { globalThis.document = previous; }
});
