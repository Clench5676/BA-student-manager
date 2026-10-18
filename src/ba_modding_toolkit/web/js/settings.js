// Settings, on the game's PC options popup (UIPopup_Option_PC): tabs on the left, the white panel on the right with
// the game's option rows: radio rows (UIPopup_Option_Toggle), the sound slider row (UIPopup_Option_SoundToggle), and
// folder rows built from the same pieces (title with its tag, dotted line, the value, the popup's light-blue buttons).
import * as NGUI from "./ngui.js";
import { rpc } from "./api.js";
import { T, platform } from "./i18n.js";
import { $, S, clone, glyphsOf, hitButton, toast } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);
const TABS = ["general", "sound", "folders"];
const CONTENT = { x: 209, top: 375, w: 1576, h: 854 }; // the panel's inner list area (List/BG), units
const ROW_W = 1552;

let layout = null, prefs = null, tab = "general", scroll = 0, onChange = null, token = 0;

const errorText = (err) => T(`error.${err.code || "internal"}`, err.params || {});
async function call(fn) {
  try { return await fn(); } catch (err) { toast(errorText(err), { kind: "error" }); return null; }
}

// --- rows ---

function titleNode(text, y = 65) {
  const f = fitText(text, 50, 40, 900);
  return node("Title", [-718.5, y], [label(f.text, f.fs, "#506e8e/1.00", 1100, 76, { pivot: 3, depth: 8 })], [
    node("TagDeco", [-13, 5.2], [sprite("Common_Square_Bg", 6, 45, { depth: 9, color: "#5cd3ff/1.00" })]),
  ]);
}

// the popup's light-blue button (ETCSetting/ButtonBg), smaller
function buttonNode(name, x, y, caption, { w = 300, h = 112, enabled = true } = {}) {
  const f = fitText(caption, 44, 30, w - 60);
  return node(name, [x, y], [sprite("Common_Btn_BG", w, h, { incline: 10, depth: 10, color: enabled ? "#8de4ff/1.00" : "#dfe5ea/1.00" })], [
    node("Deco", [w * 0.21, 10], [sprite("Common_Btn_Normal_B_S_Pt", w * 0.6, h, { type: 0, depth: 11, color: "#ffffff/1.00" })]),
    node("Label", [0, 3], [label(f.text, f.fs, enabled ? "#314665/1.00" : "#9aa3ad/1.00", w - 30, h - 20, { depth: 12 })]),
  ]);
}

// a row: the white body with the title and its dotted line; returns [tree, height, hits]
function rowBase(name, y, h, title) {
  return node(name, [0, y], [sprite("Common_Bg_Raius5px", ROW_W, h, { depth: 5, color: "#ffffff/1.00" })], [
    titleNode(title, h / 2 - 55),
    node("DotLine", [-759.7, h / 2 - 109], [sprite("Common_Dotline", 1523, 4, { pivot: 3, type: 2, depth: 6, color: "#ffffff/1.00" })]),
  ]);
}

// radio options in a row (the game's On / Off toggles, as many as needed)
function radioRow(name, y, title, options, selected, onPick) {
  const h = 240, row = rowBase(name, y, h, title), hits = [];
  const pitch = Math.min(508, 1400 / options.length);
  options.forEach(([value, text], i) => {
    const x = -689 + i * pitch, on = value === selected;
    const f = fitText(text, 48, 34, pitch - 110);
    row.children.push(node(`Opt_${i}`, [x, -h / 2 + 65.5], [], [
      node("BG", [0, 0], [sprite("Common_Btn_Radio_BG", 60, 60, { type: 0, depth: 25 })]),
      ...(on ? [node("On", [0, 0], [sprite("Common_Btn_Radio_On", 60, 60, { type: 0, depth: 26 })])] : []),
      node("Label", [49, -5], [label(f.text, f.fs, `#2c4663/${on ? "1.00" : "0.71"}`, pitch - 90, 50, { pivot: 3, depth: 26 })]),
    ]));
    hits.push({ path: `${name}/Opt_${i}/BG`, w: pitch - 20, fn: () => onPick(value), title: text });
  });
  return { tree: row, h, hits };
}

// a value with one or two buttons on the right (folders, version, cache)
function valueRow(name, y, title, value, buttons) {
  const h = 240, row = rowBase(name, y, h, title), hits = [];
  const room = 1440 - buttons.length * 320;
  const f = fitText(value || T("settings.notSet"), 38, 30, room);
  row.children.push(node("Value", [-718, -h / 2 + 62], [label(f.lines > 1 ? value : f.text, Math.min(f.fs, 38), "#2d4664/1.00", room, 56, { pivot: 3, depth: 8, ellipsis: true })]));
  buttons.forEach(([caption, fn, enabled = true], i) => {
    const x = 700 - (buttons.length - 1 - i) * 320 - 150;
    row.children.push(buttonNode(`Btn_${i}`, x, -h / 2 + 70, caption, { enabled }));
    if (enabled) hits.push({ path: `${name}/Btn_${i}`, fn, title: caption });
  });
  return { tree: row, h, hits };
}

// the sound slider row (Master/Type_3): mute icon, slider, full icon, the mute check
function sliderRow(name, y, title, value, muted) {
  const t = clone(layout.slider);
  t.name = name;
  t.pos = [0, y];
  Object.assign(find(t, "Label_Locale_OptionTitle").widgets[0], { text: title, fontSize: fitText(title, 50, 40, 360).fs, w_: 380 });
  const thumb = find(t, "SlideBg/Thumb");
  thumb.pos[0] = -316 + (632 * value) / 100;
  const mute = find(t, "Label_Mute");
  Object.assign(mute.widgets[0], { text: T("settings.mute"), fontSize: fitText(T("settings.mute"), 50, 34, 180).fs });
  find(mute, "Icon").active = !!muted;
  return { tree: t, h: 172, hits: [{ path: `${name}/Label_Mute/Bg`, fn: () => set("voiceMuted", !muted), title: T("settings.mute") }], slider: `${name}/SlideBg` };
}

// --- tabs and frame ---

function frameTree() {
  const t = clone(find(layout.popup, "Center"));
  const popup = find(t, "Popup");
  const keep = new Set(["Base", "TabBg"]);
  const template = find(popup, "Game");
  popup.children = popup.children.filter((c) => keep.has(c.name));
  const titleNode_ = find(popup, "Base/BG/Label_Title_Locale");
  const tf = fitText(T("settings.title"), 72, 52, 1000);
  Object.assign(titleNode_.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1100 });
  find(titleNode_, "Line").widgets[0].w_ = glyphsOf(tf.text, tf.fs) + 14;
  TABS.forEach((id, i) => {
    const n = clone(template);
    n.name = `Tab_${id}`;
    n.pos = [-680, 316 - i * 136.5];
    for (const state of ["Tab_On", "Tab_Off"]) {
      const lbl = find(n, `${state}/Label_Locale`);
      const f = fitText(T(`settings.tab.${id}`), 56, 40, 300);
      Object.assign(lbl.widgets[0], { text: f.text, fontSize: f.fs, w_: 320 });
      find(n, state).active = (state === "Tab_On") === (id === tab);
    }
    popup.children.push(n);
  });
  // the left column keeps only as many separators as there are tabs
  const grid = find(popup, "TabBg/Grid");
  if (grid) grid.children = grid.children.slice(0, TABS.length);
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
  return t;
}

function rows() {
  const p = prefs, out = [];
  let y = -20;
  const add = (r) => { r.tree.pos[1] = y - r.h / 2 + (r.tree.pos[1] || 0); out.push(r); y -= r.h + 24; };
  const reveal = (path) => () => call(() => rpc("os.reveal", { path }));
  const browse = (key, start) => async () => {
    const path = await call(() => rpc("settings.pickFolder", { start }));
    if (path) set(key, path);
  };
  const open = T(platform === "mac" ? "open.mac" : "open.win");
  if (tab === "general") {
    add(radioRow("Language", 0, T("settings.language"), p.languages.map((l) => [l.code, l.name]), p.language, (v) => set("language", v)));
    add(valueRow("Cache", 0, T("settings.cache.label"), p.consent ? `${T("settings.cache.on")} - ${p.cacheDir}` : T("settings.cache.off"),
      [[T("settings.cache.clear"), async () => { if (await call(() => rpc("settings.clearCache")) !== null) toast(T("settings.cache.cleared")); }, !!p.consent]]));
    add(valueRow("Version", 0, T("settings.version"), (p.version || "").replace(/-dev$/, ""), [[T("settings.update.check"), checkUpdate]]));
    add(valueRow("Classic", 0, T("settings.classic.label"), T("settings.classic.hint"), [[T("settings.classic.open"), () => call(() => rpc("app.openClassic", { tab: "settings" }))]]));
  } else if (tab === "sound") {
    add(sliderRow("Voice", 0, T("settings.voice"), p.voiceVolume, p.voiceMuted));
  } else {
    const region = p.fileSource === "windows_japan" ? "japan" : "global";
    add(radioRow("Server", 0, T("settings.server.label"), [["windows_global", T("settings.server.global")], ["windows_japan", T("settings.server.japan")]],
      p.fileSource, (v) => set("fileSource", v)));
    const dir = p.gameDirs[region];
    add(valueRow("Game", 0, T("settings.gameDir"), dir, [
      [T("settings.detect"), async () => {
        const found = await call(() => rpc("settings.detectGame", { region }));
        if (found?.length) set(`gameDir.${region}`, found[0]);
        else if (found) toast(T("app.noGame.title"), { kind: "error" });
      }],
      [T("settings.browse"), browse(`gameDir.${region}`, dir), p.native]]));
    add(valueRow("Library", 0, T("settings.library"), p.libraryDir, [[open, reveal(p.libraryDir)], [T("settings.browse"), browse("libraryDir", p.libraryDir), p.native]]));
    add(valueRow("Output", 0, T("settings.output"), p.outputDir, [[open, reveal(p.outputDir)], [T("settings.browse"), browse("outputDir", p.outputDir), p.native]]));
  }
  return { rows: out, height: -y };
}

async function checkUpdate() {
  try {
    const info = await rpc("app.checkUpdate");
    if (!info) { toast(T("settings.update.none")); return; }
    close();
    const { check } = await import("./update.js");
    check($("consent"));
  } catch (err) {
    toast(errorText(err), { kind: "error" });
  }
}

async function set(key, value) {
  const next = await call(() => rpc("settings.set", { key, value }));
  if (!next) return;
  prefs = next;
  if (key === "language") { location.reload(); return; }
  toast(T("settings.saved"));
  onChange?.(key, next);
  render();
}

// --- slider dragging: the thumb follows the pointer, the value is saved on release ---
function wireSlider(host, view, path, origin) {
  const bar = view.nodes.get(path)?.els[0], thumbEntry = view.nodes.get(`${path}/Thumb`);
  if (!bar || !thumbEntry) return;
  const thumb = thumbEntry.els[0];
  const [l, t, w, h] = rect(bar);
  const area = document.createElement("div");
  area.className = "hit slider-hit";
  Object.assign(area.style, { left: `${l - 20}px`, top: `${t - 20}px`, width: `${w + 40}px`, height: `${h + 40}px`, zIndex: 80 });
  host.appendChild(area);
  const stageScale = () => document.getElementById("stage").getBoundingClientRect().width / 1920;
  const pad = (w - 632 * S) / 2; // the thumb travels 632 units inside the 689-unit bar
  const valueAt = (clientX) => {
    const x = (clientX - area.getBoundingClientRect().left) / stageScale() - 20 - pad;
    return Math.round(Math.max(0, Math.min(1, x / (632 * S))) * 100);
  };
  const base = parseFloat(thumb.style.left) - (-316 + (632 * prefs.voiceVolume) / 100) * S;
  const move = (v) => { thumb.style.left = `${base + (-316 + (632 * v) / 100) * S}px`; };
  let dragging = false;
  area.addEventListener("pointerdown", (e) => { dragging = true; area.setPointerCapture(e.pointerId); move(valueAt(e.clientX)); });
  area.addEventListener("pointermove", (e) => { if (dragging) move(valueAt(e.clientX)); });
  area.addEventListener("pointerup", (e) => { if (!dragging) return; dragging = false; set("voiceVolume", valueAt(e.clientX)); });
}

async function render() {
  const my = ++token;
  const host = $("settings");
  const next = document.createElement("div");
  const view = await NGUI.render(frameTree(), next, { scale: S, origin: [960, 540], z: 3000 });
  const close_ = view.nodes.get("Center/Popup/Base/BG/Btn_Close")?.els[0];
  if (close_) hitButton(next, rect(close_), close, "", 3100);
  TABS.forEach((id) => {
    const el = view.nodes.get(`Center/Popup/Tab_${id}/Tab_Off/Label_Locale`)?.els[0];
    if (el && id !== tab) {
      const [l, t, w, h] = rect(el);
      hitButton(next, [l - 60, t - 30, w + 120, h + 60], () => { tab = id; scroll = 0; render(); }, T(`settings.tab.${id}`), 3100);
    }
  });
  // the rows scroll inside the panel's list area
  const { rows: list, height } = rows();
  const [aL, aT] = [960 + (CONTENT.x - CONTENT.w / 2) * S, 540 - CONTENT.top * S];
  const area = document.createElement("div");
  area.className = "settings-rows";
  Object.assign(area.style, { left: `${aL}px`, top: `${aT}px`, width: `${CONTENT.w * S}px`, height: `${CONTENT.h * S}px` });
  const inner = document.createElement("div");
  inner.className = "settings-rows-inner";
  inner.style.height = `${Math.max(CONTENT.h, height) * S}px`;
  area.appendChild(inner);
  next.appendChild(area);
  const origin = [CONTENT.w / 2 * S, 0];
  const tree = node("Rows", [0, 0], [], list.map((r) => r.tree));
  const rv = await NGUI.render(tree, inner, { scale: S, origin, z: 3010 });
  for (const r of list) {
    for (const hit of r.hits) {
      const el = rv.nodes.get(`Rows/${hit.path}`)?.els[0];
      if (!el) continue;
      const [l, t, w, h] = rect(el);
      hitButton(inner, [l, t, hit.w ? hit.w * S : w, h], hit.fn, hit.title, 3050);
    }
    if (r.slider) wireSlider(inner, rv, `Rows/${r.slider}`, origin);
  }
  if (my !== token || $("settings").hidden) return;
  host.replaceChildren(...next.childNodes);
  host.querySelector(".settings-rows").scrollTop = scroll;
  host.querySelector(".settings-rows").addEventListener("scroll", (e) => { scroll = e.target.scrollTop; });
}

function close() {
  const host = $("settings");
  host.hidden = true;
  host.innerHTML = "";
}

// open(onChange): onChange(key, prefs) after a setting was saved
export async function open(changed) {
  onChange = changed;
  if (!layout) {
    const popup = await NGUI.layout("UIPopup_Option_PC");
    layout = { popup, slider: find(popup, "Center/Popup/List/Sound_Setting/Sound_Scroll View/Grid_2/Master/Type_3") };
  }
  prefs = await call(() => rpc("settings.get"));
  if (!prefs) return;
  $("settings").hidden = false;
  await render();
}

export const current = () => prefs;
