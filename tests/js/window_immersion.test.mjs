import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isImmersive, dragRegions, headerGeometry } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
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
for(const platform of ['darwin','win32','fallback'])test(`immersion reports no drag rectangles for ${platform}`,()=>{
  for(const [width,height] of [[960,540],[1600,900],[2560,1080],[960,1200]])for(const dpi of [1,1.25,1.5,2,3]){
    const bounds=platform==='darwin'?{left:12,top:8,right:80,bottom:30}:{left:width-148,top:0,right:width,bottom:32};
    const g=headerGeometry(width,height,platform==='darwin'?0:32,true);
    assert.equal(g.extra,0);assert.equal(g.contentScale,g.scale,'scene controls retain their full-stage coordinates');
    for(const nativeBounds of [bounds,null])for(const blocked of [true,false]){
      assert.deepEqual(dragRegions({width,height:g.rowHeight,bounds:nativeBounds,platform,immersive:true,blocked}),[]);
    }
  }
});
