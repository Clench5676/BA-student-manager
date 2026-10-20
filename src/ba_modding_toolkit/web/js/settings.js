// Settings, on the game's PC options popup (UIPopup_Option_PC): tabs on the left, the white panel on the right with
// the game's option rows: radio rows (UIPopup_Option_Toggle), the sound slider row (UIPopup_Option_SoundToggle), and
// folder rows built from the same pieces (title with its tag, dotted line, the value, the popup's light-blue buttons).
// The Mods tab (second, after General) holds the Enable Mods switch with its square "?", where the switch shows, the
// file check mode, the tray icon, Settings' Check of the game files, plus the size and cleanup of the mod cache.
// Whether the classic UI asks before it opens is a General row,
// under More Settings.
import * as ModSwitch from "./mod-switch.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Prompts from "./prompts.js";
import { rpc } from "./api.js";
import { T, platform } from "./i18n.js";
import { $, DOT, S, clone, glyphsOf, hitButton, toast, wrapPath } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);
// UIPopup_Option_PC's tab column has five separators (TabBg/Grid Line_1 to Line_5)
const TABS = ["general", "mods", "sound", "l2d", "folders"];
const CONTENT = { x: 209, top: 375, w: 1576, h: 854 }; // the panel's inner list area (List/BG), units
const ROW_W = 1552;

let layout = null, prefs = null, tab = "general", scroll = 0, onChange = null, token = 0;
let checkingUpdate = false;

const errorText = (err) => T(`error.${err.code || "internal"}`, err.params || { error: String(err) });
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

// radio options in a row (the game's On / Off toggles, as many as needed): [value, text, the text's language if it is
// not the page's]; dim: the options drawn faded (a switch that is busy or unavailable; a click still answers why)
function radioRow(name, y, title, options, selected, onPick, { dim = false, tip = "" } = {}) {
  const h = 240, row = rowBase(name, y, h, title), hits = [];
  const pitch = Math.min(508, 1400 / options.length);
  options.forEach(([value, text, lang], i) => {
    const x = -689 + i * pitch, on = value === selected;
    const f = fitText(text, 48, 34, pitch - 110, 2, lang);
    const alpha = dim ? (on ? "0.55" : "0.35") : on ? "1.00" : "0.71";
    row.children.push(node(`Opt_${i}`, [x, -h / 2 + 65.5], [], [
      node("BG", [0, 0], [sprite("Common_Btn_Radio_BG", 60, 60, { type: 0, depth: 25, ...(dim ? { color: "#ffffff/0.55" } : {}) })]),
      ...(on ? [node("On", [0, 0], [sprite("Common_Btn_Radio_On", 60, 60, { type: 0, depth: 26, ...(dim ? { color: "#ffffff/0.55" } : {}) })])] : []),
      node("Label", [49, -5], [label(f.text, f.fs, `#2c4663/${alpha}`, pitch - 90, 50, { pivot: 3, depth: 26, lang })]),
    ]));
    hits.push({ path: `${name}/Opt_${i}/BG`, w: pitch - 20, fn: () => onPick(value), title: tip || text });
  });
  return { tree: row, h, hits };
}

// the On / Off options of the Mods tab's rows (the game's words, settings.post.*)
const ON_OFF = () => [[true, T("settings.post.on")], [false, T("settings.post.off")]];

// the square "?" after a row's title (UICharacterCollection's Btn_Information: the game's Common_Btn_Information in
// the title's navy over a white square), with the red dot when entries were not switched; it opens the Enable Mods
// help unless ``open`` names another
function helpAfterTitle(row, title, dot, open = () => ModSwitch.openHelp()) {
  const t = fitText(title, 50, 40, 900);
  const x = -718.5 + glyphsOf(t.text, t.fs) + 70, y = row.h / 2 - 55;
  row.tree.children.push(node("Help", [x, y], [sprite("Common_Square_Bg", 50, 50, { depth: 22, color: "#ffffff/1.00" })], [
    node("Sprite", [2, -7], [sprite("Common_Btn_Information", 70, 72, { type: 0, depth: 23, color: "#2c4564/1.00" })]),
    ...(dot ? [DOT([40, 30], 30)] : []),
  ]));
  row.hits.push({ path: `${row.tree.name}/Help`, fn: open, title: T("mods.guide"), pad: 14 });
  return row;
}

// the Game Files row's value: the file check off, or what the last check found
function filesValue(m) {
  if (m.scan !== true) return T("error.scan_off");
  const parts = [];
  if (m.drift) parts.push(T("tray.drift", { n: m.drift }));
  if (m.untracked) parts.push(T("mods.untrackedTitle"));
  if (m.damaged) parts.push(T("mods.damaged"));
  return parts.length ? parts.join(ModSwitch.listSep()) : T("settings.mods.clean");
}

// the Game Files row's "?": what configuration drift is
export function driftLines() {
  return [T("settings.mods.driftHelp.what")];
}

function driftHelp() {
  return Popup.message({ title: T("settings.mods.driftHelp.title"), lines: driftLines(), ok: T("picker.ok"), width: 2100 });
}

// Settings' Check: a scan with the dismissed entries listed again, then the drift and untracked prompts over the
// settings
async function checkFiles() {
  const result = await ModSwitch.check();
  if (!result) return;
  const m = ModSwitch.current() || {};
  render();
  if (!m.drift && !m.untracked && !m.damaged) { toast(T("settings.mods.clean")); return; }
  const entries = await rpc("mods.entries").catch(() => []);
  await Prompts.show("drift", { entries, dismissed: true });
  await Prompts.show("untracked", { entries, dismissed: true });
  render();
}

// a value with one or two buttons on the right (folders, version, cache); long values wrap, never cut
function valueRow(name, y, title, value, buttons) {
  const room = 1440 - buttons.length * 320;
  const f = wrapPath(value || T("settings.notSet"), 38, 30, room, 3);
  const lineH = f.fs * 1.3, blockH = Math.max(lineH * f.lines, 112);
  const h = 130 + blockH + 30, row = rowBase(name, y, h, title), hits = [];
  const midY = h / 2 - 130 - blockH / 2;
  row.children.push(node("Value", [-718, midY], [label(f.text, f.fs, "#2d4664/1.00", room, lineH * f.lines + 10, { pivot: 3, depth: 8 })]));
  buttons.forEach(([caption, fn, enabled = true], i) => {
    const x = 700 - (buttons.length - 1 - i) * 320 - 150;
    row.children.push(buttonNode(`Btn_${i}`, x, midY, caption, { enabled }));
    if (enabled) hits.push({ path: `${name}/Btn_${i}`, fn, title: caption });
  });
  return { tree: row, h, hits };
}

// the game's slider row (Master/Type_3) with its title (fitted to titleW) and the thumb at f (0 to 1)
function sliderTree(name, y, title, f, titleW = 360) {
  const t = clone(layout.slider);
  t.name = name;
  t.pos = [0, y];
  Object.assign(find(t, "Label_Locale_OptionTitle").widgets[0], { text: title, fontSize: fitText(title, 50, 34, titleW).fs, w_: titleW + 20 });
  find(t, "SlideBg/Thumb").pos[0] = -316 + 632 * f;
  return t;
}

// the sound slider row: mute icon, slider, full icon, the mute check
function sliderRow(name, y, title, value, muted) {
  const t = sliderTree(name, y, title, value / 100);
  const mute = find(t, "Label_Mute");
  Object.assign(mute.widgets[0], { text: T("settings.mute"), fontSize: fitText(T("settings.mute"), 50, 34, 180).fs });
  find(mute, "Icon").active = !!muted;
  return { tree: t, h: 172, hits: [{ path: `${name}/Label_Mute/Bg`, fn: () => set("voiceMuted", !muted), title: T("settings.mute") }],
    slider: { path: `${name}/SlideBg`, value: value / 100, steps: 100, set: (f) => set("voiceVolume", Math.round(f * 100)) } };
}

// the custom zoom-out limit: the slider row without the sound icons, the value where the mute check is
const ZOOM_CUSTOM = [1, 4]; // game views across (webui/state.py LOBBY_ZOOM_CUSTOM), in 0.1 steps
const factorText = (v) => T("settings.zoomOut.factor", { v: v.toFixed(1) });
function factorRow(name, y, title, value) {
  const [lo, hi] = ZOOM_CUSTOM, f = (value - lo) / (hi - lo), at = (x) => Math.round((lo + x * (hi - lo)) * 10) / 10;
  const t = sliderTree(name, y - 34, title, f, 340); // its body (BG, 34 up) in the middle of the row
  for (const path of ["Icon_Minimum", "Icon_Maximum", "Label_Mute/Bg", "Label_Mute/Icon"]) find(t, path).active = false;
  find(t, "SlideBg").pos[0] += 60; // into the mute icon's place: room for the title
  Object.assign(find(t, "Label_Mute").widgets[0], { text: factorText(value), fontSize: 50 });
  const slider = { path: `${name}/SlideBg`, label: `${name}/Label_Mute`, value: f, steps: Math.round((hi - lo) * 10),
    text: (x) => factorText(at(x)), set: (x) => set("lobbyZoomCustom", at(x)) };
  return { tree: t, h: 172, hits: [], slider };
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

function rows({ builtSize = null, sizeError = null } = {}) {
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
    // each language named in itself, in its own fonts
    add(radioRow("Language", 0, T("settings.language"), p.languages.map((l) => [l.code, l.name, l.code]), p.language, (v) => set("language", v)));
    add(valueRow("Cache", 0, T("settings.cache.label"), p.consent ? T("cacheTo", { path: p.cacheDir }) : `${T("settings.cache.off")} - ${p.cacheDir}`, [
      [T("settings.cache.change"), browse("cacheDir", p.cacheDir), p.native],
      [T("settings.cache.clear"), async () => { if (await call(() => rpc("settings.clearCache")) !== null) toast(T("settings.cache.cleared")); }, !!p.consent]]));
    add(valueRow("Version", 0, T("settings.version"), (p.version || "").replace(/-dev$/, ""), [[T("settings.update.check"), checkUpdate, !checkingUpdate]]));
    add(radioRow("StartupUpdate", 0, T("settings.update.startup"), ON_OFF(), p.startupUpdate !== false, (v) => set("startupUpdate", v)));
    add(valueRow("Log", 0, T("settings.log.label"), p.logPath, [
      [T("settings.log.open"), openLog], [open, reveal(p.logPath)]]));
    add(valueRow("Classic", 0, T("settings.classic.label"), T("settings.classic.hint"), [[T("settings.classic.open"), () => call(() => rpc("app.openClassic", { tab: "settings" }))]]));
    // the bottom bar's hand-off prompt (decision 6): Don't Ask Again turns it off, this turns it back on
    add(radioRow("ClassicAsk", 0, T("settings.classic.ask"), [[true, T("settings.post.on")], [false, T("settings.post.off")]],
      p.classicPrompt !== false, (v) => set("classicPrompt", v)));
  } else if (tab === "mods") {
    const m = ModSwitch.current() || {};
    const v = ModSwitch.view(m, { place: "settings" });
    // the same kill switch as the top bar's, with the same rules (the first toggle's explanation, the reasons, the
    // classic modal): picking the other option is a click on the switch
    const sw = radioRow("Switch", 0, T("mods.switch"), ON_OFF(), v.on, (value) => { if (value !== v.on) ModSwitch.click("settings"); },
      { dim: v.busy || v.unavailable, tip: v.unavailable ? ModSwitch.reasonText(m) : "" });
    add(helpAfterTitle(sw, T("mods.switch"), v.dot));
    add(radioRow("Shown", 0, T("settings.mods.shown"), ON_OFF(), p.modSwitchShown !== false, (value) => set("modSwitchShown", value)));
    add(valueRow("Built", 0, T("mods.cache"), sizeError || (builtSize == null ? T("loading.now") :
      ModSwitch.sizeText(builtSize)), [
      [T("settings.mods.clear"), async () => { if (await ModSwitch.clearBuilt()) render(); }, builtSize > 0]]));
    // Off withdraws consent; either enabled mode asks for it before checking any files.
    const scanMode = m.scan === true ? (p.startupChecks === false ? "manual" : "startup") : "off";
    add(radioRow("Scan", 0, T("settings.mods.scan"), [["off", T("settings.post.off")],
      ["manual", T("settings.mods.manual")], ["startup", T("settings.mods.atStartup")]], scanMode, async (value) => {
      if (value === scanMode) return;
      if (value === "off") await call(() => rpc("mods.consent", { granted: false }));
      else {
        if (!await set("startupChecks", value === "startup")) return;
        if (m.scan !== true) await ModSwitch.askScan();
      }
      await ModSwitch.refresh();
      render();
    }));
    // the tray or menu bar icon, only in the app window where the system has one
    if (p.native && p.traySupported) {
      add(radioRow("Tray", 0, T(platform === "mac" ? "settings.mods.tray.mac" : "settings.mods.tray.win"), ON_OFF(), !!p.tray, (value) => set("tray", value)));
    }
    add(helpAfterTitle(valueRow("Files", 0, T("settings.mods.files"), filesValue(m), [[T("settings.mods.check"), checkFiles, m.scan === true]]),
      T("settings.mods.files"), false, driftHelp));
  } else if (tab === "sound") {
    add(sliderRow("Voice", 0, T("settings.voice"), p.voiceVolume, p.voiceMuted));
  } else if (tab === "l2d") {
    // the memorial lobby's fullscreen zoom-out limit: the game's view, the art every clip keeps painted, everything
    // painted, or a custom number of game views across (its slider shows with Custom)
    const zoom = p.lobbyZoom || { mode: "art", custom: 2 };
    const modes = ["game", "art", "unlocked", "custom"].map((m) => [m, T(`settings.zoomOut.${m}`)]);
    add(radioRow("ZoomOut", 0, T("settings.zoomOut.label"), modes, zoom.mode, (v) => set("lobbyZoom", v)));
    if (zoom.mode === "custom") add(factorRow("ZoomCustom", 0, T("settings.zoomOut.limit"), zoom.custom));
    // the game's PP option: the lobby's post-processing volumes (colour grading, chromatic aberration, Panini)
    add(radioRow("Post", 0, T("settings.post.label"), [[true, T("settings.post.on")], [false, T("settings.post.off")]],
      p.lobbyPost !== false, (v) => set("lobbyPost", v)));
    // the memorial lobby's intro when it is entered (off: the lobby as the intro leaves it)
    add(radioRow("Intro", 0, T("settings.intro.label"), [[true, T("settings.intro.on")], [false, T("settings.intro.off")]],
      p.lobbyIntro !== false, (v) => set("lobbyIntro", v)));
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
      [T("settings.change"), browse(`gameDir.${region}`, dir), p.native]]));
    add(valueRow("Library", 0, T("settings.library"), p.libraryDir, [[open, reveal(p.libraryDir)], [T("settings.change"), browse("libraryDir", p.libraryDir), p.native]]));
    add(valueRow("Output", 0, T("settings.output"), p.outputDir, [[open, reveal(p.outputDir)], [T("settings.change"), browse("outputDir", p.outputDir), p.native]]));
  }
  return { rows: out, height: -y };
}

async function openLog() {
  const log = await call(() => rpc("app.log"));
  if (!log) return;
  Popup.textViewer({ title: T("settings.log.label"), text: log.text, copy: T("settings.log.copy"), onCopy: () => call(async () => {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(log.text);
    else {
      const input = document.createElement("textarea");
      input.value = log.text;
      document.body.appendChild(input);
      try {
        input.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
      } finally { input.remove(); }
    }
    toast(T("settings.log.copied"));
  }) });
}

async function checkUpdate(event) {
  if (checkingUpdate) return;
  checkingUpdate = true;
  event.currentTarget.disabled = true;
  try {
    await render();
    const { check } = await import("./update.js");
    await check($("consent"), undefined, {
      onCheck: (info) => { if (info) close(); else toast(T("settings.update.none")); },
      onError: (err) => toast(errorText(err), { kind: "error" }),
    });
  } catch (err) {
    toast(errorText(err), { kind: "error" });
  } finally {
    checkingUpdate = false;
    if (!$("settings").hidden) render();
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
  return next;
}

// --- slider dragging: the thumb follows the pointer (and the value label, if any), the value is saved on release.
// s: {path, value (0 to 1), steps, set(f), label?, text?(f)} ---
function wireSlider(host, view, s) {
  const bar = view.nodes.get(s.path)?.els[0], thumbEntry = view.nodes.get(`${s.path}/Thumb`);
  if (!bar || !thumbEntry) return;
  const thumb = thumbEntry.els[0], valueLabel = s.label ? view.nodes.get(s.label)?.els[0] : null;
  const [l, t, w, h] = rect(bar);
  const area = document.createElement("div");
  area.className = "hit slider-hit";
  Object.assign(area.style, { left: `${l - 20}px`, top: `${t - 20}px`, width: `${w + 40}px`, height: `${h + 40}px`, zIndex: 80 });
  host.appendChild(area);
  const stageScale = () => document.getElementById("stage").getBoundingClientRect().width / 1920;
  const pad = (w - 632 * S) / 2; // the thumb travels 632 units inside the 689-unit bar
  const valueAt = (clientX) => {
    const x = (clientX - area.getBoundingClientRect().left) / stageScale() - 20 - pad;
    return Math.round(Math.max(0, Math.min(1, x / (632 * S))) * s.steps) / s.steps;
  };
  const base = parseFloat(thumb.style.left) - (-316 + 632 * s.value) * S;
  const move = (f) => {
    thumb.style.left = `${base + (-316 + 632 * f) * S}px`;
    if (valueLabel && s.text) valueLabel.textContent = s.text(f);
  };
  let dragging = false;
  area.addEventListener("pointerdown", (e) => { dragging = true; area.setPointerCapture(e.pointerId); move(valueAt(e.clientX)); });
  area.addEventListener("pointermove", (e) => { if (dragging) move(valueAt(e.clientX)); });
  area.addEventListener("pointerup", (e) => { if (!dragging) return; dragging = false; s.set(valueAt(e.clientX)); });
}

async function render({ builtSize = null, sizeError = null } = {}) {
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
  const { rows: list, height } = rows({ builtSize, sizeError });
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
      const [l, t, w, h] = rect(el), pad = (hit.pad || 0) * S;
      hitButton(inner, [l - pad, t - pad, (hit.w ? hit.w * S : w) + 2 * pad, h + 2 * pad], hit.fn, hit.title, 3050);
    }
    if (r.slider) wireSlider(inner, rv, { ...r.slider, path: `Rows/${r.slider.path}`, label: r.slider.label && `Rows/${r.slider.label}` });
  }
  if (my !== token || $("settings").hidden) return;
  host.replaceChildren(...next.childNodes);
  host.querySelector(".settings-rows").scrollTop = scroll;
  host.querySelector(".settings-rows").addEventListener("scroll", (e) => { scroll = e.target.scrollTop; });
  if (tab === "mods" && builtSize == null && !sizeError) {
    // Fetch after drawing the loading row; an old reply must not redraw a closed or newer tab.
    try {
      const sizes = await rpc("mods.sizes", { kind: "built" });
      if (my === token && !host.hidden) await render({ builtSize: sizes.builtSize });
    } catch (err) {
      if (my === token && !host.hidden) await render({ sizeError: errorText(err) });
    }
  }
}

function close() {
  const host = $("settings");
  host.hidden = true;
  host.innerHTML = "";
}

// the Mods tab follows the switch's state (mods.state: a toggle elsewhere, the game starting, the file check)
let following = false;
function follow() {
  if (following) return;
  following = true;
  ModSwitch.onChange(() => { if (!$("settings").hidden && tab === "mods") render(); });
}

// open(onChange): onChange(key, prefs) after a setting was saved
export async function open(changed) {
  onChange = changed;
  follow();
  if (!layout) {
    const popup = await NGUI.layout("UIPopup_Option_PC");
    layout = { popup, slider: find(popup, "Center/Popup/List/Sound_Setting/Sound_Scroll View/Grid_2/Master/Type_3") };
  }
  prefs = await call(() => rpc("settings.get"));
  if (!prefs) return;
  if (!ModSwitch.current()) await ModSwitch.refresh();
  $("settings").hidden = false;
  await render();
}

export const current = () => prefs;
