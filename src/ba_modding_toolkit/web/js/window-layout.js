// UICharacterCollection top bar; all native rectangles are viewport CSS pixels.
import { barCentre } from "./top-bar-layout.js";

export function headerGeometry(width, height, nativeBottom = 0, immersive = false) {
  const scale = Math.min(width / 1920, height / 1080);
  const rowHeight = Math.max(64 * scale, 44, nativeBottom + 4);
  const extra = immersive ? 0 : Math.max(0, rowHeight - 64 * scale);
  return { scale, rowHeight, centre: barCentre(undefined, rowHeight), extra,
    contentScale: Math.min(width / 1920, (height - extra) / 1080) };
}

// Detail portrait/L2D share fullscreen; photography also owns an independent
// root flag while preparing or switching those two renderers. Hall is separate.
export function isImmersive(stageClasses, rootClasses) {
  const stage = new Set(stageClasses), root = new Set(rootClasses);
  return stage.has('fullscreen') || stage.has('hall-fullscreen') || root.has('photo-active');
}

export function dragRegions({ width, height, bounds, platform, immersive = false, blocked = false, exclusions = [] }) {
  if (blocked) return [];
  let background = { left: 0, top: 0, right: width, bottom: height };
  if (immersive) {
    if (!bounds) return [];
    // A small strip at the top beside the real controls leaves scene controls
    // below it free. Subtract their hit/focus bounds as well during transitions.
    const left = platform === 'darwin' ? bounds.right + 8 : bounds.left - 8 - 64;
    background = { left: Math.max(0, left), top: 0, right: Math.min(width, left + 64), bottom: Math.min(height, 12) };
    if (background.right <= background.left) return [];
  }
  return subtractRegions(background, [...exclusions, ...(bounds ? [expandRect(bounds, 8)] : [])]);
}

export function rowLayout({ scale, nativeLeft = 0, rightStart, titleWidth, modsWidth,
  captionWidth, compact = false, modsVisible = true, hall = false }) {
  const shift = Math.max(0, nativeLeft + (nativeLeft ? 8 : 0) - 38 * scale);
  const titleLeft = (hall ? 38 : 160) * scale + shift;
  const available = Math.max(0, rightStart - 64 - titleLeft);
  const gap = modsVisible ? 32 * scale : 0;
  const full = titleWidth + (modsVisible ? modsWidth + gap : 0);
  const hideCaption = modsVisible && (compact ? full + 16 > available : full > available);
  const mods = modsVisible ? modsWidth - (hideCaption ? captionWidth : 0) : 0;
  return { shift, compact: hideCaption, titleLeft,
    titleWidth: Math.max(0, Math.min(titleWidth, available - mods - gap)), modsWidth: mods,
    dragWidth: 64 };
}

export function subtractRegions(background, exclusions) {
  let regions = [background];
  for (const cut of exclusions) {
    regions = regions.flatMap((r) => {
      const l = Math.max(r.left, cut.left), t = Math.max(r.top, cut.top);
      const x = Math.min(r.right, cut.right), y = Math.min(r.bottom, cut.bottom);
      if (l >= x || t >= y) return [r];
      return [{ left: r.left, top: r.top, right: r.right, bottom: t },
        { left: r.left, top: y, right: r.right, bottom: r.bottom },
        { left: r.left, top: t, right: l, bottom: y },
        { left: x, top: t, right: r.right, bottom: y }].filter((b) => b.right > b.left && b.bottom > b.top);
    });
  }
  return regions;
}

export const expandRect = (r, gap = 4) => ({ left: r.left - gap, top: r.top - gap, right: r.right + gap, bottom: r.bottom + gap });
