import { spriteBorders, sliceAxis, slicePoint } from "./sprite-slices.js";

// The inner edge is where the near-opaque stroke ends, excluding its glow.
// Compressed atlas blocks vary slightly below peak alpha even inside the stroke;
// exact equality mistakes those blocks for holes. A centre seam can interrupt
// the top/bottom stripe; then the repeated straight-edge extent wins.
export function frameOutline({ width, height, data }) {
  let peak = 0;
  for (let i = 3; i < data.length; i += 4) peak = Math.max(peak, data[i]);
  if (!peak) throw new Error("Selection frame has no painted outline");
  const solid = (x, y) => data[(y * width + x) * 4 + 3] >= peak * 15 / 16;
  const band = (size, at) => {
    const middle = Math.floor(size / 2);
    let left = middle - 1, right = middle;
    while (left >= 0 && !at(left)) left--;
    while (right < size && !at(right)) right++;
    return left >= 0 && right < size && right > left + 1 ? [left + 1, right] : null;
  };
  const edge = (size, count, sample) => {
    const centre = band(size, (i) => sample(i, Math.floor(count / 2)));
    if (centre) return centre;
    const modes = new Map();
    for (let j = 0; j < count; j++) {
      const pair = band(size, (i) => sample(i, j));
      if (!pair) continue;
      const key = pair.join(","), current = modes.get(key) || { pair, n: 0 };
      current.n++; modes.set(key, current);
    }
    const best = [...modes.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) throw new Error("Selection frame has no enclosed inner area");
    return best.pair;
  };
  const [left, right] = edge(width, height, (x, y) => solid(x, y));
  const [top, bottom] = edge(height, width, (y, x) => solid(x, y));
  const leftEdge = [], rightEdge = [];
  for (let y = top; y < bottom; y++) {
    let a = 0, b = width - 1;
    while (a < width && !solid(a, y)) a++;
    while (b >= 0 && !solid(b, y)) b--;
    const pair = band(width, (x) => solid(x, y));
    if (!pair) throw new Error("Selection frame has an interrupted inner contour");
    const innerLeft = Math.max(left, pair[0]), innerRight = Math.min(right, pair[1]);
    if (innerLeft < a || innerRight > b + 1 || innerLeft >= innerRight) throw new Error("Selection frame has an invalid inner contour");
    leftEdge.push([innerLeft, y + .5]); rightEdge.push([innerRight, y + .5]);
  }
  const points = [[leftEdge[0][0], top], ...leftEdge, [leftEdge.at(-1)[0], bottom],
    [rightEdge.at(-1)[0], bottom], ...rightEdge.reverse(), [rightEdge.at(-1)[0], top]];
  return { width, height, insets: [left, top, width - right, height - bottom], points };
}

const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => { const n = Math.hypot(...v); return n ? v.map((c) => c / n) : [0, 1]; };
const distance = (a, b) => Math.hypot(...subtract(a, b));
const bezier = (p, t) => {
  const s = 1 - t, b = [s ** 3, 3 * t * s * s, 3 * t * t * s, t ** 3];
  return [0, 1].map((axis) => p.reduce((sum, point, i) => sum + point[axis] * b[i], 0));
};

// Least-squares cubic reconstruction of the raster contour. Shared tangents at
// subdivisions remove the pixel staircase without imposing a different radius
// or replacing this frame's chamfered corners with a generic rounded box.
function cornerCurve(points, start, end, tolerance, density, bounds) {
  const fit = (p, ta, tb) => {
    const a = p[0], b = p.at(-1), u = [0];
    for (let i = 1; i < p.length; i++) u.push(u.at(-1) + distance(p[i - 1], p[i]));
    const length = u.at(-1);
    if (!length) return [a];
    for (let i = 1; i < u.length; i++) u[i] /= length;
    let aa = 0, ab = 0, bb = 0, av = 0, bv = 0;
    for (let i = 0; i < p.length; i++) {
      const t = u[i], s = 1 - t, b1 = 3 * t * s * s, b2 = 3 * t * t * s;
      const va = ta.map((c) => c * b1), vb = tb.map((c) => -c * b2);
      const delta = p[i].map((c, axis) => c - a[axis] * (s ** 3 + b1) - b[axis] * (t ** 3 + b2));
      aa += dot(va, va); ab += dot(va, vb); bb += dot(vb, vb); av += dot(va, delta); bv += dot(vb, delta);
    }
    const determinant = aa * bb - ab * ab;
    let da = (av * bb - bv * ab) / determinant, db = (bv * aa - av * ab) / determinant;
    if (!Number.isFinite(da + db) || da > length || db > length) da = db = distance(a, b) / 3;
    // A nearly straight chamfer may solve to a negative handle because of
    // raster quantization. Clamp it; a large fallback handle invents a bulge.
    da = Math.max(distance(a, b) * .001, da); db = Math.max(distance(a, b) * .001, db);
    const clamp = (p) => p.map((c, axis) => Math.max(bounds[axis], Math.min(bounds[axis + 2], c)));
    const curve = [a, clamp(a.map((c, axis) => c + ta[axis] * da)), clamp(b.map((c, axis) => c - tb[axis] * db)), b];
    let error = 0, split = 1;
    for (let i = 1; i < p.length - 1; i++) {
      const d = distance(bezier(curve, u[i]), p[i]);
      if (d > error) { error = d; split = i; }
    }
    if (error > tolerance && p.length > 2) {
      // Estimate the tangent across several raster samples so a two-pixel
      // plateau cannot turn into a straight step inside an otherwise curved join.
      const at = points.indexOf(p[split]);
      const tangent = unit(subtract(points[Math.min(points.length - 1, at + 3)], points[Math.max(0, at - 3)]));
      return [...fit(p.slice(0, split + 1), ta, tangent).slice(0, -1), ...fit(p.slice(split), tangent, tb)];
    }
    const perimeter = distance(curve[0], curve[1]) + distance(curve[1], curve[2]) + distance(curve[2], curve[3]);
    const steps = Math.max(8, Math.ceil(perimeter * density / .25));
    return Array.from({ length: steps + 1 }, (_, i) => bezier(curve, i / steps));
  };
  return fit(points, start, end);
}

function smoothContour(points, bounds, scale) {
  const [l, t, r, b] = bounds, half = points.length / 2;
  const left = points.slice(1, half - 1), right = points.slice(half + 1, -1).reverse();
  const straight = (edge, x) => {
    let best = [0, 0], begin = 0;
    for (let i = 0; i <= edge.length; i++) {
      if (i < edge.length && Math.abs(edge[i][0] - x) < 1e-7) continue;
      if (i - begin > best[1] - best[0]) best = [begin, i - 1];
      begin = i + 1;
    }
    return best;
  };
  const [la, lb] = straight(left, l), [ra, rb] = straight(right, r);
  const fit = (p, a, b) => cornerCurve(p, a, b, Math.min(1.25, .7 / scale), Math.max(1, scale), bounds);
  const side = (edge, a, b) => [edge[a], edge[Math.floor((a + b) / 2)], edge[b]];
  return [
    ...fit([[left[0][0], t], ...left.slice(0, la + 1)], [-1, 0], [0, 1]),
    ...side(left, la, lb).slice(1),
    ...fit([...left.slice(lb), [left.at(-1)[0], b]], [0, 1], [1, 0]).slice(1),
    ...fit([[right.at(-1)[0], b], ...right.slice(rb).reverse()], [1, 0], [0, -1]),
    ...side(right, ra, rb).reverse().slice(1),
    ...fit([...right.slice(0, ra + 1).reverse(), [right[0][0], t]], [0, -1], [-1, 0]).slice(1),
  ].filter((p, i, all) => !i || distance(p, all[i - 1]) > 1e-8);
}

// Coordinates are in the same flattened NGUI space as the frame widget. Pixel
// cuts use the frame's actual rendering scale, including nine-slice rounding.
export function innerFrame(w, meta, outline, { x = 0, y = 0, sx = 1, sy = 1, scale = 1 } = {}) {
  if (!outline) throw new Error("Selection frame outline is not ready");
  const width = w.w_ * Math.abs(sx), height = w.h_ * Math.abs(sy);
  const centreX = x + (0.5 - (w.pivot ?? 4) % 3 / 2) * w.w_ * sx;
  const centreY = y + (Math.floor((w.pivot ?? 4) / 3) / 2 - 0.5) * w.h_ * sy;
  const b = spriteBorders({ ...meta, width: outline.width, height: outline.height });
  const sliced = w.type === 1 && b.some(Boolean), bs = Math.min(Math.abs(sx), Math.abs(sy)) * scale;
  const ax = sliced ? sliceAxis(outline.width, b[3], b[1], width * scale, bs) : null;
  const ay = sliced ? sliceAxis(outline.height, b[0], b[2], height * scale, bs) : null;
  const mx = (v) => ax ? slicePoint(v, ax) / scale : v / outline.width * width;
  const my = (v) => ay ? slicePoint(v, ay) / scale : v / outline.height * height;
  let [l, t, r, bo] = outline.insets;
  r = mx(outline.width - r); bo = my(outline.height - bo); l = mx(l); t = my(t);
  const flipX = (w.flip === 1 || w.flip === 3) !== (sx < 0), flipY = (w.flip >= 2) !== (sy < 0);
  if (flipX) [l, r] = [width - r, width - l];
  if (flipY) [t, bo] = [height - bo, height - t];
  const tangent = Math.tan((w.incline || 0) * Math.PI / 180);
  const dx = (l + r - width) / 2, dy = (t + bo - height) / 2;
  const contour = smoothContour(outline.points.map(([u, v]) => [mx(u), my(v)]),
    [mx(outline.insets[0]), my(outline.insets[1]), mx(outline.width - outline.insets[2]), my(outline.height - outline.insets[3])], scale);
  const clipPolygon = contour.map(([px, py]) => {
    if (flipX) px = width - px;
    if (flipY) py = height - py;
    return [(px - l) / (r - l), (py - t) / (bo - t)];
  });
  return { x: centreX + dx - tangent * dy, y: centreY - dy, width: r - l, height: bo - t,
    incline: w.incline || 0, radius: 0, clipPolygon };
}
