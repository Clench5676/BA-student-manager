// First-launch consent for caching light game assets. Before consent the UI reads every game asset straight from the
// install (in memory). After consent only light UI assets (atlas sprites, UI textures, prefab layouts) are cached in
// the user data directory; portraits, memorial lobbies, models, voices and backgrounds are always read from the game
// files and never copied.
// Also the scan consent (scan()): whether the app may check the game files on its own (the start and the end of each
// portrait and memorial lobby file), asked once like the asset consent; Settings' Mods tab asks again or withdraws it.
import { notify } from "./popup.js";
import * as NGUI from "./ngui.js";
import * as Buttons from "./game-buttons.js";
import * as Popup from "./popup.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { setSpineConsent } from "./spine-runtime.js";
import { S, clone, hitButton, wrapPath } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
let assetsAllowed = false, spinePrompt = null;

// The licence prompt uses game assets only after the asset consent.
export function init(info) { assetsAllowed = info?.consent === true; }

// resolves with the choice (true / false) once a button is pressed; native: the folder picker is available
export async function show(host, cacheDir, native = false) {
  return new Promise((resolve) => draw(host, cacheDir, native, resolve));
}

async function draw(host, cacheDir, native, resolve) {
  await Buttons.ready();
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
  // the two captions share one size
  const labels = ["Btn_Cancel", "Btn_Ok"].map((name) => find(btn, `${name}/Label_Locale`).widgets[0]);
  NGUI.fitLabels(labels, labels.map((l) => l.text), 64, 40, 380, 2, { maxH: 140 });
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
  // where the cache goes, wrapped rather than cut, with the popup's light-blue Change button beside it
  const to = wrapPath(T("cacheTo", { path: cacheDir }), 40, 30, 1260, 2);
  const cached = row("Cached", 430, T("consent.cached.label"), [T("consent.cached.items")], "#2d4c72");
  const pathY = -212 - (to.lines - 1) * to.fs * 0.65;
  cached.children.push(
    node("Path", [-800, pathY], [label(to.text, to.fs, "#2d4664/1.00", 1290, to.fs * 1.3 * to.lines + 8, { pivot: 3, depth: 7 })]),
    Buttons.smallButton("Change", 700, pathY, T("consent.change"), { w: 230, h: 96, enabled: native, fs: 40, min: 28, depth: 8 }));
  popup.children.push(
    cached,
    row("Never", 90, T("consent.never.label"), [T("consent.never.items"), T("consent.never.how")], "#545454"),
    node("Note", [0, -260], [label(T("consent.note"), 36, "#6b7d92/1.00", 1700, 50, { depth: 7 })]),
  );
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 2000 });
  for (const [name, granted] of [["Btn_Cancel", false], ["Btn_Ok", true]]) {
    const el = view.nodes.get(`Center/Popup/Btn/${name}/BG (1)`)?.els[0];
    if (!el) continue;
    hitButton(next, rect(el), async () => {
      await rpc("app.consent", { granted });
      assetsAllowed = granted;
      host.hidden = true;
      host.innerHTML = "";
      resolve(granted);
    }, "", 2100);
  }
  const change = view.nodes.get("Center/Popup/Cached/Change")?.els[0];
  if (change && native) {
    hitButton(next, rect(change), async () => {
      try {
        const folder = await rpc("settings.pickFolder", { start: cacheDir });
        if (!folder) return;
        const prefs = await rpc("settings.set", { key: "cacheDir", value: folder });
        draw(host, prefs.cacheDir, native, resolve);
      } catch (err) {
        notify(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error", error: err });
      }
    }, T("consent.change"), 2100);
  }
  host.replaceChildren(...next.childNodes);
}

// Separate from the asset and file-scan consents: no Spine code is loaded by this prompt.
export function spine(host, { over = false } = {}) {
  if (spinePrompt) return spinePrompt;
  spinePrompt = new Promise((resolve) => {
    drawSpine(host, over, resolve).catch((err) => {
      console.error("Spine consent", err);
      finishScan(host);
      resolve(null);
    });
  }).finally(() => { spinePrompt = null; });
  return spinePrompt;
}

async function drawSpine(host, over, resolve) {
  let choosing = false;
  const choose = async (granted) => {
    if (choosing) return;
    choosing = true;
    try { await rpc("app.spineConsent", { granted }); }
    catch (err) { choosing = false; notify(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error", error: err }); return; }
    setSpineConsent(granted);
    finishScan(host);
    resolve(granted);
  };
  host.classList.toggle("over", over);
  host.hidden = false;
  Popup.opened(host, null);
  const next = document.createElement("div");
  if (!assetsAllowed) {
    const back = document.createElement("div");
    back.className = "plain-popup-back";
    const box = document.createElement("div");
    box.className = "plain-popup spine-license-plain";
    for (const [tag, key] of [["h2", "title"], ["p", "body"]]) {
      const el = document.createElement(tag);
      el.textContent = T(`spine.license.${key}`);
      box.appendChild(el);
    }
    const row = document.createElement("div");
    row.className = "message-actions";
    for (const [granted, key, action] of [[false, "no", "cancel"], [true, "yes", "ok"]]) {
      const button = document.createElement("button");
      button.className = "message-button";
      button.textContent = T(`spine.license.${key}`);
      button.setAttribute("aria-label", button.textContent);
      button.dataset.action = action;
      button.addEventListener("click", () => choose(granted));
      row.appendChild(button);
    }
    box.appendChild(row);
    next.appendChild(back);
    next.appendChild(box);
  } else {
    const sort = await NGUI.layout("UIPopup_Sort");
    const { tree, popup } = consentFrame(sort, T("spine.license.title"), 1900, 860, [T("spine.license.no"), T("spine.license.yes")]);
    const body = NGUI.fitText(T("spine.license.body"), 48, 40, 1660, 3);
    popup.children.push(node("Licence", [0, 30], [label(body.text, body.fs, "#2d4664/1.00", 1680, body.lines * body.fs * 1.3 + 8, { depth: 7 })]));
    const view = await NGUI.render(tree, next, { scale: S, origin: [960, 540], z: 2000 });
    for (const [name, granted, key] of [["Btn_Cancel", false, "no"], ["Btn_Ok", true, "yes"]]) {
      Popup.hit(next, view, `Center/Popup/Btn/${name}/BG (1)`, () => choose(granted), {
        name: T(`spine.license.${key}`), action: granted ? "ok" : "cancel", z: 2100,
      });
    }
  }
  host.replaceChildren(...next.childNodes);
}

// --- the scan consent (decision 10) ---

// the popup frame of the asset consent at a size, its title and two buttons: [cancel, ok] captions
function consentFrame(sort, title, w, h, [no, yes]) {
  const t = clone(find(sort, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: w, h_: h });
  find(bg, "Texture_Top").pos = [-w / 2 + 248, h / 2 - 66];
  const titleNode = find(bg, "Label_Title_Locale");
  const tf = NGUI.fitText(title, 72, 52, w - 600);
  Object.assign(titleNode.widgets[0], { text: tf.text, fontSize: tf.fs, w_: w - 500 });
  titleNode.pos = [0, h / 2 - 64];
  find(titleNode, "Line").widgets[0].w_ = NGUI.glyphWidth(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").active = false;
  const btn = find(popup, "Btn");
  btn.pos = [0, -h / 2 + 160];
  // the two captions share one size
  NGUI.fitLabels(["Btn_Cancel", "Btn_Ok"].map((name) => find(btn, `${name}/Label_Locale`).widgets[0]), [no, yes], 64, 40, 380, 2, { maxH: 140 });
  find(t, "BlackBg/BlackBgClickArea").widgets.find((x) => "sprite" in x).color = "#000000/0.65";
  return { tree: t, popup };
}

// a white section with the game's title bar and its lines (each wrapped to two lines at most); returns [node, height]
function section(name, top, titleText, items, tone, w = 1740) {
  // every line at the rows' size, a long one on two lines
  const lines = items.map((item) => NGUI.fitText(item, 40, 40, w - 140, 2));
  const h = 120 + lines.reduce((a, f) => a + f.lines * f.fs * 1.3 + 14, 0) + 20;
  let y = -120;
  const kids = lines.map((f, i) => {
    const lh = f.lines * f.fs * 1.3;
    const n = node(`Item_${i}`, [-w / 2 + 70, y - lh / 2], [label(f.text, f.fs, "#2d4664/1.00", w - 140, lh + 8, { pivot: 3, depth: 7 })]);
    y -= lh + 14;
    return n;
  });
  return [node(name, [0, top], [], [
    node("Bg", [0, 0], [sprite("Common_Nonoutline_W_Bg", w, h, { pivot: 1, depth: 4 })]),
    node("Title_Bg", [-w / 2 + 20, -56], [sprite("Common_Bg_Raius10px", w - 40, 73, { pivot: 3, depth: 5, color: `${tone}/1.00`, incline: 10 })], [
      node("Deco", [28.8, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", type: 0 })]),
      node("Label", [40, 0], [label(titleText, 46, "#ffffff/1.00", w - 240, 50, { pivot: 3, depth: 7 })]),
    ]),
    ...kids,
  ]), h];
}

// scan(host, {over}): the scan consent popup ("Check Game Files"): what is checked and what for, what never happens,
// and that declining keeps those checks off (Settings changes it). Resolves with the choice once a button is pressed:
// Allow saves consent and requests a scan. Don't Allow saves the refusal; declining does
// not quit. It must be answered: Escape and the backdrop do nothing. over: drawn over the settings and the message
// popups (opened from Settings' Check Game Files).
export function scan(host, { over = false } = {}) {
  return new Promise((resolve) => { drawScan(host, over, resolve).catch((err) => { console.error("scan consent", err); finishScan(host); resolve(null); }); });
}

function finishScan(host) {
  host.hidden = true;
  host.innerHTML = "";
  host.classList.remove("over");
  Popup.closed(host);
}

async function drawScan(host, over, resolve) {
  const sort = await NGUI.layout("UIPopup_Sort");
  const W = 1900;
  const [checked, hc] = section("Checked", 0, T("mods.scan.will.label"), [T("mods.scan.will.items")], "#2d4c72");
  const [never, hn] = section("Never", 0, T("mods.scan.willNot.label"), [T("mods.scan.willNot.items")], "#545454");
  const note = NGUI.fitText(T("mods.scan.note"), 36, 28, 1700, 2);
  const noteH = note.lines * note.fs * 1.3;
  // the title 170, the sections with a gap, the note, the buttons 320
  const H = Math.max(1000, 170 + hc + 50 + hn + 40 + noteH + 320);
  const { tree, popup } = consentFrame(sort, T("mods.scan.title"), W, H, [T("mods.scan.no"), T("mods.scan.yes")]);
  let y = H / 2 - 170;
  checked.pos = [0, y];
  y -= hc + 50;
  never.pos = [0, y];
  y -= hn + 40;
  popup.children.push(checked, never, node("Note", [0, y - noteH / 2], [label(note.text, note.fs, "#6b7d92/1.00", 1700, noteH + 8, { depth: 7 })]));
  host.classList.toggle("over", over);
  host.hidden = false;
  // on the popup stack, to be answered with a button: Escape does nothing, and nothing under it acts
  Popup.opened(host, null);
  const next = document.createElement("div");
  const view = await NGUI.render(tree, next, { scale: S, origin: [960, 540], z: 2000 });
  // the buttons over the drawn ones (placed from the prefab when a sprite is missing, so it can still be answered)
  for (const [name, granted, caption] of [["Btn_Cancel", false, T("mods.scan.no")], ["Btn_Ok", true, T("mods.scan.yes")]]) {
    Popup.hit(next, view, `Center/Popup/Btn/${name}/BG (1)`, async () => {
      try {
        await rpc("mods.consent", { granted });
      } catch (err) {
        notify(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error", error: err });
        return;
      }
      finishScan(host);
      resolve(granted);
    }, { name: caption, action: granted ? "ok" : "cancel", z: 2100 });
  }
  host.replaceChildren(...next.childNodes);
}
