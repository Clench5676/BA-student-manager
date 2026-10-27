// Test-only binary reader. The shipped Python engine does not require Node.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {poseSetup,poseTracks,listPoses} from '../../../src/ba_modding_toolkit/web/js/refine-composite.js';
const context=vm.createContext({console,TextDecoder,TextEncoder,Float32Array,Uint8Array,Uint16Array,Int16Array,Int32Array,ArrayBuffer,DataView});
vm.runInContext(readFileSync(new URL('../../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js',import.meta.url),'utf8'),context);
const [base,replacements='{}']=process.argv.slice(2);
const atlas=readFileSync(base+'.atlas','utf8'), skel=new Uint8Array(readFileSync(base+'.skel'));
if(replacements==='--poses') {
 const poses=listPoses(context.spine,atlas,skel);
 process.stdout.write(JSON.stringify(poses.map(p=>({...p,geometry:poseTracks(context.spine,atlas,skel,p.tracks)}))));
} else process.stdout.write(JSON.stringify(poseSetup(context.spine,atlas,skel,JSON.parse(replacements))));
