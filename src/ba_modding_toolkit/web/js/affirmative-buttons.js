// UIMailBox/Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn is the native gold affirmative branch.
import {resizeButton} from './button-layout.js';
const affirmative=new Set(['confirm','save','apply','import','install','finish']);
const isAffirmative=tree=>tree.affirmative===true||affirmative.has(tree.actionSemantic);
export function hasAffirmative(tree){
  return isAffirmative(tree)||(tree.children||[]).some(hasAffirmative);
}
export function skinAffirmatives(tree,template){
  const findBody=n=>n.widgets?.some(w=>w.sprite==='Common_Btn_BG')?n:(n.children||[]).map(findBody).find(Boolean);
  const visit=(n,held=false)=>{
    if(!held&&isAffirmative(n)){
      const body=findBody(n),original=body?.widgets.find(w=>w.sprite==='Common_Btn_BG');
      if(original&&!/^#(?:d6d6d6|828282)/i.test(original.color||'')){
        const source=structuredClone(template),gold=source.widgets.find(w=>w.sprite==='Common_Btn_BG');
        resizeButton(source,original.w_,original.h_);
        Object.assign(original,{atlas:gold.atlas,sprite:gold.sprite,type:gold.type,color:gold.color,incline:gold.incline});
        const patterns=source.children.filter(child=>child.widgets?.some(w=>/_Pt$/.test(w.sprite||'')));
        for(const pattern of patterns)for(const w of pattern.widgets)w.depth=(original.depth||0)+1;
        body.children=[...(body.children||[]).filter(child=>!child.widgets?.some(w=>/_Pt$/.test(w.sprite||''))),...patterns];
        const ink=node=>{for(const w of node.widgets||[])if('text'in w)w.color=template.children.find(c=>c.name==='Label_Locale').widgets[0].color;for(const c of node.children||[])ink(c);};ink(n);
        held=true;
      }
    }
    for(const child of n.children||[])visit(child,held);
  };
  const copy=node=>({...node,pos:node.pos?.slice(),scale:node.scale?.slice(),widgets:(node.widgets||[]).map(widget=>({...widget})),children:(node.children||[]).map(copy)});
  const result=copy(tree);visit(result);return result;
}
// Derived widget geometry only; every sprite is still loaded from the user's own Common atlas at runtime.
// Keeping these small values avoids loading the entire Mailbox scene for each first confirmation.
export const goldTemplate={name:'Btn',pos:[0,0],scale:[1,1],widgets:[
 {sprite:'Common_Btn_BG',atlas:'Common',type:1,incline:10,w_:494,h_:162,pivot:4,depth:5,color:'#f6e94b/1.00'}],children:[
 {name:'Label_Locale',pos:[0,5],scale:[1,1],widgets:[{text:'',color:'#4b2116/1.00'}],children:[]},
 ...[[125.8,3.1,1,.8],[-122.6,9.3,-1,.6]].map(([x,y,scale,alpha],index)=>({name:`GoldPattern${index}`,pos:[x,y],scale:[scale,scale],widgets:[
 {sprite:'Common_Btn_Normal_Y_S_Pt',atlas:'Common',type:1,incline:0,w_:252,h_:140,pivot:4,depth:6,color:`#ffffff/${alpha}`}],children:[]}))]};
