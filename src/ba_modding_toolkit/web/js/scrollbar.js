// UICharacterCollection's complete texture track and thumb, shared by native and virtual lists.
import * as NGUI from "./ngui.js";
import { clone } from "./util.js";

export async function scrollbar(host, [left, top, width, height], { collection = null, z = 150, className = "", horizontal = false } = {}) {
  collection ||= await NGUI.layout("UICharacterCollection");
  const tree = clone(NGUI.find(collection, "SeletControl/List/Scroll Bar"));
  // Turn the complete prefab, retaining both texture widgets and their colours.
  if (horizontal) [width, height] = [height, width];
  tree.pos = [0, 0];
  for (const part of tree.children) {
    part.pos = [width / 2, -height / 2];
    for (const w of part.widgets) if ("texture" in w) Object.assign(w, { w_: width, h_: height });
  }
  const bar = document.createElement("div");
  bar.className = `scrollbar ${className}`;
  Object.assign(bar.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: z });
  if (horizontal) Object.assign(bar.style, { top: `${top + width}px`, transform: "rotate(-90deg)", transformOrigin: "top left" });
  const view = await NGUI.render(tree, bar, { scale: 1, origin: [0, 0] });
  const thumb = view.nodes.get(`${tree.name}/Foreground`).els[0];
  bar.sync = (visible, total, offset = 0) => {
    bar.hidden = total <= visible;
    const extent = height * Math.min(1, visible / Math.max(1, total));
    Object.assign(thumb.style, { height: `${extent}px`, top: `${(height - extent) * (total > visible ? offset / (total - visible) : 0)}px` });
  };
  host.appendChild(bar);
  return bar;
}
