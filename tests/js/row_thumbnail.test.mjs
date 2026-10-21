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

test("measured rounded corners cover the opening inside the outer outline at every scale and pivot", () => {
  const pixels = fixture(), outline = frameOutline(pixels), [l, t, r, b] = outline.insets;
  // Every source raster strip occupied by the bounding window fits the frame's
  // filled outer silhouette. Monotone slice maps and affine shear preserve this
  // containment for every point, including the measured corner transitions.
  for (let y = t; y < pixels.height - b; y++) {
    const solid = Array.from({ length: pixels.width }, (_, x) => x).filter((x) => pixels.data[(y * pixels.width + x) * 4 + 3] === 255);
    assert.ok(solid[0] <= l && solid.at(-1) + 1 >= pixels.width - r);
  }
  for (const [x, y] of pixels.opening) assert.ok(x >= l && x <= pixels.width - r && y >= t && y <= pixels.height - b);
  for (const scale of [.34, .54, .68, .873, 1.25]) for (let pivot = 0; pivot < 9; pivot++) {
    for (const incline of [-12, 0, 10, 17]) for (const flip of [0, 1, 2, 3]) for (const [sx, sy] of [[1, 1], [.7, 1.2], [-.8, -.65]]) {
      const w = { w_: 240, h_: 220, type: 1, pivot, incline, flip, radius: 70 };
      const { win, points, source } = geometry(w, { x: 17, y: -23, sx, sy, scale }, outline);
      assert.equal(win.radius, 0); assert.ok(win.clipPolygon.length > 4);
      const coverWidth = win.width + Math.abs(Math.tan(incline * Math.PI / 180)) * win.height;
      for (const [x, y] of points) {
        assert.ok(Math.abs(x - win.x) <= coverWidth / 2 + 1e-7 && Math.abs(y + win.y) <= win.height / 2 + 1e-7,
          "the centred upright cover image reaches every clipped corner");
      }
      const sourcePoints = points.map(source);
      near(Math.min(...sourcePoints.map(([x]) => x)), l); near(Math.max(...sourcePoints.map(([x]) => x)), pixels.width - r);
      near(Math.min(...sourcePoints.map(([, y]) => y)), t); near(Math.max(...sourcePoints.map(([, y]) => y)), pixels.height - b);
      // The straight middle portion keeps the exact prefab incline; the
      // measured corners turn inward rather than reaching the bounding box.
      const middle = sourcePoints.map((p, i) => ({ p, i })).filter(({ p }) => Math.abs(p[0] - l) < 1e-6 && p[1] > 20 && p[1] < 50);
      assert.ok(middle.length > 2);
      const a = points[middle[0].i], c = points[middle.at(-1).i];
      near((c[0] - a[0]) / (c[1] - a[1]), -Math.tan(incline * Math.PI / 180));
      for (const q of sourcePoints) assert.ok(q[0] >= l - 1e-7 && q[0] <= pixels.width - r + 1e-7 && q[1] >= t - 1e-7 && q[1] <= pixels.height - b + 1e-7);

    }
  }
});

test("transparent or solid sprites cannot silently supply an invented inner window", () => {
  assert.throws(() => frameOutline({ width: 10, height: 10, data: new Uint8Array(400) }), /no painted outline/);
  const data = new Uint8ClampedArray(400).fill(255);
  assert.throws(() => frameOutline({ width: 10, height: 10, data }), /no enclosed inner area/);
  assert.throws(() => innerFrame({ w_: 10, h_: 10 }, {}, null), /not ready/);
});

test("the clip follows the measured inner corner contour rather than a sharp box or atlas-cut radius", () => {
  const pixels = fixture(), outline = frameOutline(pixels);
  assert.ok(outline.points?.length > 4, "retain the painted corner contour");
  const win = innerFrame({ w_: 240, h_: 220, type: 1, incline: 10 }, meta, outline, { scale: .68 });
  assert.ok(win.clipPolygon.length > 4);
  assert.ok(!win.clipPolygon.some(([x, y]) => x === 0 && y === 0), "the outer box corner is excluded");
});

test("shared nine-slice mapping emits exactly the same raster rectangles as the pre-refactor renderer", () => {
  const reference = (meta, width, height, bs) => {
    const b = [meta.borderTop, meta.borderRight, meta.borderBottom, meta.borderLeft];
    for (const [i, j, size] of [[0, 2, meta.height], [1, 3, meta.width]]) if (b[i] + b[j] >= size) {
      const f = (size - 1) / (b[i] + b[j]); b[i] = Math.floor(b[i] * f); b[j] = Math.floor(b[j] * f);
    }
    const W = Math.max(1, Math.round(width * 2)), H = Math.max(1, Math.round(height * 2));
    let dl = b[3] * bs * 2, dr = b[1] * bs * 2, dt = b[0] * bs * 2, db = b[2] * bs * 2;
    if (dl + dr > W) { const f = W / (dl + dr); dl *= f; dr *= f; }
    if (dt + db > H) { const f = H / (dt + db); dt *= f; db *= f; }
    [dl, dr, dt, db] = [dl, dr, dt, db].map(Math.round);
    return { b, W, H, xs: [[0, b[3], 0, dl], [b[3], meta.width - b[1], dl, W - dr], [meta.width - b[1], meta.width, W - dr, W]],
      ys: [[0, b[0], 0, dt], [b[0], meta.height - b[2], dt, H - db], [meta.height - b[2], meta.height, H - db, H]] };
  };
  for (const meta of [{ width: 138, height: 87, borderLeft: 69, borderRight: 69, borderTop: 42, borderBottom: 42 },
    { width: 55, height: 55, borderLeft: 30, borderRight: 30, borderTop: 30, borderBottom: 30 },
    { width: 200, height: 100, borderLeft: 13, borderRight: 7, borderTop: 11, borderBottom: 3 }]) {
    for (const width of [22.3, 60, 163.2, 240, 399.91]) for (const height of [19.54, 149.6, 220.12]) for (const bs of [.2, .68, 1, 1.25]) {
      const old = reference(meta, width, height, bs), b = spriteBorders(meta);
      const x = sliceAxis(meta.width, b[3], b[1], width, bs), y = sliceAxis(meta.height, b[0], b[2], height, bs);
      assert.deepEqual(b, old.b); assert.equal(x.size, old.W); assert.equal(y.size, old.H);
      assert.deepEqual(x.spans, old.xs); assert.deepEqual(y.spans, old.ys);
    }
  }
});
