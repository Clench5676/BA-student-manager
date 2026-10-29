import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../../src/ba_modding_toolkit/web/js/photography/controller.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function deletePhoto()'),source.indexOf('async function applyGame()'));
test('gallery cards and their accessible Applied label consume only the target-scoped flag', async () => {
  const drawCode=source.slice(source.indexOf('async function galleryDraw()'),source.indexOf('async function deletePhoto()'));
  const photos=[{id:'own',name:'Own skin',url:'own.png',applied:true},{id:'other',name:'Other skin',url:'other.png',applied:false}];
  const cards=[],hits=[];
  const env={Popup:{selectionReady:async()=>{},listCard:(item,x,y,selected)=>{cards.push({...item,selected});return item;}},
    galleryPhotos:()=>photos,photo:()=>null,modal:{draw:fn=>fn({})},NGUI:{render:async()=>{}},
    UI:{buttonSize:()=>({}),button:async()=>{}},
    hitButton:(_layer,_box,_fn,label)=>hits.push(label),safe:fn=>fn,P:key=>key};
  await new Function('env',`const {${Object.keys(env)}}=env;let page=0,selected='other',repository={game:{id:'own'}};const OFFICIAL='official';${drawCode};return galleryDraw();`)(env);
  assert.deepEqual(cards.map(card=>[card.key,card.applied,card.selected]),[['own',true,false],['other',false,true]]);
  assert.deepEqual(hits,['Own skin - applied','Other skin']);
});
function setup({used=false,used_here=used,used_elsewhere=false,official=false,answer='ok',fail=false,locale='en-US'}={}){
  const requests=[],prompts=[];let changed=0;
  const strings=JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url),'utf8')).webui;
  const T=key=>key.split('.').reduce((v,key)=>v[key],strings),P=key=>T('photo.'+key);
  const env={T,P,call:async(method,params)=>{requests.push([method,params]);return method==='removalInfo'?{used,used_here,used_elsewhere,official}:{photos:[]};},
    Popup:{message:async options=>{prompts.push(options);return {button:answer};}},
    Loading:{task:fn=>fn()},waitJob:async result=>{if(fail)throw new Error('Storage failed');return result;},
    bridge:{thumbnailChanged:()=>changed++},galleryDraw:async()=>{},normalized:v=>v};
  const api=new Function('env',`const {${Object.keys(env)}}=env;let selected='capture',generation=1,repository={photos:[{id:'capture'}]};const DEFAULT='generated';${code};return {deletePhoto,selected:()=>selected,repository:()=>repository};`)(env);
  return {...api,requests,prompts,changed:()=>changed};
}
const otherVariantWarnings={
  'en-US':'In use by another alt','zh-CN':'正在被另一换皮使用','zh-TW':'正在被另一換皮使用',
  'ja-JP':'別のバリエーションで使用中','ko-KR':'다른 바리에이션에서 사용 중','th-TH':'กำลังใช้กับชุดอื่น',
};
for(const [locale,otherWarning] of Object.entries(otherVariantWarnings)){
  for(const [state,used_here,used_elsewhere] of [['shown skin',true,false],['other skin',false,true],['both skins',true,true]]){
    test(`${state} photo confirmation uses the approved localized wording in ${locale}`,async()=>{
      const h=setup({used:true,used_here,used_elsewhere,locale});await h.deletePhoto();
      const ui=JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url),'utf8')).webui;
      assert.equal(h.prompts.length,1);
      assert.deepEqual(h.prompts[0].lines,[used_here?ui.error.asset_delete_confirm:otherWarning]);
      assert.equal(h.prompts[0].ok,ui.photo.delete);assert.equal(h.prompts[0].cancel,ui.popup.cancel);
      assert.deepEqual(h.requests[1],['delete',{id:'capture',confirm:true}]);assert.equal(h.changed(),1);
    });
  }
  test(`unused photo skips the warning and retains the unconfirmed delete flag in ${locale}`,async()=>{
    const h=setup({locale});await h.deletePhoto();
    assert.equal(h.prompts.length,0);assert.deepEqual(h.requests[1],['delete',{id:'capture',confirm:false}]);
  });
}
test('official is rejected, cancellation preserves choices, and preview-only deletion needs no in-use prompt',async()=>{
  const official=setup({official:true});await official.deletePhoto();assert.equal(official.requests.length,1);
  const cancel=setup({used:true,answer:'cancel'});await cancel.deletePhoto();assert.equal(cancel.requests.length,1);assert.equal(cancel.selected(),'capture');
  for(const answer of ['cancel',null]){
    const other=setup({used:true,used_here:false,used_elsewhere:true,answer});await other.deletePhoto();
    assert.equal(other.requests.length,1);assert.equal(other.selected(),'capture');assert.equal(other.changed(),0);
  }
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

test('the gallery reuses the stored default card and retains separate skin defaults',()=>{
  const start=source.indexOf('const galleryPhotos=');
  const code=source.slice(start,source.indexOf('const photo=',start));
  const cards=new Function('repository','sessionVariant',`const DEFAULT='generated',OFFICIAL='official',P=k=>k,generatedThumbnail='runtime',defaultThumbnail='official';${code};return galleryPhotos();`);
  const own={id:'stored',variant:'a',builtin:'generated',url:'stored.png',applied:true};
  const other={id:'skin',variant:'b',builtin:'generated',url:'skin.png'};
  assert.deepEqual(cards({photos:[own,other]},'a').map(p=>p.id),['official','stored','skin']);
  assert.deepEqual(cards({photos:[other]},'a').map(p=>p.id),['generated','official','skin']);
});
