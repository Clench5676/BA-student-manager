import assert from "node:assert/strict";
import { test } from "node:test";
import { createFullscreen } from "../../src/ba_modding_toolkit/web/js/student-hall-fullscreen.js";
class Element {
  constructor(doc){this.doc=doc;this.children=[];this.inert=false;this.isConnected=true;this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};this.attrs={};}
  append(element){element.parent=this;this.children.push(element);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.isConnected=false;}
  contains(element){return element===this||this.children.some(child=>child.contains(element));}
  closest(){return this.inert?this:this.parent?.closest()||null;}
  focus(){this.doc.activeElement=this;}
  blur(){if(this.doc.activeElement===this)this.doc.activeElement=null;}
  setAttribute(key,value){this.attrs[key]=value;}
}
function fixture(){
  const handlers=new Map(),doc={activeElement:null,addEventListener(type,fn){handlers.set(type,fn);},removeEventListener(type,fn){if(handlers.get(type)===fn)handlers.delete(type);}};
  const root=new Element(doc),stage=new Element(doc),chrome=new Element(doc),top=new Element(doc),nav=new Element(doc),entry=new Element(doc),detailExit=new Element(doc);
  stage.append(top);stage.append(nav);stage.append(root);root.append(chrome);chrome.append(entry);stage.append(detailExit);
  stage.classList.add("fullscreen");stage.querySelector=selector=>selector===".topbar"?top:nav;
  let waiting=null,popup=false;const built=[],changes=[];
  const api=createFullscreen({root,stage,chrome,document:doc,popupOpen:()=>popup,returnFocus:()=>entry,
    prepareExit:async close=>{const host=new Element(doc),button=new Element(doc);host.append(button);const result={host,button,close};built.push(result);await waiting;return result;},
    onChange:value=>changes.push(value)});
  entry.focus();
  return {api,doc,root,stage,chrome,top,nav,entry,detailExit,built,changes,handlers,hold:promise=>{waiting=promise;},popup:value=>{popup=value;},
    escape(extra={}){const event={key:"Escape",preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};handlers.get("keydown")?.(event);return event;}};
}
test("immersive entry holds only Hall and global chrome, keeps a visible focusable exit and restores original inert and focus",async()=>{
  const h=fixture();h.nav.inert=true;await h.api.enter();
  assert.equal(h.api.active(),true);assert.equal(h.top.inert,true);assert.equal(h.chrome.inert,true);assert.equal(h.doc.activeElement,h.built[0].button);
  assert.equal(h.stage.classes.has("hall-fullscreen"),true);assert.equal(h.stage.classes.has("fullscreen"),true);assert.equal(h.detailExit.inert,false);
  h.built[0].close();assert.equal(h.api.active(),false);assert.equal(h.top.inert,false);assert.equal(h.chrome.inert,false);assert.equal(h.nav.inert,true);
  assert.equal(h.doc.activeElement,h.entry);assert.equal(h.stage.classes.has("fullscreen"),true);assert.equal(h.built[0].host.isConnected,false);
});
test("Escape exits Hall, respects popup ownership and composition, and never propagates an exit key",async()=>{
  const h=fixture();await h.api.enter();h.popup(true);assert.equal(h.escape().defaultPrevented,undefined);assert.equal(h.api.active(),true);
  h.popup(false);h.escape({isComposing:true});assert.equal(h.api.active(),true);
  const event=h.escape();assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);assert.equal(h.api.active(),false);
});
test("navigation during asynchronous exit preparation cannot hide the destination or publish a late control",async()=>{
  const h=fixture();let ready;h.hold(new Promise(resolve=>{ready=resolve;}));const entry=h.api.enter();
  assert.equal(h.top.inert,false);h.api.dispose();ready();assert.equal(await entry,false);
  assert.equal(h.stage.classes.has("hall-fullscreen"),false);assert.equal(h.built[0].host.isConnected,false);assert.equal(h.handlers.size,0);assert.deepEqual(h.changes,[]);
});
test("a canceled pending entry cannot override a later successful entry",async()=>{
  const h=fixture();let ready;h.hold(new Promise(resolve=>{ready=resolve;}));const old=h.api.enter();h.escape();h.hold(null);await h.api.enter();
  ready();assert.equal(await old,false);assert.equal(h.api.active(),true);assert.equal(h.root.children.includes(h.built[1].host),true);assert.equal(h.root.children.includes(h.built[0].host),false);
  h.api.dispose();assert.equal(h.top.inert,false);assert.equal(h.chrome.inert,false);
});
test("cleanup restores UI without refocusing the departing route, and relabel affects only the owned exit",async()=>{
  const h=fixture();await h.api.enter();h.api.relabel("Leave immersive view");assert.equal(h.built[0].button.attrs["aria-label"],"Leave immersive view");assert.deepEqual(h.detailExit.attrs,{});
  const destination=new Element(h.doc);destination.focus();h.api.dispose();assert.equal(h.doc.activeElement,destination);assert.equal(h.chrome.inert,false);assert.equal(h.stage.classes.has("hall-fullscreen"),false);
});

test('Hall immersion holds a window-anchored toolbar outside the stage and restores its focus',async()=>{
  const f=fixture(),top=new Element(f.doc);
  // The real header is now a document sibling of the scaled stage.
  f.doc.querySelector=selector=>selector==='.topbar'?top:null;
  top.append(f.entry);f.entry.focus();
  await f.api.enter();
  assert.equal(top.inert,true);
  f.api.leave();
  assert.equal(top.inert,false);
  assert.equal(f.doc.activeElement,f.entry);
});
