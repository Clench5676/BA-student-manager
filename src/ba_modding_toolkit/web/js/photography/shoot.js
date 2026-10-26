// Freeze one complete real frame, restore playback, and persist it without a review modal.
function notify(callback,...args){
  try{Promise.resolve(callback?.(...args)).catch(error=>console.warn('Photography feedback failed',error));}
  catch(error){console.warn('Photography feedback failed',error);}
}
export async function photograph({bridge,mode,paused,capture,wait,save,onCaptured,onSaved,alive=()=>true}){
  const check=()=>{if(!alive())throw new DOMException("Photography ended","AbortError");};
  check();bridge.pause(true);
  const pose={mode,expression:mode==='portrait'?bridge.expression():'',action:bridge.action()||'',source:bridge.info().source||''};
  let payload;
  try{
    let shot;
    for(let attempt=0;attempt<60;attempt++){
      try{check();await wait(attempt?Math.min(250,attempt*25):0);check();await bridge.redraw();check();shot=await capture();check();break;}
      catch(error){if(error.code!=='capture_not_ready')throw error;if(attempt===59)throw Object.assign(new Error('Renderer did not recover'),{code:'photo_capture_unavailable'});}
    }
    payload={png:shot.png,...pose};
    notify(onCaptured,shot);
  }finally{bridge.pause(paused);}
  check();
  const result=await save(payload);
  check();
  notify(onSaved,result,payload);
  return result;
}
