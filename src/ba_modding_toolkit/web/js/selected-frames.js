// UIPopup_Mulligan/Center/Popup/01/UIMulliganSlot: selected starting-skill cards.
// Clone the frame and the badge. Both badge sprites (Common_Icon_Mulligan_1 / _2) already draw their own check;
// the slot's number label (Mulligan_IndexLabel) carries the caption, a word instead of the game's number. SelectLine's
// own Sprite (Common_Icon_Check_Y_Off, inactive in the prefab) is not cloned: it would be a second check.
import { innerFrame } from './row-thumbnail.js';

export const SELECTION_PREFAB = 'UIPopup_Mulligan';
export const SELECTION_SLOT = 'Center/Popup/01/UIMulliganSlot';
// App-owned horizontal cuts, verified by test_selection_badge_slices.py against the official development view.
// Columns [14, 28) are exactly equal in RGBA in both originals. No pixels or vertical cuts ship with the App.
export const SELECTION_BADGE_SLICES = {
  "Common_Icon_Mulligan_1": { "width": 64, "height": 69, "borderLeft": 14, "borderRight": 36, "borderTop": 0, "borderBottom": 0 },
  "Common_Icon_Mulligan_2": { "width": 64, "height": 69, "borderLeft": 14, "borderRight": 36, "borderTop": 0, "borderBottom": 0 }
};
const child = (n, name) => n.children.find(c => c.name === name);
const widget = n => n.widgets.find(w => 'sprite' in w);
const textOf = n => n.widgets.find(w => 'text' in w);
export const sourceCardState = (applied, previewed) => applied ? 'applied' : previewed ? 'preview' : null;

// The box of the prefab's number label: its font size and size in prefab units, which a caption has to fit.
export function badgeCaptionBox(slot) {
  const label = child(slot, 'Mulligan_IndexLabel'), text = label && textOf(label);
  return text ? { fontSize: text.fontSize, width: text.w_, height: text.h_ } : null;
}

// Both states share a width and a font size per locale/card. Start at the prefab label's font size, expanding the
// uniform fill first. A badge may occupy at most the card body's width; only that limit can shrink the captions.
// Preserve the original 76/64 horizontal and 74/69 vertical scale of the end pieces, including the check.
export const BADGE_FONT_MIN = 12;
export function fitBadgeCaptions(slot, texts, fitGroup, measureWidth, card = null) {
  const box = badgeCaptionBox(slot);
  if (!box) return null;
  const badge = widget(child(slot, 'Mulligan_IndexBg'));
  const cuts = SELECTION_BADGE_SLICES[badge.sprite], scale = badge.w_ / cuts.width;
  const ends = (cuts.borderLeft + cuts.borderRight) * scale;
  const limit = Math.max(badge.w_, card?.w ?? widget(child(child(slot, 'Common'), 'BG')).w_);
  const fits = fitGroup(texts, box.fontSize, BADGE_FONT_MIN, limit - ends, 1);
  const width = Math.min(limit, Math.max(badge.w_, Math.ceil(ends + Math.max(...fits.map(fit => measureWidth(fit.text, fit.fs))))));
  return fits.map(fit => ({ text: fit.text, fontSize: fit.fs, overflow: !!fit.overflow,
    badgeWidth: width, labelWidth: width - ends }));
}

// Paint the entire opening of SelectLine / SelectLine_Sub, including its corners. A second rounded mask or
// Common_Line_Raius20px cuts into that opening and exposes Common/BG. One source texel of underpaint stays under
// the opaque stroke and covers nine-slice raster rounding; the prefab frame itself supplies the visible corners.
export function selectionArtWindow(frame, meta, outline) {
  const { clipPolygon, ...window } = innerFrame(widget(frame), meta,
    { ...outline, insets: outline.insets.map(v => Math.max(0, v - 1)) },
    { x: frame.pos[0], y: frame.pos[1] });
  return window;
}

// caption: the state's fitBadgeCaptions result. The label occupies only the fill between the preserved ends.
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
  const bw = widget(badge), cuts = SELECTION_BADGE_SLICES[bw.sprite];
  bw.sliceBorders = { borderLeft: cuts.borderLeft, borderRight: cuts.borderRight, borderTop: 0, borderBottom: 0 };
  bw.sliceScale = [bw.w_ / cuts.width, bw.h_ / cuts.height];
  const growth = (caption?.badgeWidth ?? bw.w_) - bw.w_;
  bw.w_ += growth;
  badge.pos[0] -= growth / 2; // Keep the right edge, top, height and the entire check piece fixed.
  const nodes = [badge];
  const number = child(slot, 'Mulligan_IndexLabel');
  if (caption?.text && number) {
    const label = structuredClone(number);
    label.name = `${prefix}Label`; label.active = true;
    // The prefab defines no separate blue label colour; retain Mulligan_IndexLabel's own ink for both badges.
    Object.assign(textOf(label), { text: caption.text, fontSize: caption.fontSize, w_: caption.labelWidth });
    // Centre the original label in the fill, clear of the check and rounded left end. Its font, height and ink
    // still come from Mulligan_IndexLabel; the line box has the badge's height available (including Latin scaling).
    label.pos = [badge.pos[0] + (cuts.borderLeft - cuts.borderRight) * bw.sliceScale[0] / 2, badge.pos[1]];
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
