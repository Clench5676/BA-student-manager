// The lobby-style bottom navigation and the top bar. The entries are nav-items.js: one without a web screen is greyed
// out with the game's disabled tint and hands over to the classic GUI on its tab, through the hand-off prompt
// (decision 6: on every click, with Don't Ask Again, until the pref classicPrompt is turned off).
import * as Loading from "./loading.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { navigationEntry } from "./navigation-layout.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { ITEMS, activate, handOffPrompt, view } from "./nav-items.js";
import { $, S, clone, toast } from "./util.js";

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
    await activate(item, {
      prompt: options.prefs()?.classicPrompt !== false,
      go: (route) => { location.hash = route; },
      ask, open: openClassic, savePrompt,
    });
  } catch (err) {
    toast(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error" });
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
    skinTop().catch(console.error);
    const tree = clone(NGUI.find(lobby, "Front/Bottom/Menu/BG/BG")); tree.pos = [0, 0];
    await NGUI.render(tree, plate, { scale: S, origin: [960, 104 - 52 * S] });
  }
  await Promise.all(ITEMS.map(async (item, i) => {
    const v = view(item, T), b = document.createElement("button");
    b.className = `nav-item${v.greyed ? " greyed" : ""}`;
    b.setAttribute("aria-label", v.name);
    if (v.greyed) {
      b.setAttribute("aria-disabled", "true");
      b.dataset.tab = v.tab;
    } else if (i === active) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => click(item));
    next.appendChild(b);
    if (lobby) {
      const tree = navigationEntry(NGUI.find(lobby, "Front/Bottom/Menu/BG/Grid"), item, v.label, v.greyed, i);
      await NGUI.render(tree, b, { scale: S, origin: [130, 90] });
    } else b.textContent = v.label;
  }));
  if (revision !== navRevision) return;
  host.replaceChildren(...next.childNodes);
  document.querySelector(".nav-bar")?.replaceChildren(...plate.childNodes);
}

let topReady;
function skinTop() {
  return topReady ||= NGUI.layout("UICharacterCollection").then(async (collection) => {
    for (const [selector, path, w, h] of [
      [".topbar .back", "SeletControl/Top/BG_W/Bg/Btn", 164, 172],
      [".top-option", "NUITop_Scenes/Top/Right/Option", 60, 62],
    ]) {
      const host = document.querySelector(selector);
      if (!host) continue;
      const tree = clone(NGUI.find(collection, path)); tree.pos = [0, 0];
      const next = document.createElement("div");
      await NGUI.render(tree, next, { scale: S, origin: [w * S / 2, h * S / 2] });
      Object.assign(host.style, { width: `${w * S}px`, height: `${h * S}px` });
      host.replaceChildren(...next.childNodes);
    }
  }).catch((err) => { topReady = null; throw err; });
}

export function setTitle(text, onBack) {
  document.querySelector(".topbar .title").textContent = text;
  const back = document.querySelector(".topbar .back");
  back.onclick = onBack || null;
  back.style.visibility = onBack ? "visible" : "hidden";
}
