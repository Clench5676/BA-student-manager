import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {n,spr,insert} from './control_prefabs.mjs';
const detail=await readFile(new URL('../../src/ba_modding_toolkit/web/js/detail.js',import.meta.url),'utf8');
const code=detail.slice(detail.indexOf('// Student photography retains'));
const playbackFixture=n('Inventory_ListControl');
insert(playbackFixture,'LeftInfo/CharInfo/Char_Target/Char_ZoomBtn',n('Char_ZoomBtn',[0,0],[spr('Common_Bg_Raius5px_Shadow',145,141)],[n('Sprite',[3.6,9.8],[spr('Common_Icon_ZoomChar',100,70)])]));
function harness({start='portrait',show}={}){
  const calls=[],nodes=new Map();
  const classList=()=>({add:(...n)=>calls.push(['class.add',...n]),remove:()=>{},toggle:()=>{}});
  const player={skeleton:{data:{animations:[]}},drawFrame:()=>calls.push(['portrait.frame']),stopRendering:()=>calls.push(['portrait.stop']),startRendering:()=>calls.push(['portrait.start']),stopRequestAnimationFrame:true};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},classList:classList(),hidden:id==='lobby',querySelectorAll:()=>id==='portrait'?[{player}]:[]});return nodes.get(id);};
  const env={console,Promise,tab:start,variantKey:'cycling',open:true,fullscreen:true,mainPlayer:player,fam:{version:'r1'},lobbyFrom:null,lobbyStale:false,
    previewAvailable:()=>true,variant:()=>({key:'cycling',spr:'cycling_spr',lobby:'cycling_home'}),current:()=>({kind:'self'}),modsOn:()=>true,specialFraming:()=>null,
    $:node,stage:()=>node('stage'),document:{documentElement:{classList:classList()}},Photo:{FRAME:{x:780,y:360,size:360}},
    Lobby:{show:async()=>{calls.push(['lobby.show']);return show?show():{};},suspend:()=>calls.push(['lobby.suspend']),frame:()=>{},photography:()=>{},skipIntro:()=>{},
      prepareFrame:async()=>calls.push(['lobby.frame']),resume:()=>calls.push(['lobby.resume']),interactive:()=>{},hide:()=>calls.push(['lobby.hide']),meta:()=>null},
    Visual:{isOpen:()=>true,photography:()=>{},captureReady:()=>{},uiOut:()=>{},close:()=>calls.push(['visual.close'])},
    nextFrame:async()=>calls.push(['commit.frame']),slidOut:()=>[],currentBase:()=>'/portrait',shownSource:()=>'/lobby',
    shownLeft:null,shownKey:null,leftKey:part=>part,renderAll:async()=>calls.push(['detail.render']),
    disposePortrait:()=>calls.push(['portrait.dispose']),showExit:()=>{},thumb:async()=>'/default.png',settleImages:async()=>calls.push(['detail.ready']),
    layouts:{list:playbackFixture},TEXTURES:{'svg:stop':'native stop icon'},clone:node=>JSON.parse(JSON.stringify(node)),
    find:(root,path)=>path.split('/').reduce((node,name)=>node?.children?.find(child=>child.name===name),root),
    thumbnailWork:{thumb:(...args)=>{calls.push(['thumbnail',...args]);return Promise.resolve('/face.png');}}};
  env.setFullscreen=async on=>{calls.push(['fullscreen',on]);env.fullscreen=on;if(!on)await env.bridge.release();};
  vm.runInNewContext(code+'\nglobalThis.bridge=photoBridge;',env);
  return {env,calls,nodes,bridge:env.bridge};
}
test('preloads both modes once and switches without opening or rendering the detail page',async()=>{
  const h=harness();
  await h.bridge.full('portrait');await h.bridge.full('lobby');await h.bridge.full('portrait');await h.bridge.full('lobby');
  assert.equal(h.env.tab,'lobby');
  assert.equal(h.calls.filter(([x])=>x==='lobby.show').length,1);
  assert.equal(h.calls.filter(([x])=>x==='detail.render').length,0);
  assert.equal(h.calls.filter(([x])=>x==='visual.close'||x==='portrait.dispose'||x==='lobby.hide').length,0);
  assert.equal(h.nodes.get('lobby').hidden,false);assert.equal(h.nodes.get('portrait').hidden,true);
});
test('a target mode cannot be published before its resources have loaded',async()=>{
  let ready;const loaded=new Promise(resolve=>ready=resolve),h=harness({show:()=>loaded});
  const switchTo=h.bridge.full('lobby');await Promise.resolve();await Promise.resolve();
  assert.equal(h.env.tab,'portrait');assert.ok(!h.calls.some(([name])=>name==='lobby.resume'));
  ready({});await switchTo;assert.equal(h.env.tab,'lobby');
});
test('a preload failure preserves the current mode and does not destroy its player',async()=>{
  const h=harness({show:()=>Promise.reject(new Error('Missing atlas'))});
  await assert.rejects(()=>h.bridge.full('lobby'),/Missing atlas/);
  assert.equal(h.env.tab,'portrait');assert.ok(!h.calls.some(([name])=>name==='portrait.dispose'||name==='visual.close'));
});
test('leaving the fullscreen session releases the inactive mode once',async()=>{
  const h=harness();await h.bridge.full('lobby');await h.bridge.leave();await h.bridge.release();await h.bridge.release();
  assert.equal(h.calls.filter(([name])=>name==='portrait.dispose').length,1);
  assert.equal(h.calls.filter(([name])=>name==='visual.close').length,1);
  assert.equal(h.calls.filter(([name])=>name==='lobby.hide').length,0);
});
test('camera Back returns to the ready detail page instead of a full lobby without navigation',async()=>{
  const h=harness();await h.bridge.full('lobby');await h.bridge.leave();
  assert.equal(h.env.fullscreen,false);assert.equal(h.env.shownLeft,'lobby');
  assert.equal(h.nodes.get('lobby').hidden,false);assert.equal(h.nodes.get('lobby').style.visibility,'');
  assert.equal(h.calls.filter(([name])=>name==='detail.ready').length,1);
  assert.ok(h.calls.some(([name,on])=>name==='fullscreen'&&on===false));
});
test('memorial playback works from the real cropped detail root while the intro is pending',()=>{
  const h=harness();h.env.Lobby.introPending=()=>true;
  assert.equal(h.env.layouts.list.name,'Inventory_ListControl');
  const paused=h.bridge.playbackTree(true),playing=h.bridge.playbackTree(false);
  assert.equal(paused.tree.name,'PhotoPlayback');assert.equal(paused.tree.children[0].widgets[0].sprite,'Common_Icon_Play');
  assert.equal(playing.tree.children[0].widgets[0].texture,'svg:stop');
  assert.equal(h.env.find(h.env.layouts.list,'LeftInfo/CharInfo/Char_Target/Char_ZoomBtn').name,'Char_ZoomBtn');
});
test('expression previews reuse the detail face renderer and request each expression once',async()=>{
  const h=harness();
  await h.bridge.expressionPreview('01');await h.bridge.expressionPreview('01');await h.bridge.expressionPreview('02');
  const requests=h.calls.filter(([name])=>name==='thumbnail');
  assert.equal(requests.length,2);assert.deepEqual(requests[0],['thumbnail','/portrait','face','01']);
});
test('default thumbnail is the student collection portrait',async()=>{
  const h=harness();h.env.variant=()=>({portrait:'/Student_Portrait_Cycling_Collection.png',spr:'cycling_spr'});
  assert.equal(await h.bridge.defaultThumbnail(),'/Student_Portrait_Cycling_Collection.png');
});
