// Detail screen, built from the game's own prefab (UICharacterDetail) by ngui.js. The prefab supplies every frame,
// sprite, tint, incline and position; this file swaps labels and textures, hides what the tool has no use for, and adds
// what the game has no screen for: variant chips, the expression strip and the portrait switcher. A family is one base
// character with all of its variant portraits; each variant's game file carries one portrait (its own skeleton,
// another variant's skeleton or an added portrait). Added portraits belong to the variant whose game file they replace
// (mod.target) and can be worn by the other variants of the family.
// The screen is shown only when it is ready: the panels, the left side's first frame (portrait, lobby or model) and,
// within a short soft cap, the visible thumbnails. A change inside the screen (another variant, a tab, an applied
// portrait) prepares every part off screen and swaps all of them in one frame (the commit barrier below).
import * as NGUI from "./ngui.js";
import * as Loading from "./loading.js";
import * as Lobby from "./lobby.js";
import { rpc, spineBase, waitJob } from "./api.js";
import { L, T, language, platform } from "./i18n.js";
import { forget, prioritise, thumb } from "./thumbs.js";
import { setTitle } from "./nav.js";
import {
  $, DOT, RECRUIT, S, TAN10, advanceOf, at, clone, glyphsOf, hitButton, markedLabel, off, text, toast, widget, wrapPath,
} from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);
const ORIGIN = [960, 515]; // prefab centre; 25 px above the stage centre so the panels clear the nav bar
const toStage = (x, y) => [ORIGIN[0] + x * S, ORIGIN[1] - y * S];
const INFO = "RightInfo/Target/Active/1_NormalInfo";
const stage = () => document.getElementById("stage");

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
const showable = (part, my, latest, gen) => my === latest || (!!batch && gen === showGen && my > applied[part]);
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
const variant = () => fam.variants.find((v) => v.key === variantKey) || fam.variants[0];
const familyMods = () => fam.variants.flatMap((v) => v.modList || []);
const isFav = (v) => !!v.favorite;
const hasLobby = (v) => !!v.lobby;
const hasModel = (v) => !!v.model;
const hasFresh = (v) => (v.modList || []).some((m) => m.fresh);
const modLabel = (m) => m.label || m.file?.split(/[\\/]/).pop() || m.id;
const baseOf = (c) => (c.kind === "mod" ? spineBase("mod", c.id) : spineBase("spr", c.spr));

// the variant's own portrait, its added portraits, the other variants' portraits, the other variants' added portraits
function candidates(v = variant()) {
  const others = fam.variants.filter((o) => o.key !== v.key && o.spr);
  const mod = (m) => ({ key: `m:${m.id}`, kind: "mod", id: m.id, label: modLabel(m), mod: m, origin: fam.variants.find((o) => o.key === m.target) });
  return [
    { key: "self", kind: "self", label: shortName(v), spr: v.spr, variant: v, recruit: v.recruitable, fav: isFav(v) },
    ...familyMods().filter((m) => m.kind === "spr" && m.target === v.key).map(mod),
    ...others.map((o) => ({ key: `v:${o.key}`, kind: "variant", label: shortName(o), spr: o.spr, variant: o, recruit: o.recruitable, fav: isFav(o) })),
    ...familyMods().filter((m) => m.kind === "spr" && m.target !== v.key).map(mod),
  ];
}
// the game file parts of one kind ("spr" portrait, "lobby" memorial lobby)
const partsOf = (v, kind = "spr") => (v.state?.files || []).filter((f) => f.kind === kind);
// what the variant's game file carries now: the one non-official source among its parts (a mod often replaces one part)
function appliedOf(v, kind = "spr") {
  const sources = new Set(partsOf(v, kind).map((f) => f.applied).filter((a) => a !== "official"));
  return !sources.size ? "official" : sources.size === 1 ? [...sources][0] : "unknown";
}
function crcOf(v, kind = "spr") {
  const states = partsOf(v, kind).map((f) => f.crc);
  return states.includes("needs_fix") ? "needs_fix" : states.includes("fixed") ? "fixed" : "ok";
}
function appliedKey(v = variant()) {
  const a = appliedOf(v);
  if (a === "official") return "self";
  if (a.startsWith("mod:")) return `m:${a.slice(4)}`;
  if (a.startsWith("variant:")) return `v:${a.slice(8)}`;
  return "unknown";
}
const current = () => candidates().find((c) => c.key === appliedKey()) || candidates()[0];
// what the variant's lobby files carry, as a label: the original, a mod's name, or "replaced"
function lobbyLabel(v) {
  const a = appliedOf(v, "lobby");
  if (a === "official") return T("lobby.original");
  const mod = a.startsWith("mod:") && familyMods().find((m) => m.id === a.slice(4));
  return mod ? modLabel(mod) : T("status.replaced");
}
const sourceOf = (key) => (key === "self" ? "official" : key.startsWith("m:") ? `mod:${key.slice(2)}` : `variant:${key.slice(2)}`);
const gameFile = (v = variant(), kind = "spr") => partsOf(v, kind)[0]?.file || null;
const baseName = (path) => (path ? path.split(/[\\/]/).pop() : "—");
const sizeText = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)} MB` : "—");
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
// a dialogue card: a speech bubble with the dialogue's number (the game's lines are not read yet)
const talkCard = (n) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 200"><rect width="240" height="200" fill="#eef4f8"/>
  <path d="M60 54h120a16 16 0 0 1 16 16v52a16 16 0 0 1-16 16h-66l-26 22v-22H60a16 16 0 0 1-16-16V70a16 16 0 0 1 16-16Z" fill="#fff" stroke="#9fb7cc" stroke-width="5"/>
  <text x="120" y="111" text-anchor="middle" font-family="RHR, PingFang SC, sans-serif" font-size="40" fill="#2c4564">${String(n).padStart(2, "0")}</text></svg>`);

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
  const v = variant(), c = current(), kind = tab === "lobby" ? "lobby" : "spr";
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
    ["Label_Defense", "info.gameFile", "Data", v.date || "—"], ["Label_Healing", "info.crc", "Data_Widget/Data", T(crc[0]), crc[1]]];
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
    text(t, `${INFO}/Status/${name_}/${dataPath}`, String(value), { w_: rooms[i], fontSize: valueFs, ...(color ? { color: `${color}/1.00` } : {}) });
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

  // row 2: four actions. Title and icon centred as a group on the card's slanted midline.
  const isMod = c.kind === "mod";
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
  // row 3: portrait box, the switch card (the game's light weapon card), add portrait
  const boxTitle = fitText(T(`row.box.${tab}`), 48, 42, 128);
  text(t, `${INFO}/Weapon/WeaponType/Label_WeaponType`, boxTitle.text, { fontSize: boxTitle.fs, w_: 200, h_: 60 * boxTitle.lines });
  at(t, `${INFO}/Weapon/WeaponType/Label_WeaponType`).pos = [-8, -2];
  off(t, `${INFO}/Weapon/WeaponType/Icon`);
  const card = `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target`;
  if (tab !== "portrait" || !hasFresh(v)) off(t, `${INFO}/Weapon/Equip_1/UIEquipmentCard/Dot`);
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
  // the wrapper holds an enabled (cyan) and a disabled (grey) body and label; keep the enabled ones
  let bodies = 0, labels = 0;
  const add = fitText(T(`row.add.${tab}`), 52, 30, 160, 2);
  for (const k of at(t, `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up`).children) {
    if (k.name === "BG (1)") { bodies += 1; if (bodies === 2) k.active = false; }
    if (k.name === "Label_Locale") { labels += 1; if (labels === 2) k.active = false; else Object.assign(k.widgets[0], { text: add.text, fontSize: add.fs, w_: 200, h_: 160 }); }
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
  const row4 = fitText(T(`row.four.${tab}`), 48, 42, 150);
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
  const nm = fitText(fullName(v), 64, 44, 780);
  text(t, `${np}/Label_Name`, nm.text, { w_: 800, fontSize: nm.fs });
  at(t, `${np}/Label_Name`).pos = [110, 288];
  // the dark plate keeps its bottom edge and loses the level row; the game's shard texture is clipped to it
  widget(t, `${np}/BG`).h_ = 120;
  off(t, `${np}/BG/Deco`);
  const poli = layouts.textures.Img_Deco_Poli;
  if (poli) {
    at(t, `${np}/BG`).children.push(node("DecoClip", [0, 0], [{ clipImage: poli, tint: "#0e62b2",
      w_: 906, h_: 120, pivot: 6, depth: 5, incline: 10, radius: 10, color: "#ffffff/0.90",
      imgLeft: `${-13.4 * S}px`, imgTop: "0", imgWidth: `${388 * S}px`, imgHeight: `${172 * S}px`, imgSize: "100% 100%", imgPosition: "0 0" }]));
  }
  // square buttons: fullscreen (lobby, 3D model) or zoom, copy the file name, and on the lobby tab play all dialogue
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
    host.replaceChildren(...next.children);
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
  const c = current();
  const sub = tab === "lobby" ? lobbyLabel(variant()) : tab === "model" ? T("model.original")
    : c.kind === "mod" && c.origin && c.origin.key !== variant().key ? `${shortName(c.origin)} - ${c.label}` : c.label;
  const title = T(`row.switch.${tab}`);
  const tf = fitText(title, 46, 34, textW / S), sf = fitText(sub, 32, 24, textW / S);
  box.style.setProperty("--title-size", `${NGUI.fontSizeFor(title, tf.fs) * S}px`);
  box.style.setProperty("--sub-size", `${NGUI.fontSizeFor(sub, sf.fs) * S}px`);
  const b = document.createElement("b"), span = document.createElement("span"), go = document.createElement("i");
  b.innerText = tf.text;
  span.innerText = sf.text;
  go.className = "switch-go";
  box.append(b, span, go);
  host.appendChild(box);
}

function hits(view, leftHost, rightHost) {
  const add = (host, path, fn, title) => {
    const el = view.nodes.get(`Inventory_ListControl/${path}`)?.els[0];
    if (el) hitButton(host, rect(el), fn, title);
  };
  if (tab === "portrait") {
    add(rightHost, `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`, openPopup, T("row.switch.portrait"));
    add(rightHost, `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up/BG (1)`, addMods, T("popup.add"));
  }
  add(rightHost, `${INFO}/Status/Btn_Up_Wrapper/Btn_Up/BG (1)`, () => reveal(gameFile(variant(), tab === "lobby" ? "lobby" : "spr")), T(platform === "mac" ? "open.mac" : "open.win"));
  const act = (card, fn, title) => add(rightHost, `${INFO}/Skill/${card}/Bg`, fn, title);
  act("SkillData_EX (1)", () => runUpdate(), T("act.update"));
  act("SkillData_EX (2)", () => runExtract(), T("act.extract"));
  act("SkillData_EX (3)", () => runCompare(), T("act.compare"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Pin/Pin_On/Bg", toggleFav, T("fav.label"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Pin/Pin_Off/Bg", toggleFav, T("fav.label"));
  add(leftHost, "LeftInfo/CharInfo/Char_Target/Char_CVCollectionBtn", copyName, baseName(gameFile()));
  add(leftHost, "Arrow_L/Left", () => ctx.stepFamily(fam.key, -1));
  add(rightHost, "Arrow_R/Right", () => ctx.stepFamily(fam.key, 1));
  if (tab === "lobby" || tab === "model") add(leftHost, "LeftInfo/CharInfo/Char_Target/Char_ZoomBtn", () => setFullscreen(true), T("lobby.fullscreen"));
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
  const name = baseName(gameFile());
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
function runUpdate() {
  const c = current();
  if (c.kind !== "mod" || busy) return;
  job("actions.update", { mod: c.id }, { onDone: () => { forget(spineBase("mod", c.id)); } });
}
function runExtract() {
  const c = current();
  if (busy) return;
  const target = c.kind === "mod" ? `mod:${c.id}` : `variant:${variant().key}`;
  job("actions.extract", { target }, { onDone: (r) => reveal(r?.folder) });
}
async function runCompare() {
  const c = current();
  if (c.kind !== "mod" || busy) return;
  const result = await call(() => rpc("actions.compare", { mod: c.id }));
  if (result) showCompare(result);
}
async function applyCandidate(key) {
  const v = variant();
  await job("actions.apply", { variant: v.key, source: sourceOf(key), kind: "spr" }, {
    onDone: () => { forget(spineBase("spr", v.spr)); },
    // the applied portrait swaps in with the rest of the screen; the old one shows until then
    after: (ok) => {
      if (!ok) return reload();
      ctx.invalidateRoster();
      expression = "00";
      clearTimeout(blinkTimer);
      mainPlayer = null;
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
function stripCard(name, x, { w = CARD.w, h = CARD.h, thumb: pic = null, selected = false, dim = false, caption = "", body = "", tone = "#ffffff" } = {}) {
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
    // (the subtitle shows it in full)
    let f = fitText(body, 40, 32, w - 52, 4), cut = body;
    while (f.lines === 1 && glyphsOf(f.text, f.fs) > w - 52 && cut.length > 4) { cut = cut.slice(0, -2); f = fitText(`${cut}…`, 40, 32, w - 52, 4); }
    kids.push(node("Body", [0, cy], [label(f.text, f.fs, "#2c4564/1.00", w - 40, f.fs * 1.3 * f.lines, { depth: 12 })]));
  }
  if (selected) kids.push(node("Select", [1, cy], [sprite("Card_Select_Line_Blue", w + 6, vis + 8, { incline: 10, depth: 20 })],
    [node("Check", [w / 2 - 30 + (vis / 2 - 26) * TAN10, vis / 2 - 26], [sprite("Common_Icon_Check_B", 56, 54, { type: 0, depth: 21 })])]));
  return node(name, [x, ROW4_Y - cy], [sprite("Common_Btn_BG", w, h, { incline: 10, depth: 7, color: `${tone}/1.00` })], kids);
}

// row 4 per tab: the portrait's faces, the memorial lobby's dialogues
function row4Items() {
  if (tab === "lobby") {
    // the lines from Kivo when they could be read, else a numbered speech bubble
    return (Lobby.meta()?.sequences || []).map((sq) => {
      const text = Lobby.textOf(sq).join(" ");
      return text ? { key: sq.anim, body: text, title: text } : { key: sq.anim, thumb: talkCard(sq.n), title: String(sq.n) };
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
// a dialogue started (a card, play all, a tap on the character in fullscreen), ended or stopped
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
  const cardOf = (it, x, extra = {}) => stripCard(`Item_${it.key}`, x, { thumb: it.thumb, body: it.body, caption: it.caption, selected: it.key === sel, ...extra });
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
// the old one, which goes.
function loadSpine(base) {
  const my = ++spineToken;
  const host = $("portrait");
  const layer = document.createElement("div");
  layer.className = host.children.length || batch ? "layer fading" : "layer";
  host.appendChild(layer);
  const previous = [...host.querySelectorAll(".layer")].filter((l) => l !== layer);
  clearTimeout(blinkTimer);
  prioritise(base);
  return new Promise((resolve) => {
    layer.done = resolve; // settled by disposePortrait() too
    layer.player = new spine.SpinePlayer(layer, {
      skeleton: `${base}.skel`, atlas: `${base}.atlas`, animation: "Idle_01",
      premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000",
      showControls: false, showLoading: false, preserveDrawingBuffer: true,
      // no viewport transition: spine-player starts it from an undefined viewport and draws nothing meanwhile
      viewport: { padLeft: "6%", padRight: "6%", padTop: "3%", padBottom: "0%", transitionTime: 0 },
      success: async (player) => {
        if (my !== spineToken) { resolve(); return; } // a newer portrait took over; it retires this layer
        mainPlayer = player;
        applyExpression();
        scheduleBlink(player);
        await renderExpressions(); // the faces come from this skeleton
        await frames(2);           // its first frame is on the canvas
        commit(() => {
          if (my !== spineToken) return;
          layer.classList.remove("fading");
          for (const old of previous) {
            old.classList.add("fading");
            setTimeout(() => { old.player?.dispose(); old.remove(); }, 400);
          }
        });
        resolve();
      },
      error: (_p, message) => {
        console.error(message);
        toast(T("error.internal", { error: message }), { kind: "error" });
        resolve();
      },
    });
  });
}
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

// switch portrait: the variant's own skeleton and added portraits, then the other variants'
let popupSeg = 0, popupToken = 0;
async function renderPopup(scroll = 0) {
  const v = variant();
  const items = candidates().map((c) => ({
    key: c.key, kind: c.kind, recruit: c.kind !== "mod" && c.recruit,
    label: c.kind === "mod" && c.origin && c.origin.key !== v.key ? `${shortName(c.origin)} - ${c.label}` : c.label,
    full: c.kind === "mod" ? c.label : fullName(c.variant),
    thumb: thumb(baseOf(c), "card"), big: () => thumb(baseOf(c), "bust"),
    inUse: c.key === appliedKey(), fav: c.fav, isNew: c.kind === "mod" && c.mod.fresh, src: c,
  }))
    .filter((it) => popupSeg === 0 || (popupSeg === 1) === !!it.recruit)
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0));
  await listPopup({
    hostId: "popup", title: T("popup.switch"), okText: T("popup.apply"), items, selected: pending, keepScroll: scroll,
    segs: ["seg.all", "seg.recruit", "seg.noRecruit"], seg: popupSeg, onSeg: (i) => { popupSeg = i; renderPopup(); }, sortKey: "sort.default",
    onSelect: (key, s) => {
      pending = key;
      const c = candidates().find((x) => x.key === key);
      if (c?.kind === "mod" && c.mod.fresh) rpc("mods.seen", { id: c.id }).then(() => { c.mod.fresh = false; }).catch(() => {});
      renderPopup(s);
    },
    onOk: () => closePopup(true), onClose: () => closePopup(false),
    details: (it) => {
      const c = it.src, inUse = it.inUse;
      const file = c.kind === "mod" ? c.mod.file : gameFile(c.variant);
      const size = c.kind === "mod" ? c.mod.size : partsOf(c.variant).reduce((n, f) => n + (f.size || 0), 0);
      const status = c.kind === "mod" ? (inUse ? ["status.installed", "#1f9a52"] : ["status.notInstalled", "#d9822b"]) : ["status.gameFile", ""];
      const crcState = inUse ? crcOf(v) : null;
      const crc = crcState === "fixed" ? ["crc.fixed", "#1f9a52"] : crcState === "needs_fix" ? ["crc.needed", "#d9822b"] : crcState === "ok" ? ["crc.original", ""] : null;
      return {
        title: T("info.title.portrait"),
        fields: [[T("field.file"), baseName(file)], [T("field.size"), sizeText(size)], [T("field.status"), T(status[0]), status[1] && `${status[1]}/1.00`],
          [T("field.crc"), crc ? T(crc[0]) : "—", crc?.[1] && `${crc[1]}/1.00`]],
        actions: [[T(platform === "mac" ? "open.mac" : "open.win"), () => reveal(file)],
          c.kind === "mod"
            ? [T("btn.remove"), async () => {
              try { await rpc("mods.remove", { id: c.id }); } catch (err) { toast(errorText(err), { kind: "error" }); return; }
              await reload();
              ctx.invalidateRoster();
              if (pending === c.key) pending = appliedKey();
              renderPopup();
            }]
            : [T("btn.extract"), () => { closePopup(false); job("actions.extract", { target: `variant:${c.variant.key}` }, { onDone: (r) => reveal(r?.folder) }); }]],
      };
    },
  });
}
function openPopup() { pending = appliedKey(); popupSeg = 0; renderPopup(); }
function closePopup(apply) {
  $("popup").hidden = true;
  $("popup").innerHTML = "";
  if (apply && pending && pending !== appliedKey()) applyCandidate(pending);
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

// compare: what the mod changes against the game's official file, on the popup frame
async function showCompare(result) {
  const host = $("popup");
  const t = clone(find(layouts.sortPopup, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: 1900, h_: 1180 });
  find(bg, "Texture_Top").pos = [-950 + 248, 590 - 66];
  const title = find(bg, "Label_Title_Locale");
  const tf = fitText(T("act.compare"), 72, 52, 1300);
  Object.assign(title.widgets[0], { text: tf.text, fontSize: tf.fs, w_: 1400 });
  title.pos = [0, 590 - 64];
  find(title, "Line").widgets[0].w_ = glyphsOf(tf.text, tf.fs) + 14;
  find(bg, "Btn_Close").pos = [950 - 90, 590 - 60];
  find(popup, "Btn").active = false;
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
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
  }));
}

// tabs: the left side shows the portrait, the memorial lobby or the 3D model
function showTab(id) {
  tab = id;
  expanded = false;
  exprScroll = 0;
  lobbySeq = null;
  return changeInPlace(() => Promise.all([renderAll(), renderLeft()]));
}

// renderLeft() -> Promise, resolved once the tab's part has drawn its first frame (the lobby also its still and
// lines, the model its still). The part loads laid out but transparent (.pending: a hidden canvas has no size) and is
// committed with the rest of the screen; the part it replaces fades out and is freed. The lobby and the model are
// single players: when the shown one is replaced by another variant's, a still of it holds the place meanwhile.
const LEFT = ["portrait", "lobby", "model"];
let shownLeft = null, shownKey = null;
const leftKey = (part, v) => (part === "lobby" ? v.lobby : part === "model" ? v.key : null);
function renderLeft() {
  const v = variant(), my = ++leftToken, want = tab, el = $(want), key = leftKey(want, v);
  const same = want === shownLeft;
  if (!same) {
    el.hidden = false;
    el.classList.remove("leaving");
    el.classList.add("pending");
  }
  const swap = same && key !== shownKey ? freezeLeft(want) : null;
  const ready = Promise.resolve(swap).then(() => (want === "portrait" ? (mainPlayer ? null : loadSpine(baseOf(current())))
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

// the memorial lobby: every layer in and drawn, the still for the switch card, the dialogue strip; the lines from
// Kivo when they come in time (later ones re-render the strip)
async function showLobby(v, my) {
  const still = () => my === leftToken && tab === "lobby" && variantKey === v.key;
  const m = await Lobby.show(v.lobby, $("lobby"), v.key);
  if (!m || !still()) return;
  if (fullscreen) { Lobby.frame("full"); Lobby.interactive(true); }
  // lines and voices from Kivo; the Chinese UIs show the Chinese text, the others the original Japanese
  const lines = rpc("lobby.lines", { variant: v.key }).then((table) => {
    if (!still()) return null;
    const pick = (l) => (language().startsWith("zh") ? l?.["zh-CN"] || l?.ja : l?.ja || l?.["zh-CN"]) || "";
    Lobby.setLines(table, pick);
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
  const still = () => my === leftToken && tab === "model" && variantKey === v.key;
  try {
    const M = await ModelLib();
    if (!still()) return;
    const list = await M.show(v.key, $("model"), {
      frame: fullscreen ? "full" : "left",
      onAction: (a) => { if (tab === "model" && variantKey === v.key) { modelAction = a; renderExpressions(); } },
    });
    if (!list || !still()) return;
    modelActions = list;
    modelAction = M.current();
    if (!modelShot && !fullscreen) modelShot = M.snapshot();
    await Promise.all([renderScreen(), renderExpressions()]);
  } catch (err) {
    console.error(err);
    if (still()) toast(T("error.internal", { error: err?.message || String(err) }), { kind: "error" });
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
// in fullscreen the character can be touched and the view zoomed like in the game; leaving resets the zoom
function setFullscreen(on) {
  fullscreen = on;
  stage().classList.toggle("fullscreen", on);
  if (tab === "lobby") { Lobby.frame(on ? "full" : "left"); Lobby.interactive(on); }
  if (tab === "model") modelLib?.then((M) => M.frame(on ? "full" : "left"));
  $("fs-exit").hidden = !on;
  if (on) { wake(); stage().addEventListener("pointermove", wake); } else { stage().removeEventListener("pointermove", wake); clearTimeout(idleTimer); }
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
  layouts = { list: find(detail, "Inventory_ListControl"), collection, sortPopup, textures };
}

// the voice volume and mute from the settings (development runs started with --mute stay silent)
export function applyPrefs(prefs) {
  Lobby.setVolume((prefs?.voiceVolume ?? 80) / 100, ctx?.info?.mute || prefs?.voiceMuted);
}

// show(context, familyData, variantKey, {inPlace}): open the detail screen on a variant; resolves once the screen is
// ready (the panels, the left side's first frame, the visible thumbnails within THUMBS_CAP). In place (another
// variant or family while the screen is shown), the shown screen stays until then and every part swaps in one frame.
export async function show(context, familyData, key, { inPlace = false } = {}) {
  ctx = context;
  applyPrefs(ctx.prefs);
  const g = begin();
  await ensureLayouts();
  if (g.gen !== showGen) return;
  const sameFamily = fam?.key === familyData.key;
  const sameVariant = sameFamily && variantKey === key;
  fam = familyData;
  variantKey = fam.variants.some((v) => v.key === key && v.spr) ? key : (fam.variants.find((v) => v.spr) || fam.variants[0]).key;
  setTitle(T("top.students"), () => { location.hash = "#/roster"; });
  if (!sameVariant) {
    expression = "00";
    expanded = false;
    lobbyShot = null;
    lobbySeq = null;
    modelShot = null;
    modelActions = [];
    modelAction = null;
    if (tab === "lobby" && !hasLobby(variant())) tab = "portrait";
    if (tab === "model" && !hasModel(variant())) tab = "portrait";
    // a new portrait is loaded; the shown one stays until it is committed
    clearTimeout(blinkTimer);
    mainPlayer = null;
  }
  rpc("ui.visit", { variant: variantKey }).catch(() => {});
  // the left side starts at once, beside the panels
  await prepare(g, inPlace, async () => {
    await Promise.all([renderAll(), renderLeft()]);
    await settleThumbs();
  });
}

// leaving the screen: stop the players, drop any change being prepared
export function hide() {
  begin();
  batch = null;
  leftToken += 1;
  if (fullscreen) setFullscreen(false);
  disposePortrait();
  Lobby.hide($("lobby"));
  hideModel();
  unfreezeLeft(true);
  shownLeft = shownKey = null;
  for (const part of LEFT) { $(part).hidden = true; $(part).classList.remove("pending", "leaving"); }
  for (const id of ["popup", "picker"]) { $(id).hidden = true; $(id).innerHTML = ""; }
}

$("fs-exit")?.addEventListener("click", () => setFullscreen(false));
