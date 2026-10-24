import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
let rendered, nodes;
const tree = {name:"Scroll Bar",children:["Background","Foreground"].map((name)=>({name,pos:[1391,0],widgets:[{texture:"CharacterCollection_ScrollBarBg",w_:126,h_:990}]}))};
globalThis.scrollFixture = {clone:structuredClone,NGUI:{find:()=>tree,render:async(t)=>{rendered=t;return{nodes:nodes=new Map(t.children.map((c)=>[`${t.name}/${c.name}`,{els:[{style:{backgroundImage:'url("native-texture")'}}]}]))};}}};
globalThis.document={createElement:()=>({style:{}})};
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/scrollbar.js",import.meta.url),"utf8");source=source.replace(/^import .*;$/gm,"");
const {scrollbar,scrollbarTrack}=await import(`data:text/javascript;base64,${Buffer.from('const {clone,NGUI}=globalThis.scrollFixture;\n'+source).toString('base64')}`);
test("native scrollbar end caps retain their aspect on both axes and very long lists",async()=>{
  for(const horizontal of [false,true]){
    const host={appendChild(bar){this.bar=bar;}},box=horizontal?[0,0,600,63]:[0,0,63,600];
    const bar=await scrollbar(host,box,{collection:{},horizontal});
    assert.equal(rendered.children[0].widgets[0].h_,12);assert.equal(rendered.children[0].widgets[0].w_,63);
    bar.sync(100,100000,99900);assert.equal(bar.hidden,false);
    const thumb=nodes.get("Scroll Bar/Foreground").els[0];
    assert.equal(thumb.style.borderImageSlice,"8 0 8 0 fill");assert.equal(thumb.style.height,"8px");assert.equal(thumb.style.top,"592px");assert.equal(thumb.style.backgroundImage,"none");
    bar.sync(100,100,0);assert.equal(bar.hidden,true);
    assert.equal(bar.style.transform,horizontal?'rotate(-90deg)':undefined);
  }
});

test("scrollbar painted edges align with the supplied content edge on both axes",()=>{
  const scale=1920/2960, box=[300,300,1320,555];
  const vertical=scrollbarTrack(box,scale);assert.equal(vertical[0]+49*scale,1620);
  const horizontal=scrollbarTrack(box,scale,true);assert.equal(horizontal[1]+126*scale-29*scale,855);
});
