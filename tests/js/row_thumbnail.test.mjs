import assert from "node:assert/strict";
import { test } from "node:test";
import { frameOutline, innerFrame } from "../../src/ba_modding_toolkit/web/js/row-thumbnail.js";
import { sliceAxis, spriteBorders } from "../../src/ba_modding_toolkit/web/js/sprite-slices.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function fixture({ insets = [7, 9, 10, 6], seam = false, radius = 14 } = {}) {
  const width = 80, height = 70, [l, t, r, b] = insets;
  const data = new Uint8ClampedArray(width * height * 4), opening = [];
  const rounded = (x, y, left, top, right, bottom, rad) => {
    const cx = Math.max(left + rad, Math.min(right - rad, x)), cy = Math.max(top + rad, Math.min(bottom - rad, y));
    return x >= left && y >= top && x <= right && y <= bottom && (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const outer = rounded(x + .5, y + .5, 0, 0, width, height, radius);
    const inner = rounded(x + .5, y + .5, l, t, width - r, height - b, radius / 2);
    if (inner) opening.push([x + .5, y + .5]);
    const gap = seam && x >= width / 2 - 2 && x < width / 2 + 2;
    data[(y * width + x) * 4 + 3] = outer && !inner && !gap ? 255 : 17;
  }
  return { width, height, data, opening, insets };
}
const meta = { width: 80, height: 70, borderTop: 24, borderBottom: 24, borderLeft: 28, borderRight: 28 };

for (const seam of [false, true]) test(`measure the painted inner edge independently of nine-slice cuts${seam ? " with a centre seam" : ""}`, () => {
  const pixels = fixture({ seam }), outline = frameOutline(pixels);
  assert.deepEqual(outline.insets, pixels.insets);
  assert.notDeepEqual(outline.insets, [meta.borderLeft, meta.borderTop, meta.borderRight, meta.borderBottom]);
});

// Inverse of the renderer's raster cut mapping, independently interpolated.
function unslice(value, axis) {
  const pixel = value / axis.extent * axis.size;
  const span = axis.spans.find(([, , a, b]) => b > a && pixel >= a - 1e-7 && pixel <= b + 1e-7);
  assert.ok(span); const [a, b, c, d] = span;
  return a + (pixel - c) / (d - c) * (b - a);
}
function geometry(w, transform, outline) {
  const win = innerFrame(w, meta, outline, transform), { x, y, sx, sy, scale } = transform;
  const width = w.w_ * Math.abs(sx), height = w.h_ * Math.abs(sy), tangent = Math.tan(w.incline * Math.PI / 180);
  const cx = x + (.5 - w.pivot % 3 / 2) * w.w_ * sx, cy = y + (Math.floor(w.pivot / 3) / 2 - .5) * w.h_ * sy;
  const b = spriteBorders(meta), borderScale = Math.min(Math.abs(sx), Math.abs(sy)) * scale;
  const ax = sliceAxis(meta.width, b[3], b[1], width * scale, borderScale);
  const ay = sliceAxis(meta.height, b[0], b[2], height * scale, borderScale);
  const points = win.clipPolygon.map(([u, v]) => [win.x + (u - .5) * win.width - tangent * (v - .5) * win.height,
    -win.y + (v - .5) * win.height]);
  const source = (point) => {
    let tx = point[0] - cx + tangent * (point[1] + cy) + width / 2;
    let ty = point[1] + cy + height / 2;
    if ((w.flip === 1 || w.flip === 3) !== (sx < 0)) tx = width - tx;
    if ((w.flip >= 2) !== (sy < 0)) ty = height - ty;
    return [unslice(tx * scale, ax), unslice(ty * scale, ay)];
  };
  return { win, points, source };
}

test("four sharp corners exactly cover the inner area and stay within the outer outline at all scales and pivots", () => {
  const pixels = fixture(), outline = frameOutline(pixels), [l, t, r, b] = outline.insets;
  // Every source raster strip occupied by the sharp window fits the frame's
  // filled outer silhouette. Monotone slice maps and affine shear preserve this
  // containment for every point, including the rounded frame's four corners.
  for (let y = t; y < pixels.height - b; y++) {
    const solid = Array.from({ length: pixels.width }, (_, x) => x).filter((x) => pixels.data[(y * pixels.width + x) * 4 + 3] === 255);
    assert.ok(solid[0] <= l && solid.at(-1) + 1 >= pixels.width - r);
  }
  for (const [x, y] of pixels.opening) assert.ok(x >= l && x <= pixels.width - r && y >= t && y <= pixels.height - b);
  for (const scale of [.34, .54, .68, .873, 1.25]) for (let pivot = 0; pivot < 9; pivot++) {
    for (const incline of [-12, 0, 10, 17]) for (const flip of [0, 1, 2, 3]) for (const [sx, sy] of [[1, 1], [.7, 1.2], [-.8, -.65]]) {
      const w = { w_: 240, h_: 220, type: 1, pivot, incline, flip, radius: 70 };
      const { win, points, source } = geometry(w, { x: 17, y: -23, sx, sy, scale }, outline);
      assert.equal(win.radius, 0); assert.equal(win.clipPolygon.length, 4);
      assert.deepEqual(win.clipPolygon, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const coverWidth = win.width + Math.abs(Math.tan(incline * Math.PI / 180)) * win.height;
      for (const [x, y] of points) {
        assert.ok(Math.abs(x - win.x) <= coverWidth / 2 + 1e-7 && Math.abs(y + win.y) <= win.height / 2 + 1e-7,
          "the centred upright cover image reaches every clipped corner");
      }
      const sourcePoints = points.map(source);
      near(Math.min(...sourcePoints.map(([x]) => x)), l); near(Math.max(...sourcePoints.map(([x]) => x)), pixels.width - r);
      near(Math.min(...sourcePoints.map(([, y]) => y)), t); near(Math.max(...sourcePoints.map(([, y]) => y)), pixels.height - b);
      // The two sloping sides are parallel to the prefab frame, with no curve.
      for (const [a, c] of [[0, 3], [1, 2]]) near((points[c][0] - points[a][0]) / (points[c][1] - points[a][1]), -Math.tan(incline * Math.PI / 180));
      for (const [a, c] of [[0, 1], [1, 2], [2, 3], [3, 0]]) for (let i = 0; i <= 16; i++) {
        const f = i / 16, q = source([points[a][0] * (1 - f) + points[c][0] * f, points[a][1] * (1 - f) + points[c][1] * f]);
        assert.ok(q[0] >= l - 1e-7 && q[0] <= pixels.width - r + 1e-7 && q[1] >= t - 1e-7 && q[1] <= pixels.height - b + 1e-7);
      }
    }
  }
});

test("transparent or solid sprites cannot silently supply an invented inner window", () => {
  assert.throws(() => frameOutline({ width: 10, height: 10, data: new Uint8Array(400) }), /no painted outline/);
  const data = new Uint8ClampedArray(400).fill(255);
  assert.throws(() => frameOutline({ width: 10, height: 10, data }), /no enclosed inner area/);
  assert.throws(() => innerFrame({ w_: 10, h_: 10 }, {}, null), /not ready/);
});
