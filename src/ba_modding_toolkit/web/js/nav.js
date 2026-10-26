import {topActionLayout,nativeRightClearance} from "./top-action-layout.js";
import { CORNER_MARGIN } from "./corner-layout.js";
import { sizeTitle, watchTopBar } from "./top-bar.js";
// The lobby-style bottom navigation and the top bar. The entries are nav-items.js: one without a web screen is greyed
// out with the game's disabled tint and hands over to the classic GUI on its tab, through the hand-off prompt
// (decision 6: on every click, with Don't Ask Again, until the pref classicPrompt is turned off).
import { notify } from "./popup.js";
import * as Loading from "./loading.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { navigationEntry, navigationOrigin } from "./navigation-layout.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { ITEMS, activate, handOffPrompt, view } from "./nav-items.js";
import { $, S, clone } from "./util.js";

const CLASSIC_WAIT = 32000; // the classic UI's start: app.openClassic waits up to 30 s for its window
let options = { game: false, prefs: () => null, setPrefs: () => {} };
let opening = false;

// the hand-off prompt (drawn plain without a game folder: the classic UI works without one)
const ask = (item) => Popup.message(handOffPrompt(item, T));

// hands over to the classic UI on a tab; the corner indicator until its window is up (or it failed)
async function openClassic(tab) {
  const call = rpc("app.openClassic", { tab });
  await Loading.wait(call.catch(() => null), { label: T("classic.opening"), cap: CLASSIC_WAIT });
  await call;
}

async function savePrompt(value) {
  const prefs = await rpc("settings.set", { key: "classicPrompt", value });
  options.setPrefs(prefs);
}

async function click(item) {
  if (opening) return; // one hand-off at a time
  opening = true;
  try {
    if (await options.canLeave?.() === false) return;
    await activate(item, {
      prompt: options.prefs()?.classicPrompt !== false,
      go: (route) => { location.hash = route; },
      ask, open: openClassic, savePrompt,
    });
  } catch (err) {
    notify(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error", error: err });
  } finally {
    opening = false;
  }
}

// renderNav(active, {game, prefs, setPrefs}): game, whether a game folder is found (the greyed look's source);
// prefs(), the settings as last read (settings.get); setPrefs(prefs), after the prompt turned itself off
let navRevision = 0;
export async function renderNav(active = 0, opts = {}) {
  options = { ...options, ...opts };
  const host = $("nav"), revision = ++navRevision;
  const next = document.createElement("div"), plate = document.createElement("div");
  let lobby = null;
  if (options.game) lobby = await NGUI.layout("UILobby").catch((err) => { console.warn("navigation layout", err); return null; });
  if (lobby) {
    await skinTop().catch((err) => console.warn("top bar layout", err));
    const tree = clone(NGUI.find(lobby, "Front/Bottom/Menu/BG/BG")); tree.pos = [0, 0];
    await NGUI.render(tree, plate, { scale: S, origin: [960, 104 - 52 * S] });
  }
  await Promise.all(ITEMS.map(async (item, i) => {
    const v = view(item, T), b = document.createElement("button");
    b.className = `nav-item${v.greyed ? " greyed" : ""}`;
    const width = 1820 / ITEMS.length;
    b.style.width = `${width}px`;
    b.setAttribute("aria-label", v.name);
    if (v.greyed) {
      b.setAttribute("aria-disabled", "true");
      b.dataset.tab = v.tab;
    } else if (i === active) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => click(item));
    next.appendChild(b);
    if (lobby) {
      const tree = navigationEntry(NGUI.find(lobby, "Front/Bottom/Menu/BG/Grid"), item, v.label, v.greyed, i, width);
      await NGUI.render(tree, b, { scale: S, origin: navigationOrigin(tree, S, width) });
    } else b.textContent = v.label;
  }));
  if (revision !== navRevision) return;
  host.replaceChildren(...next.childNodes);
  document.querySelector(".nav-bar")?.replaceChildren(...plate.childNodes);
}

let topReady,topHall=false,topAvailable=true;
const topBoxes={home:[CORNER_MARGIN,7,50,50],option:[CORNER_MARGIN+114,7,50,50],line:[CORNER_MARGIN+76,12,3,32]};
export function setTopActions(hall,available=true){
  topHall=hall;topAvailable=available;
  document.querySelector('.topbar')?.classList.toggle('hall-home',hall);
  const back=document.querySelector('.topbar .back');
  if(back)back.hidden=hall||!back.onclick;
  reflowTopActions();
}
export function reflowTopActions(){
  document.querySelector('.topbar')?.style.setProperty('--corner-margin', `${CORNER_MARGIN}px`);
  const stage=document.querySelector('.topbar')?.getBoundingClientRect?.() || document.getElementById('stage')?.getBoundingClientRect?.();
  const native=globalThis.bamtWindowChrome;
  const controls=native?.platform==='win32' ? native.bounds : document.getElementById('native-controls')?.getBoundingClientRect?.();
  const preliminary=topActionLayout(topBoxes,topHall);
  const scale=globalThis.bamtHeaderGeometry?.scale || document.getElementById('stage')?.getBoundingClientRect?.().width/1920;
  const boxes=topActionLayout(topBoxes,topHall,nativeRightClearance(stage,controls,preliminary.option,scale));
  for(const [key,selector] of [['home','.top-home'],['option','.top-option'],['line','.top-line']]){
    const host=document.querySelector(selector);if(!host)continue;
    const [right,top,width,height]=boxes[key];Object.assign(host.style,{right:`${right}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});
    if(key==='home')host.hidden=topHall||!topAvailable;
    if(key==='line')host.hidden=topHall;
  }
}
addEventListener('resize',reflowTopActions);
function skinTop() {
  return topReady ||= NGUI.layout("UICharacterCollection").then(async (collection) => {
    const right = "NUITop_Scenes/Top/Right";
    const home = NGUI.find(collection, `${right}/Lobby`);
    const homeWidget = home?.widgets?.find((w) => "sprite" in w);
    for (const [selector, path, w, h] of [
      [".topbar .back", "SeletControl/Top/BG_W/Bg/Btn", 164, 172],
      [".top-option", `${right}/Option`, 60, 62],
      [".top-home", `${right}/Lobby`, 62, 59],
      [".top-line", `${right}/Line (1)`, 4, 49],
    ]) {
      const host = document.querySelector(selector);
      if (!host) continue;
      const original = NGUI.find(collection, path);
      if (!original) continue;
      const tree = clone(original); tree.pos = [0, 0];
      const next = document.createElement("div");
      await NGUI.render(tree, next, { scale: S, origin: [w * S / 2, h * S / 2] });
      Object.assign(host.style, { width: `${w * S}px`, height: `${h * S}px` });
      if (path.startsWith(right) && homeWidget) {
        // Anchor the game's rightmost Home control; retain the prefab's sibling offsets and sizes.
        Object.assign(host.style, {
          right: `${CORNER_MARGIN + (home.pos[0] - original.pos[0] + (homeWidget.w_ - w) / 2) * S}px`,
          top: `${7 + (home.pos[1] - original.pos[1] + (homeWidget.h_ - h) / 2) * S}px`,
        });
      }
      if(path.startsWith(right)){
        const key=selector==='.top-home'?'home':selector==='.top-option'?'option':'line';
        topBoxes[key]=['right','top','width','height'].map(field=>parseFloat(host.style[field]));
      }
      host.replaceChildren(...next.childNodes);
    }
    reflowTopActions();
  }).catch((err) => { topReady = null; throw err; });
}

export function setTitle(text, onBack) {
  const title = document.querySelector(".topbar .title");
  title.textContent = text;
  sizeTitle(title);
  const back = document.querySelector(".topbar .back");
  back.onclick = onBack || null;
  back.hidden = topHall || !onBack;
}

// the bar's content stays centred on its fill whatever changes under it (top-bar.js)
watchTopBar();
// Prefabs and derived UI values belong to the selected installation.
NGUI.onResourceChange?.(() => { topReady = null; });
