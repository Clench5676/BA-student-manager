// Update popup on the game's popup frame (UIPopup_Sort): the current and the new version, Later / Update.
// Updating downloads and verifies the build; Restart installs it only after a separate confirmation.
// check() resolves once the popup has closed; automatic checks wait for beforeShow without holding a screen.
import * as Buttons from "./game-buttons.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { S, clone } from "./util.js";

const { node, sprite, label, find } = NGUI;
const checks = new WeakMap();
const RESTART_WAIT = 3000;

// Literal text on the same UIPopup_Sort frame used by notices. No HTML, Markdown images or update jobs.
export async function releaseNotes(info) {
  const notes = typeof info.notes === "string" ? info.notes.trim() : "";
  const result = await Popup.message({ title: `${T("update.notes")} - ${info.version}`,
    lines: notes ? notes.split(/\r?\n/) : [T("update.notesEmpty")], plain: true, scroll: true, width: 2458,
    sharedButtonSize: true, buttons: [{ label: T("update.releasePage"), value: "page" },
      { label: T("display.close"), value: "dismiss" }] });
  if (result.button === "page") await rpc("app.openReleasePage", { page: info.page });
}

// resolves with what closed the popup: "later" (Later or Escape), "page" (the download page opened) or "update" (a
// failed update, once dismissed). A successful retry clears that failure; Restart quits the app on success.
// null without a newer release, offline or when the popup cannot be drawn. Settings may pass its check's result.
export function check(host, info, { onCheck, onError, beforeShow } = {}) {
  const observe = (checked) => {
    if (onCheck || onError) checked.then(onCheck, onError).catch((err) => console.error("update check", err));
  };
  if (checks.has(host)) {
    const current = checks.get(host);
    observe(current.checked);
    return current.done;
  }
  // Reserve the host before asking the server, including checks that have not drawn their popup yet.
  const checked = Promise.resolve().then(() => info === undefined ? rpc("app.checkUpdate") : info);
  observe(checked);
  const done = checked.then(async (release) => {
    if (!release) return null;
    await beforeShow?.();
    return show(host, release);
  }, () => null).finally(() => checks.delete(host)); // automatic checks stay quiet when offline
  checks.set(host, { checked, done });
  return done;
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
  await Buttons.ready();
  const sort = await NGUI.layout("UIPopup_Sort");
  if (ended) return;
  const t = clone(find(sort, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: 1700, h_: 820 });
  find(bg, "Texture_Top").pos = [-850 + 248, 410 - 66];
  const title = find(bg, "Label_Title_Locale");
  const tf = NGUI.fitText(T("update.title"), 72, 52, 1100);
  Object.assign(title.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1200 });
  title.pos = [0, 410 - 64];
  find(title, "Line").widgets[0].w_ = NGUI.glyphWidth(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").active = false;
  const btn = find(popup, "Btn");
  btn.pos = [0, -274];
  const notesButton = clone(find(btn, "Btn_Cancel"));
  notesButton.name = "Btn_Notes";
  find(notesButton, "Label_Locale").widgets[0].text = T("update.notes");
  btn.children.push(notesButton);
  for (const [name, x] of [["Btn_Cancel", -550], ["Btn_Notes", 0], ["Btn_Ok", 550]]) {
    find(btn, name).pos = [x, 0];
  }
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
    // one line on the slanted 496-wide bodies, shrinking long captions rather than running into the edges; all three share one size
    const names = ["Btn_Cancel", "Btn_Notes", "Btn_Ok"];
    const captions = names.map((name) => find(controls, `${name}/Label_Locale`).widgets[0]);
    NGUI.fitLabels(captions, captions.map((l) => l.text), 64, 34, 400, 1);
    for (const name of names) {
      if (locked) {
        const index = controls.children.findIndex((child) => child.name === name);
        controls.children[index] = Buttons.disable(controls.children[index]);
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
      hit("Btn_Notes", () => releaseNotes(info).catch((err) => console.error("release notes", err)), T("update.notes"), "notes"),
      hit("Btn_Ok", () => act(action), okText, action)];
    for (const b of buttons) { b.disabled = locked; b.setAttribute("aria-disabled", String(locked)); }
    host.replaceChildren(...next.childNodes);
  }

  async function act(action) {
    if (ended || blocked()) return;
    if ((action === "update" && phase !== "offer") || (action === "restart" && phase !== "ready")) return;
    if (!installable) {
      if (close("page")) rpc("app.openReleasePage", { page: info.page }).catch(() => {});
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
        await new Promise((resolve) => setTimeout(resolve, RESTART_WAIT));
        // A successful quit destroys this page. If it is still here, allow dismissal and another Restart.
        phase = "ready";
        error = T("error.update_restart_failed");
        await render();
        return;
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
