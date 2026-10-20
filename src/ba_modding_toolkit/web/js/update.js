// Update popup on the game's popup frame (UIPopup_Sort): the current and the new version, Later / Update.
// Updating downloads and verifies the build; Restart installs it only after a separate confirmation.
// check() resolves once the popup has closed, so the start popups come one at a time (popup.js sequence).
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { S, clone } from "./util.js";

const { node, sprite, label, find } = NGUI;

// resolves with what closed the popup: "later" (Later or Escape), "page" (the download page opened) or "update" (a
// failed update, once dismissed). A successful retry clears that failure; Restart quits the app on success.
// null without a newer release, offline or when the popup cannot be drawn. Settings may pass its check's result.
export async function check(host, info) {
  try { if (info === undefined) info = await rpc("app.checkUpdate"); } catch { return null; } // offline: say nothing
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
  let phase = info.installable && info.downloaded ? "ready" : "offer";
  let file = info.file, error = "", percent = 0, revision = 0;
  let buttons = [];
  const blocked = () => phase === "downloading" || phase === "installing";
  const close = (how) => {
    if (ended || blocked()) return false;
    ended = true;
    host.hidden = true;
    host.innerHTML = "";
    resolve(how === "later" && error ? "update" : how);
    return true;
  };
  // on the popup stack from the start: Escape is Later unless a job or restart is in progress
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
  find(btn, "Btn_Cancel/Label_Locale").widgets[0].text = T("update.later");
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
  popup.children.push(
    node("Status", [0, -94], [label("", 40, "#2d4664/1.00", 1250, 96, { depth: 8 })]),
    node("Progress", [0, -160], [sprite("Common_Bg_Raius10px", 1200, 20, { depth: 5, color: "#c0c9d4/1.00" })], [
      node("Fill", [-600, 0], [sprite("Common_Bg_Raius10px", 1200, 20, { pivot: 3, depth: 6, color: "#1f9a52/1.00" })]),
    ]),
  );

  async function render() {
    const rev = ++revision, locked = blocked();
    if (locked) for (const b of buttons) b.disabled = true;
    const tree = clone(t), body = find(tree, "Popup"), controls = find(body, "Btn");
    const action = !installable ? "page" : phase === "ready" || phase === "installing" ? "restart" : "update";
    const okText = T(action === "update" ? "update.now" : `update.${action}`);
    find(controls, "Btn_Ok/Label_Locale").widgets[0].text = okText;
    // one line on the slanted 496-wide body, shrinking long captions rather than running into the edges
    for (const name of ["Btn_Cancel", "Btn_Ok"]) {
      const l = find(controls, `${name}/Label_Locale`).widgets[0];
      const f = NGUI.fitText(l.text, 64, 34, 400, 1);
      Object.assign(l, { text: f.text, fontSize: f.fs });
      if (locked) {
        l.color = "#6e7c8d/1.00";
        for (const w of find(controls, `${name}/BG (1)`).widgets) w.color = "#aab4bf/1.00";
      }
    }
    const text = error || (phase === "downloading" ? T("update.downloading", { p: percent })
      : phase === "ready" ? T("update.complete") : phase === "installing" ? T("update.restarting") : "");
    const f = NGUI.fitText(text, 40, 30, 1250, 2);
    Object.assign(find(body, "Status").widgets[0], { text: f.text, fontSize: f.fs, color: error ? "#c74646/1.00" : "#2d4664/1.00" });
    const progress = find(body, "Progress");
    progress.active = phase === "downloading";
    find(progress, "Fill").active = percent > 0;
    find(progress, "Fill").widgets[0].w_ = 1200 * percent / 100;
    const next = document.createElement("div");
    const view = await NGUI.render(tree, next, { scale: S, origin: [960, 540], z: 2000 });
    if (ended || rev !== revision) return;
    const hit = (name, fn, caption, action) => Popup.hit(next, view, `Center/Popup/Btn/${name}/BG (1)`, fn, { name: caption, action, z: 2100 });
    buttons = [hit("Btn_Cancel", () => close("later"), T("update.later"), "later"),
      hit("Btn_Ok", () => act(action), okText, action)];
    for (const b of buttons) { b.disabled = locked; b.setAttribute("aria-disabled", String(locked)); }
    host.replaceChildren(...next.childNodes);
  }

  async function act(action) {
    if (ended || blocked()) return;
    if ((action === "update" && phase !== "offer") || (action === "restart" && phase !== "ready")) return;
    if (!installable) {
      if (close("page")) rpc("app.openReleasePage").catch(() => {});
      return;
    }
    const installing = phase === "ready";
    phase = installing ? "installing" : "downloading";
    error = "";
    percent = 0;
    try {
      await render();
      if (installing) {
        await rpc("app.installUpdate", { file });
        return; // the app quits and starts again as the new version
      }
      const result = await waitJob(await rpc("app.update"), (p) => {
        const next = p.total > 0 ? Math.max(0, Math.min(100, Math.floor(p.current / p.total * 100))) : 0;
        if (next === percent) return; // the popup is drawn again only when the number changes
        percent = next;
        render().catch((err) => console.error("update progress", err));
      });
      file = result.file;
      phase = "ready";
    } catch (err) {
      phase = installing ? "ready" : "offer";
      error = T(`error.${err.code || "internal"}`, err.params || {});
    }
    await render();
  }
  await render();
}
