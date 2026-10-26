import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/ba_modding_toolkit/web/js/detail.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('// fullscreen memorial lobby:'), source.indexOf('// the switch card\'s still'));
function harness(start, hasLobby = true) {
  const calls = [], nodes = new Map();
  const switchButton = { dataset: { visualAction: 'Btn_HideUI' }, focus() {} };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, classList: { add() {}, remove() {}, toggle: (...args) => calls.push(['class', ...args]) },
      replaceChildren() {}, querySelector: () => node('nav'), querySelectorAll: () => id === 'visual-ui' ? [switchButton] : [], addEventListener() {}, removeEventListener() {} });
    return nodes.get(id);
  };
  const selection = { skin: 'cycling', mod: false, source: 'configured portrait', expression: '02' };
  const env = { console, Promise, setTimeout: () => 0, clearTimeout() {}, tab: start, fullscreen: true, open: true,
    busy: false, photoSession: false, variantKey: selection.skin, selection,
    mainPlayer: { skeleton: {} }, layouts: { visual: {} }, $: node, stage: () => node('stage'),
    document: { querySelector: () => node('topbar') }, T: key => key,
    variant: () => ({ key: selection.skin }), previewAvailable: (_, kind) => kind !== 'lobby' || hasLobby,
    switchKindOf: part => part === 'portrait' ? 'spr' : part, detailViewport: () => ({ detail: true }),
    Loading: { held: () => false }, Photo: { visualEntry: async on => calls.push(['launcher', on]) },
    Lobby: { frame: value => calls.push(['lobby.frame', value]), interactive() {} }, modelLib: null,
    Visual: { close: options => calls.push(['visual.close', options]), uiOut() {}, uiBack: () => calls.push(['uiBack']),
      exitControl: async () => {}, prepareSwitch: async () => switchButton, prepare: async options => options,
      open: async options => { calls.push(['visual.open', options]); return true; } },
    renderAll: async () => calls.push(['renderAll']), renderLeft: async () => calls.push(['renderLeft']),
    changeInPlace: async work => { await work(); return true; }, stillAfterFullscreen() {}, photoBridge: { release: async () => {} } };
  vm.runInNewContext(`${code}\nglobalThis.switchView = switchFullscreenView; globalThis.back = () => setFullscreen(false);`, env);
  return { env, calls, selection };
}

for (const start of ['portrait', 'lobby']) test(`${start} switches directly and Back retains the selected preview state`, async () => {
  const { env, calls, selection } = harness(start), before = { ...selection };
  await env.switchView();
  assert.equal(env.tab, start === 'portrait' ? 'lobby' : 'portrait');
  const close = calls.find(([name]) => name === 'visual.close')[1];
  assert.equal(close.instant, true); assert.equal(close.restore, false);
  assert.ok(!calls.some(([name]) => name === 'uiBack'));
  assert.ok(!calls.some(([name, value]) => name === 'lobby.frame' && value === 'left'));
  const entry = calls.find(([name]) => name === 'visual.open');
  if (entry) assert.equal(entry[1].instant, true);
  assert.deepEqual(selection, before);
  await env.back();
  assert.equal(env.fullscreen, false);
  assert.ok(calls.some(([name]) => name === 'uiBack'));
  assert.deepEqual(selection, before);
});

test('a skin without a memorial lobby cannot switch', async () => {
  const { env, calls } = harness('portrait', false);
  await env.switchView();
  assert.equal(env.tab, 'portrait'); assert.deepEqual(calls, []);
});
