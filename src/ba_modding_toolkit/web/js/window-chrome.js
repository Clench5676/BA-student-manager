import { on, rpc } from "./api.js";
import { T } from "./i18n.js";
import { reflowTopActions } from "./nav.js";
import { alignTopBar } from "./top-bar.js";
import { fitStage } from "./util.js";
import { headerGeometry, rowLayout, subtractRegions, expandRect } from "./window-layout.js";

let snapshot = null, wrapper = null, placeholder = null, compact = false, scheduled = false, lastLayout = "";
let layoutRevision = 0;
const bar = () => document.querySelector('.topbar');
export const nativeChrome = () => snapshot?.active ? snapshot : null;

function fallbackControls() {
  const existing = document.getElementById('native-controls');
  if (snapshot?.active || !globalThis.pywebview) { existing?.remove(); return; }
  if (existing) {
    for (const button of existing.children) button.setAttribute('aria-label', T(`window.${button.dataset.action}`));
    return;
  }
  const controls = document.createElement('div'); controls.id = 'native-controls';
  for (const [action, icon] of [['minimize', '−'], ['maximize', '□'], ['close', '×']]) {
    const button = document.createElement('button'); button.textContent = icon; button.dataset.action = action;
    button.setAttribute('aria-label', T(`window.${action}`));
    button.addEventListener('click', () => rpc('window.control', { action }).catch(console.error)); controls.append(button);
  }
  document.body.append(controls);
}

function accept(next) {
  if (snapshot && (next.sequence || 0) < (snapshot.sequence || 0)) return;
  snapshot = next;
  globalThis.bamtWindowChrome = nativeChrome();
  fallbackControls(); schedule();
}

function schedule() {
  ++layoutRevision;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; layout().catch(console.error); });
}

function fitRow(header, scale, nativeLeft = 0) {
  const title = header.querySelector('.title'), mods = header.querySelector('.mod-switch'), label = mods?.querySelector('.ms-label');
  const option = header.querySelector('.top-option').getBoundingClientRect();
  // Natural text widths must not depend on the last ellipsis or hidden caption.
  const measure = (element) => {
    const style = getComputedStyle(element), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return (ctx.measureText(element.textContent).width + Math.max(0, element.textContent.length - 1) * (parseFloat(style.letterSpacing) || 0)) * scale;
  };
  const captionWidth = label ? measure(label) + 12 * scale : 0;
  const fixedMods = mods && !mods.hidden ? [...mods.children].filter((el) => el !== label)
    .reduce((width, el) => width + el.getBoundingClientRect().width, 12 * scale) : 0;
  const row = rowLayout({ scale, nativeLeft, rightStart: option.left - header.getBoundingClientRect().left,
    titleWidth: measure(title), modsWidth: fixedMods + captionWidth, captionWidth, compact, modsVisible: !!mods && !mods.hidden });
  compact = row.compact;
  header.style.setProperty('--native-left', `${row.shift / scale}px`);
  header.classList.toggle('mods-compact', compact);
  title.style.maxWidth = `${row.titleWidth / scale}px`;
  title.setAttribute('aria-label', title.textContent);
  if (label) mods.querySelector('[role="switch"]')?.setAttribute('aria-label', label.textContent);
}

async function layout() {
  const revision = layoutRevision;
  fallbackControls();
  const header = bar(), stage = document.getElementById('stage');
  if (!header || !stage) return;
  if (!snapshot?.active) {
    if (wrapper) {
      placeholder.replaceWith(header); wrapper.remove(); wrapper = placeholder = null;
      header.style.removeProperty('width'); header.style.removeProperty('height'); header.style.removeProperty('transform');
      header.style.removeProperty('--native-left'); header.inert = false;
      header.querySelector('.title').style.removeProperty('max-width');
      header.classList.remove('mods-compact', 'chrome-waiting', 'native-toolbar');
    }
    document.body.classList.remove('native-chrome', 'window-immersive');
    globalThis.bamtHeaderGeometry = null; fitStage(); reflowTopActions();
    fitRow(header, stage.getBoundingClientRect().width / 1920);
    await alignTopBar();
    return;
  }
  if (!wrapper) {
    placeholder = document.createComment('window toolbar'); header.before(placeholder);
    wrapper = document.createElement('div'); wrapper.className = 'window-header';
    document.body.append(wrapper); wrapper.append(header); header.classList.add('native-toolbar'); document.body.classList.add('native-chrome');
  }
  const immersive = stage.classList.contains('fullscreen') || stage.classList.contains('hall-fullscreen');
  document.body.classList.toggle('window-immersive', immersive);
  const g = headerGeometry(innerWidth, innerHeight, snapshot.platform === 'win32' ? snapshot.bounds?.bottom || 0 : 0);
  globalThis.bamtHeaderGeometry = g;
  wrapper.style.height = `${g.rowHeight}px`;
  Object.assign(header.style, { width: `${innerWidth / g.scale}px`, height: `${g.rowHeight / g.scale}px`, transform: `scale(${g.scale})` });
  header.classList.toggle('chrome-waiting', !snapshot.valid);
  // Hall/detail hold their own inert/focus state. Only add a temporary measurement guard.
  if (!immersive) header.inert = !snapshot.valid;
  fitStage(); reflowTopActions();
  fitRow(header, g.scale, snapshot.platform === 'darwin' ? snapshot.bounds?.right || 0 : 0);
  await alignTopBar();
  if (revision !== layoutRevision || !snapshot?.active || !wrapper) return;
  // Native regions never cover popups or hanging Back art. During page immersion
  // only the small game background strip and the real window controls remain.
  const blocked = [...document.querySelectorAll('.consent-host, .popup-host')].some((el) => !el.hidden && el.getClientRects().length);
  header.inert = !snapshot.valid || immersive || blocked;
  const exclusions = immersive ? [] : [...header.querySelectorAll('button, .mod-switch')]
    .filter((el) => !el.hidden && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length)
    .map((el) => expandRect(el.getBoundingClientRect()));
  if (snapshot.bounds) exclusions.push(expandRect(snapshot.bounds, 8));
  const drag = blocked || !snapshot.valid ? [] : subtractRegions({ left: 0, top: 0, right: innerWidth, bottom: g.rowHeight }, exclusions);
  wrapper.querySelectorAll('.window-drag-region').forEach((el) => el.remove());
  if (snapshot.platform === 'win32') for (const rect of drag) {
    const region = document.createElement('div'); region.className = 'window-drag-region';
    Object.assign(region.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
    wrapper.append(region);
  }
  const payload = JSON.stringify({ centre: g.centre, height: g.rowHeight, drag });
  if (payload !== lastLayout) { lastLayout = payload; await rpc('window.layout', JSON.parse(payload)); }
}

export function setupWindowChrome() {
  on('window.chrome', accept);
  rpc('window.chrome').then(accept).catch(console.error);
  fallbackControls();
  addEventListener('pywebviewready', () => { fallbackControls(); rpc('window.chrome').then(accept).catch(console.error); }, { once: true });
  addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  new MutationObserver(schedule).observe(document.getElementById('stage'), { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class'] });
  // The header leaves the stage only on active native hosts.
  new MutationObserver(schedule).observe(bar(), { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['hidden'] });
}
