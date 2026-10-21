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

function labels(tree, path = "", x = 0, y = 0, sx = 1, sy = 1, result = []) {
  if (!tree || tree.active === false) return result;
  x += (tree.pos?.[0] || 0) * sx; y += (tree.pos?.[1] || 0) * sy;
  sx *= tree.scale?.[0] ?? 1; sy *= tree.scale?.[1] ?? 1;
  path += `/${tree.name}`;
  for (const w of tree.widgets || []) if ("text" in w) result.push({ w, path, x, y, sx, sy });
  for (const child of tree.children || []) labels(child, path, x, y, sx, sy, result);
  return result;
}

// Both labels share the repeater's screen-bottom anchor, including the text renderer's baseline lift.
export function loadingLabel(repeater, loading, text, scale) {
  const candidates = labels(repeater);
  const anchor = candidates.find((item) => /\/Loading\//i.test(item.path)) || candidates[0];
  const source = anchor?.w.effect ? anchor : labels(loading).find((item) => item.w.effect && item.w.effectColor && item.w.effectDistance);
  if (!anchor || !source) return null;
  const w = structuredClone(source.w), fs = anchor.w.fontSize * anchor.sy;
  const bottom = 1080 - (720 + anchor.y) * scale + (1 - Math.floor((anchor.w.pivot ?? 4) / 3) / 2) * anchor.w.h_ * anchor.sy * scale;
  const baseline = bottom - labelBaselineInset(anchor.w.text, fs) * scale;
  Object.assign(w, { text, fontSize: fs, w_: 1000 / scale, h_: fs * 1.4, pivot: 6, align: 1, ellipsis: true });
  return { name: "Progress", active: true, pos: [84 / scale, -(baseline + labelBaselineInset(text, fs) * scale) / scale],
    scale: [1, 1], widgets: [w], children: [] };
}
