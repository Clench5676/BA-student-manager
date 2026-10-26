import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { withTimeout } from "../../src/ba_modding_toolkit/web/js/async.js";
class Element {
  constructor(id = "") { this.id=id;this.style={};this.dataset={};this.children=[];this.listeners={};this.inert=false;this.isConnected=true;this.scrollTop=0;this.scrollLeft=0; }
  append(el) { el.parentElement=this;this.children.push(el); }
  remove() { this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter((e)=>e!==this); }
  addEventListener(key,fn) { (this.listeners[key] ||= []).push(fn); }
  removeEventListener(key,fn) { this.listeners[key]=(this.listeners[key]||[]).filter((x)=>x!==fn); }
  emit(key) { for(const fn of this.listeners[key]||[])fn({}); }
  setAttribute() {} focus() { globalThis.document.activeElement=this; }
  replaceChildren(...children) { for(const child of [...this.children])child.remove();for(const child of children)this.append(child); }
  querySelectorAll(selector) { const all=[];const walk=(node)=>{for(const child of node.children){all.push(child);walk(child);}};walk(this);
    if(selector==='[data-scroll]')return all.filter(node=>node.dataset.scroll);if(selector==='[data-focus-key]')return all.filter(node=>node.dataset.focusKey);return []; }
  querySelector(selector){const all=[];const walk=(node)=>{for(const child of node.children){all.push(child);walk(child);}};walk(this);return selector==='[data-reordering="true"]'?all.find(node=>node.dataset.reordering==='true'):null;}
  setSelectionRange(start){this.selectionStart=start;}
}
let stage=new Element("stage"),top;
globalThis.document={createElement:()=>new Element(),getElementById:()=>stage,activeElement:null};
const find=(tree,path)=>path.split("/").reduce((node,key)=>node.children.find((child)=>child.name===key),tree);
globalThis.uiHarness={withTimeout,Loading:{hold:async(work)=>work()},T:key=>key,clone:structuredClone,NGUI:{find,fitLabel(widget,text){widget.text=text;}},Popup:{opened(host,close){top={host,close};},closed(){top=null;},top:()=>top}};
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall-ui.js",import.meta.url),"utf8");
source=source.replace(/^import .*;$/gm,"");source=`const {Popup,clone,NGUI,Loading,withTimeout,T}=globalThis.uiHarness; const S=1920/2960;\n${source}\nexport function areaFixture(fn){area=fn;} export function assetsFixture(value){assets=value;} export function readinessFixture(host,fn){visibleReadiness.set(host,fn);} export {pictureReadiness};\n//# sourceURL=hall-ui-fixture.js`;
const UI=await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
UI.areaFixture((host,box,height,key)=>{const scroll=new Element();scroll.dataset.scroll=key;scroll.isConnected=host.isConnected;const inner=new Element();scroll.append(inner);host.append(scroll);return inner;});
const settle=()=>new Promise((resolve)=>setTimeout(resolve,40));
test("true Hall modals block base navigation and restore nested ownership in order",()=>{
  stage=new Element("stage");const nav=new Element("nav"),screen=new Element("screen-hall"),display=new Element("display");stage.append(nav);stage.append(screen);stage.append(display);
  const first=UI.createModal("Picker",()=>{});assert.equal(first.host.style.zIndex,"1250");assert.equal(nav.inert,true);assert.equal(screen.inert,true);assert.equal(display.inert,false);
  const second=UI.createModal("Preview",()=>{},{level:1});assert.equal(first.host.inert,true);second.close();assert.equal(first.host.inert,false);assert.equal(nav.inert,true);
  first.close();assert.equal(nav.inert,false);assert.equal(screen.inert,false);
});
test("large candidate lists construct only visible rows plus overscan",async()=>{
  const host=new Element(),controller=new AbortController(),built=[];
  const list=UI.virtualArea(host,[0,0,500,250],10000,100,(cell,index)=>built.push(index),{key:"many",signal:controller.signal});await list.ready;
  assert.deepEqual(built,[0,1,2,3]);list.inner.parentElement.scrollTop=1000;list.inner.parentElement.emit("scroll");await settle();
  assert.deepEqual(built.slice(4),[9,10,11,12,13]);assert.equal(list.inner.children.length,5);controller.abort();
});
test("independent horizontal strips retain offsets when their row is recycled",async()=>{
  const positions=new Map(),controller=new AbortController();
  const first=UI.virtualArea(new Element(),[0,0,300,100],100,100,()=>{},{key:"student-a",horizontal:true,signal:controller.signal,positions});await first.ready;
  first.inner.parentElement.scrollLeft=480;first.inner.parentElement.emit("scroll");controller.abort();
  const built=[];const next=UI.virtualArea(new Element(),[0,0,300,100],100,100,(_,i)=>built.push(i),{key:"student-a",horizontal:true,positions});await next.ready;
  assert.equal(next.inner.parentElement.scrollLeft,480);assert.deepEqual(built,[3,4,5,6,7,8]);next.dispose();
});

test("formation cards retain native frame geometry while removing sample player stats and selection marks",()=>{
  const n=(name,children=[],widgets=[])=>({name,children,widgets,pos:[0,0],scale:[1,1]});
  const normal=n("Normal",[n("Active"),n("Card_Bg_Line"),n("Card_Bg_Line (1)"),n("Card_Char",[],[{texture:"sample",w_:252,h_:204}]),n("Card_Level",[],[{text:"Lv.90"}]),n("Card_Star"),n("Cover_Sell_Select",[n("Mark")])]);
  const selection=n("Cover_Sell_Select",[n("Mark",[],[{sprite:"Card_Ability_Select_Line_Icon"}])],[{sprite:"Card_Ability_Select_Line",w_:266,h_:353,pivot:4,depth:37}]);selection.pos=[0,-172];
  const card=n("UIPopupFormationCharSlot",[n("Bg"),n("UICharacterCard",[normal]),n("Sprite",[n("Type_2 (1)",[n("Text",[],[{text:"sample"}])]),n("Skill")]),n("Cover_Event_Select",[n("Tag")]),selection,n("FormationMark")],[{sprite:"Formation_SuffCharacter_CoverLine_Btn",w_:256,h_:347,pivot:1}]);
  let formation=card;for(const key of ["UIFormationCharSlotGroup","Grid","Scroll View","Inbox","RightBg","Popup","Center"])formation=n(key,[formation]);
  formation=n("Root",[formation]);
  const result=UI.formationCardTree(formation,{key:"a",name:"Actual Student",thumb:"portrait"},true);
  assert.deepEqual(result.widgets,card.widgets);
  const all=[];const walk=(node)=>{all.push(node);for(const child of node.children||[])walk(child);};walk(result);
  assert.ok(!all.some((node)=>["Card_Level","Card_Star","Cover_Event_Select","FormationMark","Skill","Tag","Mark"].includes(node.name)));
  const outlines=all.filter((node)=>node.name==="Cover_Sell_Select");assert.equal(outlines.length,1);
  assert.deepEqual(outlines[0].widgets,selection.widgets);assert.deepEqual(outlines[0].pos,selection.pos);assert.equal(outlines[0].active,true);assert.deepEqual(outlines[0].children,[]);
  const unselected=UI.formationCardTree(formation,{key:"a",name:"Actual Student",thumb:"portrait"},false);
  assert.equal(find(unselected,"Cover_Sell_Select").active,false);
  const image=all.find((node)=>node.name==="Card_Char").widgets[0];
  assert.equal(image.clipImage,"portrait");assert.equal(image.incline,10);assert.equal(image.radius,18);assert.equal(image.texture,undefined);
  assert.equal(all.find((node)=>node.name==="Text").widgets[0].text,"Actual Student");
});

test("white native row plates reserve equal margins beyond their outer inclined edges",()=>{
  const body={sprite:"Common_Bg_Raius5px_Shadow",type:1,incline:10,w_:622,h_:116,color:"#ffffff/1.00"};
  const n=(name,children=[],widgets=[])=>({name,children,widgets,pos:[0,0]});
  const tree=n("Root",[n("SeletControl",[n("TopMenu",[n("SortBtn",[n("Btn_Normal",[n("Icon")],[body])])])])]);
  const plate=UI.rowPlateTree(tree,[1320,402]),widget=plate.widgets[0],scale=1920/2960;
  assert.equal(widget.sprite,body.sprite);assert.equal(widget.color,body.color);assert.equal(widget.type,1);assert.deepEqual(plate.children,[]);
  const outer=widget.w_*scale+widget.h_*scale*Math.tan(Math.PI/18);
  assert.ok(Math.abs((1320-outer)/2-32)<.001);
  assert.ok(154-600*.46/2>=16);
  assert.ok(154+(600/2+10+88)*.46+8+40<=402-16);
});


test("the memorial queue preserves artwork size, halves the actual gap, and uses native noninclined paper",async()=>{
  const artWidth=(720+405*Math.tan(Math.PI/18))*.25;
  assert.ok(Math.abs((UI.MEMORIAL_QUEUE_PITCH-artWidth)-(290-artWidth)/2)<.001);
  const n=(name,children=[],widgets=[])=>({name,children,widgets,pos:[0,0]});
  const native={sprite:"Common_Bg_Raius10px",w_:2828,h_:1282,pivot:4,type:1,incline:0,color:"#f4fcfe/1.00",depth:7};
  UI.assetsFixture({collection:n("Root",[n("ListBG",[n("PaperBG",[],[native])])])});
  let drawn;globalThis.uiHarness.NGUI.render=async(tree,host,options)=>{drawn={tree,options};};
  await UI.queuePanel(new Element(),[115,720,1685,195]);
  const body=drawn.tree.widgets[0];assert.equal(body.sprite,native.sprite);assert.equal(body.color,native.color);assert.equal(body.incline,0);assert.equal(body.type,1);
  assert.equal(body.w_*(1920/2960),1685);assert.equal(body.h_*(1920/2960),195);assert.deepEqual(drawn.options.origin,[957.5,817.5]);
});

test("queue drag feedback renders a thin native solid blue line rather than a card outline",async()=>{
  const n=(name,children=[],widgets=[])=>({name,children,widgets,pos:[0,0]});
  const blue={sprite:"Common_Line_Raius20px",color:"#0db4ff/1.00"};
  let branch=n("Mulligan_Sub",[],[blue]);for(const name of ["Normal","UICharacterCard","UIPopupFormationCharSlot","UIFormationCharSlotGroup","Grid","Scroll View","Inbox","RightBg"])branch=n(name,[branch]);
  const formation=n("Root",[n("Center",[n("Popup",[branch,n("BG",[n("Label_Title",[n("DecoLine",[],[{sprite:"Common_Line_Dot",color:"#ffee00/0.99",type:1,incline:0}])])])])])]);
  UI.assetsFixture({formation});let drawn;globalThis.uiHarness.NGUI.render=async(tree,host,options)=>{drawn={tree,options};};
  const marker=await UI.queueMarker(new Element(),UI.MEMORIAL_QUEUE_PITCH),widget=drawn.tree.widgets[0];
  assert.equal(widget.sprite,"Common_Line_Dot");assert.equal(widget.color,blue.color);assert.equal(widget.incline,0);
  assert.equal(widget.w_*(1920/2960),2);assert.equal(widget.h_*(1920/2960),155);assert.equal(marker.hidden,true);assert.equal(marker.style.width,"2px");assert.deepEqual(drawn.options.origin,[1,82.5]);assert.deepEqual(drawn.tree.children,[]);
});


const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const micro=()=>new Promise(setImmediate);
test("only visible windows warm detached thumbnail captures, including nested portrait strips",async()=>{
  const captures=[],host=new Element(),controller=new AbortController();host.isConnected=false;
  const list=UI.virtualArea(host,[0,0,500,150],10000,100,async(row,index,rowSignal)=>{
    const strip=UI.virtualArea(row,[0,0,250,100],10000,100,(cell,column)=>UI.readinessFixture(cell,async()=>{captures.push([index,column]);}),{key:`nested-${index}`,horizontal:true,signal:rowSignal});await strip.ready;
  },{key:"rows",signal:controller.signal});await list.ready;
  assert.deepEqual(captures,[]);await UI.prepareVisible(host,controller.signal);
  assert.deepEqual(captures,[[0,0],[0,1],[0,2],[1,0],[1,1],[1,2]]);controller.abort();
});
test("detached virtual windows use saved logical offsets before browser layout exists",async()=>{
  const host=new Element(),built=[],warmed=[],positions=new Map([["offset",[0,500]]]);host.isConnected=false;
  const list=UI.virtualArea(host,[0,0,500,150],100,100,(cell,index)=>{built.push(index);UI.readinessFixture(cell,async()=>warmed.push(index));},{key:"offset",positions});await list.ready;await UI.prepareVisible(host);
  assert.deepEqual(built,[4,5,6,7]);assert.deepEqual(warmed,[5,6]);list.dispose();
});
test("capture completion alone cannot pass the visible thumbnail decode barrier",async()=>{
  const host=new Element(),capture=deferred(),decode=deferred();let starts=0,decoded=false;
  globalThis.uiHarness.NGUI.decoded=async()=>{decoded=true;return decode.promise;};
  UI.pictureReadiness(host,{start(){starts++;}},{thumbnails:[capture.promise]});let ready=false;
  const pending=UI.prepareVisible(host).then(()=>{ready=true;});await micro();assert.equal(starts,1);assert.equal(decoded,false);
  capture.resolve();await micro();assert.equal(decoded,true);assert.equal(ready,false);decode.resolve(true);await pending;assert.equal(ready,true);
});
test("modal redraw retains complete contents and live input until thumbnails and frame decode finish",async()=>{
  UI.assetsFixture({});Object.assign(globalThis.uiHarness.Popup,{popupFrame:()=>({}),closable(){},hit(){}});
  globalThis.uiHarness.NGUI.render=async()=>({});globalThis.uiHarness.NGUI.decoded=async()=>true;
  const modal=UI.createModal("Atomic",()=>{});let oldSignal,oldInput;
  await modal.draw(async(layer,alive,signal)=>{layer.id="old";oldSignal=signal;oldInput=new Element();oldInput.dataset.focusKey="query";oldInput.value="old";layer.append(oldInput);});
  oldInput.focus();const capture=deferred(),decode=deferred();let newInput;
  globalThis.uiHarness.NGUI.decoded=async()=>decode.promise;
  const pending=modal.draw(async(layer)=>{layer.id="new";newInput=new Element();newInput.dataset.focusKey="query";newInput.value="early";layer.append(newInput);UI.readinessFixture(newInput,()=>capture.promise);});
  await micro();oldInput.value="latest input";oldInput.selectionStart=12;
  assert.equal(modal.host.children[0].id,"old");assert.equal(oldSignal.aborted,false);
  capture.resolve();await micro();assert.equal(modal.host.children[0].id,"old");decode.resolve(true);await pending;
  assert.equal(modal.host.children[0].id,"new");assert.equal(oldSignal.aborted,true);assert.equal(newInput.value,"latest input");assert.equal(newInput.selectionStart,12);modal.close();
});
test("closing or superseding a preparing modal cannot publish stale contents",async()=>{
  UI.assetsFixture({});globalThis.uiHarness.NGUI.render=async()=>({});globalThis.uiHarness.NGUI.decoded=async()=>true;
  const modal=UI.createModal("Race",()=>{}),capture=deferred();
  const first=modal.draw(async(layer,alive,signal)=>{layer.id="stale";UI.readinessFixture(layer,()=>withTimeout(capture.promise,Infinity,"test",{signal}));});await micro();
  const next=modal.draw(async(layer)=>{layer.id="current";});await next;await first;capture.resolve();assert.equal(modal.host.children[0].id,"current");
  const last=modal.draw(async(layer,alive,signal)=>UI.readinessFixture(layer,()=>withTimeout(new Promise(()=>{}),Infinity,"test",{signal})));await micro();modal.close();await last;assert.equal(modal.host.isConnected,false);
});
test("long horizontal drags retain their source cell and capture until the drag finishes",async()=>{
  const host=new Element(),controller=new AbortController();let source,sourceSignal;
  const list=UI.virtualArea(host,[0,0,500,175],100,244,(cell,index,signal)=>{if(index===0){source=cell;sourceSignal=signal;const hit=new Element();hit.dataset.reordering="true";cell.append(hit);}},{key:"drag",horizontal:true,signal:controller.signal});await list.ready;
  list.inner.parentElement.scrollLeft=3000;list.inner.parentElement.emit("scroll");await settle();assert.equal(sourceSignal.aborted,false);assert.ok(list.inner.children.includes(source));
  delete source.children[0].dataset.reordering;list.inner.parentElement.emit("scroll");await settle();assert.equal(sourceSignal.aborted,true);assert.ok(!list.inner.children.includes(source));controller.abort();
});

test("a ready redraw waits for the current drag before retiring its source cell",async()=>{
  UI.assetsFixture({});globalThis.uiHarness.NGUI.render=async()=>({});globalThis.uiHarness.NGUI.decoded=async()=>true;
  const modal=UI.createModal("Drag",()=>{});let hit,oldSignal;
  await modal.draw(async(layer,alive,signal)=>{layer.id="dragging";oldSignal=signal;hit=new Element();layer.append(hit);});
  hit.dataset.reordering="true";const pending=modal.draw(async(layer)=>{layer.id="next";});await micro();
  assert.equal(modal.host.children[0].id,"dragging");assert.equal(oldSignal.aborted,false);
  delete hit.dataset.reordering;modal.host.emit("pointerup");await pending;assert.equal(modal.host.children[0].id,"next");assert.equal(oldSignal.aborted,true);modal.close();
});

test("filter redraws reset the logical viewport instead of restoring a stale old scroll offset",async()=>{
  UI.assetsFixture({});globalThis.uiHarness.NGUI.render=async()=>({});globalThis.uiHarness.NGUI.decoded=async()=>true;
  const positions=new Map([["filtered",[0,500]]]),modal=UI.createModal("Filtered",()=>{});let current;
  const draw=count=>modal.draw(async(layer,alive,signal)=>{current=UI.virtualArea(layer,[0,0,500,150],count,100,()=>{},{key:"filtered",positions,signal});await current.ready;});
  await draw(100);assert.equal(current.inner.parentElement.scrollTop,500);positions.clear();await draw(2);
  assert.equal(current.inner.parentElement.scrollTop,0);assert.deepEqual(positions.get("filtered"),[0,0]);modal.close();
});
