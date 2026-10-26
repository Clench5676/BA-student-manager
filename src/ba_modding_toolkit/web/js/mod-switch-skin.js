// Collection FilterBtn widgets, rasterized by NGUI before the inclined edge is composited.
// A single image replaces WebKit's independently sampled CSS mask/border-image patches.
export const SEGMENT_SCALE=40/104;
export function segmentTree(width,pressed,flipped=false){
  const inset=pressed?.8:0,height=pressed?38:40;
  return {name:'Segment',active:true,pos:[0,0],scale:[1,1],children:[],widgets:[{
    sprite:pressed?'Common_Filter_Tab_Type1_Pressed':'Common_Filter_Tab_Type1',atlas:'Common',type:1,
    w_:(width-inset*2)/SEGMENT_SCALE,h_:height/SEGMENT_SCALE,pivot:4,depth:0,incline:10,
    flip:flipped?1:0,color:pressed?(flipped?'#153757/1.00':'#0664eb/1.00'):'#ffffff/0.95',
  }]};
}
export function segmentOrigin(width,pressed){return [width/2,(pressed?38:40)/2];}

export function segmentDensity(dpi=1,stageScale=1){return Math.max(2,dpi*stageScale);}
