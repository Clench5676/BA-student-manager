// Freeze one complete real frame, restore playback, and persist it without a review modal.
function notify(callback,...args){
  try{Promise.resolve(callback?.(...args)).catch(error=>console.warn('Photography feedback failed',error));}
  catch(error){console.warn('Photography feedback failed',error);}
}
export async function photograph({bridge,mode,paused,capture,wait,save,onCaptured,onSaved}){
  bridge.pause(true);
  const pose={mode,expression:mode==='portrait'?bridge.expression():'',action:bridge.action()||'',source:bridge.info().source||''};
  let payload;
  try{
    await bridge.redraw();await wait();
    let shot;
    for(let attempt=0;attempt<12;attempt++){
      try{shot=await capture();break;}
      catch(error){if(error.code!=='capture_not_ready'||attempt===11)throw error;await bridge.redraw();await wait();}
    }
    payload={png:shot.png,...pose};
    notify(onCaptured,shot);
  }finally{bridge.pause(paused);}
  const result=await save(payload);
  notify(onSaved,result,payload);
  return result;
}
