// UILobby's plate and entry states, with app destinations substituted into its grid.
import * as NGUI from "./ngui.js";
import { clone } from "./util.js";

// UILobby's label half-height supplies the bottom inset as well as the space below the baseline.
export const navigationOrigin = (tree, scale, width = 260) => [width / 2, 104 - NGUI.find(tree, "Label").widgets[0].h_ * scale];

export function navigationEntry(grid, item, caption, greyed, index, width = 260) {
  const donor = grid.children.find((entry) => NGUI.find(entry, "Able")?.widgets.some((w) => w.sprite === item.icon))
    || grid.children[index % grid.children.length];
  const tree = clone(donor);
  tree.pos = [0, 0];
  tree.scale = [1, 1];
  const reference = grid.children.find((entry) => NGUI.find(entry, "Able")?.widgets.some((w) => w.sprite === "Common_Icon_Student")) || grid.children[0];
  const labelSlot = NGUI.find(reference, "Label"), iconSize = 80;
  tree.children = tree.children.filter((child) => ["Label", "Able", "Disable"].includes(child.name));
  NGUI.find(tree, "Able").active = !greyed;
  const disabled = NGUI.find(tree, "Disable");
  disabled.active = greyed;
  // greyed entries hand over to the classic UI: the dimmed icon only, not the game's lock and unlock effect
  disabled.children = disabled.children.filter((child) => child.name === "Icon");
  for (const path of ["Able", "Disable/Icon"]) {
    const part = NGUI.find(tree, path), icon = part.widgets.find((w) => "sprite" in w);
    part.pos = [0, labelSlot.pos[1] + labelSlot.widgets[0].h_ / 2 + 6 + iconSize / 2]; part.scale = [1, 1];
    Object.assign(icon, { sprite: item.icon, w_: iconSize, h_: iconSize, keepAspect: true });
  }
  // The Social donor's Label/IconPlus is a submenu marker; destination notifications also stay in the game.
  NGUI.find(tree, "Able").children = [];
  NGUI.find(tree, "Label").children = [];
  const label = NGUI.find(tree, "Label").widgets[0];
  NGUI.find(tree, "Label").pos = [...labelSlot.pos];
  const available = (width - 8) * 2960 / 1920 - 2 * Math.abs(labelSlot.pos[0]);
  NGUI.fitLabel(label, caption, label.fontSize, 28, Math.min(360, available), 1);
  label.w_ = Math.min(370, available + 4);
  return tree;
}
