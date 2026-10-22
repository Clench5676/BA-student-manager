// Switch geometry in NGUI units. Preserve popup.js's Common_Btn_BG body,
// Common_Line_Raius20px frame and Common_Bg_Raius10px name band.
const GRID_WIDTH = 1818, INSET = 40, ROW_GAP = 48;
const lean = Math.tan(10 * Math.PI / 180);
export function switchGrid(kind, width = GRID_WIDTH) {
  if (!kind) return { card: { w: 250, h: 226, bar: 68 }, columns: 6, pitch: [284, 350], overhang: 304 * lean };
  const card = kind === "spr" ? { w: 320, h: 704, bar: 104 }
    : kind === "lobby" ? { w: 750, h: 422, bar: 104 }
    : kind === "model" ? { w: 360, h: 360, bar: 104 }
    : { w: 250, h: 226, bar: 68 };
  const overhang = (card.h + card.bar + 10) * lean;
  const max = kind === "lobby" ? 2 : kind === "spr" || kind === "model" ? 4 : 6;
  const columns = Math.max(1, Math.min(max, Math.floor((width - 2 * INSET - overhang + 48) / (card.w + 48))));
  const pitch = [(width - 2 * INSET - card.w - overhang) / Math.max(1, columns - 1), card.h + card.bar + ROW_GAP];
  return { card, columns, pitch, overhang };
}

// NGUI inclines each widget around its own centre; children are positioned separately.
// Measure the outer corners, rather than splitting the total overhang equally about the body centre.
export function cardInkBounds(tree) {
  const bounds = { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity };
  function visit(n, px, py, sx, sy) {
    if (n.active === false) return;
    const x = px + n.pos[0] * sx, y = py + n.pos[1] * sy;
    sx *= n.scale?.[0] ?? 1; sy *= n.scale?.[1] ?? 1;
    for (const w of n.widgets || []) {
      if (!("sprite" in w)) continue;
      const width = w.w_ * sx, height = w.h_ * sy, pivot = w.pivot ?? 4;
      const cx = x + (.5 - (pivot % 3) / 2) * width;
      const cy = y + (Math.floor(pivot / 3) / 2 - .5) * height;
      const half = width / 2 + Math.abs(Math.tan((w.incline || 0) * Math.PI / 180) * height / 2);
      bounds.left = Math.min(bounds.left, cx - half); bounds.right = Math.max(bounds.right, cx + half);
      bounds.top = Math.max(bounds.top, cy + height / 2); bounds.bottom = Math.min(bounds.bottom, cy - height / 2);
    }
    for (const child of n.children || []) visit(child, x, y, sx, sy);
  }
  visit(tree, 0, 0, 1, 1);
  return bounds;
}

export function placeSwitchCards(trees, { columns, pitch }, paper) {
  const boxes = trees.map(cardInkBounds);
  for (let start = 0; start < trees.length; start += columns) {
    const row = boxes.slice(start, start + columns);
    const left = Math.min(...row.map((b, i) => b.left + i * pitch[0]));
    const right = Math.max(...row.map((b, i) => b.right + i * pitch[0]));
    const x = (paper.left + paper.right - left - right) / 2;
    const y = paper.top - INSET - Math.max(...row.map((b) => b.top)) - Math.floor(start / columns) * pitch[1];
    row.forEach((_, i) => { trees[start + i].pos = [x + i * pitch[0], y]; });
  }
}

// Portrait body: image on the left, name/chips/stacked fields on the right;
// the existing full-width action row remains below both halves.
export const portraitPanel = { left: -1340, right: -550, top: 490, bottom: -530, gap: 28 };

export function splitPortraitPanel(tree, find, wrap) {
  const b = portraitPanel, middle = (b.left + b.right) / 2;
  const width = (b.right - b.left - b.gap) / 2, cx = middle + b.gap / 2 + width / 2;
  const picture = find(tree, "Picture");
  picture.pos = [b.left + width / 2, (b.top + b.bottom) / 2];
  // UINonEquipmentInventory/Inventory_ListControl/EquipPos/Texture is supplied by the caller.
  const texture = find(picture, "Texture");
  texture.pos = [0, 0];
  Object.assign(texture.widgets.find((w) => "texture" in w), { w_: width, h_: b.top - b.bottom, pivot: 4 });
  const name = find(tree, "Name"), edit = find(tree, "EditName"), original = find(tree, "OriginalName");
  name.pos = [cx - (edit ? 28 : 0), b.top - 54];
  const nw = name.widgets[0];
  Object.assign(nw, { w_: width - (edit ? 60 : 0), h_: 100, ellipsis: true });
  if (edit) edit.pos = [b.right - 24, name.pos[1]];
  if (original) { original.pos = [cx, b.top - 126]; original.widgets[0].w_ = width; }
  const chips = tree.children.filter((n) => n.name.startsWith("Chip_"));
  const chipWidth = (width - 12 * (chips.length - 1)) / Math.max(1, chips.length);
  chips.forEach((chip, i) => {
    chip.pos = [middle + b.gap / 2 + chipWidth / 2 + i * (chipWidth + 12), b.top - 192];
    chip.widgets[0].w_ = chipWidth;
    find(chip, "Line").widgets[0].w_ = chipWidth;
    const text = find(chip, "Text");
    for (const n of text.children || []) for (const w of n.widgets || []) if ("text" in w) {
      w.w_ = chipWidth - 20; w.ellipsis = true;
    }
  });
  const fields = tree.children.filter((n) => /^F_\d+$/.test(n.name));
  let top = b.top - 246;
  fields.forEach((caption, i) => {
    const value = find(tree, `V_${i}`), w = value.widgets[0];
    const fitted = wrap(w.ariaLabel ?? w.text, w.fontSize, 26, width - 32, i === 0 ? 5 : 3);
    // A persisted error may include a very long path. Keep its full accessible value,
    // but bound its visible status row so CRC and the action row stay reachable.
    const clipped = i === 2 && fitted.lines > 3;
    if (clipped) { fitted.text = fitted.text.split("\n").slice(0, 3).join("\n") + "…"; fitted.lines = 3; }
    const h = fitted.lines * fitted.fs * 1.25 + 8;
    caption.pos = [middle + b.gap / 2 + 16, top];
    Object.assign(caption.widgets[0], { w_: width - 32, h_: 48, pivot: 0 });
    value.pos = [caption.pos[0], top - 50];
    Object.assign(w, { text: fitted.text, fontSize: fitted.fs, w_: width - 32, h_: h, pivot: 0, ellipsis: clipped });
    top -= 50 + h + 20;
    const line = find(tree, `L_${i}`);
    if (line) { line.pos = [cx, top + 10]; line.widgets[0].w_ = width - 24; }
  });
  const box = find(tree, "Fields"), boxTop = b.top - 234;
  box.pos = [cx, (boxTop + top) / 2];
  Object.assign(box.widgets[0], { w_: width, h_: boxTop - top });
  Object.assign(find(box, "Line").widgets[0], { w_: width + 6, h_: boxTop - top + 6 });
  return tree;
}
