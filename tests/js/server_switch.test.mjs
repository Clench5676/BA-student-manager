import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../../src/ba_modding_toolkit/web/js/main.js',import.meta.url),'utf8');
const refresh=source.slice(source.indexOf('async function refreshConfiguration()'),source.indexOf('\nlet routeToken'));
test('old cross-server refreshes cannot commit after a newer refresh and recovery needs no restart',async()=>{
  const pending=[],routes=[],nav=[];
  const ctx={invalidateRoster(){}},env={ctx,
    previewCache:{configure(){}},
    rpc:method=>new Promise(resolve=>pending.push({method,resolve})),
    renderNav:async(_,options)=>nav.push(options),route:async()=>routes.push(ctx.info.resourceVersion),
    StudentHall:{hide(){}},Detail:{hide(){}},Roster:{hide(){}},BatchImport:{invalidate(){}},
    NGUI:{init:async()=>{}},noGame:()=>routes.push('missing')};
  const api=new Function('env',`const {${Object.keys(env)}}=env;let info,stepCards,configurationRevision=0,resourceEpoch=0,routeToken=0,routeAttempt=0;const endRoute=()=>{};${refresh};return refreshConfiguration;`)(env);
  const old=api(),latest=api();
  pending[2].resolve({gameFound:true,resourceVersion:'japan'});pending[3].resolve({fileSource:'windows_japan'});await latest;
  pending[0].resolve({gameFound:true,resourceVersion:'global'});pending[1].resolve({fileSource:'windows_global'});await old;
  assert.deepEqual(routes,['japan']);assert.equal(ctx.info.resourceVersion,'japan');assert.equal(nav.length,1);
  const missing=api();pending[4].resolve({gameFound:false});pending[5].resolve({fileSource:'windows_japan'});await missing;
  assert.equal(routes.at(-1),'missing');
  const recovery=api();pending[6].resolve({gameFound:true,resourceVersion:'recovered'});pending[7].resolve({fileSource:'windows_japan'});await recovery;
  assert.equal(routes.at(-1),'recovered');assert.ok(!refresh.includes('location.reload'));
});
test('old roster responses cannot replace a new server snapshot',async()=>{
  const code=source.slice(source.indexOf('async function roster()'),source.indexOf('// the portraits whose'));
  let resolve;const api=new Function('rpc',`let resourceEpoch=0,rosterData=null,rosterStale=true;const forgetReplaced=()=>{};${code};return {roster,change(){resourceEpoch++},data:()=>rosterData};`)(()=>new Promise(r=>resolve=r));
  const old=api.roster();api.change();resolve({families:['global']});await assert.rejects(old,{name:'AbortError'});assert.equal(api.data(),null);
});
