// Exercise the controller through its public setup and native events, using DOM
// and RPC fakes only. The raster and text-layout contracts have separate tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as geometry from '../../src/ba_modding_toolkit/web/js/window-layout.js';
class Classes extends Set {
  contains(name){return this.has(name);}
  toggle(name,on=!this.has(name)){on?this.add(name):this.delete(name);return on;}
  remove(...names){names.forEach(name=>this.delete(name));}
}
class El {
  children=[];style={setProperty(key,value){this[key]=value;},removeProperty(key){delete this[key];}};
  classList=new Classes();hidden=false;inert=false;textContent='';attrs={};dataset={};
  constructor(name='div'){this.name=name;}
  set className(value){this.classList=new Classes(value.split(' '));}
  get className(){return [...this.classList].join(' ');}
  append(...nodes){for(const node of nodes){node.remove();node.parent=this;this.children.push(node);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  before(node){const parent=this.parent;node.parent=parent;parent.children.splice(parent.children.indexOf(this),0,node);}
  replaceWith(node){const parent=this.parent,index=parent.children.indexOf(this);node.remove();parent.children.splice(index,1,node);node.parent=parent;this.parent=null;}
  descendants(){return this.children.flatMap(node=>[node,...node.descendants()]);}
  matches(selector){return selector==='button'?this.name==='button':selector.startsWith('.')?this.classList.has(selector.slice(1)):false;}
  querySelectorAll(selector){return this.descendants().filter(node=>selector.split(',').some(s=>node.matches(s.trim())));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  setAttribute(key,value){this.attrs[key]=value;}
  addEventListener(){}
  getClientRects(){return this.hidden?[]:[this.getBoundingClientRect()];}
  getBoundingClientRect(){
    let left=0,top=0,width=960,height=44;
    if(this===stage){width=960;height=540;}
    if(this===back){left=88;top=4;width=54;height=56;}
    if(this===mods){left=300;top=4;width=250;height=32;}
    if(this===option){left=740;width=40;height=32;}
    if(this===sceneBack){left=12.5;top=10;width=54;height=56;}
    if(this.id==='native-controls'){left=852;width=108;height=24;}
    if(this===toggle||this===help){width=40;height=32;}
    if(this===header&&this.style.width){width=parseFloat(this.style.width)*.5;height=parseFloat(this.style.height)*.5;}
    return {left,top,right:left+width,bottom:top+height,width,height};
  }
}
const root=new El(),body=new El(),stage=new El(),header=new El(),title=new El(),mods=new El(),label=new El(),
  option=new El('button'),back=new El('button'),sceneBack=new El('button'),toggle=new El(),help=new El('button'),popup=new El();
header.className='topbar';title.className='title';title.textContent='Student Hall';mods.className='mod-switch';
label.className='ms-label';label.textContent='Enable Mods';option.className='top-option';back.className='back';
mods.append(toggle,label,help);header.append(back,title,mods,option);stage.append(header,sceneBack);body.append(stage);popup.hidden=true;
const frames=[],listeners={},handlers={},calls=[],observed=[];
const doc={body,documentElement:root,createElement:name=>new El(name),createComment:()=>new El('comment'),
  getElementById:id=>id==='stage'?stage:body.descendants().find(el=>el.id===id),
  querySelector:selector=>body.querySelector(selector),querySelectorAll:()=>[popup]};
globalThis.document=doc;globalThis.innerWidth=960;globalThis.innerHeight=540;globalThis.pywebview={};
globalThis.requestAnimationFrame=fn=>frames.push(fn);globalThis.addEventListener=(name,fn)=>listeners[name]=fn;
globalThis.getComputedStyle=el=>({visibility:el===back&&back.hidden?'hidden':'visible'});
globalThis.MutationObserver=class {constructor(fn){this.fn=fn;}observe(target,opts){observed.push({target,opts,fn:this.fn});}};
let alignmentGate=null;
let snapshot={active:true,valid:true,platform:'darwin',sequence:1,bounds:{left:12,top:8,right:80,bottom:30}};
globalThis.chromeFixture={...geometry,on:(name,fn)=>handlers[name]=fn,rpc:async(name,value)=>{
  if(name==='window.chrome')return snapshot;calls.push({name,value});},T:key=>key,
  reflowTopActions(){},sizeTitle(){title.style.fontSize='26px';},alignTopBar:async()=>{if(alignmentGate)await alignmentGate;},fitStage(){},
  naturalTextWidth:(el,scale)=>Math.ceil(el.textContent.length*13*scale),paintTopBar:async()=>{}};
let source=readFileSync(new URL('../../src/ba_modding_toolkit/web/js/window-chrome.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
source=`const {on,rpc,T,reflowTopActions,sizeTitle,alignTopBar,fitStage,naturalTextWidth,paintTopBar,headerGeometry,rowLayout,isImmersive,dragRegions,expandRect}=globalThis.chromeFixture;\n${source}`;
const {setupWindowChrome}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
async function settle(){for(let i=0;i<8;i++){frames.splice(0).forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));}}
const payload=()=>calls.filter(c=>c.name==='window.layout').at(-1).value;
const change=async()=>{listeners.resize();await settle();};
test('native and fallback controllers hide and restore every immersive scene and block popup dragging',async()=>{
  setupWindowChrome();await settle();
  assert.ok(observed.some(({target,opts})=>target===root&&opts.attributeFilter.includes('class')));
  for(const platform of ['darwin','win32']){
    snapshot={...snapshot,sequence:snapshot.sequence+1,platform,bounds:platform==='darwin'?{left:12,top:8,right:80,bottom:30}:{left:812,top:0,right:960,bottom:32}};
    handlers['window.chrome'](snapshot);await settle();
    assert.ok(body.classList.has('native-chrome'));assert.equal(doc.getElementById('native-controls'),undefined);
    for(const [stageFlags,rootFlags] of [[['fullscreen'],[]],[['fullscreen'],[]],[['fullscreen'],['photo-active']],[['fullscreen'],['photo-active','photo-lobby']],[['hall-fullscreen'],[]],[[],['photo-active']]]){
      stage.classList=new Classes(stageFlags);root.classList=new Classes(rootFlags);await change();
      assert.ok(body.classList.has('window-immersive'));assert.equal(header.inert,true);
      assert.equal(globalThis.bamtHeaderGeometry.extra,0);assert.equal(sceneBack.inert,false);
      assert.deepEqual(payload().drag,[]);
      assert.equal(body.querySelectorAll('.window-drag-region').length,0);
      popup.hidden=false;await change();assert.deepEqual(payload().drag,[]);
      assert.equal(body.querySelectorAll('.window-drag-region').length,0);
      popup.hidden=true;stage.classList.clear();root.classList.clear();await change();
      assert.equal(body.classList.has('window-immersive'),false);assert.equal(header.inert,false);
      assert.ok(payload().drag.some(rect=>rect.bottom>12));
    }
  }
  // A slow decoded sprite cannot leave the previous full drag row over the
  // scene, and a late alignment completion cannot re-enable it under a popup.
  let release;alignmentGate=new Promise(resolve=>release=resolve);
  stage.classList.add('fullscreen');await change();assert.deepEqual(payload().drag,[]);
  popup.hidden=false;await change();assert.deepEqual(payload().drag,[]);
  alignmentGate=null;release();await settle();assert.deepEqual(payload().drag,[]);
  popup.hidden=true;await change();assert.deepEqual(payload().drag,[]);
  stage.classList.clear();await change();
  snapshot={...snapshot,active:false,sequence:snapshot.sequence+1};handlers['window.chrome'](snapshot);await settle();
  assert.equal(header.parent,stage);assert.equal(body.classList.has('native-chrome'),false);
  assert.equal(body.descendants().filter(el=>el.id==='native-controls').length,1);
  root.classList.add('photo-active');await change();
  assert.ok(body.classList.has('window-immersive'));assert.equal(body.querySelectorAll('.window-drag-region').length,0);
  popup.hidden=false;await change();assert.equal(body.querySelectorAll('.window-drag-region').length,0);
  popup.hidden=true;root.classList.clear();await change();
  assert.equal(body.classList.has('window-immersive'),false);assert.equal(body.querySelectorAll('.window-drag-region').length,0);
});
