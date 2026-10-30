import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { easeScroll, installVerticalWheel, wheelScroller, windowsWheel } from '../../src/ba_modding_toolkit/web/js/horizontal-scroll.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const notch = (extra = {}) => ({ deltaY: 100, deltaX: 0, deltaMode: 0, wheelDeltaY: -120,
  preventDefault() { this.defaultPrevented = true; }, ...extra });

function fixture({ platform = 'Win32', reduced = false } = {}) {
  let now = 0, sequence = 0;
  const frames = new Map(), listeners = new Map(), motionListeners = new Map();
  const env = { navigator: { platform }, performance: { now: () => now },
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    matchMedia: () => ({ matches: reduced, addEventListener: (name, fn) => motionListeners.set(name, fn),
      removeEventListener: name => motionListeners.delete(name) }),
    getComputedStyle: area => area.style, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  const frame = (elapsed) => { now += elapsed; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); };
  return { env, frames, listeners, motionListeners, frame, setReduced: value => { reduced = value; } };
}

function virtual(options = {}) {
  const f = fixture(options);
  let position = options.position || 0, maximum = 1000, alive = true;
  const writes = [];
  const controller = wheelScroller({ read: () => position, write: value => { position = value; writes.push(value); },
    max: () => maximum, page: () => 400, scale: () => options.scale || 1, alive: () => alive }, f.env);
  return { ...f, ...controller, writes, position: () => position, setPosition: value => { position = value; },
    setMaximum: value => { maximum = value; }, detach: () => { alive = false; } };
}

test('easeScroll is bounded, monotonic and exact at both ends in either direction', () => {
  for (const [from, to] of [[0, 100], [900, 100], [40, 40]]) {
    assert.equal(easeScroll(from, to, -10), from);
    assert.equal(easeScroll(from, to, 180), to);
    assert.equal(easeScroll(from, to, 900), to);
    assert.equal(easeScroll(from, to, 0, 0), to);
    let previous = from;
    for (let elapsed = 0; elapsed <= 180; elapsed++) {
      const value = easeScroll(from, to, elapsed);
      assert.ok(value >= Math.min(from, to) && value <= Math.max(from, to));
      assert.ok(to >= from ? value >= previous : value <= previous);
      previous = value;
    }
  }
  near(easeScroll(0, 100, 90), 87.5);
});

test('Windows WebView2 notches are identified without taking trackpad, pinch or horizontal input', () => {
  for (const platform of ['Win32', 'Windows']) {
    for (const event of [notch(), notch({ deltaMode: 1, deltaY: 3 }), notch({ deltaMode: 2, deltaY: 1 })]) {
      assert.equal(windowsWheel(event, platform), true);
    }
    for (const event of [notch({ ctrlKey: true }), notch({ shiftKey: true }), notch({ defaultPrevented: true }),
      notch({ cancelable: false }),
      notch({ deltaX: 5 }), notch({ deltaY: 4, wheelDeltaY: -5 }), notch({ deltaY: 0 })]) {
      assert.equal(windowsWheel(event, platform), false);
    }
  }
  for (const platform of ['MacIntel', 'macOS', 'Linux x86_64', '']) assert.equal(windowsWheel(notch(), platform), false);
});

test('a virtual roster notch draws intermediate positions and ends at the same distance at 60 and 120 Hz', () => {
  for (const hz of [60, 120]) {
    const h = virtual(); const event = notch();
    assert.equal(h.wheel(event), true); assert.equal(event.defaultPrevented, true);
    assert.equal(h.position(), 0);
    h.frame(1000 / hz);
    assert.ok(h.position() > 0 && h.position() < 100);
    for (let i = 1; i < hz; i++) h.frame(1000 / hz);
    near(h.position(), 100); assert.equal(h.frames.size, 0);
  }
});

test('successive notches accumulate while reversing takes effect from the current position', () => {
  const h = virtual();
  h.wheel(notch()); h.frame(30); h.wheel(notch()); h.frame(180);
  near(h.position(), 200);
  h.wheel(notch()); h.frame(30);
  const before = h.position();
  h.wheel(notch({ deltaY: -100, wheelDeltaY: 120 })); h.frame(20);
  assert.ok(h.position() < before);
  h.frame(180); near(h.position(), before - 100);
});

for (const scale of [.5, 1, 1.5, 2]) test(`wheel pixels respect the stage scale ${scale} while line and page units stay logical`, () => {
  for (const [event, distance] of [[notch(), 100 / scale], [notch({ deltaMode: 1, deltaY: 3 }), 120],
    [notch({ deltaMode: 2, deltaY: 1 }), 400]]) {
    const h = virtual({ scale }); h.wheel(event); h.frame(180); near(h.position(), distance);
  }
});

test('limits, changing content height and external scrollbar movement cannot leave stale wheel motion', () => {
  const h = virtual({ position: 980 });
  h.wheel(notch()); h.frame(180); near(h.position(), 1000);
  assert.equal(h.wheel(notch()), false); assert.equal(h.frames.size, 0);
  h.wheel(notch({ deltaY: -100, wheelDeltaY: 120 })); h.setMaximum(500); h.frame(180); near(h.position(), 500);
  h.wheel(notch({ deltaY: -100, wheelDeltaY: 120 })); h.setPosition(0); h.frame(16);
  assert.equal(h.position(), 0); assert.equal(h.frames.size, 0);
});

test('macOS trackpad steps and their momentum are untouched, including wheel-like tail events', () => {
  const h = virtual({ platform: 'MacIntel' });
  for (const deltaY of [40, 37, 24, 16, 8, 4, 2, 1]) {
    const event = notch({ deltaY, wheelDeltaY: -3 * deltaY });
    assert.equal(h.wheel(event), false); assert.equal(event.defaultPrevented, undefined);
    assert.equal(h.frames.size, 0);
  }
});

test('reduced motion, an interrupted gesture and detached lists cancel pending frames', () => {
  for (const cancel of [h => h.setReduced(true), h => h.stop(), h => h.detach(),
    h => h.wheel(notch({ deltaY: 4, wheelDeltaY: -5 }))]) {
    const h = virtual(); h.wheel(notch()); h.frame(16); const before = h.position();
    cancel(h); h.frame(180); assert.equal(h.position(), before); assert.equal(h.frames.size, 0);
  }
  const h = virtual({ reduced: true }), event = notch();
  assert.equal(h.wheel(event), false); assert.equal(event.defaultPrevented, undefined);
});

function nativeFixture(options = {}) {
  const f = fixture(options), handlers = new Map();
  const root = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const dispose = installVerticalWheel(root, f.env);
  const area = (parent = root, extra = {}) => ({ parentElement: parent, isConnected: true, scrollTop: 0,
    clientHeight: 400, scrollHeight: 1400, style: { overflowY: 'auto' }, getClientRects: () => [1],
    getBoundingClientRect: () => ({ height: 400 }), ...extra });
  const send = target => { const event = notch({ target }); handlers.get('wheel')(event); return event; };
  return { ...f, root, handlers, dispose, area, send };
}

test('delegation smooths every dynamically inserted overflow list without per-screen hooks', () => {
  const h = nativeFixture();
  for (const className of ['display-rows settings-rows', 'settings-rows', 'popup-cards', 'import-list',
    'import-dialog-content', 'plain-message-lines', 'log-text', 'future-list']) {
    const area = h.area(h.root, { className });
    const child = { parentElement: area };
    assert.equal(h.send(child).defaultPrevented, true);
    h.frame(30); assert.ok(area.scrollTop > 0 && area.scrollTop < 100);
    h.frame(180); near(area.scrollTop, 100);
  }
  h.dispose(); assert.equal(h.handlers.size, 0); assert.equal(h.listeners.size, 0);
});

test('native nested lists consume one notch and chain at the edge unless the prefab list contains overscroll', () => {
  const h = nativeFixture(), outer = h.area(), inner = h.area(outer);
  h.send(inner); h.frame(180); near(inner.scrollTop, 100); near(outer.scrollTop, 0);
  inner.scrollTop = 1000; h.send(inner); h.frame(180); near(outer.scrollTop, 100);
  inner.style.overscrollBehaviorY = 'contain';
  assert.equal(h.send(inner).defaultPrevented, undefined); h.frame(180); near(outer.scrollTop, 100);
  h.dispose();
});

test('native horizontal lists, scene handlers, trackpads and reduced motion keep their own input', () => {
  const h = nativeFixture(), horizontal = h.area(h.root, { style: { overflowY: 'hidden' } });
  assert.equal(h.send(horizontal).defaultPrevented, undefined);
  const area = h.area();
  for (const extra of [{ defaultPrevented: true }, { ctrlKey: true }, { shiftKey: true }, { deltaX: 80 },
    { deltaY: 4, wheelDeltaY: -5 }]) {
    h.handlers.get('wheel')(notch({ target: area, ...extra })); assert.equal(h.frames.size, 0);
  }
  h.setReduced(true); assert.equal(h.send(area).defaultPrevented, undefined); h.dispose();
});

test('pointer, keyboard, blur, visibility and motion preference changes cancel native and virtual easing', () => {
  for (const type of ['pointerdown', 'keydown', 'visibilitychange', 'blur', 'change']) {
    const h = nativeFixture(), area = h.area(); h.send(area); h.frame(16); const before = area.scrollTop;
    (h.handlers.get(type) || h.listeners.get(type) || h.motionListeners.get(type))();
    h.frame(180); assert.equal(area.scrollTop, before); assert.equal(h.frames.size, 0); h.dispose();
  }
});

test('the roster uses the shared controller for its virtual position and cancels it on hide or rebuild', () => {
  const source = readFileSync(new URL('../../src/ba_modding_toolkit/web/js/roster.js', import.meta.url), 'utf8');
  assert.match(source, /wheelScroller\(\{ read: \(\) => view.scroll/);
  assert.match(source, /view.scroll = top; applyScroll\(\)/);
  assert.match(source, /if \(motion.wheel\(ev\)\) return;/);
  for (const name of ['relist', 'buildFrame', 'hide']) assert.match(source,
    new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{\\s*wheelMotion\\?\\.stop\\(\\);`));
  const main = readFileSync(new URL('../../src/ba_modding_toolkit/web/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /installVerticalWheel\(\);/);
});
