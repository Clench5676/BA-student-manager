import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { headerGeometry, rowLayout, subtractRegions, expandRect } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
import { topActionLayout, nativeRightClearance } from '../../src/ba_modding_toolkit/web/js/top-action-layout.js';
import { barCentre, CAPTION_PX } from '../../src/ba_modding_toolkit/web/js/top-bar-layout.js';
import { installCloseGuard } from '../../src/ba_modding_toolkit/web/js/window-close.js';

const S = 24 / 37;
const sizes = [[960,540], [1600,900], [2560,1080], [960,1200]];
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);
// Deterministic advance fixture: real locale strings feed the same measured-width
// contract as the DOM canvas. Native font rendering remains owner acceptance.
const textWidth = (text, font) => [...text].reduce((w,c) => w + font * (/[^\x00-\x7f]/.test(c) ? 1 : .65), 0);
const boxes = {home:[44,7,62*S,59*S],option:[44+175*S,7,60*S,62*S],line:[44+116.5*S,12,4*S,49*S]};
for (const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH']) test(`one row, native safe areas and caption-sized title in ${locale}`, () => {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url))).webui;
  for (const [width,height] of sizes) for (const density of [1,2,3]) for (const hall of [true,false]) for (const platform of ['darwin','win32','fallback']) {
    // Native APIs normalize device pixels/points before entering the web layout.
    const native = platform==='darwin' ? {left:12,top:8,right:80,bottom:30} : {left:width-148,top:0,right:width,bottom:32};
    const css = Object.fromEntries(Object.entries(native).map(([k,v]) => [k, v*density/density]));
    const g = headerGeometry(width,height,platform==='win32'?css.bottom:0), k=g.scale;
    assert.ok(g.rowHeight>=44); near(g.centre,barCentre(undefined,g.rowHeight));
    assert.ok(g.contentScale<=k);
    const base=topActionLayout(boxes,hall),safe=nativeRightClearance({left:0,top:0,right:width,width},platform==='win32'?css:null,base.option,k);
    const actions=topActionLayout(boxes,hall,safe);
    const rightStart=width-(actions.option[0]+actions.option[2])*k;
    const captionWidth=textWidth(strings.mods.switch,26)*k+12*k;
    for (const title of [strings.top.students,strings.hall.title,strings.nav.import]) for (const enlargement of [1,2]) {
      const row=rowLayout({scale:k,nativeLeft:platform==='darwin'?css.right:0,rightStart,
        titleWidth:textWidth(title,CAPTION_PX)*k*enlargement,modsWidth:240*k+captionWidth,captionWidth,hall});
      assert.equal(CAPTION_PX,26);
      if(platform==='darwin')assert.ok(38*k+row.shift>=css.right+8);
      else if(platform==='win32') assert.ok(width-actions[hall?"option":"home"][0]*k<=css.left-8+1e-7);
      assert.ok(row.titleLeft+row.titleWidth+32*k+row.modsWidth<=rightStart-64+1e-7);
      assert.ok(row.titleWidth>=0);
      if(enlargement===1) near(row.titleWidth,textWidth(title,CAPTION_PX)*k);
      near(row.titleLeft,(hall?38:160)*k+row.shift);
      // Hall keeps Settings in Home's former safe slot and all sprite sizes.
      if(hall)near(actions.option[0]+actions.option[2]/2,actions.home[0]+actions.home[2]/2);
      else near(actions.option[0]-actions.home[0]+(actions.option[2]-actions.home[2])/2,174*S, .01);
    }
  }
});

test('compact caption restores only with sixteen CSS pixels of spare width', () => {
  const input={scale:1,nativeLeft:80,titleWidth:220,modsWidth:460,captionWidth:220};
  const threshold=160+(80+8-38)+220+460+32+64;
  assert.equal(rowLayout({...input,rightStart:threshold-1}).compact,true);
  assert.equal(rowLayout({...input,rightStart:threshold,compact:false}).compact,false);
  assert.equal(rowLayout({...input,rightStart:threshold+15,compact:true}).compact,true);
  assert.equal(rowLayout({...input,rightStart:threshold+16,compact:true}).compact,false);
});

test('native bounds subtract only the missing right clearance, preserving sufficient margins',()=>{
  const stage={left:0,top:0,right:1600,width:1600};
  assert.equal(nativeRightClearance(stage,{left:1580,top:0,right:1600,bottom:32},boxes.home,1),28);
  assert.equal(topActionLayout(boxes,false,28).home[0],44);
});

test('every interactive hit and focus ring, native group and popup is excluded from native dragging',()=>{
  const background={left:0,top:0,right:1600,bottom:54};
  const hits=[{left:12,top:6,right:80,bottom:30},{left:88,top:8,right:176,bottom:100},
    {left:350,top:10,right:600,bottom:48},{left:1300,top:8,right:1450,bottom:48}].map(r=>expandRect(r));
  const regions=subtractRegions(background,hits);
  for(const r of regions){
    assert.ok(r.top>=0&&r.bottom<=54&&r.left>=0&&r.right<=1600);
    for(const h of hits)assert.ok(r.right<=h.left||r.left>=h.right||r.bottom<=h.top||r.top>=h.bottom);
  }
  assert.deepEqual(subtractRegions(background,[background]),[],'modal coverage removes every drag region');
});

function guardFixture(prepare) {
  const elements=[{inert:false},{inert:true}], target={}, focused=[];
  const previous={isConnected:true,closest:()=>false,focus:()=>focused.push(true)};
  installCloseGuard({prepare,root:()=>elements,focus:()=>previous,target});
  return {target,elements,focused};
}
test('clean, Save and Discard use the same Hall permission; cancel restores exact inert state and focus',async()=>{
  for(const outcome of ['clean','save','discard']){
    const calls=[];const f=guardFixture(async()=>{calls.push(outcome);return true;});
    assert.equal(await f.target.bamtPrepareClose('one'),true);
    assert.equal(await f.target.bamtPrepareClose('duplicate'),false);
    assert.deepEqual(f.elements.map(e=>e.inert),[true,true]);
    f.target.bamtCancelClose('foreign');assert.deepEqual(f.elements.map(e=>e.inert),[true,true]);
    f.target.bamtCancelClose('one');assert.deepEqual(f.elements.map(e=>e.inert),[false,true]);
    assert.equal(f.focused.length,1);assert.deepEqual(calls,[outcome]);
  }
});
test('Stay and failed Save leave the editor clickable',async()=>{
  for(const prepare of [async()=>false,async()=>{throw Error('save failed');}]){
    const f=guardFixture(prepare);assert.equal(await f.target.bamtPrepareClose('one'),false);
    assert.deepEqual(f.elements.map(e=>e.inert),[false,true]);
  }
});
test('late page replies cannot freeze or approve a later request after cancellation',async()=>{
  let resolve;const f=guardFixture(()=>new Promise(r=>resolve=r));
  const pending=f.target.bamtPrepareClose('old');
  f.target.bamtCancelClose('old');resolve(true);assert.equal(await pending,false);
  assert.deepEqual(f.elements.map(e=>e.inert),[false,true]);
  f.target.bamtCancelClose('not-started-yet');
  assert.equal(await f.target.bamtPrepareClose('not-started-yet'),false);
});

test('a new Hall draft revision invalidates an earlier approval',async()=>{
  const target={}, element={inert:false};let revision='one';
  installCloseGuard({prepare:async()=>true,root:()=>[element],revision:()=>revision,focus:()=>null,target});
  assert.equal(await target.bamtPrepareClose('close'),true);
  assert.equal(target.bamtValidateClose('close'),true);
  revision='two';assert.equal(target.bamtValidateClose('close'),false);
  target.bamtCancelClose('close');assert.equal(element.inert,false);
});


test('Hall uses the Back slot and restores the other rows without losing native clearance',()=>{
  for(const scale of [.5, 1, 2])for(const nativeLeft of [0,80]){
    const input={scale,nativeLeft,rightStart:2000*scale,titleWidth:200*scale,modsWidth:400*scale,captionWidth:160*scale};
    const before=rowLayout(input),hall=rowLayout({...input,hall:true}),after=rowLayout(input);
    near(before.titleLeft-hall.titleLeft,122*scale);
    assert.deepEqual(after,before);
    if(nativeLeft)near(hall.titleLeft,nativeLeft+8);
    assert.equal(hall.titleWidth,200*scale);
  }
});
