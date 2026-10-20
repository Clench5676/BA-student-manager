// The real detail and NGUI modules, with mod-backed family data and stand-in browser/Spine loaders.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: { setProperty(k, v) { this[k] = v; } },
      dataset: {}, attrs: {}, listeners: {}, className: "", hidden: false, textContent: "", id: "", width: 8, height: 8 });
    this.classList = {
      contains: (c) => this.className.split(" ").includes(c),
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
  click() { return Promise.all((this.listeners.click || []).map((f) => f({ type: "click" }))); }
  getContext() {
    return { font: "", measureText(s) {
      const fs = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 10);
      return { width: [...s].reduce((w, c) => w + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/.test(c) ? fs : fs / 2), 0) };
    }, drawImage() {}, fillRect() {}, clearRect() {} };
  }
  toBlob(fn) { fn(new Blob()); }
}
const walk = (el) => [el, ...el.children.flatMap(walk)];
const body = new El("body"), title = new El(), back = new El("button");
const hosts = Object.fromEntries(["stage", "screen-detail", "ngui", "ngui-bg", "ngui-chips", "ngui-expr", "portrait", "lobby", "model",
  "popup", "picker", "dialog", "prompt", "consent", "toast", "fs-exit"].map((id) => {
  const el = body.appendChild(new El()); el.id = id; el.hidden = /popup|picker|dialog|prompt|consent/.test(id); return [id, el];
}));
globalThis.document = { body, documentElement: new El("html"), activeElement: body,
  createElement: (tag) => new El(tag), createDocumentFragment: () => new El("fragment"), getElementById: (id) => hosts[id],
  querySelector: (s) => s === ".topbar .title" ? title : s === ".topbar .back" ? back : null,
  querySelectorAll: () => [], addEventListener() {} };
Object.defineProperty(globalThis, "navigator", { value: { platform: "Mac" }, configurable: true });
globalThis.location = { hash: "#/student/ibuki/ibuki" };
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => { queueMicrotask(() => fn(performance.now())); return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ opacity: "1" });

const imageRequests = [], pendingImages = [];
let imageMode = "ready", playerMode = "ready", portraitRevision = "a", portraitStatus = 200;
let decodeMode = "ready";
const pendingDecodes = [], pendingPlayers = [];
globalThis.Image = class {
  naturalWidth = 8; naturalHeight = 8;
  set src(url) {
    imageRequests.push(url);
    if (imageMode === "pending") pendingImages.push(this);
    else queueMicrotask(() => imageMode === "error" ? this.onerror?.() : this.onload?.());
  }
  decode() {
    return decodeMode === "pending" ? new Promise((resolve) => pendingDecodes.push(resolve)) : Promise.resolve();
  }
};
const playerRequests = [];
globalThis.spine = { Physics: { update: 1 }, SpinePlayer: class {
  constructor(el, config) {
    playerRequests.push(config.skeleton);
    this.dispose = () => {}; this.config = config;
    const animations = ["Idle_01", "00", "01"].map((name) => ({ name }));
    this.skeleton = { data: { animations, findAnimation(name) {
      if (playerMode === "broken") throw new Error("Mod skeleton setup failed");
      return animations.find((a) => a.name === name);
    } } };
    this.animationState = { setAnimation() {}, setEmptyAnimation: () => ({}), addEmptyAnimation() {} };
    // Thumbnails deliberately never call back: a stuck mod preview must not block the panels or other bases.
    if (el.className !== "thumb-player" && playerMode !== "pending") {
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
}
for (const path of ["BG/BG (1)", "Line/Line", "Label_WeaponType"]) add(`${INFO}/Weapon/WeaponType/${path}`);
for (const path of ["Card_Bg/Deco", "Card_Level"]) add(`${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/${path}`);
for (const path of ["BG/Deco", "Label_Name", "Char_CVCollectionBtn/Sprite", "Char_ZoomBtn/Sprite",
  "Pin/Pin_On/Bg/Icon/Label_Locale", "Pin/Pin_Off/Bg/Icon/Label_Locale"]) add(`${PLATE}/${path}`);

const atlas = { Common: Object.fromEntries([...new Set([
  ...[...readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8").matchAll(/"(Common_[A-Za-z0-9_]+)"/g)].map((m) => m[1]),
  "Card_Select_Line_Blue", "Cafe_Icon_NameEdit", "Common_Icon_Reddot2",
])].map((name) => [name, { width: 8, height: 8 }])) };
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
let family, indexMode = "ready", layoutMode = "ready", lobbyMode = "pending", optionalPending = false, modsEnabled = true;
let seenReply = async () => ({ result: null });
const textureReplies = [], layoutReplies = [], rpcRequests = [], assetRequests = [];
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const request = JSON.parse(opts.body), { method } = request;
    rpcRequests.push(request);
    if (method === "mods.seen") return reply(await seenReply(request.params));
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
    if (optionalPending) return new Promise((resolve) => textureReplies.push(() => resolve(reply({}))));
    return reply({});
  }
  if (url === "/asset/ui/layout/UICharacterDetail.json") {
    if (layoutMode === "pending") return new Promise((resolve) => layoutReplies.push(() => resolve(reply(detail))));
    return reply(detail, layoutMode === "error" ? 500 : 200);
  }
  if (url.startsWith("/asset/ui/layout/")) {
    if (optionalPending && url.endsWith("UIPopup_Sort.json")) return new Promise(() => {});
    if (url.endsWith("UIPopup_Sort.json")) return reply(sortPopup);
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
setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
const Detail = await import("../../src/ba_modding_toolkit/web/js/detail.js");
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const Loading = await import("../../src/ba_modding_toolkit/web/js/loading.js");
const ModSwitch = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
let invalidations = 0;
const context = { prefs: {}, info: {}, invalidateRoster() { invalidations++; }, step() {}, go() {} };
function modFamily(kind = "spr", id = "test") {
  return { key: "ibuki", version: id, variants: [{ key: "ibuki", spr: "ibuki_spr", lobby: "ibuki_home", names: { en: { full: "Ibuki", short: "Ibuki" } },
    modList: [{ id, target: "ibuki", kind, label: id }], state: { files: [{ kind, applied: `mod:${id}`, official: false, restorable: true, crc: "fixed" }] } }] };
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const finish = async (t, promise) => {
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  for (let i = 0; i < 90 && !settled; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.ok(settled, "asset failures must settle the readiness barrier");
  return promise;
};
const switchButton = () => walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`);
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
  } finally { Detail.hide(); layoutMode = "ready"; t.mock.timers.reset(); }
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
  } finally { Detail.hide(); layoutMode = "ready"; t.mock.timers.reset(); }
});

test("detail waits for UI images and settles broken thumbnails before reveal", async (t) => {
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
  } finally { Detail.hide(); t.mock.timers.reset(); imageMode = "ready"; optionalPending = false; }
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
    Detail.hide(); t.mock.timers.reset();
  }
});

test("a mod portrait setup exception is observed, settled and reported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; playerMode = "broken"; family = modFamily("spr", "broken");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.ok(switchButton());
    assert.ok(errors.some((a) => a.some((e) => String(e).includes("Mod skeleton setup failed"))));
    assert.equal(hosts.toast.textContent, "Preview unavailable");
    assert.ok(!hosts.portrait.classList.contains("pending"));
  } finally { Detail.hide(); t.mock.timers.reset(); playerMode = "ready"; }
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
  } finally { Detail.hide(); playerMode = "ready"; portraitRevision = "a"; t.mock.timers.reset(); }
});

for (const status of [404, 500]) test(`the main portrait logs the cause of a failed manifest (${status})`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; warnings.length = 0; family = modFamily(); portraitStatus = status;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    assert.equal(hosts.toast.textContent, "Preview unavailable");
    assert.ok(errors.some((args) => args.includes("/asset/spine/spr/ibuki_spr/skeleton")), "the console names the current source");
    assert.ok([...errors, ...warnings].some((args) => args.some((value) => String(value).includes(`HTTP ${status}`))));
    assert.ok(switchButton(), "the panels stay usable");
  } finally { Detail.hide(); portraitStatus = 200; t.mock.timers.reset(); }
});

test("a lobby switch stays covered until its failed preview settles and can retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; family = modFamily("lobby", "lobby");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await finish(t, showing);
    const lobbyTab = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("Tab_2/Tab_Off/Label"));
    const switching = lobbyTab.click(); await flush();
    assert.equal(Loading.covering(), true, "the tab's panels and preview prepare behind black");
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
  } finally { Detail.hide(); t.mock.timers.reset(); }
});

test("a special background waits for preview failure and keeps controls and unseen dots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; lobbyMode = "pending";
    const v = { key: "special:arona_workpage_daytime", spr: null, lobby: "arona_workpage_daytime", spineCategory: "spinebackground",
      names: { en: { full: "Arona - Work Page - Daytime", short: "Work Page - Daytime" } },
      modList: [{ id: "special-day", target: "special:arona_workpage_daytime", core: "arona_workpage_daytime", kind: "lobby", label: "Day", fresh: true }],
      state: { files: [{ kind: "lobby", applied: "mod:special-day", official: false, restorable: true, crc: "fixed" }] } };
    family = { key: "arona", version: "special", variants: [modFamily().variants[0], v] };
    const start = playerRequests.length, fetchStart = assetRequests.length, rpcStart = rpcRequests.length;
    let ready = false;
    const showing = Detail.show(context, family, v.key).then(() => { ready = true; }); await flush();
    t.mock.timers.tick(1300); await flush();
    assert.equal(ready, false, "a pending background cannot release the loading cover early");
    await finish(t, showing);
    assert.equal(Detail.currentVariant(), v.key, "the requested background stays selected alongside a portrait variant");
    assert.equal(switchButton().getAttribute("aria-label"), "Switch Background");
    assert.ok(switchButton().listeners.click.length);
    const add = walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Btn_Up_Wrapper/Btn_Up/BG (1)`);
    assert.equal(add.getAttribute("aria-label"), "Add Background");
    assert.ok(add.listeners.click.length);
    assert.ok(!walk(hosts.ngui).some((e) => e.dataset.part?.endsWith("Tab_1/Tab_Off/Label")), "there is no portrait tab hit target");
    assert.ok(assetRequests.slice(fetchStart).some((url) => url.includes("/lobby/arona_workpage_daytime/")));
    assert.ok(!playerRequests.slice(start).some((url) => url.includes("/spr/")), "no missing portrait player is started");
    assert.equal(hosts.lobby.querySelector(".lobby-unavailable")?.textContent, "Preview unavailable");
    assert.ok(!hosts.lobby.classList.contains("pending"));
    assert.equal(switchButton().getAttribute("aria-label"), "Switch Background");
    assert.ok(switchButton().listeners.click.length, "apply and restore still have a switch card");
    assert.ok(!rpcRequests.slice(rpcStart).some((r) => r.method === "lobby.lines"));
    assert.ok(tabDot(2)); assert.ok(chipDot(v.key));
    assert.ok(!rpcRequests.slice(rpcStart).some((r) => r.method === "mods.seen"), "a failed preview leaves mods unseen");
    await switchButton().click(); await flush();
    assert.deepEqual(rpcRequests.filter((r) => r.method === "mods.seen").at(-1).params, { ids: ["special-day"] });
    assert.equal(tabDot(2), undefined); assert.equal(chipDot(v.key), undefined);
    await closeSwitch();
    back.onclick(); assert.equal(location.hash, "#/roster");
  } finally { Detail.hide(); t.mock.timers.reset(); }
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
  } finally { indexMode = "ready"; t.mock.timers.reset(); }
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
  } finally { Detail.hide(); modsEnabled = true; await ModSwitch.refresh(); t.mock.timers.reset(); }
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
  } finally { imageMode = "ready"; t.mock.timers.reset(); }
});

test("long portrait and lobby names only resize their own info cell in every locale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const paths = ["Label_Life/Data_Widget/Data", "Label_Attact/Data_Widget/Data", "Label_Defense/Data", "Label_Healing/Data_Widget/Data"];
  const cell = (path) => walk(hosts.ngui).find((el) => el.dataset.path?.endsWith(`${INFO}/Status/${path}`) && el.style.fontSize);
  const size = (str, fs) => `${(NGUI.fontSizeFor(str, fs) * 1920 / 2960).toFixed(2)}px`;
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
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
    Detail.hide(); t.mock.timers.reset();
    setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
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
  } finally { Detail.hide(); t.mock.timers.reset(); }
});

test("a failed seen write keeps the dots and can be retried by opening the mod card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    family = modFamily(); family.variants[0].modList[0].fresh = true;
    await showPortrait(t);
    seenReply = async () => ({ error: { code: "internal" } });
    const popup = switchButton().click(); await flush(); await popup;
    assert.ok(tabDot(1)); assert.ok(chipDot("ibuki"));
    seenReply = async () => ({ result: null });
    const card = walk(hosts.popup).find((e) => e.dataset.key === "m:test");
    assert.ok(card);
    await card.click(); await flush();
    assert.equal(tabDot(1), undefined); assert.equal(chipDot("ibuki"), undefined);
    await closeSwitch();
  } finally { Detail.hide(); seenReply = async () => ({ result: null }); t.mock.timers.reset(); }
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
    assert.ok(walk(hosts.popup).some((e) => e.dataset.path?.endsWith("Card_m:test/Dot")));
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
      assert.equal(walk(hosts.popup).find((e) => e.dataset.path?.endsWith("Card_m:test/Dot")), undefined);
    } else {
      assert.equal(hosts.popup.hidden, true);
      assert.equal(hosts.popup.children.length, 0);
    }
    if (after !== "left") { assert.equal(tabDot(1), undefined); assert.equal(chipDot("ibuki"), undefined); }
  } finally { finish?.({ result: null }); Detail.hide(); seenReply = async () => ({ result: null }); t.mock.timers.reset(); }
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
  } finally { Detail.hide(); t.mock.timers.reset(); }
});
