// PNG export preserves the atlas texels. SpinePlayer ignores page.pma and takes one alpha option for the whole
// skeleton instead. Keep its vertices straight and select PMA per texture, including mixed-page atlases.
export function atlasAlpha(player) {
  const atlas = player.assetManager?.get?.(player.config?.atlas);
  return new Map((atlas?.pages || []).map((page) => [page.texture, !!page.pma]));
}

export function applyAtlasAlpha(player) {
  const pages = atlasAlpha(player);
  if (![...pages.values()].some(Boolean)) return false;
  const renderer = player.sceneRenderer, sr = renderer?.skeletonRenderer, batcher = renderer?.batcher;
  if (!sr || !batcher) return false;
  const draw = sr.draw, triangles = batcher.draw;
  let mode = 0;
  // Capture the final blend setter at draw time: linear.js and skeleton-materials.js install theirs after loading.
  sr.draw = function (b, ...args) {
    const blend = b.setBlendMode, pma = this.premultipliedAlpha;
    this.premultipliedAlpha = false;
    b.setBlendMode = function (next, alpha) { mode = next; return blend.call(this, next, alpha); };
    try { return draw.call(this, b, ...args); }
    finally { b.setBlendMode = blend; this.premultipliedAlpha = pma; }
  };
  batcher.draw = function (texture, vertices, indices) {
    // Ported materials already apply their own alpha and blend rules. This hook is below their draw hook.
    if (this.shader !== renderer.batcherShader) return triangles.call(this, texture, vertices, indices);
    const pma = pages.get(texture) || false;
    this.setBlendMode(mode, pma);
    if (pma) {
      vertices = vertices.slice();
      const stride = sr.twoColorTint ? 12 : 8;
      for (let i = 0; i < vertices.length; i += stride) {
        const a = vertices[i + 5];
        for (let c = 2; c < 5; c++) vertices[i + c] *= a;
        if (sr.twoColorTint) {
          for (let c = 8; c < 11; c++) vertices[i + c] *= a;
          vertices[i + 11] = 1;
        }
      }
    }
    return triangles.call(this, texture, vertices, indices);
  };
  return true;
}
