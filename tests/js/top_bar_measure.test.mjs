import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { naturalTextWidth } from '../../src/ba_modding_toolkit/web/js/top-bar-measure.js';

test('natural measurement retains shaping and trailing spacing outside the clipped or hidden row',()=>{
  for(const locale of ['en-US','zh-CN','zh-TW','ja-JP','ko-KR','th-TH']){
    const ui=JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`,import.meta.url))).webui;
    for(const text of [ui.top.students,ui.hall.title,ui.nav.import,ui.mods.switch])for(const scale of [.5,1,2]){
      let removed=false,probe;
      const shapedWidth=[...text].length*15.2+1; // includes the browser's last spacing advance
      const style={fontFamily:'"RHR Latin", "Thonburi", sans-serif',fontSize:'26px',fontWeight:'500',
        letterSpacing:'1px',fontFeatureSettings:'"halt"',fontKerning:'normal',textRendering:'geometricPrecision'};
      const doc={documentElement:{lang:locale},body:{append(el){probe=el;}},createElement(){return {style:{},
        getBoundingClientRect(){return {width:shapedWidth};},remove(){removed=true;}};}};
      assert.equal(naturalTextWidth({textContent:text},scale,doc,()=>style),Math.ceil(shapedWidth*scale));
      for(const key of Object.keys(style))assert.equal(probe.style[key],style[key]);
      assert.equal(probe.lang,locale);assert.equal(probe.style.width,'max-content');
      assert.equal(probe.style.visibility,'hidden');assert.ok(removed);
    }
  }
});
