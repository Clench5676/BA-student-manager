// UILobby's plate and entry states, with app destinations substituted into its grid.
import * as NGUI from "./ngui.js";
import { disabledButton } from "./game-buttons.js";
import { clone } from "./util.js";

// UILobby's label half-height supplies the bottom inset as well as the space below the baseline.
export const navigationOrigin = (tree, scale) => [130, 104 - NGUI.find(tree, "Label").widgets[0].h_ * scale];

export function navigationEntry(grid, item, caption, greyed, index) {
  const donor = grid.children.find((entry) => NGUI.find(entry, "Able")?.widgets.some((w) => w.sprite === item.icon))
    || grid.children[index % grid.children.length];
  const tree = clone(donor);
  tree.pos = [0, 0];
  tree.scale = [1, 1];
  const reference = grid.children.find((entry) => NGUI.find(entry, "Able")?.widgets.some((w) => w.sprite === "Common_Icon_Student")) || grid.children[0];
  const slot = NGUI.find(reference, "Able"), size = slot.widgets.find((w) => "sprite" in w);
  tree.children = tree.children.filter((child) => ["Label", "Able", "Disable"].includes(child.name));
  NGUI.find(tree, "Able").active = !greyed;
  const disabled = NGUI.find(tree, "Disable");
  disabled.active = greyed;
  // greyed entries hand over to the classic UI: the dimmed icon only, not the game's lock and unlock effect
  disabled.children = disabled.children.filter((child) => child.name === "Icon");
  for (const path of ["Able", "Disable/Icon"]) {
    const part = NGUI.find(tree, path), icon = part.widgets.find((w) => "sprite" in w);
    part.pos = [...slot.pos]; part.scale = [1, 1];
    Object.assign(icon, { sprite: item.icon, w_: size.h_, h_: size.h_, keepAspect: true });
  }
  // Notification dots belong to the game's destinations, not to these app routes.
  NGUI.find(tree, "Able").children = [];
  const label = NGUI.find(tree, "Label").widgets[0];
  NGUI.find(tree, "Label").pos = [...NGUI.find(reference, "Label").pos];
  NGUI.fitLabel(label, caption, label.fontSize, 28, 360, 1);
  label.w_ = 370;
  return tree;
}

export function switchTree(collection, filter, on, unavailable, captions) {
  const source = NGUI.find(collection, "SeletControl/TopMenu/FilterBtn");
  // All supplies the left cap; Support supplies the right cap and its offset baseline.
  const baseline = NGUI.find(source, "All").pos[1];
  const children = ["All", "Support"].map((name, i) => {
    const segment = clone(NGUI.find(source, name));
    segment.pos = [i === 0 ? -164 : 164, segment.pos[1] - baseline];
    for (const state of segment.children) {
      state.active = (state.name === "Btn_Pressed") === (i === (on ? 0 : 1));
      for (const child of state.children || []) {
        const picture = child.widgets.find((w) => "texture" in w);
        if (picture) child.widgets = [NGUI.label(captions[i], 56, picture.color, 280, 80, { depth: picture.depth })];
      }
    }
    // The roster's filter/sort button supplies the normal state's shadow border, with its top aligned to the cap.
    const normal = NGUI.find(segment, "Btn_Normal"), body = normal.widgets.find((w) => "sprite" in w);
    const shadow = clone(NGUI.find(collection, "SeletControl/TopMenu/SortBtn/Btn_Normal"));
    shadow.name = "Shadow"; shadow.children = [];
    const border = shadow.widgets.find((w) => "sprite" in w);
    shadow.pos = [0, -(border.h_ - body.h_) / 2]; shadow.scale = [1, 1];
    border.w_ = body.w_; border.flip = body.flip; border.depth = body.depth - 1;
    normal.children.push(shadow);
    if (unavailable) {
      const original = NGUI.find(segment, "Btn_Normal"), text = original.children.find((child) => child.widgets.some((w) => "text" in w));
      text.name = "Label_Locale";
      const disabled = disabledButton(filter, original);
      segment.children = [disabled];
    }
    return segment;
  });
  return NGUI.node("ModSwitch", [0, 0], [], children);
}
