// Authored stand-ins for the exported NGUI paths; no game assets are stored here.
import { node as n, makeImportLayouts } from "./import_prefabs.mjs";
const sprite = (sprite, w_, h_, extra = {}) => ({ sprite, w_, h_, pivot: 4, type: 1, incline: 10,
  color: "#ffffff/1.00", depth: 7, prefabMarker: true, ...extra });
const label = (name, w = 350) => n(name, [0, 0], [{ text: "Name", fontSize: 42, w_: w, h_: 50,
  color: "#2d4664/1.00", pivot: 4, depth: 15, prefabMarker: true }]);
export function switchPrefabs() {
  const card = n("UICollectCard", [0, 0], [], [
    n("BG", [0, 0], [sprite("Common_Bg_Raius10px", 430, 560)]),
    n("Char_Portrait", [0, 0], [{ texture: "portrait", w_: 430, h_: 560, pivot: 4, depth: 8, prefabMarker: true }]),
    label("Label_CharName"),
    n("Sort", [0, -240], [], [n("Sprite", [0, 0], [sprite("Common_Bg_Raius10px", 430, 70, { color: "#d7eaf4/1.00", depth: 12 })]), label("Label_Schoolname")]),
    n("Btn_Pin", [150, -150], [], [n("Off"), n("On", [0, 0], [sprite("Common_Btn_Pin_01", 54, 54)])]),
    n("NewIcon", [170, 230], [sprite("Common_Bg_Raius10px", 30, 30)]),
    n("BG_Discover", [0, 0], [sprite("Common_Bg_Raius10px", 430, 560, { color: "#000000/0.55", depth: 20 })]),
    n("CharacterWeapon"),
  ]);
  return { unit: n("UICharacterCollectionPopulatorUnit", [0, 0], [], [n("Grid", [0, 0], [], [card])]),
    inventory: makeImportLayouts().UINonEquipmentInventory };
}
