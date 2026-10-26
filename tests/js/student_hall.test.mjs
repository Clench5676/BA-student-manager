import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { portraitScale } from "../../src/ba_modding_toolkit/web/js/student-hall-framing.js";

const file = new URL("../../src/ba_modding_toolkit/web/js/student-hall-portraits.js", import.meta.url);
let source = await readFile(file, "utf8");
source = source.replace(/^import .*;$/gm, "");
source = `const {loadSpineAssets, spineBase, loadPlayer, ensureSpine, idleAnimation, Stage, portraitScale} = globalThis.hallHarness;\n${source}`;
let calls, disposed, shared, hooks, delay, drawn, players;
class Skeleton { constructor(data) { this.data = data; } setSkin(skin) { this.skin = skin; } setSlotsToSetupPose() { this.attachments = this.skin.attachments; } update() {} updateWorldTransform() {} }
class AnimationState { constructor(data) { this.data = data; } setAnimation() {} setEmptyAnimation() { return {}; } apply() {} update(delta) { this.elapsed=(this.elapsed||0)+delta; } }
const data = { animations: [{ name: "Idle_01" }], findAnimation: () => null };
globalThis.spine = { Skeleton, AnimationState, AnimationStateData: class { constructor(data) { this.skeletonData = data; } }, Physics: { update: 0 },
  SpinePlayer: class { constructor(layer, config) {
    players.push(this);
    this.skeleton = new Skeleton(data); this.skeleton.skin = { name: "custom", attachments: ["mod-only"] }; this.animationState = new AnimationState({});
    this.canvas = { width: 1920, height: 1080 }; this.sceneRenderer = { drawSkeleton(skeleton) { drawn.push(skeleton); } }; this.context = { gl: {} }; this.config = config;
    this.drawFrame = () => this.sceneRenderer.drawSkeleton(this.skeleton);
    this.stopRendering = () => { this.stopRequestAnimationFrame=true; }; this.startRendering = () => { this.stopRequestAnimationFrame=false; };
  } } };
globalThis.document = { createElement: () => ({ style: {}, remove() { this.removed = true; }, getContext() { return { drawImage() {} }; } }) };
globalThis.hallHarness = {
  portraitScale,
  spineBase: (kind, key) => `${kind}/${key}`,
  loadSpineAssets: async (base, fn, { signal }) => { calls.push(base); if (delay) await delay; if (!signal.aborted) await fn(base); },
  ensureSpine: async () => true, idleAnimation: () => "Idle_01",
  loadPlayer: (create, config, { signal }) => {
    const player = create(config); hooks.push(config); config.success(player);
    let dead = false;
    const dispose = () => { if (!dead) { dead = true; disposed.push(player); } };
    signal.addEventListener("abort", dispose);
    return { player, dispose, ready: Promise.resolve(player) };
  },
  Stage: { make: (owner, fn) => { shared.push(owner); return fn(); }, ready: () => {}, hostOf: () => null },
};
const Hall = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function setup() { calls = []; disposed = []; shared = []; hooks = []; delay = null; drawn = []; players = []; return { children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children=[]; } }; }
const entries = (n) => Array.from({ length: n }, (_, i) => ({ id: `uuid-${i}`, x: i * 40, y: 1100, scale: 1 }));
const choice = () => ({ source: "mod:one", core: "hoshino_spr" });

test("the low-level shared asset cache retains independent poses while draft validation owns source uniqueness", async () => {
  const host = setup(), controller = new AbortController(), list = entries(25);
  const result = await Hall.createPortraits(host, list, choice, { signal: controller.signal });
  assert.equal(result.actors.size, 25); assert.deepEqual(calls, ["mod/one"]);
  const actors = [...result.actors.values()];
  assert.notEqual(actors[0].player.skeleton, actors[1].player.skeleton);
  assert.notEqual(actors[0].player.animationState, actors[1].player.animationState);
  assert.equal(actors[0].player.skeleton.data, actors[24].player.skeleton.data);
  assert.equal(actors[0].player.skeleton.skin.name, "custom");
  assert.deepEqual(actors[24].player.skeleton.attachments, ["mod-only"]);
  list[0].x = 900; Hall.pose(list[0], actors[0].player.skeleton);
  assert.equal(actors[0].player.skeleton.x, 900); assert.equal(actors[1].player.skeleton.x, 40);
  controller.abort(); assert.equal(result.actors.size, 0); assert.equal(disposed.length, 1);
});

test("unique portrait sources share the first GPU context and dispose guests before owner", async () => {
  const host = setup(), controller = new AbortController();
  const result = await Hall.createPortraits(host, entries(2), (e) => ({ source: `mod:${e.id}` }), { signal: controller.signal });
  assert.equal(calls.length, 2); assert.equal(shared[0], null); assert.ok(shared[1]);
  result.dispose(); assert.equal(disposed.length, 2); assert.equal(disposed[1], shared[1]);
});

test("navigation cancellation during extraction creates no late player", async () => {
  const host = setup(), controller = new AbortController(); let release;
  delay = new Promise((resolve) => { release = resolve; });
  const pending = Hall.createPortraits(host, entries(2), choice, { signal: controller.signal });
  await Promise.resolve(); controller.abort(); release();
  const result = await pending;
  assert.equal(hooks.length, 0); assert.equal(result.actors.size, 0);
});

test("global scale updates existing actors without loading sources or replacing shared renderer state", async()=>{
  const host=setup(),controller=new AbortController(),list=entries(2);list[1].scale=.6;
  const result=await Hall.createPortraits(host,list,(e)=>({source:`mod:${e.id}`}),{signal:controller.signal,globalScale:.8});
  const actors=[...result.actors.values()],before=actors.map(a=>[a.player.skeleton,a.player.animationState]),positions=structuredClone(list),loads=calls.length;
  for(const value of [.25,.73,1,1.5]){
    result.setScale(value);
    for(let i=0;i<actors.length;i++){
      assert.equal(actors[i].player.skeleton,before[i][0]);assert.equal(actors[i].player.animationState,before[i][1]);
      assert.equal(actors[i].player.skeleton.scaleX,portraitScale(list[i],value));
      assert.equal(actors[i].player.skeleton.x,list[i].x);assert.equal(actors[i].player.skeleton.y,1080-list[i].y);
    }
  }
  assert.equal(calls.length,loads);assert.equal(disposed.length,0);assert.deepEqual(list,positions);
  result.dispose();result.setScale(.5);assert.equal(result.actors.size,0);
});

test("edit save cancel reconciliation preserves canvas, actors, pose tracks and source fetch counts", async () => {
  const host=setup(), controller=new AbortController(), original=entries(3);
  const result=await Hall.createPortraits(host,original,(entry)=>({source:`mod:${entry.id}`}),{signal:controller.signal});
  const before=[...result.actors.values()], context=shared[1], canvas=context.canvas, fetches=calls.length;
  before.forEach((actor,i)=>{actor.player.animationState.trackTime=71+i;});
  let draft=structuredClone(original); draft[0].x=650; draft[1].mirror=true;
  await result.update(draft,.7);
  assert.equal(result.actors.get(draft[0].id).entry,draft[0]);
  assert.equal(result.actors.get(draft[1].id).player.skeleton.scaleX,-portraitScale(draft[1],.7));
  draft=[draft[2],draft[0],draft[1]]; drawn=[]; await result.update(draft,.7);
  assert.deepEqual([...result.actors.keys()],draft.map((entry)=>entry.id));
  assert.deepEqual(drawn,before.map((actor)=>actor.player.skeleton).map((_,i)=>before[[2,0,1][i]].player.skeleton));
  await result.update(structuredClone(original),1);
  for(let i=0;i<before.length;i++){
    const actor=result.actors.get(original[i].id);assert.equal(actor,before[i]);assert.equal(actor.player.animationState.trackTime,71+i);
    assert.equal(actor.entry.x,original[i].x);assert.equal(actor.player.skeleton.scaleX,portraitScale(original[i]));
  }
  assert.equal(shared[1],context);assert.equal(context.canvas,canvas);assert.equal(calls.length,fetches);assert.equal(disposed.length,0);
  result.dispose();
});
test("additional sources stay staged until all are ready and a superseding cancel rejects late publication", async()=>{
  const host=setup(),controller=new AbortController(),original=entries(1);
  const result=await Hall.createPortraits(host,original,(entry)=>({source:`mod:${entry.id}`}),{signal:controller.signal});
  const retained=result.actors.get(original[0].id), next=entries(3); let release;
  delay=new Promise((resolve)=>{release=resolve;}); drawn=[];
  const pending=result.update(next);await new Promise(setImmediate);
  assert.deepEqual([...result.actors.keys()],[original[0].id]);assert.equal(drawn.length,0);
  assert.equal(players[0].hallLayer.style.visibility,"hidden");
  assert.equal(host.children.find(child=>child.width===1920)?.height,1080,"snapshot keeps the exact canvas backing resolution");
  const cancelled=result.update(structuredClone(original));release();await Promise.all([pending,cancelled]);
  assert.deepEqual([...result.actors.keys()],[original[0].id]);assert.equal(result.actors.get(original[0].id),retained);
  assert.equal(players[0].hallLayer.style.visibility,"");
  delay=null;drawn=[];await result.update(next);
  assert.equal(result.actors.size,3);assert.equal(drawn.length,3,"one complete draw precedes reveal");
  assert.equal(drawn[0],retained.player.skeleton);assert.ok(drawn.every((skeleton)=>skeleton!==shared[1].skeleton));
  controller.abort();assert.equal(result.actors.size,0);
});

test("unused actors and guest resources are bounded to current and saved layouts plus the GPU owner",async()=>{
  const host=setup(),controller=new AbortController(),original=entries(3);
  const result=await Hall.createPortraits(host,original,(entry)=>({source:`mod:${entry.id}`}),{signal:controller.signal});
  const savedActor=result.actors.get(original[1].id);
  await result.update([original[0]],1,{retain:original});assert.equal(disposed.length,0);
  await result.update(original);assert.equal(result.actors.get(original[1].id),savedActor);assert.equal(calls.length,3);
  await result.update([original[0]]);assert.equal(disposed.length,2);
  await result.update([original[0]]);assert.equal(calls.length,3);result.dispose();assert.equal(disposed.length,3);
});

test("inactive portrait sessions pause their actor clocks and resume the same GPU owner without loading",async()=>{
  const host=setup(),controller=new AbortController(),list=entries(2);
  const result=await Hall.createPortraits(host,list,choice,{signal:controller.signal}),actor=result.actors.get(list[0].id),owner=players[0],fetches=calls.length;
  hooks[0].frame(owner,.25);assert.equal(actor.player.animationState.elapsed,.25);
  result.setActive(false);hooks[0].frame(owner,10);assert.equal(actor.player.animationState.elapsed,.25);assert.equal(owner.stopRequestAnimationFrame,true);
  result.setActive(true);await Promise.resolve();hooks[0].frame(owner,.1);
  assert.equal(actor.player.animationState.elapsed,.35);assert.equal(owner.stopRequestAnimationFrame,false);assert.equal(calls.length,fetches);assert.equal(result.actors.get(list[0].id),actor);
  result.dispose();
});

test("scene zoom updates the shared projection while retaining every skeleton, asset and animation state",async()=>{
  const host=setup(),controller=new AbortController(),list=entries(2);
  const result=await Hall.createPortraits(host,list,choice,{signal:controller.signal});
  const actors=[...result.actors.values()],before=actors.map(actor=>({player:actor.player,x:actor.player.skeleton.x,y:actor.player.skeleton.y,scale:actor.player.skeleton.scaleX}));
  const requestCount=calls.length,viewport={x:100,y:200,width:960,height:540};
  result.setView(viewport,{draw:true});hooks[0].frame(players[0],.1);
  assert.equal(players[0].currentViewport.width,960);assert.equal(players[0].currentViewport.x,100);
  assert.equal(calls.length,requestCount);assert.equal(disposed.length,0);
  for(let i=0;i<actors.length;i++){assert.equal(actors[i].player,before[i].player);assert.equal(actors[i].player.skeleton.x,before[i].x);assert.equal(actors[i].player.skeleton.scaleX,before[i].scale);}
  result.setView(null);assert.equal(players[0].currentViewport.width,1920);controller.abort();
});
