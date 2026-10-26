// Compose only actual scene media; UI, guide, cursor and subtitle layers are never inputs.
import * as NGUI from '../ngui.js';
import {FRAME} from './camera.js';
export {FRAME};
export function projectedCrop(stageBox,box=FRAME){
  const factor=stageBox.width/1920;
  return {left:stageBox.left+box.x*factor,top:stageBox.top+box.y*factor,width:(box.width||box.size)*factor,height:(box.height||box.size)*factor};
}
function visibility(element,root){
  let opacity=1;
  for(let node=element;node&&node!==root.parentElement;node=node.parentElement){
    const style=getComputedStyle(node);
    if(node.hidden||style.display==='none'||style.visibility==='hidden')return 0;
    opacity*=Number(style.opacity||1);
  }
  return opacity;
}
export async function captureScene(roots,stage){
  const crop=projectedCrop(stage.getBoundingClientRect());
  const media=[];
  for(const root of roots){
    if(!root||root.hidden)continue;
    for(const node of root.querySelectorAll('canvas,img,div.ngui')){
      if(node.closest('.lobby-off,.lobby-fade,.lobby-subtitle,.lobby-text,.lobby-balloon,.lobby-caption'))continue;
      const alpha=visibility(node,root);if(alpha<=.001)continue;
      const rect=node.getBoundingClientRect();
      if(!rect.width||!rect.height||rect.right<crop.left||rect.left>crop.left+crop.width||rect.bottom<crop.top||rect.top>crop.top+crop.height)continue;
      const style=getComputedStyle(node);
      let image=node;
      if(node.tagName==='DIV'){
        const match=/^url\(["']?(.*?)["']?\)$/.exec(style.backgroundImage);
        if(!match)continue;
        image=await NGUI.load(match[1]);
      }
      if(node.tagName==='IMG')await node.decode?.();
      const width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
      if(!width||!height)continue;
      media.push({node,image,rect,alpha,z:Number(style.zIndex)||Number(getComputedStyle(node.parentElement).zIndex)||0,
                  scale:node.tagName==='CANVAS'?width/rect.width:0,blend:style.mixBlendMode});
    }
  }
  if(!media.some(item=>item.node.tagName==='CANVAS'))throw Object.assign(new Error('Renderer is not ready'),{code:'capture_not_ready'});
  const density=Math.max(...media.map(item=>item.scale));
  const limited=Math.min(density,4096/Math.max(crop.width,crop.height));
  const width=Math.max(64,Math.round(crop.width*limited)),height=Math.max(64,Math.round(crop.height*limited));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';
  media.sort((a,b)=>a.z-b.z);
  for(const item of media){
    ctx.globalAlpha=item.alpha;
    ctx.globalCompositeOperation=['screen','multiply','lighter'].includes(item.blend)?item.blend:'source-over';
    ctx.drawImage(item.image,(item.rect.left-crop.left)/crop.width*width,(item.rect.top-crop.top)/crop.height*height,item.rect.width/crop.width*width,item.rect.height/crop.height*height);
  }
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  return {png:canvas.toDataURL('image/png'),width,height};
}
