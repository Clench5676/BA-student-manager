// Authored stand-ins for the runtime layout contract, not exported game trees or assets.
// Marker fields prove that the page preserves the prefab widgets rather than rebuilding them from sprite names.
export const node = (name, pos = [0, 0], widgets = [], children = []) => ({ name, active: true, pos, widgets, children, scale: [1, 1] });
const sprite = (name, w_ = 100, h_ = 100, extra = {}) => ({ sprite: name, w_, h_, pivot: 4, color: "#ffffff/1.00", depth: 7, prefabMarker: true, ...extra });
const label = (name, text = "sample", extra = {}) => node(name, [0, 0], [{ text, fontSize: 48, w_: 800, h_: 60, pivot: 4, color: "#2c4663/1.00", depth: 22, prefabMarker: true, ...extra }]);
const image = (name) => node(name, [0, 0], [{ texture: "stand-in", w_: 304, h_: 321, color: "#ffffff/1.00", prefabMarker: true }]);
const find = (tree, path) => path.split("/").reduce((n, part) => n?.children.find((c) => c.name === part), tree);
function insert(tree, path, n) {
  const parts = path.split("/"); let parent = tree;
  for (const part of parts.slice(0, -1)) {
    let child = parent.children.find((c) => c.name === part);
    if (!child) { child = node(part); parent.children.push(child); }
    parent = child;
  }
  n.name = parts.at(-1); parent.children.push(n); return n;
}
function button(name, primary = false, disabled = false) {
  const bg = node(primary ? "BG" : name, [0, 0], [sprite("Common_Btn_BG", primary ? 372 : 348, primary ? 166 : 162,
    { incline: 10, color: disabled ? "#d6d6d6/0.90" : primary ? "#ffee00/0.94" : "#77deff/1.00" })], [
    node("Pt", [52.1, 2.4], [sprite(`Common_Btn_Normal_${disabled ? "B_C" : primary ? "Y_S" : "B_S"}_Pt`, 252, 140)]),
  ]);
  if (primary) return node(name, [0, 0], [], [bg, label(disabled ? "Text" : "Label_Locale_Use", "use", { fontSize: 72 })]);
  bg.children.push(label("Label_Locale", "receive", { fontSize: 60 })); return bg;
}
export function makeImportLayouts() {
  const inv = node("UINonEquipmentInventory"), mail = node("UIMailBox"), content = node("UIMailBoxContent"), fs = node("UIPopup_FilterSort");
  const base = "Inventory_ListControl", list = `${base}/RightCanvas/ListBG`, detail = `${base}/Left_Info/EquipInfo/Equip_Target`;
  insert(inv, `${base}/BG`, image("BG"));
  insert(inv, `${base}/EquipPos`, node("EquipPos", [0, 0], [], [image("Texture"), image("BGCilcle")]));
  insert(inv, `${detail}/Text_Type`, label("Text_Type", "type"));
  insert(inv, `${detail}/Text_Type/TypeBG`, node("TypeBG", [0, 0], [sprite("Common_Bg_Raius10px")]));
  const tag = find(inv, `${detail}/Text_Type`); tag.scale = [1.001, 1.001];
  Object.assign(tag.widgets[0], { fontSize: 46, w_: 106, h_: 44, pivot: 3 });
  const tagBG = find(tag, "TypeBG"); tagBG.pos = [-26, 1]; Object.assign(tagBG.widgets[0], { w_: 170, h_: 86, pivot: 3 });
  Object.assign(find(inv, `${base}/EquipPos/Texture`).widgets[0], { w_: 551, h_: 435, pivot: 4 });
  insert(inv, `${detail}/Label_Name`, label("Label_Name", "Name", { fontSize: 104 }));
  insert(inv, `${detail}/Text_Amount`, label("Text_Amount", "x999", { color: "#77deff/1.00" }));
  insert(inv, `${detail}/BG`, node("BG", [17, 98], [sprite("Common_Bg_Raius20px", 1246, 204, { color: "#1a3351/0.99" })], [node("HaveBG"), image("Texture")]));
  insert(inv, `${detail}/Label_ExpirationDateTime/TypeBG`, node("TypeBG", [0, 0], [sprite("Common_Bg_Raius10px", 438, 64, { color: "#eb5691/1.00" })]));
  insert(inv, `${base}/RightCanvas/Bottom/Use/UseBtn`, button("UseBtn", true));
  insert(inv, `${base}/RightCanvas/Bottom/None/UseBtn`, button("UseBtn", true, true));
  const panel = insert(inv, list, node("ListBG", [0, 0], [sprite("Common_Gacha_Bg", 1384, 1802)]));
  panel.children.push(node("PaperBG", [-2, -60], [sprite("Common_Bg_Raius10px", 1375, 1650)]), node("Inbox", [0, -60], [sprite("Common_Bg_Raius10px", 1339, 1620)]));
  insert(inv, `${list}/Inbox/ListEmpty/Label_Locale_EmptyMessage`, label("Label_Locale_EmptyMessage"));
  const header = insert(inv, `${list}/BG_Top_Widget`, node("BG_Top_Widget", [0, 440]));
  const title = label("Label_Locale_Title", "List", { fontSize: 62, w_: 118, h_: 60, pivot: 3 }); title.pos = [-651.5, 390.6]; header.children.push(title);
  header.children.push(node("OrderBtn", [582.4, 386.9], [], [node("Btn_Normal", [-8, 0], [sprite("Common_Bg_Raius5px_Shadow", 168, 116, { incline: 10 })],
    [node("Icon_down", [11.3, 8.5], [sprite("Common_Icon_Order", 99, 47)]), node("Icon_Up", [11.3, 8.5], [sprite("Common_Icon_Order", 99, 47, { flip: 2 })])])]));
  const markers = ["FilterMarker_Off", "FilterMarker_On"].map((name) => node(name, [-181, 26], [], [
    node("Icon", [384, 4.5], [sprite("Common_Icon_Expend", 30, 30)]), node("Filter_01", [-43, 33], [sprite("Common_Icon_Filter_01", 86, 66, { pivot: 0 })]),
    node("Filter_02", [-30, 33], [sprite("Common_Icon_Filter_02", 445, 6, { pivot: 0 })]),
  ]));
  const sort = node("SortBtn", [258.7, 386.9], [], [node("Btn_Normal", [0, 0], [sprite("Common_Bg_Raius5px_Shadow", 456, 116, { incline: 10 })], [
    ...markers, node("Icon", [203, 30], [sprite("Common_Icon_Expend", 30, 30)]), node("Type_1", [16.5, 0]),
    node("Type_2", [16.5, 0], [], [node("Text", [0, 5], [{ text: "center", fontSize: 56, w_: 336, h_: 54, pivot: 4, prefabMarker: true }])]),
  ])]); sort.scale = [1.001, 1.001]; header.children.push(sort);
  header.children.push(node("SearchBtn", [-36, 386], [], ["Btn_Normal", "Btn_Pressed"].map((name) => node(name, [0, 0], [sprite("Common_Bg_Raius5px_Shadow", 124, 116, { incline: 10 })], [
    node("Icon_Search", [2, 6], [sprite("Common_Icon_Search", 64, 66)]),
  ]))));
  insert(inv, `${list}/Inbox/SearchInfo/SearchName/SearchNameArea`, node("SearchNameArea", [1, -20], [{ cls: "UIRect" }, sprite("Common_Bg_Raius10px", 1296, 112, { pivot: 1 })], [
    node("BG_Line", [0, -56], [sprite("Common_line_10px", 1296, 112)]), node("Icon_Search", [-586, -56], [{ cls: "UIRect" }, sprite("Common_Icon_Search", 64, 66)]), node("Btn_Close", [588, -56], [sprite("Common_Icon_Close", 50, 50)]),
    node("InputField", [0, -56], [], [label("Label_Search", "", { fontSize: 60, w_: 778, h_: 58, color: "#1f3f5f/1.00" }), label("Label_Locale_Input", "Text", { fontSize: 55, w_: 778, h_: 50 })]),
  ]));
  find(inv, `${list}/Inbox/SearchInfo`).pos = [0, 810];
  insert(mail, "Right/Label_Amount", label("Label_Amount", "200/200", { fontSize: 54, w_: 318, h_: 64, pivot: 2 }));
  insert(mail, "Bottom/ObjectsDisplayed_Unread/Label_Locale", label("Label_Locale", "note", { pivot: 3 }));
  const receive = insert(mail, "Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn", button("Btn", false));
  receive.widgets[0].color = "#f6e94b/1.00";
  const disabled = insert(mail, "Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn_Disable", button("Btn_Disable", false, true));
  disabled.children.push(node("Pt (1)", [-52, 3], [sprite("Common_Btn_Normal_B_C_Pt", 252, 140, { color: "#ffffff/0.80" })]));
  disabled.children.at(-1).scale = [-1, -1];
  for (const name of ["List_01", "List_02"]) {
    const row = node(name, [0, 0], [], [node("BG", [0, 0], [sprite("Campaign_List_Normal", 2208, 329)]), image("Deco"), node("Line", [-760.8, 50], [sprite("Common_Square_Bg", 1842, 4)]),
      node("BG_Icon", [-897.9, 4], [sprite("Common_Circle_Bg", 304, 322)], [image("Icon_Arona")]), label("Label_System", "Title"), label("Label_From", "From"), label("Label_Locale_Received", "day")]);
    find(row, "BG_Icon").widgets[0].pivot = 3;
    find(row, "BG_Icon/Icon_Arona").pos = [-17.7, 0];
    find(row, "Label_System").pos = [-762, 99]; Object.assign(find(row, "Label_System").widgets[0], { fontSize: 62, w_: 1688, h_: 93, pivot: 3 });
    find(row, "Label_Locale_Received").pos = [-759.8, -22.7]; find(row, "Label_Locale_Received").widgets[0].pivot = 3;
    if (name === "List_01") row.children.push(label("Label_Locale_Limit", "limit"), node("TimeLimit", [0, 0], [], [node("Bg", [0, 0], [sprite("Common_Bg_Raius10px", 220, 54)]), label("Label_Locale_TimeLimit")]), button("Btn_Receive"));
    content.children.push(row);
  }
  const filterPath = "Center/Popup/Filter/ScrollView/Filter_List/Table_List/UIFilterObjectList_1";
  insert(fs, `${filterPath}/Label_Title`, label("Label_Title", "TEXT"));
  insert(fs, `${filterPath}/Table_Align/Table_ListUnit/UIFilterObjectListUnit_1/UIFilter_CheckBox`, node("UIFilter_CheckBox", [0, 0], [], [
    node("Bg", [-50, 0], [sprite("Common_line_10px", 100, 100, { pivot: 3 })]), node("CheckBoxIcon", [0, 0], [sprite("Common_Icon_Check_B", 82, 80)]), node("CheckBoxIcon_Disable", [0, 0], [sprite("Common_Icon_Check_B", 82, 80, { color: "#96aac3/0.66" })]),
  ]));
  insert(fs, "Center/Popup/Sort/Scroll View/Sort_Normal/Option_Normal/Grid/UISortObjectListUnit/Label_Text", node("Label_Text", [0, 0], [], [node("BG", [0, 0], [sprite("Common_Btn_Radio_BG", 60, 60)]), node("On", [0, 0], [sprite("Common_Btn_Radio_On", 60, 60)], [label("Label_On")]), label("Label_On"), node("Line", [0, -87], [sprite("Common_Square_Bg", 504, 4)])]));
  const item = node("UINonEquipmentInventoryListItem", [0, 0], [], [node("Card", [0, 0], [], [node("Normal", [0, 0], [], [node("Cover_Select", [0, -0.6], [sprite("Card_Select_Line", 240, 220)], [{ name: "Bare", active: true, pos: [0, 0], scale: [1, 1], widgets: [] }])])])]);
  const state = (name) => node(name, [178, -3.2], [], [node("Check", [-120, 8], [sprite(`Check_${name}`, 74, 72)]), label("Caption")]);
  const caption = label("Locale_Text", "unowned", { pivot: 3, color: "#484e52/1.00" }); caption.pos = [131, 2.8];
  const toggle = node("UIPopup_GachaCharList.Btn_Checkbox", [-1385, 598], [sprite("Common_Toggle_BG", 798, 110, { pivot: 3 })],
    [state("Type_OFF"), state("Type_ON"), caption]);
  return { UINonEquipmentInventory: inv, UIMailBox: mail, UIMailBoxContent: content, UIPopup_FilterSort: fs, UINonEquipmentInventoryListItem: item,
    "UIPopup_GachaCharList.Btn_Checkbox": toggle };
}
export { find };

// Flatten the stand-in NGUI tree like ngui.js, retaining positions, labels, widget sizes and render metadata.
export async function renderImportTree(tree, host, { scale = 1, origin = [0, 0] } = {}) {
  const nodes = new Map();
  function walk(n, path = "", x = 0, y = 0, sx = 1, sy = 1) {
    if (!n.active) return;
    const p = path ? `${path}/${n.name}` : n.name;
    x += n.pos[0] * sx; y += n.pos[1] * sy; sx *= n.scale[0]; sy *= n.scale[1];
    const entry = { node: n, stage: [origin[0] + x * scale, origin[1] - y * scale], els: [] }; nodes.set(p, entry);
    for (const w of n.widgets) {
      if (!("w_" in w) || !("text" in w || "sprite" in w || "texture" in w)) continue;
      const e = document.createElement("div"); e.textContent = w.text || ""; e.dataset.path = p;
      Object.assign(e.style, { left: `${entry.stage[0] - [0, .5, 1, 0, .5, 1, 0, .5, 1][w.pivot ?? 4] * w.w_ * sx * scale}px`,
        top: `${entry.stage[1] - [0, 0, 0, .5, .5, .5, 1, 1, 1][w.pivot ?? 4] * w.h_ * sy * scale}px`,
        width: `${w.w_ * sx * scale}px`, height: `${w.h_ * sy * scale}px` });
      if ("clipImage" in w) {
        Object.assign(e.style, { overflow: "hidden", borderRadius: `${w.radius * sy * scale}px`, transform: `skewX(${-w.incline}deg)` });
        const picture = document.createElement("div");
        Object.assign(picture.style, { left: w.imgLeft, width: w.imgWidth, height: w.imgHeight,
          backgroundSize: w.imgSize, backgroundPosition: w.imgPosition, transform: `skewX(${w.incline}deg)` });
        e.appendChild(picture);
      }
      host.appendChild(e); entry.els.push(e);
    }
    n.children?.forEach((c) => walk(c, p, x, y, sx, sy));
  }
  walk(tree); return { nodes, scale, origin };
}
