// UILobby's plate and entry states, with app destinations substituted into its grid.
import * as NGUI from "./ngui.js";
import { disabledButton } from "./game-buttons.js";
import { clone } from "./util.js";

export function navigationEntry(grid, item, caption, greyed, index) {
  const donor = grid.children.find((entry) => NGUI.find(entry, "Able")?.widgets.some((w) => w.sprite === item.icon))
    || grid.children[index % grid.children.length];
  const tree = clone(donor);
  tree.pos = [0, 0];
  tree.children = tree.children.filter((child) => ["Label", "Able", "Disable"].includes(child.name));
  NGUI.find(tree, "Able").active = !greyed;
  const disabled = NGUI.find(tree, "Disable");
  disabled.active = greyed;
  for (const path of ["Able", "Disable/Icon"]) {
    const icon = NGUI.find(tree, path).widgets.find((w) => "sprite" in w);
    icon.sprite = item.icon;
  }
  // Notification dots belong to the game's destinations, not to these app routes.
  NGUI.find(tree, "Able").children = [];
  const label = NGUI.find(tree, "Label").widgets[0];
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
      state.active = (state.name === "Btn_Pressed") === (i === (on ? 1 : 0));
      for (const child of state.children || []) {
        const picture = child.widgets.find((w) => "texture" in w);
        if (picture) child.widgets = [NGUI.label(captions[i], 56, picture.color, 280, 80, { depth: picture.depth })];
      }
    }
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
