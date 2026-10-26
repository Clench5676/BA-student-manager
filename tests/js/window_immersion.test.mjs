import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isImmersive, dragRegions, headerGeometry, expandRect } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
const source=(file)=>readFileSync(new URL(`../../src/ba_modding_toolkit/${file}`,import.meta.url),'utf8');
const scenes=[
  ['portrait fullscreen',['fullscreen'],[]],
  ['memorial lobby fullscreen',['fullscreen'],[]],
  ['portrait camera',['fullscreen'],['photo-active']],
  ['memorial lobby camera',['fullscreen'],['photo-active','photo-lobby']],
  ['Student Hall fullscreen',['hall-fullscreen'],[]],
];
for(const [name,stage,root] of scenes)test(`${name} hides the whole bar and restores on exit`,()=>{
  assert.ok(isImmersive(stage,root));
  assert.equal(isImmersive([],[]),false);
});
test('camera preparation is immersive even before the shared detail fullscreen flag arrives',()=>{
  assert.ok(isImmersive([],['photo-active']));
  assert.equal(isImmersive([],['photo-lobby']),false);
  assert.match(source('web/js/detail.js'),/stage\(\)\.classList\.toggle\("fullscreen", on\)/);
  assert.match(source('web/js/photography/controller.js'),/document\.documentElement\.classList\.add\('photo-active'\)/);
  assert.match(source('web/js/student-hall-fullscreen.js'),/stage\.classList\.add\("hall-fullscreen"\)/);
  assert.match(source('web/js/window-chrome.js'),/observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['class'\]/);
  const css=source('web/css/app.css');
  assert.match(css,/\.window-immersive \.topbar \{[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*filter: none/);
  assert.doesNotMatch(source('web/js/nav.js'),/back\.style\.visibility/);
});
const disjoint=(a,b)=>a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;
for(const platform of ['darwin','win32','fallback'])test(`immersion keeps only a 64 by 12 strip beside ${platform} controls`,()=>{
  for(const [width,height] of [[960,540],[1600,900],[2560,1080],[960,1200]])for(const dpi of [1,1.25,1.5,2,3]){
    const bounds=platform==='darwin'?{left:12,top:8,right:80,bottom:30}:{left:width-148,top:0,right:width,bottom:32};
    const g=headerGeometry(width,height,platform==='darwin'?0:32,true);
    assert.equal(g.extra,0);assert.equal(g.contentScale,g.scale,'scene controls retain their full-stage coordinates');
    const input={width,height:g.rowHeight,bounds,platform,immersive:true};
    const drag=dragRegions(input);assert.equal(drag.length,1);
    const strip=drag[0];assert.equal(strip.right-strip.left,64);assert.equal(strip.bottom-strip.top,12);assert.equal(strip.top,platform==='win32'?8:0);
    assert.ok(disjoint(strip,expandRect(bounds,8)));
    assert.equal(platform==='darwin'?strip.left-bounds.right:bounds.left-strip.right,8);
    // Camera Back is UICharacterCollection/Bg/Btn, 164 x 172 units, at (25,20)
    // in photography/controller.js. All other visible scene hits use this same
    // exclusion contract, including animated visual-mode Back and Hall's exit.
    const scale=g.scale,back=expandRect({left:25*scale,top:20*scale,right:(25+164*24/37)*scale,bottom:(20+172*24/37)*scale});
    const protectedRegions=dragRegions({...input,exclusions:[back]});
    for(const region of protectedRegions)assert.ok(disjoint(region,back));
    assert.deepEqual(dragRegions({...input,blocked:true}),[]);
    assert.deepEqual(dragRegions({...input,bounds:null}),[]);
    for(const region of drag)assert.ok(region.left*dpi>=0&&region.right*dpi<=width*dpi);
  }
});
test('scene controls and popups always win over immersive drag strips, including partial overlap',()=>{
  const input={width:960,height:44,bounds:{left:12,top:8,right:80,bottom:30},platform:'darwin',immersive:true};
  const hit={left:100,top:4,right:130,bottom:20};
  for(const region of dragRegions({...input,exclusions:[hit]}))assert.ok(disjoint(region,hit));
  assert.deepEqual(dragRegions({...input,exclusions:[{left:0,top:0,right:960,bottom:44}]}),[]);
  assert.match(source('webui/main.py'),/\.window-fallback-strip \.window-drag-region/);
});
