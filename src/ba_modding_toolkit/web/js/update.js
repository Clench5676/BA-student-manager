// Update popup on the game's popup frame (UIPopup_Sort): the current and the new version, Later / Update.
// Updating downloads the build for this platform, checks its MD5, then the app quits and restarts as the new version.
import * as NGUI from "./ngui.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { S, clone, hitButton, toast } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;

export async function check(host) {
  let info = null;
  try { info = await rpc("app.checkUpdate"); } catch { return; } // offline: say nothing
  if (info) await show(host, info);
}

async function show(host, info) {
  const sort = await NGUI.layout("UIPopup_Sort");
  const t = clone(find(sort, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: 1500, h_: 820 });
  find(bg, "Texture_Top").pos = [-750 + 248, 410 - 66];
  const title = find(bg, "Label_Title_Locale");
  const tf = NGUI.fitText(T("update.title"), 72, 52, 1100);
  Object.assign(title.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1200 });
  title.pos = [0, 410 - 64];
  find(title, "Line").widgets[0].w_ = NGUI.glyphWidth(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").active = false;
  const btn = find(popup, "Btn");
  btn.pos = [0, -250];
  const installable = info.installable;
  find(btn, "Btn_Cancel/Label_Locale").widgets[0].text = T("update.later");
  find(btn, "Btn_Ok/Label_Locale").widgets[0].text = T(installable ? "update.now" : "update.page");
  for (const name of ["Btn_Cancel", "Btn_Ok"]) {
    const l = find(btn, `${name}/Label_Locale`).widgets[0];
    l.fontSize = NGUI.fitText(l.text, 64, 40, 380).fs;
  }
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.65";
  // the two versions on the game's light stats box
  const rows = [[T("update.current"), info.current.replace(/-dev$/, "")], [T("update.latest"), info.version]];
  const capW = Math.max(...rows.map(([k]) => NGUI.textWidth(k, 44))) + 60;
  popup.children.push(node("Box", [0, 90], [sprite("Common_Bg_Raius10px", 1300, 260, { depth: 5, color: "#ecf5f9/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", 1306, 266, { depth: 4, color: "#c0c9d4/1.00" })]),
    ...rows.flatMap(([k, v], i) => [
      node(`K_${i}`, [-600, 62 - i * 124], [label(k, 44, "#2d4664/1.00", capW, 60, { pivot: 3, depth: 8 })]),
      node(`V_${i}`, [-600 + capW, 62 - i * 124], [label(v, 48, i ? "#1f9a52/1.00" : "#000000/1.00", 1100 - capW, 60, { pivot: 3, depth: 8 })]),
    ]),
    node("Dots", [0, 0], [sprite("Common_Line_Dot", 1200, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]),
  ]));
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 2000 });
  const close = () => { host.hidden = true; host.innerHTML = ""; };
  const hit = (name, fn) => {
    const el = view.nodes.get(`Center/Popup/Btn/${name}/BG (1)`)?.els[0];
    if (el) hitButton(next, rect(el), fn, "", 2100);
  };
  hit("Btn_Cancel", close);
  hit("Btn_Ok", async () => {
    if (!installable) { close(); rpc("app.openReleasePage").catch(() => {}); return; }
    close();
    try {
      const id = await rpc("app.update");
      const result = await waitJob(id, (p) => toast(T("update.downloading", { p: p.total ? Math.floor((p.current / p.total) * 100) : 0 }), { sticky: true }));
      toast(T("update.restarting"), { sticky: true });
      await rpc("app.installUpdate", { file: result.file });
    } catch (err) {
      toast(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error" });
    }
  });
  host.replaceChildren(...next.childNodes);
}
