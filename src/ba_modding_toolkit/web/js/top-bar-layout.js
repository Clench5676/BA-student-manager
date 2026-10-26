// The top bar's vertical alignment. No DOM: the tests run it in Node (top-bar.js applies it).
// The bar is UICharacterCollection SeletControl/Top/BG_W/Bg (Common_Top_Menu_Bg, 2996 x 166 sliced), with Label_Title (font size
// 66), Btn_Information and the back button on it; the right-hand actions are NUITop_Scenes/Top/Right (Option, Lobby, Line).
// The sprite is a light fill with a dark lip and a shadow under it: the centre that content is aligned to is the fill's.

export const BAR_HEIGHT = 64;
// Common_Top_Menu_Bg is 105 rows high; rows 0 to 96 are the light fill, the dark lip and its shadow start at row 97
export const FILL = Object.freeze({ top: 0, bottom: 97, height: 105 });

// the centre of a bar of this height, from where the fill is in the sprite (its rows scale with the bar)
export const barCentre = (fill = FILL, height = BAR_HEIGHT) => (fill.top + fill.bottom) / 2 / fill.height * height;

// the padding under the bar's content that makes flex centring use the fill's centre instead of the whole height's
export const barPadding = (centre, height = BAR_HEIGHT) => Math.max(0, height - 2 * centre);

// the vertical extent [top, bottom] of several rectangles together, or null without any
export function extent(rects) {
  const list = rects.filter((r) => r && r.bottom > r.top);
  return list.length ? { top: Math.min(...list.map((r) => r.top)), bottom: Math.max(...list.map((r) => r.bottom)) } : null;
}

// where the drawn part of a bitmap box is: the box's rect (px) and the sprite's ink rows (alpha bounds, of `height`)
export const inkRect = (box, rows) => ({ top: box.top + rows.top / rows.height * (box.bottom - box.top),
  bottom: box.top + rows.bottom / rows.height * (box.bottom - box.top) });

// how far down an element has to move for the centre of its ink to sit on `centre` (all px, one origin)
export const moveBy = (centre, ink) => (ink ? centre - (ink.top + ink.bottom) / 2 : 0);
