// Boot and routing: #/roster (the student list) and #/student/<family>/<variant> (the detail screen). The game's
// loading screen covers the start and every change of screen until the new one is ready; a change inside the detail
// screen (a variant chip, the arrows) keeps the old screen until the new one swaps in, with the indicator alone.
import * as Consent from "./consent.js";
import * as Detail from "./detail.js";
import * as Loading from "./loading.js";
import * as NGUI from "./ngui.js";
import * as Roster from "./roster.js";
import * as Settings from "./settings.js";
import * as Update from "./update.js";
import { on, rpc } from "./api.js";
import { T, setStrings } from "./i18n.js";
import { neighbour } from "./roster-order.js";
import { renderNav, setTitle } from "./nav.js";
import { $, fitStage, toast } from "./util.js";

let info = null, rosterData = null, rosterStale = true;
// the roster's cards as the list showed them when it was left (its filters, search and sort): the detail screen's
// arrows step through these, so visits and edits on the way do not reshuffle them; taken afresh once the roster shows
let stepCards = null;

const ctx = {
  dragged: false,
  go: (family, variant) => { location.hash = `#/student/${encodeURIComponent(family)}/${encodeURIComponent(variant)}`; },
  invalidateRoster: () => { rosterStale = true; Roster.invalidate(); },
  // the card before or after the shown variant (merged: family) in the roster's order, within its filters
  step: async (delta, family, variant) => {
    const data = await roster();
    stepCards ||= Roster.order(data);
    const next = neighbour(stepCards, () => Roster.order(data, { unfiltered: true }), { family, variant, merged: Roster.merged() }, delta);
    if (next) ctx.go(next.family, next.key);
  },
};

async function roster() {
  if (!rosterData || rosterStale) {
    rosterData = await rpc("roster.list");
    rosterStale = false;
  }
  return rosterData;
}

function showScreen(name) {
  for (const id of ["screen-roster", "screen-detail", "screen-message"]) $(id).hidden = id !== `screen-${name}`;
}

function message(title, hint, actions = []) {
  showScreen("message");
  $("message-title").textContent = title;
  $("message-hint").textContent = hint || "";
  const row = $("message-actions");
  row.replaceChildren(...actions.map(([caption, fn]) => {
    const b = document.createElement("button");
    b.className = "message-button";
    b.textContent = caption;
    b.addEventListener("click", fn);
    return b;
  }));
}

// without a game folder the game's UI cannot be drawn: plain buttons to find or choose one
function noGame() {
  const setDir = async (path) => {
    try { await rpc("settings.set", { key: "gameDir.global", value: path }); location.reload(); }
    catch (err) { toast(T(`error.${err.code}`, err.params), { kind: "error" }); }
  };
  message(T("app.noGame.title"), T("app.noGame.hint"), [
    [T("settings.detect"), async () => {
      const found = await rpc("settings.detectGame", { region: "global" }).catch(() => []);
      if (found.length) setDir(found[0]); else toast(T("app.noGame.title"), { kind: "error" });
    }],
    ...(info?.native ? [[T("settings.browse"), async () => { const p = await rpc("settings.pickFolder", {}).catch(() => null); if (p) setDir(p); }]] : []),
  ]);
}

let routeToken = 0, rosterBuilt = false;
async function route() {
  const my = ++routeToken;
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  try {
    if (parts[0] === "student" && parts[1]) {
      // leaving the list: its cards as shown are the arrows' order
      if (!stepCards && rosterData && !$("screen-roster").hidden) stepCards = Roster.order(rosterData);
      Roster.invalidate();
      if (!$("screen-detail").hidden && !Loading.covering()) {
        // in place: the shown screen stays until every part of the new one is ready, then all of it swaps at once
        await Loading.wait((async () => {
          const fam = await rpc("family.get", { key: parts[1] });
          if (my === routeToken) await Detail.show(ctx, fam, parts[2], { inPlace: true });
        })());
      } else {
        // from another screen, a deep link or the start: behind the loading screen
        await Loading.scene(async (covered) => {
          const fam = await rpc("family.get", { key: parts[1] });
          await covered;
          if (my !== routeToken) return; // a later navigation took over
          showScreen("detail");
          await Detail.show(ctx, fam, parts[2]);
        });
      }
    } else {
      const open = async (covered) => {
        const data = await roster();
        await covered;
        if (my !== routeToken) return;
        Detail.hide();
        showScreen("roster");
        stepCards = null;
        setTitle(T("top.students"), null);
        await Roster.show(ctx, data);
        rosterBuilt = true;
      };
      // the roster's first build is covered too; afterwards it comes back at once
      if (!rosterBuilt || Loading.covering()) await Loading.scene(open);
      else await open(null);
    }
  } catch (err) {
    console.error(err);
    if (err.code === "game_not_found") noGame();
    else toast(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error" });
  }
}

async function boot() {
  fitStage();
  addEventListener("resize", fitStage);
  // the page starts behind the loading screen: the game's UI is read, then the first screen is built
  await Loading.scene(start, { opaque: true });
  if (!info?.gameFound) return;
  // the consent popup only once the first screen is revealed
  if (info.consent !== true) await Consent.show($("consent"), info.cacheDir, info.native);
  // released builds look for a newer release once per launch (development runs do not)
  if (info.compiled) Update.check($("consent"));
}

async function start() {
  info = await rpc("app.info");
  ctx.info = info;
  Loading.init(info); // the loading illustrations of the UI language, fetched while the rest starts
  ctx.prefs = await rpc("settings.get").catch(() => null);
  Roster.init(ctx.prefs?.roster);
  setStrings(info.language, await rpc("i18n.strings", { lang: info.language }));
  Loading.relabel();
  document.title = T("top.students");
  document.querySelector(".topbar .back").setAttribute("aria-label", T("a11y.back"));
  $("fs-exit").setAttribute("aria-label", T("lobby.exit"));
  $("top-option").setAttribute("aria-label", T("settings.button"));
  // subscribed before the no-game screen too, so choosing the game folder elsewhere reaches the page
  on("config.changed", () => { if (!info.gameFound) { location.reload(); return; } stepCards = null; ctx.invalidateRoster(); route(); });
  on("app.busy", () => toast(T("error.busy"), { kind: "error" }));
  await document.fonts.ready;
  if (!info.gameFound) {
    renderNav(0);
    noGame();
    return;
  }
  await NGUI.init();
  renderNav(0);
  // files dropped on the window are added to the library
  on("drop", async ({ paths }) => {
    try {
      const added = await rpc("mods.add", { paths });
      toast(added.length ? `${T("popup.add")} ${added.length}` : T("drop.hint"));
      ctx.invalidateRoster();
      route();
    } catch (err) {
      toast(T(`error.${err.code}`, err.params), { kind: "error" });
    }
  });
  $("top-option").addEventListener("click", () => Settings.open((key, prefs) => {
    ctx.prefs = prefs;
    Detail.applyPrefs(prefs);
    if (key === "fileSource" || key.startsWith("gameDir") || key === "libraryDir") { stepCards = null; ctx.invalidateRoster(); route(); }
  }));
  addEventListener("hashchange", route);
  await route();
}

boot().catch((err) => {
  console.error(err);
  toast(String(err), { kind: "error", sticky: true });
});
