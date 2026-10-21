import { spriteBorders, sliceAxis, slicePoint } from "./sprite-slices.js";

// The inner edge of a frame is where its fully painted stroke ends. Ignore its
// translucent glow. A centre seam can interrupt the top/bottom stripe; in that
// case the repeated straight-edge extent wins over the corner extents.
export function frameOutline({ width, height, data }) {
  let peak = 0;
  for (let i = 3; i < data.length; i += 4) peak = Math.max(peak, data[i]);
  if (!peak) throw new Error("Selection frame has no painted outline");
  const solid = (x, y) => data[(y * width + x) * 4 + 3] === peak;
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
  // The four sharp inner corners must sit beneath the frame's own border.
  // Checking every raster strip also catches a narrow or nonconvex outer edge.
  for (let y = top; y < bottom; y++) {
    let a = 0, b = width - 1;
    while (a < width && !solid(a, y)) a++;
    while (b >= 0 && !solid(b, y)) b--;
    if (a > left || b + 1 < right) throw new Error("Selection frame cannot contain a sharp inner window");
  }
  return { width, height, insets: [left, top, width - right, height - bottom] };
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
  return { x: centreX + dx - tangent * dy, y: centreY - dy, width: r - l, height: bo - t,
    incline: w.incline || 0, radius: 0, clipPolygon: [[0, 0], [1, 0], [1, 1], [0, 1]] };
}
