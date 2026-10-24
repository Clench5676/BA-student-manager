import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
function pixels(width,height,[left,top,right,bottom],color=[255,255,255,255]){
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)data.set(color,(y*width+x)*4);
  return {width,height,data};
}
const bodyPixels=pixels(48,48,[6,0,42,33]);
const originals={
  pencil:pixels(50,50,[1,2,48,49]),photo:pixels(120,104,[0,0,120,104]),
  students:pixels(80,80,[4,13,78,68]),cycle:pixels(116,84,[1,1,115,83]),
  skip:pixels(87,51,[1,0,87,51]),
};
globalThis.iconHarness={
  NGUI:{spritePixels:async(widget)=>originals[widget.sprite],load:async()=>({naturalWidth:48,naturalHeight:48,pixels:bodyPixels})},
  spriteUrl:(atlas,name)=>`${atlas}/${name}`,
  document:{createElement(){let image;return {getContext(){return {drawImage(value){image=value;},getImageData(){return image.pixels;}};}};}},
};
let source=await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall-icons.js",import.meta.url),"utf8");
source=source.replace(/^import .*;$/gm,"");source=`const {NGUI,spriteUrl,document}=globalThis.iconHarness;\n${source}\n//# sourceURL=hall-icons-fixture.js`;
const Icons=await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function view(sprite){
  const icon={node:{widgets:[{sprite,atlas:"Common",color:"#466399/1.00"}]},els:[{style:{}}]};
  const bg={els:[{style:{left:"0px",top:"0px",width:"156px",height:"104px",transform:"skewX(-10deg)",backgroundImage:'url("body")'}}]};
  return {nodes:new Map([["Icon",icon],["Bg",bg]]),icon:icon.els[0],background:bg.els[0]};
}
test("original alpha padding is excluded and background shadow is excluded from the button center",async()=>{
  const ink=Icons.inkBounds(originals.students);assert.deepEqual([ink.left,ink.top,ink.right,ink.bottom],[4,13,78,68]);
  const center=await Icons.buttonCenter(view("students").background);
  close(center.y,104*16.5/48);close(center.x,78+Math.tan(-10*Math.PI/180)*(center.y-52));
  assert.ok(center.y<52,"the visible button body is above the shadow-inclusive widget center");
});
test("rendered toolbar icons have equal visible height and matching visible-body centers despite different transparent padding",async()=>{
  for(const sprite of ["pencil","photo","students","cycle"]){
    const target=view(sprite);await Icons.alignIcon(target,"Icon","Bg",{height:64,maxWidth:104});
    const style=target.icon.style,ink=Icons.inkBounds(originals[sprite]),center=await Icons.buttonCenter(target.background);
    const scale=parseFloat(style.width)/ink.width;
    close((ink.bottom-ink.top)*scale,64);
    close(parseFloat(style.left)+(ink.left+ink.right)/2*scale,center.x);
    close(parseFloat(style.top)+(ink.top+ink.bottom)/2*scale,center.y);
    assert.equal(style.backgroundColor,"#466399");assert.equal(style.maskImage,`url("Common/${sprite}")`);
  }
});
test("rotated action ink remains centered, and disabled actions keep the enabled blue with reduced opacity",async()=>{
  for(const rotation of [90,270]){
    const target=view("skip");await Icons.alignIcon(target,"Icon","Bg",{maxSize:56,rotation,enabled:false});
    const style=target.icon.style,ink=Icons.inkBounds(originals.skip),center=await Icons.buttonCenter(target.background);
    const scale=parseFloat(style.width)/ink.width,angle=-rotation*Math.PI/180;
    const dx=((ink.left+ink.right)/2-ink.width/2)*scale,dy=((ink.top+ink.bottom)/2-ink.height/2)*scale;
    close(parseFloat(style.left)+parseFloat(style.width)/2+dx*Math.cos(angle)-dy*Math.sin(angle),center.x);
    close(parseFloat(style.top)+parseFloat(style.height)/2+dx*Math.sin(angle)+dy*Math.cos(angle),center.y);
    close(Math.max(ink.right-ink.left,ink.bottom-ink.top)*scale,56);
    assert.equal(style.transform,`rotate(${-rotation}deg)`);assert.equal(style.opacity,".4");assert.equal(style.backgroundColor,"#466399");
  }
});

test("asymmetric icon mass uses its alpha-weighted optical center without changing visible size",()=>{
  const image=pixels(10,10,[0,6,10,10]);image.data.set([255,255,255,255],0);image.data.set([255,255,255,255],9*4);
  const ink=Icons.inkBounds(image);assert.ok(ink.centerY>7);assert.equal(ink.top,0);assert.equal(ink.bottom,10);
  const fitted=Icons.fitInk(ink,{x:100,y:200},{height:60});
  close(fitted.height,60);close(fitted.left+ink.centerX*6,100);close(fitted.top+ink.centerY*6,200);
});

test("full-stack outline alignment includes translucent backplates instead of centering only their heavier foreground",async()=>{
  const image=pixels(12,12,[1,6,9,11]);
  for(let y=1;y<7;y++)for(let x=5;x<12;x++)if(image.data[(y*12+x)*4+3]===0)image.data.set([255,255,255,96],(y*12+x)*4);
  originals.stack=image;
  const heavy=Icons.inkBounds(image),whole=Icons.inkBounds(image,false,32);
  assert.deepEqual([heavy.left,heavy.top,heavy.right,heavy.bottom],[1,6,9,11]);
  assert.deepEqual([whole.left,whole.top,whole.right,whole.bottom],[1,1,12,11]);
  const target=view("stack");await Icons.alignIcon(target,"Icon","Bg",{height:48,alphaCutoff:32,center:"bounds"});
  const center=await Icons.buttonCenter(target.background),style=target.icon.style,scale=parseFloat(style.height)/12;
  close(parseFloat(style.left)+(whole.left+whole.right)/2*scale,center.x);
  close(parseFloat(style.top)+(whole.top+whole.bottom)/2*scale,center.y);
  close((whole.bottom-whole.top)*scale,48);
});
test("measured native duty and photo outlines center independently of their asymmetric alpha mass",()=>{
  // Derived from runtime pixels; all four authored atlas padding fields are zero for both sprites.
  const duty={width:80,height:80,left:3,top:13,right:78,bottom:68,centerX:37.283737535584834,centerY:44.074586204750865};
  const photo={width:120,height:104,left:0,top:0,right:120,bottom:104,centerX:59.86417363714045,centerY:59.9225322480161};
  for(const [ink,height] of [[duty,48],[photo,48*1.08]]){
    const fitted=Icons.fitInk(ink,{x:100,y:200},{height,center:"bounds"}),scale=fitted.height/ink.height;
    close(fitted.left+(ink.left+ink.right)/2*scale,100);close(fitted.top+(ink.top+ink.bottom)/2*scale,200);
    close((ink.bottom-ink.top)*scale,height);
  }
});
