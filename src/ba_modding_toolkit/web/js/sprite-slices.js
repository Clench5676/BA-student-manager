// NGUI's atlas borders describe nine-slice cuts, not the painted stroke width.
// Rendering and content-window geometry share these exact source and raster cuts.
export function spriteBorders(meta) {
  const b = [meta.borderTop, meta.borderRight, meta.borderBottom, meta.borderLeft].map((v) => v || 0);
  for (const [i, j, size] of [[0, 2, meta.height], [1, 3, meta.width]]) {
    if (b[i] + b[j] >= size) {
      const f = (size - 1) / (b[i] + b[j]); b[i] = Math.floor(b[i] * f); b[j] = Math.floor(b[j] * f);
    }
  }
  return b;
}

export function sliceAxis(source, before, after, extent, borderScale, density = 2) {
  const size = Math.max(1, Math.round(extent * density));
  const [beforeScale, afterScale] = Array.isArray(borderScale) ? borderScale : [borderScale, borderScale];
  let a = before * beforeScale * density, b = after * afterScale * density;
  if (a + b > size) { const f = size / (a + b); a *= f; b *= f; }
  a = Math.round(a); b = Math.round(b);
  return { size, extent, spans: [[0, before, 0, a], [before, source - after, a, size - b],
    [source - after, source, size - b, size]] };
}

export function slicePoint(value, axis) {
  const span = axis.spans.find(([a, b]) => b > a && value >= a && value <= b);
  if (!span) throw new Error("Sprite content lies outside its atlas rectangle");
  const [a, b, c, d] = span;
  return (c + (value - a) / (b - a) * (d - c)) * axis.extent / axis.size;
}
