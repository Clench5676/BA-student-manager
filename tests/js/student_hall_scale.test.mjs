import assert from "node:assert/strict";
import { test } from "node:test";
import { bindScale } from "../../src/ba_modding_toolkit/web/js/student-hall-scale.js";
import { createDraft } from "../../src/ba_modding_toolkit/web/js/student-hall-model.js";
import { portraitScale, portraitRect } from "../../src/ba_modding_toolkit/web/js/student-hall-framing.js";
class Input {
  value=""; listeners={};
  addEventListener(name,fn){(this.listeners[name] ||= []).push(fn);}
  emit(name,event={}){for(const fn of this.listeners[name]||[])fn(event);}
}
function setup(value=1) {
  const range=new Input(),number=new Input(),reset=new Input(),changes=[],paints=[];
  let enabled=true;
  const control=bindScale(range,number,reset,{value,change:(v)=>changes.push(v),paint:(f)=>paints.push(f),enabled:()=>enabled});
  return {range,number,reset,changes,paints,control,disable(){enabled=false;}};
}
test("slider and numeric percent stay synchronized with exact integer percentage round trips",()=>{
  const s=setup();assert.equal(s.number.value,"100");assert.equal(s.range.value,"100");
  s.range.value="73";s.range.emit("input");assert.equal(s.number.value,"73");assert.equal(s.control.value(),.73);
  s.number.value="85";s.number.emit("input");assert.equal(s.range.value,"85");assert.equal(s.control.value(),.85);
  assert.deepEqual(s.changes,[.73,.85]);assert.equal(s.paints.at(-1),(85-25)/125);
});
test("numeric partial input is not prematurely clamped; commit clamps and invalid input restores last valid size",()=>{
  const s=setup(.8);s.number.value="7";s.number.emit("input");assert.equal(s.number.value,"7");assert.equal(s.range.value,"80");
  s.number.value="75";s.number.emit("input");assert.equal(s.range.value,"75");
  s.number.value="1";s.number.emit("change");assert.equal(s.number.value,"25");assert.equal(s.control.value(),.25);
  s.number.value="999";s.number.emit("blur");assert.equal(s.number.value,"150");assert.equal(s.control.value(),1.5);
  s.number.value="";s.number.emit("blur");assert.equal(s.number.value,"150");
  s.number.value="bad";s.number.emit("change");assert.equal(s.number.value,"150");
});
test("Reset restores100percent and a pending write prevents input mutations",()=>{
  const s=setup(.6);s.reset.emit("click");assert.equal(s.control.value(),1);assert.equal(s.number.value,"100");
  s.disable();s.range.value="40";s.range.emit("input");s.reset.emit("click");assert.equal(s.number.value,"100");assert.deepEqual(s.changes,[1]);
});
test("global size drafts cancel/save without changing any actor position or relative scale",()=>{
  const value={revision:0,mode:"portraits",background:"office-night",portraits:[{id:"a",variant:"a",source:"mod:a",x:600,y:1000,scale:.8}],memorials:[],active:null};
  const model=createDraft(value);assert.equal(model.current().portraitScale,1);assert.equal(value.portraitScale,undefined);
  model.begin("layout").portraitScale=.75;assert.ok(model.dirty());assert.deepEqual(model.current().portraits,value.portraits);
  model.cancel();assert.equal(model.current().portraitScale,1);
  model.begin("layout").portraitScale=.73;model.accept({...structuredClone(model.current()),revision:1});assert.equal(model.saved().portraitScale,.73);assert.equal(model.dirty(),false);
  const entry=value.portraits[0],bounds={x:-200,y:0,width:600,height:1400};
  assert.ok(Math.abs(portraitScale(entry,.5)-.72*.8*.5)<1e-12);
  const normal=portraitRect(entry,bounds,1),half=portraitRect(entry,bounds,.5);
  assert.equal(half.width,normal.width*.5);assert.equal(half.height,normal.height*.5);
  assert.equal(half.x,entry.x+(normal.x-entry.x)*.5);assert.equal(half.y,entry.y+(normal.y-entry.y)*.5);
});

test("slider-only binding supports the full25to150range without a numeric field or reset control",()=>{
  const range=new Input(),changes=[];
  const control=bindScale(range,null,null,{value:1,change:value=>changes.push(value)});
  assert.equal(range.min,"25");assert.equal(range.max,"150");
  for(const value of [25,73,150]){range.value=String(value);range.emit("input");assert.equal(control.value(),value/100);}
  assert.deepEqual(changes,[.25,.73,1.5]);
});
