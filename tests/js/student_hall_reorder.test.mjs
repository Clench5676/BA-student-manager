import assert from "node:assert/strict";
import { test } from "node:test";
import { bindReorder, dragFeedback, TOUCH_REORDER_HOLD } from "../../src/ba_modding_toolkit/web/js/student-hall-reorder.js";
import { horizontalScroll } from "../../src/ba_modding_toolkit/web/js/horizontal-scroll.js";
class Target {
  style={};dataset={};events=new Map();
  addEventListener(key,fn){if(!this.events.has(key))this.events.set(key,new Set());this.events.get(key).add(fn);}
  removeEventListener(key,fn){this.events.get(key)?.delete(fn);}
  emit(key,event){for(const fn of this.events.get(key)||[]){fn(event);if(event.immediateStopped)break;}}
  setAttribute(){}
  focus(){}
}
function harness({index=0,count=4,scale=.5,left=0,nativeScroll=false,type="mouse"}={}) {
  const document=new Target(),window=new Target(),hit=new Target(),scroll=new Target(),moved=[],captures=[],releases=[],feedbackEvents=[],frames=new Map();
  let frameId=0,now=0;window.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};window.cancelAnimationFrame=id=>frames.delete(id);
  document.defaultView=window;hit.ownerDocument=document;
  Object.assign(scroll,{clientWidth:600,scrollLeft:left,getBoundingClientRect:()=>({left:100,top:50,width:600*scale,height:100,bottom:150}),
    setPointerCapture:id=>captures.push(id),releasePointerCapture:id=>releases.push(id)});
  if(nativeScroll)horizontalScroll(scroll,600,count*200);
  const controller=new AbortController();let enabled=true;
  const feedback={start:event=>feedbackEvents.push(["start",event.clientX]),update:(event,target)=>feedbackEvents.push(["update",event.clientX,target]),cleanup:()=>feedbackEvents.push(["cleanup"])};
  const dispose=bindReorder(hit,{id:"resource-2",index,count,pitch:200,scroll,move:(...args)=>moved.push(args),enabled:()=>enabled,signal:controller.signal,feedback});
  const send=(name,x=125,extra={})=>{
    const event={button:0,pointerId:7,pointerType:type,isPrimary:true,clientX:x,clientY:100,detail:1,
      preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},stopImmediatePropagation(){this.stopped=true;this.immediateStopped=true;},...extra};
    if(name==="pointerdown"){document.emit(name,event);if(!event.stopped)hit.emit(name,event);if(!event.stopped)scroll.emit(name,event);}
    else if(name==="lostpointercapture")scroll.emit(name,event);
    else if(["keydown","click","contextmenu"].includes(name))hit.emit(name,event);
    else{document.emit(name,event);if(!event.stopped)scroll.emit(name,event);}
    return event;
  };
  return{send,moved,captures,releases,hit,controller,feedbackEvents,document,window,dispose,scroll,frames,disable:()=>{enabled=false;},
    frame(ms=16){now+=ms;const batch=[...frames.values()];frames.clear();for(const fn of batch)fn(now);},
    scrollTo(value){scroll.scrollLeft=value;scroll.emit("scroll",{});},blur(){window.emit("blur",{});}};
}
test("mouse capture owns the viewport stream instead of starting a simultaneous horizontal pan",()=>{
  const h=harness({nativeScroll:true,count:10,left:300});
  const down=h.send("pointerdown");assert.equal(down.stopped,true);assert.equal(h.hit.dataset.pointerOwned,"true");
  h.send("pointermove",395);assert.equal(h.hit.dataset.reordering,"true");assert.equal(h.scroll.scrollLeft,300,"horizontalScroll never received the grab pointerdown");
  h.send("pointerup",395);assert.deepEqual(h.captures,[7]);assert.deepEqual(h.releases,[7]);assert.deepEqual(h.moved,[["resource-2",3]]);
  assert.equal(h.hit.dataset.reordering,undefined);assert.equal(h.hit.dataset.pointerOwned,undefined);assert.deepEqual(h.feedbackEvents.at(-1),["cleanup"]);assert.equal(h.frames.size,0);
});
test("a fast native mouse drag with no intermediate move uses the final release position",()=>{
  const h=harness();h.send("pointerdown");h.send("pointerup",395);assert.deepEqual(h.moved,[["resource-2",2]]);
  assert.deepEqual(h.feedbackEvents[0],["start",125]);assert.deepEqual(h.feedbackEvents.filter(event=>event[0]==="update").at(-1),["update",395,3]);assert.deepEqual(h.feedbackEvents.at(-1),["cleanup"]);
});
test("the final release overrides a stale move and ignores other pointer releases",()=>{
  const h=harness();h.send("pointerdown");h.send("pointermove",220);h.send("pointerup",395,{pointerId:8});assert.deepEqual(h.moved,[]);
  h.send("pointerup",395);assert.deepEqual(h.moved,[["resource-2",2]]);
});
test("clicks, cancellation, lost capture, disposal, blur and a save cannot commit a drag",()=>{
  for(const stop of ["click","cancel","lost","abort","dispose","blur","saving"]){
    const h=harness();h.send("pointerdown");if(stop!=="click")h.send("pointermove",395);
    if(stop==="cancel")h.send("pointercancel");if(stop==="lost")h.send("lostpointercapture");if(stop==="abort")h.controller.abort();if(stop==="dispose")h.dispose();if(stop==="blur")h.blur();if(stop==="saving")h.disable();
    h.send("pointerup",stop==="click"?125:395);assert.deepEqual(h.moved,[],stop);assert.equal(h.hit.dataset.reordering,undefined,stop);assert.equal(h.hit.dataset.pointerOwned,undefined,stop);assert.equal(h.frames.size,0,stop);
    assert.deepEqual(h.feedbackEvents.at(-1),["cleanup"]);
    if(["abort","dispose"].includes(stop))assert.equal([...h.document.events.values()].reduce((n,set)=>n+set.size,0),0);
  }
});
test("short touch taps and swipes pan instead of accidentally reordering or playing",(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  try{
    const tap=harness({type:"touch"});tap.send("pointerdown");t.mock.timers.tick(120);tap.send("pointerup",128);t.mock.timers.tick(1000);
    assert.deepEqual(tap.moved,[]);assert.equal(tap.feedbackEvents.some(event=>event[0]==="start"),false);
    const pan=harness({type:"touch",nativeScroll:true,count:10,left:300});pan.send("pointerdown",200);pan.send("pointermove",150);assert.equal(pan.scroll.scrollLeft,400,"screen delta uses the current stage scale");
    t.mock.timers.tick(1000);pan.send("pointerup",125);assert.equal(pan.scroll.scrollLeft,450);assert.deepEqual(pan.moved,[]);assert.equal(pan.feedbackEvents.some(event=>event[0]==="start"),false);
    assert.equal(pan.send("click").defaultPrevented,true,"the compatibility click after a swipe is consumed");
    const vertical=harness({type:"touch"});vertical.send("pointerdown");vertical.send("pointermove",126,{clientY:150});t.mock.timers.tick(1000);vertical.send("pointerup",395);assert.deepEqual(vertical.moved,[]);
  }finally{t.mock.timers.reset();}
});
test("touch hold tolerates CSS-pixel jitter and then directly drags with menu/selection suppressed",(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  try{
    for(const scale of [.4,1]){
      const h=harness({type:"touch",scale,count:10});h.send("pointerdown",150);h.send("pointermove",155,{clientY:103});
      t.mock.timers.tick(TOUCH_REORDER_HOLD-1);assert.equal(h.hit.dataset.reordering,undefined);t.mock.timers.tick(1);assert.equal(h.hit.dataset.reordering,"true");
      assert.equal(h.send("contextmenu").defaultPrevented,true);assert.equal(h.hit.style.webkitTouchCallout,"none");assert.equal(h.hit.style.touchAction,"none");
      h.send("pointerup",100+600*scale);assert.deepEqual(h.moved,[["resource-2",2]]);assert.equal(h.frames.size,0);
    }
  }finally{t.mock.timers.reset();}
});
test("secondary touches, pointercancel, blur and disposal retire pending or active touch holds",(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  try{
    for(const active of [false,true])for(const stop of ["secondary","cancel","lost","blur","abort","dispose","hidden","save"]){
      const h=harness({type:"touch",count:20});h.send("pointerdown");if(active){t.mock.timers.tick(TOUCH_REORDER_HOLD);h.send("pointermove",395);}
      if(stop==="secondary")h.send("pointerdown",200,{pointerId:8,isPrimary:false});
      if(stop==="cancel")h.send("pointercancel");if(stop==="lost")h.send("lostpointercapture");if(stop==="blur")h.blur();if(stop==="abort")h.controller.abort();if(stop==="dispose")h.dispose();
      if(stop==="hidden"){h.document.hidden=true;h.document.emit("visibilitychange",{});}if(stop==="save"){h.disable();h.send("pointermove",395);}
      t.mock.timers.tick(1000);h.frame();h.send("pointerup",395);assert.deepEqual(h.moved,[],`${stop}, active=${active}`);assert.equal(h.hit.dataset.pointerOwned,undefined);assert.equal(h.frames.size,0);
    }
  }finally{t.mock.timers.reset();}
});
test("stationary-edge drag scrolls by elapsed time without new pointermoves and remains scale independent",()=>{
  const totals=[];
  for(const scale of [.5,1]){
    const h=harness({count:30,scale});h.send("pointerdown",150);h.send("pointermove",100+600*scale);
    for(let i=0;i<30;i++)h.frame();assert.ok(h.scroll.scrollLeft>200);totals.push(h.scroll.scrollLeft*scale);
    const target=h.feedbackEvents.filter(event=>event[0]==="update").at(-1)[2];assert.ok(target>3,"stationary edge advances the insertion gap");
    h.send("pointerup",100+600*scale);assert.equal(h.moved[0][1],target-1);assert.equal(h.frames.size,0);
  }
  assert.ok(Math.abs(totals[0]-totals[1])<.001);
});
test("edge scrolling is bounded, stops away from the viewport, and updates the marker after external scroll",()=>{
  const h=harness({count:4});h.send("pointerdown");h.send("pointermove",395);for(let i=0;i<100;i++)h.frame();assert.equal(h.scroll.scrollLeft,200);assert.equal(h.frames.size,0);
  h.send("pointermove",100,{clientY:300});for(let i=0;i<20;i++)h.frame();assert.equal(h.scroll.scrollLeft,200);
  h.send("pointermove",250);h.scrollTo(0);assert.deepEqual(h.feedbackEvents.filter(event=>event[0]==="update").at(-1),["update",250,2]);
  h.send("pointermove",100);for(let i=0;i<100;i++)h.frame();assert.equal(h.scroll.scrollLeft,0);assert.equal(h.frames.size,0);h.dispose();
});
test("Alt arrows remain available and Escape cancels only the active grab",()=>{
  const h=harness();h.send("keydown",0,{altKey:true,key:"ArrowLeft"});h.send("keydown",0,{altKey:true,key:"ArrowRight"});assert.deepEqual(h.moved,[["resource-2",1]]);
  h.send("pointerdown");h.send("pointermove",395);const escape=h.send("keydown",0,{key:"Escape"});assert.equal(escape.stopped,true);h.send("pointerup",395);assert.equal(h.moved.length,1);
});
test("drag ghost retains the decoded image and scaling, with a small finger clearance for touch",()=>{
  for(const pointerType of ["mouse","touch"]){
    const children=[],marker={hidden:true,style:{}};
    const visual={style:{opacity:".7"},offsetWidth:244,offsetHeight:175,getBoundingClientRect:()=>({left:100,top:100,width:122,height:87.5}),
      ownerDocument:{body:{appendChild(node){children.push(node);}}},cloneNode(){return{style:{},attrs:{},thumbnail:"decoded-current-frame",removeAttribute(){},setAttribute(key,value){this.attrs[key]=value;},remove(){children.splice(children.indexOf(this),1);}};}};
    const feedback=dragFeedback(visual,()=>marker,244,3);feedback.start({clientX:150,clientY:120,pointerType});
    assert.equal(visual.style.opacity,".5");assert.equal(children.length,1);assert.equal(children[0].thumbnail,"decoded-current-frame");assert.equal(children[0].style.transform,"scale(0.5)");
    feedback.update({clientX:300,clientY:200},2);assert.equal(children[0].style.left,"250px");assert.equal(children[0].style.top,pointerType==="touch"?"156px":"180px");assert.equal(marker.hidden,false);assert.equal(marker.style.transform,"translateX(483px)");
    feedback.update({clientX:100,clientY:200},0);assert.equal(marker.style.transform,"translateX(0px)");feedback.update({clientX:700,clientY:200},3);assert.equal(marker.style.transform,"translateX(722px)");
    feedback.cleanup();assert.equal(children.length,0);assert.equal(visual.style.opacity,".7");assert.equal(marker.hidden,true);
  }
});
test("disposed rows cannot attach new capture listeners",()=>{
  const hit=new Target(),controller=new AbortController();controller.abort();bindReorder(hit,{id:"gone",index:0,count:1,scroll:{},pitch:200,move(){throw new Error("disposed");},signal:controller.signal});assert.equal(hit.events.size,0);
});
test("insertion gaps still support endpoints and both source-adjacent no-op positions",()=>{
  const before=harness({index:2});before.send("pointerdown",350);before.send("pointerup",100);assert.deepEqual(before.moved,[["resource-2",0]]);
  const after=harness();after.send("pointerdown",150);after.scrollTo(200);after.send("pointerup",400);assert.deepEqual(after.moved,[["resource-2",3]]);
  for(const x of [200,300]){const h=harness({index:1});h.send("pointerdown",250);h.send("pointerup",x);assert.deepEqual(h.moved,[],`adjacent gap at ${x}`);}
});
