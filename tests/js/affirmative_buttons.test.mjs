import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hasAffirmative,skinAffirmatives} from '../../src/ba_modding_toolkit/web/js/affirmative-buttons.js';
test('affirmative styling preserves secondary and disabled semantics',()=>{
 const make=(name,color='#77deff/1.00')=>({name,actionSemantic:name.startsWith('Save')?'save':'secondary',widgets:[{sprite:'Common_Btn_BG',w_:496,h_:177,color}],children:[{name:'Label_Locale',widgets:[{text:'Save',color:'#123456/1.00'}],children:[]}]});
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
 const tree={name:'Save',actionSemantic:'save',widgets:[{sprite:'Common_Btn_BG',w_:100,h_:60}],children:[{name:'Thumb',widgets:[{clipImage:picture}],children:[]}]};
 const template={widgets:[{sprite:'Common_Btn_BG',w_:494,h_:162,color:'#f6e94b/1.00'}],children:[{name:'Label_Locale',widgets:[{text:'',color:'#4b2116/1.00'}]}]};
 assert.equal(skinAffirmatives(tree,template).children[0].widgets[0].clipImage,picture);
});

test('names and translated captions cannot imply an affirmative action',()=>{
  for(const name of ['Save','Export','Update','Btn_Ok'])assert.equal(hasAffirmative({name,children:[]}),false);
  for(const actionSemantic of ['save','confirm','apply'])assert.equal(hasAffirmative({name:'Arbitrary',actionSemantic}),true);
  for(const actionSemantic of ['update','export','secondary'])assert.equal(hasAffirmative({name:'Save',actionSemantic}),false);
});

test('the source picker, gallery and Settings use explicit treatment in all locales',async()=>{
  const {readFile}=await import('node:fs/promises');
  const popup=await readFile(new URL('../../src/ba_modding_toolkit/web/js/popup.js',import.meta.url),'utf8');
  assert.match(popup,/actionSemantic=b.semantic\|\|\(b.primary\?"confirm":"secondary"\)/);
  assert.ok(!popup.includes('[T("popup.apply"),T("act.update")'));
  const controller=await readFile(new URL('../../src/ba_modding_toolkit/web/js/photography/controller.js',import.meta.url),'utf8');
  assert.match(controller,/'Export',P\('export'\).*enabled:!!selectedPhoto/s);
  assert.match(controller,/'SaveSelection'.*semantic:"save"/s);
  for(const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH']){
    const data=JSON.parse(await readFile(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url),'utf8'));
    assert.ok(data.webui.export.applied.includes('Mod'));
    if(locale==='zh-CN'){
      assert.equal(data.webui.popup.save,'保存');assert.equal(data.webui.export.library,'导出Mod仓库');assert.equal(data.webui.export.applied,'导出已应用的Mod');
    }
  }
});
