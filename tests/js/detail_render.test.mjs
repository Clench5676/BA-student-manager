// The real detail and NGUI modules, with mod-backed family data and stand-in browser/Spine loaders.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: { setProperty(k, v) { this[k] = v; } },
      dataset: {}, listeners: {}, className: "", hidden: false, textContent: "", id: "", width: 8, height: 8 });
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
  set innerHTML(html) {
    this.replaceChildren();
    for (const m of html.matchAll(/<(div|canvas|span|i)\b([^>]*)>/g)) {
      const child = new El(m[1]); child.className = /class="([^"]*)"/.exec(m[2])?.[1] || ""; this.appendChild(child);
    }
  }
  querySelectorAll(selector) {
    const match = (n) => selector.startsWith(".") ? n.classList.contains(selector.slice(1)) : n.tagName === selector.toUpperCase();
    return walk(this).slice(1).filter(match);
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  focus() { document.activeElement = this; }
  click() { return Promise.all((this.listeners.click || []).map((f) => f({ type: "click" }))); }
  getContext() { return { measureText: (s) => ({ width: s.length * 20 }), drawImage() {}, fillRect() {}, clearRect() {} }; }
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

const imageRequests = [], pendingImages = [];
let imageMode = "ready", playerMode = "ready", portraitRevision = "a", portraitStatus = 200;
globalThis.Image = class {
  naturalWidth = 8; naturalHeight = 8;
  set src(url) {
    imageRequests.push(url);
    if (imageMode === "pending") pendingImages.push(this);
    else queueMicrotask(() => imageMode === "error" ? this.onerror?.() : this.onload?.());
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
    }
  }
} };

const node = (name) => ({ name, pos: [0, 0], scale: [1, 1], active: true, widgets: [
  { sprite: "Common_Bg_Raius10px", w_: 100, h_: 100, color: "#ffffff/1.00" },
  { text: "text", w_: 100, h_: 100, fontSize: 40 },
], children: [] });
const detail = node("UICharacterDetail"), list = node("Inventory_ListControl"); detail.children.push(list);
function add(path) {
  let at = list;
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
  "Card_Select_Line_Blue", "Cafe_Icon_NameEdit",
])].map((name) => [name, { width: 8, height: 8 }])) };
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
let family, indexMode = "ready", layoutMode = "ready", lobbyMode = "pending", optionalPending = false, modsEnabled = true;
const textureReplies = [], layoutReplies = [];
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const { method } = JSON.parse(opts.body);
    return reply({ result: method === "family.get" ? family : method === "mods.state" ? { enabled: modsEnabled } : null });
  }
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
const ModSwitch = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
const context = { prefs: {}, info: {}, invalidateRoster() {}, step() {}, go() {} };
function modFamily(kind = "spr", id = "test") {
  return { key: "ibuki", version: id, variants: [{ key: "ibuki", spr: "ibuki_spr", lobby: "ibuki_home", names: { en: { full: "Ibuki", short: "Ibuki" } },
    modList: [{ id, target: "ibuki", kind, label: id }], state: { files: [{ kind, applied: `mod:${id}`, official: false, restorable: true, crc: "fixed" }] } }] };
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const switchButton = () => walk(hosts.ngui).find((e) => e.dataset.part === `${INFO}/Weapon/Equip_1/UIEquipmentCard/Btn_Target/Normal/Card_Bg`);

test("a failed detail layout cannot prevent the installed portrait from loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; layoutMode = "error"; imageMode = "pending"; family = modFamily();
    const start = playerRequests.length;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await showing;
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
    t.mock.timers.tick(1300); await flush(); await showing;
    assert.ok(switchButton(), "panels finish when the layout arrives");
  } finally { Detail.hide(); layoutMode = "ready"; t.mock.timers.reset(); }
});

test("an applied portrait draws usable panels while UI images and mod thumbnails never settle", async (t) => {
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
    t.mock.timers.tick(1300); await flush(); await showing;
    const panel = walk(hosts.ngui).find((e) => e.dataset.path?.endsWith("Active/Bg"));
    assert.equal(panel.style.backgroundColor, "#0c284b", "a missing sprite leaves a panel placeholder");
    imageMode = "ready";
    pendingImages.splice(0).forEach((img) => img.onload()); await flush();
    assert.ok(panel.style.backgroundImage, "late sprites fill the existing panels");
    assert.equal(panel.style.backgroundColor, "");
    back.onclick(); assert.equal(location.hash, "#/roster");
  } finally { Detail.hide(); t.mock.timers.reset(); imageMode = "ready"; optionalPending = false; }
});

test("a mod portrait setup exception is observed, settled and reported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; playerMode = "broken"; family = modFamily("spr", "broken");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await showing;
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
    t.mock.timers.tick(1300); await flush(); await showing;
    const live = playerRequests.slice(start).filter((url) => url.includes("/spr/ibuki_spr/"));
    assert.ok(live.some((url) => url.includes(`/${"a".repeat(64)}/`)));
    assert.ok(live.some((url) => url.includes(`/${"b".repeat(64)}/`)));
    assert.ok(!errors.length, errors.map(String).join("\n"));
    assert.ok(warnings.some((args) => args[0] === "Spine source changed during load"));
  } finally { Detail.hide(); playerMode = "ready"; portraitRevision = "a"; t.mock.timers.reset(); }
});

for (const status of [404, 500]) test(`the main portrait logs the cause of a failed manifest (${status})`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; warnings.length = 0; family = modFamily(); portraitStatus = status;
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await showing;
    assert.equal(hosts.toast.textContent, "Preview unavailable");
    assert.ok(errors.some((args) => args.includes("/asset/spine/spr/ibuki_spr/skeleton")), "the console names the current source");
    assert.ok([...errors, ...warnings].some((args) => args.some((value) => String(value).includes(`HTTP ${status}`))));
    assert.ok(switchButton(), "the panels stay usable");
  } finally { Detail.hide(); portraitStatus = 200; t.mock.timers.reset(); }
});

test("an applied lobby with hanging asset routes releases the in-place render barrier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    errors.length = 0; family = modFamily("lobby", "lobby");
    const showing = Detail.show(context, family, "ibuki"); await flush();
    t.mock.timers.tick(1300); await flush(); await showing;
    const lobbyTab = walk(hosts.ngui).find((e) => e.dataset.part?.endsWith("Tab_2/Tab_Off/Label"));
    const switching = lobbyTab.click(); await flush();
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(1300); await flush(); }
    await switching;
    assert.ok(switchButton(), "the new panel commits even though Lobby.show is pending");
    assert.equal(switchButton().title, "Switch Memorial Lobby");
    t.mock.timers.tick(16000); await flush();
    assert.ok(errors.some((a) => a.some((e) => String(e).includes("Detail lobby: timed out"))));
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
    t.mock.timers.tick(1300); await flush(); await showing;
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
    pendingImages.splice(0).forEach((img) => img.onload());
  } finally { imageMode = "ready"; t.mock.timers.reset(); }
});
