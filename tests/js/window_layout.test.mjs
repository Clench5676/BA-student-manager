import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { headerGeometry, rowLayout, subtractRegions, expandRect, stageCoverBleed } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
import { topActionLayout, nativeRightClearance } from '../../src/ba_modding_toolkit/web/js/top-action-layout.js';
import { barCentre } from '../../src/ba_modding_toolkit/web/js/top-bar-layout.js';
import { cornerPrefabs } from './corner_prefabs.mjs';
import { CORNER_MARGIN } from '../../src/ba_modding_toolkit/web/js/corner-layout.js';
import { installCloseGuard } from '../../src/ba_modding_toolkit/web/js/window-close.js';

const S = 24 / 37;
const sizes = [[960,540], [1600,900], [2560,1080], [960,1200]];
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);
// Deterministic advance fixture: real locale strings feed the same measured-width
// contract as the DOM canvas. Native font rendering remains owner acceptance.
const textWidth = (text, font) => [...text].reduce((w,c) => w + font * (/[^\x00-\x7f]/.test(c) ? 1 : .65), 0);
const prefabs=cornerPrefabs.UICharacterCollection,right='NUITop_Scenes/Top/Right/';
const cssSource=readFileSync(new URL('../../src/ba_modding_toolkit/web/css/app.css',import.meta.url),'utf8');
const borderLeft=Number(/border-width: 0 11px 0 (\d+)px/.exec(cssSource)[1]);
const marginLeft=Number(/\.mod-switch \{[^}]*margin-left: (-?[\d.]+)px/.exec(cssSource)[1]);
const hallMargin=Number(/\.topbar\.hall-home \.mod-switch \{ margin-left: (-?[\d.]+)px/.exec(cssSource)[1]);
const home=prefabs[right+'Lobby'];
const boxes=Object.fromEntries([['home','Lobby'],['option','Option'],['line','Line (1)']].map(([key,path])=>{
  const node=prefabs[right+path], [w,h]=node.size;
  return [key,[CORNER_MARGIN+(home.pos[0]-node.pos[0]+(home.size[0]-w)/2)*S,
    7+(home.pos[1]-node.pos[1]+(home.size[1]-h)/2)*S,w*S,h*S]];
}));
const pages=[{name:'Hall',hall:true,modsVisible:true},{name:'roster',hall:false,modsVisible:true},
  {name:'detail',hall:false,modsVisible:true},{name:'import',hall:false,modsVisible:true},{name:'message',hall:false,modsVisible:false}];
for (const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH']) test(`title-free rows for every page and native bounds in ${locale}`, () => {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url))).webui;
  // Preserve the real ON/OFF labels, prefab switch/help widgets and CSS gaps.
  const toggleWidth=[strings.settings.post.on,strings.settings.post.off].reduce((w,label)=>w+Math.max(82,textWidth(label,24)+28),0);
  const fixedMods=toggleWidth+40+12;
  const captionWidth=textWidth(strings.mods.switch,26)+12;
  for (const [width,height] of sizes) for (const density of [1,2,3]) for (const {hall,modsVisible} of pages) {
    for (const [platform,hasBounds] of [['darwin',true],['win32',true],['darwin',false],['win32',false],['fallback',false]]) {
      // Native APIs normalize device pixels/points before entering the web layout.
      const native = platform==='darwin' ? {left:12,top:8,right:80,bottom:30} : {left:width-148,top:0,right:width,bottom:32};
      const css=hasBounds?Object.fromEntries(Object.entries(native).map(([k,v])=>[k,v*density/density])):null;
      const g=headerGeometry(width,height,platform==='win32'?css?.bottom:0), k=g.scale;
      assert.ok(g.rowHeight>=44); near(g.centre,barCentre(undefined,g.rowHeight));
      assert.ok(g.contentScale<=k);
      const base=topActionLayout(boxes,hall),safe=nativeRightClearance({left:0,top:0,right:width,width},platform==='win32'?css:null,base.option,k);
      const actions=topActionLayout(boxes,hall,safe);
      const rightStart=width-(actions.option[0]+actions.option[2])*k;
      const row=rowLayout({scale:k,nativeLeft:platform==='darwin'?css?.right:0,rightStart,
        modsWidth:(fixedMods+captionWidth)*k,captionWidth:captionWidth*k,hall,modsVisible});
      if(platform==='darwin'&&css)assert.ok(38*k+row.shift>=css.right+8);
      else if(platform==='win32'&&css)assert.ok(width-actions[hall?'option':'home'][0]*k<=css.left-8+1e-7);
      assert.ok(row.modsLeft+row.modsWidth<=rightStart-64+1e-7);
      near(row.modsLeft,(hall?38:160)*k+row.shift);
      near(row.modsLeft,(borderLeft+(hall?hallMargin:marginLeft))*k+row.shift);
      assert.equal(row.compact,false,'the real caption fits in all supported windows after title removal');
      near(row.modsWidth,modsVisible?(fixedMods+captionWidth)*k:0);
      if(modsVisible&&!hall){
        const backRight=(CORNER_MARGIN+prefabs['SeletControl/Top/BG_W/Bg/Btn/Btn'].size[0]*S)*k+row.shift;
        assert.ok(row.modsLeft>=backRight,'the group clears the prefab Back hit box');
      }
      // Hall retains Settings in Home's former safe slot; all sprite sizes stay.
      for(const name of ['home','option','line'])assert.deepEqual(actions[name].slice(2),boxes[name].slice(2));
      if(hall)near(actions.option[0]+actions.option[2]/2,actions.home[0]+actions.home[2]/2);
      else near(actions.option[0]-actions.home[0]+(actions.option[2]-actions.home[2])/2,174*S);
    }
  }
});

test('compact row hides only the caption and restores with sixteen CSS pixels spare', () => {
  for(const scale of [.5,1,2])for(const hall of [false,true]){
    const input={scale,hall,nativeLeft:80,modsWidth:460*scale,captionWidth:220*scale};
    const full=rowLayout({...input,rightStart:2000});
    const threshold=full.modsLeft+input.modsWidth+64;
    const compact=rowLayout({...input,rightStart:threshold-1});
    assert.equal(compact.compact,true);
    near(compact.modsWidth,240*scale,'switch and help keep their widths');
    near(compact.modsLeft,full.modsLeft);
    assert.equal(rowLayout({...input,rightStart:threshold,compact:false}).compact,false);
    assert.equal(rowLayout({...input,rightStart:threshold+15,compact:true}).compact,true);
    assert.equal(rowLayout({...input,rightStart:threshold+16,compact:true}).compact,false);
    assert.equal(rowLayout({...input,rightStart:threshold-1,modsVisible:false}).modsWidth,0);
  }
});

test('native bounds subtract only the missing right clearance, preserving sufficient margins',()=>{
  const stage={left:0,top:0,right:1600,width:1600};
  assert.equal(nativeRightClearance(stage,{left:1580,top:0,right:1600,bottom:32},boxes.home,1),28);
  assert.equal(topActionLayout(boxes,false,28).home[0],CORNER_MARGIN);
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
    const input={scale,nativeLeft,rightStart:2000*scale,modsWidth:400*scale,captionWidth:160*scale};
    const before=rowLayout(input),hall=rowLayout({...input,hall:true}),after=rowLayout(input);
    near(before.modsLeft-hall.modsLeft,122*scale);
    assert.deepEqual(after,before);
    if(nativeLeft)near(hall.modsLeft,nativeLeft+8);
  }
});

for(const [width,height] of [[960,540],[1600,900],[2560,1440]])test(`16:9 content at ${width}x${height} has no header-induced letterbox`,()=>{
  for(const immersive of [false,true]){
    const g=headerGeometry(width,height,0,immersive);
    assert.equal(g.extra,0);near(1920*g.contentScale,width);near(1080*g.contentScale,height);
    assert.ok(g.rowHeight>=44);near(g.centre,barCentre(undefined,g.rowHeight));
  }
});

for(const dpi of [1,1.25,1.5,2,3])test(`opaque loading cover includes the stage's antialiasing footprint at DPI ${dpi}`,()=>{
  for(const [width,height] of [[960,540],[1600,900],[2560,1440],[1568,900],[2560,1080],[960,1200]]){
    const g=headerGeometry(width,height),scale=g.contentScale,bleed=stageCoverBleed(scale,dpi);
    near(bleed*scale*dpi,1);
    for(const fraction of [0,.125,.25,.5,.875]){
      const left=(width-1920*scale)/2+fraction,top=(height-1080*scale)/2+fraction;
      for(const [start,end] of [[left,left+1920*scale],[top,top+1080*scale]]){
        assert.ok((start-bleed*scale)*dpi<=Math.floor(start*dpi)+1e-7);
        assert.ok((end+bleed*scale)*dpi>=Math.ceil(end*dpi)-1e-7);
      }
    }
  }
  assert.match(cssSource,/\.loading\.full \.loading-back \{ inset: calc\(0px - var\(--cover-bleed, 2px\)\); \}/);
  assert.match(cssSource,/html, body \{[^}]*background: #000/);
});
