// Boot and routing: #/roster (the student list) and #/student/<family>/<variant> (the detail screen).
import * as Consent from "./consent.js";
import * as Detail from "./detail.js";
import * as NGUI from "./ngui.js";
import * as Roster from "./roster.js";
import * as Settings from "./settings.js";
import * as Update from "./update.js";
import { on, rpc } from "./api.js";
import { T, setStrings } from "./i18n.js";
import { renderNav, setTitle } from "./nav.js";
import { $, fitStage, toast } from "./util.js";

let info = null, rosterData = null, rosterStale = true;

const ctx = {
  dragged: false,
  go: (family, variant) => { location.hash = `#/student/${encodeURIComponent(family)}/${encodeURIComponent(variant)}`; },
  invalidateRoster: () => { rosterStale = true; Roster.invalidate(); },
  // the next or previous family in the roster's order
  stepFamily: async (key, delta) => {
    const data = await roster();
    const list = data.families.filter((f) => f.variants.some((v) => v.spr));
    const i = list.findIndex((f) => f.key === key);
    const next = list[(i + delta + list.length) % list.length];
    if (next) ctx.go(next.key, next.variants.find((v) => v.spr).key);
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

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  try {
    if (parts[0] === "student" && parts[1]) {
      Roster.invalidate();
      const fam = await rpc("family.get", { key: parts[1] });
      showScreen("detail");
      await Detail.show(ctx, fam, parts[2]);
    } else {
      Detail.hide();
      showScreen("roster");
      setTitle(T("top.students"), null);
      await Roster.show(ctx, await roster());
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
  info = await rpc("app.info");
  ctx.info = info;
  ctx.prefs = await rpc("settings.get").catch(() => null);
  setStrings(info.language, await rpc("i18n.strings", { lang: info.language }));
  document.title = T("top.students");
  await document.fonts.ready;
  if (!info.gameFound) {
    renderNav(0);
    noGame();
    return;
  }
  toast(T("app.loading"), { sticky: true });
  await NGUI.init();
  renderNav(0);
  toast("");
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
  on("config.changed", () => { ctx.invalidateRoster(); route(); });
  $("top-option").addEventListener("click", () => Settings.open((key, prefs) => {
    ctx.prefs = prefs;
    Detail.applyPrefs(prefs);
    if (key === "fileSource" || key.startsWith("gameDir") || key === "libraryDir") { ctx.invalidateRoster(); route(); }
  }));
  addEventListener("hashchange", route);
  await route();
  if (info.consent !== true) await Consent.show($("consent"), info.cacheDir, info.native);
  // released builds look for a newer release once per launch (development runs do not)
  if (info.compiled) Update.check($("consent"));
}

boot().catch((err) => {
  console.error(err);
  toast(String(err), { kind: "error", sticky: true });
});
