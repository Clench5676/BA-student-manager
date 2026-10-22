// Switch geometry in NGUI units. All kinds use popup.js's shared switch card:
// Common_Btn_BG body, Common_Line_Raius20px frame and Common_Bg_Raius10px name band.
const GRID_WIDTH = 1788, INCLINE = 10, ROW_GAP = 48;
const lean = Math.tan(INCLINE * Math.PI / 180);
const overhangOf = (card) => (card.h + card.bar + 10) * lean;
// Preserve the accepted square-card spacing for the portrait rows as well.
const COLUMN_GAP = (GRID_WIDTH - 360 - overhangOf({ h: 360, bar: 104 })) / 3 - 360;
export function switchGrid(kind, width = GRID_WIDTH) {
  if (!kind) return { card: { w: 250, h: 226, bar: 68 }, columns: 6, pitch: [284, 350], overhang: (226 + 68 + 10) * lean };
  const b = portraitPanel, portraitAspect = (b.right - b.left - b.gap) / 2 / (b.top - b.bottom);
  const card = kind === "spr" ? { w: 250, h: 250 / portraitAspect, bar: 104 }
    : kind === "lobby" ? { w: 750, h: 422, bar: 104 }
    : kind === "model" ? { w: 360, h: 360, bar: 104 }
    : { w: 250, h: 226, bar: 104 };
  const overhang = overhangOf(card);
  const columns = kind === "spr" ? Math.max(1, Math.floor((width - overhang + COLUMN_GAP) / (card.w + COLUMN_GAP)))
    : kind === "lobby" ? 2 : kind === "model" ? 4 : 6;
  const pitch = [kind === "spr" ? card.w + COLUMN_GAP : (width - card.w - overhang) / (columns - 1), card.h + card.bar + ROW_GAP];
  return { card, columns, pitch, overhang };
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
