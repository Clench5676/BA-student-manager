// The lobby-style bottom navigation and the top bar. The entries are nav-items.js: one without a web screen is greyed
// out with the game's disabled tint and hands over to the classic GUI on its tab, through the hand-off prompt
// (decision 6: on every click, with Don't Ask Again, until the pref classicPrompt is turned off).
import * as Loading from "./loading.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, spriteUrl } from "./api.js";
import { T } from "./i18n.js";
import { ITEMS, activate, handOffPrompt, tintOf, view } from "./nav-items.js";
import { $, toast } from "./util.js";

// labels: 26 px, down to 18 px so they stay on one line in their 176 px slot
const navSize = (str) => { for (let fs = 26; fs > 18; fs -= 1) if (NGUI.textWidth(str, fs) / NGUI.fontSizeFor(str, 1) <= 172) return fs; return 18; };

const CLASSIC_WAIT = 32000; // the classic UI's start: app.openClassic waits up to 30 s for its window
let options = { game: false, prefs: () => null, setPrefs: () => {} };
let tint = null, opening = false;

// the greyed look: the tint of UILobby's locked entries, read once (nav-items.js tintOf); without a game, the plain
// one at once
function applyTint(host) {
  const set = (t) => { host.dataset.tint = t.mode; host.style.setProperty("--nav-greyed", String(t.factor)); };
  if (!options.game) { set(tintOf(null, { game: false })); return; }
  tint ||= fetch("/asset/ui/layout/UILobby.json?path=Front/Bottom/Menu/BG/Grid")
    .then((r) => (r.ok ? r.json() : null)).catch(() => null).then((grid) => tintOf(grid));
  set({ mode: "pending", factor: 0.5 }); // until the prefab is read: the icon at half, the label as it is
  tint.then((t) => { if (host.isConnected) set(t); });
}

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
export function renderNav(active = 0, opts = {}) {
  options = { ...options, ...opts };
  const host = $("nav");
  host.innerHTML = "";
  applyTint(host);
  ITEMS.forEach((item, i) => {
    const v = view(item, T);
    const b = document.createElement("button");
    // a greyed entry never takes the active look
    b.className = `nav-item${v.greyed ? " greyed" : i === active ? " active" : ""}`;
    if (v.greyed) {
      // still a button (a click hands over), so aria-disabled rather than disabled; named, never a tooltip
      b.setAttribute("aria-disabled", "true");
      b.setAttribute("aria-label", v.name);
      b.dataset.tab = v.tab;
    }
    const icon = document.createElement("i");
    icon.className = "nav-icon";
    icon.style.backgroundImage = `url("${spriteUrl("Common", item.icon)}")`;
    const span = document.createElement("span");
    span.textContent = v.label;
    span.style.fontSize = `${navSize(v.label)}px`;
    b.append(icon, span);
    b.addEventListener("click", () => click(item));
    host.appendChild(b);
  });
}

export function setTitle(text, onBack) {
  document.querySelector(".topbar .title").textContent = text;
  const back = document.querySelector(".topbar .back");
  back.onclick = onBack || null;
  back.style.visibility = onBack ? "visible" : "hidden";
}
