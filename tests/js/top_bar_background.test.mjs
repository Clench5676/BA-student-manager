import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const blobs=new Map();
globalThis.document={createElement:()=>({getContext(){return this.context ||= {draws:[],drawImage(...args){this.draws.push(args);},measureText:()=>({width:0})};},
  toBlob(fn){fn(this);}})};
URL.createObjectURL=canvas=>{const url=`blob:${blobs.size}`;blobs.set(url,canvas);return url;};
globalThis.Image=class {set src(url){this.naturalWidth=343;this.naturalHeight=105;queueMicrotask(()=>this.onload());}};
const {barImage,barDensity,BAR_CUTS,BAR_BORDER_SCALES,paintTopBar}=await import('../../src/ba_modding_toolkit/web/js/top-bar-background.js');
for(const scale of [.5,.625,.75,5/6,1,1.25,1.5,1.75,2])for(const dpi of [1,1.25,1.5,2,3])test(`top bar is one contiguous raster at scale ${scale}, DPI ${dpi}`,async()=>{
  // Verified development view: UICharacterCollection/BG_W/Bg is 2996 x 166;
  // its Common_Top_Menu_Bg atlas crop is 343 x 105, cuts 310 left / 20 right.
  assert.deepEqual(BAR_CUTS,[0,20,0,310]);
  assert.equal(BAR_BORDER_SCALES[3]*310,172);assert.equal(BAR_BORDER_SCALES[1]*20,11);
  for(const [width,height] of [[1920,64],[2560,88]]){
    const url=await barImage(width,height,scale,dpi),raster=blobs.get(url),density=barDensity(dpi,scale);
    assert.ok(density>=2&&density>=dpi*scale);
    assert.equal(raster.width,Math.round(width*density));assert.equal(raster.height,Math.round(height*density));
    assert.equal(raster.context.imageSmoothingQuality,'high');
    const draws=raster.context.draws;
    assert.equal(draws.length,3);
    assert.deepEqual(draws.map(d=>d[3]),[310,13,20]);
    assert.deepEqual(draws.map(d=>d[5]),[0,Math.round(172*density),raster.width-Math.round(11*density)]);
    for(let i=0;i<2;i++)assert.equal(draws[i][5]+draws[i][7],draws[i+1][5]);
    assert.equal(draws[2][5]+draws[2][7],raster.width);
    for(const d of draws){
      assert.ok(d.slice(5).every(Number.isInteger));
      assert.equal(d[6],0);assert.equal(d[8],raster.height);
      assert.equal(d[0].context.imageSmoothingEnabled,false,'each source tile is clamped before resampling');
    }
  }
});
test('painting changes only the background; toolbar caps, shadow and layout remain intact',async()=>{
  const bar={style:{},getBoundingClientRect:()=>({width:960,height:44})};
  await paintTopBar(bar,.5);
  assert.match(bar.style.backgroundImage,/^url\("blob:/);
  assert.deepEqual(Object.keys(bar.style),['backgroundImage']);
  const css=readFileSync(new URL('../../src/ba_modding_toolkit/web/css/app.css',import.meta.url),'utf8');
  const rule=css.slice(css.indexOf('.topbar {'),css.indexOf('.back {'));
  assert.doesNotMatch(rule,/border-image/);assert.match(rule,/border-width: 0 11px 0 172px/);
  assert.match(rule,/background-origin: border-box/);assert.match(rule,/drop-shadow\(0 2px 3px rgba\(30, 60, 100, \.18\)\)/);
});
test('remaining switch and scrollbar paint paths do not create CSS border-image slices',()=>{
  for(const name of ['mod-switch-skin.js','scrollbar.js']){
    const js=readFileSync(new URL(`../../src/ba_modding_toolkit/web/js/${name}`,import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(js,/borderImage|border-image/);
  }
});
