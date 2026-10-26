import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createDraft, sourceKey } from "../../src/ba_modding_toolkit/web/js/student-hall-model.js";
import { createMemorialPool } from "../../src/ba_modding_toolkit/web/js/student-hall-memorial.js";
import { dialogueText } from "../../src/ba_modding_toolkit/web/js/dialogue-text.js";
import { sceneRect, sceneViewport } from "../../src/ba_modding_toolkit/web/js/student-hall-camera.js";
import { portraitRect } from "../../src/ba_modding_toolkit/web/js/student-hall-framing.js";

class Element {
  constructor() { this.style={};this.dataset={};this.children=[];this.listeners={};this.isConnected=true; }
  append(...children) { for (const child of children) { child.parentElement=this;this.children.push(child); } }
  replaceChildren(...children) { this.children=[];this.append(...children); }
  replaceWith(next) { const parent=this.parentElement;if(parent){const at=parent.children.indexOf(this);parent.children[at]=next;next.parentElement=parent;}this.isConnected=false; }
  remove() { if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.isConnected=false; }
  cloneNode(deep) { const copy=new Element();copy.style={...this.style};copy.dataset={...this.dataset};if(deep)copy.append(...this.children.map(child=>child.cloneNode(true)));return copy; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener(name,fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute(name,value) { this[name]=value; }
  setPointerCapture() {}
  contains(node) { return this===node || this.children.some(child=>child.contains?.(node)); }
  closest() { return this.dataset.entry ? this : this.parentElement?.closest?.() || null; }
  getBoundingClientRect() { return {width:1920,top:0}; }
  emit(name,event={}) { for(const fn of this.listeners[name]||[]) fn(event); }
}
const saved=()=>({revision:0,mode:"portraits",background:"office-day",portraitScale:1,portraits:["a","b","c"].map((id)=>({id,variant:id,source:`mod:${id}`,x:700,y:1100,scale:1})),memorials:[],active:null});
let loads=0,disposals=0,holds=0,updates=0,persisted=[],buttons=[],chromeDelay=null,testLanguage="en-US";
const renderer={actors:new Map(),allowed:true,needsLoad:()=>false,dispose(){disposals++;},setScale(){},update(entries){updates++;const previous=new Map(this.actors);this.actors.clear();for(const entry of entries)this.actors.set(entry.id,{...previous.get(entry.id),entry});return Promise.resolve(true);}};
globalThis.sceneHarness={
  createDraft,createMemorialPool,sourceKey,portraitRect,sceneRect,sceneViewport,dialogueText,language:()=>testLanguage,clone:structuredClone,S:1920/2960,T:(key)=>key,L:(names)=>names?.en,
  document:{createElement:()=>new Element(),activeElement:null,removeEventListener(){}},
  Backgrounds:{backgroundChoice:()=>({name:"office-day"}),render:async()=>{loads++;}},
  Loading:{hold:async(fn)=>{holds++;return fn();}},
  Lobby:{hide(){}},Popup:{notify(){}},
  UI:{button:async()=>{},caption:async()=>{}},
  rpc:async(method,params)=>{if(method==="lobby.lines")return globalThis.sceneHarness.lineResponse(params);const {value,revision}=params;persisted.push(method);return {...structuredClone(value),revision:revision+1};},
  hitButton(parent,rect,click,label){const button=new Element();button.label=label;button.rect=rect;button.addEventListener("click",click);parent.append(button);buttons.push(button);return button;},
};
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall.js",import.meta.url),"utf8");
source=source.replace(/^import .*;$/gm,"");
source=`const {createDraft,createMemorialPool,sourceKey,portraitRect,sceneRect,sceneViewport,dialogueText,language,clone,S,T,L,document,Backgrounds,Loading,Lobby,Popup,UI,rpc,hitButton}=globalThis.sceneHarness;\n${source}
const originalHits=renderHits;
export function fixture(value,renderer,memory=null,shownMode=value.mode){
 store=createDraft(value);root=document.createElement('div');art=document.createElement('div');hits=document.createElement('div');chrome=document.createElement('div');subtitle=document.createElement('div');root.append(art,hits,chrome,subtitle);
 portraits=renderer;abort=new AbortController();sceneMode=shownMode;backgroundName='office-day';backgroundHost=document.createElement('div');portraitSceneHost=document.createElement('div');art.append(portraitSceneHost);ctx={prefs:{},info:{}};actorHover=null;sceneCover=null;fullscreen=null;sceneCamera=null;dialogue=null;
 memorials=memory||{current:()=>null,suspend(){},cancelPending(){},dispose(){}};
 options={choices:[...value.portraits.map(e=>({...e,kind:'spr',names:{en:{full:e.id}}})),...value.memorials.map(e=>({...e,kind:'lobby',names:{en:{full:e.id}}}))],backgrounds:[]};
 renderChrome=async()=>{await globalThis.sceneHarness.chromeReady?.();return document.createElement('div');};renderHits=()=>Promise.resolve();renderPortraitActions=async()=>{};
}
export function elements(){return {root,art,hits,chrome,portraitSceneHost,sceneCover,sceneMode};}
export function immersiveFixture(active,onPlay){fullscreen={active:()=>active,dispose(){}};dialogue={play:onPlay};}

export function draft(){return store;} export {controls,saveDraft,cancelDraft,renderScene,portraitActions,createHoverOwner,memorial,step,refreshMemorialCaptions};
export function cameraFixture(view){sceneCamera={view:()=>view,sync(){},dispose(){}};}
export function hitsNow(){originalHits();return hits;}`;
// The fixture is intentionally DOM-only; actual Spine identities and GPU resource reuse are covered by student_hall.test.
source += "\n//# sourceURL=hall-scene-fixture.js";
const Hall=await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function setup(){loads=disposals=holds=updates=0;persisted=[];buttons=[];chromeDelay=null;globalThis.sceneHarness.chromeReady=()=>chromeDelay;const value=saved();renderer.actors=new Map(value.portraits.map(entry=>[entry.id,{entry,player:{animationState:{trackTime:18}}}]));Hall.fixture(value,renderer);return value;}

test("Change Layout Save and Cancel reconcile the existing scene without loading, holds or disposal",async()=>{
  setup();const before=[...renderer.actors.values()].map(actor=>actor.player);
  await Hall.controls().find(action=>action[0]==="Layout")[4]();
  Hall.draft().current().portraits[0].x=900;await Hall.saveDraft();
  assert.equal(Hall.draft().saved().portraits[0].x,900);assert.deepEqual(persisted,["hall.update"]);
  await Hall.controls().find(action=>action[0]==="Layout")[4]();Hall.draft().current().portraits[0].x=1200;await Hall.cancelDraft();
  assert.equal(renderer.actors.get("a").entry.x,900);
  assert.deepEqual([...renderer.actors.values()].map(actor=>actor.player),before);
  assert.ok(before.every(player=>player.animationState.trackTime===18));assert.equal(updates,4);
  assert.equal(loads,0);assert.equal(disposals,0);assert.equal(holds,0);
});
test("portrait hit order follows saved layer order and wheel or keys cannot mutate relative size",async()=>{
  const value=setup();Hall.draft().begin("layout");Hall.draft().layer("a","front");Hall.hitsNow();
  assert.deepEqual(buttons.map(button=>button.dataset.entry),["b","c","a"]);
  for(const button of buttons){button.emit("wheel",{deltaY:-120,preventDefault(){}});button.emit("keydown",{key:"+",preventDefault(){}});}
  assert.deepEqual(Hall.draft().current().portraits.map(entry=>entry.scale),[1,1,1]);
  assert.ok(buttons.every(button=>!button.listeners.wheel&&!button.listeners.keydown));
  assert.equal(Hall.draft().current().portraitScale,1);assert.equal(value.portraits[0].scale,1);
});
test("two-or-more portrait layouts offer layer and flip actions, with boundary moves disabled",()=>{
  setup();Hall.draft().begin("layout");
  const list=Hall.draft().current().portraits;
  assert.equal(Hall.portraitActions(list[0]).length,6);
  assert.equal(Hall.portraitActions(list[0]).find(action=>action[0]==="Backward")[3],false);
  assert.equal(Hall.portraitActions(list[2]).find(action=>action[0]==="Front")[3],false);
  Hall.draft().remove("c");assert.equal(Hall.portraitActions(list[0]).length,6);
  Hall.draft().remove("b");assert.deepEqual(Hall.portraitActions(list[0]),[]);assert.equal(Hall.draft().remove("a"),false);
});

test("one hover owner keeps its palette during pointer entry, focus loss and overlapping actor entry",()=>{
  const shown=[],hover=Hall.createHoverOwner((id)=>shown.push(id));
  hover.focus("a");hover.paletteEnter();hover.focus(null);hover.actorEnter("b");
  assert.equal(hover.snapshot().owner,"a");assert.deepEqual(shown,["a"]);
  hover.paletteLeave("b");assert.equal(hover.snapshot().owner,"b");
  hover.actorLeave("b");assert.equal(hover.snapshot().owner,null);
});
test("actor to palette transitions never hide the palette before its pointerenter or click",()=>{
  const shown=[],hover=Hall.createHoverOwner((id)=>shown.push(id));
  hover.actorEnter("a");hover.actorLeave("a",true);hover.focus(null);hover.paletteEnter();
  assert.deepEqual(shown,["a"]);hover.paletteLeave();assert.deepEqual(shown,["a",null]);
  hover.focus("b");hover.actorEnter("b");hover.focus(null);assert.equal(hover.snapshot().owner,"b");
  hover.actorLeave("b");assert.equal(hover.snapshot().owner,null);
});

test("the shared action palette stays above every hit rectangle through real focusout and pointer events",async()=>{
  setup();Hall.draft().begin("layout");const hits=Hall.hitsNow(),palette=hits.children.at(-1);
  assert.equal(palette.style.zIndex,"1000");assert.equal(palette.style.pointerEvents,"auto");
  buttons[0].emit("focusin");assert.equal(palette.dataset.actorToolbar,"a");
  palette.emit("pointerdown");globalThis.sceneHarness.document.activeElement=null;buttons[0].emit("focusout");
  await Promise.resolve();buttons[1].emit("pointerenter");
  assert.equal(palette.dataset.actorToolbar,"a");assert.equal(palette.style.visibility,"");
  palette.emit("pointerleave",{relatedTarget:buttons[1]});assert.equal(palette.dataset.actorToolbar,"b");
});

test("lost pointer capture or released buttons end dragging before any later movement",()=>{
  setup();Hall.draft().begin("layout");Hall.hitsNow();const entry=Hall.draft().current().portraits[0],initial=entry.x,button=buttons[0];
  button.emit("pointerdown",{clientX:100,clientY:100,pointerId:1,preventDefault(){}});
  button.emit("lostpointercapture");button.emit("pointermove",{clientX:200,clientY:100,buttons:0});assert.equal(entry.x,initial);
  const fresh=buttons.at(-3);fresh.emit("pointerdown",{clientX:100,clientY:100,pointerId:2,preventDefault(){}});
  fresh.emit("pointermove",{clientX:200,clientY:100,buttons:0});assert.equal(entry.x,initial);
});

const tick=()=>new Promise(setImmediate);
function memoryFixture(){
  const events=[],players=[0,1].map(index=>({index,suspended:true,suspend(){if(!this.suspended)events.push(["suspend",index]);this.suspended=true;},resume(){if(this.suspended)events.push(["resume",index]);this.suspended=false;},async prepareFrame(){events.push(["frame",index]);return true;},hide(){events.push(["hide",index]);},setVolume(){},setZoomLimit(){},setPostProcessing(){},setIntro(){}}));
  let loadDelay=null;
  const pool=createMemorialPool({moduleFor:async index=>players[index],load:async(choice,host,signal,player)=>{events.push(["load",player.index,choice.source]);await loadDelay;return true;}});
  return {pool,players,events,delay(value){loadDelay=value;}};
}
test("a mode transition retains old complete art and controls until target resources and chrome are both ready",async()=>{
  const value=setup();value.memorials=[{id:"m1",variant:"memory",source:"mod:memory"}];value.active="m1";
  const memory=memoryFixture();Hall.fixture(value,renderer,memory.pool);const before=Hall.elements(),oldChrome=new Element();before.chrome.append(oldChrome);
  let resourcesReady,chromeReady;memory.delay(new Promise(resolve=>{resourcesReady=resolve;}));chromeDelay=new Promise(resolve=>{chromeReady=resolve;});
  Hall.draft().current().mode="memorial";const pending=Hall.renderScene();await tick();
  assert.equal(before.chrome.children[0],oldChrome);assert.equal(before.hits.isConnected,true);assert.equal(memory.events.some(event=>event[0]==="resume"),false);
  resourcesReady();await tick();assert.equal(before.chrome.children[0],oldChrome);assert.equal(before.hits.isConnected,true);
  chromeReady();await pending;assert.notEqual(before.chrome.children[0],oldChrome);assert.equal(before.hits.isConnected,false);
  assert.equal(Hall.elements().sceneMode,"memorial");assert.equal(before.portraitSceneHost.style.visibility,"hidden");assert.equal(memory.pool.current().host.style.visibility,"");
});
test("playlist edits and source-identical active UUID changes never restart the retained memorial",async()=>{
  const value=setup();value.mode="memorial";value.memorials=[{id:"m1",variant:"memory",source:"mod:memory"},{id:"m2",variant:"other",source:"mod:other"}];value.active="m1";
  const memory=memoryFixture(),session=await memory.pool.prepare(value.memorials[0],()=>new Element(),new AbortController().signal);memory.pool.commit(session);memory.pool.resume();
  Hall.fixture(value,renderer,memory.pool);memory.events.length=0;
  Hall.draft().begin("memorial");Hall.draft().current().memorials.reverse();await Hall.renderScene();await Hall.saveDraft();
  Hall.draft().begin("memorial");Hall.draft().current().memorials[1].id="replacement-id";Hall.draft().current().active="replacement-id";await Hall.renderScene();await Hall.cancelDraft();
  assert.deepEqual(memory.events,[]);assert.equal(memory.pool.current(),session);
});
test("portraits and the last memorial survive round trips with one memory load and stable player identity",async()=>{
  const value=setup();value.memorials=[{id:"m1",variant:"memory",source:"mod:memory"}];value.active="m1";
  const memory=memoryFixture();Hall.fixture(value,renderer,memory.pool);
  Hall.draft().current().mode="memorial";await Hall.renderScene();const retained=memory.pool.current();
  Hall.draft().current().mode="portraits";await Hall.renderScene();Hall.draft().current().mode="memorial";await Hall.renderScene();
  assert.equal(memory.pool.current(),retained);assert.equal(memory.events.filter(event=>event[0]==="load").length,1);assert.equal(memory.events.filter(event=>event[0]==="hide").length,0);
  assert.equal(memory.events.filter(event=>event[0]==="resume").length,2);assert.equal(disposals,0);
});

test("the real memorial wrapper rejects null metadata or a false frame result before its ready contract",async()=>{
  setup();const host=new Element(),signal=new AbortController().signal,choice={variant:"m",core:"m",source:"official"};
  const player={setVolume(){},setZoomLimit(){},setPostProcessing(){},setIntro(){},frame(){},interactive(){},show:async()=>null,prepareFrame:async()=>false};
  await assert.rejects(Hall.memorial(choice,host,signal,player),/source is unavailable/);
  player.show=async()=>({sequences:[]});await assert.rejects(Hall.memorial(choice,host,signal,player),/frame is unavailable/);
});
test("Next then Previous during staging cancels the pending source and resumes the retained current memory",async()=>{
  const value=setup();value.mode="memorial";value.memorials=[{id:"m1",variant:"a",source:"mod:a"},{id:"m2",variant:"b",source:"mod:b"}];value.active="m1";
  const memory=memoryFixture(),session=await memory.pool.prepare(value.memorials[0],()=>new Element(),new AbortController().signal);memory.pool.commit(session);memory.pool.resume();
  Hall.fixture(value,renderer,memory.pool);memory.events.length=0;let finish;
  memory.delay(new Promise(resolve=>{finish=resolve;}));const next=Hall.step(1);await tick();assert.equal(session.player.suspended,true);
  await Hall.step(-1);assert.equal(memory.pool.current(),session);assert.equal(session.player.suspended,false);assert.equal(Hall.draft().saved().active,"m1");
  finish();await next;assert.equal(memory.pool.current(),session);assert.equal(session.player.suspended,false);
  assert.deepEqual(memory.events.filter(event=>event[0]==="resume"),[["resume",0]]);
});

test("immersive portrait interaction preserves its draft and renderer while disabling editing gestures",async()=>{
  setup();Hall.draft().begin("layout");const entry=Hall.draft().current().portraits[0],actor=renderer.actors.get(entry.id),before=structuredClone(entry);let spoken=null;
  Hall.immersiveFixture(true,async value=>{spoken=value.id;});Hall.hitsNow();
  const target=buttons[0];target.emit("pointerdown",{clientX:100,clientY:100,pointerId:1,preventDefault(){}});target.emit("pointermove",{clientX:300,clientY:400,buttons:1});target.emit("click");await Promise.resolve();
  assert.deepEqual(entry,before);assert.equal(spoken,entry.id);assert.equal(renderer.actors.get(entry.id),actor);assert.equal(Hall.draft().kind(),"layout");assert.equal(updates,0);assert.equal(disposals,0);
  Hall.immersiveFixture(false,async()=>{});
});

test("viewing zoom projects every portrait hit with the artwork, and editing keeps original layout coordinates",()=>{
  setup();Hall.hitsNow();const before=buttons.slice(-3).map(button=>button.rect);
  Hall.cameraFixture({scale:2,x:-500,y:-200});Hall.hitsNow();const after=buttons.slice(-3).map(button=>button.rect);
  for(let i=0;i<before.length;i++)assert.deepEqual(after[i],[before[i][0]*2-500,before[i][1]*2-200,before[i][2]*2,before[i][3]*2]);
  Hall.draft().begin("layout");Hall.hitsNow();assert.deepEqual(buttons.slice(-3).map(button=>button.rect),before);
});

test("a retained memorial changes caption language without replaying and rejects stale language requests",async()=>{
  setup();const controller=new AbortController(),source={variant:"hero",talks:{Talk_01_M:["voice"]},signal:controller.signal};
  const requests=[],published=[];let oldReady;
  globalThis.sceneHarness.lineResponse=params=>{requests.push(params);return params.lang==="ja"?new Promise(resolve=>{oldReady=resolve;}):Promise.resolve({voice:{"zh-CN":"Current Chinese",ja:"Original"}});};
  const player={setLines:(rows,text)=>published.push({rows,text}),show(){assert.fail("Localization cannot restart the scene");}};
  testLanguage="ja-JP";const old=Hall.refreshMemorialCaptions(player,source);testLanguage="zh-CN";await Hall.refreshMemorialCaptions(player);
  assert.equal(requests[1].lang,"zh-TW");const tables=published.filter(value=>value.rows!==undefined);
  assert.equal(tables[0].text(tables[0].rows.voice),"Current Chinese");
  assert.equal(published[1].text({ja:"Old foreign line"}),"");
  oldReady({voice:{ja:"Obsolete"}});await old;assert.equal(published.filter(value=>value.rows!==undefined).length,1);
  controller.abort();await Hall.refreshMemorialCaptions(player);assert.equal(requests.length,2);
});
