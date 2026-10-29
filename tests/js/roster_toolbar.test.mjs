import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
const text={"roster.title":"Student List","roster.merge":"Group Alts","seg.all":"All","seg.mods":"Modded","seg.noMods":"No Mod","seg.recruit":"Playable","seg.noRecruit":"NPC","sort.recent":"Recently Viewed","sort.added":"Recently Added","sort.name":"Name","sort.mods":"Mod Count","sort.default":"Default"};
const measure=(value,size)=>value.length*size*.45;
const fit=(value,size,min,width)=>({text:value,fs:Math.max(min,Math.min(size,width/(value.length*.45))),lines:1});
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/roster-widgets.js",import.meta.url),"utf8");source=source.replace(/^import .*;$/gm,"");
globalThis.toolbarFixture={NGUI:{fitText:fit,fitGroup:(values,size,min,width)=>{const fits=values.map(value=>fit(value,size,min,width)),fs=Math.min(...fits.map(f=>f.fs));return fits.map(f=>({...f,fs}));}},T:key=>text[key]||key,advanceOf:measure,glyphsOf:measure,SORTS:["recent","added","name","mods","default"]};
const {toolbarLayout}=await import(`data:text/javascript;base64,${Buffer.from('const {NGUI,T,advanceOf,glyphsOf,SORTS}=globalThis.toolbarFixture;\n'+source).toString('base64')}`);
test("shared roster toolbar fits every control in one row and keeps anchors fixed when sort changes",()=>{
  let anchors;
  for(const sort of globalThis.toolbarFixture.SORTS){
    const lay=toolbarLayout({sort});
    const boxes=[[lay.cbLeft,lay.cbW],[lay.seg1-3*lay.segW,3*lay.segW],[lay.seg2-3*lay.segW,3*lay.segW],[lay.search-75,150],[lay.sort-lay.sortW/2,lay.sortW],[lay.order-243/2,243]];
    assert.ok(boxes[0][0]>=-1270+measure(text["roster.title"],lay.titleFs)+40);
    for(let i=1;i<boxes.length;i++)assert.ok(boxes[i][0]>=boxes[i-1][0]+boxes[i-1][1]+15.99);
    assert.equal(boxes.at(-1)[0]+boxes.at(-1)[1],1412);
    if(anchors)assert.deepEqual(boxes,anchors);anchors=boxes;
    assert.equal(lay.sortText.text,text[`sort.${sort}`]);
  }
});
