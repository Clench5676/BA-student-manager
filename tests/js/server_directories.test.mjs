import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { controls } from './control_prefabs.mjs';

const web = new URL('../../src/ba_modding_toolkit/web/js/', import.meta.url);
const source = readFileSync(new URL('settings.js', web), 'utf8');
const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH'];
const strip = s => s.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
class El {
  style = {}; children = []; lang = '';
  appendChild(el) { this.children.push(el); }
  remove() {}
  getContext() { return { font: '', measureText(s) {
    const fs = Number(this.font.match(/([\d.]+)px/)?.[1] || 40);
    return { width: [...s].reduce((w, c) => w + (/\s/.test(c) ? .3 : c.charCodeAt(0) < 128 ? .58 : 1) * fs, 0) };
  } }; }
}
const original = globalThis.document;
globalThis.document = { documentElement: new El(), createElement: () => new El() };
const NGUI = await import(new URL('ngui.js', web));
const { wrapPath, S } = await import(new URL('util.js', web));
const { rowBase, radioRow } = await import(new URL('settings-rows.js', web));
const ButtonsModule = await import(new URL('game-buttons.js', web));
const { option, filter } = controls();
const Buttons = { smallButton: (...args) => ButtonsModule.optionButton(option, filter, ...args) };

function harness(locale, { native = true, sourceValue = 'windows_global', error = null, pathLength = 1 } = {}) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), 'utf8')).webui;
  const T = (key, values = {}) => key.split('.').reduce((v, k) => v[k], strings).replace(/\{(\w+)\}/g, (_, k) => values[k]);
  const prefs = { fileSource: sourceValue, gameDirs: { global: '/test/global/'.repeat(pathLength), japan: '/test/japan/'.repeat(pathLength) }, native, libraryDir: '/test/library', outputDir: '/test/output' };
  const requests = [], messages = [], failures = [], changed = [];
  const deps = { NGUI, T, wrapPath, S, rowBase, radioRow, Buttons, platform: 'mac',
    notify: (...args) => failures.push(args), Popup: { message: async options => messages.push(options) },
    rpc: async (method, args) => {
      requests.push([method, args]);
      if (error && method === 'settings.set') throw error;
      if (method === 'settings.detectGame') return [`/detected/${args.region}`];
      if (method === 'settings.pickFolder') return `/chosen${args.start}`;
      return prefs;
    },
  };
  const api = new Function('deps', 'initial', `const {${Object.keys(deps)}} = deps; ${strip(source)};
    prefs=initial;tab='folders';onChange=async(...args)=>deps.changed.push(args);render=async()=>{};
    return {rows, set, current};` )({ ...deps, changed }, prefs);
  return { ...api, prefs, requests, messages, failures, changed, T };
}

for (const locale of locales) {
  test(`${locale}: both server rows are visible and every choose/detect action targets its own server`, async () => {
    for (const sourceValue of ['windows_global', 'windows_japan']) {
      const h = harness(locale, { sourceValue });
      const { rows } = h.rows();
      assert.deepEqual(rows.map(r => r.tree.name), ['Server', 'Game_global', 'Game_japan', 'Library', 'Output']);
      for (const region of ['global', 'japan']) {
        const row = rows.find(r => r.tree.name === `Game_${region}`);
        assert.equal(NGUI.find(row.tree, 'Title').widgets[0].text, h.T(`settings.gameDirLabel.${region}`));
        await row.hits[0].fn(); await row.hits[1].fn();
        assert.ok(h.requests.some(([method, p]) => method === 'settings.detectGame' && p.region === region));
        assert.ok(h.requests.some(([method, p]) => method === 'settings.pickFolder' && p.start === h.prefs.gameDirs[region]));
        assert.ok(h.requests.some(([method, p]) => method === 'settings.set' && p.key === `gameDir.${region}` && p.value === `/detected/${region}`));
        assert.ok(h.requests.some(([method, p]) => method === 'settings.set' && p.key === `gameDir.${region}` && p.value === `/chosen${h.prefs.gameDirs[region]}`));
      }
      assert.deepEqual(h.failures, []);
    }
  });

  test(`${locale}: missing directory uses the notice caption and Confirm only, with no preference refresh`, async () => {
    for (const region of ['global', 'japan']) {
      const h = harness(locale, { error: { code: 'game_directory_missing', params: { region } } });
      await h.set('fileSource', `windows_${region}`);
      assert.deepEqual(h.messages, [{ title: h.T('quit.title'), lines: [h.T(`settings.gameDirMissing.${region}`)], ok: h.T('picker.ok') }]);
      assert.deepEqual(h.failures, []);
      assert.deepEqual(h.changed, []);
      assert.equal(h.current(), h.prefs);
      if (locale === 'zh-CN') assert.equal(h.messages[0].lines[0], region === 'japan' ? '未设置日服游戏目录' : '未设置国际服游戏目录');
    }
    const h = harness(locale, { error: { code: 'busy', params: {} } });
    await h.set('fileSource', 'windows_japan');
    assert.equal(h.messages.length, 0);
    assert.equal(h.failures[0][1].kind, 'error');
  });

  test(`${locale}: folder row geometry stays within the native scrolling panel at narrow and wide window scales`, () => {
    globalThis.document.documentElement.lang = locale;
    for (const pathLength of [1, 80]) {
      const h = harness(locale, { pathLength });
      const { rows, height } = h.rows();
      let previousBottom = 0;
      for (const { tree, h: rowHeight } of rows) {
        const top = -tree.pos[1] - rowHeight / 2, bottom = top + rowHeight;
        assert.ok(top >= previousBottom + 19 && bottom <= height);
        previousBottom = bottom;
        if (!tree.name.startsWith('Game_')) continue;
        const value = NGUI.find(tree, 'Value'), widget = value.widgets[0];
        const title = NGUI.find(tree, 'Title').widgets[0];
        assert.ok(NGUI.glyphWidth(title.text, title.fontSize) <= title.w_);
        assert.ok(title.fontSize >= 40 && title.fontSize <= 50);
        assert.ok(widget.fontSize >= 30 && widget.fontSize <= 38);
        assert.ok(widget.text.split('\n').every(line => NGUI.glyphWidth(line, widget.fontSize) <= widget.w_));
        const valueTop = value.pos[1] + widget.h_ / 2, valueBottom = value.pos[1] - widget.h_ / 2;
        assert.ok(valueTop <= rowHeight / 2 - 109 && valueBottom > -rowHeight / 2);
        const buttons = [NGUI.find(tree, 'Btn_0'), NGUI.find(tree, 'Btn_1')];
        const labels = buttons.map(b => NGUI.find(b, 'Label_Locale').widgets[0]);
        assert.equal(labels[0].fontSize, labels[1].fontSize);
        buttons.forEach((button, i) => {
          const body = button.widgets.find(w => w.sprite === 'Common_Btn_BG');
          assert.ok(body, 'UIPopup_Option_PC ETCSetting/ButtonBg body');
          const [x, y] = button.pos;
          assert.ok(value.pos[0] + widget.w_ < x - body.w_ / 2);
          assert.ok(x + body.w_ / 2 < 1552 / 2);
          assert.ok(y + body.h_ / 2 <= rowHeight / 2 - 109 && y - body.h_ / 2 >= -rowHeight / 2);
          assert.ok(labels[i].text.split('\n').every(line => NGUI.glyphWidth(line, labels[i].fontSize) <= labels[i].w_));
          assert.ok(labels[i].fontSize >= 30 && labels[i].fontSize <= 44);
        });
        assert.ok(buttons[0].pos[0] + 150 < buttons[1].pos[0] - 150);
        for (const [width, windowHeight] of [[640, 480], [960, 540], [1920, 1080], [2560, 1440]]) {
          const scale = Math.min(width / 1920, windowHeight / 1080);
          const panelTop = (540 - 375 * S) * scale, panelBottom = panelTop + 854 * S * scale;
          assert.ok(panelTop >= 0 && panelBottom <= windowHeight);
          const scrollMax = Math.max(0, height - 854);
          const controlBottom = (bottom - scrollMax) * S * scale + panelTop;
          assert.ok(controlBottom <= panelBottom, 'last row reachable by scrolling');
        }
      }
    }
    assert.match(source, /NGUI\.layout\("UIPopup_Option_PC"\)/);
    assert.match(source, /Math\.max\(CONTENT\.h, height\)/);
    assert.match(source, /scrollTop = scroll/);
  });
}

test('browser mode offers detection for both directories and omits native picker hit targets', () => {
  const h = harness('en-US', { native: false });
  for (const row of h.rows().rows.filter(r => r.tree.name.startsWith('Game_'))) assert.equal(row.hits.length, 1);
});
