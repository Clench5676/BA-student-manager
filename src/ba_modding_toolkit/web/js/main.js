// Boot and routing: #/roster (the student list) and #/student/<family>/<variant> (the detail screen). The game's
// loading screen covers the start and every change of screen until the new one is ready; a change inside the detail
// screen (a variant chip, the arrows) keeps the old screen until the new one swaps in, with the indicator alone.
import * as Consent from "./consent.js";
import * as Cursor from "./cursor.js";
import * as Detail from "./detail.js";
import * as Loading from "./loading.js";
import * as ModSwitch from "./mod-switch.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Roster from "./roster.js";
import * as Settings from "./settings.js";
import * as Update from "./update.js";
import { on, rpc, spinePrefix } from "./api.js";
import { L, T, setStrings } from "./i18n.js";
import { neighbour, visit } from "./roster-order.js";
import { renderNav, setTitle } from "./nav.js";
import { forget } from "./thumbs.js";
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
    const before = rosterData;
    rosterData = await rpc("roster.list");
    rosterStale = false;
    forgetReplaced(before, rosterData);
  }
  return rosterData;
}

// the portraits whose game files carry something else than before (the classic UI closed, a job that stopped midway:
// library.changed without its cores): their thumbnails are rendered again
function forgetReplaced(before, after) {
  if (!before) return;
  const was = new Map(before.families.flatMap((f) => f.variants.map((v) => [v.key, v.replaced ?? null])));
  for (const f of after.families) {
    for (const v of f.variants) if (v.spr && was.has(v.key) && was.get(v.key) !== (v.replaced ?? null)) forget(spinePrefix("spr", v.spr));
  }
}

// an entry's variant named as the roster names it (entries of cores the catalog does not map carry their shipped
// names, else their core); resolves once the roster's data is in
async function variantNames() {
  const data = await roster().catch(() => rosterData);
  const byKey = new Map((data?.families || []).flatMap((f) => f.variants.map((v) => [v.key, v])));
  return (entry) => {
    const v = byKey.get(entry?.variant);
    return (v && L(v.names)?.full) || L(entry?.names)?.full || entry?.variant || entry?.core || "";
  };
}

// --- library.changed: a writer job switched game files ({cores, kinds}), or anything may have changed (no data: the
// classic UI closed, a job stopped midway, the mod list changed). The roster is read again, the thumbnails of those
// cores are forgotten (a mod and the official file share one /asset/spine/<kind>/<core> URL; the prefix covers the
// <core>@<id> bases of other installs too) and the detail screen reloads what it shows of them ---
let heldChange, changeTimer = null, changeRoute = 0;
function libraryChanged(data) {
  const change = data && Array.isArray(data.cores) ? { cores: data.cores } : null;
  if (change && !change.cores.length) return; // a job that switched nothing the page shows (a prune, a judging)
  for (const core of change?.cores || []) forget(spinePrefix(/_spr$/i.test(core) ? "spr" : "lobby", core));
  ctx.invalidateRoster();
  heldChange = heldChange === undefined ? change : heldChange === null || change === null ? null
    : { cores: [...new Set([...heldChange.cores, ...change.cores])] };
  changeRoute = routeToken;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(applyChange, 150); // the events of one job come together
}
async function applyChange() {
  const change = heldChange;
  heldChange = undefined;
  if (!$("screen-detail").hidden) { Detail.filesChanged(change); return; }
  if ($("screen-roster").hidden) return;
  // the list is built again once no popup is open, unless a route came meanwhile (it reads the list itself)
  await Popup.whenIdle();
  if (changeRoute === routeToken && !$("screen-roster").hidden) route();
}

// the window back in front after 30 s or more: the game files are checked again (only with the scan consent)
let hiddenAt = 0;
function watchFront() {
  const away = () => { hiddenAt ||= Date.now(); };
  const back = () => {
    if (hiddenAt && Date.now() - hiddenAt >= 30000 && ModSwitch.current()?.scan === true) rpc("mods.scan").catch(() => {});
    hiddenAt = 0;
  };
  addEventListener("blur", away);
  addEventListener("focus", back);
  document.addEventListener("visibilitychange", () => (document.hidden ? away() : back()));
}

// the visit the detail screen records (ui.visit) goes into the roster's data too, so "Recently Viewed" has it on the
// way back; the variant is the one the detail screen shows for the link (one with a portrait)
function visited(fam, key) {
  const vs = fam?.variants || [];
  const shown = vs.some((v) => v.key === key && v.spr) ? key : (vs.find((v) => v.spr) || vs[0])?.key;
  if (rosterData && shown) visit(rosterData, shown);
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
          if (my !== routeToken) return;
          visited(fam, parts[2]);
          await Detail.show(ctx, fam, parts[2], { inPlace: true });
        })());
      } else {
        // from another screen, a deep link or the start: behind the loading screen
        await Loading.scene(async (covered) => {
          const fam = await rpc("family.get", { key: parts[1] });
          await covered;
          if (my !== routeToken) return; // a later navigation took over
          showScreen("detail");
          visited(fam, parts[2]);
          await Detail.show(ctx, fam, parts[2]);
        });
      }
    } else {
      const reveal = () => {
        Detail.hide();
        showScreen("roster");
        stepCards = null;
        setTitle(T("top.students"), null);
      };
      const open = async (covered) => {
        const data = await roster();
        await covered;
        if (my !== routeToken) return;
        // the list is built, its pictures decoded, behind the screen shown; then the screens change in one frame
        try {
          await Roster.show(ctx, data);
        } catch (err) {
          if (my === routeToken) reveal();
          throw err;
        }
        if (my !== routeToken) return;
        reveal();
        rosterBuilt = true;
      };
      // the roster's first build is covered too; afterwards the screen shown stays until the list is ready (with the
      // indicator alone if that takes a while)
      if (!rosterBuilt || Loading.covering()) await Loading.scene(open);
      else await Loading.wait(open(null));
    }
  } catch (err) {
    console.error(err);
    if (err.code === "game_not_found") { noGame(); return; }
    toast(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error" });
    if (parts[0] === "student") Detail.stepFailed();
    // a student the catalog does not have (a stale or mistyped link): the screen shown before, its portrait, lobby or
    // 3D view, does not stay under that address; back to the list, under the error toast
    if (parts[0] === "student" && my === routeToken && String(err.code || "").startsWith("catalog_")) {
      Detail.hide();
      location.replace("#/roster");
    }
  }
}

async function boot() {
  fitStage();
  addEventListener("resize", fitStage);
  // the page starts behind the loading screen: the game's UI is read, then the first screen is built
  await Loading.scene(start, { opaque: true });
  if (!info?.gameFound) return;
  // the start popups only once the first screen is revealed
  await Popup.sequence(startPopups());
}

// The start popups, one at a time and in this order, each only when it has something to show (mod-switch.js
// startDue); each step resolves once its popup has closed (docs/web-ui.md, "Start sequence"):
//   - the asset consent;
//   - the scan consent, while it is unanswered and a game folder is known;
//   - the update: released builds look for a newer release once per launch (development runs do not);
//   - (the prompts of mods outside the library and of mods back to official come after these, with the start scan)
function startPopups() {
  const due = (name) => ModSwitch.startDue(name, { info, state: ModSwitch.current() });
  return [
    ["consent", () => due("consent") && Consent.show($("consent"), info.cacheDir, info.native)],
    ["scan", () => due("scan") && Consent.scan($("consent"))],
    ["update", () => due("update") && Update.check($("consent"))],
  ];
}

async function start() {
  info = await rpc("app.info");
  ctx.info = info;
  Loading.init(info); // the loading screen's backdrop from the game's prefab
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
  // the game's pointer and touch effect, read from the game in the background (the system cursor until then)
  Cursor.init();
  renderNav(0);
  // the Enable Mods switch in the top bar, and what the writer jobs switched
  await ModSwitch.init({ names: variantNames }).catch((err) => console.error("mod switch", err));
  on("library.changed", libraryChanged);
  watchFront();
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
