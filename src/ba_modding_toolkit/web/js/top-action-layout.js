// Reuse the game's sibling boxes; only the Hall's Settings position changes.
export function topActionLayout(boxes,hall,safeRight=0){
  const result=structuredClone(boxes),home=boxes.home;
  if(hall){
    const option=result.option;
    option[0]=home[0]+(home[2]-option[2])/2;
    option[1]=home[1]+(home[3]-option[3])/2;
  }
  const shift=Math.max(0,safeRight-(hall?result.option[0]:home[0]));
  for(const box of Object.values(result))box[0]+=shift;
  return result;
}
export function nativeRightClearance(stage,controls,box){
  if(!stage?.width||!controls?.width)return 0;
  const scale=stage.width/1920,top=stage.top+box[1]*scale,bottom=top+box[3]*scale;
  if(controls.bottom<=top||controls.top>=bottom||controls.left<stage.left+stage.width/2)return 0;
  return Math.max(0,(stage.right-controls.left+8)/scale);
}
