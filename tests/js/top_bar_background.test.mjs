import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const blobs=new Map();
globalThis.document={createElement:()=>({getContext(){return this.context ||= {draws:[],drawImage(...args){this.draws.push(args);},measureText:()=>({width:0})};},
  toBlob(fn){fn(this);}})};
URL.createObjectURL=canvas=>{const url=`blob:${blobs.size}`;blobs.set(url,canvas);return url;};
globalThis.Image=class {set src(url){this.naturalWidth=343;this.naturalHeight=105;queueMicrotask(()=>this.onload?.());}decode(){return Promise.resolve();}};
globalThis.requestAnimationFrame=fn=>queueMicrotask(fn);
const {barImage,barDensity,BAR_CUTS,BAR_BORDER_SCALES,paintTopBar,createTopBarPainter}=await import('../../src/ba_modding_toolkit/web/js/top-bar-background.js');
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

const deferred=()=>{let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function paintFixture(){
  const frames=[],draws=[],decodes=[],writes=[];
  const bar={style:{get backgroundImage(){return writes.at(-1)||'url("old")';},set backgroundImage(value){writes.push(value);}},
    getBoundingClientRect:()=>({width:bar.width,height:44}),width:960};
  const paint=createTopBarPainter({frame:fn=>frames.push(fn),raster:(...args)=>{
    const pending=deferred();draws.push({args,...pending});return pending.promise;},decode:url=>{
    const pending=deferred();decodes.push({url,...pending});return pending.promise;}});
  return {bar,paint,frames,draws,decodes,writes};
}

test('resize bursts draw once per animation frame using the latest geometry',async()=>{
  const f=paintFixture(),waiting=[];
  for(let i=0;i<20;i++){f.bar.width=960+i;waiting.push(f.paint(f.bar,.5));}
  assert.equal(f.frames.length,1);assert.equal(f.draws.length,0);
  f.frames.shift()();await settle();
  assert.equal(f.draws.length,1);assert.equal(f.draws[0].args[0],979/.5);
  assert.equal(f.bar.style.backgroundImage,'url("old")');
  f.draws[0].resolve('next');await settle();
  assert.equal(f.decodes[0].url,'next');assert.equal(f.writes.length,0,'encoding alone cannot publish an undecoded raster');
  f.decodes[0].resolve({});await Promise.all(waiting);
  assert.deepEqual(f.writes,['url("next")']);
});

test('slow rasters keep the previous bar visible and stale completions cannot replace it',async()=>{
  const f=paintFixture(),first=f.paint(f.bar,.5);
  f.frames.shift()();await settle();
  const latest=[];
  for(let i=0;i<10;i++){f.bar.width=1100+i;latest.push(f.paint(f.bar,.75));}
  assert.equal(f.frames.length,0,'no parallel draw while encoding');
  f.draws[0].resolve('stale');await settle();
  f.decodes[0].resolve({});await settle();
  assert.equal(f.bar.style.backgroundImage,'url("old")');assert.equal(f.frames.length,1);
  f.frames.shift()();await settle();
  assert.equal(f.draws.length,2);assert.equal(f.draws[1].args[0],1109/.75);
  f.draws[1].resolve('latest');await settle();
  assert.equal(f.writes.length,0);f.decodes[1].resolve({});await Promise.all([first,...latest]);
  assert.deepEqual(f.writes,['url("latest")']);
});

test('a request during decoding invalidates that raster and waits for the next frame',async()=>{
  const f=paintFixture(),first=f.paint(f.bar,.5);
  f.frames.shift()();await settle();f.draws[0].resolve('first');await settle();
  const next=f.paint(f.bar,1);
  f.decodes[0].resolve({});await settle();
  assert.equal(f.writes.length,0);assert.equal(f.frames.length,1);
  f.frames.shift()();await settle();f.draws[1].resolve('second');await settle();
  f.decodes[1].resolve({});await Promise.all([first,next]);
  assert.deepEqual(f.writes,['url("second")']);
});

for(const failure of ['raster','decode'])test(`${failure} failure retains the last drawn bar and a later frame recovers`,async()=>{
  const f=paintFixture(),pending=f.paint(f.bar,.5),failed=assert.rejects(pending,/failed/);
  f.frames.shift()();await settle();
  if(failure==='raster')f.draws[0].reject(Error('failed'));
  else {f.draws[0].resolve('broken');await settle();f.decodes[0].reject(Error('failed'));}
  await failed;assert.equal(f.bar.style.backgroundImage,'url("old")');assert.deepEqual(f.writes,[]);
  const retry=f.paint(f.bar,.5);f.frames.shift()();await settle();f.draws[1].resolve('recovered');await settle();
  f.decodes.at(-1).resolve({});await retry;assert.deepEqual(f.writes,['url("recovered")']);
});

test('hidden bars keep their image; restored bars and separate elements retain independent queues',async()=>{
  const f=paintFixture();f.bar.width=0;
  const hidden=f.paint(f.bar,.5);f.frames.shift()();await hidden;
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.draws,[]);
  f.bar.width=960;
  const other={...f.bar,style:{backgroundImage:'url("other-old")'}},a=f.paint(f.bar,.5),b=f.paint(other,.5);
  assert.equal(f.frames.length,2);f.frames.splice(0).forEach(fn=>fn());await settle();
  f.draws[0].resolve('one');f.draws[1].resolve('two');await settle();
  f.decodes.forEach(d=>d.resolve({}));await Promise.all([a,b]);
  assert.equal(f.bar.style.backgroundImage,'url("one")');assert.equal(other.style.backgroundImage,'url("two")');
});
