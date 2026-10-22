// Switch geometry in NGUI units. UICollectCard supplies the portrait silhouette;
// lobby/model retain the existing popup's Common_Btn_BG card and name bar.
export function switchGrid(kind, portrait = null) {
  if (!kind) return { card: { w: 250, h: 226, bar: 68 }, columns: 6, pitch: [284, 350], overhang: (226 + 68 + 10) * Math.tan(Math.PI / 18) };
  const card = kind === "spr" ? { w: 300, h: 440, bar: 0 }
    : kind === "lobby" ? { w: 750, h: 422, bar: 104 }
    : kind === "model" ? { w: 360, h: 360, bar: 104 }
    : { w: 250, h: 226, bar: 104 };
  if (kind === "spr" && portrait) {
    const bg = portrait.children.find((c) => c.name === "BG");
    const w = bg.widgets.find((w) => w.sprite);
    card.h = card.w * w.h_ / w.w_;
    card.incline = w.incline || 0;
  }
  const columns = kind === "lobby" ? 2 : kind === "model" || kind === "spr" ? 4 : 6;
  const lean = Math.abs(Math.tan((card.incline ?? 10) * Math.PI / 180));
  const overhang = (card.h + card.bar + 10) * lean;
  const pitch = [(1788 - card.w - overhang) / (columns - 1), card.h + card.bar + 48];
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

// UICollectCard is cloned intact. Only content and unused branches change;
// its BG sprite retains the game's incline, corner contour, colour and slicing.
export function portraitCard(template, it, selected, ui, caption) {
  const t = structuredClone(template), find = ui.find;
  t.name = `Card_${it.key}`;
  const keep = new Set(["BG", "Char_Portrait", "Label_CharName", "Sort", "Btn_Pin", "NewIcon", "BG_Discover"]);
  for (const c of t.children) if (!keep.has(c.name)) c.active = false;
  const bg = find(t, "BG"), body = bg.widgets.find((w) => w.sprite);
  const picture = find(t, "Char_Portrait");
  const pw = picture.widgets.find((w) => "texture" in w);
  Object.assign(pw, { clipImage: it.thumb, imgSize: "cover", imgPosition: "center", imgLeft: "0", imgWidth: "100%", radius: 0, incline: body.incline || 0 });
  const name = find(t, "Label_CharName"), nw = name.widgets.find((w) => "text" in w);
  const nameWidth = body.w_ - 72 - (it.nameEdit ? 60 : 0);
  const fitted = ui.fitText(it.label, nw.fontSize, 24, nameWidth, 2);
  Object.assign(nw, { text: fitted.text, fontSize: fitted.fs, ariaLabel: it.full, ellipsis: true,
    w_: nameWidth, h_: Math.min(100, fitted.lines * fitted.fs * 1.25) });
  name.pos = [bg.pos[0], bg.pos[1] - body.h_ / 2 + 140];
  for (const child of name.children || []) child.active = false;
  const sort = find(t, "Sort"), status = find(sort, "Label_Schoolname");
  sort.active = !!(it.badge || it.inUse);
  sort.pos = [bg.pos[0], bg.pos[1] - body.h_ / 2 + 38];
  status.pos = [0, 0];
  Object.assign(status.widgets.find((w) => "text" in w), { text: it.badge?.text || caption, w_: body.w_ - 72, h_: 48, ellipsis: true });
  if (it.tag) {
    const tag = structuredClone(sort); tag.name = "Tag"; tag.active = true;
    tag.pos[1] = bg.pos[1] + body.h_ / 2 - 112;
    find(tag, "Label_Schoolname").widgets.find((w) => "text" in w).text = it.tag.text;
    t.children.push(tag);
  }
  if (it.nameEdit) {
    name.pos[0] -= 30;
    t.children.push(ui.node("EditName", [bg.pos[0] + body.w_ / 2 - 48, name.pos[1]],
      [ui.sprite("Cafe_Icon_NameEdit", 42, 42, { type: 0, depth: 26 })]));
  }
  if (it.recruit) t.children.push(ui.node("Recruit", [bg.pos[0] - body.w_ / 2 + 48, bg.pos[1] + body.h_ / 2 - 48],
    [ui.sprite("Common_Icon_Gacha2", 62 * 126 / 143, 62, { type: 0, depth: 26 })]));
  const dim = find(t, "BG_Discover"); dim.active = !!it.dim;
  const pin = find(t, "Btn_Pin"); pin.active = !!it.fav;
  pin.pos = [bg.pos[0] + body.w_ / 2 - 48, bg.pos[1] + body.h_ / 2 - 180];
  if (find(pin, "Off")) find(pin, "Off").active = false;
  find(t, "NewIcon").active = !!it.isNew && !it.inUse && !selected;
  if (selected) {
    // Existing switch selection widgets, using the character frame's native dimensions/incline.
    t.children.push(ui.node("Select", [...bg.pos], [], [ui.node("Check", [body.w_ / 2 - 48, body.h_ / 2 - 48],
      [ui.sprite("Card_Ability_Select_Line_Icon", 66, 65, { type: 0, depth: 26 })])]));
  }
  const [bx, by] = bg.pos;
  for (const child of t.children) { child.pos[0] -= bx; child.pos[1] -= by; }
  const scale = 300 / body.w_;
  t.scale = [scale, scale];
  return t;
}

// Clip the upright portrait with UICollectCard/BG's actual raster alpha, not a guessed CSS corner radius.
export async function maskPortrait(view, root) {
  await Promise.all(view.images || []);
  const frame = view.nodes.get(`${root}/BG`)?.els[0], picture = view.nodes.get(`${root}/Char_Portrait`)?.els[0];
  if (!frame || !picture) return;
  const position = `${parseFloat(frame.style.left) - parseFloat(picture.style.left)}px ${parseFloat(frame.style.top) - parseFloat(picture.style.top)}px`;
  Object.assign(picture.style, { webkitMaskImage: frame.style.backgroundImage, maskImage: frame.style.backgroundImage,
    webkitMaskSize: `${frame.style.width} ${frame.style.height}`, maskSize: `${frame.style.width} ${frame.style.height}`,
    webkitMaskPosition: position, maskPosition: position, webkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" });
}
