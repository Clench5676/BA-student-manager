import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const source=await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/camera.js',import.meta.url),'utf8');
const {FRAME,portraitCaptureView,lobbyCaptureView,portraitMinimum,lobbyMaximumWidth,choiceLayout}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('minimum portrait zoom can put the entire authored portrait height in the square',()=>{
  const k=portraitMinimum([-1200,-800,1200,3200],.324);
  assert.ok(k<.324);assert.equal(FRAME.size/k,4000);
});
test('maximum memorial view can put the complete painted height in the square',()=>{
  const width=lobbyMaximumWidth({x0:0,y0:0,x1:1920,y1:1080},1920);
  assert.equal(FRAME.size/1920*width,1080);
  const view=lobbyCaptureView({x:0,y:0,w:width,h:width*9/16},{x0:0,y0:0,x1:1920,y1:1080});
  assert.ok(Math.abs(view.y+(1-FRAME.y/1080)*view.h-1080)<1e-8);
});
test('the action popover fits its visible rows and scrolls only excess content',()=>{
  const short=choiceLayout('lobby',5),long=choiceLayout('lobby',20),face=choiceLayout('portrait',3);
  assert.equal(short.rows,2);assert.equal(short.height,146);assert.equal(short.y+short.height,920);
  assert.equal(long.rows,3);assert.ok(long.contentHeight>long.rows*long.rowHeight);
  assert.equal(face.rows,1);assert.equal(face.height,152);
});
test('portrait camera can pan at minimum zoom while keeping the framing square inside the full scene',()=>{
  const bounds=[-960,-540,960,540];
  assert.deepEqual(portraitCaptureView({cx:400,cy:200,k:1},bounds),{cx:400,cy:200,k:1});
  const edge=portraitCaptureView({cx:10000,cy:-10000,k:1},bounds);
  assert.ok(Math.abs(edge.cx-(960-FRAME.width/2))<1e-8);assert.equal(edge.cy,-360);assert.equal(edge.k,1);
});
test('memorial camera can pan at minimum zoom without constraining the entire display to the scene',()=>{
  const bounds={x0:0,y0:0,x1:1920,y1:1080};
  assert.deepEqual(lobbyCaptureView({x:-400,y:200,w:1920,h:1080},bounds),{x:-400,y:200,w:1920,h:1080});
  const edge=lobbyCaptureView({x:10000,y:-10000,w:1920,h:1080},bounds);
  assert.ok(Math.abs(edge.x-FRAME.x)<1e-8);assert.ok(Math.abs(edge.y+360)<1e-8);
});
test('portrait crop stays in the scene through both pan extremes at each supported zoom',()=>{
  const bounds=[-960,-540,960,540];
  for(const k of [1,1.5,2,4])for(const sign of [-1,1]){
    const v=portraitCaptureView({cx:sign*1e6,cy:sign*1e6,k},bounds);
    assert.ok(v.cx-FRAME.width/2/k>=bounds[0]-1e-8);assert.ok(v.cx+FRAME.width/2/k<=bounds[2]+1e-8);
    assert.ok(v.cy-180/k>=bounds[1]);assert.ok(v.cy+180/k<=bounds[3]);
    assert.equal(v.k,k);
  }
});
test('framing matches the real roster portrait aspect and stays centered',()=>{
  assert.ok(Math.abs(FRAME.width/FRAME.height-404/456)<1e-12);
  assert.equal(FRAME.x+FRAME.width/2,960);assert.equal(FRAME.y+FRAME.height/2,540);
});
test('memorial framing stays painted at every zoom and both pan extremes',()=>{
  const bounds={x0:-300,y0:200,x1:1620,y1:1280};
  for(const width of [1920,1280,960,480])for(const sign of [-1,1]){
    const v=lobbyCaptureView({x:sign*1e6,y:sign*1e6,w:width,h:width*9/16},bounds);
    assert.ok(v.x+FRAME.x/1920*v.w>=bounds.x0-1e-8);
    assert.ok(v.x+(FRAME.x+FRAME.width)/1920*v.w<=bounds.x1+1e-8);
    assert.ok(v.y+(1-(FRAME.y+FRAME.size)/1080)*v.h>=bounds.y0-1e-8);
    assert.ok(v.y+(1-FRAME.y/1080)*v.h<=bounds.y1+1e-8);
  }
});

test('compact occlusion control retains the right edge, centering, hit target and neighbours',async()=>{
  const {OCCLUSION_BUTTON:box,captionSize}=await import('../../src/ba_modding_toolkit/web/js/photography/camera.js');
  assert.deepEqual(box,[1352,25,196,76]);
  assert.equal(box[0]+box[2],1548);assert.equal(1570-box[0]-box[2],22);
  for(const scale of [.75,1,1.25,1.5,2]){
    assert.ok(box[2]*scale>=44);assert.ok(box[3]*scale>=44);
    assert.equal((box[1]+box[3]/2)*scale,63*scale);
  }
  for(const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH']){
    const data=JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url),'utf8'));
    const label=data.webui.photo.occlusion;
    assert.ok(label);
    // Conservative full-em glyphs also exercise fitting long translations.
    const measure=size=>[...label].length*size;
    const size=captionSize(measure,box[2]-36,38*1920/2960);
    assert.ok(measure(size)<=box[2]-36+1e-8);
  }
  const controller=await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/controller.js',import.meta.url),'utf8');
  assert.match(controller,/P\('occlusion'\),OCCLUSION_BUTTON/);
  assert.match(controller,/\[1570,25,196,76\]/);
});
