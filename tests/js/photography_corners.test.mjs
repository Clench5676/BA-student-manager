import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { bindCorner, CORNER_MARGIN } from '../../src/ba_modding_toolkit/web/js/corner-layout.js';
import { headerGeometry } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
import { FRAME, OCCLUSION_BUTTON, TOOLBAR_CAPTION } from '../../src/ba_modding_toolkit/web/js/photography/camera.js';
import { visualPrefab } from './visual_prefabs.mjs';
import { n, spr } from './control_prefabs.mjs';

const S = 1920 / 2960, near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const source = readFileSync(new URL('../../src/ba_modding_toolkit/web/js/photography/controller.js', import.meta.url), 'utf8');
const code = source.match(/^const CHOICE_ICONS=.*$/m)[0] + '\n' + source.slice(source.indexOf('let whiteTemplate;'), source.indexOf('export function attach'))
  + source.slice(source.indexOf('async function modeButton('), source.indexOf('async function choicePanel('))
  + source.slice(source.indexOf('async function drawControls('), source.indexOf('async function capture('));
class Element {
  style = {}; dataset = {}; children = []; isConnected = true;
  append(child) { child.parentElement = this; this.children.push(child); }
  get childNodes() { return this.children; }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
  getContext() { return { font: '', measureText(text) { const fs = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 16);
    return { width: [...text].reduce((w, c) => w + fs * (/[\u2e80-\u9fff\u3000-\u30ff\uac00-\ud7af\u0e00-\u0e7f]/.test(c) ? 1 : .55), 0),
      actualBoundingBoxAscent: .75 * fs, actualBoundingBoxDescent: .2 * fs, fontBoundingBoxAscent: 1.16 * fs, fontBoundingBoxDescent: .29 * fs }; } }; }
}
const find = (tree, path) => path.split('/').reduce((node, key) => node?.children?.find(child => child.name === key), tree);
function render(tree, host, { scale = S, origin = [960, 540] } = {}) {
  const nodes = new Map();
  function walk(node, x = 0, y = 0, path = '') {
    x += node.pos[0]; y += node.pos[1]; path = path ? `${path}/${node.name}` : node.name;
    const entry = { els: [] }; nodes.set(path, entry);
    for (const w of node.widgets || []) if (w.w_) {
      const el = new Element();
      Object.assign(el.style, { left: `${origin[0] + (x - w.w_ / 2) * scale}px`, top: `${origin[1] - (y + w.h_ / 2) * scale}px`,
        width: `${w.w_ * scale}px`, height: `${w.h_ * scale}px`, fontSize: `${(w.fontSize || 38) * scale}px` });
      entry.els.push(el); host.append(el);
    }
    for (const child of node.children || []) walk(child, x, y, path);
  }
  walk(tree); return Promise.resolve({ nodes });
}
const back = n('Btn', [0, 0], [], [n('Btn', [0, 0], [spr('Common_Circle_Back_Btn', 164, 172)])]);
const loop = n('Able_Count', [0, 0], [], [n('Bg', [0, 0], [spr('Common_Bg_Raius5px_Shadow', 156, 104)]), n('Icon', [0, 0], [spr('Common_Icon_Change_Count', 116, 84)])]);
const layouts = { UICharacterVisualMode: visualPrefab(),
  UICharacterCollection: n('UICharacterCollection', [0, 0], [], [n('SeletControl', [0, 0], [], [n('Top', [0, 0], [], [n('BG_W', [0, 0], [], [n('Bg', [0, 0], [], [back])])])])]),
  UILobby: n('UILobby', [0, 0], [], [n('Front', [0, 0], [], [n('Right', [0, 0], [], [n('Btn_RotateSpine', [0, 0], [], [n('ConditionRoot', [0, 0], [], [loop])])])])]) };
globalThis.document = { createElement: () => new Element(), documentElement: { lang: 'en-US' } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const NGUI = await import('../../src/ba_modding_toolkit/web/js/ngui.js');

for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH']) for (const mode of ['portrait', 'lobby']) {
  test(`real ${mode} camera controls retain prefab dimensions and fit at all corner margins in ${locale}`, async () => {
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui.photo;
    for (const platform of [null, 'darwin', 'win32']) for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440]]) {
      const scale = width / 1920, header = headerGeometry(width, height, platform === 'win32' ? 40 : 0, true);
      const doc = { createElement: () => new Element(), documentElement: { lang: locale },
        getElementById: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) }) };
      Object.assign(globalThis, { document: doc, innerWidth: width, innerHeight: height, bamtHeaderGeometry: platform ? header : null,
        bamtWindowChrome: platform ? { active: true, platform, bounds: platform === 'darwin'
          ? { left: 12, right: 80, top: 8, bottom: 30 } : { left: width - 148, right: width, top: 8, bottom: 40 } } : null });
      const hits = new Map(), overlay = new Element();
      const env = { S, FRAME, OCCLUSION_BUTTON, TOOLBAR_CAPTION, document: doc, mode, overlay, active: true,
        controlsRevision: 0, grid: true, occlusion: false, expanded: false, paused: false, saving: false,
        P: key => strings[key], clone: structuredClone, safe: fn => fn, alignIcon: async () => {}, bindCorner,
        buttonCenter: async el => ({ x: parseFloat(el.style.left) + parseFloat(el.style.width) / 2, y: parseFloat(el.style.top) + parseFloat(el.style.height) / 2 }),
        NGUI: { ...NGUI, find, render, layout: async name => layouts[name] },
        node: (name, widgets, children = []) => n(name, [0, 0], widgets, children),
        hitButton(host, box, action, label) { const hit = new Element(); hit.box = [...box]; hit.label = label; host.append(hit);
          const dataset = {}; Object.defineProperty(hit, 'dataset', { value: new Proxy(dataset, { set(target, key, value) { target[key] = value; if (key === 'photoAction') hits.set(value, hit); return true; } }) }); return hit; },
        panSurface() {}, shutter: async () => {}, openGallery() {}, leave() {}, switchMode() {},
        bridge: { playbackTree: () => ({ tree: n('PhotoPlayback', [0, 0], [spr('Common_Bg_Raius5px_Shadow', 145, 141)]), textures: {} }) } };
      vm.runInNewContext(`${code}\nglobalThis.draw = drawControls;`, env);
      await env.draw();
      const rect = name => { const hit = hits.get(name); assert.ok(hit, name);
        const [dx, dy] = hit.parentElement.style.translate.split(' ').map(parseFloat);
        return [hit.box[0] + dx, hit.box[1] + dy, hit.box[2], hit.box[3]]; };
      const b = rect('Back'), rotate = rect('Mode'), guide = rect('Occlusion'), grid = rect('Grid'), gallery = rect('Gallery'), choices = rect('Choices');
      near(b[0], CORNER_MARGIN); near(b[1], CORNER_MARGIN + (platform === 'darwin' ? header.rowHeight / scale : 0));
      near(b[2], 164 * S); near(b[3], 172 * S); assert.equal(hits.get('Back').label, strings.back);
      near(1920 - rotate[0] - rotate[2], CORNER_MARGIN);
      near(rotate[1], CORNER_MARGIN + (platform === 'win32' ? header.rowHeight / scale : 0));
      near(guide[1], rotate[1]); near(grid[1], rotate[1]); near(grid[0] - guide[0] - guide[2], 22); near(rotate[0] - grid[0] - grid[2], 22);
      near(guide[2], 196); near(grid[3], 76); near(rotate[2], 102);
      near(gallery[0], CORNER_MARGIN); near(1080 - gallery[1] - gallery[3], CORNER_MARGIN);
      near(1920 - choices[0] - choices[2], CORNER_MARGIN); near(1080 - choices[1] - choices[3], CORNER_MARGIN);
      if (mode === 'lobby') { const playback = rect('Playback'); near(choices[0] - playback[0] - playback[2], 20); near(playback[1], choices[1]); }
      for (const density of [1, 2, 3]) for (const name of hits.keys()) {
        const [x, y, w, h] = rect(name); assert.ok(x * scale * density >= 0 && (x + w) * scale * density <= width * density);
        assert.ok(y * scale * density >= 0 && (y + h) * scale * density <= height * density);
      }
    }
  });
}
