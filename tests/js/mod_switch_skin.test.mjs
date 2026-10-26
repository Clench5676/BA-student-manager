import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {segmentTree,segmentOrigin,SEGMENT_SCALE} from '../../src/ba_modding_toolkit/web/js/mod-switch-skin.js';
import {sliceAxis} from '../../src/ba_modding_toolkit/web/js/sprite-slices.js';
for(const dpi of [1,1.25,1.5,1.75,2,3])for(const scale of [.5,.75,1,1.25,1.5,2])test(`switch tiles share exact raster edges at DPI ${dpi}, scale ${scale}`,()=>{
  for(const pressed of [false,true])for(const flip of [false,true]){
    const widget=segmentTree(110,pressed,flip).widgets[0];
    assert.ok(Math.abs(widget.w_*SEGMENT_SCALE-(pressed?108.4:110))<1e-9);
    assert.equal(widget.h_*SEGMENT_SCALE,pressed?38:40);
    assert.deepEqual(segmentOrigin(110,pressed),[55,pressed?19:20]);
    assert.equal(widget.incline,10);assert.equal(widget.flip,flip?1:0);
    const axis=sliceAxis(pressed?324:328,pressed?13:15,pressed?1:5,widget.w_*SEGMENT_SCALE*scale,SEGMENT_SCALE*scale);
    assert.equal(axis.spans[0][3],axis.spans[1][2]);assert.equal(axis.spans[1][3],axis.spans[2][2]);
    assert.ok(axis.spans.flatMap(s=>s.slice(2)).every(Number.isInteger));
    const projected=axis.spans.map(s=>s.slice(2).map(edge=>edge/2*dpi));
    assert.equal(projected[0][1],projected[1][0]);assert.equal(projected[1][1],projected[2][0]);
  }
});
test('both states use NGUI single-image paint, with no separately composited CSS mask patches',async()=>{
  const css=await readFile(new URL('../../src/ba_modding_toolkit/web/css/app.css',import.meta.url),'utf8');
  const segment=css.slice(css.indexOf('.ms-seg {'),css.indexOf('/* busy:'));
  assert.ok(!segment.includes('mask-box-image'));assert.ok(!segment.includes('border-image'));assert.ok(!segment.includes('::before'));
  const source=await readFile(new URL('../../src/ba_modding_toolkit/web/js/mod-switch.js',import.meta.url),'utf8');
  assert.match(source,/NGUI.render\(segmentTree/);assert.match(source,/revision!==skinRevision/);
});
