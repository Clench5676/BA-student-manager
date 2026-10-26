import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const S = 1920 / 2960;
const node = (name, children = [], widgets = [], more = {}) => ({ name, children, widgets, pos: [0, 0], scale: [1, 1], active: true, ...more });
const sprite = (name, w, h, color, depth = 3) => ({ cls: "UISprite", atlas: "Common", sprite: name, w_: w, h_: h, color, depth, type: 1 });
// Derived metadata from UILobby's authored enabled loop and duty-selector controls.
const bg = node("Bg", [], [sprite("Common_Bg_Raius5px_Shadow", 156, 104, "#ffffff/0.92", 2)]);
const loop = node("Able_Count", [bg, node("Icon", [], [sprite("Common_Icon_Change_Count", 116, 84, "#466399/1.00")], { pos: [3, 8], scale: [.9, .9] }), node("Label_SpineCount", [], [{ text: "9/9", color: "#466399/1.00" }])]);
const duty = (name, tint) => node(name, [node("Icon", [], [sprite("Common_Icon_SpecialLobby", 68, 68, tint, 5)])]);
const lobby = node("UILobby", [node("Front", [node("Right", [node("Btn_RotateSpine", [node("ConditionRoot", [loop])]), node("Btn_Screen_On", [structuredClone(bg),node("Icon",[],[sprite("Common_UIHide_Icon",75,63,"#466399/1.00")],{pos:[3,8],scale:[.85,.85]})])]), node("NUITop", [node("Top", [node("Right", [node("Btn_LobbyCharacter", [duty("Able", "#466399/1.00"), duty("Disable", "#2f3c52/1.00")])])])])])]);
function find(tree, path) { return path.split("/").reduce((n, name) => n.children.find((c) => c.name === name), tree); }
let rendered, wired = [], drawnIcons = new Map(), alignedIcons = new Map();
globalThis.hallControlsHarness = { S, clone: structuredClone, NGUI: { find, node: (name,pos,widgets,children) => node(name,children,widgets,{pos}), async render(tree) {
    rendered = tree;
    const nodes = new Map();
    if (tree.name.startsWith("Portrait")) {
      const entry = { node: find(tree, "Icon"), els: [{ style: { transform: "scale(1, 1)" } }] };
      nodes.set(`${tree.name}/Icon`, entry); drawnIcons.set(tree.name, entry);
    }
    return { nodes };
  } },
  async alignIcon(view,path,backgroundPath,options){
    alignedIcons.set(path,options);const entry=view.nodes.get(path); if(!entry)return;
    Object.assign(entry.els[0].style,{transform:options.rotation?`rotate(${-options.rotation}deg)`:"",transformOrigin:"50% 50%"});
  },
  text(tree, path, value) { find(tree, path).widgets[0].text = value; },
  UI: { scaleControl: async () => {} }, T: (key) => `localized:${key}`, Popup: { hit(host, view, path, fn, meta) { const b = { path, fn, dataset: {}, ...meta }; wired.push(b); return b; } },
  document: { createElement: () => ({ style: {}, children: [], append(child) { this.children.push(child); } }) }, lobby };
let source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall.js", import.meta.url), "utf8");
source = source.replace(/^import .*;$/gm, "");
source = `import { bindCorner } from "${new URL("../../src/ba_modding_toolkit/web/js/corner-layout.js", import.meta.url).href}";\n` + source;
source = `const {S,clone,NGUI,alignIcon,text,T,Popup,document,UI}=globalThis.hallControlsHarness;\n${source}\nexport {lobbyControl,controls,renderChrome,renderPortraitActions};
export function fixture(mode,kind=null,writes=0,portraits=[]){layouts={lobby:globalThis.hallControlsHarness.lobby};store={current:()=>({mode,memorials:[],portraits}),kind:()=>kind};root={};chrome={replaceChildren(){}};pendingWrites=writes;hitGeneration=0;}
//# sourceURL=hall-controls-fixture.js`;
const Hall = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("approved icon-only actions preserve the native background and normalize visual size and vertical center", () => {
  Hall.fixture("portraits");
  for (const [name, expected, width, height] of [["Layout", "Cafe_Icon_NameEdit", 50, 50], ["Background", "Cafe_Icon_Photo", 120, 104], ["Adjust", "Common_Icon_SpecialLobby", 68, 68], ["Add", "Common_Icon_SpecialLobby", 68, 68], ["Mode", "Common_Icon_Change_Count", 116, 84], ["Fullscreen", "Common_UIHide_Icon", 75, 63]]) {
    const tree = Hall.lobbyControl(name, "Unused caption", 1400, 156*S);
    assert.deepEqual(tree.children.map((c) => c.name), ["Bg", "Icon"]);
    assert.deepEqual(find(tree, "Bg"), bg);
    const icon = find(tree, "Icon"); assert.equal(icon.widgets[0].sprite, expected);
    assert.equal(Math.max(icon.widgets[0].w_, icon.widgets[0].h_), 76);
    assert.ok(Math.abs(icon.widgets[0].w_ / icon.widgets[0].h_ - width / height) < 1e-10);
    assert.equal(icon.widgets[0].color, "#466399/1.00");
    assert.deepEqual(icon.scale, [1,1]); assert.deepEqual(icon.pos, [0,0]);
    assert.equal(Hall.lobbyControl(name, "", 1400, 156*S, false).children[1].widgets[0].color, "#2f3c52/1.00");
  }
  assert.equal(find(lobby, "Front/Right/Btn_RotateSpine/ConditionRoot/Able_Count/Label_SpineCount").widgets[0].text, "9/9");
});

test("normal and edit actions pack immediately left of the right-aligned numberless loop", () => {
  for (const [mode, kind] of [["portraits", null], ["portraits", "layout"], ["memorial", null]]) {
    Hall.fixture(mode, kind); const all=Hall.controls(), actions=all.filter((action)=>!action[6]);
    assert.equal(all.some((action)=>action[0]==="Remove"),false);
    const text=all.filter((action)=>action[6]);
    assert.deepEqual(text.map((action)=>action[0]),kind==="layout"?["Cancel","Save"]:[]);
    assert.ok(text.every((action)=>action[6]===230));
    if(text.length){assert.equal(text[0][3],text[1][3]);assert.equal(text[0][2],actions[0][2]);assert.equal(text[1][2]+text[1][3],1875);}
    assert.equal(actions.at(-1)[0], "Fullscreen"); assert.equal(actions.at(-1)[2]+actions.at(-1)[3], 1875);
    for (let i=0; i<actions.length-1; i++) assert.equal(actions[i+1][2]-(actions[i][2]+actions[i][3]),20);
    for (const [name,,x,width] of actions) if (["Layout","Background","Adjust","Add","Mode","Fullscreen"].includes(name)) assert.equal(width,156*S);
  }
});

test("icon actions retain localized accessible names and disable during writes", async () => {
  Hall.fixture("portraits", null, 1); wired=[];await Hall.renderChrome();
  assert.deepEqual(wired.map((b)=>b.name), ["localized:hall.changeLayout","localized:hall.background","localized:hall.memorial","localized:lobby.fullscreen"]);
  assert.ok(wired.every((b)=>b.disabled));
  assert.ok(rendered.children.every((c)=>c.children[1].widgets[0].color==="#2f3c52/1.00"));
  Hall.fixture("portraits", "layout"); wired=[];await Hall.renderChrome();
  assert.ok(wired.some((b)=>b.name==="localized:hall.addPortraits"));
  assert.equal(find(rendered,"Save/Label_SpineCount").widgets[0].text,"localized:popup.save");
  assert.equal(find(rendered,"Cancel/Label_SpineCount").widgets[0].text,"localized:popup.cancel");
});

test("rendered layer arrows rotate in screen coordinates while retaining centered native sprite geometry", async()=>{
  const entries=[{id:"a"},{id:"b"},{id:"c"}];Hall.fixture("portraits","layout",0,entries);drawnIcons=new Map();wired=[];
  const host={style:{},replaceChildren(){}};
  await Hall.renderPortraitActions(host,entries[1],{x:700,y:400,width:500},0);
  for(const [name,rotation] of [["Backward",-180],["Forward",0],["Front",-90],["Back",-270]]){
    const icon=drawnIcons.get(`Portrait${name}`),style=icon.els[0].style,widget=icon.node.widgets[0];
    assert.equal(style.transform,rotation ? `rotate(${rotation}deg)` : "");
    if(rotation)assert.equal(style.transformOrigin,"50% 50%");
    assert.deepEqual(icon.node.pos,[0,0]);assert.deepEqual(icon.node.scale,[1,1]);
    assert.ok(Math.abs(Math.max(widget.w_,widget.h_)-56)<1e-10);
  }
  assert.equal(wired.length,6);assert.ok(wired.every(button=>!button.disabled));
});

test("top-right icons keep the75percent baseline with the photo-only8percent optical adjustment",async()=>{
  Hall.fixture("portraits","layout");alignedIcons=new Map();await Hall.renderChrome();
  assert.equal(alignedIcons.get("Hall/Add/Icon").height,64*S*.75);
  assert.equal(alignedIcons.get("Hall/Background/Icon").height,48*S*1.08);assert.equal(alignedIcons.get("Hall/Mode/Icon").height,48*S);
  Hall.fixture("memorial");await Hall.renderChrome();assert.equal(alignedIcons.get("Hall/Adjust/Icon").height,64*S*.75);
  Hall.fixture("portraits");await Hall.renderChrome();assert.equal(alignedIcons.get("Hall/Layout/Icon").height,48*S);
  for(const name of ["Add","Adjust","Layout","Background"]){assert.equal(alignedIcons.get(`Hall/${name}/Icon`).center,"bounds");assert.equal(alignedIcons.get(`Hall/${name}/Icon`).alphaCutoff,32);}
  assert.equal(alignedIcons.get("Hall/Mode/Icon").center,undefined);assert.equal(alignedIcons.get("Hall/Fullscreen/Icon").height,48*S);
});

test("Hall's real action row measures its top margin below the bar at minimum, default and large sizes", async () => {
  const { CORNER_MARGIN } = await import('../../src/ba_modding_toolkit/web/js/corner-layout.js');
  const { headerGeometry } = await import('../../src/ba_modding_toolkit/web/js/window-layout.js');
  for (const mode of ['portraits', 'memorial']) for (const platform of [null, 'darwin', 'win32']) {
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440], [2560, 1080], [960, 1200]]) {
      const header = platform ? headerGeometry(width, height, platform === 'win32' ? 40 : 0) : null;
      const k = header?.contentScale || Math.min(width / 1920, height / 1080), stageTop = (height - 1080 * k + (header?.extra || 0)) / 2;
      const barBottom = header?.rowHeight || 64 * k;
      globalThis.document = { getElementById: () => ({ getBoundingClientRect: () => ({ left: (width - 1920 * k) / 2, top: stageTop, width: 1920 * k }) }),
        querySelector: () => ({ getBoundingClientRect: () => ({ bottom: barBottom }) }) };
      Object.assign(globalThis, { innerWidth: width, innerHeight: height, bamtHeaderGeometry: header,
        bamtWindowChrome: platform ? { active: true, platform, bounds: platform === 'darwin'
          ? { left: 12, top: 8, right: 80, bottom: 30 } : { left: width - 148, top: 8, right: width, bottom: 40 } } : null });
      Hall.fixture(mode); const destination = await Hall.renderChrome({ publish: false });
      const [dx, dy] = destination.children[0].style.translate.split(' ').map(parseFloat);
      const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
      near(stageTop + (145 - 104 * S / 2 + dy) * k - barBottom, CORNER_MARGIN * k);
      near(width - ((width - 1920 * k) / 2 + (1875 + dx) * k), CORNER_MARGIN * k);
      assert.ok(rendered.children.every(node => node.children[0].widgets[0].h_ === 104));
    }
  }
});
