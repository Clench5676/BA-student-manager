import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {poseSetup} from '../../src/ba_modding_toolkit/web/js/refine-composite.js';
const c=vm.createContext({console,TextDecoder,TextEncoder,Float32Array,Uint8Array,Uint16Array,Int16Array,Int32Array,ArrayBuffer,DataView});
vm.runInContext(readFileSync(new URL('../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js',import.meta.url),'utf8'),c);
const S=c.spine;
const atlas=rotation=>`page.png\nsize: 32,32\npma: true\nbody\n bounds: 10,10,6,4\n rotate: ${rotation}\n offsets: 1,2,9,12\n index: 2\n`;
function fixture(type='region') {
 const mesh={type:'mesh',path:'body',uvs:[0,0,1,0,1,1,0,1],triangles:[0,1,2,2,3,0],vertices:[-3,-2,3,-2,3,2,-3,2],hull:4};
 if(type==='weighted')mesh.vertices=[1,1,-3,-2,1, 1,1,3,-2,1, 1,1,3,2,1, 1,1,-3,2,1];
 return {skeleton:{spine:'4.2.33'},bones:[{name:'root',x:10,y:20},{name:'child',parent:'root',x:5}],
 slots:[{name:'back',bone:'root',attachment:'body',color:'ff8080ff'}, {name:'front',bone:'root',attachment:'body',blend:'additive'}],
 skins:[{name:'default',attachments:{back:{body:type==='region'?{path:'body',width:9,height:12}:mesh, alternate:{path:'body',x:3,width:9,height:12}},front:{body:{path:'body',width:9,height:12}}}}]};
}
for(const rotation of [0,90,180,270])for(const type of ['region','mesh','weighted'])test(`setup ${type}, rotation ${rotation}: runtime vertices, UVs and draw order`,()=>{
 const g=poseSetup(S,atlas(rotation),fixture(type));
 assert.deepEqual(g.attachments.map(a=>a.slot),['back','front']);
 assert.equal(g.attachments[1].blend,1);assert.equal(g.pages[0].pma,true);
 assert.equal(g.attachments[0].region.index,2);
 const a=g.attachments[0];assert.equal(a.vertices.length,8);assert.equal(a.uvs.length,8);
 assert.equal(a.triangles.length,6);assert(a.uvs.every(x=>x>=0&&x<=1));
 if(type==='weighted')assert.deepEqual(a.vertices,[12,18,18,18,18,22,12,22]);
 if(type==='mesh')assert.deepEqual(a.vertices,[7,18,13,18,13,22,7,22]);
 assert.equal(a.slotColor[0],1);assert.equal(a.slotColor[1],128/255);
 const b=poseSetup(S,atlas(rotation),fixture(type),{back:'alternate'});
 assert.equal(b.attachments[0].attachment,'alternate');
 assert(b.choices.some(c=>c.slot==='back'&&c.attachment==='alternate'));
 assert.throws(()=>poseSetup(S,atlas(rotation),fixture(type),{missing:'body'}),/Unknown slot/);
 assert.throws(()=>poseSetup(S,atlas(rotation),fixture(type),{back:'missing'}));
});
test('runtime clipping, hidden slots and explicit null replacement',()=>{
 const f=fixture();f.slots.unshift({name:'clip',bone:'root',attachment:'clip'});
 f.skins[0].attachments.clip={clip:{type:'clipping',end:'back',vertexCount:4,vertices:[0,-1,2,-1,2,1,0,1]}};
 const g=poseSetup(S,atlas(0),f);const a=g.attachments[0];
 assert(a.vertices.length>0);for(let i=0;i<a.vertices.length;i+=2){assert(a.vertices[i]>=10-1e-5);assert(a.vertices[i]<=12+1e-5);}
 assert.equal(g.attachments[1].slot,'front');
 assert.deepEqual(poseSetup(S,atlas(0),fixture(),{back:null}).attachments.map(a=>a.slot),['front']);
});

import {poseTracks, listPoses} from '../../src/ba_modding_toolkit/web/js/refine-composite.js';
function animated() {
 const f=fixture('mesh');
 f.animations={Idle_01:{bones:{root:{translate:[{x:0,y:0},{time:2,x:8,y:4}]}}},
  '00':{attachments:{default:{back:{body:{deform:[{vertices:[1,2,1,2,1,2,1,2]}]}}}}},
  '01':{slots:{back:{attachment:[{name:'alternate'}]}}},
  '99':{slots:{back:{attachment:[{name:null}]}}},
  Eye_Close_01:{slots:{back:{attachment:[{name:'body'},{time:.1,name:null}]}}}};
 return f;
}
test('AnimationState under Node: independent tracks, mesh deformation and blink',()=>{
 const f=animated();
 const base=poseTracks(S,atlas(0),f);
 assert.deepEqual(base.attachments[0].vertices,[8,20,14,20,14,24,8,24]);
 const moved=poseTracks(S,atlas(0),f,[{track:0,animation:'Idle_01',time:1},{track:1,animation:'00'}]);
 assert.deepEqual(moved.attachments[0].vertices,[12,22,18,22,18,26,12,26]);
 assert.equal(poseTracks(S,atlas(0),f,[{track:1,animation:'01'}]).attachments[0].attachment,'alternate');
 assert.deepEqual(poseTracks(S,atlas(0),f,[{track:1,animation:'00'},{track:2,animation:'Eye_Close_01',time:.11,loop:false}]).attachments.map(a=>a.slot),['front']);
 const poses=listPoses(S,atlas(0),f,{idleFrames:4,blinkFrames:3});
 assert.deepEqual(poses.map(p=>p.name),['base','01','99','blink-0','blink-1','blink-2','idle-0','idle-1','idle-2','idle-3']);
 for(const p of poses) assert(poseTracks(S,atlas(0),f,p.tracks).attachments.length);
 assert.equal(poses.at(-1).tracks[0].time,1.5);
 assert.throws(()=>poseTracks(S,atlas(0),f,[{track:0,animation:'missing'}]),/Unknown animation/);
 assert.throws(()=>poseTracks(S,atlas(0),f,[{track:0,animation:'00',time:-1}]),/time/);
 assert.throws(()=>listPoses(S,atlas(0),f,{idleFrames:-1}),/counts/);
});
test('idle fallback and skeletons without expression animations',()=>{
 const f=fixture();f.animations={idle_other:{}};
 assert.equal(listPoses(S,atlas(0),f)[0].tracks[0].animation,'idle_other');
 assert.equal(poseTracks(S,atlas(0),f).attachments.length,2);
 assert.equal(listPoses(S,atlas(0),fixture()).length,1);
});
