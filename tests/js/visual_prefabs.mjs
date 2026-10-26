// Geometry from UICharacterVisualMode/Inventory_ListControl_PC; verified against the official prefab in Python.
import { n, spr } from "./control_prefabs.mjs";

export function visualPrefab() {
  const body = () => spr("Common_Bg_Raius5px_Shadow", 171, 116, { type: 1, incline: 10, depth: 8 });
  const icon = (name, w, h, y = 8) => n("Icon", [0, y], [spr(name, w, h, { depth: 10, color: "#2d4664/1.00" })]);
  const anchors = (right, top) => ({ cls: "UIWidget", w_: 2960, h_: 1440, pivot: 4, anchors: {
    leftAnchor: right ? [1, -2960] : [0, 0], rightAnchor: right ? [1, 0] : [0, 2960],
    bottomAnchor: top ? [1, -1474] : [0, 0], topAnchor: top ? [1, -34] : [0, 1440],
  } });
  const reset = (name) => n(name, [1352, -658], [spr("Common_Empty", 171, 116, { pivot: 7 })], [
    n("Btn_RefreshPos", [0, 61.1], [body()]), icon("Cafe_Icon_Rotate", 65, 59, 69.1),
    n("Label_Locale_Reset", [0, -25.9], [{ text: "Po Reset", fontSize: 46, w_: 212, h_: 78, pivot: 4 }]),
  ]);
  return n("UICharacterVisualMode", [0, 0], [], [n("Inventory_ListControl_PC", [0, 0], [], [
    n("BG"), n("Character", [0, 0], [], [{ ...n("CharacterPos"), scale: [50, 50] }]),
    n("LeftTop", [0, -34], [anchors(false, true)], [n("Btn_Back", [-1354, 650], [body()], [icon("Common_Icon_Back", 75, 63)])]),
    n("RightTop", [0, -34], [anchors(true, true)], [
      n("Btn_HideUI", [1352, 650], [body()], [icon("Common_UIHide_Icon", 79, 67)]),
      { ...n("Btn_ShowUI", [1352, 650], [body()], [icon("Common_UIHide_Icon2", 79, 67)]), active: false },
    ]),
    n("RightBottom", [0, 0], [anchors(true, false)], [reset("Btn_RefreshPos"), { ...reset("Btn_RefreshPos_Disable"), active: false }]),
  ])]);
}
