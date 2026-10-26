import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {photograph} from '../../src/ba_modding_toolkit/web/js/photography/shoot.js';
const source=readFileSync(new URL('../../src/ba_modding_toolkit/web/js/detail.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  async redraw(){'),source.indexOf('  pan(dx,dy)'));
function setup(tab='portrait',mainPlayer=null,Lobby={prepareFrame:async()=>false}){
  return new Function('env',`let {tab,mainPlayer,Lobby}=env;return {${code} setPlayer(value){mainPlayer=value;}};`)({tab,mainPlayer,Lobby});
}
test('the real portrait bridge distinguishes renderer handoff from permanent errors',async()=>{
  const bridge=setup();await assert.rejects(()=>bridge.redraw(),{code:'capture_not_ready'});
  const player={skeleton:{},disposed:true,drawFrame(){assert.fail('Disposed renderer drawn');}};
  bridge.setPlayer(player);await assert.rejects(()=>bridge.redraw(),{code:'capture_not_ready'});
  player.error='Permanent failure';await assert.rejects(()=>bridge.redraw(),/Portrait renderer failed/);
});
test('a renderer replaced during recovery is frozen and captured once through the real bridge',async()=>{
  const player={skeleton:{},disposed:true,paused:false,drawFrame(update){assert.equal(update,false);assert.equal(this.paused,true);}};
  const bridge=setup('portrait',player);let waits=0,saves=0;
  Object.assign(bridge,{pause:on=>player.paused=on,expression:()=> '02',action:()=>'',info:()=>({source:'same source'})});
  await photograph({bridge,mode:'portrait',paused:false,wait:async()=>{if(++waits===3)player.disposed=false;},capture:async()=>({png:'valid'}),
    save:async payload=>{saves++;assert.equal(payload.expression,'02');assert.equal(payload.source,'same source');return {saved:'one'};}});
  assert.equal(waits,3);assert.equal(saves,1);assert.equal(player.paused,false);
});
test('the real Memorial bridge retries unavailable composites and preserves permanent failures',async()=>{
  const Lobby={prepareFrame:async()=>false},bridge=setup('lobby',null,Lobby);
  await assert.rejects(()=>bridge.redraw(),{code:'capture_not_ready'});
  Lobby.prepareFrame=async()=>true;await bridge.redraw();
  Lobby.prepareFrame=async()=>{throw new Error('Permanent material failure');};await assert.rejects(()=>bridge.redraw(),/Permanent material failure/);
});
