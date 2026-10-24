import assert from "node:assert/strict";
import vm from "node:vm";
import * as Sync from "../../src/ba_modding_toolkit/web/js/lobby-sync.js";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { latestLoad } from "../../src/ba_modding_toolkit/web/js/spine-load.js";
import * as Intro from "../../src/ba_modding_toolkit/web/js/lobby-intro.js";
import { withTimeout } from "../../src/ba_modding_toolkit/web/js/async.js";

const source = (await readFile(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const runtime = vm.createContext({ console, document: {}, performance });
vm.runInContext(await readFile(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), runtime);
const NativeSpine = runtime.spine;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function environment() {
  let now = 0, next = 0, owner = null; const timers = new Map(), sounds = [], touch = [];
  class Audio {
    constructor(url) { Object.assign(this, { url, currentTime: 0, paused: true, ended: false, plays: 0, pauses: 0 }); sounds.push(this); }
    play() { this.paused = false; this.plays++; return Promise.resolve(); }
    pause() { this.paused = true; this.pauses++; }
  }
  const document = { createElement:()=>({style:{},classList:{add(){}}}), hidden: false, hasFocus: () => true, timeline: { get currentTime() { return now; } } };
  const env = { console, document, Audio, AbortController, Intro, Sync, spine: NativeSpine,
    loadPlayer: (_create,config,options)=>({config,options}), resumeRest(){}, Pins:{apply(){}},
    settle(player){player.animationState.setAnimation(0,"Idle_01",true);return "Idle_01";}, performance: { now: () => now }, latestLoad, withTimeout,
    URL: { createObjectURL: () => "blob:sfx", revokeObjectURL() {} }, fetch: async () => ({ ok: true, blob: async () => ({}) }),
    globalThis: { setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    clearInterval() {}, setInterval() { return 1; }, requestAnimationFrame: (fn) => fn(),
    Touch: { setup(api) { owner = api?.id || null; touch.push(["setup", owner]); }, attach(host) { touch.push(["attach", host.id]); }, apply(){}, detach() { touch.push(["detach", owner]); } },
    Stage: { hostOf: () => null, shown: () => true, ready(){},frame(){} }, Materials: { detach() {} }, Linear: { attach:()=>false,detach(){},begin(){},end(){},tint(){} },
    T: (key) => key, previewError() {},
  };
  return { env, timers, sounds, touch, owner: () => owner, now: () => now,
    tick(ms) { const end = now + ms; while (true) { const due = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].fn(); } now = end; } };
}
function instance(h, id) {
  const code = `${source}
    feather = () => {}; playClip = (p, name) => { p.clip = name; }; returnToIdle = () => {}; clearClip = () => {};
    function seed() {
      const controller = new AbortController(), host = { id: ${JSON.stringify(id)}, classList: { remove() {} }, querySelector() { return null; } };
      const p = { bamtLayer: {name:'main'}, paused:false, disposed:false, starts:0, draws:0, stopRequestAnimationFrame:true,
        canvas:{width:1920,height:1080}, animationState:{tracks:[]}, trackTime:7, effectTime:3,
        stopRendering(){this.stopRequestAnimationFrame=true;}, startRendering(){this.stopRequestAnimationFrame=false;this.starts++;},
        time:{ last:performance.now(),delta:0,totalTime:7,update(){this.delta=(performance.now()-this.last)/1000;this.last=performance.now();this.totalTime+=this.delta;}},
        drawFrame(){this.time.update();this.draws++;current.intro.frame(this,this.time.delta);this.trackTime+=this.time.delta;this.effectTime+=this.time.delta;current.drawnAt=performance.now();} };
      const c = current = {core:'fixture',variant:'fixture',host,signal:controller.signal,deferPlayback:true,suspended:true,
        backgroundPaused:false,visualLoads:new Map(),resumeAudio:new Set(),pendingSounds:[],view:{x:0,y:0,w:1920,h:1080},
        meta:{main:'main',sequences:[{anim:'Talk_01_M',duration:10,cues:[{clip:'one',t:0},{clip:'two',t:3}]}]},
        info:{sounds:{start:{clips:['start'],volume:1,pitch:1}}},touch:{id:${JSON.stringify(id)}},
        intro:{t:0,started:false,skip(){},pending:()=>false,dispose(){},frame(p,dt){if(!this.started){this.started=true;Sfx.play('start');}else this.t+=dt;}}};
      c.ready=Promise.resolve(c.meta);players=[p];mode='full';wantTouch=true;
      playerLoads.set(p,{active:()=>true,dispose(){p.disposed=true;}});clocked(p);freezePlayer(p,c);
      return {c,p,controller};
    }
    return {seed,suspend,resume,prepareFrame,hide,play,setLines,setVolume,interactive,frame,
      capturePlayer(){return makePlayer({appendChild(){}},{name:'main',x:0,y:0,scale:1,spine:'native'},null,null,current.signal);},
      adoptPlayer(player){players=[player];current.pauseFlags=new Map();playerLoads.set(player,{active:()=>true,dispose(){player.disposed=true;}});},
      background(value){const c=current;c.backgroundPaused=value;if(value)freezeScene(c);else if(!c.suspended)resumeScene(c);},
      realIntro(definition){const c=current;c.intro=Intro.create(definition,{layers:[],visible:()=>c.preparingFrame||!paused()&&c.revealed,now:()=>performance.now(),sfx:(id,set)=>Sfx.play(id,set)});return c.intro;},
      sound:(id)=>Sfx.play(id),later:(fn,ms)=>setTimeout(fn,ms),current:()=>current};`;
  return new Function(...Object.keys(h.env), code)(...Object.values(h.env));
}

test("hidden preparation waits for complete visual assets, draws at zero time and defers all sound and input", async () => {
  const h = environment(), a = instance(h, "a"), { c, p } = a.seed(), image = deferred();
  c.visualLoads.set("fx", image.promise); let ready = false;
  const prepared = a.prepareFrame().then((value) => { ready = value; }); await flush();
  assert.equal(ready, false); assert.equal(p.draws, 0); assert.equal(h.owner(), null);
  image.resolve({}); await prepared; await flush();
  assert.equal(p.draws, 1); assert.equal(p.trackTime, 7); assert.equal(p.effectTime, 3); assert.equal(c.intro.t, 0);
  assert.equal(h.sounds.length, 0); assert.equal(c.pendingSounds.length, 1); assert.equal(p.paused, true);
  a.interactive(true); assert.equal(h.owner(), null);
  a.resume(); await flush(); assert.equal(h.owner(), "a"); assert.equal(h.sounds.length, 1); assert.equal(h.sounds[0].plays, 1);
  assert.equal(p.starts, 1); a.resume(); assert.equal(p.starts, 1, "Repeated activation is idempotent"); a.hide(c.host);
});

test("suspend retains the actual player, intro, cue delays and audio position without a hidden-wall-clock jump", async () => {
  const h = environment(), a = instance(h, "a"), { c, p } = a.seed();
  await a.prepareFrame(); a.resume(); await flush();
  a.setLines({ one:{voice:true},two:{voice:true} });a.play("Talk_01_M");h.tick(0);
  const voice = h.sounds.at(-1); voice.currentTime = 1.25;
  h.tick(1000);p.drawFrame();const track=p.trackTime,effect=p.effectTime,intro=c.intro.t,total=p.time.totalTime;
  a.suspend();assert.equal(voice.paused,true);assert.equal(h.owner(),null);const sounds=h.sounds.length;
  h.tick(60000);await a.prepareFrame();assert.equal(h.sounds.length,sounds);assert.equal(voice.currentTime,1.25);
  assert.equal(p.trackTime,track);assert.equal(p.effectTime,effect);assert.equal(c.intro.t,intro);assert.equal(p.time.totalTime,total);
  a.resume();assert.equal(a.current(),c);assert.equal(voice.currentTime,1.25);assert.equal(voice.plays,2);assert.equal(p.time.delta,0);
  h.tick(1999);assert.equal(h.sounds.length,sounds);h.tick(1);assert.equal(h.sounds.length,sounds+1);
  a.hide(c.host);assert.equal(h.timers.size,0);
});

test("failed or cancelled staging disposal cannot clear the active module's shared Touch ownership", async () => {
  const h = environment(), a = instance(h,"a"), b = instance(h,"b"), first=a.seed();a.resume();
  const second=b.seed(), image=deferred();second.c.visualLoads.set("fx",image.promise);
  const prepare=b.prepareFrame();await flush();assert.equal(h.owner(),"a");
  b.hide(second.c.host);image.resolve({});assert.equal(await prepare,false);assert.equal(h.owner(),"a");
  const third=b.seed();await b.prepareFrame();a.suspend();b.resume();assert.equal(h.owner(),"b");
  a.hide(first.c.host);assert.equal(h.owner(),"b");assert.equal(third.p.disposed,false);b.hide(third.c.host);
});

test("a sound request resolving during suspension remains silent until resume and respects a later mute", async () => {
  const h=environment(),data=deferred();h.env.fetch=()=>data.promise;
  const a=instance(h,"a"),{c}=a.seed();a.resume();a.sound("start");a.suspend();
  data.resolve({ok:true,blob:async()=>({})});await flush();assert.equal(h.sounds.length,1);assert.equal(h.sounds[0].plays,0);
  a.setVolume(.5,true);a.resume();await flush();assert.equal(h.sounds[0].plays,0);a.hide(c.host);
});

test("suspension preserves remaining idle-style deadlines and disposal cancels all instance deadlines", async () => {
  const h=environment(),a=instance(h,"a"),{c}=a.seed(),fired=[];a.resume();
  a.later(()=>fired.push("idle"),2000);h.tick(600);a.suspend();h.tick(90000);assert.deepEqual(fired,[]);
  a.resume();h.tick(1399);assert.deepEqual(fired,[]);h.tick(1);assert.deepEqual(fired,["idle"]);
  a.later(()=>fired.push("stale"),2000);a.hide(c.host);h.tick(5000);assert.deepEqual(fired,["idle"]);
});

test("a stale former owner cannot detach a newer singleton owner even when activation preceded its suspension", async () => {
  const h=environment(),a=instance(h,"a"),b=instance(h,"b"),first=a.seed(),second=b.seed();
  a.resume();b.resume();await flush();assert.equal(h.owner(),"b");const before=h.touch.length;
  a.interactive(false);a.suspend();a.hide(first.c.host);
  assert.equal(h.owner(),"b");assert.equal(h.touch.length,before);assert.equal(second.p.disposed,false);
  b.hide(second.c.host);assert.equal(h.owner(),null);
});

test("the real intro controller prepares frame zero silently and resumes its existing timeline after hidden time", async () => {
  const h=environment(),a=instance(h,"a"),{c,p}=a.seed();
  const intro=a.realIntro({duration:2,wrap:"none",sounds:[{t:0,id:"start"},{t:1,id:"start"}]});
  await a.prepareFrame();await flush();assert.equal(intro.state().started,true);assert.equal(intro.state().t,0);assert.equal(h.sounds.length,0);
  a.resume();await flush();assert.equal(h.sounds.length,1);
  h.tick(400);p.drawFrame();assert.equal(intro.state().t,.4);
  a.suspend();assert.equal(c.host.inert,true);h.tick(60000);await a.prepareFrame();assert.equal(intro.state().t,.4);
  a.resume();assert.equal(c.host.inert,false);h.tick(600);p.drawFrame();await flush();
  assert.equal(intro.state().t,1);assert.equal(h.sounds.length,2);assert.equal(intro.state().skipped,false);a.hide(c.host);
});

test("a failed visual asset rejects the publication barrier before any staging frame or audio is published", async () => {
  const h=environment(),a=instance(h,"a"),b=instance(h,"b"),first=a.seed(),second=b.seed();a.resume();
  const image=deferred();second.c.visualLoads.set("material",image.promise);const prepared=b.prepareFrame();await flush();
  image.reject(new Error("missing material texture"));await assert.rejects(prepared,/missing material texture/);
  assert.equal(second.p.draws,0);assert.equal(h.sounds.length,0);b.hide(second.c.host);assert.equal(h.owner(),"a");a.hide(first.c.host);
});

for (const blurredDuringLoad of [false, true]) test(`real vendored bootstrap resumes a progressing intro with load-time blur=${blurredDuringLoad}`, async () => {
  const h=environment(),a=instance(h,"native"),{c}=a.seed(),load=a.capturePlayer(),noop=()=>{};
  assert.equal(load.options.manual,true);
  const config={debug:{},controlBones:[],scale:1,...load.config,skeleton:"fixture.json"};
  const player={config,paused:true,disposed:false,error:false,speed:1,stopRequestAnimationFrame:true,
    bg:{r:0,g:0,b:0,a:0},bgFullscreen:{r:0,g:0,b:0,a:0},canvas:{width:1920,height:1080},viewport:{},
    currentViewport:{x:0,y:0,width:1920,height:1080,padLeft:0,padRight:0,padTop:0,padBottom:0},
    time:{last:h.now(),delta:0,totalTime:0,update(){this.delta=(h.now()-this.last)/1000;this.last=h.now();this.totalTime+=this.delta;}},
    assetManager:{isLoadingComplete:()=>true,hasErrors:()=>false,require:()=>({pages:[]}),remove:()=>({bones:[{name:"root"}],animations:{Idle_01:{bones:{root:{rotate:[{value:0},{time:1,value:0}]}}}}})},
    context:{gl:{VERSION:1,getExtension:()=>null,getParameter:()=>"WebGL 2.0",clearColor:noop,clear:noop}},
    sceneRenderer:{resize:noop,camera:{position:{}},begin:noop,end:noop,drawSkeleton:noop,skeletonDebugRenderer:{}},
    setupInput:noop,setViewport:noop,stopRendering(){this.stopRequestAnimationFrame=true;},startRendering(){this.stopRequestAnimationFrame=false;},
    play:NativeSpine.SpinePlayer.prototype.play,pause:NativeSpine.SpinePlayer.prototype.pause,
    loadSkeleton(){NativeSpine.SpinePlayer.prototype.loadSkeleton.call(this);},
    drawFrame(loop=false){NativeSpine.SpinePlayer.prototype.drawFrame.call(this,loop);},
    showError(message,error){throw error||new Error(message);}};
  a.adoptPlayer(player);
  if (blurredDuringLoad) a.background(true);
  player.drawFrame(false);assert.equal(player.paused,true,"The completed bootstrap frame is frozen");
  const intro=a.realIntro({duration:2,wrap:"none"});await a.prepareFrame();assert.equal(intro.state().t,0);
  a.resume();if(blurredDuringLoad)a.background(false);await flush();assert.equal(player.paused,false,"Restore native post-load autoplay, not the constructor's temporary paused=true");
  h.tick(250);player.drawFrame(false);assert.equal(intro.state().t,.25);
  a.suspend();h.tick(30000);await a.prepareFrame();assert.equal(intro.state().t,.25);
  a.resume();await flush();h.tick(250);player.drawFrame(false);assert.equal(intro.state().t,.5);a.hide(c.host);
});
