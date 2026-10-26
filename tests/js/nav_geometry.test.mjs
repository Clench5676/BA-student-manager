import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { insert, n, spr } from "./control_prefabs.mjs";

class El {
  children = []; style = {}; dataset = {}; attrs = {};
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  get childNodes() { return this.children; }
  addEventListener() {}
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
  getContext() { return { font: "", measureText(text) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 16);
    return { width: [...text].reduce((sum, c) => sum + fs * (/[\u2e80-\u9fff\uac00-\ud7af]/.test(c) ? 1 : 0.6), 0) };
  }, drawImage() {}, fillRect() {} }; }
  toBlob(fn) { const blob = new Blob(); blob.width = this.width; blob.height = this.height; fn(blob); }
}
const host = new El(), plate = new El();
const top = Object.fromEntries([".topbar .back", ".top-option", ".top-home", ".top-line"].map((key) => [key, new El()]));
globalThis.document = { createElement: () => new El(), documentElement: { lang: "en-US" },
  getElementById: (id) => id === "nav" ? host : null, querySelector: (s) => s === ".nav-bar" ? plate : top[s] || null };
globalThis.addEventListener = () => {};
const blobs = new Map();
URL.createObjectURL = (blob) => { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; };
const { ITEMS } = await import("../../src/ba_modding_toolkit/web/js/nav-items.js");
const meta = Object.fromEntries(ITEMS.map((item, i) => [item.icon, { width: 1100 + i * 130, height: 1400 - i * 120 }]));
Object.assign(meta, { Common_Top_Home_Btn: { width: 62, height: 59 }, Common_Top_Option_Btn: { width: 60, height: 62 },
  Common_Square_Bg: { width: 4, height: 49 } });
globalThis.Image = class {
  set src(url) {
    const image = blobs.get(url) || meta[url.split("/").at(-1).replace(/\.png$/, "")];
    assert.ok(image, url); this.naturalWidth = image.width; this.naturalHeight = image.height;
    queueMicrotask(() => this.onload?.());
  }
};
const lobby = n("UILobby"), collection = n("UICharacterCollection");
insert(lobby, "Front/Bottom/Menu/BG/BG", n("BG"));
insert(lobby, "Front/Bottom/Menu/BG/Grid", n("Grid", [0, 0], [], ITEMS.map((item, i) => {
  const entry = n(`Entry${i}`, [i * 200, 0], [], [
    n("Label", [5, 8 + i * 2], [{ text: "Label", fontSize: 39, w_: 200, h_: 40, pivot: 4, color: "#2c4564/1.00" }],
      [n("IconPlus", [77, 9], [spr("Common_Icon_Minus", 20, 22)])]),
    n("Able", [0, 94 + i], [spr(item.icon, 108 + i * 30, 130 + i * 20)]),
    n("Disable", [0, 0], [], [n("Icon", [0, 94 + i], [spr(item.icon, 108 + i * 30, 130 + i * 20)]), n("Lock")]),
  ]);
  entry.scale = [1 + i * 0.1, 1]; return entry;
})));
insert(collection, "SeletControl/Top/BG_W/Bg/Btn", n("Btn"));
insert(collection, "NUITop_Scenes/Top/Right/Option", n("Option", [-272.8, -52.4], [spr("Common_Top_Option_Btn", 60, 62)]));
insert(collection, "NUITop_Scenes/Top/Right/Lobby", n("Lobby", [-98.8, -51.8], [spr("Common_Top_Home_Btn", 62, 59)]));
insert(collection, "NUITop_Scenes/Top/Right/Line (1)", n("Line (1)", [-186.3, -54.2], [spr("Common_Square_Bg", 4, 49)]));
globalThis.fetch = async (url) => ({ ok: true, json: async () => {
  if (url.endsWith("atlases.json")) return { Common: meta };
  if (url.endsWith("textures.json")) return {};
  if (url.endsWith("UILobby.json")) return lobby;
  if (url.endsWith("UICharacterCollection.json")) return collection;
  assert.fail(url);
} });
const { renderNav } = await import("../../src/ba_modding_toolkit/web/js/nav.js");
const { setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
const { S } = await import("../../src/ba_modding_toolkit/web/js/util.js");
const flat = (value, prefix = "", out = {}) => {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "object") flat(item, `${prefix}${key}.`, out); else out[prefix + key] = item;
  }
  return out;
};

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`all seven nav entries fit their buttons with a shared icon box and label baseline in ${locale}`, async () => {
  document.documentElement.lang = locale;
  setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"))));
  await renderNav(1, { game: true });
  assert.equal(host.children.length, 7);
  const labelTops = [], iconTops = [];
  host.children.forEach((button, i) => {
    const label = button.children.find((e) => e.dataset.path.endsWith("/Label"));
    const icon = button.children.find((e) => /\/(Able|Disable\/Icon)$/.test(e.dataset.path));
    assert.equal(icon.style.backgroundSize, "contain");
    assert.ok(Math.abs(parseFloat(icon.style.width) - 80 * S) < 0.01);
    assert.ok(parseFloat(icon.style.top) >= 0, "icons stay inside the bar, below the panels");
    assert.ok(parseFloat(icon.style.top) + parseFloat(icon.style.height) < parseFloat(label.style.top), "icons clear the labels");
    assert.equal(icon.style.width, icon.style.height);
    iconTops.push(icon.style.top);
    const url = /url\("(.+)"\)/.exec(icon.style.backgroundImage)[1], encoded = blobs.get(url);
    const native = meta[ITEMS[i].icon];
    // Integer raster dimensions can round by half a pixel on each axis.
    assert.ok(Math.abs(encoded.width * native.height - encoded.height * native.width) <= (native.width + native.height) / 2 + 1,
      `resampling preserves the native sprite aspect before CSS containment: ${encoded.width}x${encoded.height} from ${native.width}x${native.height}`);
    const bottom = parseFloat(label.style.top) + parseFloat(label.style.height);
    assert.ok(bottom <= 104 - 20 * S, "labels leave the game's half-label-height bottom inset");
    assert.ok(parseFloat(label.style.left) >= 0 && parseFloat(label.style.left) + parseFloat(label.style.width) <= parseFloat(button.style.width));
    assert.ok(!label.textContent.includes("\n")); labelTops.push(label.style.top);
    assert.ok(!button.children.some((e) => e.dataset.path.endsWith("/Lock")));
    assert.ok(!button.children.some((e) => e.dataset.path.includes("/IconPlus")), "donor submenu badges are removed");
  });
  assert.equal(new Set(labelTops).size, 1);
  assert.equal(new Set(iconTops).size, 1);
});

test("Home, settings and divider retain the game's native sibling spacing", async () => {
  await renderNav(-1, { game: true });
  const center = (selector) => {
    const style = top[selector].style;
    return [parseFloat(style.right) + parseFloat(style.width) / 2,
      parseFloat(style.top) + parseFloat(style.height) / 2];
  };
  const home = center(".top-home"), option = center(".top-option"), line = center(".top-line");
  assert.ok(Math.abs(option[0] - home[0] - 174 * S) < 0.001);
  assert.ok(Math.abs(option[1] - home[1] - .6 * S) < 0.001);
  assert.ok(Math.abs(line[0] - home[0] - 87.5 * S) < 0.001);
  assert.ok(top[".top-home"].children.some((el) => el.dataset.path === "Lobby"));
  assert.ok(!host.children.some((button) => button.attrs["aria-current"]), "the hall has no bottom-nav selection");
});

test('Hall reflows Settings into Home and restores sibling geometry across repeated transitions',async()=>{
  const {setTopActions}=await import('../../src/ba_modding_toolkit/web/js/nav.js');
  await renderNav(-1,{game:true});
  const original=structuredClone(Object.fromEntries(Object.entries(top).map(([key,node])=>[key,node.style])));
  const centre=style=>[parseFloat(style.right)+parseFloat(style.width)/2,parseFloat(style.top)+parseFloat(style.height)/2];
  for(let i=0;i<3;i++){
    setTopActions(true,true);
    assert.ok(centre(top['.top-option'].style).every((v,i)=>Math.abs(v-centre(original['.top-home'])[i])<1e-8));
    assert.equal(top['.top-home'].hidden,true);assert.equal(top['.top-line'].hidden,true);
    assert.equal(top['.top-option'].style.width,original['.top-option'].width);
    assert.equal(top['.top-option'].style.height,original['.top-option'].height);
    setTopActions(false,true);
    for(const key of Object.keys(top))assert.deepEqual(top[key].style,original[key]);
    assert.equal(top['.top-home'].hidden,false);assert.equal(top['.top-line'].hidden,false);
  }
});
test('native-control clearance is preserved at fractional window scales',async()=>{
  const {topActionLayout,nativeRightClearance}=await import('../../src/ba_modding_toolkit/web/js/top-action-layout.js');
  const boxes={home:[44,7,62*S,59*S],option:[158,7,60*S,62*S],line:[120,12,4*S,49*S]};
  for(const scale of [.5,.75,1,1.25,1.5,2]){
    const stage={left:0,top:0,right:1920*scale,width:1920*scale},controls={left:stage.right-108,top:0,bottom:24,width:108};
    const base=topActionLayout(boxes,true),safe=nativeRightClearance(stage,controls,base.option);
    const next=topActionLayout(boxes,true,safe),option=next.option;
    if(safe)assert.ok(stage.right-option[0]*scale<=controls.left-8+1e-8);
    assert.deepEqual(option.slice(2),boxes.option.slice(2));
    assert.equal(topActionLayout(boxes,false,0).option[0],158);
  }
});

test('Hall removes Back and moves the title slot; leaving restores Back for its current route',async()=>{
  const {setTitle,setTopActions}=await import('../../src/ba_modding_toolkit/web/js/nav.js');
  const classes=new Set();
  top['.topbar']=Object.assign(new El(),{classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}});
  top['.topbar .title']=new El();
  const back=top['.topbar .back'],action=()=>{};
  for(let i=0;i<3;i++){
    setTopActions(false);setTitle('Students',action);
    assert.equal(back.hidden,false);assert.equal(back.onclick,action);
    setTopActions(true);setTitle('Student Hall',action);
    assert.equal(back.hidden,true);assert.ok(classes.has('hall-home'));
    setTopActions(false);setTitle('Batch Import',action);
    assert.equal(back.hidden,false);assert.ok(!classes.has('hall-home'));
    setTitle('Students',null);assert.equal(back.hidden,true);
  }
});
