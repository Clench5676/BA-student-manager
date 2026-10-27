// Test-only binary reader. The shipped Python engine does not require Node.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {poseSetup} from '../../../src/ba_modding_toolkit/web/js/refine-composite.js';
const context=vm.createContext({console,TextDecoder,TextEncoder,Float32Array,Uint8Array,Uint16Array,Int16Array,Int32Array,ArrayBuffer,DataView});
vm.runInContext(readFileSync(new URL('../../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js',import.meta.url),'utf8'),context);
const [base,replacements='{}']=process.argv.slice(2);
process.stdout.write(JSON.stringify(poseSetup(context.spine,readFileSync(base+'.atlas','utf8'),new Uint8Array(readFileSync(base+'.skel')),JSON.parse(replacements))));
