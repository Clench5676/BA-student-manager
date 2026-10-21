// Synthetic complete branches for controls whose state is selected by the app.
export const n = (name, pos = [0, 0], widgets = [], children = []) => ({ name, active: true, pos, scale: [1, 1], widgets, children });
export const spr = (sprite, w_ = 400, h_ = 140, extra = {}) => ({ sprite, atlas: "Common", type: 0, w_, h_, pivot: 4, depth: 5, color: "#ffffff/1.00", ...extra });
export const lbl = (color = "#314665/1.00") => ({ text: "Caption", fontSize: 48, color, w_: 300, h_: 80, pivot: 4, depth: 23 });
export function insert(root, path, value) {
  let t = root;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    let child = t.children.find((c) => c.name === part);
    if (!child) { child = n(part); t.children.push(child); }
    t = child;
  }
  value.name = parts.at(-1); t.children.push(value); return value;
}
export function controls() {
  const body = (bright) => n("Body", [0, 0], [spr("Common_Btn_BG", 402, 136, { color: bright ? "#8de4ff/1.00" : "#d6d6d6/0.90" })], [
    n("Deco", [85, 10], [spr(bright ? "Common_Btn_Normal_B_S_Pt" : "Common_Btn_Normal_B_C_Pt", 244, 136)]),
    n("Deco (1)", [-85, 2], [spr(bright ? "Common_Btn_Normal_B_S_Pt" : "Common_Btn_Normal_B_C_Pt", 236, 131, { flip: 3, color: "#ffffff/0.75" })]),
  ]);
  const option = n("UIPopup_Option_PC"), filter = n("UIPopup_FilterSort");
  const button = body(true); button.children.push(n("Label_Locale", [0, 4], [lbl()]));
  insert(option, "Center/Popup/List/Sound_Setting/ETCSetting/ButtonBg", button);
  const disabled = n("Btn_Disable", [289, 0], [], [body(false), n("Label_Locale", [0, -2], [lbl("#828282/1.00")])]);
  disabled.children[0].name = "BG (1)"; disabled.active = false;
  insert(filter, "Center/Popup/Btn_Section/Btn_Disable", disabled);
  return { option, filter };
}
