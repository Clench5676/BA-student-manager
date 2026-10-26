import assert from "node:assert/strict";
import { test } from "node:test";
let epoch = "http-exports-v1";
globalThis.document = { documentElement: { lang: "en-US" }, querySelector: () => ({ content: epoch }),
  createElement: () => ({ getContext: () => ({}) }) };
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  // Model a browser entry still fresh under the old max-age policy.
  return { ok: true, json: async () => options?.cache === "no-cache"
    ? { effect: 3, effectColor: "#ffffff/1", effectDistance: [3, 3], gradient: ["#fa8c21", "#e6780e"] }
    : { effect: 3 } };
};
const { uiExportUrl } = await import("../../src/ba_modding_toolkit/web/js/api.js");
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
test("the bootstrap export epoch bypasses old fresh cache entries and is idempotent", () => {
  const first = uiExportUrl("/asset/ui/layout/Root.json?path=child");
  assert.equal(uiExportUrl(first), first); assert.match(first, /path=child.*export=http-exports-v1/);
  epoch = "next-schema";
  assert.notEqual(uiExportUrl("/asset/ui/layout/Root.json?path=child"), first);
  assert.equal(uiExportUrl("/asset/spine/mod/x/manifest.json"), "/asset/spine/mod/x/manifest.json");
});
test("layouts force HTTP validation instead of accepting the legacy fresh export", async () => {
  const layout = await NGUI.layout("CacheProof");
  assert.deepEqual(layout.effectDistance, [3, 3]); assert.equal(layout.gradient[0], "#fa8c21");
  assert.equal(calls.at(-1).options.cache, "no-cache"); assert.match(calls.at(-1).url, /export=next-schema/);
});

test('resource changes invalidate UI indexes and prefabs while late old responses cannot replace the new install', async (t) => {
  const pending = [];
  t.mock.method(globalThis, 'fetch', (url) => new Promise(resolve => pending.push({ url, resolve })));
  let changes = 0;
  const off = NGUI.onResourceChange(() => changes++);
  const atlas = name => ({ [name]: { Icon: { width: 10, height: 10 } } });
  const answer = (context, endpoint, value) => {
    const item = pending.find(p => p.url.includes(endpoint) && new URL(p.url, 'http://test').searchParams.get('resource') === context);
    assert.ok(item, `${context} ${endpoint}`);
    item.resolve({ ok: true, json: async () => value });
  };
  try {
    NGUI.setResourceContext('global-context');
    const old = NGUI.init();
    const oldLayout = assert.rejects(NGUI.layout('ServerProof'), { name: 'AbortError' });
    NGUI.setResourceContext('japan-context');
    const next = NGUI.init(), nextLayout = NGUI.layout('ServerProof');
    answer('japan-context', 'atlases.json', atlas('Japan'));
    answer('japan-context', 'textures.json', { JapanTexture: '/asset/ui/texture/Japan.png' });
    answer('japan-context', 'ServerProof.json', { name: 'JapanPrefab' });
    await next;
    assert.deepEqual(await nextLayout, { name: 'JapanPrefab' });
    answer('global-context', 'atlases.json', atlas('Global'));
    answer('global-context', 'textures.json', { GlobalTexture: '/asset/ui/texture/Global.png' });
    answer('global-context', 'ServerProof.json', { name: 'GlobalPrefab' });
    await old; await oldLayout;
    assert.deepEqual(Object.keys(NGUI.atlasIndex()), ['Japan']);
    assert.deepEqual(Object.keys(NGUI.textureIndex()), ['JapanTexture']);
    assert.deepEqual(await NGUI.layout('ServerProof'), { name: 'JapanPrefab' });
    assert.equal(NGUI.setResourceContext('japan-context'), false);
    assert.equal(changes, 2);
    assert.equal(pending.length, 6, 'the rejected old layout cannot evict the new cached layout');
  } finally { off(); }
});

test('identically named UI images are loaded again for the selected resource context', async (t) => {
  class Image {
    set src(url) { this.url = url; queueMicrotask(() => this.onload()); }
  }
  const originalImage = globalThis.Image;
  globalThis.Image = Image;
  t.after(() => { globalThis.Image = originalImage; });
  NGUI.setResourceContext('global-images');
  const first = await NGUI.load('/asset/ui/sprite/Common/Icon.png');
  assert.equal(await NGUI.load('/asset/ui/sprite/Common/Icon.png'), first);
  NGUI.setResourceContext('japan-images');
  const second = await NGUI.load('/asset/ui/sprite/Common/Icon.png');
  assert.notEqual(first, second);
  assert.match(first.url, /resource=global-images/);
  assert.match(second.url, /resource=japan-images/);
});
