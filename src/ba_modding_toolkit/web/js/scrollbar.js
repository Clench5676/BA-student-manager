// UICharacterCollection's complete texture track and thumb, shared by native and virtual lists.
import * as NGUI from "./ngui.js";
import { clone } from "./util.js";

// Painted alpha occupies x 29..49 of the native 126-pixel texture, not its DOM bounds.
export function scrollbarTrack([left, top, width, height], scale, horizontal = false) {
  return horizontal ? [left + 6, top + height - 97 * scale, width - 12, 126 * scale]
    : [left + width - 49 * scale, top + 6, 126 * scale, height - 12];
}

export async function scrollbar(host, [left, top, width, height], { collection = null, z = 150, className = "", horizontal = false } = {}) {
  collection ||= await NGUI.layout("UICharacterCollection");
  const tree = clone(NGUI.find(collection, "SeletControl/List/Scroll Bar"));
  // Turn the complete prefab, retaining both texture widgets and their colours.
  if (horizontal) [width, height] = [height, width];
  tree.pos = [0, 0];
  // CharacterCollection_ScrollBarBg is a 126 × 24 texture with eight-pixel end caps.
  // Bake it at its native aspect, then extend only its centre instead of stretching its rounded ends.
  const cap = width * 8 / 126, naturalHeight = width * 24 / 126;
  for (const part of tree.children) {
    part.pos = [width / 2, -naturalHeight / 2];
    for (const w of part.widgets) if ("texture" in w) Object.assign(w, { w_: width, h_: naturalHeight });
  }
  const bar = document.createElement("div");
  bar.className = `scrollbar ${className}`;
  Object.assign(bar.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: z });
  if (horizontal) Object.assign(bar.style, { top: `${top + width}px`, transform: "rotate(-90deg)", transformOrigin: "top left" });
  const view = await NGUI.render(tree, bar, { scale: 1, origin: [0, 0] });
  for (const part of tree.children) for (const element of view.nodes.get(`${tree.name}/${part.name}`).els) {
    const source = element.style.backgroundImage;
    Object.assign(element.style, { backgroundImage: "none", height: `${height}px`, top: "0px",
      borderImageSource: source, borderImageSlice: "8 0 8 0 fill", borderImageWidth: `${cap}px 0`, borderImageRepeat: "stretch" });
  }
  const thumb = view.nodes.get(`${tree.name}/Foreground`).els[0];
  bar.sync = (visible, total, offset = 0) => {
    bar.hidden = total <= visible;
    const extent = Math.min(height, Math.max(cap * 2, height * Math.min(1, visible / Math.max(1, total))));
    Object.assign(thumb.style, { height: `${extent}px`, top: `${(height - extent) * (total > visible ? offset / (total - visible) : 0)}px` });
  };
  host.appendChild(bar);
  return bar;
}
