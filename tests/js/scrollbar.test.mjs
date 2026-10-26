import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { sliceAxis } from '../../src/ba_modding_toolkit/web/js/sprite-slices.js';
let rendered, nodes, slices=[];
const tree = {name:"Scroll Bar",children:["Background","Foreground"].map((name)=>({name,pos:[1391,0],widgets:[{texture:"CharacterCollection_ScrollBarBg",w_:126,h_:990,color:name==='Background'?'#ccd7df/1.00':'#92a6b7/1.00'}]}))};
globalThis.scrollFixture = {clone:structuredClone,NGUI:{find:()=>tree,textureIndex:()=>({CharacterCollection_ScrollBarBg:'native-texture'}),
  tinted:async(url,color)=>`${url}:${color}`,slicedImage:async(...args)=>{slices.push(args);return `baked:${args[3]}`;},
  render:async(t)=>{rendered=t;return{nodes:nodes=new Map(t.children.map((c)=>[`${t.name}/${c.name}`,{els:[{style:{backgroundImage:'url("native-texture")'}}]}]))};}}};
globalThis.document={createElement:()=>({style:{}}),getElementById:()=>null};
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/scrollbar.js",import.meta.url),"utf8");source=source.replace(/^import .*;$/gm,"");
const {scrollbar,scrollbarTrack}=await import(`data:text/javascript;base64,${Buffer.from('const {clone,NGUI}=globalThis.scrollFixture;\n'+source).toString('base64')}`);
test("native scrollbar end caps retain their aspect on both axes and very long lists",async()=>{
  for(const horizontal of [false,true]){
    slices=[];
    const host={appendChild(bar){this.bar=bar;}},box=horizontal?[0,0,600,63]:[0,0,63,600];
    const bar=await scrollbar(host,box,{collection:{},horizontal});
    assert.equal(rendered.children[0].widgets[0].h_,12);assert.equal(rendered.children[0].widgets[0].w_,63);
    await bar.sync(100,100000,99900);assert.equal(bar.hidden,false);
    const thumb=nodes.get("Scroll Bar/Foreground").els[0];
    assert.equal(thumb.style.height,"8px");assert.equal(thumb.style.top,"592px");assert.equal(thumb.style.backgroundImage,'url("baked:8")');
    assert.equal(slices[0][0],'native-texture:#ccd7df');assert.equal(slices[1][0],'native-texture:#92a6b7');
    for(const args of slices){assert.deepEqual(args[1],[8,0,8,0]);assert.equal(args[2],63);assert.equal(args[4],.5);}
    await bar.sync(100,100,0);assert.equal(bar.hidden,true);
    assert.equal(bar.style.transform,horizontal?'rotate(-90deg)':undefined);
  }
});

test("scrollbar painted edges align with the supplied content edge on both axes",()=>{
  const scale=1920/2960, box=[300,300,1320,555];
  const vertical=scrollbarTrack(box,scale);assert.equal(vertical[0]+49*scale,1620);
  const horizontal=scrollbarTrack(box,scale,true);assert.equal(horizontal[1]+126*scale-29*scale,855);
});

test('scrollbar slices share integer raster edges at every supported stage scale and density',async()=>{
  for(const scale of [.5,.625,.75,1,1.25,1.5,1.75,2])for(const dpi of [1,1.25,1.5,2,3])for(const horizontal of [false,true]){
    globalThis.devicePixelRatio=dpi;globalThis.bamtHeaderGeometry={contentScale:scale};slices=[];
    const bar=await scrollbar({appendChild(){}},horizontal?[0,0,600,63]:[0,0,63,600],{collection:{},horizontal});
    await bar.sync(100,1000,300);
    for(const [url,b,width,height,bs,density] of slices){
      assert.ok(density>=dpi*scale&&density>=2);
      const axis=sliceAxis(24,8,8,height,bs,density);
      assert.equal(axis.spans[0][3],axis.spans[1][2]);assert.equal(axis.spans[1][3],axis.spans[2][2]);
      assert.ok(axis.spans.flatMap(s=>s.slice(2)).every(Number.isInteger));
      assert.equal(axis.spans[2][3],Math.round(height*density));
    }
  }
});
