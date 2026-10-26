import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const source=await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/feedback.js',import.meta.url),'utf8');
const {stageRect,flightTransform}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('album flight uses logical stage coordinates at any window scale',()=>{
  for(const scale of [.5,1,1.5]){
    const stage={left:12,top:40,width:1920*scale};
    const album={left:12+60*scale,top:40+970*scale,width:60*scale,height:40*scale};
    const rect=stageRect(album,stage);
    assert.deepEqual(rect,{x:60,y:970,width:60,height:40});
  }
});
test('the saved image lands centered in the album without changing its aspect ratio',()=>{
  const frame={x:780,y:360,size:360},album={x:60,y:970,width:60,height:40},end=flightTransform(frame,album);
  assert.equal(frame.x+frame.size/2+end.x,album.x+album.width/2);
  assert.equal(frame.y+frame.size/2+end.y,album.y+album.height/2);
  assert.equal(frame.size*end.scale,40);
});
