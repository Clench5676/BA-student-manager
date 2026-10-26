import assert from "node:assert/strict";
import { test } from "node:test";
import { constrainScene, sceneRect, sceneViewport, createSceneCamera } from "../../src/ba_modding_toolkit/web/js/student-hall-camera.js";
const close = (a,b) => assert.ok(Math.abs(a-b)<.03,`${a} != ${b}`);
function fixture(){
  const listeners=new Map(),frames=new Map(),painted=[],released=[];let sequence=0,now=0,enabled=true,blocked=false;
  const host={addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name);},
    getBoundingClientRect:()=>({left:100,top:50,width:960,height:540}),setPointerCapture(){},releasePointerCapture:id=>released.push(id)};
  const env={performance:{now:()=>now},requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id)};
  const camera=createSceneCamera({host,enabled:()=>enabled,blocked:()=>blocked,onChange:(view,immediate)=>painted.push({view,immediate}),env});
  return {camera,painted,frames,listeners,released,
    send(name,extra={}){const event={clientX:580,clientY:320,deltaX:0,deltaY:0,deltaMode:0,ctrlKey:false,target:{closest:()=>null},preventDefault(){this.defaultPrevented=true;},...extra};listeners.get(name)?.(event);return event;},
    flush(){for(let i=0;i<150&&frames.size;i++){now+=16;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(now);}assert.equal(frames.size,0);},
    time(ms){now+=ms;},enable(value){enabled=value;},block(value){blocked=value;}};
}
test("the scene camera transforms the whole composition and its hits using the same native projection",()=>{
  const view=constrainScene({scale:2,x:-400,y:-200}),rect={x:500,y:300,width:240,height:600};
  const hit=sceneRect(rect,view),viewport=sceneViewport(view);
  close(hit.x,(rect.x-viewport.x)*1920/viewport.width);
  close(hit.y,1080-(1080-rect.y-viewport.y)*1080/viewport.height);
  assert.deepEqual(hit,{x:600,y:400,width:480,height:1200});
  const second=sceneRect({...rect,x:800},view);close(second.x-hit.x,600);
  assert.deepEqual(rect,{x:500,y:300,width:240,height:600});
});
test("wheel zoom centers at the pointer and stops zooming out at the default composition without changing layout state",()=>{
  const h=fixture();const event=h.send("wheel",{deltaY:-3,deltaMode:1,clientX:340,clientY:185});assert.equal(event.defaultPrevented,true);h.flush();
  const zoom=h.camera.view();assert.ok(zoom.scale>1);close(480*zoom.scale+zoom.x,480);close(270*zoom.scale+zoom.y,270);
  h.send("wheel",{deltaY:100,deltaMode:1});h.flush();assert.deepEqual(h.camera.view(),{scale:1,x:0,y:0});h.camera.dispose();
});
test("touchpad pinches zoom while two-finger swipes pan at the display scale",()=>{
  const h=fixture();h.send("wheel",{ctrlKey:true,deltaY:-70});h.flush();const zoom=h.camera.view();assert.ok(zoom.scale>1);
  h.time(500);h.send("wheel",{deltaX:8,deltaY:5});h.flush();const panned=h.camera.view();close(panned.scale,zoom.scale);close(panned.x,zoom.x-16);close(panned.y,zoom.y-10);h.camera.dispose();
});
test("WKWebView gesture events suppress companion ctrl-wheel events instead of zooming twice",()=>{
  const h=fixture();h.send("gesturestart");h.send("gesturechange",{scale:1.5});const before=h.camera.target();
  h.send("wheel",{ctrlKey:true,deltaY:-100});assert.deepEqual(h.camera.target(),before);
  h.send("gestureend");h.time(301);h.send("wheel",{ctrlKey:true,deltaY:-10});assert.ok(h.camera.target().scale>before.scale);h.flush();h.camera.dispose();
});
test("editing, modals and toolbar controls retain their input, and lifecycle cleanup retires every frame",()=>{
  const h=fixture();h.enable(false);assert.equal(h.send("wheel",{deltaY:-3,deltaMode:1}).defaultPrevented,undefined);
  h.enable(true);h.block(true);assert.equal(h.send("gesturechange",{scale:2}).defaultPrevented,undefined);
  h.block(false);assert.equal(h.send("wheel",{deltaY:-3,deltaMode:1,target:{closest:()=>({})}}).defaultPrevented,undefined);
  h.send("wheel",{ctrlKey:true,deltaY:-80});assert.equal(h.frames.size,1);h.enable(false);h.camera.sync({reset:true});assert.equal(h.frames.size,0);assert.deepEqual(h.camera.view(),{scale:1,x:0,y:0});
  h.enable(true);h.send("wheel",{ctrlKey:true,deltaY:-80});h.camera.dispose();assert.equal(h.frames.size,0);assert.equal(h.listeners.size,0);
});
test("middle-button scene pan and source switching preserve the temporary view without touching an actor",()=>{
  const h=fixture();h.send("wheel",{ctrlKey:true,deltaY:-70});h.flush();const zoom=h.camera.view();
  h.send("pointerdown",{button:1,pointerId:4});h.send("pointermove",{pointerId:4,clientX:600,clientY:330,buttons:4});h.send("pointerup",{pointerId:4});h.flush();
  close(h.camera.view().x,zoom.x+40);close(h.camera.view().y,zoom.y+20);assert.deepEqual(h.released,[4]);
  const retained=h.camera.view();h.enable(false);h.camera.sync();assert.deepEqual(h.painted.at(-1).view,{scale:1,x:0,y:0});assert.deepEqual(h.camera.view(),retained);
  h.enable(true);h.camera.sync();assert.deepEqual(h.painted.at(-1).view,retained);assert.equal(h.painted.at(-1).immediate,true);h.camera.dispose();
});

test("animated zoom-out never exposes an unintended edge while the scene is still magnified",()=>{
  const h=fixture();h.send("wheel",{ctrlKey:true,deltaY:-200});h.flush();h.send("wheel",{deltaY:100,deltaMode:1});h.flush();
  for(const {view} of h.painted){
    if(view.scale>=1){assert.ok(view.x<=0&&view.y<=0);assert.ok(view.x>=1920*(1-view.scale));assert.ok(view.y>=1080*(1-view.scale));}
    else{close(view.x,1920*(1-view.scale)/2);close(view.y,1080*(1-view.scale)/2);}
  }
  h.camera.dispose();
});

test("every wheel and native pinch zoom-out path clamps to the default scene",()=>{
  assert.deepEqual(constrainScene({scale:.1,x:800,y:-500}),{scale:1,x:0,y:0});
  const h=fixture();
  h.send("wheel",{ctrlKey:true,deltaY:1000});h.flush();
  assert.deepEqual(h.camera.view(),{scale:1,x:0,y:0});
  h.send("gesturestart");h.send("gesturechange",{scale:.1});h.send("gestureend");h.flush();
  assert.deepEqual(h.camera.view(),{scale:1,x:0,y:0});
  assert.ok(h.painted.every(({view})=>view.scale>=1));h.camera.dispose();
});
