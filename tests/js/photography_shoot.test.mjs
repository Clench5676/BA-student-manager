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
  assert.equal(result.saved,'one');assert.deepEqual(h.calls.map(([name])=>name),['pause','draw','frame','capture','pause','save']);
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
