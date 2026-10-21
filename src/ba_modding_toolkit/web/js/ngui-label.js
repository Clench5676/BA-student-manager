// NGUI UILabel effects, in scaled CSS pixels. NGUI's effect distance uses screen-down y.
export function labelEffect(widget, scale = 1) {
  const { effect = 0, effectColor, effectDistance } = widget;
  if (!effect || !effectColor || !effectDistance) return "";
  const [hex, alpha = "1"] = effectColor.split("/");
  const rgb = hex.match(/[a-f\d]{2}/gi)?.map((v) => parseInt(v, 16));
  if (!rgb || rgb.length !== 3) return "";
  const color = `rgba(${rgb.join(", ")}, ${Number(alpha)})`;
  const [x, y] = effectDistance.map((v) => v * scale);
  const offsets = effect === 1 ? [[x, y]] : [[x, y], [-x, -y], [x, -y], [-x, y]];
  if (effect === 3) offsets.push([x, 0], [-x, 0], [0, y], [0, -y]);
  return offsets.map(([dx, dy]) => `${dx}px ${dy}px 0 ${color}`).join(", ");
}

// Distance from the bottom of a bottom-pivot label to its font baseline in ngui.js.
export function labelBaselineInset(text, fontSize) {
  const latin = !/[\u0e00-\u0e7f\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text);
  return fontSize * (latin ? 1.12 : 1) * (0.29 + (1.15 - 1.45) / 2 + (latin ? 0.085 : 0.06) * 2);
}

// A CSS line box is shorter than this font's ink. Ellipsis clips both axes, so
// give its canvas room for descenders, combining marks and the prefab's effect.
export function labelClipPadding(widget, fs, metrics = {}) {
  const ascent = Math.max(metrics.actualBoundingBoxAscent || 0, metrics.fontBoundingBoxAscent || 0, fs * 1.16);
  const descent = Math.max(metrics.actualBoundingBoxDescent || 0, metrics.fontBoundingBoxDescent || 0, fs * 0.29);
  const baseline = (fs * 1.15 + ascent - descent) / 2;
  const [dx, dy] = widget.effect ? (widget.effectDistance || [0, 0]).map(Math.abs) : [0, 0];
  return { top: Math.max(0, ascent - baseline) + dy, bottom: Math.max(0, descent - (fs * 1.15 - baseline)) + dy,
    left: dx, right: dx };
}

export function alphaBounds({ width, height, data }) {
  let top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]) {
    top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  return bottom ? { height, top, bottom } : null;
}

function labels(tree, path = "", x = 0, y = 0, sx = 1, sy = 1, result = []) {
  if (!tree || tree.active === false) return result;
  x += (tree.pos?.[0] || 0) * sx; y += (tree.pos?.[1] || 0) * sy;
  sx *= tree.scale?.[0] ?? 1; sy *= tree.scale?.[1] ?? 1;
  path += `/${tree.name}`;
  for (const w of tree.widgets || []) if ("text" in w || "sprite" in w) result.push({ w, path, x, y, sx, sy });
  for (const child of tree.children || []) labels(child, path, x, y, sx, sy, result);
  return result;
}

// Both labels share the repeater's screen-bottom anchor, including the text renderer's baseline lift.
export function loadingLetterSprites(repeater) {
  return labels(repeater).filter((item) => /\/Loading\//i.test(item.path) && item.w.sprite && !/\/g$/i.test(item.path));
}

export function loadingLabel(repeater, loading, text, scale, ink = {}) {
  const candidates = labels(repeater);
  const anchor = candidates.find((item) => "text" in item.w && /\/Loading\//i.test(item.path)) || candidates.find((item) => "text" in item.w);
  const source = anchor?.w.effect ? anchor : labels(loading).find((item) => item.w.effect && item.w.effectColor && item.w.effectDistance);
  if (!source) return null;
  const letters = loadingLetterSprites(repeater).filter(({ w }) => ink[w.sprite]);
  if (!anchor && !letters.length) return null;
  const w = structuredClone(source.w), fs = anchor ? anchor.w.fontSize * anchor.sy : source.w.fontSize * source.sy;
  const bottom = anchor && 1080 - (720 + anchor.y) * scale + (1 - Math.floor((anchor.w.pivot ?? 4) / 3) / 2) * anchor.w.h_ * anchor.sy * scale;
  const baseline = anchor ? bottom - labelBaselineInset(anchor.w.text, fs) * scale : Math.max(...letters.map(({ w, y, sy }) => {
    const rect = ink[w.sprite];
    // upgrade() shifts the 1440-high prefab to the stage bottom. The PNG is
    // the atlas's cropped rectangle, stretched to the prefab widget by NGUI.
    return 1080 - (720 + y) * scale + (rect.bottom / rect.height - Math.floor((w.pivot ?? 4) / 3) / 2) * w.h_ * sy * scale;
  }));
  Object.assign(w, { text, fontSize: fs, w_: 1000 / scale, h_: fs * 1.4, pivot: 6, align: 1, ellipsis: true });
  return { name: "Progress", active: true, pos: [84 / scale, -(baseline + labelBaselineInset(text, fs) * scale) / scale],
    scale: [1, 1], widgets: [w], children: [] };
}
