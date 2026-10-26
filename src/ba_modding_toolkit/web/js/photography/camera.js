// Camera limits constrain the capture square, rather than the entire display viewport.
// The framing guide matches UICollectCard/Char_Portrait, so application never stretches a square into the roster.
const HEIGHT=360,WIDTH=HEIGHT*404/456;
export const FRAME=Object.freeze({x:(1920-WIDTH)/2,y:360,width:WIDTH,height:HEIGHT,size:HEIGHT});
const bounded=(value,low,high)=>low<=high?Math.max(low,Math.min(high,value)):(low+high)/2;
export const portraitMinimum=(box,homeScale,frame=FRAME)=>Math.min(homeScale,(frame.height||frame.size)/Math.max(1,box[3]-box[1]));
export const lobbyMaximumWidth=(bounds,normalWidth,frame=FRAME)=>Math.max(normalWidth,(bounds.y1-bounds.y0)*1920/(frame.height||frame.size));
export function choiceLayout(kind,count){
  const columns=kind==='portrait'?Math.min(4,Math.max(1,count)):Math.min(3,Math.max(1,count));
  const rowHeight=kind==='portrait'?128:61,totalRows=Math.max(1,Math.ceil(count/columns)),rows=Math.min(3,totalRows);
  const width=kind==='portrait'?columns*146+24:columns*196+24;
  const height=rows*rowHeight+24;
  return {x:1890-width,y:920-height,width,height,columns,rowHeight,rows,contentHeight:totalRows*rowHeight};
}
export function portraitCaptureView(view,bounds,frame=FRAME){
  const [x0,y0,x1,y1]=bounds,k=view.k;
  return {...view,cx:bounded(view.cx,x0-(frame.x-960)/k,x1-(frame.x+(frame.width||frame.size)-960)/k),
    cy:bounded(view.cy,y0-(540-frame.y-(frame.height||frame.size))/k,y1-(540-frame.y)/k)};
}
export function lobbyCaptureView(view,bounds,frame=FRAME){
  const left=frame.x/1920,right=(frame.x+(frame.width||frame.size))/1920;
  const bottom=1-(frame.y+(frame.height||frame.size))/1080,top=1-frame.y/1080;
  return {...view,x:bounded(view.x,bounds.x0-left*view.w,bounds.x1-right*view.w),
    y:bounded(view.y,bounds.y0-bottom*view.h,bounds.y1-top*view.h)};
}

// Keep the existing right edge and neighbouring grid/mode controls fixed.
export const OCCLUSION_BUTTON=Object.freeze([1352,25,196,76]);
// The toolbar's text buttons (Occlusion Guide, Grid) share one caption size: the largest up to 38 units at which every caption
// fits its 196 x 76 body (18 clear of each side, 8 above and below) on up to two lines. Stage px.
export const TOOLBAR_CAPTION=Object.freeze({size:38,min:26,width:196-36,height:76-16});
