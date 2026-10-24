import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createDraft } from "../../src/ba_modding_toolkit/web/js/student-hall-model.js";
const tick = () => new Promise(setImmediate);
let requests = [], deferred = [], prompts = [], currentScene = "hall", renders = 0, auto = false;
const node = () => ({ style: {}, dataset: {}, inert: false, isConnected: true, replaceChildren() {}, append() {} });
globalThis.document = { removeEventListener() {}, addEventListener() {}, getElementById: node, createElement: node };
globalThis.hallHarness = {
  createDraft, S:1920/2960, clone: structuredClone, T: (key) => key,
  rpc: (method, params) => {
    requests.push({ method, params });
    if (method !== "hall.update") return Promise.resolve(method === "hall.get" ? saved() : { choices: [], backgrounds: [] });
    if (auto) return Promise.resolve({ ...params.value, revision: params.revision + 1 });
    return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
  },
  Lobby: { hide() { currentScene = null; } }, Popup: { notify() {}, message({ buttons, width }) { assert.equal(width, 1450); return new Promise((resolve) => prompts.push({ actions: buttons.map((action) => ({ fn: () => resolve({ button: action.value }) })) })); } }, NGUI: { layout: async () => ({}) },
  UI: { ready: async () => {}, caption: async () => {}, createModal() {
    const modal = { host: node(), close() {}, async draw(build, actions) { prompts.push({ modal, actions }); } }; return modal;
  } },
};
let source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall.js", import.meta.url), "utf8");
source = source.replace(/^import .*;$/gm, "");
source = `const {createDraft,S,clone,T,rpc,Lobby,Popup,NGUI,UI}=globalThis.hallHarness;\n${source}
export function fixture(value, render) { store=createDraft(value);root=art=nodeFake(); renderScene=render;renderChrome=async()=>{}; }
function nodeFake(){return {replaceChildren(){}};}
export function initializePending(){store=null;root=art=nodeFake();}
export function draft(){return store;} export {step,setMode,persist,saveDraft,cancelDraft};`;
const Hall = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function saved() { return { revision: 0, mode: "memorial", portraits: [], memorials: [{ id: "one" }, { id: "two" }], active: "one" }; }
function setup() { requests=[];deferred=[];prompts=[];renders=0;auto=false;Hall.fixture(saved(),async()=>{renders++;currentScene="hall";}); }

test("held save cannot replace a detail scene after leaving Hall", async () => {
  setup(); const pending=Hall.step(1);await tick();Hall.hide();currentScene="detail";
  deferred[0].resolve({...requests[0].params.value,revision:1});await pending;
  assert.equal(currentScene,"detail");assert.equal(renders,0);
});
test("inactive Hall cleanup leaves successive detail owners intact", () => {
  setup();Hall.hide();currentScene="detail-one";Hall.hide();assert.equal(currentScene,"detail-one");
  currentScene="detail-two";Hall.hide();assert.equal(currentScene,"detail-two");
});
test("navigation before initial Hall metadata arrives is safe", async()=>{setup();Hall.initializePending();assert.equal(await Hall.canLeave(),true);Hall.hide();});
test("three queued saves use monotonic revisions even when accepted snapshots replace the base", async()=>{
  setup();const a=Hall.persist(saved()),b=Hall.persist(saved());await tick();
  deferred[0].resolve({...saved(),revision:1});await a;Hall.draft().accept({...saved(),revision:1});
  const c=Hall.persist(saved());await tick();deferred[1].resolve({...saved(),revision:2});await b;await tick();
  assert.equal(requests[2].params.revision,2);deferred[2].resolve({...saved(),revision:3});await c;Hall.hide();
});
test("canLeave coalesces prompts and Keep Editing preserves the draft",async()=>{
  setup();Hall.draft().begin("layout").background="changed";
  const first=Hall.canLeave(),second=Hall.canLeave();assert.equal(first,second);await tick();assert.equal(prompts.length,1);
  prompts[0].actions[0].fn();assert.equal(await first,false);assert.ok(Hall.draft().dirty());Hall.hide();
});
test("Discard leaves without writing, Save persists the full draft once",async()=>{
  setup();Hall.draft().begin("layout").background="discard";let leaving=Hall.canLeave();await tick();prompts[0].actions[1].fn();
  assert.equal(await leaving,true);assert.equal(requests.length,0);
  setup();auto=true;Hall.draft().begin("layout").background="saved";leaving=Hall.canLeave();await tick();prompts[0].actions[2].fn();
  assert.equal(await leaving,true);assert.equal(requests.filter((r)=>r.method==="hall.update").length,1);assert.equal(Hall.draft().saved().background,"saved");Hall.hide();
});
test("Cancel cannot discard a draft while its save is already in flight",async()=>{
  setup();Hall.draft().begin("layout").background="saved";const pending=Hall.saveDraft({render:false});await tick();await Hall.cancelDraft();
  assert.equal(Hall.draft().current().background,"saved");deferred[0].resolve({...requests[0].params.value,revision:1});await pending;
  assert.equal(Hall.draft().saved().background,"saved");Hall.hide();
});


test("settleView restores canceled draft visuals once when navigation stays on Hall", async()=>{
  setup();Hall.draft().begin("layout").background="discard";
  const leaving=Hall.canLeave();await tick();prompts[0].actions[1].fn();assert.equal(await leaving,true);
  assert.equal(renders,0);await Hall.settleView();assert.equal(renders,1);await Hall.settleView();assert.equal(renders,1);Hall.hide();
});
test("clean Home settlement does not restart a memorial scene",async()=>{
  setup();assert.equal(await Hall.canLeave(),true);await Hall.settleView();assert.equal(renders,0);Hall.hide();
});
