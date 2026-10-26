import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../../src/ba_modding_toolkit/web/js/photography/controller.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function deletePhoto()'),source.indexOf('async function applyGame()'));
function setup({used=false,official=false,answer='ok',fail=false,locale='en-US'}={}){
  const requests=[],prompts=[];let changed=0;
  const strings=JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url),'utf8')).webui;
  const T=key=>key.split('.').reduce((v,key)=>v[key],strings),P=key=>T('photo.'+key);
  const env={T,P,call:async(method,params)=>{requests.push([method,params]);return method==='removalInfo'?{used,official}:{photos:[]};},
    Popup:{message:async options=>{prompts.push(options);return {button:answer};}},
    Loading:{task:fn=>fn()},waitJob:async result=>{if(fail)throw new Error('Storage failed');return result;},
    bridge:{thumbnailChanged:()=>changed++},galleryDraw:async()=>{},normalized:v=>v};
  const api=new Function('env',`const {${Object.keys(env)}}=env;let selected='capture',generation=1,repository={photos:[{id:'capture'}]};const DEFAULT='generated';${code};return {deletePhoto,selected:()=>selected,repository:()=>repository};`)(env);
  return {...api,requests,prompts,changed:()=>changed};
}
for(const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH'])test(`applied-photo confirmation uses the approved localized wording in ${locale}`,async()=>{
  const h=setup({used:true,locale});await h.deletePhoto();
  assert.equal(h.prompts.length,1);assert.ok(h.prompts[0].lines[0]);
  if(locale==='zh-CN')assert.equal(h.prompts[0].lines[0],'该资产正在被应用中，是否删除？');
  assert.deepEqual(h.requests[1],['delete',{id:'capture',confirm:true}]);assert.equal(h.changed(),1);
});
test('official is rejected, cancellation preserves choices, and preview-only deletion needs no in-use prompt',async()=>{
  const official=setup({official:true});await official.deletePhoto();assert.equal(official.requests.length,1);
  const cancel=setup({used:true,answer:'cancel'});await cancel.deletePhoto();assert.equal(cancel.requests.length,1);assert.equal(cancel.selected(),'capture');
  const preview=setup();await preview.deletePhoto();assert.equal(preview.prompts.length,0);assert.equal(preview.selected(),'generated');
});
test('a failed deletion cannot change selection or publish thumbnail success',async()=>{
  const h=setup({fail:true});await assert.rejects(()=>h.deletePhoto(),/Storage failed/);
  assert.equal(h.selected(),'capture');assert.equal(h.changed(),0);assert.equal(h.repository().photos[0].id,'capture');
});
test('official and runtime gallery entries omit Delete; persisted generated photos remain managed',()=>{
  assert.match(source,/provenance:'official',managed:false/);
  assert.match(source,/provenance:'runtime',managed:false/);
  assert.match(source,/if\(selectedPhoto.managed!==false&&selectedPhoto.provenance!=='official'\)await UI.button\(layer,'Delete'/);
  assert.ok(!source.includes('enabled:!selectedPhoto.original'));
});
