// The game's own mouse pointer.
//
// Pointer: the PC client (ControllerMouse.SetPCCursorStyle, by its MousePoint option: this or the system arrow) sets
// PCIcon_MousePoint (UIs/GLPC_Cursor, 64 x 64) with Cursor.SetCursor, hotspot (0, 0), CursorMode.Auto: a hardware
// cursor, which Windows shows at the system cursor size (32 px at 100 %).
// Here it is a CSS cursor of 32 CSS px with the texture as its 2x image, on everything the game would show it on
// (buttons too: the game has no hover or pressed pointer); drag handles keep grab and grabbing, text fields the text
// cursor. Cursor_1 (the halo crosshair, hotspot in its middle, a software cursor) is the controller's pointer.
//
// The texture comes from the light /asset/ui/texture route; without a game the system cursor stays.
const POINTER = "PCIcon_MousePoint";
const SIZE = 32; // CSS px

function image(name) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `/asset/ui/texture/${name}.png`;
  });
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function scaled(img, size) {
  const c = canvas(size, size), g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/png");
}

// the pointer as a CSS cursor value, in the first syntax the engine takes (image-set keeps it sharp on HiDPI)
export function cursorValue(one, two, supports = (v) => CSS.supports("cursor", v)) {
  const set = `url("${one}") 1x, url("${two}") 2x`;
  return [`image-set(${set}) 0 0, auto`, `-webkit-image-set(${set}) 0 0, auto`, `url("${one}") 0 0, auto`].find(supports) || null;
}

async function initPointer() {
  const img = await image(POINTER);
  if (!img) return;
  const value = cursorValue(scaled(img, SIZE), scaled(img, SIZE * 2));
  if (!value) return;
  const root = document.documentElement.style;
  root.setProperty("--cursor", value);
  root.setProperty("--cursor-press", value);
}

export function init() {
  return initPointer().catch((err) => console.warn("cursor", err));
}
