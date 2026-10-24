import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorialPool } from "../../src/ba_modding_toolkit/web/js/student-hall-memorial.js";
const choice=(name,id=name)=>({id,variant:name,source:`mod:${name}`});
function fixture(){
  const events=[],hosts=[],players=[0,1].map(index=>({index,hide(){events.push(["hide",index]);},suspend(){events.push(["pause",index]);},resume(){events.push(["resume",index]);}}));
  let wait=null;
  const pool=createMemorialPool({moduleFor:async index=>players[index],load:async(value,host,signal,player)=>{events.push(["load",value.source,player.index]);await wait;return true;}});
  return {pool,events,players,hosts,hold(value){wait=value;},host(){const host={removed:false,remove(){this.removed=true;}};hosts.push(host);return host;}};
}
test("resource identity reuses the current memorial even when its playlist UUID changes",async()=>{
  const h=fixture(),signal=new AbortController().signal,first=await h.pool.prepare(choice("a"),()=>h.host(),signal);h.pool.commit(first);
  assert.equal(await h.pool.prepare(choice("a","canonical-new-id"),()=>h.host(),signal),first);
  assert.equal(h.events.filter(event=>event[0]==="load").length,1);assert.equal(h.hosts.length,1);
});
test("only current and one staging lobby exist and replacement disposal precedes activation",async()=>{
  const h=fixture(),signal=new AbortController().signal;
  for(const name of ["a","b","c","d","e"]){
    const next=await h.pool.prepare(choice(name),()=>h.host(),signal);assert.ok(h.hosts.filter(host=>!host.removed).length<=2);
    h.pool.commit(next);h.pool.resume();assert.equal(h.hosts.filter(host=>!host.removed).length,1);
  }
  assert.deepEqual(h.events.filter(event=>event[0]==="load").map(event=>event[2]),[0,1,0,1,0]);
  const last=h.events.slice(-2);assert.deepEqual(last,[["hide",1],["resume",0]]);
  h.pool.dispose();assert.equal(h.hosts.filter(host=>!host.removed).length,0);
});
test("a canceled staged load cannot replace or dispose the retained current scene",async()=>{
  const h=fixture(),signal=new AbortController().signal,first=await h.pool.prepare(choice("a"),()=>h.host(),signal);h.pool.commit(first);
  let release;h.hold(new Promise(resolve=>{release=resolve;}));const cancel=new AbortController();
  const pending=h.pool.prepare(choice("b"),()=>h.host(),cancel.signal);await new Promise(setImmediate);cancel.abort();release();
  assert.equal(await pending,null);assert.equal(h.pool.current(),first);assert.equal(first.host.removed,false);
  h.pool.resume();assert.deepEqual(h.events.at(-1),["resume",0]);
});
test("a failed replacement keeps the current session and releases its staging host",async()=>{
  const h=fixture(),signal=new AbortController().signal,first=await h.pool.prepare(choice("a"),()=>h.host(),signal);h.pool.commit(first);
  h.hold(Promise.reject(new Error("missing target")));
  await assert.rejects(h.pool.prepare(choice("b"),()=>h.host(),signal),/missing target/);
  assert.equal(h.pool.current(),first);assert.equal(h.hosts.filter(host=>!host.removed).length,1);
});

test("an explicit false ready result cannot commit a failed view or dispose the previous scene",async()=>{
  const players=[{hide(){},resume(){},suspend(){}},{hide(){},resume(){},suspend(){}}];let ready=true;
  const pool=createMemorialPool({moduleFor:async index=>players[index],load:async()=>ready});
  const host=()=>({remove(){}}),signal=new AbortController().signal,first=await pool.prepare(choice("a"),host,signal);pool.commit(first);
  ready=false;await assert.rejects(pool.prepare(choice("b"),host,signal),/not ready/);assert.equal(pool.current(),first);
});
