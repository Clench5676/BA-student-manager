import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {segmentTree,segmentOrigin,segmentDensity,SEGMENT_SCALE} from '../../src/ba_modding_toolkit/web/js/mod-switch-skin.js';
import {sliceAxis} from '../../src/ba_modding_toolkit/web/js/sprite-slices.js';
for(const dpi of [1,1.25,1.5,1.75,2,3])for(const scale of [.5,.75,1,1.25,1.5,2])test(`switch tiles share exact raster edges at DPI ${dpi}, scale ${scale}`,()=>{
  for(const pressed of [false,true])for(const flip of [false,true]){
    const widget=segmentTree(110,pressed,flip).widgets[0];
    assert.ok(Math.abs(widget.w_*SEGMENT_SCALE-(pressed?108.4:110))<1e-9);
    assert.equal(widget.h_*SEGMENT_SCALE,pressed?38:40);
    assert.deepEqual(segmentOrigin(110,pressed),[55,pressed?19:20]);
    assert.equal(widget.incline,10);assert.equal(widget.flip,flip?1:0);
    const density=segmentDensity(dpi,scale);
    assert.ok(density>=dpi*scale&&density>=2);
    const axis=sliceAxis(pressed?324:328,pressed?13:15,pressed?1:5,widget.w_*SEGMENT_SCALE,SEGMENT_SCALE,density);
    assert.equal(axis.spans[0][3],axis.spans[1][2]);assert.equal(axis.spans[1][3],axis.spans[2][2]);
    assert.ok(axis.spans.flatMap(s=>s.slice(2)).every(Number.isInteger));
    const projected=axis.spans.map(s=>s.slice(2).map(edge=>edge/density*scale*dpi));
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

test('the shared raster accepts effective DPI without reducing smoothing or logical geometry',async()=>{
  const renderer=await readFile(new URL('../../src/ba_modding_toolkit/web/js/ngui.js',import.meta.url),'utf8');
  assert.match(renderer,/sliceAxis\(sw, l, r, wpx, \[scales\[3\], scales\[1\]\], density\)/);
  assert.match(renderer,/sliceAxis\(sh, t, bo, hpx, \[scales\[0\], scales\[2\]\], density\)/);
  assert.match(renderer,/Number\(opts.rasterDensity\)/);
  assert.match(renderer,/g.imageSmoothingQuality = "high"/);
});

test('the real sliced-image raster keeps exact tile boundaries and display-density resolution',async()=>{
  const source=await readFile(new URL('../../src/ba_modding_toolkit/web/js/ngui.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('const baked = new Map();'),source.indexOf('// halve repeatedly')).replace('export function slicedImage', 'function slicedImage');
  const canvases=[];
  const document={createElement(){
    const canvas={getContext(){return this.context ||= {draws:[],drawImage(...args){this.draws.push(args);}};}};
    canvases.push(canvas);return canvas;
  }};
  const bake=new Function('document','sliceAxis','load','canvasUrl',`${code};return slicedImage;`)(
    document,sliceAxis,async()=>({naturalWidth:324,naturalHeight:99}),async canvas=>canvas);
  for(const dpi of [1,1.25,1.5,1.75,2,3])for(const scale of [.5,.75,1,1.25,1.5,2]){
    const density=segmentDensity(dpi,scale),canvas=await bake('pressed',[11,1,12,13],108.4,38,SEGMENT_SCALE,density);
    assert.equal(canvas.width,Math.round(108.4*density));assert.equal(canvas.height,Math.round(38*density));
    assert.equal(canvas.context.imageSmoothingQuality,'high');assert.equal(canvas.context.draws.length,9);
    const rectangles=canvas.context.draws.map(args=>args.slice(5));
    const xs=[...new Set(rectangles.map(([x])=>x))].sort((a,b)=>a-b);
    const widths=xs.map(x=>rectangles.find(rect=>rect[0]===x)[2]);
    assert.equal(xs[0]+widths[0],xs[1]);assert.equal(xs[1]+widths[1],xs[2]);assert.equal(xs[2]+widths[2],canvas.width);
  }
});
