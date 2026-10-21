// UICharacterCollection's search field and list tools, shared with Batch Import.
import { find } from "./ngui.js";
import { clone } from "./util.js";

export function searchTree(collection) {
  const box = clone(find(collection, "SeletControl/CharacterSearch"));
  const input = find(box, "SearchName/SearchNameArea/InputField");
  for (const c of input.children) c.widgets.find((w) => "text" in w).text = "";
  return box;
}

// Keep the roster's funnel line, expand marker, caption and inclined shadow together when the width changes.
export function sortBody(collection, fitted, width, filtered) {
  const body = clone(find(collection, "SeletControl/TopMenu/SortBtn/Btn_Normal"));
  const shrink = 622 - width;
  body.widgets.find((w) => "sprite" in w).w_ = width;
  for (const name of ["FilterMarker_Off", "FilterMarker_On"]) {
    const n = find(body, name);
    n.pos[0] += shrink / 2;
    find(n, "Icon").pos[0] -= shrink;
    find(n, "Filter_02").widgets[0].w_ -= shrink;
    n.active = (name === "FilterMarker_On") === filtered;
  }
  find(body, "Icon").pos[0] -= shrink / 2;
  find(body, "Type_1").active = false;
  const type2 = find(body, "Type_2");
  type2.active = true;
  Object.assign(find(type2, "Text").widgets[0], { text: fitted.text, fontSize: fitted.fs, w_: width - 120 });
  find(type2, "Text").pos[0] = 30;
  return body;
}

export function orderBody(collection, ascending) {
  const body = clone(find(collection, "SeletControl/TopMenu/OrderBtn/Btn_Normal"));
  find(body, "Icon_down").active = !ascending;
  find(body, "Icon_Up").active = ascending;
  return body;
}
