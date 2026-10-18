// First-launch consent for caching light game assets. Before consent the UI reads every game asset straight from the
// install (in memory). After consent only light UI assets (atlas sprites, UI textures, prefab layouts) are cached in
// the user data directory; portraits, memorial lobbies, models, voices and backgrounds are always read from the game
// files and never copied.
import * as NGUI from "./ngui.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { S, clone, hitButton } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;

// resolves with the choice (true / false) once a button is pressed
export async function show(host, cacheDir) {
  const sort = await NGUI.layout("UIPopup_Sort");
  const t = clone(find(sort, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: 1900, h_: 1180 });
  find(bg, "Texture_Top").pos = [-950 + 248, 590 - 66];
  const title = find(bg, "Label_Title_Locale");
  const tf = NGUI.fitText(T("consent.title"), 72, 52, 1300);
  Object.assign(title.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1400 });
  title.pos = [0, 590 - 64];
  find(title, "Line").widgets[0].w_ = NGUI.glyphWidth(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").active = false;
  const btn = find(popup, "Btn");
  btn.pos = [0, -430];
  find(btn, "Btn_Cancel/Label_Locale").widgets[0].text = T("consent.no");
  find(btn, "Btn_Ok/Label_Locale").widgets[0].text = T("consent.yes");
  for (const name of ["Btn_Cancel", "Btn_Ok"]) {
    const l = find(btn, `${name}/Label_Locale`).widgets[0];
    l.fontSize = NGUI.fitText(l.text, 64, 40, 380).fs;
  }
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.65";
  // two rows: what is cached, what never is; each a white section with the game's title bar
  const row = (name, y, titleText, items, tone) => node(name, [0, y], [], [
    node("Bg", [0, 0], [sprite("Common_Nonoutline_W_Bg", 1740, 300, { pivot: 1, depth: 4 })]),
    node("Title_Bg", [-850, -56], [sprite("Common_Bg_Raius10px", 1700, 73, { pivot: 3, depth: 5, color: `${tone}/1.00`, incline: 10 })], [
      node("Deco", [28.8, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", type: 0 })]),
      node("Label", [40, 0], [label(titleText, 46, "#ffffff/1.00", 1500, 50, { pivot: 3, depth: 7 })]),
    ]),
    ...items.map((item, i) => node(`Item_${i}`, [-800, -150 - i * 62], [label(item, 40, "#2d4664/1.00", 1600, 50, { pivot: 3, depth: 7 })])),
  ]);
  popup.children.push(
    row("Cached", 430, T("consent.cached.label"), [T("consent.cached.items"), cacheDir], "#2d4c72"),
    row("Never", 90, T("consent.never.label"), [T("consent.never.items"), T("consent.never.how")], "#545454"),
    node("Note", [0, -260], [label(T("consent.note"), 36, "#6b7d92/1.00", 1700, 50, { depth: 7 })]),
  );
  host.hidden = false;
  host.innerHTML = "";
  const view = await NGUI.render(t, host, { scale: S, origin: [960, 540], z: 2000 });
  return new Promise((resolve) => {
    for (const [name, granted] of [["Btn_Cancel", false], ["Btn_Ok", true]]) {
      const el = view.nodes.get(`Center/Popup/Btn/${name}/BG (1)`)?.els[0];
      if (!el) continue;
      hitButton(host, rect(el), async () => {
        await rpc("app.consent", { granted });
        host.hidden = true;
        host.innerHTML = "";
        resolve(granted);
      }, "", 2100);
    }
  });
}
