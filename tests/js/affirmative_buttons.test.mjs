import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hasAffirmative,skinAffirmatives} from '../../src/ba_modding_toolkit/web/js/affirmative-buttons.js';
test('affirmative styling preserves secondary and disabled semantics',()=>{
 const make=(name,color='#77deff/1.00')=>({name,widgets:[{sprite:'Common_Btn_BG',w_:496,h_:177,color}],children:[{name:'Label_Locale',widgets:[{text:'Save',color:'#123456/1.00'}],children:[]}]});
 const gold=make('Btn','#f6e94b/1.00');gold.children[0].widgets[0].color='#4b2116/1.00';
 const input={name:'Root',widgets:[],children:[make('Save'),make('Btn_Cancel'),make('SaveSelection','#d6d6d6/1.00')]};
 assert.ok(hasAffirmative(input));
 const output=skinAffirmatives(input,gold);
 assert.equal(output.children[0].widgets[0].color,'#f6e94b/1.00');
 assert.equal(output.children[1].widgets[0].color,'#77deff/1.00');
 assert.equal(output.children[2].widgets[0].color,'#d6d6d6/1.00');
 assert.equal(input.children[0].widgets[0].color,'#77deff/1.00');
});
test('styling retains asynchronous thumbnail sources without cloning them',()=>{
 const picture=Promise.resolve('thumbnail');
 const tree={name:'Save',widgets:[{sprite:'Common_Btn_BG',w_:100,h_:60}],children:[{name:'Thumb',widgets:[{clipImage:picture}],children:[]}]};
 const template={widgets:[{sprite:'Common_Btn_BG',w_:494,h_:162,color:'#f6e94b/1.00'}],children:[{name:'Label_Locale',widgets:[{text:'',color:'#4b2116/1.00'}]}]};
 assert.equal(skinAffirmatives(tree,template).children[0].widgets[0].clipImage,picture);
});
