// UIPopup_Mulligan/Center/Popup/01/UIMulliganSlot: selected starting-skill cards.
// Clone the frame, number-badge body and check. The separate numeric label is omitted for a single applied source.
export const SELECTION_PREFAB = 'UIPopup_Mulligan';
export const SELECTION_SLOT = 'Center/Popup/01/UIMulliganSlot';
const child = (n, name) => n.children.find(c => c.name === name);
const widget = n => n.widgets.find(w => 'sprite' in w);
export const sourceCardState = (applied, previewed) => applied ? 'applied' : previewed ? 'preview' : null;

export function selectedFrame(slot, card, applied, previewed) {
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
  if (state === 'applied') {
    const badge = structuredClone(child(slot, 'Mulligan_IndexBg'));
    badge.name = 'AppliedBadge'; badge.active = true;
    badge.pos = [badge.pos[0] + dx, badge.pos[1] + dy - frame.pos[1]];
    const check = structuredClone(child(source, 'Sprite'));
    check.name = 'Check'; check.active = true;
    check.pos = [check.pos[0] + dx, check.pos[1] + dy];
    // The prefab's number is a sibling UILabel, not part of either sprite.
    widget(check).depth = widget(badge).depth + 1;
    for (const n of [badge, check]) n.pos[0] += (n.pos[1] + frame.pos[1]) * Math.tan(Math.PI / 18);
    frame.children.push(badge, check);
  }
  const effectRoot = source.children.find(n => n.name.startsWith('FX_UI_Mulligan'));
  const uv = effectRoot?.children.find(n => n.name === 'UV');
  if (uv?.frameEffect) frame.children.push({ name: 'FrameEffect', active: true, pos: [0, 0], scale: [1, 1], widgets: [],
    frameEffect: { ...structuredClone(uv.frameEffect), uvScale: uv.scale, width: fw.w_, height: fw.h_,
      sourceWidth: widget(source).w_, sourceHeight: widget(source).h_, incline: fw.incline, depth: fw.depth + 1 } });
  return frame;
}
