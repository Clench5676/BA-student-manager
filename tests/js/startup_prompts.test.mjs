import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../../src/ba_modding_toolkit/web/js/prompts.js', import.meta.url), 'utf8');
const lifecycle = source.slice(source.indexOf('const shown = { drift:'), source.indexOf('async function cardsOf(')).replace(/^export /gm, '');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };

function harness({ scanned = false } = {}) {
  const state = { scan: true, scanned, enabled: true }, events = new Map(), offers = [], calls = [];
  let entries = [], idle = Promise.resolve(), priority = Promise.resolve(), afterRefresh = () => {};
  const env = {
    ModSwitch: { current: () => state, refresh: async () => { afterRefresh(); return { ...state }; },
      setDriftPrompt() {}, startDue: (which, { entries }) => entries.some(e => e.state === which) },
    on: (type, fn) => events.set(type, fn), rpc: async (method) => { calls.push(method); return entries; },
    Popup: { whenIdle: () => idle }, console,
    promptEntries: (entries, which) => ({ listed: entries.filter(e => e.state === which) }),
    entryKey: e => e.core, fresh: (list, shown) => list.some(e => !shown.has(`${e.core}|${e.state}`)),
    driftPrompt: async () => { offers.push('drift'); await priority; },
    untrackedPrompt: async () => { offers.push('untracked'); await priority; },
  };
  const api = new Function('env', `let { ${Object.keys(env).join(', ')} } = env; let names;
    ${lifecycle} return { init, start, later, isBusy };`)(env);
  api.init();
  return { ...api, state, events, calls, offers, setEntries: value => { entries = value; },
    setIdle: value => { idle = value; }, setPriority: value => { priority = value; },
    afterRefresh: fn => { afterRefresh = fn; } };
}

test('an unfinished startup scan does not delay the tour sequence or read stale entries', async () => {
  const h = harness();
  h.setEntries([{ core: 'old', state: 'drift' }]);
  await h.start('drift', {}); await h.start('untracked', {}); await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.offers, []);
});

test('scan results already available at startup keep dialog priority until dismissed', async () => {
  const h = harness({ scanned: true }), priority = deferred();
  h.setEntries([{ core: 'one', state: 'drift' }, { core: 'two', state: 'untracked' }]);
  h.setPriority(priority.promise);
  let complete = false;
  const startup = (async () => { await h.start('drift', {}); await h.start('untracked', {}); complete = true; })();
  await flush();
  assert.deepEqual(h.offers, ['drift']); assert.equal(complete, false); assert.equal(h.isBusy(), true);
  priority.resolve(); await startup; await flush();
  assert.deepEqual(h.offers, ['drift', 'untracked']);
  assert.equal(h.isBusy(), false);
});

test('a late scan queues its prompts behind the tour or another open dialog', async () => {
  const h = harness(), idle = deferred();
  await h.start('drift', {}); await h.start('untracked', {}); await flush();
  h.setIdle(idle.promise);
  h.state.scanned = true; h.setEntries([{ core: 'one', state: 'untracked' }]);
  h.events.get('library.scanned')(); await flush();
  assert.deepEqual(h.offers, []);
  idle.resolve(); await flush();
  assert.deepEqual(h.offers, ['untracked']);
});

test('a scan published between startup steps is caught even before late prompts are enabled', async () => {
  const h = harness();
  await h.start('drift', {});
  h.afterRefresh(() => {
    queueMicrotask(() => {
      h.state.scanned = true; h.setEntries([{ core: 'one', state: 'drift' }]);
      h.events.get('library.scanned')();
    });
  });
  await h.start('untracked', {}); await flush();
  assert.deepEqual(h.offers, ['drift']);
});

test('a dialog opened during the scan RPC still takes priority over a late prompt', async () => {
  const h = harness({ scanned: true }), idle = deferred();
  await h.start('untracked', {}); await flush();
  h.setEntries([{ core: 'one', state: 'untracked' }]);
  h.afterRefresh(() => { h.setIdle(idle.promise); });
  const pending = h.later(); await flush();
  assert.deepEqual(h.offers, []);
  idle.resolve(); await pending;
  assert.deepEqual(h.offers, ['untracked']);
});
