// The real detail and NGUI modules, with mod-backed family data and stand-in browser/Spine loaders.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { switchPrefabs } from "./switch_prefabs.mjs";
import { selectionPrefab, selectionFramePixels, selectionSprite } from "./selection_prefabs.mjs";
import { controls } from "./control_prefabs.mjs";
import { visualPrefab } from "./visual_prefabs.mjs";
const controlLayouts = controls();
const switchLayouts = switchPrefabs();

class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: { setProperty(k, v) { this[k] = v; } },
      dataset: {}, attrs: {}, listeners: {}, className: "", hidden: false, textContent: "", id: "", width: 8, height: 8 });
    // Match the DOM's non-enumerable parent link so failed assertions cannot
    // recursively print the complete page through every sibling's parent.
    Object.defineProperty(this, "parentNode", { value: null, writable: true, enumerable: false });
    this.classList = {
      contains: (c) => this.className.split(" ").includes(c),
      replace: (a, b) => { this.classList.remove(a); this.classList.add(b); },
      add: (...cs) => { this.className = [...new Set([...this.className.split(" "), ...cs])].join(" "); },
      remove: (...cs) => { this.className = this.className.split(" ").filter((c) => !cs.includes(c)).join(" "); },
      toggle: (c, on) => on ? this.classList.add(c) : this.classList.remove(c),
    };
  }
  appendChild(child) {
    if (child.tagName === "FRAGMENT") { this.append(...[...child.children]); return child; }
    child.remove(); child.parentNode = this; this.children.push(child); return child;
  }
  append(...kids) { kids.forEach((k) => this.appendChild(k)); }
  replaceChildren(...kids) { [...this.children].forEach((c) => c.remove()); this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  after(child) { this.parentNode?.appendChild(child); }
  contains(n) { return walk(this).includes(n); }
  get isConnected() { return body.contains(this); }
  get parentElement() { return this.parentNode; }
  get childNodes() { return [...this.children]; }
  set innerHTML(html) {
    this.replaceChildren();
    for (const m of html.matchAll(/<(div|canvas|span|i)\b([^>]*)>/g)) {
      const child = new El(m[1]); child.className = /class="([^"]*)"/.exec(m[2])?.[1] || ""; this.appendChild(child);
    }
  }
  querySelectorAll(selector) {
    if (selector === ".lobby-view .lobby-layer:not(.lobby-off) canvas") return walk(this)
      .filter((n) => n.classList.contains("lobby-layer") && !n.classList.contains("lobby-off")).flatMap((n) => n.querySelectorAll("canvas"));
    const match = (n) => selector === "*" ? true : selector.startsWith(".") ? n.classList.contains(selector.slice(1)) : n.tagName === selector.toUpperCase();
    return walk(this).slice(1).filter(match);
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = body; }
  closest(selector) { assert.equal(selector, "[inert]"); for (let n = this; n; n = n.parentNode) if (n.inert) return n; return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; }
  click() { return Promise.all((this.listeners.click || []).map((f) => f({ type: "click", stopPropagation() {} }))); }
  getContext() {
    return { font: "", measureText(s) {
      const fs = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 10);
      return { width: [...s].reduce((w, c) => w + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/.test(c) ? fs : fs / 2), 0) };
    }, drawImage() {}, fillRect() {}, clearRect() {}, scale() {}, transform() {}, putImageData() {}, getImageData(_x, _y, width, height) {
      if (width === 30 && height === 30) return selectionFramePixels();
      return { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, () => [20, 40, 60, 255]).flat()) };
    } };
  }
  toBlob(fn) { fn(new Blob()); }
  toDataURL() { return "data:image/png;base64,c3ludGhldGljLW1hc2s="; }
}
const walk = (el) => [el, ...el.children.flatMap(walk)];
const body = new El("body"), title = new El(), back = new El("button");
const hosts = Object.fromEntries(["stage", "screen-detail", "ngui", "ngui-bg", "ngui-chips", "ngui-expr", "portrait", "lobby", "model",
  "popup", "picker", "dialog", "prompt", "consent", "notify", "fs-exit", "visual-ui", "visual-bg"].map((id) => {
  const el = body.appendChild(new El()); el.id = id; el.hidden = /popup|picker|dialog|prompt|consent/.test(id); return [id, el];
}));
const documentEvents = new EventTarget();
globalThis.window = new EventTarget();
globalThis.document = { hidden: false, hasFocus: () => true, body, documentElement: new El("html"), activeElement: body,
  createElement: (tag) => new El(tag), createDocumentFragment: () => new El("fragment"), getElementById: (id) => hosts[id] || walk(body).find((el) => el.id === id),
  querySelector: (s) => s === ".topbar .title" ? title : s === ".topbar .back" ? back : null,
  querySelectorAll: () => [], addEventListener: (...args) => documentEvents.addEventListener(...args),
  removeEventListener: (...args) => documentEvents.removeEventListener(...args) };
Object.defineProperty(globalThis, "navigator", { value: { platform: "Mac" }, configurable: true });
globalThis.location = { hash: "#/student/ibuki/ibuki" };
const globalListeners = {};
globalThis.addEventListener = (type, fn) => (globalListeners[type] ||= new Set()).add(fn);
globalThis.removeEventListener = (type, fn) => globalListeners[type]?.delete(fn);
const keydown = (key) => { for (const fn of [...(globalListeners.keydown || [])]) fn({ key, preventDefault() {} }); };
globalThis.Audio = class { constructor() { assert.fail("Audio must remain muted in tests"); } };
globalThis.requestAnimationFrame = (fn) => { queueMicrotask(() => { for (const p of thumbnailPlayers) if (!p.disposed) p.config.draw?.(p); fn(performance.now()); }); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ opacity: "1" });

const imageRequests = [], pendingImages = [];
let imageMode = "ready", playerMode = "ready", portraitRevision = "a", portraitStatus = 200;
let blankThumbnailCore = "";
let decodeMode = "ready", thumbMode = "pending", portraitExpressions = ["00", "01"];
const thumbnailPlayers = [], pendingThumbnails = [];
const pendingDecodes = [], pendingPlayers = [];
globalThis.Image = class {
  naturalWidth = 8; naturalHeight = 8;
  set src(url) {
    if (url.includes('Common_Bg_Raius10px_Select')) this.naturalWidth = this.naturalHeight = 30;
    imageRequests.push(url);
    if (imageMode === "pending") pendingImages.push(this);
    else queueMicrotask(() => imageMode === "error" ? this.onerror?.() : this.onload?.());
  }
  decode() {
    return decodeMode === "pending" ? new Promise((resolve) => pendingDecodes.push(resolve)) : Promise.resolve();
  }
};
const playerRequests = [], previewPlayers = [];
class RegionAttachment {
  region = {}; color = { a: 1 };
  computeWorldVertices(_slot, vertices) { vertices.set([-4000, -2000, 4000, -2000, 4000, 3000, -4000, 3000]); }
}
class Skeleton {
  constructor(data) {
    this.data = data; this.color = { a: 1 };
    this.drawOrder = [{ getAttachment: () => new RegionAttachment(), bone: { active: true }, data: { blendMode: 0 }, color: { a: 1 } }];
  }
  setToSetupPose() {} updateWorldTransform() {} findBone() { return null; }
}
class AnimationState {
  constructor(data) { this.data = data; }
  setAnimation(_track, name) { return this.entry = { animation: { name } }; }
  setEmptyAnimation() { return this.setAnimation(0, "<empty>"); }
  getCurrent() { return this.entry; }
  update() {} apply() {} clearTracks() { this.entry = null; }
}
globalThis.spine = { Vector2: class {}, Physics: { update: 1 }, RegionAttachment, MeshAttachment: class {}, Skeleton,
  AnimationState, AnimationStateData: class { constructor(data) { this.skeletonData = data; } }, BlendMode: { Normal: 0 }, SpinePlayer: class {
  constructor(el, config) {
    assert.equal(config.premultipliedAlpha, false, "portraits and thumbnails retain the 0.2.0 PMA flag");
    playerRequests.push(config.skeleton);
    this.dispose = () => { this.disposed = true; }; this.config = config;
    this.currentViewport = { ...config.viewport };
    this.canvas = new EventTarget(); this.stopRequestAnimationFrame = false;
    this.stopRendering = () => { this.stopRequestAnimationFrame = true; };
    this.startRendering = () => { this.stopRequestAnimationFrame = false; };
    if (el.className !== "thumb-player") previewPlayers.push(this);
    const animations = ["Idle_01", ...portraitExpressions].map((name) => ({ name, timelines: [] }));
    this.skeleton = { data: { animations, findAnimation(name) {
      if (playerMode === "broken") throw new Error("Mod skeleton setup failed");
      return animations.find((a) => a.name === name);
    } }, slots: [], setToSetupPose() {}, updateWorldTransform() {},
      getBounds: (offset, size) => { Object.assign(offset, { x: 0, y: 0 }); Object.assign(size, { x: 800, y: 1600 }); },
    };
    this.trackNames = {};
    this.animationState = { setAnimation: (track, name) => { this.trackNames[track] = name; return { animation: {} }; }, setEmptyAnimation: () => ({ animation: {} }), addEmptyAnimation() {}, clearTracks() {}, apply() {} };
    if (playerMode === "lobby-ready" && el.className === "lobby-layer") {
      this.skeleton.data.findBone = () => null;
      this.skeleton = new Skeleton(this.skeleton.data);
      this.animationState = new AnimationState({ skeletonData: this.skeleton.data });
      this.canvas = el.appendChild(new El("canvas"));
    }
    this.setViewport = () => {};
    this.drawFrame = () => config.draw?.(this);
    if (el.className === "thumb-player") {
      thumbnailPlayers.push(this);
      this.context = { gl: { drawingBufferWidth: 2, drawingBufferHeight: 1, RGBA: 1, UNSIGNED_BYTE: 1,
        readPixels: (_x, _y, _w, _h, _f, _t, pixels) => {
          if (!blankThumbnailCore || !config.skeleton.includes(blankThumbnailCore)) pixels.set([0, 0, 0, 0, 200, 100, 50, 255]);
        } } };
      el.appendChild(new El("canvas"));
      const done = () => config.success(this);
      if (thumbMode === "ready") queueMicrotask(done); else pendingThumbnails.push(done);
    } else if (playerMode !== "pending") {
      if (playerMode === "stale") {
        playerMode = "ready"; portraitRevision = "b";
        queueMicrotask(() => config.error(this, `Couldn't load binary ${config.skeleton}: status 404`));
      } else queueMicrotask(() => config.success(this));
    } else if (el.className !== "thumb-player") pendingPlayers.push(() => config.success(this));
  }
} };

const node = (name) => ({ name, pos: [0, 0], scale: [1, 1], active: true, widgets: [
  { sprite: "Common_Bg_Raius10px", w_: 100, h_: 100, color: "#ffffff/1.00" },
  { text: "text", w_: 100, h_: 100, fontSize: 40 },
], children: [] });
const detail = node("UICharacterDetail"), list = node("Inventory_ListControl"); detail.children.push(list);
function add(path, root = list) {
  let at = root;
  for (const name of path.split("/")) {
    let child = at.children.find((n) => n.name === name);
    if (!child) at.children.push(child = node(name));
    at = child;
  }
  return at;
}
const INFO = "RightInfo/Target/Active/1_NormalInfo", PLATE = "LeftInfo/CharInfo/Char_Target";
for (const path of ["BG", "CharacterPos", "Arrow_L/Left", "Arrow_R/Right", "RightInfo/Target/Active/Bg",
  `${INFO}/Title_Bg/Label_Locale`, `${INFO}/Detail_Btn/Label_Locale`, `${INFO}/Equip`]) add(path);
add("BG").widgets = [{ texture: "Detail_Background", w_: 2960, h_: 1665, color: "#ffffff/1.00" }];
for (const tab of ["Tab_1", "Tab_2", "Tab_3"]) for (const state of ["Tab_On", "Tab_Off"]) {
  add(`RightInfo/Target/Active/CharacterTab/${tab}/${state}/Label`);
  add(`RightInfo/Target/Active/CharacterTab/${tab}/${state}/BG`);
}
for (const [tab, dot] of [["Tab_1", "Dot"], ["Tab_2", "Dot (1)"], ["Tab_3", "Dot (2)"]]) {
  add(`RightInfo/Target/Active/CharacterTab/${tab}/${dot}`).widgets = [
    { sprite: "Common_Icon_Reddot2", w_: 34, h_: 31, color: "#ffffff/1.00" },
  ];
}
const sortPopup = node("UIPopup_Sort");
for (const path of ["Center/BlackBg/BlackBgClickArea", "Center/Popup/Base/BG/Texture_Top",
  "Center/Popup/Base/BG/Label_Title_Locale/Line", "Center/Popup/Base/BG/Btn_Close"]) add(path, sortPopup);
for (const button of ["Btn_Ok", "Btn_Cancel"]) {
  add(`Center/Popup/Btn/${button}/BG (1)`, sortPopup);
  add(`Center/Popup/Btn/${button}/Label_Locale`, sortPopup);
}
for (const stat of ["Label_Life", "Label_Attact", "Label_Defense", "Label_Healing"]) {
  add(`${INFO}/Status/${stat}/Data_Widget/Data`); add(`${INFO}/Status/${stat}/Data`);
}
for (const button of ["Status", "Weapon"]) for (const path of ["BG (1)/Corner", "Label_Locale"]) add(`${INFO}/${button}/Btn_Up_Wrapper/Btn_Up/${path}`);
for (const card of ["SkillData_EX", "SkillData_EX (1)", "SkillData_EX (2)", "SkillData_EX (3)"]) {
  for (const path of ["Bg/Bg_Line", "Normal/Label_SkillType", "Normal/SkillIconBg/Texture"]) add(`${INFO}/Skill/${card}/${path}`);
  for (const path of ["Normal/SkillIconBg/SkillIconBg (1)", "Normal/SkillIconBg/Deco", "Normal/SkillIconBg/Bg_Skill_Plus/IconPlus"]) add(`${INFO}/Skill/${card}/${path}`);
  add(`${INFO}/Skill/${card}/Bg/Corner`).widgets = [{ sprite: "Common_Btn_Normal_B_C_Pt", w_: 20, h_: 10, pivot: 2,
    anchors: { leftAnchor: [1, -23], rightAnchor: [1, -3], bottomAnchor: [1, -14], topAnchor: [1, -4] } }];
}
for (const path of ["BG/BG (1)", "Line/Line", "Label_WeaponType"]) add(`${INFO}/Weapon/WeaponType/${path}`);
for (const path of ["Card_Bg/Deco", "Card_Level"]) add(`${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/${path}`);
add(`${INFO}/Weapon/Equip_1/UIEquipmentCard/Dot`).widgets = [
  { sprite: "Common_Icon_Reddot2", w_: 34, h_: 31, color: "#ffffff/1.00" },
];
for (const path of ["BG/Deco", "Label_Name", "Char_CVCollectionBtn/Sprite", "Char_ZoomBtn/Sprite",
  "Pin/Pin_On/Bg/Icon/Label_Locale", "Pin/Pin_Off/Bg/Icon/Label_Locale"]) add(`${PLATE}/${path}`);

const atlas = { Common: Object.fromEntries([...new Set([
  ...[...readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8").matchAll(/"(Common_[A-Za-z0-9_]+)"/g)].map((m) => m[1]),
  "Common_Bg_Raius10px_Select", "Common_Icon_Check_Y_Off", "Common_Icon_Mulligan_1", "Common_Icon_Mulligan_2", "Card_Select_Line_Blue", "Cafe_Icon_NameEdit", "Common_Icon_Reddot2", "School_Icon_Schedule",
  "Common_UIHide_Icon", "Common_Icon_Back", "Common_Empty", "Cafe_Icon_Rotate",
])].map((name) => [name, name === 'Common_Bg_Raius10px_Select' ? selectionSprite : { width: 8, height: 8 }])), Event: { Event_Icon_ClueSearch_857: { width: 8, height: 8 } } };
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
let family, indexMode = "ready", layoutMode = "ready", lobbyMode = "pending", optionalPending = false, modsEnabled = true;
let seenReply = async () => ({ result: null });
const saveAlias = async ({ id, label }) => {
  const mod = family.variants.flatMap((v) => v.modList || []).find((m) => m.id === id);
  mod.defaultLabel ||= mod.label;
  mod.alias = label.trim(); mod.label = mod.alias || mod.defaultLabel;
  return { result: mod };
};
let renameReply = saveAlias;
const textureReplies = [], layoutReplies = [], rpcRequests = [], assetRequests = [];
const textures = { Detail_Background: "/asset/ui/texture/Detail_Background.png" };
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const request = JSON.parse(opts.body), { method } = request;
    rpcRequests.push(request);
    if (method === "mods.seen") return reply(await seenReply(request.params));
    if (method === "mods.rename") return reply(await renameReply(request.params));
    if (method === "aliases.set") return reply({ result: request.params.aliases.map((s) => s.trim()).filter(Boolean) });
    if (method === "ui.preview") {
      const { variant, kind, source } = request.params;
      const v = family.variants.find((v) => v.key === variant);
      (v.previewSources ||= {})[kind] = source;
      return reply({ result: { ...v.previewSources } });
    }
    if (method === "actions.apply") {
      const { variant, kind, source } = request.params;
      const v = family.variants.find((v) => v.key === variant);
      (v.configured ||= {})[kind] = source === "official" ? null : source;
      if (modsEnabled) for (const file of v.state.files.filter((f) => f.kind === kind)) file.applied = source;
      return reply({ result: "apply-test" });
    }
    if (method === "jobs.get" && request.params.id === "apply-test")
      return reply({ result: { state: "done", result: { deferred: !modsEnabled, files: [] } } });
    return reply({ result: method === "family.get" ? family : method === "mods.state" ? { enabled: modsEnabled } : null });
  }
  assetRequests.push(url);
  if (url === "/asset/ui/atlases.json") {
    assert.equal(opts.cache, "no-store", "reload must bypass an old browser-cached empty atlas index");
    if (indexMode === "pending") return new Promise(() => {});
    if (indexMode === "empty") return reply({});
    if (indexMode === "partial") return reply({ Common: { Back: { width: 8, height: 8 } } });
    if (indexMode === "invalid") return reply({ Common: { Back: null } });
    return reply(atlas, indexMode === "error" ? 500 : 200);
  }
  if (url === "/asset/ui/textures.json") {
    if (optionalPending) return new Promise((resolve) => textureReplies.push(() => resolve(reply(textures))));
    return reply(textures);
  }
  if (url === "/asset/ui/layout/UICharacterDetail.json") {
    if (layoutMode === "pending") return new Promise((resolve) => layoutReplies.push(() => resolve(reply(detail))));
    return reply(detail, layoutMode === "error" ? 500 : 200);
  }
  if (url.startsWith("/asset/ui/layout/")) {
    if (optionalPending && url.endsWith("UIPopup_Sort.json")) return new Promise(() => {});
    if (url.endsWith("UICharacterCollectionPopulatorUnit.json")) return reply(switchLayouts.unit);
    if (url.endsWith("UINonEquipmentInventory.json")) return reply(switchLayouts.inventory);
    if (url.endsWith("UIPopup_Sort.json")) return reply(sortPopup);
    if (url.endsWith("UIPopup_Mulligan.json")) return reply(selectionPrefab());
    if (url.endsWith("UIPopup_Option_PC.json")) return reply(controlLayouts.option);
    if (url.endsWith("UIPopup_FilterSort.json")) return reply(controlLayouts.filter);
    if (url.endsWith("UICharacterVisualMode.json")) return reply(visualPrefab());
    if (url.endsWith("UICharacterCollection.json") || url.endsWith("UIPopup_GachaCharList.Btn_Checkbox.json")) return reply(null, 404);
    return reply(node("Empty"));
  }
  if (url.startsWith("/asset/spine/") && url.endsWith("manifest.json")) {
    if (url.includes("/lobby/") && lobbyMode === "pending") return new Promise(() => {});
    return reply({ revision: portraitRevision.repeat(64) }, url.includes("/spr/") ? portraitStatus : 200);
  }
  if (url.startsWith("/asset/spine/lobby/")) {
    if (lobbyMode === "pending") return new Promise(() => {});
    return reply(url.endsWith("files.json") ? ["ibuki_home.skel", "ibuki_home.atlas"] : null);
  }
  if (url.startsWith("/asset/spine/mod/library-only-lobby/")) {
    return reply(url.endsWith("files.json") ? ["ibuki_home.skel", "ibuki_home.atlas"] : null);
  }
  throw new Error(`Unexpected fetch ${url}`);
};
const errors = [], warnings = [];
console.error = (...args) => errors.push(args);
console.warn = (...args) => warnings.push(args);
const flat = (obj, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") flat(value, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = value;
  }
  return out;
};
const { setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
const { setSpineConsent } = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
setSpineConsent(true);
setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
const modelRequests = [], modelStillRequests = [];
let modelPreview = null;
globalThis.__detailModel = {
  createStillView() {
    let source;
    return { async load(url) { source = url; modelStillRequests.push(url); },
      async renderStill() { return `blob:rendered-${source}`; }, dispose() {} };
  },
  async show(key, host, options) {
    modelRequests.push({ key, ...options });
    modelPreview = options;
    const canvas = document.createElement("canvas"); canvas.className = "model-view ready";
    host.replaceChildren(canvas);
    return ["idle"];
  },
  hide(host) { host?.replaceChildren(); }, frame() {}, settled: async () => {}, current: () => "idle", play() {},
  snapshot: () => `blob:model-${modelPreview?.source}`,
};
const modelStub = `data:text/javascript,${encodeURIComponent(Object.keys(globalThis.__detailModel)
  .map((name) => `export const ${name} = (...args) => globalThis.__detailModel.${name}(...args);`).join("\n"))}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "./model.js" && (ctx.parentURL?.endsWith("/detail.js") || ctx.parentURL?.endsWith("/model-still.js"))) return { url: ${JSON.stringify(modelStub)}, shortCircuit: true };
  return next(spec, ctx);
}`)}`);
await import(modelStub);
const Detail = await import("../../src/ba_modding_toolkit/web/js/detail.js");
const localeTable = (lang) => flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8")));

test("disabled action cards never enable the dark lock cover", () => {
  const card = node("SkillData_EX"), normal = node("Normal"), cover = node("Lock_Cover"), empty = node("Empty");
  const icon = node("SkillIconBg"); icon.widgets[0].color = "#bb3421/1.00";
  normal.children.push(icon); cover.children.push(node("Bg"), node("Icon"), node("Icon_Star"), node("Label_StarNum"));
  card.children.push(normal, cover, empty);
  const original = structuredClone(cover.children);
  for (const enabled of [false, true, false]) {
    Detail.actionState(card, enabled);
    assert.equal(normal.active, true); assert.equal(cover.active, false); assert.equal(empty.active, false);
    assert.equal(icon.widgets[0].color, "#bb3421/1.00");
    assert.deepEqual(cover.children, original);
  }
});


test("disabled actions use the game's grey button body without changing its donor", () => {
  const card = node("SkillData_EX"), normal = node("Normal"), bg = node("Bg");
  card.children.push(bg, normal, node("Lock_Cover"));
  const template = walk(controlLayouts.filter).find((node) => node.name === "Btn_Disable");
  const before = structuredClone(template);
  Detail.actionState(card, false, template);
  assert.equal(card.children.find((child) => child.name === "Lock_Cover").active, false);
  assert.equal(bg.widgets[0].color, template.children.find((node) => node.name === "BG (1)").widgets[0].color);
  assert.deepEqual(template, before);
});
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const Loading = await import("../../src/ba_modding_toolkit/web/js/loading.js");
const ModSwitch = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
const ModAlias = await import("../../src/ba_modding_toolkit/web/js/mod-alias.js");
const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");
let invalidations = 0;
const context = { prefs: { voiceMuted: true, voiceVolume: 0 }, info: {}, invalidateRoster() { invalidations++; }, step() {}, go() {} };
function modFamily(kind = "spr", id = "test") {
  return { key: "ibuki", version: id, variants: [{ key: "ibuki", spr: "ibuki_spr", lobby: "ibuki_home", names: { en: { full: "Ibuki", short: "Ibuki" } },
    modList: [{ id, target: "ibuki", kind, label: id }], state: { files: [{ kind, applied: `mod:${id}`, official: false, restorable: true, crc: "fixed" }] } }] };
}
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
const finish = async (t, promise) => {
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  for (let i = 0; i < 90 && !settled; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.ok(settled, "asset failures must settle the readiness barrier");
  return promise;
};
const switchButton = () => walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`);
const switchDot = () => walk(hosts.ngui).find((e) => e.dataset.path?.endsWith(`${INFO}/Weapon/Equip_1/UIEquipmentCard/Dot`));
const tabDot = (i) => walk(hosts.ngui).find((e) => e.dataset.path?.endsWith(`CharacterTab/Tab_${i}/${i === 1 ? "Dot" : `Dot (${i - 1})`}`));
const chipDot = (key) => walk(hosts["ngui-chips"]).find((e) => e.dataset.path?.endsWith(`/Chip_${key}/Dot`));
const tabButton = (i) => walk(hosts.ngui).find((e) => e.dataset.part?.endsWith(`Tab_${i}/Tab_Off/Label`));
const closeSwitch = async () => { await walk(hosts.popup).find((e) => e.dataset.action === "close").click(); await flush(); };
async function showPortrait(t, key = "ibuki") {
  const showing = Detail.show(context, family, key); await flush();
  await finish(t, showing);
  if (tabButton(1)) {
    const switching = tabButton(1).click(); await flush();
    await finish(t, switching);
  }
}

test("a failed detail layout cannot prevent the installed portrait from loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; layoutMode = "error"; imageMode = "pending"; family = modFamily();
    const start = playerRequests.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.ok(playerRequests.slice(start).some((url) => url.includes("/spr/ibuki_spr/")));
    assert.ok(errors.some((args) => args.some((err) => String(err).includes("layout UICharacterDetail: HTTP 500"))));
    assert.ok(!hosts.portrait.classList.contains("pending"));
  } finally { Detail.hide(); layoutMode = "ready"; await flush(); t.mock.timers.reset(); }
});

test("the installed portrait starts while the detail layout is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; layoutMode = "pending"; family = modFamily();
    const start = playerRequests.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    assert.ok(layoutReplies.length, "the layout has not answered yet");
    assert.ok(playerRequests.slice(start).some((url) => url.includes("/spr/ibuki_spr/")));
    layoutReplies.splice(0).forEach((resolve) => resolve()); layoutMode = "ready"; await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.ok(switchButton(), "panels finish when the layout arrives");
  } finally { Detail.hide(); layoutMode = "ready"; await flush(); t.mock.timers.reset(); }
});

test("detail waits for UI images and bounds optional thumbnails before reveal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    imageMode = "pending"; optionalPending = true; family = modFamily();
    const showing = Detail.show(context, family, "ibuki");
    await flush();
    assert.ok(switchButton()?.listeners.click.length, `the switch has a hit target before any image completes: ${errors.map((a) => a.map((e) => e?.stack || String(e)).join(" ")).join("; ")}`);
    assert.ok(playerRequests.some((p) => p.includes("/spr/ibuki_spr/")), "installed mod bytes come from the current game source");
    assert.ok(!playerRequests.some((p) => p.includes("/mod/test/")), "the installed portrait needs no library preview or kept originals");
    assert.ok(imageRequests.some((p) => p.includes("Common_Bg_Raius10px")), "panel sprites are requested independently of mod previews");
    optionalPending = false; textureReplies.splice(0).forEach((reply) => reply()); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    const panel = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Active/Bg"));
    assert.equal(panel.style.backgroundColor, "#0c284b", "a missing sprite leaves a panel placeholder");
    imageMode = "ready";
    pendingImages.splice(0).forEach((img) => img.onload?.()); await flush();
    family = modFamily("spr", "recovered");
    const retry = Detail.show(context, family, "ibuki"); await flush(); await finish(t, retry);
    const recovered = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Active/Bg"));
    assert.ok(recovered.style.backgroundImage, "a fresh render retries failed sprites");
    assert.equal(recovered.style.backgroundColor, "");
    back.onclick(); assert.equal(location.hash, "#/roster");
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); imageMode = "ready"; optionalPending = false; }
});

test("ready detail controls publish while optional thumbnails continue filling locally", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].spr = "late_spr";
    portraitExpressions = ["00", "01", "02", "03", "04", "05"];
    imageMode = "ready";
    const previous = [...hosts.ngui.children], previousExpressions = [...hosts["ngui-expr"].children];
    let ready = false;
    const showing = Detail.show(context, family, "ibuki").then(() => { ready = true; });
    await flush(); t.mock.timers.tick(3000); await flush();
    assert.equal(ready, true, "never-settling optional thumbnails cannot hold the ready primary preview");
    assert.notDeepEqual(hosts.ngui.children, previous);
    assert.notDeepEqual(hosts["ngui-expr"].children, previousExpressions);
    thumbMode = "ready"; pendingThumbnails.splice(0).forEach((done) => done()); await flush();
    await finish(t, showing);
    const pictures = [hosts.ngui, hosts["ngui-expr"]].flatMap(walk).filter((e) => e.dataset.thumbnail === "true");
    assert.ok(pictures.length >= 5);
    assert.ok(pictures.every((e) => e.style.backgroundImage), "all entry pictures are present at publication");
    assert.ok(pictures.every((e) => e.style.transition === "none"), "publication cannot start thumbnail fades");
  } finally {
    Detail.hide(); thumbMode = "pending"; portraitExpressions = ["00", "01"];
    await flush(); t.mock.timers.reset();
  }
});

test("leaving a page revealed at its deadline cancels thumbnail players, retries and late DOM writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].spr = "cancelled_spr";
    const start = thumbnailPlayers.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(15000); await flush(); await showing;
    const pictures = walk(body).filter((e) => e.dataset.thumbnail === "true");
    Detail.hide();
    assert.ok(thumbnailPlayers.slice(start).every((p) => p.disposed));
    const count = thumbnailPlayers.length;
    pendingThumbnails.splice(0).forEach((done) => done()); await flush();
    t.mock.timers.tick(60000); await flush();
    assert.equal(thumbnailPlayers.length, count, "cancelled queued work cannot start another player");
    assert.ok(pictures.every((e) => !e.style.backgroundImage));
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("NGUI keeps a queued thumbnail beyond fifteen seconds and cancels abandoned pictures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let finish, abandoned;
  try {
    const host = new El();
    const pending = Object.assign(new Promise((resolve) => { finish = resolve; }), { thumbnail: true, signal: controller.signal });
    const gone = Object.assign(new Promise((resolve) => { abandoned = resolve; }), { thumbnail: true, signal: controller.signal });
    const view = await NGUI.render(NGUI.node("Late", [0, 0], [{ clipImage: pending, w_: 10, h_: 10 }]), host);
    const cancelledHost = new El();
    const cancelled = await NGUI.render(NGUI.node("Gone", [0, 0], [{ clipImage: gone, w_: 10, h_: 10 }]), cancelledHost);
    t.mock.timers.tick(20000); await flush();
    finish("blob:late"); await Promise.all(view.pictures);
    assert.equal(walk(host).find((e) => e.dataset.thumbnail).style.backgroundImage, 'url("blob:late")');
    controller.abort(); await Promise.all(cancelled.pictures);
    abandoned("blob:abandoned"); await flush();
    assert.ok(!walk(cancelledHost).find((e) => e.dataset.thumbnail).style.backgroundImage);
  } finally { controller.abort(); await flush(); t.mock.timers.reset(); }
});

test("the first detail reveal waits for its preview and decoded background", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); imageMode = "ready"; playerMode = "pending"; decodeMode = "pending";
    let ready = false;
    const showing = Detail.show(context, family, "ibuki").then(() => { ready = true; });
    await flush(); t.mock.timers.tick(1300); await flush();
    assert.ok(pendingPlayers.length, "the main preview is still loading");
    assert.equal(ready, false);
    playerMode = "ready"; pendingPlayers.splice(0).forEach((done) => done()); await flush();
    assert.ok(pendingDecodes.length, "the detached UI backgrounds are decoded before reveal");
    assert.equal(ready, false);
    decodeMode = "ready"; pendingDecodes.splice(0).forEach((done) => done());
    await finish(t, showing);
    assert.equal(ready, true);
  } finally {
    playerMode = decodeMode = "ready";
    pendingDecodes.splice(0).forEach((done) => done());
    Detail.hide(); await flush(); t.mock.timers.reset();
  }
});

test("main preview and decoded UI remain required while optional thumbnails do not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].spr = "slow_main_spr";
    playerMode = decodeMode = "pending";
    let ready = false;
    const showing = Detail.show(context, family, "ibuki").then(() => { ready = true; });
    await flush(); t.mock.timers.tick(5000); await flush();
    assert.equal(ready, false, "the main portrait must still be ready");
    playerMode = "ready"; pendingPlayers.splice(0).forEach((done) => done()); await flush();
    assert.equal(ready, false, "decoded panel backgrounds remain required");
    decodeMode = "ready"; pendingDecodes.splice(0).forEach((done) => done()); await flush();
    assert.equal(ready, true, "entry thumbnails cannot extend the required-image barrier");
    thumbMode = "ready"; pendingThumbnails.splice(0).forEach((done) => done()); await flush();
    await finish(t, showing);
    assert.equal(ready, true);
    await showing;
  } finally {
    playerMode = decodeMode = "ready"; thumbMode = "pending";
    pendingPlayers.splice(0).forEach((done) => done()); pendingDecodes.splice(0).forEach((done) => done());
    Detail.hide(); await flush(); t.mock.timers.reset();
  }
});

test("abandoning thumbnail colour sampling cancels its image deadline and permits a later load", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  try {
    imageMode = "pending";
    const pending = NGUI.load("blob:cancel-colours", { signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: "AbortError" });
    controller.abort(); await cancelled;
    t.mock.timers.tick(60000); await flush();
    imageMode = "ready";
    assert.ok(await NGUI.load("blob:cancel-colours", { signal: new AbortController().signal }));
  } finally { controller.abort(); imageMode = "ready"; await flush(); t.mock.timers.reset(); }
});

test("a mod portrait setup exception is observed, settled and reported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; playerMode = "broken"; family = modFamily("spr", "broken");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.ok(switchButton());
    assert.ok(errors.some((a) => a.some((e) => String(e).includes("Mod skeleton setup failed"))));
    assert.ok(walk(hosts.dialog).some((el) => el.textContent === "Preview unavailable"));
    assert.ok(!hosts.portrait.classList.contains("pending"));
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); playerMode = "ready"; }
});

test("the main portrait retries a rejected live revision after a cold load", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; family = modFamily(); playerMode = "stale";
    const start = playerRequests.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    const live = playerRequests.slice(start).filter((url) => url.includes("/spr/ibuki_spr/"));
    assert.ok(live.some((url) => url.includes(`/${"a".repeat(64)}/`)));
    assert.ok(live.some((url) => url.includes(`/${"b".repeat(64)}/`)));
    assert.ok(!errors.some((args) => args[0] === "Detail render failed"), errors.map(String).join("\n"));
    assert.ok(warnings.some((args) => args[0] === "Spine source changed during load"));
  } finally { Detail.hide(); playerMode = "ready"; portraitRevision = "a"; await flush(); t.mock.timers.reset(); }
});

for (const status of [404, 500]) test(`the main portrait logs the cause of a failed manifest (${status})`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; warnings.length = 0; family = modFamily(); portraitStatus = status;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.ok(walk(hosts.dialog).some((el) => el.textContent === "Preview unavailable"));
    assert.ok(errors.some((args) => args.includes("/asset/spine/spr/ibuki_spr/skeleton")), "the console names the current source");
    assert.ok([...errors, ...warnings].some((args) => args.some((value) => String(value).includes(`HTTP ${status}`))));
    assert.ok(switchButton(), "the panels stay usable");
  } finally { Detail.hide(); portraitStatus = 200; await flush(); t.mock.timers.reset(); }
});

test("a lobby switch stays covered until its failed preview settles and can retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; family = modFamily("lobby", "lobby");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    const lobbyTab = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("Tab_2/Tab_Off/Label"));
    const switching = lobbyTab.click(); await flush();
    assert.equal(Loading.covering(), false, "in-page preview waits keep the current screen visible");
    assert.equal(Loading.held(), true);
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(1300); await flush(); }
    await finish(t, switching);
    assert.equal(Loading.covering(), false);
    assert.ok(switchButton(), "the new panel commits even though Lobby.show is pending");
    assert.equal(switchButton().getAttribute("aria-label"), "Switch Memorial Lobby");
    t.mock.timers.tick(16000); await flush();
    assert.ok(errors.some((a) => a.some((e) => String(e).includes("Detail lobby: timed out"))));
    assert.equal(hosts.lobby.querySelector(".lobby-unavailable")?.textContent, "Preview unavailable");
    assert.ok(!hosts.lobby.classList.contains("pending"));
    assert.ok(rpcRequests.some((r) => r.method === "preview.failed" && r.params.url.includes("/lobby/ibuki_home/") && r.params.step));
    const before = assetRequests.filter((url) => url.includes("/lobby/") && url.endsWith("manifest.json")).length;
    const portraitTab = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("Tab_1/Tab_Off/Label"));
    const portrait = portraitTab.click(); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, portrait);
    const retryTab = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("Tab_2/Tab_Off/Label"));
    const retry = retryTab.click(); await flush();
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(1300); await flush(); }
    await finish(t, retry);
    assert.ok(assetRequests.filter((url) => url.includes("/lobby/") && url.endsWith("manifest.json")).length > before,
      "showing the lobby tab again asks for a new source after failure");
    t.mock.timers.tick(16000); await flush();
    back.onclick(); assert.equal(location.hash, "#/roster");
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const core of ["arona_workpage_daytime", "np0032_npc"]) for (const category of ["spinebackground", null]) test(`a special L2D ${core} keeps its labels, aliases, repair tags and unseen dots with category ${category}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; lobbyMode = "pending";
    const v = { key: `special:${core}`, spr: null, lobby: core, spineCategory: category,
      names: { en: { full: "Arona - Work Page - Daytime", short: "Work Page - Daytime" } },
      modList: [{ id: "special-day", target: `special:${core}`, core, kind: "lobby", label: "Day", alias: "Painted L2D - Repaired", repaired_from: "original-special", fresh: true }],
      state: { files: [{ kind: "lobby", applied: "mod:special-day", official: false, restorable: true, crc: "fixed" }] } };
    family = { key: "arona", version: "special", variants: [modFamily().variants[0], v] };
    const start = playerRequests.length, fetchStart = assetRequests.length, rpcStart = rpcRequests.length;
    let ready = false;
    const showing = Detail.show(context, family, v.key).then(() => { ready = true; }); await flush();
    t.mock.timers.tick(1300); await flush();
    assert.equal(ready, false, "a pending background cannot release the loading cover early");
    await finish(t, showing);
    assert.equal(Detail.currentVariant(), v.key, "the requested background stays selected alongside a portrait variant");
    assert.equal(switchButton().getAttribute("aria-label"), "Switch L2D");
    assert.ok(switchButton().listeners.click.length);
    for (const path of [`${INFO}/Title_Bg/Label_Locale`, "RightInfo/Target/Active/CharacterTab/Tab_2/Tab_On/Label"]) {
      assert.ok(walk(hosts.ngui).some((e) => e.dataset.path?.endsWith(path) && walk(e).some((n) => n.textContent === "L2D")), `${path} uses the L2D label`);
    }
    const add = walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up/BG (1)`);
    assert.equal(add.getAttribute("aria-label"), "Add L2D");
    assert.ok(add.listeners.click.length);
    assert.ok(!walk(hosts.ngui).some((e) => e.dataset.part?.endsWith("Tab_1/Tab_Off/Label")), "there is no portrait tab hit target");
    assert.ok(assetRequests.slice(fetchStart).some((url) => url.includes(`/lobby/${core}/`)));
    assert.ok(!playerRequests.slice(start).some((url) => url.includes("/spr/")), "no missing portrait player is started");
    assert.equal(hosts.lobby.querySelector(".lobby-unavailable")?.textContent, "Preview unavailable");
    assert.ok(!hosts.lobby.classList.contains("pending"));
    assert.equal(switchButton().getAttribute("aria-label"), "Switch L2D");
    assert.ok(switchButton().listeners.click.length, "apply and restore still have a switch card");
    assert.ok(!rpcRequests.slice(rpcStart).some((r) => r.method === "lobby.lines"));
    assert.equal(tabDot(2), undefined); assert.equal(chipDot(v.key), undefined);
    assert.ok(rpcRequests.slice(rpcStart).some((r) => r.method === "mods.seen"), "showing the configured asset's tab marks it seen");
    await switchButton().click(); await flush();
    assert.deepEqual(rpcRequests.filter((r) => r.method === "mods.seen").at(-1).params, { ids: ["special-day"] });
    assert.equal(tabDot(2), undefined); assert.equal(chipDot(v.key), undefined);
    const part = (path) => walk(hosts.popup).find((el) => el.dataset.path === path);
    assert.equal(part("Details/Name").getAttribute("aria-label"), "Painted L2D - Repaired");
    assert.equal(part("Card_m:special-day/Tag/Text").textContent, "Repaired");
    assert.ok(walk(hosts.popup).some((el) => el.dataset.action === "alias:details"));
    await walk(hosts.popup).find((el) => el.dataset.action === "alias:m:special-day").click(); await flush();
    assert.equal(aliasInput().value, "Painted L2D - Repaired");
    aliasInput().value = "Evening L2D";
    await finish(t, aliasKey(aliasInput()));
    assert.equal(part("Details/Name").getAttribute("aria-label"), "Evening L2D");
    assert.equal(part("Card_m:special-day/Tag/Text").textContent, "Repaired");
    assert.equal(walk(part("Details/Chip_0/Text/Text")).map((el) => el.textContent).join(""), "Repaired");
    assert.ok(!walk(hosts.popup).some((el) => el.getAttribute("aria-label") === "Remap to current version"));
    await closeSwitch();
    back.onclick(); assert.equal(location.hash, "#/roster");
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("NGUI logs missing atlas metadata and keeps placeholder geometry for controls", async () => {
  errors.length = 0;
  const host = new El();
  const tree = node("Missing"); tree.widgets[0].sprite = "MissingSprite";
  const view = await NGUI.render(tree, host, { deferImages: true });
  await Promise.all(view.pictures);
  assert.equal(view.nodes.get("Missing").els.length, 2);
  assert.ok(errors.some((a) => a.some((e) => String(e).includes("Missing sprite Common/MissingSprite"))));
});

test("a lobby player setup exception settles its layer instead of hanging Lobby.show", async () => {
  const Lobby = await import("../../src/ba_modding_toolkit/web/js/lobby.js");
  try {
    errors.length = 0; lobbyMode = "ready"; playerMode = "broken";
    await assert.rejects(Lobby.show("ibuki_home", hosts.lobby, "ibuki"), /Mod skeleton setup failed/);
    assert.ok(errors.some((a) => a[0] === "Lobby player setup failed"));
  } finally { Lobby.hide(hosts.lobby); lobbyMode = "pending"; playerMode = "ready"; }
});

for (const mode of ["pending", "error", "empty", "partial", "invalid"]) test(`panels survive a ${mode} atlas index, report it and retry`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; indexMode = mode;
    const Renderer = await import(`../../src/ba_modding_toolkit/web/js/ngui.js?index=${mode}`);
    const host = new El();
    const view = await Renderer.render(node("Panel"), host, { deferImages: true });
    assert.equal(view.nodes.get("Panel").els[0].style.backgroundColor, "#ffffff");
    await flush();
    t.mock.timers.tick(15000); await flush(); await Promise.all(view.pictures);
    const cause = mode === "pending" ? "timed out" : mode === "error" ? "HTTP 500"
      : mode === "partial" ? "Missing sprite Common/Common_Bg_Raius10px" : "empty or invalid atlas index";
    assert.ok(errors.some((a) => a.some((e) => String(e).includes(cause))));
    indexMode = "ready";
    const retry = await Renderer.render(node("Panel"), new El(), { deferImages: true });
    await Promise.all(retry.pictures);
    assert.ok(retry.nodes.get("Panel").els[0].style.backgroundImage);
  } finally { indexMode = "ready"; await flush(); t.mock.timers.reset(); }
});

for (const configured of ["mod:configured", "variant:dress"]) test(`mods off keeps the configured portrait source ${configured}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    modsEnabled = false; await ModSwitch.refresh();
    family = modFamily("spr", "configured");
    const v = family.variants[0];
    delete v.lobby;
    v.state.files[0].applied = "official"; v.state.files[0].official = true;
    v.configured = { spr: configured };
    family.variants.push({ key: "dress", spr: "dress_spr", names: v.names });
    const start = playerRequests.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    const requested = playerRequests.slice(start);
    const source = configured.startsWith("mod:") ? "/mod/configured/" : "/official-spr/dress_spr/";
    assert.ok(requested.some((url) => url.includes(source)), source);
    assert.ok(requested.every((url) => !url.includes("/spr/ibuki_spr/")), "current official files do not replace the configured preview");
    assert.ok(requested.every((url) => url.includes(`/${"a".repeat(64)}/`)), "all players use revisioned assets");
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); await flush(); t.mock.timers.reset(); }
});

test("NGUI image callbacks have a deadline and a later request can retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    imageMode = "pending";
    const failed = assert.rejects(NGUI.load("/asset/ui/stuck.png"), /timed out/);
    t.mock.timers.tick(15000); await failed;
    imageMode = "ready";
    assert.ok(await NGUI.load("/asset/ui/stuck.png"));
    pendingImages.splice(0).forEach((img) => img.onload?.());
  } finally { imageMode = "ready"; await flush(); t.mock.timers.reset(); }
});

test("long portrait and lobby names only resize their own info cell in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const paths = ["Label_Life/Data_Widget/Data", "Label_Attact/Data_Widget/Data", "Label_Defense/Data", "Label_Healing/Data_Widget/Data"];
  const cell = (path) => walk(hosts.ngui).find((el) => el.dataset.path?.endsWith(`${INFO}/Status/${path}`) && el.style.fontSize);
  const size = (str, fs) => `${(NGUI.fontSizeFor(str, fs) * 1920 / 2960).toFixed(2)}px`;
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      setStrings(lang, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"))));
      for (const kind of ["spr", "lobby"]) {
        const snapshots = [];
        for (const name of ["ibuki_spr", "azusa_swimsuit_spr", "azusa_swimsuit_spr".repeat(20), "ibuki_spr"]) {
          family = modFamily(kind, name);
          const v = family.variants[0];
          v.date = v.state.files[0].date = "2024-11-18";
          if (kind === "spr") delete v.lobby;
          const showing = Detail.show(context, family, "ibuki"); await flush();
          t.mock.timers.tick(16000); await flush(); await finish(t, showing);
          const lobbyTab = kind === "lobby" && walk(hosts.ngui).find((el) => el.dataset.part?.endsWith("Tab_2/Tab_Off/Label"));
          if (lobbyTab) {
            const switching = lobbyTab.click(); await flush();
            t.mock.timers.tick(16000); await flush(); await finish(t, switching);
          }
          const cells = paths.map(cell);
          assert.ok(cells.every(Boolean), `${lang} ${kind}: all four value cells render`);
          assert.equal(cells[0].getAttribute("aria-label"), name);
          assert.equal(cells[0].title, undefined);
          assert.equal(cells[0].style.pointerEvents, "none", "labels never intercept hover");
          assert.equal(cells[0].children[0].style.textOverflow, "ellipsis");
          assert.equal(cells[0].children[0].textContent, name, "the complete value is retained");
          assert.ok(parseFloat(cells[0].style.fontSize) >= parseFloat(size(name, 28)));
          if (name.length > 100) assert.equal(cells[0].style.fontSize, size(name, 28));
          const labels = paths.map((path) => cell(path.split("/")[0]).style.fontSize);
          snapshots.push({ current: cells[0].style.fontSize, others: cells.slice(1).map((el) => [el.getAttribute("aria-label"), el.style.fontSize]), labels });
          Detail.hide();
        }
        assert.ok(parseFloat(snapshots[1].current) < parseFloat(snapshots[0].current), `${lang} ${kind}: the long name fits on its own`);
        for (const snapshot of snapshots.slice(1)) {
          assert.deepEqual(snapshot.others, snapshots[0].others, `${lang} ${kind}: status, date and CRC keep their sizes`);
          assert.deepEqual(snapshot.labels, snapshots[0].labels, `${lang} ${kind}: labels keep their sizes`);
        }
        assert.equal(snapshots[3].current, snapshots[0].current, "returning to a short name restores its normal size");
      }
    }
  } finally {
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

const aliasKey = (input, extra = {}) => {
  const ev = { key: "Enter", preventDefault() {}, ...extra };
  return Promise.all(input.listeners.keydown.map((fn) => fn(ev)));
};
const aliasInput = () => hosts.dialog.querySelector(".alias-input");
const currentCell = () => walk(hosts.ngui).find((el) => el.dataset.path?.endsWith(`${INFO}/Status/Label_Life/Data_Widget/Data`) && el.style.fontSize);

test("student aliases lead the existing name band, keep the variant's original, and update on save and clear in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"));
      setStrings(lang, flat(ui));
      family = modFamily(); family.variants[0].custom = ["My <Ibuki> & friend", "Search nickname"];
      const base = structuredClone(family.variants[0]);
      base.custom = ["Original nickname"];
      family.variants[0].key = "ibuki_dress";
      family.variants.push(base);
      const original = "Ibuki (Dress) ".repeat(10);
      family.variants[0].names = { en: { full: original, short: "Dress" } };
      await showPortrait(t, "ibuki_dress");
      const part = (name) => walk(hosts.ngui).find((el) => el.dataset.path?.endsWith(`${PLATE}/${name}`) && el.style.fontSize);
      const main = part("Label_Name"), secondary = part("Label_OriginalName");
      assert.equal(main.getAttribute("aria-label"), family.variants[0].custom[0]);
      assert.equal(secondary.getAttribute("aria-label"), original);
      assert.ok(parseFloat(main.style.fontSize) > parseFloat(secondary.style.fontSize));
      const a = NGUI.rect(main), b = NGUI.rect(secondary);
      assert.ok(a[1] + a[3] <= b[1], "the two name lines do not overlap");
      assert.equal(secondary.children[0].style.textOverflow, "ellipsis");
      const pencil = () => walk(hosts.ngui).find((el) => el.tagName === "BUTTON" && el.getAttribute("aria-label")?.startsWith(ui.webui.alias.title));
      assert.ok(pencil().getAttribute("aria-label").includes("Search nickname"));
      await pencil().click(); await flush();
      hosts.popup.querySelectorAll(".alias-input")[0].value = "Changed name";
      const invalidated = invalidations;
      await walk(hosts.popup).find((el) => el.dataset.action === "ok").click(); await flush();
      assert.equal(part("Label_Name").getAttribute("aria-label"), "Changed name");
      assert.equal(rpcRequests.findLast((r) => r.method === "aliases.set").params.variant, "ibuki_dress");
      assert.deepEqual(base.custom, ["Original nickname"]);
      assert.equal(invalidations, invalidated + 1, "roster will reload aliases and name order");
      await pencil().click(); await flush();
      for (const input of hosts.popup.querySelectorAll(".alias-input")) input.value = "";
      await walk(hosts.popup).find((el) => el.dataset.action === "ok").click(); await flush();
      assert.equal(part("Label_Name").getAttribute("aria-label"), original);
      assert.equal(part("Label_OriginalName"), undefined);
      await showPortrait(t, "ibuki");
      assert.equal(part("Label_Name").getAttribute("aria-label"), "Original nickname");
      Detail.hide();
    }
  } finally {
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

test("variant aliases name detail chips, switch cards and variant picker cards in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const labelled = (host, caption) => walk(host).some((el) => el.style.fontSize &&
    (el.textContent === caption || el.getAttribute("aria-label") === caption));
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      setStrings(lang, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"))));
      family = modFamily();
      family.variants[0].custom = ["Base Ink"];
      family.variants.push(...Array.from({ length: 8 }, (_, i) => ({
        key: `skin_${i}`, spr: `skin_${i}_spr`, order: i + 1, recruitable: true, modList: [],
        custom: i === 0 ? ["Skin Ink"] : [], names: { en: { full: `Variant ${i}`, short: `Skin ${i}` } },
      })));
      await showPortrait(t);
      assert.ok(labelled(hosts["ngui-chips"], "Base Ink"), `${lang}: base chip`);
      assert.ok(labelled(hosts["ngui-chips"], "Skin Ink"), `${lang}: skin chip`);
      await switchButton().click(); await flush();
      assert.ok(labelled(hosts.popup, "Base Ink"), `${lang}: own switch card`);
      assert.ok(labelled(hosts.popup, "Skin Ink"), `${lang}: skin switch card`);
      const skin = walk(hosts.popup).find((el) => el.dataset.key === "v:skin_0");
      assert.ok(skin); await skin.click(); await flush();
      assert.equal(walk(hosts.popup).find((el) => el.dataset.path === "Details/Name").getAttribute("aria-label"), "Skin Ink");
      await closeSwitch();
      assert.ok(walk(hosts["ngui-chips"]).some((el) => el.dataset.path?.endsWith("/Chip_more")));
      await walk(hosts["ngui-chips"]).filter((el) => el.tagName === "BUTTON").at(-1).click(); await flush();
      assert.ok(labelled(hosts.picker, "Base Ink"), `${lang}: own picker card`);
      assert.ok(labelled(hosts.picker, "Skin Ink"), `${lang}: skin picker card`);
      const selected = walk(hosts.picker).find((el) => el.dataset.key === "skin_0");
      assert.ok(selected); await selected.click(); await flush();
      assert.equal(walk(hosts.picker).find((el) => el.dataset.path === "Details/Name").getAttribute("aria-label"), "Skin Ink");
      assert.ok(labelled(hosts.picker, "Skin 1"), "an unaliased sibling retains its original short name");
      Detail.hide();
    }
  } finally {
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

test("mod aliases save and clear from the current value and both switch pencils in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"));
      setStrings(lang, flat(ui));
      for (const kind of ["spr", "lobby"]) {
        family = modFamily(kind);
        const core = kind === "spr" ? "ibuki_spr" : "ibuki_home";
        Object.assign(family.variants[0].modList[0], { core, file: `/mods/test/${core}.bundle` });
        delete family.variants[0][kind === "spr" ? "lobby" : "spr"];
        await showPortrait(t);
        const pencil = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("/ModAliasBtn"));
        assert.equal(pencil.getAttribute("aria-label"), ui.webui.modAlias.title);
        await pencil.click(); await flush();
        const input = aliasInput(), start = rpcRequests.length;
        assert.equal(input.value, "");
        input.value = "Alias <paint> & colors";
        await aliasKey(input, { isComposing: true });
        await aliasKey(input, { keyCode: 229 });
        assert.equal(rpcRequests.length, start, "input method confirmation cannot save");
        await finish(t, aliasKey(input));
        assert.equal(hosts.dialog.hidden, true);
        assert.equal(currentCell().getAttribute("aria-label"), input.value);
        const original = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Data_Widget/OriginalName"));
        assert.equal(original.getAttribute("aria-label"), core);
        assert.ok(parseFloat(original.style.fontSize) < parseFloat(currentCell().style.fontSize));
        assert.deepEqual(rpcRequests.findLast((r) => r.method === "mods.rename").params, { id: "test", label: input.value });
        await switchButton().click(); await flush();
        const card = walk(hosts.popup).find((e) => e.dataset.action === "alias:m:test");
        const details = walk(hosts.popup).find((e) => e.dataset.action === "alias:details");
        assert.ok(card && details, `${lang} ${kind}: both names have pencils`);
        assert.equal(walk(hosts.popup).filter((e) => e.dataset.action?.startsWith("alias:")).length, 2, "official names have no pencil");
        assert.equal(walk(hosts.popup).find((e) => e.dataset.path === "Details/Name").getAttribute("aria-label"), input.value);
        assert.equal(walk(hosts.popup).find((e) => e.dataset.path === "Details/OriginalName").getAttribute("aria-label"), core);
        await card.click(); await flush();
        assert.equal(aliasInput().value, input.value);
        aliasInput().value = "";
        await finish(t, aliasKey(aliasInput()));
        assert.equal(currentCell().getAttribute("aria-label"), "test");
        assert.ok(!walk(hosts.ngui).some((e) => e.dataset.path?.endsWith("Data_Widget/OriginalName")));
        assert.equal(walk(hosts.popup).find((e) => e.dataset.path === "Details/Name").getAttribute("aria-label"), "test");
        assert.ok(!walk(hosts.popup).some((e) => e.dataset.path === "Details/OriginalName"));
        await walk(hosts.popup).find((e) => e.dataset.action === "alias:details").click(); await flush();
        assert.equal(aliasInput().value, "");
        await walk(hosts.dialog).find((e) => e.dataset.action === "cancel").click();
        assert.equal(hosts.popup.hidden, false, "cancel keeps the source picker open");
        await closeSwitch();
        Detail.hide();
      }
    }
  } finally {
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

test("an alias on another variant's mod replaces the entire display name", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily();
    const mod = family.variants[0].modList[0];
    Object.assign(mod, { alias: "Only alias", label: "Original name", core: "ibuki_dress_spr", target: "dress" });
    family.variants.push({ key: "dress", spr: "ibuki_dress_spr", names: { en: { full: "Ibuki Dress", short: "Dress" } }, modList: [] });
    await showPortrait(t);
    await switchButton().click(); await flush();
    const texts = walk(hosts.popup).filter((e) => e.style.fontSize).map((e) => e.textContent || e.children[0]?.textContent);
    assert.ok(texts.includes("Only alias"));
    assert.ok(!texts.some((s) => s?.includes("Dress - Only alias") || s?.includes("Original name")));
    assert.equal(walk(hosts.popup).find((e) => e.dataset.path === "Details/OriginalName").getAttribute("aria-label"), "ibuki_dress_spr");
    assert.equal(currentCell().getAttribute("aria-label"), "Only alias");
    assert.ok(!walk(hosts["ngui-chips"]).some((e) => e.dataset.path?.endsWith("/ModAliasBtn")), "variant chips show student names");
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("repaired names and own aliases keep a separate repair tag in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"));
      setStrings(lang, flat(ui));
      for (const enabled of [true, false]) for (const alias of ["", "Own alias"]) {
        modsEnabled = enabled;
        await ModSwitch.refresh();
        family = modFamily("spr", "fixed");
        const v = family.variants[0], mod = v.modList[0];
        const name = alias || ui.webui.remap.name.replace("{name}", "Painted");
        Object.assign(mod, { alias, label: name, repaired_from: "original" });
        v.modList.push({ id: "original", target: v.key, kind: "spr", alias: "Painted", label: "Painted", repaired_id: mod.id });
        v.configured = { spr: "mod:fixed" };
        v.selection = { spr: { source: "mod:fixed", installed: enabled } };
        await showPortrait(t);
        assert.equal(currentCell().getAttribute("aria-label"), name);
        await switchButton().click(); await flush();
        const part = (path) => walk(hosts.popup).find((el) => el.dataset.path === path);
        assert.equal(part("Details/Name").getAttribute("aria-label"), name);
        assert.equal(walk(part("Details/Chip_0/Text/Text")).map((el) => el.textContent).join(""), ui.webui.remap.repaired);
        assert.equal((part("Card_m:fixed/Tag/Text").textContent || part("Card_m:fixed/Tag/Text").children[0].textContent), ui.webui.remap.repaired);
        assert.ok(part("Card_m:fixed/Select/AppliedBadge"));
        assert.equal(part("Card_m:fixed/Select/Check"), undefined, "the badge sprite draws the only check");
        assert.equal((part("Card_m:fixed/Select/AppliedLabel").textContent || part("Card_m:fixed/Select/AppliedLabel").children[0].textContent), ui.webui.status.applied);
        assert.ok(walk(hosts.popup).find(el => el.dataset.key === "m:fixed").getAttribute("aria-label").includes(ui.webui.status.applied));
        assert.ok(walk(hosts.popup).some((el) => el.dataset.action === "alias:m:fixed"));
        assert.equal(walk(hosts.popup).filter((el) => el.getAttribute("aria-label") === ui.webui.act.update).length, 1);
        await closeSwitch();
        Detail.hide();
      }
    }
  } finally {
    modsEnabled = true;
    await ModSwitch.refresh();
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

for (const parentPresent of [true, false]) test(`a loaded repaired Mod relocalizes its name with its source ${parentPresent ? "present" : "removed"}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    setStrings("en-US", localeTable("en-US"));
    thumbMode = playerMode = "ready";
    family = modFamily("spr", "locale-repair");
    const v = family.variants[0], repaired = v.modList[0], sourceName = parentPresent ? "Source alias" : "Stored source";
    Object.assign(repaired, { repaired_from: "original", label_base: "Stored source",
      label: localeTable("en-US")["webui.remap.name"].replace("{name}", sourceName) });
    if (parentPresent) v.modList.push({ id: "original", target: v.key, kind: "spr", label: "Source alias", alias: "Source alias", repaired_id: repaired.id });
    v.previewSources = { spr: `mod:${repaired.id}` };
    await showPortrait(t); await switchButton().click(); await flush();
    const players = previewPlayers.length, before = rpcRequests.length;
    for (const alias of ["", "Own repaired alias"]) {
      repaired.alias = alias;
      for (const lang of ["ja-JP", "zh-CN", "en-US"]) {
        setStrings(lang, localeTable(lang)); await Detail.relabel(); await flush();
        const expected = alias || localeTable(lang)["webui.remap.name"].replace("{name}", sourceName);
        assert.equal(currentCell().getAttribute("aria-label"), expected);
        assert.equal(walk(hosts.popup).find((e) => e.dataset.path === "Details/Name").getAttribute("aria-label"), expected);
        assert.equal(previewPlayers.length, players);
      }
    }
    assert.ok(!rpcRequests.slice(before).some((r) => ["family.get", "roster.list"].includes(r.method)));
  } finally {
    Detail.hide(); thumbMode = "pending";
    setStrings("en-US", localeTable("en-US")); await flush(); t.mock.timers.reset();
  }
});

test("cancel, close, backdrop and Escape discard an alias draft without saving", async () => {
  const start = rpcRequests.length;
  for (const how of ["cancel", "close", "backdrop", "escape"]) {
    await ModAlias.open({ mod: { id: "test", alias: "Saved alias" }, onSaved: () => assert.fail("cancel cannot save") });
    aliasInput().value = "Draft";
    if (how === "escape") Popup.onKey({ key: "Escape", preventDefault() {} });
    else if (how === "backdrop") await walk(hosts.dialog).find((e) => e.dataset.path === "Center/BlackBg/BlackBgClickArea").click();
    else await walk(hosts.dialog).find((e) => e.dataset.action === how).click();
    assert.equal(hosts.dialog.hidden, true);
  }
  assert.equal(rpcRequests.length, start);
});

test("failed alias saves keep the draft, and repeated Enter submits once", async () => {
  let saved = null, resolve;
  try {
    renameReply = async () => ({ error: { code: "library_io_error", params: {} } });
    await ModAlias.open({ mod: { id: "test", alias: "Saved alias" }, onSaved: (m) => { saved = m; } });
    const input = aliasInput(); input.value = "Retry alias";
    await aliasKey(input);
    assert.equal(hosts.dialog.hidden, false);
    assert.equal(input.value, "Retry alias");
    assert.equal(input.disabled, false);
    assert.equal(saved, null);
    renameReply = () => new Promise((r) => { resolve = r; });
    const start = rpcRequests.length, pending = aliasKey(input);
    await aliasKey(input);
    assert.equal(rpcRequests.length - start, 1);
    resolve({ result: { id: "test", alias: input.value } });
    await pending;
    assert.equal(saved.alias, "Retry alias");
    assert.equal(hosts.dialog.hidden, true);
  } finally { ModAlias.close(); renameReply = saveAlias; }
});

test("leaving detail closes the mod alias editor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); await showPortrait(t);
    await walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("/ModAliasBtn")).click();
    assert.ok(aliasInput());
    Detail.hide();
    assert.equal(hosts.dialog.hidden, true);
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("new mod dots survive visits and tab changes, then clear for the switch's offered mods", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily();
    const v = family.variants[0];
    v.model = "ibuki_model";
    v.modList = ["spr", "lobby"].map((kind) => ({ id: kind, target: v.key, kind, fresh: true }));
    family.variants.push({ ...v, key: "dress", spr: "dress_spr", lobby: "dress_home", modList: [
      { id: "dress-spr", target: "dress", kind: "spr", fresh: true },
      { id: "dress-lobby", target: "dress", kind: "lobby", fresh: true },
    ] });
    const start = rpcRequests.length, invalidated = invalidations;
    await showPortrait(t);
    assert.ok(tabDot(1)); assert.ok(tabDot(2)); assert.equal(tabDot(3), undefined);
    assert.ok(switchDot(), "unapplied portrait assets mark the switch card");
    assert.ok(chipDot(v.key)); assert.ok(chipDot("dress"));
    assert.ok(rpcRequests.slice(start).every((r) => r.method !== "mods.seen"), "visiting leaves the marks alone");
    const switching = tabButton(2).click(); await flush();
    await finish(t, switching);
    assert.ok(tabDot(1)); assert.ok(tabDot(2), "selecting a tab leaves its mods new");
    const lobby = switchButton().click(); await flush(); await lobby;
    assert.equal(tabDot(2), undefined); assert.ok(tabDot(1)); assert.ok(chipDot(v.key));
    assert.deepEqual(rpcRequests.filter((r) => r.method === "mods.seen").at(-1).params, { ids: ["lobby"] });
    assert.equal(v.modList.find((m) => m.kind === "spr").fresh, true);
    await closeSwitch();
    const portrait = tabButton(1).click(); await flush();
    await finish(t, portrait);
    const popup = switchButton().click(); await flush(); await popup;
    assert.equal(tabDot(1), undefined); assert.equal(tabDot(2), undefined); assert.equal(chipDot(v.key), undefined);
    assert.ok(chipDot("dress"), "the other variant still has an unseen lobby mod");
    assert.deepEqual(rpcRequests.filter((r) => r.method === "mods.seen").at(-1).params, { ids: ["spr", "dress-spr"] });
    assert.equal(family.variants[1].modList[1].fresh, true);
    assert.equal(invalidations - invalidated, 2, "Back fetches the roster's updated marks immediately");
    await closeSwitch();
    const before = rpcRequests.filter((r) => r.method === "mods.seen").length;
    const again = switchButton().click(); await flush(); await again;
    assert.equal(rpcRequests.filter((r) => r.method === "mods.seen").length, before, "seen mods need no further state writes");
    await closeSwitch();
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const kind of ["spr", "portrait", "lobby"]) for (const enabled of [true, false]) test(`opening the ${kind} result tab sees the ${enabled ? "applied" : "configured"} import without opening its switch`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const assetKind = kind === "portrait" ? "spr" : kind;
    family = modFamily(assetKind, `import-${assetKind}`);
    const v = family.variants[0], imported = v.modList[0];
    imported.fresh = true; v.fresh = true;
    v.configured = { [assetKind]: `mod:${imported.id}` };
    if (!enabled) Object.assign(v.state.files[0], { applied: "official", official: true });
    modsEnabled = enabled; await ModSwitch.refresh();
    const invalidated = invalidations, start = rpcRequests.length;
    const showing = Detail.show(context, family, v.key, { kind }); await flush(); await finish(t, showing); await flush();
    const tabNumber = assetKind === "lobby" ? 2 : 1;
    assert.equal(tabButton(tabNumber), undefined, "the requested asset tab is active immediately");
    assert.equal(tabDot(tabNumber), undefined); assert.equal(chipDot(v.key), undefined); assert.equal(switchDot(), undefined);
    assert.equal(imported.fresh, false); assert.equal(v.fresh, false);
    assert.deepEqual(rpcRequests.slice(start).filter((r) => r.method === "mods.seen").map((r) => r.params), [{ ids: [imported.id] }]);
    assert.equal(invalidations, invalidated + 1, "returning to the roster refreshes its cleared mark");
    assert.equal(hosts.popup.hidden, true);
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); await flush(); t.mock.timers.reset(); }
});

for (const kind of ["spr", "lobby"]) test(`an auto-applied ${kind} mod has no card dot when another source is picked`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(kind); family.variants[0].modList[0].fresh = true;
    family.variants[0].configured = { [kind]: "mod:test" };
    family.variants[0].selection = { [kind]: { source: "mod:test", installed: true } };
    seenReply = async () => ({ error: { code: "internal" } });
    await showPortrait(t);
    const tab = kind === "lobby" ? 2 : 1;
    if (tab === 2) {
      const switching = tabButton(tab).click(); await flush(); await finish(t, switching);
    }
    assert.ok(tabDot(tab)); assert.ok(chipDot("ibuki"));
    assert.equal(switchDot(), undefined, "applied assets never mark the switch card");
    const popup = switchButton().click(); await flush(); await popup;
    const own = walk(hosts.popup).find((e) => e.dataset.key === "self");
    assert.ok(own); await own.click(); await flush();
    assert.ok(walk(hosts.popup).some((e) => e.dataset.path?.endsWith("Card_m:test/Select/AppliedBadge")));
    assert.equal(walk(hosts.popup).find((e) => e.dataset.path?.match(/Card_m:test\/(?:Dot|NewIcon)$/)), undefined);
    assert.ok(tabDot(tab)); assert.ok(chipDot("ibuki"), "card rendering leaves the unread marks intact");
    await closeSwitch();
  } finally { Detail.hide(); seenReply = async () => ({ result: null }); await flush(); t.mock.timers.reset(); }
});

test("a failed seen write keeps the dots and can be retried by opening the mod card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].modList[0].fresh = true;
    seenReply = async () => ({ error: { code: "internal" } });
    await showPortrait(t);
    const popup = switchButton().click(); await flush(); await popup;
    assert.ok(tabDot(1)); assert.ok(chipDot("ibuki"));
    seenReply = async () => ({ result: null });
    const card = walk(hosts.popup).find((e) => e.dataset.key === "m:test");
    assert.ok(card);
    await card.click(); await flush();
    assert.equal(tabDot(1), undefined); assert.equal(chipDot("ibuki"), undefined);
    await closeSwitch();
  } finally { Detail.hide(); seenReply = async () => ({ result: null }); await flush(); t.mock.timers.reset(); }
});

for (const after of ["closed", "aliases", "reopened", "left"]) test(`a delayed seen save respects a switch that was ${after}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  try {
    family = modFamily(); family.variants[0].modList[0].fresh = true;
    Object.assign(family.variants[0].state.files[0], { applied: "official", official: true });
    await showPortrait(t);
    seenReply = () => new Promise((resolve) => { finish = resolve; });
    const start = rpcRequests.length, invalidated = invalidations;
    const popup = switchButton().click(); await flush();
    assert.ok(finish, "the switch shows while its seen state is being saved");
    assert.ok(walk(hosts.popup).some((e) => e.dataset.key === "m:test"));
    assert.ok(walk(hosts.popup).some((e) => e.dataset.path?.match(/Card_m:test\/(?:Dot|NewIcon)$/)));
    assert.ok(tabDot(1));
    await closeSwitch();
    let input;
    if (after === "aliases") {
      const pencil = walk(hosts.ngui).find((e) => e.getAttribute("aria-label") === "Aliases");
      assert.ok(pencil);
      await pencil.click(); await flush();
      input = hosts.popup.querySelector(".alias-input");
      assert.ok(input);
      input.value = "Draft alias";
    } else if (after === "reopened") {
      await switchButton().click(); await flush();
    } else if (after === "left") Detail.hide();
    finish({ result: null }); await popup; await flush();
    assert.equal(invalidations - invalidated, 1);
    assert.equal(family.variants[0].modList[0].fresh, false);
    assert.equal(rpcRequests.slice(start).filter((r) => r.method === "mods.seen").length, 1);
    if (after === "aliases") {
      assert.equal(hosts.popup.querySelector(".alias-input"), input, "the alias editor keeps its unsaved input");
      assert.equal(input.value, "Draft alias");
    } else if (after === "reopened") {
      assert.equal(hosts.popup.hidden, false);
      assert.ok(walk(hosts.popup).some((e) => e.dataset.key === "m:test"));
      assert.equal(walk(hosts.popup).find((e) => e.dataset.path?.match(/Card_m:test\/(?:Dot|NewIcon)$/)), undefined);
    } else {
      assert.equal(hosts.popup.hidden, true);
      assert.equal(hosts.popup.children.length, 0);
    }
    if (after !== "left") { assert.equal(tabDot(1), undefined); assert.equal(chipDot("ibuki"), undefined); }
  } finally { finish?.({ result: null }); Detail.hide(); seenReply = async () => ({ result: null }); await flush(); t.mock.timers.reset(); }
});

test("the 3D tab dot only follows mods of its own kind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily("model");
    family.variants[0].model = "ibuki_model";
    family.variants[0].modList[0].fresh = true;
    await showPortrait(t);
    assert.equal(tabDot(1), undefined); assert.equal(tabDot(2), undefined);
    assert.ok(tabDot(3)); assert.ok(chipDot("ibuki"));
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("the detail portrait resumes focus and rebuilds after a hidden context loss", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; family = modFamily(); playerMode = thumbMode = "ready";
    await showPortrait(t);
    const p = previewPlayers.at(-1), count = previewPlayers.length;
    const failStart = rpcRequests.filter((r) => r.method === "preview.failed").length;
    window.dispatchEvent(new Event("blur")); assert.equal(p.stopRequestAnimationFrame, true);
    t.mock.timers.tick(60000); await flush();
    window.dispatchEvent(new Event("focus")); await flush(); assert.equal(p.stopRequestAnimationFrame, false);
    const lost = new Event("webglcontextlost", { cancelable: true }); p.canvas.dispatchEvent(lost);
    assert.equal(lost.defaultPrevented, true);
    document.hidden = true; documentEvents.dispatchEvent(new Event("visibilitychange"));
    p.config.error(p, "Context lost"); p.canvas.dispatchEvent(new Event("webglcontextrestored"));
    await flush(); assert.equal(previewPlayers.length, count, "no GPU rebuild while the page is hidden");
    document.hidden = false; documentEvents.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(previewPlayers.length, count + 1); assert.equal(p.disposed, true);
    assert.equal(previewPlayers.at(-1).config.skeleton, p.config.skeleton);
    assert.equal(rpcRequests.filter((r) => r.method === "preview.failed").length, failStart);
    p.canvas.dispatchEvent(new Event("webglcontextrestored")); await flush();
    assert.equal(previewPlayers.length, count + 1, "a disposed portrait cannot restart again");
  } finally { document.hidden = false; Detail.hide(); thumbMode = "pending"; await flush(); t.mock.timers.reset(); }
});

test("detail action patterns follow their resized bodies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily();
    await showPortrait(t);
    const part = (path) => walk(hosts.ngui).find((e) => e.dataset.path?.endsWith(path));
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} != ${b}`);
    const scale = 1920 / 2960;
    for (const card of ["SkillData_EX", "SkillData_EX (1)", "SkillData_EX (2)", "SkillData_EX (3)"]) {
      const base = `${INFO}/Skill/${card}/Bg`, body = part(base), corner = part(`${base}/Corner`);
      const num = (el, key) => parseFloat(el.style[key]);
      near(num(body, "left") + num(body, "width") - num(corner, "left") - num(corner, "width"), 3 * scale);
      near(num(corner, "top") - num(body, "top"), 4 * scale);
      near(num(corner, "width"), 20 * scale);
      near(num(corner, "height"), 10 * scale);
    }
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const background of ["/asset/art/bg/Original_Collection", null]) test(`the portrait switch keeps the prefab card without ${background ? "the student's" : "the prefab's"} artwork under its bust`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].bg = background;
    await showPortrait(t);
    const bust = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Normal/Bust"));
    assert.ok(!bust.style.backgroundImage, "no background picture on the portrait card");
    assert.equal(bust.children.length, 1, "the portrait thumbnail draws above the card artwork");
    assert.ok(bust.children[0].style.maskImage.includes("#000 70%"));
    const screen = walk(hosts["ngui-bg"]).find((e) => e.dataset.path?.endsWith("/BG"));
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const core of ["ibuki_home", "arona_workpage_daytime", "np0032_npc"]) test(`the ${core} switch continues its still's colours through the text area`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; warnings.length = 0; lobbyMode = "ready"; playerMode = "lobby-ready";
    family = modFamily("lobby");
    const v = family.variants[0];
    v.bg = "/asset/art/bg/Portrait_Only";
    if (core !== "ibuki_home") { v.key = `special:${core}`; v.spr = null; v.lobby = core; }
    const showing = Detail.show(context, family, v.key); await flush(); await finish(t, showing);
    if (tabButton(2)) { const switching = tabButton(2).click(); await flush(); await finish(t, switching); }
    const bust = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Normal/Bust"));
    assert.ok(bust.children[0].style.backgroundImage?.startsWith('url("blob:'), "a generated lobby still fills the thumbnail");
    assert.ok(bust.style.backgroundImage?.includes("rgb(20.000, 40.000, 60.000)"), `the text area takes the still's edge colours: ${errors.flat().join(" ")}`);
    assert.ok(bust.style.backgroundImage.includes("rgb(239.000, 243.000, 247.000) 100%"));
    assert.ok(!bust.style.backgroundImage.includes("Portrait_Only"));
    const text = walk(hosts.ngui).find((e) => e.className === "switch-text");
    assert.equal(text.style.color, "#000000");
    assert.ok(!warnings.some((args) => args[0] === "Switch card colours unavailable"));
  } finally { Detail.hide(); lobbyMode = "pending"; playerMode = "ready"; await flush(); t.mock.timers.reset(); }
});

test("re-entering a torn-down lobby rebuilds its players and keeps the Portrait tab usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    lobbyMode = "ready"; playerMode = "lobby-ready"; family = modFamily("lobby", "route-recovery");
    await showPortrait(t);
    const switching = tabButton(2).click(); await flush(); await finish(t, switching);
    const before = previewPlayers.filter((p) => !p.disposed);
    assert.ok(before.length); assert.equal(hosts.lobby.hidden, false);
    Detail.hide();
    assert.equal(Detail.currentVariant(), null); assert.ok(before.every((p) => p.disposed));
    const requests = playerRequests.length;
    const returning = Detail.show(context, family, "ibuki"); await flush(); await finish(t, returning);
    assert.ok(playerRequests.length > requests, "the same variant gets fresh lobby players after hide");
    assert.equal(hosts.lobby.hidden, false); assert.equal(Detail.currentVariant(), "ibuki");
    const portrait = tabButton(1).click(); await flush(); await finish(t, portrait);
    t.mock.timers.tick(360); await flush();
    assert.equal(hosts.portrait.hidden, false); assert.equal(hosts.lobby.hidden, true);
  } finally { Detail.hide(); lobbyMode = "pending"; playerMode = "ready"; await flush(); t.mock.timers.reset(); }
});

for (const kind of ["portrait", "lobby", "model"]) test(`repeated locale changes preserve the active ${kind} player and route`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily("spr", `locale-${kind}`);
    family.variants[0].model = "ibuki_model";
    family.variants[0].names.ja = { full: "Localized Ibuki", short: "Localized" };
    lobbyMode = "ready"; playerMode = "lobby-ready"; thumbMode = "ready";
    const showing = Detail.show(context, family, "ibuki", { kind }); await flush(); await finish(t, showing);
    const players = previewPlayers.filter((p) => !p.disposed), modelCount = modelRequests.length;
    const liveCount = previewPlayers.length, before = rpcRequests.length, hash = location.hash;
    const canvases = hosts[kind].children.slice();
    for (const lang of ["ja-JP", "en-US", "ja-JP"]) {
      setStrings(lang, localeTable(lang));
      await Detail.relabel(); await flush();
      assert.equal(previewPlayers.length, liveCount, "localization cannot create a new live Spine player");
      assert.equal(modelRequests.length, modelCount, "localization cannot reload a model");
      assert.ok(players.every((p) => !p.disposed));
      assert.deepEqual(hosts[kind].children, canvases, "the media DOM remains mounted");
      assert.equal(hosts[kind].hidden, false); assert.equal(location.hash, hash);
      const apply = walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Skill/SkillData_EX (3)/Bg`);
      assert.ok(apply, "the existing action remains available");
      assert.equal(apply.attrs["aria-label"], localeTable(lang)["webui.popup.apply"]);
    }
    assert.ok(!rpcRequests.slice(before).some((r) => ["roster.list", "family.get", "ui.visit"].includes(r.method)), "locale refresh reuses loaded family data");
    if (kind === "lobby") assert.equal(rpcRequests.filter((r) => r.method === "lobby.lines").at(-1).params.lang, "ja");
  } finally {
    Detail.hide(); lobbyMode = "pending"; playerMode = "ready"; thumbMode = "pending";
    setStrings("en-US", localeTable("en-US")); await flush(); t.mock.timers.reset();
  }
});

test("an open source picker relabels while keeping its unsaved selection and scroll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily("spr", "localized-picker");
    family.variants[0].previewSources = { spr: "official" };
    thumbMode = playerMode = "ready";
    await showPortrait(t);
    await switchButton().click(); await flush();
    await walk(hosts.popup).find((e) => e.dataset.key === "m:localized-picker").click(); await flush();
    hosts.popup.querySelector(".popup-cards").scrollLeft = 185;
    const players = previewPlayers.length;
    setStrings("ja-JP", localeTable("ja-JP"));
    await Detail.relabel(); await flush();
    assert.equal(hosts.popup.querySelector(".popup-cards").scrollLeft, 185);
    const save = walk(hosts.popup).find((e) => e.dataset.action === "ok");
    assert.equal(save.getAttribute("aria-label"), localeTable("ja-JP")["webui.popup.save"]);
    assert.equal(previewPlayers.length, players);
    await finish(t, save.click());
    assert.equal(family.variants[0].previewSources.spr, "mod:localized-picker");
  } finally {
    Detail.hide(); thumbMode = "pending";
    setStrings("en-US", localeTable("en-US")); await flush(); t.mock.timers.reset();
  }
});


for (const enabled of [true, false]) test(`model switching reuses the detail controls and previews its source with mods ${enabled ? "on" : "off"}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0;
    family = modFamily("model");
    const v = family.variants[0];
    v.model = "ibuki_model";
    v.configured = { model: "mod:test" };
    v.selection = { model: { source: "mod:test", installed: enabled } };
    v.modList[0].fresh = true;
    if (!enabled) v.state.files = [{ kind: "model", applied: "official", official: true, restorable: true, crc: "ok" }];
    modsEnabled = enabled; await ModSwitch.refresh();
    await showPortrait(t);
    const switching = tabButton(3).click();
    for (let i = 0; i < 20; i++) { await new Promise(setImmediate); await flush(); }
    await finish(t, switching);
    assert.equal(modelRequests.at(-1)?.key, "ibuki", errors.map((args) => args.map(String).join(" ")).join("\n"));
    assert.equal(modelRequests.at(-1).source, "mod:test");
    assert.ok(switchButton(), "the model switch opens the shared popup");
    const add = walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up/BG (1)`);
    assert.ok(add && add.getAttribute("aria-label") === "Add 3D Model");
    const text = walk(hosts.ngui).find((e) => e.className === "switch-text");
    assert.ok(text.children.some((e) => e.className === "switch-go"));
    assert.ok(text.children.some((e) => e.innerText?.startsWith("test - ")));
    assert.equal(tabDot(3), undefined, "showing the model tab marks its configured asset seen");
    assert.equal(v.fresh, false);
    await switchButton().click(); await flush();
    assert.ok(walk(hosts.popup).some((e) => e.dataset.key === "self"));
    assert.ok(walk(hosts.popup).some((e) => e.dataset.key === "m:test"));
    const picture = (host, path) => walk(host).find((e) => e.dataset.path === path)?.children[0].style.backgroundImage;
    for (let i = 0; i < 5; i++) { await new Promise(setImmediate); await flush(); }
    const original = picture(hosts.popup, "Card_self/Thumb"), mod = picture(hosts.popup, "Card_m:test/Thumb");
    assert.match(original, /blob:rendered-.*source=official/);
    assert.match(mod, /blob:rendered-.*source=mod%3Atest/);
    assert.equal(picture(hosts.popup, "Details/Picture/Thumb"), mod);
    const switchImage = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("/Bust") && e.children[0]?.style.backgroundImage?.includes("blob:rendered"));
    assert.equal(switchImage?.children[0].style.backgroundImage, mod, "detail and popup share the source's 3D still");
    const info = walk(hosts.popup).find((e) => e.dataset.path === "Details/Picture/Thumb");
    assert.equal(info.style.width, info.style.height, "the model info preview is square");
    assert.equal(tabDot(3), undefined, "opening the model switch marks its offered mods seen");
    assert.equal(v.modList[0].fresh, false);
    assert.ok(!errors.flat().some((e) => String(e).includes("Spine source unavailable")));
    await closeSwitch();
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); await flush(); t.mock.timers.reset(); }
});

test("detail action cards remove skill bases and plus badges and contain their replacement icons", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); await showPortrait(t);
    for (const card of ["SkillData_EX", "SkillData_EX (1)", "SkillData_EX (2)", "SkillData_EX (3)"]) {
      const prefix = `${INFO}/Skill/${card}/Normal/SkillIconBg`;
      const picture = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith(`${prefix}/Texture`));
      assert.ok(picture); assert.equal(picture.style.width, picture.style.height); assert.equal(picture.style.backgroundSize, "contain");
      assert.ok(!walk(hosts.ngui).some((e) => e.dataset.path?.endsWith(prefix)));
      assert.ok(!walk(hosts.ngui).some((e) => e.dataset.path?.endsWith(`${prefix}/Deco`)), "action icons have no decoration ring");
      assert.ok(!walk(hosts.ngui).some((e) => e.dataset.path?.includes(`${prefix}/Bg_Skill_Plus`)));
      assert.ok(!walk(hosts.ngui).some((e) => e.dataset.path?.includes(`${prefix}/SkillIconBg (1)`)));
    }
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});


test("switch subtitles retain the selected name and use a plain separator in all six locales", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"));
      setStrings(lang, flat(ui));
      for (const installed of [false, true]) {
        family = modFamily("spr", "hina_spr");
        const v = family.variants[0];
        v.configured = { spr: "mod:hina_spr" };
        v.selection = { spr: { source: "mod:hina_spr", installed } };
        await showPortrait(t);
        const text = walk(hosts.ngui).find((e) => e.className === "switch-text");
        const subtitle = text.children.find((e) => e.tagName === "SPAN").innerText.replace(/\n/g, "");
        assert.equal(subtitle, `hina_spr - ${ui.webui.status.applied}`);
        assert.ok(!/[·•・]/u.test(subtitle));
        Detail.hide();
      }
    }
  } finally {
    Detail.hide(); await flush(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

test("a failed portrait capture keeps the shared placeholder and reports the exact source and frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    thumbMode = "ready"; blankThumbnailCore = "pajamas_missing_spr";
    family = modFamily();
    family.variants.push({ key: "pajamas", spr: blankThumbnailCore,
      portrait: "/asset/art/portrait/pajamas", names: { en: { full: "Ibuki (Pajamas)", short: "Pajamas" } }, modList: [], state: { files: [] } });
    const v = family.variants[0];
    v.portrait = "/asset/art/portrait/original";
    v.configured = { spr: "variant:pajamas" };
    v.selection = { spr: { source: "variant:pajamas", installed: false } };
    await showPortrait(t);
    await switchButton().click(); await flush();
    const picture = (path) => walk(hosts.popup).find((e) => e.dataset.path === path).children[0].style.backgroundImage;
    assert.equal(picture("Card_v:pajamas/Thumb"), undefined);
    for (const path of ["Card_v:pajamas/Thumb/Placeholder", "Details/Picture/Texture/Placeholder"]) {
      const note = walk(hosts.popup).find((e) => e.dataset.path === path);
      assert.ok(note?.textContent); assert.equal(note.hidden, false);
    }
    assert.ok(errors.some((args) => args[0] === "Preview failed" && args[1].url.includes("official-spr/pajamas_missing_spr/")
      && args[1].step === "thumbnail:portrait" && args[1].error.includes("No visible pixels")));
    assert.equal(picture("Details/Picture/Texture"), picture("Card_v:pajamas/Thumb"));
    await closeSwitch();
  } finally {
    Detail.hide(); blankThumbnailCore = ""; thumbMode = "pending"; await flush(); t.mock.timers.reset();
  }
});


test("a failed Mod portrait never displays the variant's official collection art", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    thumbMode = "ready"; blankThumbnailCore = "/mod/test/"; portraitRevision = "f";
    family = modFamily();
    const v = family.variants[0]; v.portrait = "/asset/art/portrait/official-hina";
    v.configured = { spr: "mod:test" };
    await showPortrait(t); await switchButton().click(); await flush();
    for (const path of ["Card_m:test/Thumb", "Details/Picture/Texture"]) {
      const preview = walk(hosts.popup).find((e) => e.dataset.path === path);
      assert.equal(preview.children[0].style.backgroundImage, undefined);
      assert.equal(walk(hosts.popup).find((e) => e.dataset.path === `${path}/Placeholder`).hidden, false);
    }
    assert.ok(playerRequests.some((url) => url.includes("/mod/test/")));
    await closeSwitch();
  } finally { Detail.hide(); blankThumbnailCore = ""; thumbMode = "pending"; portraitRevision = "a"; await flush(); t.mock.timers.reset(); }
});

test("switch and detail captures can recover after the detail thumbnail reveal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].spr = "popup_after_deadline_spr";
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(15000); await flush(); await showing;
    const detailPictures = walk(hosts.ngui).filter((e) => e.dataset.thumbnail === "true");
    assert.ok(detailPictures.length);
    const before = thumbnailPlayers.length;
    thumbMode = "ready";
    await switchButton().click(); await flush();
    assert.ok(thumbnailPlayers.length > before, "popup owns a fresh capture scope");
    for (const path of ["Card_self/Thumb", "Details/Picture/Texture"]) {
      assert.ok(walk(hosts.popup).find((e) => e.dataset.path === path).children[0].style.backgroundImage);
      assert.equal(walk(hosts.popup).find((e) => e.dataset.path === `${path}/Placeholder`), undefined);
    }
    pendingThumbnails.splice(0).forEach((done) => done()); await flush();
    const captures = thumbnailPlayers.length;
    t.mock.timers.tick(60000); await flush();
    assert.equal(thumbnailPlayers.length, captures, "background retries wait while the switch popup owns the renderer");
    await closeSwitch();
    t.mock.timers.tick(2000); await flush();
    assert.ok(detailPictures.every((e) => e.style.backgroundImage), "page pictures resume after the popup closes, even after the reveal deadline");
  } finally { Detail.hide(); thumbMode = "pending"; await flush(); t.mock.timers.reset(); }
});

test("a timed-out switch candidate logs its source and updates both card and panel after an idle retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily();
    family.variants.push({ key: "swimsuit", spr: "hina_swimsuit_retry_spr",
      names: { en: { full: "Hina (Swimsuit)", short: "Swimsuit" } }, modList: [], state: { files: [] } });
    family.variants[0].configured = { spr: "variant:swimsuit" };
    await showPortrait(t);
    const start = rpcRequests.length;
    await switchButton().click(); await flush();
    const paths = ["Card_v:swimsuit/Thumb", "Details/Picture/Texture"];
    const element = (path) => walk(hosts.popup).find((e) => e.dataset.path === path);
    for (const path of paths) assert.ok(element(`${path}/Placeholder`));
    t.mock.timers.tick(15000); await flush();
    assert.ok(rpcRequests.slice(start).some((r) => r.method === "preview.failed"
      && r.params.url.includes("hina_swimsuit_retry_spr") && /timed out/.test(r.params.error)));
    thumbMode = "ready";
    pendingThumbnails.splice(0).forEach((done) => done()); await flush();
    t.mock.timers.tick(2000); await flush();
    for (const path of paths) {
      assert.ok(element(path).children[0].style.backgroundImage, path);
      assert.equal(element(`${path}/Placeholder`), undefined, path);
    }
    assert.equal(element(paths[0]).children[0].style.backgroundImage, element(paths[1]).children[0].style.backgroundImage);
    await closeSwitch();
  } finally { Detail.hide(); thumbMode = "pending"; await flush(); t.mock.timers.reset(); }
});

for (const enabled of [false, true]) test(`Save changes only the preview and both Apply buttons follow intent with Mods ${enabled ? "on" : "off"}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    thumbMode = playerMode = imageMode = decodeMode = "ready";
    family = modFamily();
    const v = family.variants[0]; v.configured = {}; v.previewSources = { spr: "official" };
    modsEnabled = enabled; await ModSwitch.refresh();
    await showPortrait(t);
    const before = structuredClone(v.state.files), start = rpcRequests.length;
    await switchButton().click(); await flush();
    await walk(hosts.popup).find((e) => e.dataset.key === "m:test").click(); await flush();
    const save = walk(hosts.popup).find((e) => e.dataset.action === "ok");
    assert.equal(save.getAttribute("aria-label"), "Save");
    await finish(t, save.click());
    assert.deepEqual(v.previewSources, { spr: "mod:test" });
    assert.deepEqual(v.configured, {});
    assert.deepEqual(v.state.files, before);
    assert.equal(rpcRequests.slice(start).filter((r) => r.method === "actions.apply").length, 0);
    const detailApply = () => walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("SkillData_EX (3)/Bg"));
    assert.equal(detailApply().getAttribute("aria-label"), "Apply");
    assert.equal(detailApply().disabled, false);
    await finish(t, detailApply().click());
    assert.equal(v.configured.spr, "mod:test");
    if (!enabled) assert.deepEqual(v.state.files, before);
    assert.equal(detailApply().disabled, true);
    await switchButton().click(); await flush();
    const popupApply = () => walk(hosts.popup).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "Apply");
    assert.equal(popupApply().disabled, true);
    await walk(hosts.popup).find((e) => e.dataset.key === "self").click(); await flush();
    assert.equal(popupApply().disabled, false);
    await finish(t, popupApply().click());
    assert.equal(v.configured.spr, null);
    assert.equal(v.previewSources.spr, "mod:test", "Apply does not overwrite the saved preview");
    assert.equal(popupApply().disabled, true);
    assert.equal(detailApply().disabled, false);
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); await flush(); t.mock.timers.reset(); }
});

for (const kind of ["spr", "lobby", "model"]) for (const selected of [false, true]) {
  test(`library-only ${kind} remains selectable and preview ${selected ? "uses its saved Mod" : "stays unselected"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      lobbyMode = "ready"; playerMode = "lobby-ready";
      family = modFamily(kind, `library-only-${kind}`);
      const v = family.variants[0];
      Object.assign(v, { spr: null, lobby: null, model: null, storedKinds: [kind], localKinds: [],
        configured: {}, previewSources: selected ? { [kind]: `mod:library-only-${kind}` } : {}, state: { files: [] } });
      const assetsBefore = assetRequests.length, modelsBefore = modelRequests.length, rpcsBefore = rpcRequests.length;
      const showing = Detail.show(context, family, v.key); await flush(); await finish(t, showing);
      assert.equal(Detail.currentVariant(), v.key);
      assert.ok(switchButton(), "the own Mod can still be selected for preview");
      const apply = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("SkillData_EX (3)/Bg"));
      assert.equal(apply.disabled, true);
      assert.equal(apply.getAttribute("aria-description"), "No Matching Game File");
      await apply.click(); await flush();
      assert.equal(rpcRequests.slice(rpcsBefore).some((r) => r.method === "actions.apply"), false);
      assert.equal(assetRequests.slice(assetsBefore).some((url) => url.includes("/null/")), false);
      if (kind === "model") {
        assert.equal(modelRequests.length - modelsBefore, selected ? 1 : 0);
        if (selected) assert.equal(modelRequests.at(-1).source, "mod:library-only-model");
      } else {
        assert.equal(assetRequests.slice(assetsBefore).some((url) => url.includes(`/mod/library-only-${kind}/`)), selected);
      }
      assert.deepEqual(v.previewSources, selected ? { [kind]: `mod:library-only-${kind}` } : {});
    } finally { Detail.hide(); lobbyMode = "pending"; playerMode = "ready"; await flush(); t.mock.timers.reset(); }
  });
}

test("detail Back calls the session history callback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let returned = 0;
  try {
    family = modFamily();
    const showing = Detail.show({ ...context, back: () => { returned += 1; } }, family, "ibuki");
    await flush(); await finish(t, showing);
    back.onclick();
    assert.equal(returned, 1);
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

test("an unselected library-only Mod can be saved for preview without applying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily("spr", "library-only-pick");
    const v = family.variants[0];
    Object.assign(v, { spr: null, lobby: null, model: null, storedKinds: ["spr"], localKinds: [],
      configured: {}, previewSources: {}, state: { files: [] } });
    await showPortrait(t);
    const before = rpcRequests.length;
    await switchButton().click(); await flush();
    await walk(hosts.popup).find((e) => e.dataset.key === "m:library-only-pick").click(); await flush();
    const save = walk(hosts.popup).find((e) => e.dataset.action === "ok");
    await finish(t, save.click());
    assert.deepEqual(v.previewSources, { spr: "mod:library-only-pick" });
    assert.equal(rpcRequests.slice(before).some((r) => r.method === "actions.apply"), false);
    const apply = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("SkillData_EX (3)/Bg"));
    assert.equal(apply.disabled, true);
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

const visualButton = (name) => walk(hosts['visual-ui']).find((el) => el.dataset.visualAction === name);
const zoomButton = () => walk(hosts.ngui).find((el) => el.dataset.part === `${PLATE}/Char_ZoomBtn`);
function assertPhotographyCorner(mode) {
  const launcher = document.getElementById('photo-launcher');
  const hit = walk(launcher).find((el) => el.tagName === 'BUTTON'), scale = 1920 / 2960;
  const width = 171 * scale, height = 116 * scale;
  const expected = [960 + 1352 * scale - width / 2 - (mode === 'portrait' ? width + 26 : 0),
    540 - (-112.5 - 658 + 61.1) * scale - height / 2, width, height];
  ['left', 'top', 'width', 'height'].forEach((key, index) => assert.ok(Math.abs(parseFloat(hit.style[key]) - expected[index]) < 0.02, `Photography ${key} follows the existing ${mode} corner`));
}
async function clickFullscreen(t, button) {
  assert.ok(button, 'The fullscreen action must exist');
  const result = button.click(); await flush(); await finish(t, result);
}

for (const enabled of [true, false]) test(`fullscreen switches both ways on the selected skin with mods ${enabled ? 'on' : 'off'} and keeps preview state`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    errors.length = 0; lobbyMode = 'ready'; playerMode = 'lobby-ready';
    setStrings('en-US', localeTable('en-US'));
    modsEnabled = enabled; await ModSwitch.refresh();
    family = modFamily('spr', `fullscreen-${enabled}`);
    const selected = structuredClone(family.variants[0]); selected.key = 'selected-skin'; selected.spr = 'selected_skin_spr'; selected.lobby = 'selected_skin_home';
    selected.previewSources = { spr: 'mod:portrait-preview', lobby: 'mod:library-only-lobby' };
    selected.configured = { spr: 'mod:configured-portrait', lobby: 'mod:configured-lobby' };
    selected.modList = [{ id: 'portrait-preview', target: selected.key, kind: 'spr' }, { id: 'library-only-lobby', target: selected.key, kind: 'lobby' }];
    family.variants.push(selected);
    await showPortrait(t, selected.key);
    await walk(hosts['ngui-expr']).filter((el) => el.tagName === 'BUTTON')[1].click(); await flush();
    const saved = structuredClone(selected), start = rpcRequests.length, assets = playerRequests.length, requests = assetRequests.length;
    const origin = zoomButton(); origin.focus();
    await clickFullscreen(t, origin);
    assert.equal(hosts.stage.classList.contains('fullscreen'), true);
    assert.equal(visualButton('Btn_HideUI').getAttribute('aria-label'), 'Switch Memorial Lobby');
    assert.equal(visualButton('Btn_Back').hidden, false);
    assert.equal(hosts.ngui.inert, true);
    assertPhotographyCorner('portrait');
    visualButton('Btn_HideUI').focus();
    await clickFullscreen(t, visualButton('Btn_HideUI'));
    assert.equal(hosts.stage.classList.contains('fullscreen'), true);
    assert.equal(Detail.currentVariant(), selected.key);
    assert.equal(hosts.lobby.hidden, false);
    assert.equal(hosts['visual-ui'].querySelector('.visual-touch'), null, 'Lobby input has no portrait overlay');
    assert.equal(visualButton('Btn_HideUI').getAttribute('aria-label'), 'Switch Portrait');
    assert.equal(document.activeElement, visualButton('Btn_HideUI'), 'The replacement switch retains keyboard focus');
    assert.equal(hosts['fs-exit'].hidden, false, 'Back remains available in the lobby');
    const s = 1920 / 2960, backBounds = [960 + (-1354 - 171 / 2) * s, 540 - (650 + 116 / 2) * s, 171 * s, 116 * s];
    ['left', 'top', 'width', 'height'].forEach((key, index) => assert.ok(Math.abs(parseFloat(hosts['fs-exit'].style[key]) - backBounds[index]) < 0.02, `Lobby Back ${key} keeps its existing position`));
    assertPhotographyCorner('lobby');
    await clickFullscreen(t, visualButton('Btn_HideUI'));
    assert.equal(hosts.portrait.hidden, false);
    assert.equal(hosts['fs-exit'].hidden, true, 'The portrait keeps its own Back control');
    assert.equal(visualButton('Btn_HideUI').getAttribute('aria-label'), 'Switch Memorial Lobby');
    const player = [...hosts.portrait.querySelectorAll('.layer')].at(-1).player;
    assert.equal(player.trackNames[1], '01', 'The selected expression survives the round trip');
    assert.equal(document.activeElement, visualButton('Btn_HideUI'));
    assertPhotographyCorner('portrait');
    assert.ok(playerRequests.slice(assets).some((url) => url.includes('/mod/library-only-lobby/')));
    assert.ok(assetRequests.slice(requests).some((url) => url.includes('/lobby/selected_skin_home/')));
    assert.ok(!assetRequests.slice(requests).some((url) => url.includes('/lobby/ibuki_home/')), 'No other skin supplies the lobby');
    assert.ok(playerRequests.slice(assets).some((url) => url.includes('/mod/portrait-preview/')));
    await clickFullscreen(t, visualButton('Btn_Back'));
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
    await clickFullscreen(t, zoomButton()); keydown('Escape'); await flush();
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
    assert.equal(hosts.ngui.inert, false);
    assert.equal(document.activeElement, zoomButton(), 'Back returns focus to the rebuilt detail launcher');
    assert.deepEqual(selected, saved);
    assert.equal(ModSwitch.current().enabled, enabled);
    assert.ok(!rpcRequests.slice(start).some((r) => /^(actions\.|ui\.preview|mods\.(set|toggle))/.test(r.method)), 'Fullscreen navigation performs no game or preview writes');
    assert.ok(!errors.some((args) => args[0] === 'Detail render failed'), errors.map(String).join('\n'));
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); lobbyMode = 'pending'; playerMode = 'ready'; await flush(); t.mock.timers.reset(); }
});

test('a skin without a lobby omits the switch even when another skin has a lobby', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    family = modFamily();
    const selected = { ...structuredClone(family.variants[0]), key: 'portrait-only', lobby: null };
    family.variants.push(selected);
    await showPortrait(t, selected.key);
    await clickFullscreen(t, zoomButton());
    assert.equal(visualButton('Btn_HideUI'), undefined);
    assert.ok(visualButton('Btn_Back'));
    assert.ok(walk(hosts['visual-ui']).some((el) => el.dataset.path?.includes('Btn_RefreshPos_Disable')));
    assert.ok(document.getElementById('photo-launcher'), 'Photography remains available');
    await clickFullscreen(t, visualButton('Btn_Back'));
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const viaSwitch of [true, false]) test(`Back and Escape leave the lobby fullscreen ${viaSwitch ? 'after the portrait switch' : 'from the lobby detail tab'}`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    lobbyMode = 'ready'; playerMode = 'lobby-ready'; family = modFamily();
    await showPortrait(t);
    if (!viaSwitch) await clickFullscreen(t, tabButton(2));
    zoomButton().focus(); await clickFullscreen(t, zoomButton());
    if (viaSwitch) await clickFullscreen(t, visualButton('Btn_HideUI'));
    await clickFullscreen(t, hosts['fs-exit']);
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
    assert.equal(hosts['visual-ui'].hidden, true);
    assert.equal(document.activeElement, zoomButton());
    await clickFullscreen(t, zoomButton()); keydown('Escape'); await flush();
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
    assert.equal(hosts['visual-ui'].hidden, true);
    assert.equal(hosts.ngui.inert, false);
  } finally { Detail.hide(); lobbyMode = 'pending'; playerMode = 'ready'; await flush(); t.mock.timers.reset(); }
});

test('Escape while a fullscreen switch is loading cannot reopen fullscreen with stale controls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    family = modFamily(); lobbyMode = 'pending'; await showPortrait(t);
    await clickFullscreen(t, zoomButton());
    const switching = visualButton('Btn_HideUI').click(); await flush();
    keydown('Escape'); await flush();
    await finish(t, switching);
    assert.equal(hosts.stage.classList.contains('fullscreen'), false);
    assert.equal(hosts['visual-ui'].hidden, true);
    assert.equal(hosts['fs-exit'].hidden, true);
    assert.equal(hosts.ngui.inert, false);
  } finally { Detail.hide(); await flush(); t.mock.timers.reset(); }
});

for (const lang of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH']) test(`fullscreen prefab corners and native switch buttons preserve geometry in ${lang}`, async () => {
  const Visual = await import('../../src/ba_modding_toolkit/web/js/visual-mode.js');
  const strings = localeTable(lang), scale = 1920 / 2960, layout = visualPrefab();
  const labels = { back: strings['webui.lobby.exit'], reset: strings['webui.visual.reset'], switch: strings['webui.row.switch.lobby'] };
  const before = structuredClone(layout);
  const parts = await Visual.prepare({ layout, strings: labels });
  let switched = 0;
  const lobby = await Visual.prepareSwitch({ layout, label: strings['webui.row.switch.portrait'], onSwitch: () => { switched++; } });
  const button = (group) => walk(group).find((el) => el.tagName === 'BUTTON');
  const portraitSwitch = button(parts.groups.Btn_HideUI), lobbySwitch = button(lobby);
  for (const key of ['left', 'top', 'width', 'height', 'zIndex']) assert.equal(lobbySwitch.style[key], portraitSwitch.style[key], 'Both views use the identical hit area');
  assert.equal(portraitSwitch.getAttribute('aria-label'), strings['webui.row.switch.lobby']);
  assert.equal(lobbySwitch.getAttribute('aria-label'), strings['webui.row.switch.portrait']);
  for (const control of [portraitSwitch, lobbySwitch]) {
    assert.equal(control.tagName, 'BUTTON', 'Native buttons support Tab, Enter and Space');
    assert.notEqual(control.tabIndex, -1);
    assert.equal(control.disabled, undefined);
    assert.equal(control.closest('[inert]'), null);
  }
  await lobbySwitch.click(); assert.equal(switched, 1);
  assert.equal(parts.groups.Btn_ShowUI, undefined, 'No Hide/Show UI alternate remains');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} != ${b}`);
  const bounds = (el) => ['left', 'top', 'width', 'height'].map((key) => parseFloat(el.style[key]));
  const switchBox = bounds(portraitSwitch);
  const backBox = bounds(button(parts.groups.Btn_Back));
  const resetBox = bounds(button(parts.groups.Btn_RefreshPos));
  const expected = [
    [switchBox, [960 + (1352 - 228.83 / 2) * scale, 540 - (78.5 + 650 + 165 / 2) * scale, 228.83 * scale, 165 * scale]],
    [backBox, [960 + (-1354 - 228.83 / 2) * scale, switchBox[1], 228.83 * scale, 165 * scale]],
    [resetBox, [switchBox[0], 540 - (-112.5 - 658 + 32 + 195.2 / 2) * scale, 228.83 * scale, 195.2 * scale]],
  ];
  for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440]]) for (const density of [1, 2]) {
    const factor = Math.min(width / 1920, height / 1080) * density;
    for (const [actual, reference] of expected) actual.forEach((value, index) => near(value * factor, reference[index] * factor));
  }
  for (const group of [parts.groups.Btn_HideUI, lobby]) {
    const icon = walk(group).find((el) => el.dataset.path?.endsWith('RightTop/Btn_HideUI/Icon'));
    near(parseFloat(icon.style.width), 79 * scale); near(parseFloat(icon.style.height), 67 * scale);
    near(parseFloat(icon.style.left) + 79 * scale / 2, switchBox[0] + switchBox[2] / 2);
    near(parseFloat(icon.style.top) + 67 * scale / 2, switchBox[1] + switchBox[3] / 2 - 8 * scale);
    assert.ok(imageRequests.some((url) => url.includes('/Common_UIHide_Icon.png')), 'The original double-arrow sprite is rendered');
  }
  assert.deepEqual(layout, before, 'The source prefab is unchanged');
  const { CORNER_MARGIN, reflowCorners } = await import('../../src/ba_modding_toolkit/web/js/corner-layout.js');
  const { headerGeometry } = await import('../../src/ba_modding_toolkit/web/js/window-layout.js');
  const oldRect = hosts.stage.getBoundingClientRect;
  const old = Object.fromEntries(['innerWidth', 'innerHeight', 'bamtWindowChrome', 'bamtHeaderGeometry'].map(k => [k, globalThis[k]]));
  const holder = body.appendChild(new El());
  holder.append(...Object.values(parts.groups), lobby);
  const exit = holder.appendChild(new El('button'));
  try {
    await Visual.exitControl(exit, layout);
    for (const platform of [null, 'darwin', 'win32']) for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440]]) {
      const k = width / 1920, native = platform ? { active: true, platform, bounds: platform === 'darwin'
        ? { left: 12, right: 80, top: 8, bottom: 30 } : { left: width - 148, right: width, top: 8, bottom: 40 } } : null;
      Object.assign(globalThis, { innerWidth: width, innerHeight: height, bamtWindowChrome: native,
        bamtHeaderGeometry: platform ? headerGeometry(width, height, platform === 'win32' ? 40 : 0, true) : null });
      hosts.stage.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
      reflowCorners();
      const checks = [[parts.groups.Btn_Back, 'LeftTop/Btn_Back', 'top-left'], [parts.groups.Btn_HideUI, 'RightTop/Btn_HideUI', 'top-right'],
        [lobby, 'RightTop/Btn_HideUI', 'top-right'], [parts.groups.Btn_RefreshPos, 'RightBottom/Btn_RefreshPos/Btn_RefreshPos', 'bottom-right'],
        [parts.groups.Btn_RefreshPos_Disable, 'RightBottom/Btn_RefreshPos_Disable/Btn_RefreshPos', 'bottom-right']];
      for (const [group, path, corner] of checks) {
        const sprite = walk(group).find(el => el.dataset.path === `Inventory_ListControl_PC/${path}`);
        assert.ok(sprite, path);
        const [dx, dy] = group.style.translate.split(' ').map(parseFloat), box = bounds(sprite);
        const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
        const row = platform && (right ? platform === 'win32' : platform === 'darwin') ? globalThis.bamtHeaderGeometry.rowHeight : 0;
        near(right ? 1920 - box[0] - dx - box[2] : box[0] + dx, CORNER_MARGIN);
        near(bottom ? 1080 - box[1] - dy - box[3] : box[1] + dy - row / k, CORNER_MARGIN);
      }
      const [dx, dy] = exit.style.translate.split(' ').map(parseFloat);
      near(parseFloat(exit.style.left) + dx, CORNER_MARGIN);
      near(parseFloat(exit.style.top) + dy, CORNER_MARGIN + (platform === 'darwin' ? globalThis.bamtHeaderGeometry.rowHeight / k : 0));
    }
  } finally { holder.remove(); hosts.stage.getBoundingClientRect = oldRect; Object.assign(globalThis, old); }
});
