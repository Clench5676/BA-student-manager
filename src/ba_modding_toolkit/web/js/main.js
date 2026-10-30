// Boot and routing: #/roster (the student list) and #/student/<family>/<variant> (the detail screen). The game's
// loading screen covers the start and every change of screen until the new one is ready; a change inside the detail
// screen (a variant chip, the arrows) is covered too, through its first complete frame.
import { notify } from "./popup.js";
import * as Consent from "./consent.js";
import * as BatchImport from "./batch-import.js";
import * as Cursor from "./cursor.js";
import * as Detail from "./detail.js";
import * as Loading from "./loading.js";
import * as ModSwitch from "./mod-switch.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Prompts from "./prompts.js";
import * as Roster from "./roster.js";
import * as StudentHall from "./student-hall.js";
import * as Settings from "./settings.js";
import * as Update from "./update.js";
import * as Tours from "./tours.js";
import * as ModAdd from "./mod-add.js";
import { on, rpc, spinePrefix } from "./api.js";
import { L, T, setStrings, languageRefresh } from "./i18n.js";
import { neighbour, visit } from "./roster-order.js";
import { hasAsset, primaryKind } from "./switch-sources.js";
import { renderNav, setTitle, setTopActions, reflowTopActions } from "./nav.js";
import { confirmQuit, quitKey } from "./quit.js";
import { forget } from "./thumbs.js";
import { setSpineConsent } from "./spine-runtime.js";
import { $, fitStage } from "./util.js";
import { studentName } from "./names.js";
import { withTimeout } from "./async.js";
import { previewCache } from "./preview-cache.js";
import { ROOT_ROUTE, routeHistory } from "./route-history.js";
import { setupWindowChrome } from "./window-chrome.js";
import { installCloseGuard } from "./window-close.js";

installCloseGuard({ prepare: () => StudentHall.canLeave(), revision: StudentHall.closeRevision, root: () => [document.querySelector('.viewport'),
  document.querySelector('.window-header')].filter(Boolean) });
setupWindowChrome();

globalThis.BAMTRecovery?.presentReport((result) => Popup.message({ title: T("recovery.report"),
  lines: result ? [T("recovery.saved"), result.path, T(result.copied ? "recovery.copied" : "recovery.copyFailed"),
    ...(!result.copied ? [result.summary] : [])] : [T("recovery.actionFailed")], ok: T("picker.ok"), plain: true,
}));

let info = null, rosterData = null, rosterStale = true,resourceEpoch=0,configurationRevision=0;
const startup = {};
async function timed(phase, work) {
  const began = performance.now();
  globalThis.BAMTRecovery?.begin(phase);
  try { return await work(); }
  catch (error) { if (globalThis.BAMTRecovery?.isBooting()) globalThis.BAMTRecovery.fail(error); throw error; }
  finally { startup[phase] = performance.now() - began; globalThis.BAMTRecovery?.end(phase, startup[phase]); }
}
// the roster's cards as the list showed them when it was left (its filters, search and sort): the detail screen's
// arrows step through these, so visits and edits on the way do not reshuffle them; taken afresh once the roster shows
let stepCards = null;

function relabelShell() {
  document.title = T("top.students");
  document.querySelector(".topbar .back").setAttribute("aria-label", T("a11y.back"));
  $("fs-exit").setAttribute("aria-label", T("lobby.exit"));
  $("top-option").setAttribute("aria-label", T("settings.button"));
  $("top-home").setAttribute("aria-label", T("hall.home"));
  const back = document.querySelector(".topbar .back").onclick;
  setTitle(T(!$("screen-hall").hidden ? "hall.title" : !$("screen-import").hidden ? "nav.import" : "top.students"), back);
  Loading.relabel();
}
const refreshLanguage = languageRefresh({
  load: (lang) => rpc("i18n.strings", { lang }),
  refresh: async (lang) => {
    info.language = lang;
    stepCards = null;
    relabelShell();
    await document.fonts.ready;
    await Promise.all([renderNav(!$("screen-hall").hidden ? -1 : !$("screen-import").hidden ? 1 : 0), ModSwitch.relabel(),
      StudentHall.relabel(), Roster.relabel(), Detail.relabel(), BatchImport.relabel()]);
  },
});

const ctx = {
  dragged: false,
  back: () => goBack(),
  go: (family, variant, kind) => {
    const target = kind === "spr" ? "portrait" : kind;
    const tab = ["portrait", "lobby", "model"].includes(target) ? `/${target}` : "";
    location.hash = `#/student/${encodeURIComponent(family)}/${encodeURIComponent(variant)}${tab}`;
  },
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
    const epoch=resourceEpoch,next=await rpc("roster.list");
    if(epoch!==resourceEpoch)throw new DOMException('Game resources changed','AbortError');
    rosterData=next;
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
    for (const v of f.variants) if (hasAsset(v) && was.has(v.key) && was.get(v.key) !== (v.replaced ?? null)) {
      const kind = primaryKind(v);
      forget(spinePrefix(kind, kind === "spr" ? v.spr : v.lobby));
    }
  }
}

// an entry's variant named as the roster names it (entries of cores the catalog does not map carry their shipped
// names, else their core); resolves once the roster's data is in
async function variantNames() {
  const data = await roster().catch(() => rosterData);
  const byKey = new Map((data?.families || []).flatMap((f) => f.variants.map((v) => [v.key, v])));
  return (entry) => {
    const v = byKey.get(entry?.variant);
    return studentName(v, (v && L(v.names)?.full) || L(entry?.names)?.full || entry?.variant || entry?.core || "");
  };
}

// --- library.changed: a writer job switched game files ({cores, kinds}), or anything may have changed (no data: the
// classic UI closed, a job stopped midway, the mod list changed). The roster is read again, the thumbnails of those
// cores are forgotten (both live and official sources, including other installs' bases) and the detail screen
// reloads what it shows of them ---
let heldChange, changeTimer = null, changeRoute = 0;
function libraryChanged(data) {
  // An import changes the mod list without changing game files.
  const change = data && !data.mods && Array.isArray(data.cores) ? { cores: data.cores } : null;
  if (change && !change.cores.length) return;
  BatchImport.invalidate();
  for (const core of change?.cores || []) {
    const kinds = data.kinds?.length ? data.kinds : [/_spr$/i.test(core) ? "spr" : "lobby"];
    for (const kind of kinds) {
      forget(spinePrefix(kind, core));
      forget(spinePrefix(`official-${kind}`, core));
    }
  }
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
  if (change === undefined) return;
  const my = changeRoute;
  if (!$("screen-detail").hidden) return Detail.filesChanged(change);
  if (!$("screen-hall").hidden) {
    await Popup.whenIdle();
    if (my === routeToken && !$("screen-hall").hidden) await route();
    return;
  }
  if ($("screen-roster").hidden) return;
  // the list is built again once no popup is open, unless a route came meanwhile (it reads the list itself)
  await Popup.whenIdle();
  if (my === routeToken && !$("screen-roster").hidden) await route();
}

// A completed toggle refreshes directly, even if its event has not arrived or is still being coalesced.
async function refreshAfterToggle() {
  libraryChanged(null);
  clearTimeout(changeTimer);
  await applyChange();
}

// the window back in front after 30 s or more: the server checks again with scan consent
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
// way back; the variant is the one the detail screen shows for the link
function visited(fam, key) {
  const vs = fam?.variants || [];
  const shown = vs.some((v) => v.key === key && hasAsset(v)) ? key : (vs.find(hasAsset) || vs[0])?.key;
  if (rosterData && shown) visit(rosterData, shown);
}

function showScreen(name) {
  setTopActions(name === "hall",!!info?.gameFound);
  for (const id of ["screen-hall", "screen-roster", "screen-detail", "screen-import", "screen-message"]) $(id).hidden = id !== `screen-${name}`;
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

// the quit prompt (quit.js): the student list's back button and Escape on the list. In the app's window the quit
// closes it; in browser mode the server stops once it has answered, and the page says so
function askQuit() {
  return confirmQuit({
    message: Popup.message, rpc, T, notify, native: !!info?.native,
    closed: () => {
      $("stage").classList.add("closed");
      message(T("app.closed"));
    },
  });
}
addEventListener("keydown", (ev) => {
  if (!quitKey(ev, { byId: (id) => document.getElementById(id), covering: Loading.covering() })) return;
  ev.preventDefault();
  askQuit();
});

// without a game folder the game's UI cannot be drawn: plain buttons to find or choose one
function noGame() {
  const region=ctx.prefs?.fileSource==='windows_japan'?'japan':'global';
  const setDir = async (path) => {
    try { await rpc("settings.set", { key: `gameDir.${region}`, value: path }); await refreshConfiguration(); }
    catch (err) { notify(T(`error.${err.code}`, err.params), { kind: "error", error: err }); }
  };
  message(T("app.noGame.title"), T("error.game_directory_missing"), [
    [T("settings.detect"), async () => {
      const found = await rpc("settings.detectGame", { region }).catch(() => []);
      if (found.length) setDir(found[0]); else notify(T("error.game_directory_missing"), { kind: "error", error: { code: "game_directory_missing" } });
    }],
    ...(info?.native ? [[T("settings.change"), async () => { const p = await rpc("settings.pickFolder", {}).catch(() => null); if (p) setDir(p); }]] : []),
  ]);
}

async function refreshConfiguration(){
  const revision=++configurationRevision;++resourceEpoch;++routeToken;++routeAttempt;endRoute();
  StudentHall.hide();Detail.hide();Roster.hide();BatchImport.invalidate();stepCards=null;ctx.invalidateRoster();
  const [next,prefs]=await Promise.all([rpc('app.info'),rpc('settings.get')]);
  if(revision!==configurationRevision)return;
  info=next;ctx.info=next;ctx.prefs=prefs;
  previewCache.configure(prefs);
  if (NGUI.setResourceContext?.(next.resourceContext)) forget();
  await renderNav(-1,{game:!!next.gameFound});
  if(revision!==configurationRevision)return;
  if(!next.gameFound){noGame();return;}
  await NGUI.init();if(revision!==configurationRevision)return;
  await route();
}

let routeToken = 0, routeAttempt = 0, permissionAttempt = 0, endRoute = () => {}, homeRequested = false;
const navigation = routeHistory();
let shownRoute = ROOT_ROUTE;
let stagedDetail = null;
function goBack() {
  return withHallPermission(() => {
    const destination = navigation.back(location.hash || ROOT_ROUTE);
    if (destination) location.hash = destination;
    else return Promise.resolve(askQuit()).then((result) => {
      if (result !== "quit" && !$("screen-hall").hidden) return StudentHall.settleView?.();
    });
  });
}
function withHallPermission(action) {
  const permission = ++permissionAttempt;
  if ($("screen-hall").hidden) return action();
  return Promise.resolve(StudentHall.canLeave?.()).then((allowed) => {
    if (allowed !== false && permission === permissionAttempt) return action();
  }).catch((err) => {
    if (permission === permissionAttempt) notify(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error", error: err });
  });
}
function goHome() {
  return withHallPermission(() => {
    if ((location.hash || ROOT_ROUTE) === ROOT_ROUTE && !$("screen-hall").hidden) {
      navigation.commit(ROOT_ROUTE, { home: true });
      return StudentHall.settleView?.();
    }
    homeRequested = true;
    location.hash = ROOT_ROUTE;
  });
}
async function route() {
  ++permissionAttempt;
  const attempt = ++routeAttempt, address = location.hash || ROOT_ROUTE;
  if (!$("screen-hall").hidden) {
    try {
      const allowed = await StudentHall.canLeave?.();
      if (attempt !== routeAttempt) return;
      if (allowed === false) {
        homeRequested = false;
        if (location.hash !== shownRoute) history.replaceState(null, "", shownRoute);
        return;
      }
    } catch (err) {
      if (attempt !== routeAttempt) return;
      homeRequested = false;
      if (location.hash !== shownRoute) history.replaceState(null, "", shownRoute);
      notify(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error", error: err });
      return;
    }
  }
  endRoute();
  if (stagedDetail) {
    stagedDetail.target.hidden = true; stagedDetail.target.style.visibility = ""; stagedDetail.target.inert = false;
    stagedDetail = null;
  }
  const ended = new Promise((resolve) => { endRoute = resolve; });
  const my = ++routeToken;
  const current = () => my === routeToken && attempt === routeAttempt;
  const parts = address.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] !== "import") BatchImport.hide();
  if (parts[0] !== "hall") StudentHall.hide();
  renderNav(parts[0] === "hall" ? -1 : parts[0] === "import" ? 1 : 0);
  try {
    if (parts[0] === "hall") {
      Roster.hide();
      await Loading.scene(async () => {
        Detail.suspend();
        Detail.hide();
        const target = $("screen-hall");
        const wasHidden = target.hidden, wasVisibility = target.style.visibility;
        let committed = false;
        target.hidden = false; target.style.visibility = "hidden";
        try {
          await StudentHall.show(ctx);
          if (!current()) return;
          showScreen("hall"); setTitle(T("hall.title"), goBack);
          committed = true;
        } finally {
          if (my === routeToken) {
            if (!committed) target.hidden = wasHidden;
            target.style.visibility = wasVisibility || "";
          }
        }
      }, { until: ended });
    } else if (parts[0] === "import") {
      Roster.hide();
      await Loading.scene(async (covered) => {
        await covered;
        if (!current()) return;
        Detail.suspend();
        const data = await roster();
        if (!current()) return;
        await BatchImport.show(ctx, data);
        if (!current()) return;
        Detail.hide();
        showScreen("import");
        setTitle(T("nav.import"), goBack);
      }, { until: ended });
    } else if (parts[0] === "student" && parts[1]) {
      // leaving the list: its cards as shown are the arrows' order
      if (!stepCards && rosterData && !$("screen-roster").hidden) stepCards = Roster.order(rosterData);
      Roster.invalidate();
      Roster.hide();
      const inPlace = !$("screen-detail").hidden && !!Detail.currentVariant();
      await Loading.hold(() => Loading.scene(async (covered) => {
        const fam = await withTimeout(rpc("family.get", { key: parts[1] }), 15000, "family.get");
        await covered;
        if (!current()) return; // a later navigation took over
        visited(fam, parts[2]);
        const target = $("screen-detail"), wasHidden = target.hidden;
        let committed = false;
        if (wasHidden) {
          target.hidden = false; target.style.visibility = "hidden"; target.inert = true;
          stagedDetail = { target, token: my };
        }
        try {
          await Detail.show(ctx, fam, parts[2], { inPlace, kind: parts[3] });
          if (!current()) return;
          showScreen("detail");
          committed = true;
        } finally {
          if (stagedDetail?.token === my) {
            target.hidden = !committed; target.style.visibility = ""; target.inert = false; stagedDetail = null;
          }
        }
      }, { until: ended }), { until: ended });
    } else {
      const reveal = () => {
        Detail.hide();
        showScreen("roster");
        stepCards = null;
        setTitle(T("top.students"), goBack);
      };
      const open = async (covered) => {
        await covered;
        if (!current()) return;
        // Release detail page work before a roster RPC can wait on a writer's library lock.
        Detail.suspend();
        const data = await roster();
        if (!current()) return;
        try {
          await Roster.show(ctx, data);
        } catch (err) {
          if (current()) reveal();
          throw err;
        }
        if (!current()) return;
        reveal();
      };
      await Loading.scene(open, { until: ended });
    }
    if (current()) {
      shownRoute = navigation.commit(address, { home: homeRequested && address === ROOT_ROUTE });
      homeRequested = false;
    }
  } catch (err) {
    if (!current()||err.name==='AbortError') return;
    homeRequested = false;
    if (globalThis.BAMTRecovery?.isBooting() && err.code !== "game_not_found") throw err;
    console.error(err);
    if (err.code === "game_not_found") { noGame(); return; }
    notify(T(`error.${err.code || "internal"}`, err.params || { error: String(err) }), { kind: "error", error: err });
    if (parts[0] === "student") Detail.stepFailed();
    // a student the catalog does not have (a stale or mistyped link): the screen shown before, its portrait, lobby or
    // 3D view, does not stay under that address; back to the list, under the error popup
    if (parts[0] === "student" && my === routeToken && String(err.code || "").startsWith("catalog_")) {
      Detail.hide();
      location.replace("#/roster");
    } else if (location.hash !== shownRoute) {
      // The previous page has released its players/input. Re-enter its route to rebuild it, rather than exposing
      // its closed DOM under the failed destination's address (detail tabs deliberately ignore clicks when closed).
      BatchImport.hide();
      location.replace(shownRoute);
    }
  }
}

async function boot() {
  fitStage();
  addEventListener("resize", fitStage);
  // the page starts behind the loading screen: the game's UI is read, then the first screen is built
  await timed("boot", () => Loading.scene(start, { opaque: true }));
  if (globalThis.BAMTRecovery && !globalThis.BAMTRecovery.ready()) return;
  const ready = rpc("app.ready", { timings: { ...startup, ...Loading.timings() } }).catch(console.error);
  if (!info?.gameFound) return;
  Cursor.init();
  // the start popups only once the first screen is revealed
  const popups = Popup.sequence(startPopups());
  // The network check never holds the start sequence or a screen. Keep a late offer until the UI is free.
  if (ModSwitch.startDue("update", { info })) {
    Update.check($("consent"), undefined, { beforeShow: async () => {
      await popups;
      await Popup.whenIdle(200, () => Loading.busy() || ModSwitch.current()?.busy);
    } }).catch((err) => console.error("update check", err));
  }
  await popups;
  Tours.start({ info, ready, blocked: () => Loading.busy() || ModSwitch.current()?.busy || Prompts.isBusy()
    || !!document.getElementById("bamt-recovery") }).catch((err) => console.warn("feature tour", err));
}

// The start popups, one at a time and in this order, each only when it has something to show (mod-switch.js
// startDue); each step resolves once its popup has closed (docs/web-ui.md, "Start sequence"):
//   - the asset consent;
//   - the Spine licence confirmation, while unanswered;
//   - the scan consent, while it is unanswered and a game folder is known;
//   - the prompts of mods back to official and of mods outside the library, if the start scan is already in;
//     a later scan shows them once no other popup is open, only with the scan consent
function startPopups() {
  const due = (name) => ModSwitch.startDue(name, { info, state: ModSwitch.current() });
  return [
    ["consent", async () => {
      if (!due("consent")) return;
      info.consent = await Consent.show($("consent"), info.cacheDir, info.native);
      Loading.init(info);
    }],
    ["spine", async () => {
      if (!due("spine")) return;
      info.spineConsent = await Consent.spine($("consent"));
      if (info.spineConsent === true) await route();
    }],
    ["scan", () => due("scan") && Consent.scan($("consent"))],
    ["drift", () => Prompts.start("drift", info)],
    ["untracked", () => Prompts.start("untracked", info)],
  ];
}

async function start() {
  const prefs = timed("settings", () => rpc("settings.get"));
  info = await timed("info", () => rpc("app.info"));
  ctx.info = info;
  NGUI.setResourceContext?.(info.resourceContext);
  Consent.init(info);
  setSpineConsent(info.spineConsent);
  Loading.init(info); // the loading screen's backdrop from the game's prefab
  const ui = info.gameFound ? timed("ui-indexes", () => NGUI.init()) : Promise.resolve();
  ui.catch(() => {}); // observed below after the strings and fonts
  ctx.prefs = await prefs;
  previewCache.configure(ctx.prefs);
  Roster.init(ctx.prefs?.roster);
  setStrings(info.language, await timed("strings", () => rpc("i18n.strings", { lang: info.language })));
  Loading.relabel();
  document.title = T("top.students");
  document.querySelector(".topbar .back").setAttribute("aria-label", T("a11y.back"));
  $("fs-exit").setAttribute("aria-label", T("lobby.exit"));
  $("top-option").setAttribute("aria-label", T("settings.button"));
  $("top-home").setAttribute("aria-label", T("hall.home"));
  $("top-home").hidden = !info.gameFound;
  // subscribed before the no-game screen too, so choosing the game folder elsewhere reaches the page
  on("config.changed", () => refreshConfiguration().catch(console.error));
  on("app.busy", () => notify(T("error.busy"), { kind: "error", error: { code: "busy" } }));
  await timed("fonts", () => document.fonts.ready);
  // the bottom bar: its greyed entries hand over to the classic UI (with or without a game folder), their prompt
  // following the pref classicPrompt
  const navOptions = { game: !!info.gameFound, prefs: () => ctx.prefs, setPrefs: (prefs) => { ctx.prefs = prefs; },
    canLeave: () => $("screen-hall").hidden || StudentHall.canLeave?.() };
  await ui;
  renderNav(-1, navOptions);
  // the Enable Mods switch in the top bar, and what the writer jobs switched
  await timed("mod-state", () => ModSwitch.init({ names: variantNames, refreshPage: refreshAfterToggle }));
  let enabled = ModSwitch.current()?.enabled !== false;
  ModSwitch.onChange((state) => {
    const next = state.enabled !== false;
    if (next === enabled) return;
    enabled = next;
    libraryChanged(null);
  });
  Prompts.init({ names: variantNames });
  const settingsChanged = async (key, prefs) => {
    ctx.prefs = prefs;
    previewCache.configure(prefs);
    if (key === "cacheCleared" || key === "previewCache" || key === "cacheDir") return;
    if (key === "language") { await refreshLanguage(prefs.language); return; }
    Detail.applyPrefs(prefs);
    StudentHall.applyPrefs?.(prefs);
    if (key === "fileSource" || key.startsWith("gameDir") || key === "libraryDir") { await refreshConfiguration(); }
    else if(key === "spineConsent"){stepCards=null;ctx.invalidateRoster();await route();}
  };
  ctx.goOther = () => Settings.open(settingsChanged, "mods");
  ModAdd.init({ names: variantNames, changed: ctx.invalidateRoster, go: (key) => {
    const family = rosterData?.families.find((f) => f.variants.some((v) => v.key === key));
    if (family) ctx.go(family.key, key);
  }, goOther: () => Settings.open(settingsChanged, "mods") });
  on("library.changed", libraryChanged);
  on("photography.changed", () => {
    ctx.invalidateRoster();
    if ($("screen-roster").hidden) return;
    const token=routeToken;
    Popup.whenIdle().then(() => { if(token===routeToken&&!$("screen-roster").hidden)return route(); }).catch(console.error);
  });
  watchFront();
  // files dropped on the window are added to the library
  on("drop", async ({ paths }) => {
    try {
      if (location.hash.replace(/\/$/, "") === "#/import") { await BatchImport.drop(paths); return; }
      await ModAdd.add(paths, Detail.currentVariant());
      ctx.invalidateRoster();
      route();
    } catch (err) {
      notify(T(`error.${err.code}`, err.params), { kind: "error", error: err });
    }
  });
  $("top-option").addEventListener("click", () => Settings.open(settingsChanged));
  $("top-home").addEventListener("click", goHome);
  if (!location.hash) history.replaceState(null, "", ROOT_ROUTE);
  addEventListener("hashchange", route);
  if(!info.gameFound){noGame();return;}
  await timed("first-screen", route);
}

boot().catch((err) => {
  console.error(err);
  globalThis.BAMTRecovery?.fail(err);
});
