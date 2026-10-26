import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {FRAME} from '../../src/ba_modding_toolkit/web/js/photography/camera.js';
const source=(await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/capture.js',import.meta.url),'utf8')).replace("import * as NGUI from '../ngui.js';","const NGUI={load:async()=>{throw new Error('Unexpected fallback')}};");
const adjusted=source.replace("import {FRAME} from './camera.js';",`const FRAME=${JSON.stringify(FRAME)};`);
const {projectedCrop,captureScene}=await import('data:text/javascript;base64,'+Buffer.from(adjusted).toString('base64'));
test('the crop is exactly centered in the student-detail stage at either display scale',()=>{
  for(const scale of [.5,1,1.5]){
    const box={left:10,top:20,width:1920*scale,height:1080*scale};
    const crop=projectedCrop(box);
    assert.equal(crop.left+crop.width/2,box.left+box.width/2);
    assert.equal(crop.top+crop.height/2,box.top+box.height/2);
  }
});
function fixture(){
  const drawn=[],root={hidden:false,parentElement:null},style={opacity:'1',display:'block',visibility:'visible',zIndex:'1',mixBlendMode:'normal'};
  const rect={left:10,top:20,right:970,bottom:560,width:960,height:540};
  const real={tagName:'CANVAS',width:3840,height:2160,parentElement:root,getBoundingClientRect:()=>rect,closest:()=>null};
  const subtitle={...real,closest:()=>({})};
  root.querySelectorAll=selector=>{assert.equal(selector,'canvas,img,div.ngui');return [real,subtitle];};
  globalThis.getComputedStyle=()=>style;
  let canvas,alpha=255,hook;
  globalThis.document={createElement:name=>{assert.equal(name,'canvas');return canvas={getContext:()=>({clearRect(){},drawImage:(...args)=>{if(hook)hook();drawn.push(args);},getImageData:()=>({data:new Uint8Array([0,0,0,alpha])})}),toDataURL:type=>{assert.equal(type,'image/png');return 'data:image/png;base64,example';}};}};
  return {root,real,drawn,rect,getCanvas:()=>canvas,blank:()=>alpha=0,fail:fn=>hook=fn};
}
test('capture reads the actual renderer at native crop density and excludes subtitle media',async()=>{
  const h=fixture();
  const result=await captureScene([h.root],{getBoundingClientRect:()=>h.rect});
  assert.equal(result.width,638);assert.equal(result.height,720);
  assert.equal(h.drawn.length,2);assert.equal(h.drawn[0][0],h.real);
  assert.equal(h.getCanvas().width,638);
});
test('an unavailable renderer fails instead of enlarging a thumbnail as fallback',async()=>{
  const h=fixture();h.root.querySelectorAll=()=>[];
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),/not ready/);
});

test('transparent renderer pixels are transient and never produce a saved blank',async()=>{
  const h=fixture();h.blank();
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{code:'capture_not_ready'});
});
test('draw races retry, while canvas security failures remain permanent',async()=>{
  const h=fixture();h.fail(()=>{throw new DOMException('Pending image','InvalidStateError');});
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{code:'capture_not_ready'});
  h.fail(()=>{throw new DOMException('Tainted canvas','SecurityError');});
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{name:'SecurityError'});
});

test('an opaque background cannot disguise an empty renderer',async()=>{
  const h=fixture();h.blank();
  const background={...h.real,tagName:'IMG',complete:true,decode:async()=>{}};
  h.root.querySelectorAll=()=>[background,h.real];
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{code:'capture_not_ready'});
  assert.ok(h.drawn.every(([image])=>image===h.real));
});
test('hidden stage and loading images are transient, broken image decoding is permanent',async()=>{
  const h=fixture();
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>({...h.rect,width:0})}),{code:'capture_not_ready'});
  const image={...h.real,tagName:'IMG',complete:false};h.root.querySelectorAll=()=>[h.real,image];
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{code:'capture_not_ready'});
  image.complete=true;image.decode=async()=>{throw new DOMException('Invalid image','EncodingError');};
  await assert.rejects(()=>captureScene([h.root],{getBoundingClientRect:()=>h.rect}),{name:'EncodingError'});
});
