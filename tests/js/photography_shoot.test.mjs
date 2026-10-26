import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const code=await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/shoot.js',import.meta.url),'utf8');
const {photograph}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function setup({paused=false,failCapture=false,failSave=false}={}){
  const calls=[];
  return {calls,options:{mode:'portrait',paused,
    bridge:{pause:on=>calls.push(['pause',on]),redraw:async()=>calls.push(['draw']),expression:()=> '02',action:()=>'',info:()=>({source:'/real/source'})},
    wait:async()=>calls.push(['frame']),capture:async()=>{calls.push(['capture']);if(failCapture)throw new Error('Renderer unavailable');return {png:'native PNG',width:720,height:720};},
    save:async payload=>{calls.push(['save',payload]);if(failSave)throw new Error('Disk full');return {saved:'one'};}}};
}
test('one shutter press saves directly and resumes playback before waiting for storage',async()=>{
  const h=setup(),result=await photograph(h.options);
  assert.equal(result.saved,'one');assert.deepEqual(h.calls.map(([name])=>name),['pause','frame','draw','capture','pause','save']);
  assert.equal(h.calls[4][1],false);
  assert.deepEqual(h.calls[5][1],{png:'native PNG',mode:'portrait',expression:'02',action:'',source:'/real/source'});
});
test('shooting while paused preserves the paused state',async()=>{
  const h=setup({paused:true});await photograph(h.options);assert.equal(h.calls[4][1],true);
});
test('a failed capture resumes playback and does not publish a saved photo',async()=>{
  const h=setup({failCapture:true});await assert.rejects(()=>photograph(h.options),/Renderer unavailable/);
  assert.equal(h.calls.at(-1)[0],'pause');assert.equal(h.calls.at(-1)[1],false);assert.ok(!h.calls.some(([name])=>name==='save'));
});
test('storage failure does not leave the scene frozen',async()=>{
  const h=setup({failSave:true});await assert.rejects(()=>photograph(h.options),/Disk full/);
  assert.equal(h.calls.at(-2)[0],'pause');assert.equal(h.calls.at(-2)[1],false);
});
test('shutter feedback follows the real capture and album feedback waits for a successful save',async()=>{
  const h=setup();let publish;
  h.options.onCaptured=shot=>h.calls.push(['shutter',shot.png]);
  h.options.onSaved=(_,shot)=>h.calls.push(['album',shot.png]);
  h.options.save=()=>new Promise(resolve=>publish=resolve);
  const done=photograph(h.options);
  while(!publish)await Promise.resolve();
  assert.ok(h.calls.some(([name,png])=>name==='shutter'&&png==='native PNG'));
  assert.ok(!h.calls.some(([name])=>name==='album'));
  publish({saved:'one'});await done;assert.deepEqual(h.calls.at(-1),['album','native PNG']);
});
test('failed storage never emits an album-saved animation',async()=>{
  const h=setup({failSave:true});h.options.onSaved=()=>h.calls.push(['album']);
  await assert.rejects(()=>photograph(h.options),/Disk full/);
  assert.ok(!h.calls.some(([name])=>name==='album'));
});

for(const phase of ['redraw','capture'])test(`transient ${phase} recovers the same frozen pose and saves once`,async()=>{
  const h=setup();let attempts=0,saves=0;
  const fn=phase==='redraw'?h.options.bridge.redraw:h.options.capture;
  const retry=async()=>{if(++attempts<4)throw Object.assign(new Error('Pending'),{code:'capture_not_ready'});return fn();};
  if(phase==='redraw')h.options.bridge.redraw=retry;else h.options.capture=retry;
  h.options.save=async()=>{saves++;return {saved:'one'};};
  await photograph(h.options);assert.equal(attempts,4);assert.equal(saves,1);
  assert.equal(h.calls.filter(([name])=>name==='pause').length,2);
});
test('exhausted readiness is a distinct failure and never publishes success',async()=>{
  const h=setup();h.options.capture=async()=>{throw Object.assign(new Error('Pending'),{code:'capture_not_ready'});};
  await assert.rejects(()=>photograph(h.options),{code:'photo_capture_unavailable'});
  assert.ok(!h.calls.some(([name])=>name==='save'));
});
for(const phase of ['redraw','capture','save'])test(`cancel during ${phase} cannot publish stale feedback or start a stale save`,async()=>{
  const h=setup();let alive=true,saves=0,feedback=0;
  h.options.alive=()=>alive;h.options.onSaved=()=>feedback++;
  if(phase==='redraw')h.options.bridge.redraw=async()=>{alive=false;};
  if(phase==='capture')h.options.capture=async()=>{alive=false;return {png:'valid'};};
  h.options.save=async()=>{saves++;alive=false;return {saved:'one'};};
  await assert.rejects(()=>photograph(h.options),{name:'AbortError'});
  assert.equal(saves,phase==='save'?1:0);assert.equal(feedback,0);
});

test('every successful retry draws immediately before readback, after layout settles',async()=>{
  const h=setup();h.options.wait=async()=>h.calls.push(['layout']);
  h.options.bridge.redraw=async()=>h.calls.push(['fresh']);
  h.options.capture=async()=>{assert.equal(h.calls.at(-1)[0],'fresh');return {png:'valid'};};
  await photograph(h.options);
});
for(const code of ['photo_invalid','internal','write_failed'])test(`permanent ${code} failure is not retried or reported as saved`,async()=>{
  const h=setup();let attempts=0,saved=0;
  h.options.capture=async()=>{attempts++;throw Object.assign(new Error('Permanent'),{code});};h.options.onSaved=()=>saved++;
  await assert.rejects(()=>photograph(h.options),{code});assert.equal(attempts,1);assert.equal(saved,0);
});
