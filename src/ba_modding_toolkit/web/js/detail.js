// Detail screen, built from the game's own prefab (UICharacterDetail) by ngui.js. The prefab supplies every frame,
// sprite, tint, incline and position; this file swaps labels and textures, hides what the tool has no use for, and adds
// what the game has no screen for: variant chips, the expression strip and the portrait and lobby switchers. A family
// is one base character with all of its variant portraits; each variant's game file carries one portrait (its own
// skeleton, another variant's skeleton or an added portrait), and likewise one memorial lobby (its own or an added
// one). Added portraits and lobbies belong to the variant whose game file they replace (mod.target); added portraits
// can be worn by the other variants of the family, lobbies are not offered to them. Switching writes the chosen one
// into the game files (switch-sources.js, actions.apply).
// The screen is shown only when it is ready: the panels, the left side's first frame (portrait, lobby or model) and,
// within a short soft cap, the visible thumbnails. A change inside the screen (another variant, a tab, an applied
// portrait) prepares every part off screen and swaps all of them in one frame (the commit barrier below).
import * as NGUI from "./ngui.js";
import * as Loading from "./loading.js";
import * as Lobby from "./lobby.js";
import * as Visual from "./visual-mode.js";
import { rpc, spineBase, waitJob } from "./api.js";
import { L, T, language, platform } from "./i18n.js";
import { forget, idleAnimation, prioritise, thumb } from "./thumbs.js";
import { portraitViewport } from "./portrait-view.js";
import { setTitle } from "./nav.js";
import { KEYS, deltaOf, pacer, typing } from "./step-keys.js";
import { appliedKey as keyOf, appliedOf, candidates as listSources, partsOf, sourceOf, switchKindOf } from "./switch-sources.js";
import {
  $, DOT, RECRUIT, S, TAN10, advanceOf, at, clone, glyphsOf, hitButton, markedLabel, off, text, toast, widget, wrapPath,
} from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);
// fitText for a box: where nothing fits from fsMin up (fitText then gives up on one line at fsMin - 8, however wide),
// the same again from smaller sizes, down to 60 % of fsMin
function fitIn(str, fsMax, fsMin, maxW, maxLines = 2) {
  let f = fitText(str, fsMax, fsMin, maxW, maxLines), min = fsMin;
  while (f.lines === 1 && f.fs < min && min - 8 >= fsMin * 0.6) { min -= 8; f = fitText(str, min + 6, min, maxW, maxLines); }
  return f;
}
const ORIGIN = [960, 515]; // prefab centre; 25 px above the stage centre so the panels clear the nav bar
const toStage = (x, y) => [ORIGIN[0] + x * S, ORIGIN[1] - y * S];
const INFO = "RightInfo/Target/Active/1_NormalInfo";
const stage = () => document.getElementById("stage");
// the portrait's players cover the stage (.portrait in app.css), so nothing the game shows is cut at a box edge
const PORTRAIT_BOX = { left: 0, top: 0, width: 1920, height: 1080 };

let ctx = null, fam = null, variantKey = null, layouts = null;
let tab = "portrait", fullscreen = false, expression = "00", expanded = false, exprScroll = 0;
let mainPlayer = null, blinkTimer = null, pending = null, pickerSel = null, lobbySeq = null, busy = false, lobbyShot = null;
let modelShot = null, modelActions = [], modelAction = null;
// three.js and the model viewer load with the first 3D model
let modelLib = null;
const ModelLib = () => (modelLib ||= import("./model.js"));
let renderToken = 0, exprToken = 0, chipToken = 0, spineToken = 0, leftToken = 0;

// --- readiness ---
const HARD_CAP = 15000;  // a part that never comes is given up on: whatever there is shows
const THUMBS_CAP = 1200; // visible thumbnails still being rendered after this fill in after the reveal
const LINES_CAP = 1500;  // the lobby's lines from Kivo (a network call) likewise
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frames = (n) => new Promise((resolve) => { const step = () => (--n > 0 ? requestAnimationFrame(step) : resolve()); requestAnimationFrame(step); });

// Every visible swap goes through commit(): at once, or, while an in-place change is prepared, queued and applied
// together with every other part of that change in one frame. A later re-render (a face card, play all) is at once.
let batch = null;
const commit = (fn) => (batch ? batch.push(fn) : fn());
// A render of a part is shown when it is the newest one, or, while a change is prepared, when it is newer than the
// one on screen and belongs to that change: a re-render still running at the commit (late lobby lines) then follows
// it instead of keeping the old part in the commit.
const applied = { screen: 0, chips: 0, expr: 0 };
const showable = (part, my, latest, gen) => open && (my === latest || (!!batch && gen === showGen && my > applied[part]));
// the screen is shown (from show() until hide()): what a show, a tab change or a job started for it starts nothing
// once it is hidden (the left side's players least of all)
let open = false;
// a generation of the screen: a newer show, tab change or hide ends the wait of the one before
let showGen = 0, endWait = () => {};
function begin() {
  endWait();
  const gen = ++showGen;
  return { gen, ended: new Promise((resolve) => { endWait = resolve; }) };
}
// work() renders every part; resolves once they are ready (or given up on). In place, their swaps are queued
// meanwhile and applied in one animation frame; a generation that was taken over drops its queue (the newer one
// renders everything again).
async function prepare({ gen, ended }, inPlace, work) {
  const queued = inPlace ? [] : null;
  batch = queued;
  try {
    await Promise.race([Promise.resolve().then(work), ended, sleep(HARD_CAP)]);
  } catch (err) {
    console.error(err);
  }
  if (gen !== showGen) return false;
  if (queued) {
    await new Promise(requestAnimationFrame);
    if (gen !== showGen) return false;
    for (const fn of queued) try { fn(); } catch (err) { console.error(err); }
    batch = null;
  }
  return true;
}
// the thumbnails of the latest screen and strip renders (switch card, face cards, the pile's top card)
let screenPics = [], exprPics = [];
const settleThumbs = () => Promise.race([Promise.allSettled([...screenPics, ...exprPics]), sleep(THUMBS_CAP)]);

// --- names, candidates, state ---
const fullName = (v) => L(v.names)?.full ?? v.key;
const shortName = (v) => L(v.names)?.short ?? v.key;
// the user's own aliases of the student (family.get's custom; webui/state.py keeps the same limits): the roster search
// finds the student by them, and the nameplate shows them small after the name
const ALIAS_MAX = 8, ALIAS_LENGTH = 24;
const customAliases = () => (Array.isArray(fam?.custom) ? fam.custom.filter((a) => typeof a === "string" && a) : []);
const aliasList = () => customAliases().join(/^(zh|ja)/.test(language()) ? "\u3001" : ", ");
const variant = () => fam.variants.find((v) => v.key === variantKey) || fam.variants[0];
const familyMods = () => fam.variants.flatMap((v) => v.modList || []);
const isFav = (v) => !!v.favorite;
const hasLobby = (v) => !!v.lobby;
const hasModel = (v) => !!v.model;
const hasFresh = (v, kind = null) => (v.modList || []).some((m) => m.fresh && (!kind || m.kind === kind));
const modLabel = (m) => m.label || m.file?.split(/[\\/]/).pop() || m.id;
// a candidate's skeleton: a mod's preview (its parts over the official ones), else the variant's own portrait or lobby
const baseOf = (c, kind = "spr") => (c.kind === "mod" ? spineBase("mod", c.id) : spineBase(kind === "lobby" ? "lobby" : "spr", c.core));

// what the switch card of a kind offers (switch-sources.js), with the names and marks the cards show: the variant's
// own portrait or lobby and its added ones, then for the portrait the other variants' ones and their added ones
function candidates(v = variant(), kind = "spr") {
  return listSources(fam, v, kind).map((c) => (c.kind === "mod"
    ? { ...c, label: modLabel(c.mod) }
    : { ...c, label: shortName(c.variant), recruit: c.variant.recruitable, fav: isFav(c.variant) }));
}
// the kind of game file the shown tab is about, and the newest date of a kind's files
const tabKind = () => (tab === "lobby" || tab === "model" ? tab : "spr");
// the switch card's kind on the shown tab: the portrait or the lobby; null on the 3D tab (the library keeps no 3D mods)
const switchKind = () => switchKindOf(tab);
const dateOf = (v, kind) => (kind === "spr" ? v.date : partsOf(v, kind).map((f) => f.date).filter(Boolean).sort().pop());
function crcOf(v, kind = "spr") {
  const states = partsOf(v, kind).map((f) => f.crc);
  return states.includes("needs_fix") ? "needs_fix" : states.includes("fixed") ? "fixed" : "ok";
}
const appliedKey = (v = variant(), kind = "spr") => keyOf(v, kind);
// what the game shows on the variant's portrait or lobby, as a candidate (the own one when it carries something the
// library did not put there)
const current = (kind = "spr") => candidates(variant(), kind).find((c) => c.key === appliedKey(variant(), kind)) || candidates(variant(), kind)[0];
// a candidate's name on the cards: another variant's mod with that variant's name first
const candidateLabel = (c, v = variant()) => (c.kind === "mod" && c.origin && c.origin.key !== v.key ? `${shortName(c.origin)} - ${c.label}` : c.label);
// what the variant's lobby files carry, as a label: the original, a mod's or another variant's name, or "replaced"
function lobbyLabel(v) {
  const key = appliedKey(v, "lobby");
  if (key === "self") return T("lobby.original");
  const c = candidates(v, "lobby").find((x) => x.key === key);
  return c ? candidateLabel(c, v) : T("status.replaced");
}
const gameFile = (v = variant(), kind = "spr") => partsOf(v, kind)[0]?.file || null;
const baseName = (path) => (path ? path.split(/[\\/]/).pop() : "—");
const sizeText = (bytes) => (!bytes ? "—" : bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const errorText = (err) => T(`error.${err.code}`, err.params || {});

// white glyphs for the action cards (the game shows skill icons there), a folder for the file manager button
const GLYPHS = {
  edit: '<path d="M11 37v-6l17-17 6 6-17 17Z" /><path d="M24 18l6 6" />',
  update: '<path d="M33 18a13 13 0 1 0 3 11" /><path d="M34 8v10H24" />',
  extract: '<path d="M10 22h28v16H10Z" /><path d="M24 30V8m-7 7 7-7 7 7" />',
  compare: '<path d="M10 12h12v24H10ZM26 12h12v24H26Z" /><path d="M16 20v8M32 20v8" />',
};
const svg = (body) => `data:image/svg+xml,${encodeURIComponent(body)}`;
const TEXTURES = {
  ...Object.fromEntries(Object.entries(GLYPHS).map(([k, g]) => [`glyph:${k}`,
    svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">${g}</svg>`)])),
  "svg:stop": svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="10" y="10" width="28" height="28" rx="4" fill="#2b496e"/></svg>'),
  "svg:folder": svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#2d5164" d="M5 12a3 3 0 0 1 3-3h11l4 5h17a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/></svg>'),
};

// an upright texture inside a slanted body is clipped to the body (the game does this with panel clipping)
const clipped = (name, pos, url, win, img, opts = {}) => node(name, pos, [{ clipImage: url, w_: win.w, h_: win.h, pivot: 4, depth: opts.depth ?? 9,
  incline: 10, radius: win.r ?? 20, color: opts.color ?? "#ffffff/1.00", tint: opts.tint, imgSize: "100% 100%", imgPosition: "0 0",
  imgLeft: `${(win.w / 2 + img.dx - img.w / 2) * S}px`, imgTop: `${(win.h / 2 - img.dy - img.h / 2) * S}px`, imgWidth: `${img.w * S}px`, imgHeight: `${img.h * S}px`,
  imgMask: opts.mask }]);

// --- row 4 geometry ---
const ROW4_Y = -552;                       // centre of row 4's visible part (Bg_W4: top -436, 234 tall, shadow below)
const BOX_RIGHT = 332;                     // the first skill card's right edge: the box ends there
const COLS = [461.9, 707.5, 953.2];        // skill cards 2-4 (Skill at 202 + SkillData x + Bg x 24)
const BTN_COL = [1079.8, 1284.8];          // the one-click / add buttons' column
const CARD = { w: 242, h: 209 };           // Common_Btn_BG like the skill cards; the visible body is h - 13 (shadow below)
const PITCH = 245.7;

// --- the static screen: background, arrows, tabs, right panel, nameplate frame ---
function screenTree() {
  const t = clone(layouts.list);
  off(t, "Top", "NUITop_Scenes", "LeftInfo/CharInfo_Disable", "LeftInfo/CharCombatStyle", "RightInfo/Target/Disable",
    "RightInfo/Target/Active/2_LevelUp", "RightInfo/Target/Active/3_Transcendence", "RightInfo/Target/Active/FullCollier", "RightInfo/Target/Active/Effect");
  const v = variant(), sk = switchKind(), c = current(sk || "spr"), kind = tabKind();
  const swapped = tab === "lobby" ? appliedOf(v, "lobby") !== "official" : tab === "model" ? false : appliedKey() !== "self";
  // layer 1 of the panel: measured on the game screenshots it lets about 55 % of the background through
  widget(t, "RightInfo/Target/Active/Bg").color = "#0c284b/0.45";

  // tabs: portrait / memorial lobby / 3D model (disabled where unavailable)
  const tabs = [["Tab_1", "tab.portrait", "portrait", true], ["Tab_2", "tab.lobby", "lobby", hasLobby(v)], ["Tab_3", "tab.model", "model", hasModel(v)]];
  for (const [node_, key, id, enabled] of tabs) {
    const base = `RightInfo/Target/Active/CharacterTab/${node_}`;
    for (const state of ["Tab_On", "Tab_Off"]) text(t, `${base}/${state}/Label`, T(key), { w_: 400, fontSize: fitText(T(key), 52, 36, 360).fs });
    if (!enabled) widget(t, `${base}/Tab_Off/Label`).color = "#ffffff/0.35";
    at(t, `${base}/Tab_On`).active = id === tab;
    at(t, `${base}/Tab_Off`).active = id !== tab;
  }
  // the separator on a tab's right edge goes when either neighbour is active
  if (tab !== "portrait") { const l = find(t, "RightInfo/Target/Active/CharacterTab/Tab_1/Tab_Off/Line"); if (l) l.active = tab !== "lobby"; }
  { const l = find(t, "RightInfo/Target/Active/CharacterTab/Tab_2/Tab_Off/Line (1)"); if (l) l.active = tab === "portrait"; }
  // the active tab's corners a little rounder than the prefab's 5 px sprite
  for (const [tb, dot] of [["Tab_1", "Dot"], ["Tab_2", "Dot (1)"], ["Tab_3", "Dot (2)"]]) {
    Object.assign(widget(t, `RightInfo/Target/Active/CharacterTab/${tb}/Tab_On/BG`), { sprite: "Common_Bg_Raius10px", h_: 132 });
    at(t, `RightInfo/Target/Active/CharacterTab/${tb}/Tab_On/BG`).pos[1] = -4;
    off(t, `RightInfo/Target/Active/CharacterTab/${tb}/${dot}`); // "new" dots mean nothing here
  }

  // row 1: portrait information
  text(t, `${INFO}/Title_Bg/Label_Locale`, T(`info.title.${tab}`), { w_: 600 });
  text(t, `${INFO}/Detail_Btn/Label_Locale`, T("info.details"));
  const crcState = crcOf(v, kind);
  const crc = crcState === "fixed" ? ["crc.fixed", "#1f9a52"] : crcState === "needs_fix" ? ["crc.needed", "#d9822b"] : ["crc.original", "#000000"];
  const now = tab === "portrait" ? c.label : tab === "lobby" ? lobbyLabel(v) : T("model.original");
  const stats = [["Label_Life", "info.current", "Data_Widget/Data", now],
    ["Label_Attact", "info.status", "Data_Widget/Data", T(swapped ? "status.replaced" : "status.original")],
    ["Label_Defense", "info.gameFile", "Data", dateOf(v, kind) || "—"], ["Label_Healing", "info.crc", "Data_Widget/Data", T(crc[0]), crc[1]]];
  // the value column starts after the longest caption of its column
  const capW = (keys) => Math.max(...keys.map((k) => advanceOf(T(k), 42))) + 24;
  const leftCap = capW(["info.current", "info.gameFile"]), rightCap = capW(["info.status", "info.crc"]);
  // all four values share one size: the largest at which every value fits its column, never above the captions'
  const rooms = stats.map(([name_]) => {
    const right = name_ === "Label_Attact" || name_ === "Label_Healing";
    return (right ? 1240 - 773 - rightCap : 773 - 293 - leftCap) - 24;
  });
  let valueFs = 42;
  while (valueFs > 28 && stats.some(([, , , value], i) => glyphsOf(String(value), valueFs) > rooms[i])) valueFs -= 2;
  stats.forEach(([name_, caption, dataPath, value, color], i) => {
    text(t, `${INFO}/Status/${name_}`, T(caption), { w_: 300 });
    const right = name_ === "Label_Attact" || name_ === "Label_Healing";
    const dataNode = at(t, `${INFO}/Status/${name_}/${dataPath.split("/")[0]}`);
    dataNode.pos[0] = right ? rightCap : leftCap;
    // a value still too wide at the smallest shared size (a long variant name) goes on two lines
    const fit = glyphsOf(String(value), valueFs) > rooms[i] ? fitIn(String(value), valueFs, valueFs - 4, rooms[i]) : { text: String(value), fs: valueFs };
    text(t, `${INFO}/Status/${name_}/${dataPath}`, fit.text, { w_: rooms[i], fontSize: fit.fs, ...(color ? { color: `${color}/1.00` } : {}) });
    const pot = find(t, `${INFO}/Status/${name_}/Data_Widget/Potential_Widget`);
    if (pot) pot.active = false;
  });
  // the button beside the information: show the game file in Finder / Explorer (secondary style, like Cancel)
  const up = `${INFO}/Status/Btn_Up_Wrapper/Btn_Up`;
  widget(t, up).sprite = "Common_Empty";
  off(t, `${up}/Lock`, `${up}/Dot`);
  widget(t, `${up}/BG (1)`).color = "#dbeef5/1.00";
  for (const k of at(t, `${up}/BG (1)`).children) k.widgets[0].sprite = "Common_Btn_Normal_B_C_Pt";
  const openText = fitText(T(platform === "mac" ? "open.mac" : "open.win"), 32, 26, 140);
  text(t, `${up}/Label_Locale`, openText.text, { fontSize: openText.fs, w_: 160, h_: 40 * openText.lines, color: "#2d5164/1.00" });
  at(t, `${up}/Label_Locale`).pos = [-1.4 - (openText.lines > 1 ? 36 : 46) * TAN10, openText.lines > 1 ? -36 : -46];
  const folderY = openText.lines > 1 ? 38 : 26;
  at(t, up).children.push(node("Folder", [-1.4 + folderY * TAN10, folderY], [{ texture: "svg:folder", w_: 56, h_: 50, pivot: 4, depth: 12, color: "#ffffff/1.00" }]));

  // row 2: four actions on what the shown tab's game files carry. Title and icon centred as a group on the card's
  // slanted midline.
  const isMod = !!sk && c.kind === "mod";
  const actions = [["SkillData_EX", "act.edit", "edit", false], ["SkillData_EX (1)", "act.update", "update", isMod && !busy],
    ["SkillData_EX (2)", "act.extract", "extract", !busy], ["SkillData_EX (3)", "act.compare", "compare", isMod && !busy]];
  // the row's white section spans x 58..1320 (Bg_W2 at 689, 1262 wide); cards keep the first card's 37-unit margins
  const ROW_L = 58 + 37, ROW_R = 1320 - 37, GAP = 6, CW = (ROW_R - ROW_L - 3 * GAP) / 4;
  actions.forEach(([card], i) => {
    const base = `${INFO}/Skill/${card}`, bg = at(t, `${base}/Bg`);
    at(t, base).pos[0] = ROW_L + CW / 2 + i * (CW + GAP) - 202 - bg.pos[0];
    bg.widgets[0].w_ = CW;
    find(t, `${base}/Bg/Bg_Line`).widgets[0].w_ = CW - 10;
  });
  off(t, `${INFO}/Skill/Btn_Up_Wrapper`); // the install button, removed for now
  for (const [card, key, glyph, enabled] of actions) {
    const base = `${INFO}/Skill/${card}`;
    off(t, `${base}/Lock_Cover`, `${base}/Normal/Label_SkillType (1)`, `${base}/Normal/Line (1)`);
    const max = find(t, `${base}/Normal/Icon_Max`);
    if (max) max.active = false;
    const bgX = at(t, `${base}/Bg`).pos[0] + 1, midY = 158.3 - 126; // Bg_Line centre: the card's visible body
    const title = fitText(T(key), 40, 28, 170);
    text(t, `${base}/Normal/Label_SkillType`, title.text, { fontSize: title.fs, color: enabled ? "#466399/1.00" : "#9aa3ad/1.00" });
    at(t, `${base}/Normal/Label_SkillType`).pos = [bgX + 66 * TAN10, midY + 66];
    const icon = at(t, `${base}/Normal/SkillIconBg`);
    icon.pos = [bgX - 30 * TAN10, midY - 30];
    icon.widgets.find((w) => "sprite" in w).color = enabled ? "#9c44ac/1.00" : "#b6bec8/1.00";
    for (const k of icon.children) if (["Bg_Skill_Plus", "Deco", "SkillIconBg (1)"].includes(k.name)) k.active = false; // EX-only rings
    Object.assign(widget(t, `${base}/Normal/SkillIconBg/Texture`), { texture: `glyph:${glyph}`, w_: 64, h_: 64 });
  }
  // row 3: portrait box, the switch card (the game's light weapon card), add portrait. The box's body spans
  // -96..95 around its centre (its slanted right edge ends lower down a few units further left); the title sits at -8.
  const boxTitle = fitIn(T(`row.box.${tab}`), 48, 42, 160);
  text(t, `${INFO}/Weapon/WeaponType/Label_WeaponType`, boxTitle.text, { fontSize: boxTitle.fs, w_: 200, h_: 60 * boxTitle.lines });
  at(t, `${INFO}/Weapon/WeaponType/Label_WeaponType`).pos = [-8, -2];
  off(t, `${INFO}/Weapon/WeaponType/Icon`);
  const card = `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target`;
  if (!sk || !hasFresh(v, sk)) off(t, `${INFO}/Weapon/Equip_1/UIEquipmentCard/Dot`);
  off(t, `${card}/Normal_NotEquip`, `${card}/Lock`, `${card}/Normal/Icon`, `${card}/Normal/Icon_Star`,
    `${card}/Normal/Card_Equipment`, `${card}/Normal/Card_Bg/Deco`);
  text(t, `${card}/Normal/Card_Level`, "");
  // window = the card's inner line (Common_Line_Raius20px 766 x 201 at (1, 6)); the decoration and the picture are clipped to it
  const win = { w: 766, h: 201, r: 20 };
  const deco = layouts.textures.Img_Deco_Weapon;
  at(t, `${card}/Normal`).children.push(
    ...(deco ? [clipped("DecoClip", [1, 6], deco, win, { dx: 30.8 - 1, dy: 7.5 - 6, w: 820, h: 198 }, { depth: 9 })] : []),
    tab === "portrait"
      ? clipped("Bust", [1, 6], thumb(baseOf(c), "bust"), win, { dx: -383 + 202 - 40, dy: -67.5, w: 404, h: 404 },
        { depth: 10, mask: "linear-gradient(90deg, #000 70%, transparent 98%)" })
      // wider than the window's slanted left edge, and faded at both ends so no hard picture edge shows
      : clipped("Bust", [1, 6], tab === "model" ? modelShot : lobbyShot, win, { dx: -383 + 216, dy: 0, w: 450, h: 253 }, { depth: 10, mask: "linear-gradient(90deg, transparent 0, #000 10%, #000 70%, transparent 96%)" }));
  // the wrapper holds an enabled (cyan) and a disabled (grey) body and label: the enabled ones while the tab has
  // something to add and switch to (switchKind), else the disabled ones
  const keep = switchKind() ? 1 : 2;
  let bodies = 0, labels = 0;
  const add = fitIn(T(`row.add.${tab}`), 52, 30, 160, 3); // the cyan body is 205 wide, slanted
  for (const k of at(t, `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up`).children) {
    if (k.name === "BG (1)") { bodies += 1; if (bodies !== keep) k.active = false; }
    if (k.name === "Label_Locale") { labels += 1; if (labels !== keep) k.active = false; else Object.assign(k.widgets[0], { text: add.text, fontSize: add.fs, w_: 200, h_: 160 }); }
    if (k.name === "Bg" || k.name === "Lock" || k.name === "Dot") k.active = false;
  }

  // row 4: a box like row 3's in the first column of the skill grid; the cards are rendered separately
  off(t, `${INFO}/Equip/Grid`, `${INFO}/Equip/Btn_Up_Wrapper`);
  const box = clone(find(t, `${INFO}/Weapon/WeaponType`));
  box.name = "ExprType";
  box.pos = [374.7, ROW4_Y];
  find(box, "BG/BG (1)").widgets[0].w_ = BOX_RIGHT - 126;   // ends where the first skill card of row 2 ends
  find(box, "Line/Line").widgets[0].w_ = BOX_RIGHT + 3 - 123.7;
  const boxLabel = find(box, "Label_WeaponType");
  const row4 = fitIn(T(`row.four.${tab}`), 48, 42, 200); // the box's body spans -96..148, the label sits at 20
  Object.assign(boxLabel.widgets[0], { text: row4.text, fontSize: row4.fs, w_: 240, h_: 60 * row4.lines });
  boxLabel.pos = [(87.5 + BOX_RIGHT) / 2 - 183.7 - 6, -2];
  at(t, `${INFO}/Equip`).children.push(box);

  // nameplate: favourite pin, name, the white panel for the variant chips; no stars, level, heart, squad or terrain
  const np = "LeftInfo/CharInfo/Char_Target";
  off(t, `${np}/Icon_Star`, `${np}/Text_Lv`, `${np}/FavorBG`, `${np}/SquadType`, `${np}/Type`, `${np}/Terrain`, `${np}/Char_ProfileBtn`);
  const fav = isFav(v);
  at(t, `${np}/Pin/Pin_On`).active = fav;
  at(t, `${np}/Pin/Pin_Off`).active = !fav;
  for (const state of ["Pin_On", "Pin_Off"]) {
    const base = `${np}/Pin/${state}`;
    at(t, base).pos[1] = 392;
    const isOn = state === "Pin_On", color = isOn ? "#725538" : "#7d7d7d";
    const lblNode = find(t, `${base}/Bg/Icon/Label_Locale`) || find(t, `${base}/Bg/Label_Locale`);
    const fs = 38, tw = advanceOf(T("fav.label"), fs);
    // the badge sprite carries its shadow in the bottom 8 units: centre the content 4 units higher
    const icon = at(t, `${base}/Bg/Icon`);
    icon.pos = [36, 5];
    Object.assign(icon.widgets[0], { color: `${color}/1.00`, w_: 34, h_: 34 });
    Object.assign(lblNode.widgets[0], { text: T("fav.label"), fontSize: fs, w_: tw + 4, color: `${color}/1.00` });
    lblNode.pos = isOn ? [26, -1] : [62, 4];
    widget(t, `${base}/Bg`).w_ = 36 + 17 + 10 + tw + 30;
  }
  // the name leaves room for the alias pencil after it
  const nm = fitText(fullName(v), 64, 44, PLATE_RIGHT - 110 - PENCIL - 24);
  text(t, `${np}/Label_Name`, nm.text, { w_: 800, fontSize: nm.fs });
  at(t, `${np}/Label_Name`).pos = [110, 288];
  aliasPlate(at(t, np), 110 + glyphsOf(nm.text, nm.fs));
  // the dark plate keeps its bottom edge and loses the level row; the game's shard texture is clipped to it
  widget(t, `${np}/BG`).h_ = 120;
  off(t, `${np}/BG/Deco`);
  const poli = layouts.textures.Img_Deco_Poli;
  if (poli) {
    at(t, `${np}/BG`).children.push(node("DecoClip", [0, 0], [{ clipImage: poli, tint: "#0e62b2",
      w_: 906, h_: 120, pivot: 6, depth: 5, incline: 10, radius: 10, color: "#ffffff/0.90",
      imgLeft: `${-13.4 * S}px`, imgTop: "0", imgWidth: `${388 * S}px`, imgHeight: `${172 * S}px`, imgSize: "100% 100%", imgPosition: "0 0" }]));
  }
  // square buttons: fullscreen (the portrait's visual mode with the game's own icon, the lobby, the 3D model), copy the
  // file name, and on the lobby tab play all dialogue
  at(t, `${np}/Char_CVCollectionBtn`).pos[0] = 1208.8;
  if (tab === "lobby" || tab === "model") Object.assign(widget(t, `${np}/Char_ZoomBtn/Sprite`), { sprite: "Common_UIHide_Icon", w_: 74, h_: 66, color: "#2b496e/1.00" });
  Object.assign(widget(t, `${np}/Char_CVCollectionBtn/Sprite`), { sprite: "Common_Icon_Copy", w_: 64, h_: 76, color: "#2b496e/1.00" });
  if (tab === "lobby") {
    const play = clone(find(t, `${np}/Char_ZoomBtn`));
    play.name = "Char_PlayBtn";
    play.pos[0] = 1362;
    const w = play.children[0].widgets[0];
    if (Lobby.playingAll()) { Object.assign(w, { texture: "svg:stop", w_: 54, h_: 54, color: "#2b496e/1.00" }); delete w.sprite; }
    else Object.assign(w, { sprite: "Common_Icon_Play", w_: 64, h_: 64, color: "#2b496e/1.00" });
    at(t, np).children.push(play);
  }
  return t;
}

// after the name on the dark plate: the user's own aliases, small and dim, then the pencil of the game's input popup
// (UIPopup_Input's Cafe_Icon_NameEdit) that opens their editor. Where the name leaves too little room, the pencil
// alone (its tooltip lists them).
const PLATE_RIGHT = 925; // the plate's right edge at the name's height, less a margin
const PENCIL = 46;
function aliasPlate(np, nameEnd) {
  const list = aliasList();
  let x = nameEnd + 24;
  const room = PLATE_RIGHT - PENCIL - 24 - x;
  if (list && room >= 120) {
    const fs = 36, w = Math.min(glyphsOf(list, fs) + 4, room);
    np.children.push(node("Label_Alias", [x, 279], [label(list, fs, "#ffffff/0.62", w, 50, { pivot: 3, depth: 22, ellipsis: true })]));
    x += w;
  }
  np.children.push(node("Char_AliasBtn", [Math.min(x + 24 + PENCIL / 2, PLATE_RIGHT - PENCIL / 2), 287],
    [sprite("Cafe_Icon_NameEdit", PENCIL, PENCIL, { type: 0, depth: 22, color: "#ffffff/0.85" })]));
}

async function renderScreen() {
  const my = ++renderToken, gen = showGen, shown = tab;
  const ok = () => showable("screen", my, renderToken, gen);
  const host = $("ngui"), bgHost = $("ngui-bg");
  const v = variant();
  const t = screenTree();
  const bgNode = find(t, "BG");
  const RIGHT = ["RightInfo", "Arrow_R"];
  const left = { ...t, children: t.children.filter((k) => k !== bgNode && !RIGHT.includes(k.name)) };
  const right = { ...t, widgets: [], children: t.children.filter((k) => RIGHT.includes(k.name)) };
  // render off-screen, then swap in one go (no flicker while images load)
  const next = document.createElement("div");
  next.innerHTML = '<div class="side left"></div><div class="side right"></div>';
  const [leftHost, rightHost] = next.children;
  const [lv, rv] = await Promise.all([
    NGUI.render(left, leftHost, { scale: S, origin: ORIGIN, textureNames: TEXTURES }),
    NGUI.render(right, rightHost, { scale: S, origin: ORIGIN, textureNames: TEXTURES }),
  ]);
  const frag = document.createDocumentFragment();
  await NGUI.render(bgNode, frag, { scale: S, origin: ORIGIN, rootPath: "Inventory_ListControl", textures: { BG: v.bg || undefined } });
  if (!ok()) return;
  if (my === renderToken) screenPics = [...lv.pictures, ...rv.pictures];
  const view = { nodes: new Map([...lv.nodes, ...rv.nodes]) };
  addSwitchText(rightHost, view);
  hits(view, leftHost, rightHost);
  commit(() => {
    if (!ok()) return;
    applied.screen = my;
    // the control with the keyboard's focus keeps it in the new screen (an arrow stepped with Enter, a step key
    // pressed on a button), where the new screen has it
    const had = host.contains(document.activeElement) ? document.activeElement.dataset?.part : null;
    host.replaceChildren(...next.children);
    if (had) [...host.querySelectorAll(".hit")].find((b) => b.dataset.part === had)?.focus({ preventScroll: true });
    bgHost.replaceChildren(frag);
    bgHost.classList.toggle("dim", shown !== "portrait");
    bgHost.hidden = shown === "lobby"; // the lobby extends its own edges instead
  });
}

// the switch card has no label slot in the game; put the title and the portrait's name beside the picture
function addSwitchText(host, view) {
  const cardEl = view.nodes.get(`Inventory_ListControl/${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`)?.els[0];
  if (!cardEl) return;
  const [l, t, w, h] = rect(cardEl);
  const box = document.createElement("div");
  box.className = "switch-text";
  const textW = w * 0.42 - 44; // the chevron sits in the last 44 px
  Object.assign(box.style, { left: `${l + w * 0.5}px`, top: `${t}px`, width: `${w * 0.42}px`, height: `${h * 0.94}px`, paddingRight: "44px" });
  const sub = tab === "lobby" ? lobbyLabel(variant()) : tab === "model" ? T("model.original") : candidateLabel(current());
  const title = T(`row.switch.${tab}`);
  const tf = fitText(title, 46, 34, textW / S), sf = fitText(sub, 32, 24, textW / S);
  box.style.setProperty("--title-size", `${NGUI.fontSizeFor(title, tf.fs) * S}px`);
  box.style.setProperty("--sub-size", `${NGUI.fontSizeFor(sub, sf.fs) * S}px`);
  const b = document.createElement("b"), span = document.createElement("span"), go = document.createElement("i");
  b.innerText = tf.text;
  span.innerText = sf.text;
  go.className = "switch-go";
  // the chevron only where the card opens a popup: the 3D card has nothing to switch to and stays inert (hits)
  box.append(b, span, ...(switchKind() ? [go] : []));
  host.appendChild(box);
}

function hits(view, leftHost, rightHost) {
  // each button names its part, so the focus finds it again in the next render
  const add = (host, path, fn, title) => {
    const el = view.nodes.get(`Inventory_ListControl/${path}`)?.els[0];
    if (el) hitButton(host, rect(el), fn, title).dataset.part = path;
  };
  // the switch card puts another source on the game files of the shown tab (the 3D tab has none to offer yet)
  const sk = switchKind();
  if (sk) {
    add(rightHost, `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`, () => openPopup(sk), T(`row.switch.${tab}`));
    add(rightHost, `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up/BG (1)`, addMods, T(`row.add.${tab}`));
  }
  add(rightHost, `${INFO}/Status/Btn_Up_Wrapper/Btn_Up/BG (1)`, () => reveal(gameFile(variant(), tabKind())), T(platform === "mac" ? "open.mac" : "open.win"));
  add(rightHost, `${INFO}/Detail_Btn`, showDetails, T("info.details"));
  const act = (card, fn, title) => add(rightHost, `${INFO}/Skill/${card}/Bg`, fn, title);
  act("SkillData_EX (1)", () => runUpdate(), T("act.update"));
  act("SkillData_EX (2)", () => runExtract(), T("act.extract"));
  act("SkillData_EX (3)", () => runCompare(), T("act.compare"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Pin/Pin_On/Bg", toggleFav, T("fav.label"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Pin/Pin_Off/Bg", toggleFav, T("fav.label"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Char_CVCollectionBtn", copyName, baseName(gameFile(variant(), tabKind())));
  // the aliases after the name and the pencil open the alias editor; the tooltip lists them
  const aliasEls = ["Label_Alias", "Char_AliasBtn"].map((n) => view.nodes.get(`Inventory_ListControl/LeftInfo/CharInfo/Char_Target/${n}`)?.els[0]).filter(Boolean);
  if (aliasEls.length) {
    const boxes = aliasEls.map(rect), pad = 14;
    const l = Math.min(...boxes.map((b) => b[0])) - pad, tp = Math.min(...boxes.map((b) => b[1])) - pad;
    const r = Math.max(...boxes.map((b) => b[0] + b[2])) + pad, bt = Math.max(...boxes.map((b) => b[1] + b[3])) + pad;
    const list = aliasList();
    hitButton(leftHost, [l, tp, r - l, bt - tp], () => openAliases(), list ? `${T("alias.title")} - ${list}` : T("alias.title"));
  }
  // the previous or next card of the student list, within its filters and in its order
  add(leftHost, "Arrow_L/Left", () => ctx.step(-1, fam.key, variantKey));
  add(rightHost, "Arrow_R/Right", () => ctx.step(1, fam.key, variantKey));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Char_ZoomBtn", () => setFullscreen(true), T("lobby.fullscreen"));
  if (tab === "lobby") add(leftHost, "LeftInfo/CharInfo/Char_Target/Char_PlayBtn", togglePlayAll, T(Lobby.playingAll() ? "lobby.stop" : "lobby.playAll"));
  const v = variant();
  [["Tab_1", "portrait", true], ["Tab_2", "lobby", hasLobby(v)], ["Tab_3", "model", hasModel(v)]].forEach(([n, id, ok]) => {
    if (ok && id !== tab) add(rightHost, `RightInfo/Target/Active/CharacterTab/${n}/Tab_Off/Label`, () => showTab(id), T(`tab.${id}`));
  });
}

// --- actions ---
async function call(fn) {
  try { return await fn(); } catch (err) { toast(errorText(err), { kind: "error" }); return null; }
}
async function reveal(path) { if (path) await call(() => rpc("os.reveal", { path })); }
async function copyName() {
  const name = baseName(gameFile(variant(), tabKind()));
  try { await navigator.clipboard.writeText(name); toast(name); } catch { toast(name); }
}
async function toggleFav() {
  const v = variant();
  await call(() => rpc("favorites.set", { variant: v.key, on: !isFav(v) }));
  v.favorite = !isFav(v);
  ctx.invalidateRoster();
  renderAll();
}
async function addMods() {
  const added = await call(() => rpc("mods.pick"));
  if (added?.length) { await reload(); ctx.invalidateRoster(); }
}

// a job with a sticky progress line; the family is re-read afterwards (after(ok) instead, when given)
async function job(method, params, { onDone, after = reload } = {}) {
  if (busy) { toast(T("error.busy"), { kind: "error" }); return false; }
  busy = true;
  let ok = false;
  renderScreen();
  toast(T("job.running"), { sticky: true });
  try {
    const id = await rpc(method, params);
    const result = await waitJob(id, (p) => toast(`${T("job.running")} ${p.current}/${p.total}`, { sticky: true }));
    toast(T("job.done"));
    ok = true;
    await onDone?.(result);
  } catch (err) {
    toast(errorText(err), { kind: "error", sticky: false });
  } finally {
    busy = false;
    await after(ok);
  }
  return ok;
}
// the mod the shown tab's game files carry (row 2's update and compare act on it), or null
function shownMod() {
  const sk = switchKind(), c = sk && current(sk);
  return c?.kind === "mod" ? c : null;
}
function runUpdate() {
  const c = shownMod();
  if (!c || busy) return;
  job("actions.update", { mod: c.id }, { onDone: () => { forget(spineBase("mod", c.id)); } });
}
function runExtract() {
  const c = shownMod();
  if (busy) return;
  const target = c ? `mod:${c.id}` : `variant:${variant().key}`;
  job("actions.extract", { target }, { onDone: (r) => reveal(r?.folder) });
}
async function runCompare() {
  const c = shownMod();
  if (!c || busy) return;
  const result = await call(() => rpc("actions.compare", { mod: c.id }));
  if (result) showCompare(result);
}
// switch: the chosen source is written into the variant's game files of that kind, so the game shows it; the library
// keeps what it replaces (an official file until it is official again, a mod in the library)
async function applyCandidate(key, kind = "spr") {
  const v = variant();
  await job("actions.apply", { variant: v.key, source: sourceOf(key), kind }, {
    onDone: () => { forget(kind === "lobby" ? spineBase("lobby", v.lobby) : spineBase("spr", v.spr)); },
    // the applied portrait or lobby swaps in with the rest of the screen; the old one shows until then
    after: (ok) => {
      if (!ok) return reload();
      ctx.invalidateRoster();
      if (kind === "lobby") {
        // lobby.js keeps a lobby by its core: read the game files again, under a still of the old one
        lobbyStale = true;
        lobbyShot = null;
        lobbySeq = null;
        lobbyAll = false;
        if (shownLeft === "lobby") shownKey = null;
      } else {
        expression = "00";
        clearTimeout(blinkTimer);
        mainPlayer = null;
      }
      if (!open) return null; // the screen was left meanwhile: the next show reads the family again
      return changeInPlace(async () => {
        const data = await call(() => rpc("family.get", { key: fam.key }));
        if (data) fam = data;
        await Promise.all([renderAll(), renderLeft()]);
      });
    },
  });
}

// --- variant chips in the nameplate's white panel (style of the game's type chips) ---
// 3 columns x 2 rows; a long name takes two columns; with more variants than fit, the last cell opens the picker.
const CHIP_FS = 38, CHIP_W = 272, CHIP_PITCH = 290;
const chipSpan = (item) => {
  const need = glyphsOf(shortName(item), 32) + (item.recruitable ? 32 * 1.35 / RECRUIT.ratio + 6 : 0) + (appliedKey(item) !== "self" ? 34 : 0);
  return need > CHIP_W - 40 ? 2 : 1;
};
const byRank = (a, b) => (isFav(b) - isFav(a)) || (b.recruitable - a.recruitable) || a.order - b.order;
function placeChips(items) {
  const cells = [];
  let row = 0, col = 0;
  for (const item of items) {
    const span = chipSpan(item);
    if (col + span > 3) { row += 1; col = 0; }
    if (row > 1) return null;
    cells.push({ v: item, row, col, span });
    col += span;
  }
  return cells;
}
function chipLayout() {
  // favourites first, then recruitable variants, then the others in release order
  const list = fam.variants.filter((v) => v.spr).sort(byRank);
  const all = placeChips(list);
  if (all) return all;
  // six cells, the last one is "more": take variants in order, skipping ones too wide for the space left in a row
  const caps = [3, 2], fill = [0, 0], picked = [];
  const tryPlace = (v) => {
    const span = chipSpan(v);
    for (let r = 0; r < 2; r++) if (fill[r] + span <= caps[r]) { picked.push({ v, row: r, col: fill[r], span }); fill[r] += span; return true; }
    return false;
  };
  for (const v of list) { tryPlace(v); if (fill[0] === caps[0] && fill[1] === caps[1]) break; }
  // the current variant is always shown
  if (!picked.some((p) => p.v.key === variantKey)) {
    const last = [...picked].reverse().find((p) => p.span === chipSpan(variant()) || (p.span === 2 && chipSpan(variant()) === 1));
    if (last) Object.assign(last, { v: variant(), span: chipSpan(variant()) });
  }
  return [...picked, { more: list.length - picked.length, row: 1, col: 2, span: 1 }];
}
function chipNode(name, pos, w, caption, active, swapped, mark, fresh = false) {
  const body = sprite("Common_Bg_Raius10px", w, 72, { incline: 10, depth: 5, color: active ? "#2c4564/1.00" : "#ffffff/1.00" });
  const color = active ? "#ffffff/1.00" : "#2c4564/1.00";
  const lbl = markedLabel(caption, { fs: CHIP_FS, fsMin: 28, color, maxW: w - 40 - (swapped ? 30 : 0), mark, depth: 8 });
  const kids = [node("Label", [swapped ? -15 : 0, 0], [], lbl.nodes)];
  if (!active) kids.push(node("Line", [0, 0], [sprite("Common_Line_Raius10px", w, 72, { incline: 10, depth: 6, color: "#c0c9d4/1.00" })]));
  // the variant wears another portrait: the game's swap icon at the right end
  if (swapped) kids.push(node("Swapped", [w / 2 - 36, 0], [sprite("Common_Icon_Change", 32, 32, { type: 0, depth: 9, color: active ? "#e6b6ef/1.00" : "#9c44ac/1.00" })]));
  if (fresh) kids.push(DOT([w / 2 - 4 + 36 * TAN10, 34], 30));
  return node(name, pos, [body], kids);
}
async function renderChips() {
  const my = ++chipToken, gen = showGen;
  const ok = () => showable("chips", my, chipToken, gen);
  const host = $("ngui-chips");
  // Char_Target sits at (-1480, -720); BG2 (886 x 202, top-centre at 514, 234, sheared about its centre) holds the chips
  const CENTRE_Y = 234 - 101;
  const tree = node("Chips", [-1480, -720], [], chipLayout().map(({ v, more, row, col, span }) => {
    const y = 234 - 58 - row * 84, x = 514 + (y - CENTRE_Y) * TAN10 + (col + (span - 1) / 2 - 1) * CHIP_PITCH;
    const w = CHIP_W + (span - 1) * CHIP_PITCH;
    return v
      ? chipNode(`Chip_${v.key}`, [x, y], w, shortName(v), v.key === variantKey, appliedKey(v) !== "self", v.recruitable, hasFresh(v))
      : chipNode("Chip_more", [x, y], w, T("chips.more", { n: more }), false, false, false);
  }));
  const next = document.createDocumentFragment();
  const view = await NGUI.render(tree, next, { scale: S, origin: ORIGIN, z: 20 });
  if (!ok()) return; // a newer render took over
  for (const [path, entry] of view.nodes) {
    const m = /\/Chip_([^/]*)$/.exec(path);
    if (m && entry.els[0]) hitButton(next, rect(entry.els[0]), () => (m[1] === "more" ? openPicker() : ctx.go(fam.key, m[1])));
  }
  commit(() => {
    if (!ok()) return;
    applied.chips = my;
    host.replaceChildren(next);
  });
}

// --- row 4: a box, then cards on the columns of row 2's skill cards, the pile in the button column ---
function stripCard(name, x, { w = CARD.w, h = CARD.h, thumb: pic = null, selected = false, dim = false, caption = "", body = "", placeholder = false, tone = "#ffffff" } = {}) {
  const vis = h - 13, cy = 6.5; // the visible body's centre sits 6.5 units above the widget's centre
  const kids = [node("Line", [1, cy], [sprite("Common_Line_Raius20px", w - 10, vis, { incline: 10, depth: 9, color: "#bebebe/1.00" })])];
  if (pic) kids.push(node("Thumb", [1, cy], [{ clipImage: pic, w_: w - 18, h_: vis - 8, pivot: 4, depth: 8, incline: 10, radius: 16, color: "#ffffff/1.00", imgSize: "cover", imgPosition: "center 50%" }]));
  if (dim) kids.push(node("Dim", [1, cy], [sprite("Common_Bg_Raius20px", w - 12, vis - 4, { incline: 10, depth: 10, color: "#000000/0.50" })]));
  if (caption) {
    const f = fitText(caption, 56, 28, w - 50);
    kids.push(node("Caption", [0, cy], [label(f.text, f.fs, dim ? "#ffffff/1.00" : "#2c4564/1.00", w - 30, f.fs * 1.3 * f.lines, { depth: 12 })]));
  }
  if (body) {
    // a dialogue line: centred on the card, as large as fits in up to four lines; a longer line ends in an ellipsis
    // (the subtitle shows it in full). A placeholder (no line in the UI language) is grey and slanted.
    let f = fitText(body, 40, 32, w - 52, 4), cut = body;
    while (f.lines === 1 && glyphsOf(f.text, f.fs) > w - 52 && cut.length > 4) { cut = cut.slice(0, -2).trimEnd(); f = fitText(`${cut}…`, 40, 32, w - 52, 4); }
    const ink = placeholder ? "#8f9aa6/1.00" : "#2c4564/1.00";
    kids.push(node("Body", [0, cy], [label(f.text, f.fs, ink, w - 40, f.fs * 1.3 * f.lines, { depth: 12, italic: placeholder })]));
  }
  if (selected) kids.push(node("Select", [1, cy], [sprite("Card_Select_Line_Blue", w + 6, vis + 8, { incline: 10, depth: 20 })],
    [node("Check", [w / 2 - 30 + (vis / 2 - 26) * TAN10, vis / 2 - 26], [sprite("Common_Icon_Check_B", 56, 54, { type: 0, depth: 21 })])]));
  return node(name, [x, ROW4_Y - cy], [sprite("Common_Btn_BG", w, h, { incline: 10, depth: 7, color: `${tone}/1.00` })], kids);
}

// row 4 per tab: the portrait's faces, the memorial lobby's dialogues
function row4Items() {
  if (tab === "lobby") {
    // the dialogue's lines in the UI language, else a numbered placeholder
    return (Lobby.meta()?.sequences || []).map((sq) => {
      const text = Lobby.textOf(sq).join(" "), none = T("lobby.dialogue", { n: sq.n });
      return text ? { key: sq.anim, body: text, title: text } : { key: sq.anim, body: none, placeholder: true, title: none };
    });
  }
  if (tab === "model") return modelActions.map((a) => ({ key: a, caption: T(`model.action.${a}`), title: T(`model.action.${a}`) }));
  const base = baseOf(current());
  const names = mainPlayer?.skeleton ? mainPlayer.skeleton.data.animations.map((a) => a.name).filter((n) => /^\d{2}$/.test(n)).sort() : [];
  return (names.length ? names : ["00"]).map((e) => ({ key: e, thumb: thumb(base, "face", e) }));
}
const row4Selected = () => (tab === "lobby" ? lobbySeq : tab === "model" ? modelAction : expression);
function row4Pick(key) {
  // the card follows the dialogue through Lobby.onTalk: selected while it plays, let go when it ends
  if (tab === "lobby") { if (Lobby.playing() === key) Lobby.stop(); else Lobby.play(key); }
  else if (tab === "model") {
    modelAction = key;
    modelLib?.then((M) => M.play(key));
  } else { expression = key; applyExpression(); }
}
// play every dialogue in order; the cards and the play-all button follow along (Lobby.onTalk)
function togglePlayAll() {
  if (Lobby.playingAll()) Lobby.stop();
  else Lobby.playAll();
}
// a dialogue started (a card, play all, a tap on the character in fullscreen), ended or stopped. A lobby that is
// hidden stops without telling (and off the lobby tab nothing is followed): the tab change, the variant change and
// hide() reset what is followed here, so the next start redraws the cards and the play-all button.
let lobbyAll = false;
Lobby.onTalk((anim, all) => {
  if (tab !== "lobby" || (lobbySeq === anim && lobbyAll === all)) return;
  const button = lobbyAll !== all;
  lobbySeq = anim;
  lobbyAll = all;
  renderExpressions();
  if (button) renderScreen();
});

async function renderExpressions() {
  const my = ++exprToken, gen = showGen;
  const ok = () => showable("expr", my, exprToken, gen);
  const host = $("ngui-expr");
  const list = row4Items(), sel = row4Selected(), unfolded = expanded, pics = [];
  const cardOf = (it, x, extra = {}) => stripCard(`Item_${it.key}`, x, { thumb: it.thumb, body: it.body, placeholder: it.placeholder, caption: it.caption, selected: it.key === sel, ...extra });
  const cards = [];
  if (unfolded || list.length <= 4) {
    list.forEach((it, i) => cards.push({ tree: cardOf(it, COLS[0] + i * PITCH), item: it }));
    if (unfolded) cards.push({ tree: stripCard("Fold", COLS[0] + list.length * PITCH, { caption: T("fold.label"), tone: "#eef4f8" }), fold: true });
  } else {
    // three cards; a chosen item further along takes the third card so it stays in view
    const shown = list.slice(0, 3);
    const chosen = list.find((it) => it.key === sel);
    if (chosen && !shown.includes(chosen)) shown[2] = chosen;
    shown.forEach((it, i) => cards.push({ tree: cardOf(it, COLS[i]), item: it }));
    // the pile fills the button column: two plain cards behind, the top one darkened with the count
    const rest = list.filter((it) => !shown.includes(it));
    const pw = 178, right = BTN_COL[1];
    cards.push({ tree: stripCard("Pile_2", right - pw / 2, { w: pw, h: CARD.h - 24, tone: "#dfe8ef" }), pile: true, z: 100 });
    cards.push({ tree: stripCard("Pile_1", right - pw / 2 - 14, { w: pw, h: CARD.h - 12, tone: "#eef4f8" }), pile: true, z: 140 });
    cards.push({ tree: stripCard("Pile_0", right - pw / 2 - 28, { w: pw, thumb: rest[0].thumb, dim: !!rest[0].thumb, caption: `+${rest.length}`, tone: rest[0].thumb ? "#ffffff" : "#d3dee8" }), pile: true, z: 180 });
  }
  // clip: the row's height, from the box's slanted right edge to the row's inner right edge
  const Lx = 300, Rx = 1316, TOPU = -436, BOTU = -670;
  const [cl, ct] = toStage(Lx, TOPU);
  const clip = document.createElement("div");
  clip.className = "expr-clip";
  Object.assign(clip.style, { left: `${cl}px`, top: `${ct}px`, width: `${(Rx - Lx) * S}px`, height: `${(TOPU - BOTU) * S}px` });
  const edgeTop = BOX_RIGHT + (TOPU - ROW4_Y) * TAN10 + 5 - Lx, edgeBottom = BOX_RIGHT + (BOTU - ROW4_Y) * TAN10 + 5 - Lx;
  clip.style.clipPath = `polygon(${edgeTop * S}px 0, 100% 0, 100% 100%, ${edgeBottom * S}px 100%)`;
  const track = document.createElement("div");
  track.className = "expr-track";
  clip.appendChild(track);
  const origin = [ORIGIN[0] - cl, ORIGIN[1] - ct];
  await Promise.all(cards.map(async (cd) => {
    const view = await NGUI.render(cd.tree, track, { scale: S, origin, z: cd.z || 30, textureNames: TEXTURES });
    pics.push(...view.pictures);
    const body = view.nodes.get(cd.tree.name)?.els[0];
    if (!body || (cd.pile && cd.tree.name !== "Pile_0")) return;
    hitButton(track, rect(body), () => {
      if (track.dataset.dragged) return;
      if (cd.item) { row4Pick(cd.item.key); keepScroll(); renderExpressions(); }
      if (cd.pile) { expanded = true; exprScroll = 0; renderExpressions(); }
      if (cd.fold) { expanded = false; renderExpressions(); }
    }, cd.item?.title || "", 260);
  }));
  if (!ok()) return; // a newer render took over (e.g. the tab changed while faces were rendering)
  if (my === exprToken) exprPics = pics;
  if (unfolded) {
    clip.classList.add("expanded");
    track.style.width = `${(COLS[0] + list.length * PITCH + CARD.w / 2 + 24 - Lx) * S}px`;
    enableDrag(clip, track);
  }
  commit(() => {
    if (!ok()) return;
    applied.expr = my;
    host.replaceChildren(clip);
    if (unfolded) clip.scrollLeft = exprScroll;
  });
}
const keepScroll = () => { exprScroll = document.querySelector(".expr-clip")?.scrollLeft || 0; };
function enableDrag(clip, track) {
  let start = null;
  clip.addEventListener("pointerdown", (e) => { start = { x: e.clientX, left: clip.scrollLeft }; delete track.dataset.dragged; });
  clip.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = (e.clientX - start.x) / (stage().getBoundingClientRect().width / 1920);
    if (Math.abs(dx) > 4) track.dataset.dragged = "1";
    clip.scrollLeft = start.left - dx;
  });
  const end = () => { start = null; setTimeout(() => delete track.dataset.dragged, 0); };
  clip.addEventListener("pointerup", end);
  clip.addEventListener("pointerleave", end);
}

// --- main Spine portrait ---
// loadSpine(base) -> Promise, resolved once the portrait's first frame is drawn and the expression strip shows its
// faces (also on an error, after the toast). The new layer stays transparent until committed; then it fades in over
// the old one, which goes. A portrait that cannot be shown takes the old one away too: the left side stays empty
// rather than showing another variant under this one's name.
function loadSpine(base) {
  const my = ++spineToken;
  const host = $("portrait");
  const layer = document.createElement("div");
  layer.className = host.children.length || batch ? "layer fading" : "layer";
  host.appendChild(layer);
  const previous = [...host.querySelectorAll(".layer")].filter((l) => l !== layer);
  clearTimeout(blinkTimer);
  prioritise(base);
  // layers fade out, then their players are freed (once each: a failed portrait may retire layers already going)
  const retire = (layers) => {
    for (const old of layers) {
      if (old.retired) continue;
      old.retired = true;
      old.classList.add("fading");
      // disposePortrait() may have freed it meanwhile (a quick second step)
      setTimeout(() => { if (old.isConnected) { old.player?.dispose(); old.remove(); } }, 400);
    }
  };
  return new Promise((resolve) => {
    layer.done = resolve; // settled by disposePortrait() too
    layer.player = new spine.SpinePlayer(layer, {
      // the idle is set in success(): some NPC skeletons have no Idle_01, and spine-player fails on a missing one
      skeleton: `${base}.skel`, atlas: `${base}.atlas`, animation: undefined,
      premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000",
      showControls: false, showLoading: false, preserveDrawingBuffer: true,
      // framed like the game (portrait-view.js), never on the skeleton's bounds; no viewport transition:
      // spine-player starts it from an undefined viewport and draws nothing meanwhile
      viewport: detailViewport(),
      // the visual mode (visual-mode.js) frames it while it is open
      frame: (p) => Visual.frame(p),
      success: async (player) => {
        // before the first await: once this returns, spine-player frames the view on track 0's animation and plays.
        // With nothing on track 0 it would pause (no face, no blink): a skeleton without an idle gets an empty
        // animation there that never ends, so it keeps its setup pose and the faces on tracks 1-2 still play.
        const idle = idleAnimation(player.skeleton.data);
        if (idle) player.animationState.setAnimation(0, idle, true);
        else player.animationState.setEmptyAnimation(0, 0).trackEnd = Number.MAX_VALUE;
        if (my !== spineToken) { resolve(); return; } // a newer portrait took over; it retires this layer
        mainPlayer = player;
        applyExpression();
        scheduleBlink(player);
        await renderExpressions(); // the faces come from this skeleton
        await frames(2);           // its first frame is on the canvas
        commit(() => {
          if (my !== spineToken) return;
          layer.classList.remove("fading");
          retire(previous);
        });
        resolve();
      },
      error: (player, message) => {
        console.error(message);
        toast(T("error.internal", { error: message }), { kind: "error" });
        // spine-player's own error box (black, with the message) never shows: the toast says it
        layer.querySelector(".spine-player-error")?.remove();
        if (my === spineToken) {
          if (mainPlayer === player) { clearTimeout(blinkTimer); mainPlayer = null; } // it broke after it was shown
          commit(() => { if (my === spineToken) retire([...previous, layer]); });
        }
        resolve();
      },
    });
  });
}
// the detail screen's portrait framing: the skeleton's origin on CharacterPos
const detailViewport = () => portraitViewport(layouts && find(layouts.list, "CharacterPos"), { origin: ORIGIN, s: S, box: PORTRAIT_BOX });
function scheduleBlink(player) {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => {
    if (player.skeleton?.data.findAnimation("Eye_Close_01")) {
      player.animationState.setAnimation(2, "Eye_Close_01", false);
      player.animationState.addEmptyAnimation(2, 0.1, 0);
    }
    scheduleBlink(player);
  }, 2500 + Math.random() * 3500);
}
function applyExpression() {
  if (mainPlayer?.skeleton?.data.findAnimation(expression)) mainPlayer.animationState.setAnimation(1, expression, true);
}
function disposePortrait() {
  clearTimeout(blinkTimer);
  spineToken += 1;
  for (const l of $("portrait").querySelectorAll(".layer")) { l.player?.dispose(); l.done?.(); l.remove(); }
  mainPlayer = null;
}

// --- popups on the game's popup frame (UIPopup_Sort), laid out like the game's quick formation edit: the selection's
// details on the left, a framed list with the student list's tools on the right, the confirm button under it ---
const LP = {
  frame: { w: 2860, h: 1520 },                  // Common_Popup_Bg, stretched to almost the whole screen
  left: { l: -1370, r: -520, t: 600, b: -690 }, // details panel
  list: { l: -480, r: 1370, t: 600, b: -470 },  // list panel (light blue frame)
  ok: { x: 1150, y: -600, w: 440, h: 160 },     // confirm
  card: { w: 250, h: 226, bar: 68 },            // card body (Common_Btn_BG) and its name bar
  pitch: [284, 350],
};
const COLS6 = 6;

// a click on a popup's backdrop or Escape closes it, as the game's PopupClose does; its body takes the clicks that
// miss its controls
let closeTop = null;
function closable(view, close) {
  const back = view.nodes.get("Center/BlackBg/BlackBgClickArea")?.els[0];
  if (back) { back.style.pointerEvents = "auto"; back.addEventListener("click", close); }
  const body = view.nodes.get("Center/Popup/Base/BG")?.els[0];
  if (body) body.style.pointerEvents = "auto";
  closeTop = close;
}
addEventListener("keydown", (ev) => {
  // Escape while an input method composes (an alias being typed) cancels the composition, not the popup
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key !== "Escape" || !closeTop || ($("popup").hidden && $("picker").hidden)) return;
  ev.preventDefault();
  closeTop();
});

function toolbar(right, y, { segs = null, sortKey = "sort.default", active = 0 } = {}) {
  const menu = find(layouts.collection, "SeletControl/TopMenu");
  const kids = [];
  let x = right;
  const order = clone(find(menu, "OrderBtn"));
  order.pos = [x - 243 / 2 + 45.1, y];
  x -= 243 + 16;
  const sort = clone(find(menu, "SortBtn"));
  const sortW = 420;
  const body = find(sort, "Btn_Normal");
  const shrink = 622 - sortW;
  body.widgets.find((w) => "sprite" in w).w_ = sortW;
  for (const m of ["FilterMarker_Off", "FilterMarker_On"]) {
    const n = find(body, m);
    n.pos[0] += shrink / 2;
    find(n, "Icon").pos[0] -= shrink;
    find(n, "Filter_02").widgets[0].w_ -= shrink;
  }
  find(body, "Icon").pos[0] -= shrink / 2;
  find(body, "Type_1").active = false;
  const type2 = find(body, "Type_2");
  type2.active = true;
  const st = fitText(T(sortKey), 56, 36, sortW - 150);
  Object.assign(find(type2, "Text").widgets[0], { text: st.text, fontSize: st.fs, w_: sortW - 120 });
  find(type2, "Text").pos[0] = 30;
  sort.pos = [x - sortW / 2 + 83, y];
  x -= sortW + 16;
  const search = clone(find(menu, "SearchBtn"));
  search.pos = [x - 150 / 2 - 89, y];
  x -= 150 + 16;
  kids.push(order, sort, search);
  let segBox = null;
  if (segs) {
    const filter = clone(find(menu, "FilterBtn"));
    const segW = 230, sx = segW / 328;
    filter.scale = [sx, 1];
    [["All", segs[0]], ["Main", segs[1]], ["Support", segs[2]]].forEach(([k, key], i) => {
      const seg = find(filter, k);
      for (const state of seg.children) {
        for (const c of state.children || []) {
          const tex = c.widgets.find((w) => "texture" in w);
          if (tex) {
            const f = fitText(T(key), 44, 26, segW - 30);
            c.widgets = [label(f.text, f.fs, tex.color, (segW - 20) / sx, 60, { depth: 9 })];
          }
        }
        state.active = (state.name === "Btn_Pressed") === (i === active);
      }
    });
    filter.pos = [x - 3 * segW + 123 * sx + 164 * sx - 6, y + 50.2];
    segBox = { right: x, segW, y };
    kids.push(filter);
  }
  return { tree: node("Toolbar", [0, 0], [], kids), segBox };
}

function listFrame(title, okText) {
  const t = clone(find(layouts.sortPopup, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: LP.frame.w, h_: LP.frame.h });
  const top = LP.frame.h / 2;
  find(bg, "Texture_Top").pos = [-LP.frame.w / 2 + 248, top - 66];
  const titleNode = find(bg, "Label_Title_Locale");
  const titleFit = fitText(title, 72, 52, 1300);
  Object.assign(titleNode.widgets[0], { text: titleFit.text, fontSize: titleFit.fs, w_: 1400 });
  titleNode.pos = [0, top - 64];
  find(titleNode, "Line").widgets[0].w_ = glyphsOf(titleFit.text, titleFit.fs) + 14;
  find(bg, "Btn_Close").pos = [LP.frame.w / 2 - 90, top - 60];
  // confirm: the popup's OK button, moved under the list like the game's quick edit
  const btn = find(popup, "Btn");
  find(btn, "Btn_Cancel").active = false;
  const ok = find(btn, "Btn_Ok");
  btn.pos = [0, 0];
  ok.pos = [LP.ok.x, LP.ok.y];
  const okFit = fitText(okText, 72, 48, 360);
  Object.assign(find(ok, "Label_Locale").widgets[0], { text: okFit.text, fontSize: okFit.fs });
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
  const panel = (name, b, tone) => node(name, [(b.l + b.r) / 2, (b.t + b.b) / 2], [sprite("Common_Bg_Raius10px", b.r - b.l, b.t - b.b, { depth: 3, color: tone })]);
  popup.children.push(
    panel("LeftPanel", LP.left, "#ffffff/0.00"),
    panel("ListPanel", LP.list, "#d7eaf4/1.00"),
    node("ListPaper", [(LP.list.l + LP.list.r) / 2, (LP.list.t - 150 + LP.list.b + 16) / 2],
      [sprite("Common_Bg_Raius10px", LP.list.r - LP.list.l - 32, LP.list.t - 150 - LP.list.b - 16, { depth: 4, color: "#f4fcfe/1.00" })]));
  return t;
}

// one card of the list: the game's card body, the picture clipped to its window, a name bar under it
function listCard(it, x, y, selected) {
  const { w, h, bar } = LP.card;
  const kids = [
    node("Thumb", [1, 4], [{ clipImage: it.thumb, w_: w - 16, h_: h - 26, pivot: 4, depth: 8, incline: 10, radius: 18, color: "#ffffff/1.00", imgSize: "cover", imgPosition: "center 30%" }]),
    node("Line", [1, 4], [sprite("Common_Line_Raius20px", w - 12, h - 18, { incline: 10, depth: 9, color: "#ffffff/1.00" })]),
  ];
  const lbl = markedLabel(it.label, { fs: 34, fsMin: 24, color: "#ffffff/1.00", maxW: w - 56, mark: false, maxLines: 2 });
  const barH = Math.max(bar, 22 + lbl.lines * lbl.fs * 1.2), barY = -h / 2 - 10 - barH / 2;
  kids.push(node("Bar", [barY * TAN10 + 4, barY], [sprite("Common_Bg_Raius10px", w - 22, barH, { incline: 10, depth: 8, color: "#2c4564/1.00" })], [node("Name", [0, 0], [], lbl.nodes)]));
  const corner = (dx, dy) => [dx + dy * TAN10, dy]; // a point inside the slanted card
  if (it.inUse) kids.push(node("Using", corner(-w / 2 + 70, h / 2 - 30), [sprite("Common_Bg_Raius10px", 116, 42, { depth: 26, color: "#ffbc11/1.00", incline: 10 })],
    [node("Text", [0, 0], [label(T("popup.inUse"), fitText(T("popup.inUse"), 26, 18, 100).fs, "#3a2a00/1.00", 112, 40, { depth: 27 })])]));
  if (it.fav) kids.push(node("Pin", corner(w / 2 - 38, -h / 2 + 36), [sprite("Common_Btn_Pin_01", 54, 54, { type: 0, depth: 26 })]));
  if (it.recruit) kids.push(node("Recruit", corner(-w / 2 + 34, -h / 2 + 40), [sprite(RECRUIT.sprite, 62 / RECRUIT.ratio, 62, { atlas: RECRUIT.atlas, type: 0, depth: 26 })]));
  // the new dot goes once the card is picked (it has been seen); the check takes the corner
  if (it.isNew && !selected) kids.push(DOT(corner(w / 2 - 4, h / 2 - 6), 34));
  if (selected) kids.push(node("Select", [1, 4], [sprite("Card_Ability_Select_Line", w + 4, h - 8, { incline: 10, depth: 20 })],
    [node("Check", [w / 2 - 28 + (h / 2 - 30) * TAN10, h / 2 - 30], [sprite("Card_Ability_Select_Line_Icon", 66, 65, { type: 0, depth: 21 })])]));
  return node(`Card_${it.key}`, [x, y], [sprite("Common_Btn_BG", w, h, { incline: 10, depth: 7, color: "#ffffff/1.00" })], kids);
}

// the details panel: title bar, the picture, name, kind chips, fields, actions
function detailsTree(it, title, fields, actions) {
  const b = LP.left, cx = (b.l + b.r) / 2, w = b.r - b.l;
  const kids = [
    node("Title_Bg", [cx, b.t - 40], [sprite("Common_Bg_Raius10px", w - 20, 73, { depth: 5, color: "#2d4c72/1.00", incline: 10 })], [
      node("Deco", [-(w - 20) / 2 + 30, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", type: 0 })]),
      node("Deco (1)", [(w - 20) / 2 - 30, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", flip: 3, type: 0 })]),
      node("Label", [0, 0], [label(title, fitText(title, 46, 32, w - 140).fs, "#ffffff/1.00", w - 140, 50, { depth: 7 })]),
    ]),
    node("Picture", [cx, b.t - 330], [sprite("Common_Btn_BG", w - 40, 460, { incline: 10, depth: 6, color: "#ffffff/1.00" })], [
      node("Thumb", [1, 4], [{ clipImage: typeof it.big === "function" ? it.big() : it.big, w_: w - 60, h_: 430, pivot: 4, depth: 7, incline: 10, radius: 22, color: "#ffffff/1.00", imgSize: "cover", imgPosition: "center 18%" }]),
      node("Line", [1, 4], [sprite("Common_Line_Raius20px", w - 54, 438, { incline: 10, depth: 8, color: "#ffffff/1.00" })]),
    ]),
  ];
  const nameFit = fitText(it.full, 52, 36, w - 60);
  kids.push(node("Name", [cx, b.t - 610], [label(nameFit.text, nameFit.fs, "#2d4664/1.00", w - 40, 60 * nameFit.lines, { depth: 8 })]));
  const chips = [it.recruit ? T("type.recruit") : it.kind === "mod" ? T("type.added") : T("type.noRecruit"), ...(it.inUse ? [T("popup.inUse")] : [])];
  chips.forEach((c, i) => {
    const cw = 250, x = cx + (i - (chips.length - 1) / 2) * (cw + 16);
    kids.push(node(`Chip_${i}`, [x, b.t - 690], [sprite("Common_Bg_Raius10px", cw, 60, { incline: 10, depth: 6, color: i === 0 && it.recruit ? "#2c4564/1.00" : "#ffffff/1.00" })], [
      node("Line", [0, 0], [sprite("Common_Line_Raius10px", cw, 60, { incline: 10, depth: 7, color: "#c0c9d4/1.00" })]),
      node("Text", [0, 0], [], markedLabel(c, { fs: 32, fsMin: 24, color: i === 0 && it.recruit ? "#ffffff/1.00" : "#2c4564/1.00", maxW: cw - 30, mark: i === 0 && it.recruit, depth: 8 }).nodes),
    ]));
  });
  // fields, on the game's light stats box; long values (file names) wrap, never cut
  const capW = Math.max(...fields.map(([k]) => advanceOf(k, 38))) + 30, room = w - 120 - capW;
  const values = fields.map(([, v]) => wrapPath(String(v), 38, 26, room, 3));
  const rowHs = values.map((f) => Math.max(64, f.lines * f.fs * 1.25 + 16));
  const boxT = b.t - 750, boxH = rowHs.reduce((a, h) => a + h, 0) + 24;
  kids.push(node("Fields", [cx, boxT - boxH / 2], [sprite("Common_Bg_Raius10px", w - 40, boxH, { depth: 5, color: "#ecf5f9/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", w - 34, boxH + 6, { depth: 4, color: "#c0c9d4/1.00" })]),
  ]));
  let top = boxT - 12;
  fields.forEach(([k, , color], i) => {
    const rowH = rowHs[i], y = top - rowH / 2, x0 = b.l + 50, f = values[i];
    kids.push(node(`F_${i}`, [x0, y], [label(k, 38, "#2d4664/1.00", capW, 50, { pivot: 3, depth: 8 })]));
    kids.push(node(`V_${i}`, [x0 + capW, y], [label(f.text, f.fs, color || "#000000/1.00", room + 20, f.lines * f.fs * 1.25 + 8, { pivot: 3, depth: 8 })]));
    if (i < fields.length - 1) kids.push(node(`L_${i}`, [cx, y - rowH / 2], [sprite("Common_Line_Dot", w - 100, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]));
    top -= rowH;
  });
  actions.forEach(([caption], i) => {
    const bw = (w - 60) / actions.length, x = b.l + 30 + bw / 2 + i * bw, f = fitText(caption, 40, 26, bw - 60);
    kids.push(node(`Act_${i}`, [x, b.b + 70], [sprite("Common_Btn_BG", bw - 14, 120, { depth: 6, color: "#dbeef5/1.00", incline: 10 })], [
      node("Pt", [50, -2], [sprite("Common_Btn_Normal_B_C_Pt", 126, 70, { type: 0, depth: 7, color: "#ffffff/0.80" })]),
      node("Label", [0, 6], [label(f.text, f.fs, "#2d5164/1.00", bw - 40, 60 * f.lines, { depth: 8 })]),
    ]));
  });
  return node("Details", [0, 0], [], kids);
}

// a scrolling card area with the game list's scrollbar colours
function scrollArea(host, [l, t, w, h], contentH) {
  const area = document.createElement("div");
  area.className = "popup-cards";
  Object.assign(area.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
  const inner = document.createElement("div");
  inner.className = "popup-cards-inner";
  inner.style.height = `${contentH}px`;
  area.appendChild(inner);
  host.appendChild(area);
  if (contentH > h + 1) {
    const bar = document.createElement("div");
    bar.className = "scrollbar";
    Object.assign(bar.style, { left: `${l + w + 8}px`, top: `${t + 6}px`, height: `${h - 12}px` });
    const th = document.createElement("i");
    th.style.height = `${(h - 12) * (h / contentH)}px`;
    th.style.top = "0";
    bar.appendChild(th);
    host.appendChild(bar);
    area.addEventListener("scroll", () => { th.style.top = `${(h - 12 - parseFloat(th.style.height)) * area.scrollTop / (contentH - h)}px`; });
  }
  return inner;
}

// renders a list popup; items: { key, label, full, thumb, big, recruit, kind, inUse, fav, isNew }
async function listPopup({ hostId, title, okText, items, selected, onSelect, onOk, onClose, segs, seg = 0, onSeg, sortKey, details, keepScroll: scrollTop = 0 }) {
  const my = ++popupToken;
  const host = $(hostId);
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(listFrame(title, okText), next, { scale: S, origin: [960, 540] });
  const hit = (path, fn) => { const el = view.nodes.get(path)?.els[0]; if (el) hitButton(next, rect(el), fn, "", 80); };
  hit("Center/Popup/Btn/Btn_Ok/BG (1)", onOk);
  hit("Center/Popup/Base/BG/Btn_Close", onClose);
  closable(view, onClose);
  const tb = toolbar(LP.list.r - 24, LP.list.t - 76, { segs, sortKey, active: seg });
  await NGUI.render(tb.tree, next, { scale: S, origin: [960, 540], z: 20 });
  if (tb.segBox && onSeg) {
    const { right, segW, y } = tb.segBox;
    for (let i = 0; i < 3; i++) {
      const ux = right - (3 - i) * segW + segW / 2 - 6, uy = y + 50.2 - 50;
      hitButton(next, [960 + (ux - segW / 2) * S, 540 - (uy + 52) * S, segW * S, 104 * S], () => onSeg(i), T(segs[i]), 80);
    }
  }
  const top = LP.list.t - 166, bottom = LP.list.b + 24;
  const [aL, aT] = [960 + (LP.list.l + 16) * S, 540 - top * S];
  const rows = Math.ceil(items.length / COLS6);
  const contentH = (rows * LP.pitch[1] + 20) * S, visH = (top - bottom) * S;
  const inner = scrollArea(next, [aL, aT, (LP.list.r - LP.list.l - 32) * S, visH], contentH);
  const origin = [960 - aL, 540 - aT];
  // centre the grid on its ink: slanted cards lean right at the top (+h/2 tan10) and left under the name bar
  const leanL = (LP.card.h / 2 + 10 + LP.card.bar) * TAN10, leanR = (LP.card.h / 2) * TAN10;
  const inkW = (COLS6 - 1) * LP.pitch[0] + LP.card.w + leanL + leanR, areaW = LP.list.r - LP.list.l - 32 - 30;
  const x0 = LP.list.l + 16 + (areaW - inkW) / 2 + leanL + LP.card.w / 2;
  await Promise.all(items.map(async (it, i) => {
    const x = x0 + (i % COLS6) * LP.pitch[0], y = top - 30 - LP.card.h / 2 - Math.floor(i / COLS6) * LP.pitch[1];
    await NGUI.render(listCard(it, x, y, it.key === selected), inner, { scale: S, origin, z: 30 });
    const [sx, sy] = [origin[0] + x * S, origin[1] - y * S];
    hitButton(inner, [sx - LP.card.w / 2 * S, sy - LP.card.h / 2 * S, LP.card.w * S, (LP.card.h + 90) * S], () => onSelect(it.key, inner.parentElement.scrollTop), it.full, 60);
  }));
  const sel = items.find((it) => it.key === selected) || items[0];
  if (sel) {
    const d = details(sel);
    const dv = await NGUI.render(detailsTree(sel, d.title, d.fields, d.actions), next, { scale: S, origin: [960, 540], z: 20 });
    d.actions.forEach(([, fn], i) => {
      const el = dv.nodes.get(`Details/Act_${i}`)?.els[0];
      if (el && fn) hitButton(next, rect(el), fn, d.actions[i][0], 80);
    });
  }
  if (my !== popupToken || host.hidden) return;
  host.replaceChildren(...next.childNodes);
  host.querySelector(".popup-cards").scrollTop = scrollTop;
}

// switch portrait or memorial lobby: the variant's own skeleton and added ones, then the other variants' portraits;
// OK writes the chosen one into the game files (applyCandidate)
let popupSeg = 0, popupToken = 0, popupKind = "spr";
async function renderPopup(scroll = 0) {
  const v = variant(), kind = popupKind, inUseKey = appliedKey(v, kind);
  const items = candidates(v, kind).map((c) => ({
    key: c.key, kind: c.kind, recruit: c.kind !== "mod" && c.recruit,
    label: candidateLabel(c, v),
    full: c.kind === "mod" ? c.label : fullName(c.variant),
    thumb: thumb(baseOf(c, kind), "card"), big: () => thumb(baseOf(c, kind), "bust"),
    inUse: c.key === inUseKey, fav: c.fav, isNew: c.kind === "mod" && c.mod.fresh, src: c,
  }))
    .filter((it) => popupSeg === 0 || (popupSeg === 1) === !!it.recruit)
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0));
  await listPopup({
    hostId: "popup", title: T(kind === "lobby" ? "row.switch.lobby" : "popup.switch"), okText: T("popup.apply"), items, selected: pending, keepScroll: scroll,
    segs: ["seg.all", "seg.recruit", "seg.noRecruit"], seg: popupSeg, onSeg: (i) => { popupSeg = i; renderPopup(); }, sortKey: "sort.default",
    onSelect: (key, s) => {
      pending = key;
      const c = candidates(v, kind).find((x) => x.key === key);
      if (c?.kind === "mod" && c.mod.fresh) rpc("mods.seen", { id: c.id }).then(() => { c.mod.fresh = false; }).catch(() => {});
      renderPopup(s);
    },
    onOk: () => closePopup(true), onClose: () => closePopup(false),
    details: (it) => {
      const c = it.src, inUse = it.inUse;
      const file = c.kind === "mod" ? c.mod.file : gameFile(c.variant, kind);
      const size = c.kind === "mod" ? c.mod.size : partsOf(c.variant, kind).reduce((n, f) => n + (f.size || 0), 0);
      const status = c.kind === "mod" ? (inUse ? ["status.installed", "#1f9a52"] : ["status.notInstalled", "#d9822b"]) : ["status.gameFile", ""];
      const crcState = inUse ? crcOf(v, kind) : null;
      const crc = crcState === "fixed" ? ["crc.fixed", "#1f9a52"] : crcState === "needs_fix" ? ["crc.needed", "#d9822b"] : crcState === "ok" ? ["crc.original", ""] : null;
      return {
        title: T(kind === "lobby" ? "info.title.lobby" : "info.title.portrait"),
        fields: [[T("field.file"), baseName(file)], [T("field.size"), sizeText(size)], [T("field.status"), T(status[0]), status[1] && `${status[1]}/1.00`],
          [T("field.crc"), crc ? T(crc[0]) : "—", crc?.[1] && `${crc[1]}/1.00`]],
        actions: [[T(platform === "mac" ? "open.mac" : "open.win"), () => reveal(file)],
          c.kind === "mod"
            ? [T("btn.remove"), async () => {
              try { await rpc("mods.remove", { id: c.id }); } catch (err) { toast(errorText(err), { kind: "error" }); return; }
              await reload();
              ctx.invalidateRoster();
              if (pending === c.key) pending = appliedKey(variant(), kind);
              renderPopup();
            }]
            : [T("btn.extract"), () => { closePopup(false); job("actions.extract", { target: `variant:${c.variant.key}` }, { onDone: (r) => reveal(r?.folder) }); }]],
      };
    },
  });
}
function openPopup(kind = "spr") { popupKind = kind; pending = appliedKey(variant(), kind); popupSeg = 0; renderPopup(); }
function closePopup(apply) {
  $("popup").hidden = true;
  $("popup").innerHTML = "";
  if (apply && pending && pending !== appliedKey(variant(), popupKind)) applyCandidate(pending, popupKind);
}

// variant picker: every variant of the family in the same list layout
let pickerSeg = 0;
async function openPicker(scroll = 0) {
  pickerSel = pickerSel || variantKey;
  const items = fam.variants.filter((o) => o.spr).sort(byRank).map((o) => ({
    key: o.key, kind: o.recruitable ? "playable" : "other", recruit: o.recruitable, label: shortName(o), full: fullName(o),
    thumb: thumb(spineBase("spr", o.spr), "card"), big: () => thumb(spineBase("spr", o.spr), "bust"),
    inUse: o.key === variantKey, fav: isFav(o), isNew: hasFresh(o), src: o,
  })).filter((it) => pickerSeg === 0 || (pickerSeg === 1) === it.recruit);
  await listPopup({
    hostId: "picker", title: T("picker.title"), okText: T("picker.ok"), items, selected: pickerSel, keepScroll: scroll,
    segs: ["seg.all", "seg.recruit", "seg.noRecruit"], seg: pickerSeg, onSeg: (i) => { pickerSeg = i; openPicker(); }, sortKey: "sort.release",
    onSelect: (key, s) => { pickerSel = key; openPicker(s); },
    onOk: () => { $("picker").hidden = true; const k = pickerSel; pickerSel = null; ctx.go(fam.key, k); },
    onClose: () => { $("picker").hidden = true; pickerSel = null; },
    details: (it) => {
      const o = it.src, file = gameFile(o);
      return {
        title: T("info.title.portrait"),
        fields: [[T("field.file"), o.spr], [T("info.gameFile"), o.date || "—"], [T("info.status"), T(appliedKey(o) === "self" ? "status.original" : "status.replaced")],
          [T("tab.lobby"), T(o.lobby ? "model.has" : "model.none")]],
        actions: [[T(platform === "mac" ? "open.mac" : "open.win"), () => reveal(file)],
          [T("btn.extract"), () => { $("picker").hidden = true; job("actions.extract", { target: `variant:${o.key}` }, { onDone: (r) => reveal(r?.folder) }); }]],
      };
    },
  });
}

// the game's popup frame (UIPopup_Sort) at a size: backdrop, title, close button and, when given, its Cancel and OK
// buttons with these labels near the bottom edge. The frame's centre sits 12 units under the stage's (Base -20, BG +8).
const FRAME_Y = -12;
function popupFrame(title, w, h, { ok = null, cancel = null } = {}) {
  const t = clone(find(layouts.sortPopup, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: w, h_: h });
  find(bg, "Texture_Top").pos = [-w / 2 + 248, h / 2 - 66];
  const titleNode = find(bg, "Label_Title_Locale");
  const tf = fitText(title, 72, 52, 1300);
  Object.assign(titleNode.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1400 });
  titleNode.pos = [0, h / 2 - 64];
  find(titleNode, "Line").widgets[0].w_ = glyphsOf(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").pos = [w / 2 - 90, h / 2 - 60];
  const btn = find(popup, "Btn");
  btn.active = !!(ok || cancel);
  btn.pos = [0, FRAME_Y - h / 2 + 122];
  for (const [name, caption] of [["Btn_Ok", ok], ["Btn_Cancel", cancel]]) {
    const b = find(btn, name);
    b.active = !!caption;
    if (!caption) continue;
    const f = fitText(caption, 64, 40, 420);
    Object.assign(find(b, "Label_Locale").widgets[0], { text: f.text, fontSize: f.fs });
  }
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
  return t;
}

// compare: what the mod changes against the game's official file, on the popup frame
async function showCompare(result) {
  const host = $("popup");
  const t = popupFrame(T("act.compare"), 1900, 1180);
  const popup = find(t, "Popup");
  const rows = (result.assets || []).filter((d) => d.status !== "same").slice(0, 12);
  const color = { changed: "#d9822b", added: "#1f9a52", removed: "#c0392b" };
  if (!rows.length) popup.children.push(node("None", [0, 120], [label(T("compare.none"), 44, "#2d4664/1.00", 1600, 60, { depth: 8 })]));
  rows.forEach((d, i) => {
    const y = 400 - i * 64;
    popup.children.push(node(`R_${i}`, [-820, y], [label(`${d.type} - ${d.name}`, 38, "#2d4664/1.00", 1300, 50, { pivot: 3, depth: 8, ellipsis: true })]),
      node(`S_${i}`, [820, y], [label(T(`compare.${d.status}`), 38, `${color[d.status] || "#2d4664"}/1.00`, 300, 50, { pivot: 5, depth: 8 })]));
  });
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 10 });
  const close = view.nodes.get("Center/Popup/Base/BG/Btn_Close")?.els[0];
  const done = () => { host.hidden = true; host.innerHTML = ""; };
  if (close) hitButton(next, rect(close), done, "", 80);
  closable(view, done);
  host.replaceChildren(...next.childNodes);
}

// --- the alias editor (the nameplate's pencil): the user's own aliases of the student on the popup frame, one input
// row each, drawn like the game's input row (UIPopup_Input's Input_NickName: a grey box with a line round it, a dark
// icon at its end), the cross removing it, then an empty row with the pencil to add one while there is room. OK keeps
// them (aliases.set); Cancel, the close button, the backdrop or Escape drop the changes. Enter in the empty row adds
// what it holds, in another row goes to the next one, in an empty one at the end keeps them; never while an input
// method is composing (isComposing, or keyCode 229, which WebKit sends for the key that ends a conversion). ---
const AL = { w: 1500, rowW: 1180, rowH: 100, pitch: 124, top: 236, bottom: 334 };
let aliasToken = 0;
// draft: the rows; focusAt: the row to focus (the empty one when null); carry: the empty row of the editor drawn before,
// which keeps the focus while this one is drawn: what is typed there meanwhile goes into the new empty row
async function openAliases(draft = customAliases(), focusAt = null, family = fam.key, carry = null) {
  const my = ++aliasToken;
  const host = $("popup");
  const names = draft.slice(0, ALIAS_MAX);
  const adding = names.length < ALIAS_MAX;
  const n = names.length + (adding ? 1 : 0);
  const h = AL.top + (n - 1) * AL.pitch + AL.bottom;
  const ys = Array.from({ length: n }, (_, i) => FRAME_Y + h / 2 - AL.top - i * AL.pitch);
  const t = popupFrame(T("alias.title"), AL.w, h, { ok: T("picker.ok"), cancel: T("popup.cancel") });
  const popup = find(t, "Popup");
  ys.forEach((y, i) => {
    const add = adding && i === n - 1;
    const icon = add ? sprite("Cafe_Icon_NameEdit", 50, 50, { type: 0, depth: 9, color: "#2d4664/1.00" })
      : sprite("Common_Icon_Close", 42, 42, { type: 0, depth: 9, color: "#2d4664/1.00" });
    popup.children.push(node(`Row_${i}`, [0, y], [sprite("Common_Bg_Raius10px", AL.rowW, AL.rowH, { depth: 6, color: "#e6eaec/1.00" })], [
      node("BG_Line", [0, 0], [sprite("Common_line_10px", AL.rowW + 2, AL.rowH, { depth: 7, color: "#cfd4da/1.00" })]),
      node("Icon", [AL.rowW / 2 - 58, 0], [icon]),
    ]));
  });
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 10 });
  if (my !== aliasToken) return;
  const close = () => { aliasToken += 1; host.hidden = true; host.innerHTML = ""; };
  // the screen was left or shows another student meanwhile
  if (!open || fam.key !== family) { close(); return; }
  const inputs = [];
  // the rows' aliases as edited, and what the empty row holds
  const rows = () => inputs.slice(0, names.length).map((el) => el.value);
  const typed = () => (adding ? inputs[n - 1].value : "");
  const keep = async () => {
    const saved = await call(() => rpc("aliases.set", { family, aliases: [...rows(), typed()] }));
    if (!saved || my !== aliasToken) return; // an error is shown and the editor stays
    close();
    ctx.invalidateRoster();
    if (fam.key !== family) return;
    fam.custom = saved;
    renderScreen();
  };
  ys.forEach((y, i) => {
    const add = adding && i === n - 1;
    const el = document.createElement("input");
    el.className = "alias-input";
    el.type = "text";
    el.maxLength = ALIAS_LENGTH;
    el.spellcheck = false;
    el.autocomplete = "off";
    el.enterKeyHint = add ? "done" : "next";
    el.value = add ? carry?.value || "" : names[i];
    el.placeholder = add ? T("alias.add") : "";
    el.setAttribute("aria-label", add ? T("alias.add") : T("alias.title"));
    Object.assign(el.style, {
      left: `${960 + (-AL.rowW / 2 + 36) * S}px`, top: `${540 - (y + AL.rowH / 2) * S}px`,
      width: `${(AL.rowW - 150) * S}px`, height: `${AL.rowH * S}px`, fontSize: `${50 * S}px`,
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.isComposing || ev.keyCode === 229 || ev.key !== "Enter") return;
      ev.preventDefault();
      if (add && el.value.trim()) {
        const text = el.value;
        el.value = "";
        openAliases([...rows(), text], names.length + 1, family, el);
      }
      else if (i < n - 1) inputs[i + 1].focus();
      else keep();
    });
    next.appendChild(el);
    inputs.push(el);
    const [ix, iy] = [960 + (AL.rowW / 2 - 58) * S, 540 - y * S], size = 84 * S;
    const b = hitButton(next, [ix - size / 2, iy - size / 2, size, size],
      add ? () => el.focus() : () => openAliases(rows().filter((_, j) => j !== i), i, family, adding ? inputs[n - 1] : null),
      add ? T("alias.add") : T("alias.remove"), 86);
    if (add) b.tabIndex = -1;
  });
  const hit = (path, fn) => { const el = view.nodes.get(path)?.els[0]; if (el) hitButton(next, rect(el), fn, "", 80); };
  hit("Center/Popup/Btn/Btn_Ok/BG (1)", keep);
  hit("Center/Popup/Btn/Btn_Cancel/BG (1)", close);
  hit("Center/Popup/Base/BG/Btn_Close", close);
  closable(view, close);
  host.replaceChildren(...next.childNodes);
  const target = inputs[focusAt ?? inputs.length - 1] || inputs[inputs.length - 1];
  target?.focus();
}

// --- details (the info bar's Details button): the shown tab's game files on the popup frame. A summary (the folder,
// what the files carry and, for a mod, its file and the variant it was made for), then one row per bundle: name,
// size, date, CRC and what it carries ---
const DT = { w: 2200, h: 1400, l: -1040, r: 1040 };
const DT_COLS = [["field.file", 1040], ["field.size", 220], ["field.date", 270], ["field.crc", 290], ["field.status", 260]];
const crcLabel = (state) => (state === "fixed" ? [T("crc.fixed"), "#1f9a52"] : state === "needs_fix" ? [T("crc.needed"), "#d9822b"] : [T("crc.original"), "#000000"]);
// what a game file carries, as a label: the original, a mod's name, another variant's name, or "replaced"
function carriedLabel(applied) {
  if (!applied || applied === "official") return T("status.original");
  if (applied.startsWith("mod:")) { const m = familyMods().find((x) => x.id === applied.slice(4)); if (m) return modLabel(m); }
  if (applied.startsWith("variant:")) { const o = fam.variants.find((x) => x.key === applied.slice(8)); if (o) return shortName(o); }
  return T("status.replaced");
}
function detailsInfo() {
  const v = variant(), kind = tabKind(), parts = partsOf(v, kind);
  const first = parts[0]?.file || null;
  const folder = first ? first.replace(/[\\/][^\\/]*$/, "") : "—";
  const applied = kind === "model" ? "official" : appliedOf(v, kind);
  const fields = [[T("field.folder"), folder], [T("info.current"), tab === "portrait" ? current().label : tab === "lobby" ? lobbyLabel(v) : T("model.original")]];
  const mod = applied.startsWith("mod:") ? familyMods().find((m) => m.id === applied.slice(4)) : null;
  const from = mod ? fam.variants.find((o) => o.key === mod.target) : applied.startsWith("variant:") ? fam.variants.find((o) => o.key === applied.slice(8)) : null;
  if (mod) fields.push([T("field.modFile"), mod.file || "—"]);
  if (from) fields.push([T("field.source"), fullName(from)]);
  const rows = parts.map((p) => {
    const crc = crcLabel(p.crc);
    return [baseName(p.file), sizeText(p.size), p.date || "—", [crc[0], crc[1]], kind === "model" ? null : carriedLabel(p.applied)];
  });
  return { title: T(`info.title.${tab}`), fields, rows, reveal: first };
}
// the summary box and the file table, laid out from the top left of the scrolling area (units); returns the tree
// and its height
function detailsBody({ fields, rows }) {
  const W = DT.r - DT.l, kids = [];
  // summary: captions, then values that wrap (paths), never cut; on the game's light stats box
  const capW = Math.max(...fields.map(([k]) => advanceOf(k, 38))) + 40, room = W - 80 - capW;
  const values = fields.map(([, v]) => wrapPath(String(v), 38, 28, room, 3));
  const rowHs = values.map((f) => Math.max(72, f.lines * f.fs * 1.25 + 22));
  const boxH = rowHs.reduce((a, h) => a + h, 0) + 20;
  const TOP = 12; // air under the scrolling area's top edge
  kids.push(node("Summary", [W / 2, -TOP - boxH / 2], [sprite("Common_Bg_Raius10px", W - 6, boxH, { depth: 5, color: "#ecf5f9/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", W, boxH + 6, { depth: 4, color: "#c0c9d4/1.00" })]),
  ]));
  let y = -TOP - 10;
  fields.forEach(([k], i) => {
    const h = rowHs[i], cy = y - h / 2, f = values[i];
    kids.push(node(`F_${i}`, [40, cy], [label(k, 38, "#2d4664/1.00", capW, 50, { pivot: 3, depth: 8 })]));
    kids.push(node(`V_${i}`, [40 + capW, cy], [label(f.text, f.fs, "#000000/1.00", room + 20, f.lines * f.fs * 1.25 + 8, { pivot: 3, depth: 8 })]));
    if (i < fields.length - 1) kids.push(node(`L_${i}`, [W / 2, y - h], [sprite("Common_Line_Dot", W - 60, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]));
    y -= h;
  });
  // the file table: the list header's light blue bar with the captions, then the bundles
  const cols = DT_COLS.filter((_, i) => i < 4 || rows.some((r) => r[4] !== null));
  const extra = DT_COLS.reduce((a, [, w]) => a + w, 0) - cols.reduce((a, [, w]) => a + w, 0);
  const widths = cols.map(([, w], i) => w + (i === 0 ? extra : 0));
  const xs = widths.map((_, i) => 30 + widths.slice(0, i).reduce((a, w) => a + w, 0));
  y = -TOP - boxH - 36;
  kids.push(node("Head", [W / 2, y - 40], [sprite("Common_Bg_Raius10px", W, 80, { depth: 5, color: "#d1edff/1.00" })]));
  cols.forEach(([key], i) => kids.push(node(`H_${i}`, [xs[i], y - 40], [label(T(key), fitText(T(key), 36, 28, widths[i] - 30).fs, "#294263/1.00", widths[i] - 20, 50, { pivot: 3, depth: 8 })])));
  y -= 80;
  rows.forEach((r, ri) => {
    const name = wrapPath(r[0], 34, 26, widths[0] - 40, 2);
    const h = Math.max(84, name.lines * name.fs * 1.25 + 28), cy = y - h / 2;
    cols.forEach((_, i) => {
      const [text, color] = i === 0 ? [name.text, "#000000"] : i === 3 ? r[3] : [r[i], "#000000"];
      const fs = i === 0 ? name.fs : fitText(String(text), 34, 26, widths[i] - 30).fs;
      kids.push(node(`R_${ri}_${i}`, [xs[i], cy], [label(String(text), fs, `${color}/1.00`, widths[i] - 20, (i === 0 ? name.lines : 1) * fs * 1.25 + 8, { pivot: 3, depth: 8 })]));
    });
    kids.push(node(`RL_${ri}`, [W / 2, y - h], [sprite("Common_Line_Dot", W - 40, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]));
    y -= h;
  });
  return { tree: node("Details", [0, 0], [], kids), height: -y + 20 };
}
async function showDetails() {
  const host = $("popup");
  const info = detailsInfo();
  const body = detailsBody(info);
  // the frame fits its content, up to almost the whole stage (then the content scrolls): the title takes 140 units
  // above the content, the buttons 228 under it
  const h = Math.min(DT.h, Math.max(900, body.height + 140 + 228)), top = FRAME_Y + h / 2 - 140, bottom = FRAME_Y - h / 2 + 228;
  const t = popupFrame(info.title, DT.w, h, { ok: T("picker.ok"), cancel: info.reveal ? T(platform === "mac" ? "open.mac" : "open.win") : null });
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 10 });
  const done = () => { host.hidden = true; host.innerHTML = ""; };
  const hit = (path, fn, title = "") => { const el = view.nodes.get(path)?.els[0]; if (el) hitButton(next, rect(el), fn, title, 80); };
  hit("Center/Popup/Base/BG/Btn_Close", done);
  hit("Center/Popup/Btn/Btn_Ok/BG (1)", done);
  hit("Center/Popup/Btn/Btn_Cancel/BG (1)", () => reveal(info.reveal));
  closable(view, done);
  const inner = scrollArea(next, [960 + DT.l * S, 540 - top * S, (DT.r - DT.l) * S, (top - bottom) * S], body.height * S);
  await NGUI.render(body.tree, inner, { scale: S, origin: [0, 0], z: 20 });
  if (host.hidden) return;
  host.replaceChildren(...next.childNodes);
}

async function renderAll() {
  await Promise.all([renderScreen(), renderChips(), renderExpressions()]);
}

// an in-place change (a tab, an applied portrait): the shown screen stays until every part is ready, with the
// loading indicator after a moment
function changeInPlace(work) {
  const g = begin();
  return Loading.wait(prepare(g, true, async () => {
    await work();
    await settleThumbs();
  })).then((ready) => {
    // it may have taken over a show (a tab clicked while a step loads): the screen is on that student now
    if (ready && fam) arrived(fam.key, askedKey);
    return ready;
  });
}

// tabs: the left side shows the portrait, the memorial lobby or the 3D model
function showTab(id) {
  tab = id;
  expanded = false;
  exprScroll = 0;
  lobbySeq = null;
  lobbyAll = false;
  return changeInPlace(() => Promise.all([renderAll(), renderLeft()]));
}

// renderLeft() -> Promise, resolved once the tab's part has drawn its first frame (the lobby also its still and
// lines, the model its still). The part loads laid out but transparent (.pending: a hidden canvas has no size) and is
// committed with the rest of the screen; the part it replaces fades out and is freed. The lobby and the model are
// single players: when the shown one is replaced by another variant's, a still of it holds the place meanwhile.
const LEFT = ["portrait", "lobby", "model"];
let shownLeft = null, shownKey = null;
// what the lobby or the model shows: the same variant of another install (game folder, file source) is another one
const leftKey = (part, v) => (part === "lobby" ? `${v.lobby}@${fam.version}` : part === "model" ? `${v.key}@${fam.version}` : null);
let lobbyFrom = null; // the install of the lobby in lobby.js, which keeps a lobby shown again by its core
let lobbyStale = false; // its game files were switched: lobby.js reads them again
function renderLeft() {
  if (!open) return Promise.resolve();
  const v = variant(), my = ++leftToken, want = tab, el = $(want), key = leftKey(want, v);
  const same = want === shownLeft;
  if (!same) {
    el.hidden = false;
    el.classList.remove("leaving");
    el.classList.add("pending");
  }
  const swap = same && key !== shownKey ? freezeLeft(want) : null;
  // a newer left side or hide() came first: nothing is started
  const ready = Promise.resolve(swap).then(() => (my !== leftToken ? null
    : want === "portrait" ? (mainPlayer ? null : loadSpine(baseOf(current())))
      : want === "lobby" ? showLobby(v, my) : showModel(v, my)));
  return ready.then(() => commit(() => {
    if (my !== leftToken) return;
    el.hidden = false;
    el.classList.remove("pending", "leaving");
    shownLeft = want;
    shownKey = key;
    unfreezeLeft();
    for (const part of LEFT) if (part !== want) retireLeft(part, my);
  }));
}
// a part no longer shown: faded out, then freed (unless a newer change wants it again)
function retireLeft(part, my) {
  const el = $(part);
  const free = () => {
    el.hidden = true;
    el.classList.remove("pending", "leaving");
    if (part === "portrait") disposePortrait();
    else if (part === "lobby") Lobby.hide(el);
    else hideModel();
  };
  if (el.hidden || el.classList.contains("pending")) { free(); return; }
  el.classList.add("leaving");
  setTimeout(() => { if (my === leftToken && el.classList.contains("leaving")) free(); }, 360);
}
// a still of the shown lobby or model over the left side, until its replacement is committed. The model's canvas
// keeps no drawing buffer: it is copied in an animation frame, after the model's own loop has drawn into it.
async function freezeLeft(part) {
  const host = $(part);
  const sources = [...host.querySelectorAll(part === "lobby" ? ".lobby-view canvas" : "canvas.model-view")];
  if (!sources.length) return;
  if (part === "model") await new Promise(requestAnimationFrame);
  const box = document.createElement("div");
  box.className = `left-freeze ${part}`;
  Object.assign(box.style, { left: `${host.offsetLeft}px`, top: `${host.offsetTop}px`, width: `${host.offsetWidth}px`, height: `${host.offsetHeight}px` });
  const c = document.createElement("canvas");
  c.width = sources[0].width;
  c.height = sources[0].height;
  const g = c.getContext("2d");
  for (const src of sources) if (src.width && src.height) g.drawImage(src, 0, 0, c.width, c.height);
  box.appendChild(c);
  if (part === "lobby") { const frost = document.createElement("div"); frost.className = "lobby-frost"; box.appendChild(frost); }
  unfreezeLeft(true);
  $("lobby").after(box);
}
function unfreezeLeft(now = false) {
  for (const box of document.querySelectorAll(".left-freeze:not(.leaving)")) {
    if (now) { box.remove(); continue; }
    box.classList.add("leaving");
    setTimeout(() => box.remove(), 360);
  }
}

// the UI language -> its key in the lobby lines
const LINE_LANG = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko", "th-TH": "th" };
// the memorial lobby: every layer in and drawn, the still for the switch card, the dialogue strip; the lines when
// they come in time (later ones re-render the strip)
async function showLobby(v, my) {
  const still = () => open && my === leftToken && tab === "lobby" && variantKey === v.key;
  if (lobbyFrom !== fam.version || lobbyStale) Lobby.hide($("lobby"));
  lobbyFrom = fam.version;
  lobbyStale = false;
  const m = await Lobby.show(v.lobby, $("lobby"), v.key);
  if (!m || !still()) return;
  if (fullscreen) { Lobby.frame("full"); Lobby.interactive(true); }
  // the lines in the UI language only (Kivo's Chinese and Japanese, the Global server's English and the others), on
  // the voice clips of each talk animation, and Kivo's voices; nothing in another language stands in for a missing one
  const key = LINE_LANG[language()] || "en";
  const talks = Object.fromEntries(m.sequences.map((sq) => [sq.anim, sq.cues.map((c) => c.clip)]));
  const lines = rpc("lobby.lines", { variant: v.key, talks, lang: key }).then((table) => {
    if (!still()) return null;
    Lobby.setLines(table, (l) => l?.[key] || "");
    return renderExpressions();
  }).catch(() => { if (still()) Lobby.setLines({}, null); });
  // the still is taken in the left framing, once the players have drawn a few frames of it
  await frames(4);
  if (!still()) return;
  if (!lobbyShot && !fullscreen) lobbyShot = snapshotLobby();
  await Promise.all([renderScreen(), renderExpressions(), Promise.race([lines, sleep(LINES_CAP)])]);
}
// the 3D chibi: loaded, its shaders compiled and its first frame drawn; the actions fill row 4 and a still of it goes
// on the switch card
async function showModel(v, my) {
  const still = () => open && my === leftToken && tab === "model" && variantKey === v.key;
  try {
    const M = await ModelLib();
    if (!still()) return;
    const list = await M.show(v.key, $("model"), {
      frame: fullscreen ? "full" : "left", version: fam.version,
      onAction: (a) => { if (tab === "model" && variantKey === v.key) { modelAction = a; renderExpressions(); } },
    });
    if (!list || !still()) return;
    modelActions = list;
    modelAction = M.current();
    if (!modelShot && !fullscreen) modelShot = M.snapshot();
    await Promise.all([renderScreen(), renderExpressions()]);
  } catch (err) {
    // a model that cannot be read (a broken or unreadable GLB): the tab stays, empty, and the rest of the screen works
    console.error(err);
    if (still()) toast(T("model.failed"), { kind: "error" });
  }
}
function hideModel() {
  modelActions = [];
  modelAction = null;
  modelLib?.then((M) => M.hide($("model")));
}

// a still of the lobby for the switch card, framed on the face: lobby.js picks the crop inside the left view, which
// lies inside the lobby's painted area, so the still is opaque everywhere and the card's mask fades it out softly
function snapshotLobby() {
  const canvases = [...$("lobby").querySelectorAll(".lobby-view canvas")];
  if (!canvases.length) return null;
  const W = canvases[0].width, H = canvases[0].height;
  const r = Lobby.stillRect(W, H) || { x: W * 0.1, y: H * 0.16, w: W * 0.5, h: W * 0.5 * (253 / 450) };
  const c = document.createElement("canvas");
  c.width = 900; c.height = Math.round(900 * (253 / 450));
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  for (const src of canvases) g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null)));
}

// fullscreen memorial lobby: every UI part slides out its own way; the exit button hides when the pointer rests
let idleTimer = null;
const wake = () => {
  const exit = $("fs-exit");
  exit.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => exit.classList.add("idle"), 2500);
};
// in fullscreen the character can be touched and the view zoomed like in the game; leaving resets the zoom. The
// portrait's fullscreen is the game's visual mode (visual-mode.js), with the game's own buttons instead of fs-exit.
// Leaving puts every part back whatever the tab is by now (an in-place show may have changed it); setStage(false)
// closes the visual mode.
function setFullscreen(on) {
  if (on && tab === "portrait") { enterVisual(); return; }
  setStage(on);
  if (!on || tab === "lobby") { Lobby.frame(on ? "full" : "left"); Lobby.interactive(on); }
  if (!on || tab === "model") modelLib?.then((M) => M.frame(on ? "full" : "left"));
  showExit(on);
  if (!on) stillAfterFullscreen();
}
// the UI slides out (app.css .stage.fullscreen) and out of the keyboard's reach; back, the visual mode closes and the
// focus returns (visual-mode.js uiOut, uiBack)
const slidOut = () => [$("ngui"), $("ngui-chips"), $("ngui-expr"), stage().querySelector(".topbar"), stage().querySelector(".nav")];
function setStage(on) {
  fullscreen = on;
  stage().classList.toggle("fullscreen", on);
  if (on) Visual.uiOut(slidOut());
  else Visual.uiBack(slidOut(), { refocus: open });
}
function showExit(on) {
  $("fs-exit").hidden = !on;
  if (on) { wake(); stage().addEventListener("pointermove", wake); } else { stage().removeEventListener("pointermove", wake); clearTimeout(idleTimer); }
}
// the visual mode: its background and buttons are made off screen first, then the UI slides out as the portrait
// glides into the whole art and they come in. Without the prefab (another game version) the portrait still goes
// fullscreen, with the tool's exit button.
let visualToken = 0;
async function enterVisual() {
  if (fullscreen || !mainPlayer?.skeleton) return; // the portrait is not in yet
  const my = ++visualToken, key = variantKey;
  const layout = await layouts.visual;
  const strings = { reset: T("visual.reset"), back: T("lobby.exit"), hide: T("visual.hide"), show: T("visual.show") };
  const parts = await Visual.prepare({ layout, bg: variant().bg, strings }).catch((err) => { console.error(err); return null; });
  if (my !== visualToken || !open || fullscreen || tab !== "portrait" || variantKey !== key || !mainPlayer?.skeleton) return;
  setStage(true);
  Visual.open({
    parts, skeleton: mainPlayer.skeleton, detail: detailViewport(), host: stage(), bgHost: $("visual-bg"), uiHost: $("visual-ui"),
    players: () => [...$("portrait").querySelectorAll(".layer")].map((l) => l.player).filter(Boolean),
    onBack: () => setFullscreen(false),
  });
  if (!parts) showExit(true);
}
// the switch card's still is taken in the left framing: when fullscreen was entered before the lobby or the model was
// in, the still is taken once the left framing is back
async function stillAfterFullscreen() {
  const part = tab, key = variantKey;
  const wanted = () => open && !fullscreen && tab === part && variantKey === key && (part === "lobby"
    ? !lobbyShot && !!Lobby.meta() : part === "model" && !modelShot && !!$("model").querySelector(".model-view.ready"));
  if (!wanted()) return;
  // the lobby draws the left view within a few frames; the model glides there
  const M = part === "model" ? await ModelLib() : null;
  await (M ? M.settled() : frames(4));
  if (!wanted()) return;
  if (M) modelShot = M.snapshot();
  else lobbyShot = snapshotLobby();
  if (M ? modelShot : lobbyShot) renderScreen();
}

async function reload() {
  const data = await call(() => rpc("family.get", { key: fam.key }));
  if (data) fam = data;
  await renderAll();
}

async function ensureLayouts() {
  if (layouts) return;
  const [detail, collection, sortPopup, textures] = await Promise.all([
    NGUI.layout("UICharacterDetail"), NGUI.layout("UICharacterCollection"), NGUI.layout("UIPopup_Sort"),
    fetch("/asset/ui/textures.json").then((r) => (r.ok ? r.json() : {})),
  ]);
  // the portrait's visual mode: fetched now, waited for once its button is pressed
  const visual = NGUI.layout("UICharacterVisualMode").catch(() => null);
  layouts = { list: find(detail, "Inventory_ListControl"), collection, sortPopup, textures, visual };
}

// the voice volume and mute (development runs started with --mute stay silent), the zoom-out limit and the
// post-processing from the settings
export function applyPrefs(prefs) {
  Lobby.setVolume((prefs?.voiceVolume ?? 80) / 100, ctx?.info?.mute || prefs?.voiceMuted);
  Lobby.setZoomLimit(prefs?.lobbyZoom);
  Lobby.setPostProcessing(prefs?.lobbyPost !== false);
  // started with --debug: the fullscreen lobby's pointer, wheel and gesture events go to the app's log
  Lobby.setTrace(ctx?.info?.debug ? (events) => rpc("debug.trace", { events }).catch(() => {}) : null);
}

// --- the previous and next student from the keyboard: the PC client's keys for the arrows (step-keys.js) ---
// A key steps exactly like its arrow (ctx.step: the roster's cards in its order), one step at a time: the next one
// waits until the screen shows the student the last one went to (arrived), so a held key goes at the pace the screen
// follows and starts no load it would drop. The keys are the screen's own: not while a text field or an input method
// has them, under a popup (the screen's, the settings, the consent or update dialog), in a fullscreen view (the lobby,
// the 3D model, the portrait's visual mode), during a job or another change of the screen, or behind the loading screen.
const blocked = () => !open || !fam || fullscreen || Visual.isOpen() || busy || Loading.covering() || $("screen-detail").hidden
  || !!document.querySelector(".popup-host:not([hidden]), .consent-host:not([hidden])");
const changing = () => !!batch; // an in-place change is being prepared (a step, a chip, a tab, an applied portrait)
// the address, as main.js routes it: what the arrows asked for
function address() {
  try { return location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent); } catch { return []; }
}
let arrivals = [], askedKey = null; // askedKey: the variant the last show() was asked for, as in the address
// the screen is ready on a student (or was left: no arguments): a step waiting for the address to be shown goes on
function arrived(family, key) {
  if (!arrivals.length) return;
  const [screen, f, k] = address();
  if (family !== undefined && (screen !== "student" || f !== family || k !== key)) return; // a newer address comes
  for (const resolve of arrivals.splice(0)) resolve();
}
const keySteps = pacer(async (delta) => {
  if (blocked() || changing()) return;
  const from = location.hash;
  let resolve;
  const shown = new Promise((r) => { resolve = r; arrivals.push(r); });
  try {
    await ctx.step(delta, fam.key, variantKey);
  } finally {
    // nowhere else to go (or the step failed): nothing to wait for
    if (location.hash === from) resolve();
  }
  let timer;
  await Promise.race([shown, new Promise((r) => { timer = setTimeout(r, HARD_CAP); })]); // a screen that never comes
  clearTimeout(timer);
  arrivals = arrivals.filter((r) => r !== resolve);
});
addEventListener("keydown", (ev) => {
  const delta = deltaOf(ev);
  if (!delta || typing(ev.target) || blocked() || (changing() && !keySteps.busy)) return;
  ev.preventDefault(); // the page's own use of the arrows (scrolling the unfolded strip) gives way to the step
  keySteps.press(delta, ev.repeat);
});
addEventListener("keyup", (ev) => { if (KEYS[ev.key]) keySteps.release(KEYS[ev.key]); });
addEventListener("blur", () => keySteps.release());

// show(context, familyData, variantKey, {inPlace}): open the detail screen on a variant; resolves once the screen is
// ready (the panels, the left side's first frame, the visible thumbnails within THUMBS_CAP). In place (another
// variant or family while the screen is shown), the shown screen stays until then and every part swaps in one frame.
export async function show(context, familyData, key, { inPlace = false } = {}) {
  ctx = context;
  applyPrefs(ctx.prefs);
  open = true;
  askedKey = key;
  const g = begin();
  await ensureLayouts();
  if (g.gen !== showGen) return; // a newer show, or hide()
  const sameFamily = fam?.key === familyData.key;
  // the alias editor of another student goes (a history step while it was open)
  if (!sameFamily && $("popup").querySelector(".alias-input")) { aliasToken += 1; $("popup").hidden = true; $("popup").innerHTML = ""; }
  // the same variant of another install (another game folder or file source) is read again like another variant
  const sameVariant = sameFamily && variantKey === key && fam.version === familyData.version;
  fam = familyData;
  variantKey = fam.variants.some((v) => v.key === key && v.spr) ? key : (fam.variants.find((v) => v.spr) || fam.variants[0]).key;
  setTitle(T("top.students"), () => { location.hash = "#/roster"; });
  if (!sameVariant) {
    expression = "00";
    expanded = false;
    lobbyShot = null;
    lobbySeq = null;
    lobbyAll = false;
    modelShot = null;
    modelActions = [];
    modelAction = null;
    // a new portrait is loaded; the shown one stays until it is committed
    clearTimeout(blinkTimer);
    mainPlayer = null;
  }
  // the tabs the variant has, on every show: another install may lack a part under the same variant
  if (tab === "lobby" && !hasLobby(variant())) tab = "portrait";
  if (tab === "model" && !hasModel(variant())) tab = "portrait";
  rpc("ui.visit", { variant: variantKey }).catch(() => {});
  // the left side starts at once, beside the panels
  const ready = await prepare(g, inPlace, async () => {
    await Promise.all([renderAll(), renderLeft()]);
    await settleThumbs();
  });
  if (ready) arrived(familyData.key, key);
  // the server's index of the lobbies' prefabs takes seconds to build the first time: built in the background once
  // the screen is in, so the lobby tab does not wait for it
  if (open && hasLobby(variant())) rpc("lobby.warm").catch(() => {});
}

// a route to a student failed (main.js): a key step waiting for that screen goes on at once
export function stepFailed() { arrived(); }

// leaving the screen: stop the players, drop any change being prepared
export function hide() {
  open = false;
  begin();
  batch = null;
  leftToken += 1;
  Visual.close({ instant: true });
  if (fullscreen) setFullscreen(false);
  disposePortrait();
  Lobby.hide($("lobby"));
  lobbySeq = null;
  lobbyAll = false;
  hideModel();
  unfreezeLeft(true);
  shownLeft = shownKey = null;
  for (const part of LEFT) { $(part).hidden = true; $(part).classList.remove("pending", "leaving"); }
  for (const id of ["popup", "picker"]) { $(id).hidden = true; $(id).innerHTML = ""; }
  keySteps.clear();
  arrived();
}

$("fs-exit")?.addEventListener("click", () => setFullscreen(false));
