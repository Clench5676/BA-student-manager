import {rpc,waitJob} from '../api.js';
import {T,L} from '../i18n.js';
import * as NGUI from '../ngui.js';
import * as UI from '../student-hall-ui.js';
import * as Popup from '../popup.js';
import * as Loading from '../loading.js';
import {clone,S,hitButton} from '../util.js';
import {captureScene} from './capture.js';
import {photograph} from './shoot.js';
import {cameraFeedback} from './feedback.js';
import {FRAME,choiceLayout,OCCLUSION_BUTTON,captionSize} from './camera.js';
import {alignIcon,buttonCenter} from '../student-hall-icons.js';
import {anchoredCentre} from '../visual-view.js';
import {wheelKind,wheelStep} from '../lobby-touch.js';
export {FRAME};
let sessionVariant=null,generation=0,repository,bridge,overlay,active=false,mode='portrait',grid=true,expanded=false,paused=false,selected=null,page=0,modal=null;
let controlsRevision=0,saving=false,leaving=false,defaultThumbnail=null,generatedThumbnail=null,occlusion=false,feedback=null;
const CHOICE_ICONS={portrait:{icon:'Common_Icon_Emoji',atlas:'Common'},lobby:{icon:'School_Icon_Chat',atlas:'Common'}};
const P=key=>T(`photo.${key}`);
const call=async(name,params={})=>{
  const scope=generation,key=sessionVariant;
  const value=await rpc(`photography.${name}`,{variant:key,...params});
  if(scope!==generation||key!==sessionVariant)throw new DOMException('Photography ended','AbortError');
  return value;
};
const normalized=value=>({...value,photos:value.photos.map(entry=>({...entry,name:entry.builtin?P('generatedThumbnail'):[entry.variant!==sessionVariant?(L(entry.names)?.full||entry.variant):'',T('photo.captureName',{n:entry.number})].filter(Boolean).join(' - ')}))});
const DEFAULT='generated',OFFICIAL='official';
const galleryPhotos=()=>[{id:DEFAULT,name:P('generatedThumbnail'),url:generatedThumbnail,provenance:'runtime',managed:false},{id:OFFICIAL,name:P('officialThumbnail'),url:defaultThumbnail,provenance:'official',managed:false},...(repository?.photos||[])].filter(entry=>entry.url);
const photo=id=>galleryPhotos().find(item=>item.id===id);
const selectedKey=key=>key===DEFAULT?null:key;
async function generatedPNG(){const img=await NGUI.load(generatedThumbnail),canvas=document.createElement('canvas');canvas.width=img.naturalWidth||img.width;canvas.height=img.naturalHeight||img.height;canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL('image/png');}
const stage=()=>document.getElementById('stage');
const tick=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const waitFrame=async(delay=0)=>{if(delay)await new Promise(resolve=>setTimeout(resolve,delay));await tick();await tick();};
async function repositoryRead(){const key=sessionVariant,value=await call('list');if(key!==sessionVariant)throw new DOMException('Photography ended','AbortError');repository=normalized(value);return repository;}
function errorText(error){return error.code?T(`error.${error.code}`,error.params||{}):P('captureFailed');}
function safe(fn){return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(error=>{if(error.name==='AbortError')return;console.error('Photography action failed',error);return Popup.message({title:P('failed'),lines:[errorText(error)],ok:P('confirm')});});}
function node(name,widgets,children=[]){return {name,active:true,pos:[0,0],scale:[1,1,1],rotZ:0,widgets,children};}
let whiteTemplate;
async function whiteButton(host,name,caption,box,action,{icon=null,atlas='Common',pressed=false,enabled=true}={}){
  whiteTemplate ||= NGUI.layout('UICharacterVisualMode').then(layout=>clone(NGUI.find(layout,'Inventory_ListControl_PC/LeftTop/Btn_Back')));
  const tree=clone(await whiteTemplate),[x,y,w,h]=box;
  tree.name=name;tree.pos=[0,0];tree.children=[];
  const body=tree.widgets.find(widget=>'sprite' in widget);body.w_=w/S;body.h_=h/S;body.depth=60;
  if(pressed)body.color='#b9eeff/1.00';
  if(icon)tree.children.push(node('Icon',[{sprite:icon,atlas,w_:Math.min(w-30,h-26)/S,h_:Math.min(w-30,h-26)/S,pivot:4,depth:65,color:'#2b496e/1.00',type:0}]));
  else tree.children.push(node('Label',[{text:caption,fontSize:38,w_:(w-24)/S,h_:(h-16)/S,pivot:4,depth:65,color:'#2b496e/1.00',align:2}]));
  const wrapper=document.createElement('div');wrapper.dataset.photoControl=name;host.append(wrapper);
  const view=await NGUI.render(tree,wrapper,{scale:S,origin:[x+w/2,y+h/2]});
  if(icon)await alignIcon(view,`${name}/Icon`,name,{height:h*.52,maxWidth:w*.64,center:'bounds',color:'#2b496e'});
  else{
    let opticalBody=view.nodes.get(name).els[0];
    if(pressed){
      // A cyan tint falls below the white-body detector's threshold. Measure the identical white stencil.
      const stencil=clone(tree);stencil.children=[];stencil.widgets.find(w=>'sprite' in w).color='#ffffff/1.00';
      const probe=await NGUI.render(stencil,document.createElement('div'),{scale:S,origin:[x+w/2,y+h/2]});opticalBody=probe.nodes.get(name).els[0];
    }
    const center=await buttonCenter(opticalBody),label=view.nodes.get(`${name}/Label`).els[0];
    Object.assign(label.style,{left:`${center.x-(w-24)/2}px`,top:`${center.y-(h-16)/2}px`,paddingBottom:'0px',justifyContent:'center'});
    const style=getComputedStyle(label),canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const maximum=parseFloat(style.fontSize),font=size=>`${style.fontWeight} ${size}px ${style.fontFamily}`;
    const size=name==='Occlusion'?captionSize(size=>{context.font=font(size);return context.measureText(caption).width;},w-36,maximum):maximum;
    label.style.fontSize=`${size}px`;context.font=font(size);
    const metrics=context.measureText(caption),ascent=metrics.fontBoundingBoxAscent,descent=metrics.fontBoundingBoxDescent;
    if(Number.isFinite(ascent)&&Number.isFinite(descent))label.style.translate=`0 ${(metrics.actualBoundingBoxAscent-metrics.actualBoundingBoxDescent-ascent+descent)/2}px`;
  }
  const hit=hitButton(wrapper,box,safe(action),caption,90);hit.disabled=!enabled;hit.dataset.photoAction=name;
  if(pressed)hit.setAttribute('aria-pressed','true');return hit;
}
export function attach(hooks){bridge=hooks;}
export function destroy(){
  generation++;controlsRevision++;active=false;leaving=false;
  modal?.close();modal=null;feedback?.dispose();feedback=null;overlay?.remove();overlay=null;
  document.getElementById('photo-launcher')?.remove();
  document.documentElement.classList.remove('photo-active','photo-lobby');
  if(bridge?.cancel)bridge.cancel();else void bridge?.release();
  sessionVariant=null;repository=null;
}
export async function visualEntry(on){
  document.getElementById('photo-launcher')?.remove();
  if(!on||active||!bridge||!['portrait','lobby'].includes(bridge.info().mode))return;
  const layout=await NGUI.layout('UICharacterVisualMode'),corner=NGUI.find(layout,'Inventory_ListControl_PC/RightBottom');
  const reset=NGUI.find(corner,'Btn_RefreshPos'),body=NGUI.find(reset,'Btn_RefreshPos'),widget=body.widgets.find(w=>'sprite' in w);
  const at=anchoredCentre(corner.widgets.find(w=>w.anchors))||corner.pos;
  const width=widget.w_*S,height=widget.h_*S;
  const x=960+(at[0]+reset.pos[0]+body.pos[0])*S-width/2-(bridge.info().mode==='lobby'?0:width+26);
  const y=540-(at[1]+reset.pos[1]+body.pos[1])*S-height/2;
  const host=document.createElement('div');host.id='photo-launcher';stage().append(host);
  await whiteButton(host,'Entry',P('open'),[x,y,width,height],()=>open(bridge),{icon:'Combat_Icon_Camera',atlas:'Combat'});
}
async function open(hooks){
  if(active)return;bridge=hooks;const scope=++generation;sessionVariant=hooks.info().variant;
  active=true;saving=false;mode=hooks.info().mode==='lobby'?'lobby':'portrait';paused=false;expanded=false;
  document.documentElement.classList.add('photo-active');
  try{
    await Loading.task(async()=>{
      await repositoryRead();
      await Promise.all([hooks.full(mode),Promise.resolve(repository.default||hooks.defaultThumbnail()).then(async url=>{defaultThumbnail=await url;if(defaultThumbnail)await NGUI.load(defaultThumbnail);})]);
      await Promise.all([hooks.prepareExpressions(),hooks.generatedThumbnail().then(async url=>{generatedThumbnail=url;if(url)await NGUI.load(url);})]);
    });
    if(scope!==generation)return;
    overlay=document.createElement('div');overlay.id='photo-overlay';stage().append(overlay);
    await drawControls();
    feedback=cameraFeedback(stage(),FRAME,()=>overlay?.querySelector('[data-path="Gallery/Icon"]'));
  }catch(error){if(scope!==generation||error.name==='AbortError')return;active=false;document.documentElement.classList.remove('photo-active');overlay?.remove();throw error;}
}
async function leave(){
  if(!active||leaving)return;leaving=true;generation++;
  try{
    modal?.close();modal=null;
    await Loading.task(async()=>{
      await bridge.leave();
      active=false;controlsRevision++;feedback?.dispose();feedback=null;overlay?.remove();overlay=null;
      document.documentElement.classList.remove('photo-active');
      await visualEntry(false);
    });
  }finally{leaving=false;}
}
async function switchMode(){
  if(saving)return;
  const next=mode==='portrait'?'lobby':'portrait',available=bridge.info();
  if(next==='lobby'&&!available.hasLobby||next==='portrait'&&!available.hasPortrait)throw new Error(P('noAssets'));
  bridge.pause(false);paused=false;expanded=false;
  saving=true;
  try{await bridge.full(next);mode=next;}
  finally{saving=false;}
  await drawControls();
}
function panSurface(host){
  const surface=document.createElement('div');surface.className='photo-pan';host.append(surface);
  const pointers=new Map();let pinch=null,queued=false,gesture=1,pinchUntil=0,scroll={kind:null,at:-Infinity};
  const redraw=()=>{if(!paused||queued)return;queued=true;requestAnimationFrame(()=>{queued=false;bridge.redraw().catch(console.error);});};
  const anchor=(x,y)=>{const rect=stage().getBoundingClientRect(),k=1920/rect.width;return [(x-rect.left)*k,(y-rect.top)*k,k];};
  const pair=()=>{const [a,b]=[...pointers.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)};};
  surface.addEventListener('pointerdown',event=>{if(event.button!==0)return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});surface.setPointerCapture(event.pointerId);if(pointers.size===2)pinch=pair();event.preventDefault();});
  surface.addEventListener('pointermove',event=>{
    const old=pointers.get(event.pointerId);if(!old||saving)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===2){const next=pair();if(pinch){const [x,y,k]=anchor(next.x,next.y);if(pinch.d>0)bridge.zoom(next.d/pinch.d,x,y);bridge.pan((next.x-pinch.x)*k,(next.y-pinch.y)*k);}pinch=next;}
    else if(pointers.size===1){const k=1920/stage().getBoundingClientRect().width;bridge.pan((event.clientX-old.x)*k,(event.clientY-old.y)*k);}
    redraw();
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(type,event=>{pointers.delete(event.pointerId);pinch=null;});
  surface.addEventListener('wheel',event=>{
    event.preventDefault();if(saving)return;const [x,y,k]=anchor(event.clientX,event.clientY),unit=event.deltaMode===1?40:event.deltaMode===2?800:1,now=performance.now();
    if(event.ctrlKey){if(now<pinchUntil)return;bridge.zoom(Math.exp(-event.deltaY*unit*.01),x,y);}
    else{const kind=wheelKind(event,now,scroll);scroll={kind,at:now};
      if(kind==='mouse'&&Math.abs(event.deltaY)>=Math.abs(event.deltaX))bridge.zoom(Math.exp(-Math.sign(event.deltaY)*Math.max(Math.abs(event.deltaY*unit),wheelStep(event)==='notch'?40:0)*.0015),x,y);
      else bridge.pan(-event.deltaX*unit*k,-event.deltaY*unit*k);
    }redraw();
  },{passive:false});
  surface.addEventListener('gesturestart',event=>{event.preventDefault();gesture=1;pinchUntil=performance.now()+300;});
  surface.addEventListener('gesturechange',event=>{event.preventDefault();if(saving)return;pinchUntil=performance.now()+300;const [x,y]=anchor(event.clientX,event.clientY);bridge.zoom(event.scale/gesture,x,y);gesture=event.scale;redraw();});
  surface.addEventListener('gestureend',event=>{event.preventDefault();pinchUntil=performance.now()+300;});
  surface.addEventListener('contextmenu',event=>event.preventDefault());
}

async function shutter(host){
  const tree=node('Shutter',[{sprite:'Common_Btn_Circle_W',atlas:'Common',type:0,w_:146/S,h_:146/S,pivot:4,depth:60,color:'#ffffff/1.00'}]);
  const view=await NGUI.render(tree,host,{scale:S,origin:[960,980]});
  const center=await buttonCenter(view.nodes.get('Shutter').els[0]);
  const ring=document.createElement('span');ring.className='photo-shutter-ring';
  Object.assign(ring.style,{left:`${center.x-49}px`,top:`${center.y-49}px`});host.append(ring);
  const hit=hitButton(host,[887,907,146,146],safe(capture),P('capture'),90);hit.disabled=saving;hit.dataset.photoAction='Capture';
}

async function modeButton(host){
  const layout=await NGUI.layout('UILobby'),tree=clone(NGUI.find(layout,'Front/Right/Btn_RotateSpine/ConditionRoot/Able_Count'));
  tree.name='CameraMode';tree.pos=[0,0];tree.children=tree.children.filter(child=>['Bg','Icon'].includes(child.name));
  const body=NGUI.find(tree,'Bg').widgets.find(w=>'sprite' in w);body.w_=102/S;body.h_=76/S;body.depth=60;
  const icon=NGUI.find(tree,'Icon');icon.pos=[0,0];icon.scale=[1,1];icon.widgets.find(w=>'sprite' in w).depth=65;
  const view=await NGUI.render(tree,host,{scale:S,origin:[1839,63]});
  await alignIcon(view,'CameraMode/Icon','CameraMode/Bg',{height:48*S,maxWidth:104*S,center:'bounds',color:'#2b496e'});
  const hit=hitButton(host,[1788,25,102,76],safe(switchMode),P(mode==='portrait'?'lobby':'portrait'),90);hit.dataset.photoAction='Mode';
}

async function backButton(host){
  const collection=await NGUI.layout('UICharacterCollection'),tree=clone(NGUI.find(collection,'SeletControl/Top/BG_W/Bg/Btn'));
  tree.name='PhotoBack';tree.pos=[0,0];
  const width=164*S,height=172*S;
  await NGUI.render(tree,host,{scale:S,origin:[25+width/2,20+height/2]});
  const hit=hitButton(host,[25,20,width,height],safe(leave),P('back'),90);hit.dataset.photoAction='Back';
}

async function playbackButton(host){
  const {tree,textures}=bridge.playbackTree(paused),scale=82/141,width=145*scale,x=1788-20-width;
  tree.widgets.find(w=>'sprite' in w).depth=60;
  for(const child of tree.children)for(const widget of child.widgets||[])widget.depth=65;
  await NGUI.render(tree,host,{scale,origin:[x+width/2,991],textureNames:textures});
  const hit=hitButton(host,[x,950,width,82],safe(async()=>{if(saving)return;paused=!paused;bridge.pause(paused);await drawControls();}),P(paused?'play':'pause'),90);
  hit.dataset.photoAction='Playback';hit.setAttribute('aria-pressed',String(paused));
}

async function choicePanel(host,box){
  const {formation}=await UI.ready(),tree=clone(NGUI.find(formation,'Center/Popup/RightBg'));
  tree.name='PhotoChoices';tree.pos=[0,0];tree.children=tree.children.filter(child=>child.name==='Bg_W');
  Object.assign(tree.widgets.find(w=>'sprite' in w),{w_:box.width/S,h_:box.height/S,depth:15});
  const paper=NGUI.find(tree,'Bg_W');paper.pos=[0,0];
  Object.assign(paper.widgets.find(w=>'sprite' in w),{w_:box.width/S-20,h_:box.height/S-20,depth:16});
  await NGUI.render(tree,host,{scale:S,origin:[box.x+box.width/2,box.y+box.height/2]});
}

async function occlusionGuide(layer){
  const layout=await NGUI.layout('UICharacterCollectionPopulatorUnit');
  const tree=clone(NGUI.find(layout,'Grid/UICollectCard'));
  tree.name='Occlusion';tree.pos=[0,0];tree.scale=[1,1];tree.active=true;
  tree.children=tree.children.filter(child=>['Sort','CharacterWeapon'].includes(child.name));
  const sort=NGUI.find(tree,'Sort');sort.active=true;sort.children=sort.children.filter(child=>child.name==='Sprite');
  const weapon=NGUI.find(tree,'CharacterWeapon');weapon.active=true;
  const host=document.createElement('div');
  Object.assign(host.style,{position:'absolute',left:FRAME.x+'px',top:FRAME.y+'px',width:FRAME.width+'px',height:FRAME.height+'px',overflow:'hidden',pointerEvents:'none',zIndex:'5'});
  layer.append(host);
  const scale=FRAME.width/404;
  await NGUI.render(tree,host,{scale,origin:[FRAME.width/2,FRAME.height/2+2.8*scale]});
}
async function drawControls(){
  if(!active||!overlay)return;const revision=++controlsRevision;
  const layer=document.createElement('div');panSurface(layer);
  const guide=document.createElement('div');guide.className='photo-guide'+(grid?'':' no-grid');guide.innerHTML='<i></i><i></i><i></i><i></i>';layer.append(guide);
  Object.assign(guide.style,{left:`${FRAME.x}px`,top:`${FRAME.y}px`,width:`${FRAME.width}px`,height:`${FRAME.height}px`});
  const buttons=[backButton(layer),
    whiteButton(layer,'Occlusion',P('occlusion'),OCCLUSION_BUTTON,async()=>{occlusion=!occlusion;await drawControls();},{pressed:occlusion}),
    whiteButton(layer,'Grid',grid?P('gridOn'):P('gridOff'),[1570,25,196,76],async()=>{grid=!grid;await drawControls();},{pressed:grid}),
    modeButton(layer),
    whiteButton(layer,'Gallery',P('gallery'),[25,950,130,82],openGallery,{icon:'Cafe_Icon_Photo'}),
    shutter(layer),
    whiteButton(layer,'Choices',P(mode==='portrait'?'expressions':'actions'),[1788,950,102,82],async()=>{expanded=!expanded;await drawControls();},CHOICE_ICONS[mode])];
  if(occlusion)buttons.push(occlusionGuide(layer));
  if(mode==='lobby')buttons.push(playbackButton(layer));
  if(expanded){
    const entries=mode==='portrait'?bridge.expressions():bridge.actions(),box=choiceLayout(mode,entries.length);
    await choicePanel(layer,box);
    if(mode==='portrait'){
      const items=entries,area=UI.area(layer,[box.x+12,box.y+12,box.width-24,box.rows*box.rowHeight],box.contentHeight,'photo-expressions');
      for(let index=0;index<items.length;index++)buttons.push((async()=>{
        const key=items[index],preview=await bridge.expressionPreview(key),x=6+(index%box.columns)*146,y=Math.floor(index/box.columns)*box.rowHeight;
        const tree=bridge.expressionCard(key,preview),scale=128/242,height=209*scale;
        await NGUI.render(tree,area,{scale,origin:[x+64,y+height/2]});
        const hit=hitButton(area,[x,y,128,height],safe(async()=>{if(saving)return;bridge.setExpression(key);await drawControls();}),key==='00'?P('natural'):`${P('expressions')} ${key}`,90);
        hit.setAttribute('aria-pressed',String(key===bridge.expression()));
      })());
    }else{
      const sequences=entries;
      const actionArea=UI.area(layer,[box.x+12,box.y+12,box.columns*196,box.rows*61],box.contentHeight,'photo-actions');
      for(let index=0;index<sequences.length;index++)buttons.push(UI.button(actionArea,'Sequence'+index,sequences[index].anim,[6+(index%box.columns)*196,Math.floor(index/box.columns)*61,185,53],safe(async()=>{if(saving)return;paused=false;bridge.play(sequences[index].anim);await drawControls();})));
    }
  }
  await Promise.all(buttons);
  if(!active||revision!==controlsRevision)return;
  overlay.replaceChildren(...layer.childNodes);
}
async function capture(){
  if(!active||saving)return;
  saving=true;
  const scope=generation,key=sessionVariant,current=bridge,effects=feedback;
  const scoped={...current,pause:on=>{if(scope===generation)current.pause(on);}};
  try{
    const result=await photograph({bridge:scoped,mode,paused,alive:()=>scope===generation&&active&&!leaving,wait:waitFrame,capture:async()=>{
      if(scope!==generation)throw new DOMException('Photography ended','AbortError');
      const shot=await captureScene(current.paintRoots(),stage());
      if(scope!==generation)throw new DOMException('Photography ended','AbortError');
      return shot;
    },save:payload=>rpc('photography.save',{variant:key,...payload}),onCaptured:()=>effects?.flash(),onSaved:(_,shot)=>effects?.saved(shot.png)});
    if(scope!==generation)return;
    repository=normalized({...repository,...result});selected=result.saved;page=Math.floor(result.photos.length/6);
    overlay?.querySelector('.photo-shutter-ring')?.animate([{scale:'.9'},{scale:'1'}],{duration:140});
  }finally{if(scope===generation)saving=false;}
}
async function image(host,url,box,className='photo-large-image'){
  const img=document.createElement('img');img.className=className;img.alt=P('photoLabel');
  img.draggable=false;
  Object.assign(img.style,{position:'absolute',left:box[0]+'px',top:box[1]+'px',width:box[2]+'px',height:box[3]+'px',zIndex:'70',pointerEvents:'none',objectFit:'contain'});img.src=url;host.append(img);await img.decode();return img;
}
async function openGallery(keepSelection=false){
  if(saving)return;bridge.pause(true);await repositoryRead();
  if(!keepSelection)selected=repository.app||DEFAULT;
  const close=()=>{modal?.close();modal=null;bridge.pause(paused);};
  modal=UI.createModal(P('gallery'),close);
  await galleryDraw();
}
async function galleryDraw(){
  const allPhotos=galleryPhotos();page=Math.min(page,Math.max(0,Math.ceil(allPhotos.length/6)-1));
  const selectedPhoto=photo(selected);
  await modal.draw(async(layer)=>{
    const rows=allPhotos.slice(page*6,page*6+6);
    if(!rows.length)await UI.caption(layer,P('empty'),[365,440,680]);
    await Promise.all(rows.map(async(entry,index)=>{
      const x=465+(index%3)*215,y=343+Math.floor(index/3)*236,scale=.59;
      const item={key:entry.id,label:entry.name,thumb:entry.url,badge:repository.game?.known&&!repository.game?.error&&!repository.game?.pending&&entry.id===repository.game.id?{text:P('applied'),color:'#8de4ff',ink:'#314665'}:null};
      const tree=Popup.listCard(item,0,0,entry.id===selected,{w:250,h:250,bar:46});
      await NGUI.render(tree,layer,{scale,origin:[x,y]});
      hitButton(layer,[x-92,y-80,184,210],safe(async()=>{selected=entry.id;await galleryDraw();}),entry.name,90);
    }));
    if(selectedPhoto){
      await image(layer,selectedPhoto.url,[1190,270,320,320]);
      await UI.caption(layer,selectedPhoto.name,[1190,625,320],{align:2});
      const pair=UI.buttonSize([P('apply'),P('delete')],140,64);
      await UI.button(layer,'Apply',P('apply'),[1200,670,140,64],safe(applyGame),{semantic:"apply",size:pair,enabled:repository.applicable&&(!repository.game?.known||selected!==repository.game?.id||!!repository.game?.error||repository.game?.pending)});
      if(selectedPhoto.managed!==false&&selectedPhoto.provenance!=='official')await UI.button(layer,'Delete',P('delete'),[1360,670,140,64],safe(deletePhoto),{size:pair});
    }
    if(allPhotos.length>6){
      const paging=UI.buttonSize([P('previous'),P('next')],180,55);
      await UI.button(layer,'Previous',P('previous'),[365,748,180,55],safe(async()=>{page=Math.max(0,page-1);await galleryDraw();}),{enabled:page>0,size:paging});
      await UI.button(layer,'Next',P('next'),[565,748,180,55],safe(async()=>{page++;await galleryDraw();}),{enabled:(page+1)*6<allPhotos.length,size:paging});
    }
    const tools=UI.buttonSize([P('restore'),P('export')],180,64);
    await UI.button(layer,'Restore',P('restore'),[365,835,180,64],safe(async()=>{
      const scope=generation;
      await Loading.task(async()=>{await waitJob(await call('restore',{png:await generatedPNG()}));if(scope!==generation)throw new DOMException('Photography ended','AbortError');await repositoryRead();});
      bridge.thumbnailChanged();selected=DEFAULT;page=0;await galleryDraw();
    }),{enabled:repository.app!==null||repository.game?.id!==DEFAULT,size:tools});
    await UI.button(layer,'Export',P('export'),[565,835,180,64],safe(async()=>{await Loading.task(async()=>call('export',{id:selected,png:selected===DEFAULT?await generatedPNG():null}));}),{enabled:!!selectedPhoto,size:tools});
    await UI.button(layer,'SaveSelection',P('saveSelection'),[1280,835,140,64],safe(async()=>{repository=normalized({...repository,...await call('select',{id:selectedKey(selected)})});bridge.thumbnailChanged();modal.close();modal=null;bridge.pause(paused);}),{semantic:"save",enabled:!!selected});
  },[],{width:2000,height:1200});
}
async function deletePhoto(){
  const key=selected,info=await call('removalInfo',{id:key});
  if(info.official)return;
  if(info.used){
    const answer=await Popup.message({title:P('delete'),lines:[T('error.asset_delete_confirm')],ok:P('delete'),cancel:T('popup.cancel')});
    if(answer.button!=='ok')return;
  }
  const scope=generation;
  await Loading.task(async()=>{
    const result=await waitJob(await call('delete',{id:key,confirm:!!info.used}));
    if(scope!==generation)throw new DOMException('Photography ended','AbortError');
    repository=normalized(result);
  });
  bridge.thumbnailChanged();selected=repository.photos.at(-1)?.id||DEFAULT;await galleryDraw();
}

async function applyGame(){
  if(!photo(selected)||!repository.applicable)return;
  const scope=generation;
  await Loading.task(async()=>{await waitJob(await call('apply',{id:selected,png:selected===DEFAULT?await generatedPNG():null}));if(scope!==generation)throw new DOMException('Photography ended','AbortError');await repositoryRead();});
  await galleryDraw();
}
globalThis.addEventListener?.('keydown',event=>{if(active&&!modal&&!Loading.covering()&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();safe(leave)();}},true);
