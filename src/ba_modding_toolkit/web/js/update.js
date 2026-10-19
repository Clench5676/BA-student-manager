// Update popup on the game's popup frame (UIPopup_Sort): the current and the new version, Later / Update.
// Updating downloads the build for this platform, checks its MD5, then the app quits and restarts as the new version.
// check() resolves once the popup has closed, so the start popups come one at a time (popup.js sequence).
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { S, clone, toast } from "./util.js";

const { node, sprite, label, find } = NGUI;

// resolves with what closed the popup: "later" (Later or Escape), "page" (the download page opened) or "update" (once
// the update has failed; one that works restarts the app); null without a newer release, offline or when the popup
// cannot be drawn
export async function check(host) {
  let info = null;
  try { info = await rpc("app.checkUpdate"); } catch { return null; } // offline: say nothing
  return info ? show(host, info) : null;
}

function show(host, info) {
  return new Promise((resolve) => {
    draw(host, info, resolve).catch((err) => {
      console.error("update popup", err);
      host.hidden = true;
      host.innerHTML = "";
      resolve(null);
    });
  });
}

async function draw(host, info, resolve) {
  host.hidden = false;
  let ended = false;
  const close = (how) => {
    if (ended) return false;
    ended = true;
    host.hidden = true;
    host.innerHTML = "";
    if (how) resolve(how);
    return true;
  };
  // on the popup stack from the start: Escape is Later, and nothing under the popup takes it
  Popup.opened(host, () => close("later"));
  const sort = await NGUI.layout("UIPopup_Sort");
  if (ended) return;
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
  const okText = T(installable ? "update.now" : "update.page");
  find(btn, "Btn_Cancel/Label_Locale").widgets[0].text = T("update.later");
  find(btn, "Btn_Ok/Label_Locale").widgets[0].text = okText;
  // one line on the slanted 496-wide body ("Open Download Page" shrinks rather than runs into the edges)
  for (const name of ["Btn_Cancel", "Btn_Ok"]) {
    const l = find(btn, `${name}/Label_Locale`).widgets[0];
    const f = NGUI.fitText(l.text, 64, 34, 400, 1);
    Object.assign(l, { text: f.text, fontSize: f.fs });
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
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 2000 });
  if (ended) return;
  const hit = (name, fn, caption, action) => Popup.hit(next, view, `Center/Popup/Btn/${name}/BG (1)`, fn, { name: caption, action, z: 2100 });
  hit("Btn_Cancel", () => close("later"), T("update.later"), "later");
  hit("Btn_Ok", async () => {
    if (!installable) {
      if (close("page")) rpc("app.openReleasePage").catch(() => {});
      return;
    }
    if (!close(null)) return;
    try {
      const id = await rpc("app.update");
      const result = await waitJob(id, (p) => toast(T("update.downloading", { p: p.total ? Math.floor((p.current / p.total) * 100) : 0 }), { sticky: true }));
      toast(T("update.restarting"), { sticky: true });
      await rpc("app.installUpdate", { file: result.file });
      // the app quits and starts again as the new version: nothing more to show
    } catch (err) {
      toast(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error" });
      resolve("update");
    }
  }, okText, installable ? "update" : "page");
  host.replaceChildren(...next.childNodes);
}
