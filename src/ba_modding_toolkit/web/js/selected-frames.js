// UIPopup_Mulligan/Center/Popup/01/UIMulliganSlot: selected starting-skill cards.
// Clone the frame and the badge. Both badge sprites (Common_Icon_Mulligan_1 / _2) already draw their own check;
// the slot's number label (Mulligan_IndexLabel) carries the caption, a word instead of the game's number. SelectLine's
// own Sprite (Common_Icon_Check_Y_Off, inactive in the prefab) is not cloned: it would be a second check.
export const SELECTION_PREFAB = 'UIPopup_Mulligan';
export const SELECTION_SLOT = 'Center/Popup/01/UIMulliganSlot';
const child = (n, name) => n.children.find(c => c.name === name);
const widget = n => n.widgets.find(w => 'sprite' in w);
const textOf = n => n.widgets.find(w => 'text' in w);
export const sourceCardState = (applied, previewed) => applied ? 'applied' : previewed ? 'preview' : null;

// The box of the prefab's number label: its font size and size in prefab units, which a caption has to fit.
export function badgeCaptionBox(slot) {
  const label = child(slot, 'Mulligan_IndexLabel'), text = label && textOf(label);
  return text ? { fontSize: text.fontSize, width: text.w_, height: text.h_ } : null;
}

// Both captions on one line at a shared size, shrunk to that box (the prefab's label is ShrinkContent) by fitGroup
// (ngui.js), from the label's own size down to BADGE_FONT_MIN and, only where needed, below that, flagged as overflow.
export const BADGE_FONT_MIN = 12;
export function fitBadgeCaptions(slot, texts, fitGroup) {
  const box = badgeCaptionBox(slot);
  if (!box) return null;
  return fitGroup(texts, box.fontSize, BADGE_FONT_MIN, box.width, 1, { maxH: box.height })
    .map(fit => ({ text: fit.text, fontSize: fit.fs, overflow: !!fit.overflow }));
}

// caption: { text, fontSize } for this state's badge label, already fitted to badgeCaptionBox.
export function selectedFrame(slot, card, applied, previewed, caption = null) {
  const state = sourceCardState(applied, previewed);
  if (!state) return null;
  const source = child(slot, state === 'applied' ? 'SelectLine' : 'SelectLine_Sub');
  const frame = structuredClone(source), fw = widget(frame);
  const body = widget(child(child(slot, 'Common'), 'BG'));
  const dx = (card.w - body.w_) / 2, dy = (card.h - body.h_) / 2;
  frame.name = 'Select'; frame.active = true;
  fw.w_ += dx * 2; fw.h_ += dy * 2; fw.incline = 10;
  frame.children = [];
  // Keep the prefab's fixed corner insets and sprite sizes as the list's image window stretches.
  const prefix = state === 'applied' ? 'Applied' : 'Preview';
  const badge = structuredClone(child(slot, 'Mulligan_IndexBg'));
  badge.name = `${prefix}Badge`; badge.active = true;
  if (state === 'preview') widget(badge).sprite = 'Common_Icon_Mulligan_2';
  const nodes = [badge];
  const number = child(slot, 'Mulligan_IndexLabel');
  if (caption?.text && number) {
    const label = structuredClone(number);
    label.name = `${prefix}Label`; label.active = true;
    // The prefab defines no separate blue label colour; retain Mulligan_IndexLabel's own ink for both badges.
    Object.assign(textOf(label), { text: caption.text, fontSize: caption.fontSize });
    nodes.push(label);
  }
  for (const n of nodes) {
    n.pos = [n.pos[0] + dx, n.pos[1] + dy - frame.pos[1]];
    n.pos[0] += (n.pos[1] + frame.pos[1]) * Math.tan(Math.PI / 18);
  }
  frame.children.push(...nodes);
  const effectRoot = source.children.find(n => n.name.startsWith('FX_UI_Mulligan'));
  const uv = effectRoot?.children.find(n => n.name === 'UV');
  if (uv?.frameEffect) frame.children.push({ name: 'FrameEffect', active: true, pos: [0, 0], scale: [1, 1], widgets: [],
    frameEffect: { ...structuredClone(uv.frameEffect), uvScale: uv.scale, width: fw.w_, height: fw.h_,
      sourceWidth: widget(source).w_, sourceHeight: widget(source).h_, incline: fw.incline, depth: fw.depth + 1 } });
  return frame;
}
