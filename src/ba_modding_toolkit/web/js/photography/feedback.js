// Transient camera feedback stays outside the media roots used by captureScene.
export function stageRect(rect,stage){
  const scale=1920/stage.width;
  return {x:(rect.left-stage.left)*scale,y:(rect.top-stage.top)*scale,width:rect.width*scale,height:rect.height*scale};
}
export function flightTransform(frame,target){
  const width=frame.width||frame.size,height=frame.height||frame.size;
  return {x:target.x+target.width/2-frame.x-width/2,y:target.y+target.height/2-frame.y-height/2,
    scale:Math.min(target.width/width,target.height/height)};
}
export function cameraFeedback(stage,frame,album){
  const host=document.createElement('div');host.className='photo-feedback';host.setAttribute('aria-hidden','true');stage.append(host);
  const live=new Set();let disposed=false;
  const reduced=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function motion(element,frames,options){
    if(!element.animate){element.remove();return Promise.resolve();}
    const animation=element.animate(frames,options);live.add(animation);
    return animation.finished.catch(()=>{}).finally(()=>{live.delete(animation);element.remove();});
  }
  return {
    flash(){
      if(disposed)return;
      const wash=document.createElement('div');wash.className='photo-shutter-flash';host.append(wash);
      void motion(wash,[{opacity:0},{opacity:reduced() ? .12 : .78,offset:.24},{opacity:0}],{duration:180,easing:'ease-out'});
      if(reduced())return;
      for(const half of ['top','bottom']){
        const curtain=document.createElement('div');curtain.className=`photo-shutter-curtain ${half}`;host.append(curtain);
        const away=half==='top'?'-100%':'100%';
        void motion(curtain,[{transform:`translateY(${away})`},{transform:'translateY(0)',offset:.28},{transform:`translateY(${away})`}],{duration:160,easing:'cubic-bezier(.2,.6,.2,1)'});
      }
    },
    async saved(png){
      if(disposed)return;const target=album();if(!target)return;
      const destination=stageRect(target.getBoundingClientRect(),stage.getBoundingClientRect());
      if(!destination.width||!destination.height)return;
      const image=document.createElement('img');image.className='photo-saved-flight';image.alt='';image.draggable=false;image.src=png;
      Object.assign(image.style,{left:`${frame.x}px`,top:`${frame.y}px`,width:`${frame.width||frame.size}px`,height:`${frame.height||frame.size}px`});
      await image.decode();if(disposed)return;host.append(image);
      const end=flightTransform(frame,destination);
      await motion(image,reduced()?[{opacity:.8},{opacity:0}]:[
        {transform:'translate(0,0) scale(1)',opacity:1},
        {transform:`translate(${end.x*.4}px,${end.y*.18-36}px) scale(.65)`,opacity:1,offset:.35},
        {transform:`translate(${end.x}px,${end.y}px) scale(${end.scale})`,opacity:.7},
      ],{duration:reduced()?120:620,easing:'cubic-bezier(.2,.55,.25,1)',fill:'forwards'});
      if(!disposed&&target.isConnected)target.animate?.([{scale:'1'},{scale:'1.12'},{scale:'1'}],{duration:180});
    },
    dispose(){disposed=true;for(const animation of live)animation.cancel();live.clear();host.remove();},
  };
}
