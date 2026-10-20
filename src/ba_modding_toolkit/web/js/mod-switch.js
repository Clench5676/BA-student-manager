// The Enable Mods switch (docs/web-ui.md, "Enable Mods switch"): one switch for every game folder, in the top bar
// (#mod-switch) and in Settings' Mods tab. A click turns mods off or on at once (mods.toggle); the first toggle from
// any place explains it once; the square "?" opens the help, with the disk use of built mods, Retry and the file check.
// A write refused while the classic UI is open opens the classic modal, which can queue it until the window closes.
// The pure parts (the view from mods.state, the click, the help's lines, the result, the start prompts, the classic
// modal's outcome) are tested in Node (tests/js/mod_switch.test.mjs).
import * as Consent from "./consent.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";
import { on, rpc, waitJob } from "./api.js";
import { T, language } from "./i18n.js";
import { overwrittenLines } from "./repairs.js";
import { $, toast } from "./util.js";

// --- pure parts ---

// the reasons that keep the prompts reading the scan (drift, untracked) away: the game, Steam or the classic UI may
// be writing, so a file may be half written
export const PROMPT_BLOCKERS = ["game_running", "steam_busy", "classic_open"];
// the calls the classic modal can keep for when the classic window closes (webui/classic.py QUEUE_METHODS)
export const QUEUEABLE = ["actions.apply", "actions.restore", "mods.toggle", "mods.restoreDrift"];

// the language's list separator: 、 in Chinese and Japanese, a comma elsewhere
export const listSep = (lang = language()) => (/^(zh|ja)/i.test(lang) ? "、" : ", ");

// sizes as the help shows them
export function sizeText(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (!b) return "0 MB";
  if (b < 1048576) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// an error's string; the free-space refusal names sizes
export function errorText(code, params = {}) {
  const p = { ...(params || {}) };
  if (code === "not_enough_space") for (const k of ["need", "free"]) if (typeof p[k] === "number") p[k] = sizeText(p[k]);
  return T(`error.${code || "internal"}`, p);
}

// view(state, {place}): how the switch draws from mods.state. place "top" (the top bar) hides it when Settings turned
// it off (decision 15) or there is no current install (the roster and the detail screen are not available then);
// "settings" always shows it.
//   on: mods are enabled; busy: a toggle queued or running, or writes queued for the classic window (dimmed);
//   unavailable: greyed, with reason (game_running, game_status_unavailable, steam_busy, classic_open,
//   game_not_found, profiles_unreadable); dot: entries not switched or left as is (the services count them from the
//   last scan with the scan consent, from the unfinished list without it)
export function view(state, { place = "top" } = {}) {
  if (!state) return { hidden: true, on: true, busy: false, unavailable: false, reason: null, dot: false };
  const busy = !!state.busy;
  const unavailable = !busy && state.available === false;
  const counts = (state.pending || 0) + (state.stuck || 0) + (state.left || 0);
  return {
    hidden: place === "top" && (state.shown === false || !state.current),
    on: state.enabled !== false,
    busy,
    unavailable,
    reason: state.available === false ? state.reason || null : null,
    dot: counts > 0,
  };
}

// clickAction(state, explained): what a click on the switch does
//   "busy": a toggle runs (refused, a toast); "queued": writes wait for the classic window (the classic modal, its
//   box ticked); "reason": unavailable (the reason as a toast); "explain": the first toggle ever (the explanation,
//   then the toggle); "classic": the classic window is open (the classic modal); "toggle": at once (decision 3)
export function clickAction(state, explained = false) {
  if (!state) return "none";
  if (state.busy) return state.queued > 0 ? "queued" : "busy";
  if (state.available === false && state.reason !== "classic_open") return "reason";
  if (!state.explained && !explained) return "explain";
  if (state.available === false) return "classic";
  return "toggle";
}

// the toggle a click submits, and the Retry of the help (the same intent again)
export const toggleParams = (state) => ({ enabled: state?.enabled === false, expect: state?.enabled !== false });
export const retryParams = (state) => ({ enabled: state?.enabled !== false, expect: state?.enabled !== false });

// the reason a greyed switch shows
export const reasonText = (state) => (state?.reason ? errorText(state.reason, state.reasonParams) : "");

// the help's opening text, which the first toggle's explanation repeats
export const basics = () => [T("mods.help")];

// the first toggle's explanation: {title, lines, ok}; the box closes with Cancel too, and only ok toggles
export function explanation(state) {
  const action = T(state?.enabled === false ? "mods.onTitle" : "mods.offTitle");
  return { title: action, lines: [...basics(), T("mods.explainOnce")], ok: action };
}

// helpLines(state): the "?" help's lines, [{text, button: {id, label}}]. Buttons: clear (Clear Built Mods), allow
// (Allow Check: opens the scan consent popup, grants nothing itself), retry (pending and left entries), details
// (stuck entries: the Overwritten message, never a Retry)
export function helpLines(state, { sep = listSep() } = {}) {
  const s = state || {};
  const lines = basics().map((text) => ({ text }));
  // the disk use line leads straight into the two sizes
  lines.push({ text: T("mods.helpSpace") });
  lines.push({ text: T("mods.builtSize", { size: sizeText(s.builtSize) }),
    ...(s.builtSize > 0 ? { button: { id: "clear", label: T("mods.builtClear") } } : {}) });
  lines.push({ text: T("mods.originalsSize", { size: sizeText(s.originalsSize) }) });
  const installs = s.installs || [];
  if (installs.length > 1) lines.push({ text: T("mods.helpFolders", { folders: installs.map((i) => i.label).join(sep) }) });
  if (s.scan !== true) lines.push({ text: T("mods.scanOff"), button: { id: "allow", label: T("mods.allowCheck") } });
  const notSwitched = (s.pending || 0) + (s.left || 0);
  if (notSwitched > 0) lines.push({ text: T("mods.notSwitched", { n: notSwitched }), button: { id: "retry", label: T("mods.retry") } });
  if (s.stuck > 0) lines.push({ text: T("mods.stuck", { n: s.stuck }), button: { id: "details", label: T("mods.details") } });
  if (s.sourceMissing > 0) lines.push({ text: T("mods.sourceMissing", { n: s.sourceMissing }) });
  return lines;
}

// an entry as the result and the messages name it: the variant's name and the kind
export function entryLabel(entry, nameOf = (e) => e?.variant || e?.core || "", sep = listSep()) {
  const kind = entry?.kind === "lobby" || (entry?.core && !/_spr$/i.test(entry.core)) ? "tab.lobby" : "tab.portrait";
  return `${nameOf(entry)}${sep}${T(kind)}`;
}

const MAX_LISTED = 6; // failed entries a result names; the rest are counted

// resultSummary(result, nameOf): what a toggle's end shows. Nothing adopted, failed, stuck or left: a toast ("Mods
// off" / "Mods on"); otherwise {title, lines} for a result popup, each failed entry with its error string.
export function resultSummary(result, nameOf) {
  const list = (k) => result?.[k] || [];
  const title = T(result?.enabled === false ? "mods.offState" : "mods.onState");
  if (!list("adopted").length && !list("failed").length && !list("stuck").length && !list("left").length) return { toast: title };
  const lines = [];
  if (list("adopted").length) lines.push(T("mods.toAdd", { n: list("adopted").length }));
  lines.push(T("mods.result", { done: list("done").length, failed: list("failed").length + list("left").length }));
  if (list("stuck").length) lines.push(T("mods.stuck", { n: list("stuck").length }));
  const failures = [
    ...list("failed").map((f) => `${entryLabel(f.entry, nameOf)} - ${errorText(f.code, f.params)}`),
    ...list("left").map((e) => `${entryLabel(e, nameOf)} - ${errorText(e.code || "library_io_error", e.params)}`),
  ];
  lines.push(...failures.slice(0, MAX_LISTED));
  if (failures.length > MAX_LISTED) lines.push(`+${failures.length - MAX_LISTED}`);
  return { title, lines };
}

// classicOutcome({queued, checked}): what closing the classic modal does, however it closes (decision 5). Opened on
// a refused write: ticked, the write is queued ("queue"); unticked, nothing. Opened on writes already queued (a click
// on the busy switch, the box ticked): unticked, the queue is emptied ("clear").
export function classicOutcome({ queued = false, checked = false } = {}) {
  if (queued) return checked ? null : "clear";
  return checked ? "queue" : null;
}

// startDue(name, {info, state, entries}): whether a start popup has something to show, in the order of START
//   consent: the asset consent until it is given; scan: the scan consent while unanswered and a game folder is known;
//   update: released builds; drift and untracked: only with the scan consent, from the start scan's entries not
//   dismissed, never while the game, Steam or the classic UI may be writing; no drift while mods are off
export const START = ["consent", "scan", "update", "drift", "untracked"];
export function startDue(name, { info = {}, state = null, entries = [] } = {}) {
  const scanned = state?.scan === true && !PROMPT_BLOCKERS.includes(state?.reason);
  const open = (e) => !e.dismissed;
  switch (name) {
    case "consent": return info.consent !== true;
    case "scan": return !!state && state.scan == null && (state.installs || []).length > 0;
    case "update": return !!info.compiled;
    case "drift": return scanned && state.enabled !== false && entries.some((e) => open(e) && ["reset", "updated"].includes(e.state));
    case "untracked": return scanned && entries.some((e) => open(e) && ["untracked", "changed"].includes(e.state));
    default: return false;
  }
}

// the untracked prompt's buttons: Add and Turn On Mods only while mods are off
export const untrackedButtons = (state) => ["add", ...(state?.enabled === false ? ["addTurnOn"] : []), "later"];

// the drift prompt's two buttons: Apply Mod Configuration sends the selected cards and keeps the rest as they are
// (dismissed); Keep as Is dismisses every card (decision 16)
export function driftChoice(button, entries, selected) {
  const keys = new Set(selected);
  const key = (e) => `${e.install}|${e.core}`;
  if (button === "apply") return { restore: entries.filter((e) => keys.has(key(e))), dismiss: entries.filter((e) => !keys.has(key(e))) };
  return { restore: [], dismiss: [...entries] };
}

// --- the page ---

let state = null;
let explainedHere = false; // the explanation was shown in this page (mods.state follows a moment later)
let inFlight = false; // a toggle (or Retry) this page started runs
let names = async () => (e) => e?.variant || e?.core || ""; // main.js gives the variants' names (the roster's data)
let host = null, els = null;
const listeners = new Set();
let lastSignature = "";

export const current = () => state;
// fn(state) when what Settings' Mods tab shows changed (not on every progress step)
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// the parts of mods.state the switch and Settings draw
const signature = (s) => JSON.stringify(s && [s.enabled, s.shown, s.available, s.reason, s.busy, s.queued > 0, s.scan,
  s.explained, s.pending, s.stuck, s.left, s.sourceMissing, s.builtSize, s.originalsSize, s.drift, s.untracked,
  s.damaged, s.tray, s.current, (s.installs || []).map((i) => [i.key, i.label, i.named])]);

function update(next) {
  if (!next) return;
  state = next;
  render();
  const sig = signature(next);
  if (sig === lastSignature) return;
  lastSignature = sig;
  for (const fn of listeners) { try { fn(next); } catch (err) { console.error(err); } }
}

export async function refresh() {
  update(await rpc("mods.state").catch(() => null));
  return state;
}

// init({names}): the top bar's switch and the events; names() resolves with a function naming an entry's variant
export async function init(options = {}) {
  if (options.names) names = options.names;
  host = $("mod-switch");
  if (host && !els) build();
  on("mods.state", update);
  on("classic.queueDone", queueDone);
  listenTray();
  await refresh();
}

// the tray's events (webui/tray.py), also on the no-game screen: the tray switches the known installs without one
let trayHeard = false;
export function listenTray() {
  if (trayHeard) return;
  trayHeard = true;
  on("tray.open", (data) => { trayOpen(data).catch((err) => console.error("tray", err)); });
  on("tray.toggle", (data) => { trayToggle(data).catch((err) => console.error("tray", err)); });
  if (!state) refresh();
}

// the drift prompt (prompts.js), which the tray's Back to Official opens
let driftPrompt = null;
export function setDriftPrompt(fn) { driftPrompt = fn; }

// the top bar: the switch (ON and OFF, the game's filter segments), its label, the square "?"
function build() {
  host.innerHTML = "";
  const toggle = document.createElement("button");
  toggle.className = "ms-toggle";
  toggle.setAttribute("role", "switch");
  const seg = (cls, text) => {
    const s = document.createElement("span");
    s.className = `ms-seg ${cls}`;
    const b = document.createElement("b");
    b.textContent = text;
    s.appendChild(b);
    return s;
  };
  const dot = document.createElement("i");
  dot.className = "ms-dot";
  toggle.append(seg("ms-on", T("settings.post.on")), seg("ms-off", T("settings.post.off")), dot);
  const label = document.createElement("span");
  label.className = "ms-label";
  label.id = "mod-switch-label";
  label.textContent = T("mods.switch");
  toggle.setAttribute("aria-labelledby", label.id);
  const help = document.createElement("button");
  help.className = "ms-help";
  help.title = T("mods.guide");
  help.setAttribute("aria-label", T("mods.guide"));
  help.appendChild(document.createElement("i"));
  toggle.addEventListener("click", () => click("top"));
  help.addEventListener("click", () => openHelp());
  host.append(toggle, label, help);
  els = { toggle, dot, label, help };
  fitLabel(label);
}

// the label from 26 px down to 20 px so it stays on one line
function fitLabel(el, max = 240) {
  for (let fs = 26; fs >= 20; fs -= 1) {
    el.style.fontSize = `${fs}px`;
    if (!el.isConnected || el.scrollWidth <= max) return;
  }
}

function render() {
  if (!host || !els) return;
  const v = view(state);
  host.hidden = v.hidden;
  const { toggle, dot } = els;
  toggle.classList.toggle("is-on", v.on);
  toggle.classList.toggle("busy", v.busy);
  toggle.classList.toggle("unavailable", v.unavailable);
  toggle.setAttribute("aria-checked", String(v.on));
  toggle.setAttribute("aria-disabled", String(v.busy || v.unavailable));
  // the reason as the tooltip of a greyed switch (and its description for assistive technology)
  if (v.unavailable) toggle.title = reasonText(state); else toggle.removeAttribute("title");
  dot.hidden = !v.dot;
}

// --- clicks ---

// click(from): the switch was clicked (the top bar, Settings); the same rules everywhere
export async function click(from = "top") {
  const s = state;
  switch (clickAction(s, explainedHere)) {
    case "busy": toast(T("error.busy"), { kind: "error" }); return;
    case "queued": classicModal({ queued: true }); return;
    case "reason": toast(reasonText(s), { kind: "error" }); return;
    case "explain":
      // the toggle the explanation named; switched elsewhere meanwhile, the job refuses it (state_changed), and a
      // classic window opened meanwhile gives the classic modal
      if (await explain(s)) run(toggleParams(s));
      return;
    case "classic": classicModal({ method: "mods.toggle", params: toggleParams(s) }); return;
    case "toggle": run(toggleParams(s)); return;
    default:
  }
}

// the first toggle: the explanation once (decision 3); closing it in any way counts as shown, only its button toggles
async function explain(s) {
  const e = explanation(s);
  const r = await Popup.message({ title: e.title, lines: e.lines, ok: e.ok, cancel: T("popup.cancel"), width: 2100 });
  explainedHere = true;
  rpc("mods.explained").catch(() => {});
  return r.button === "ok";
}

// a toggle or Retry: submitted at once; the indicator and the progress while it runs; the result at its end
async function run(params) {
  if (inFlight) { toast(T("error.busy"), { kind: "error" }); return; }
  inFlight = true;
  let id;
  try {
    id = await rpc("mods.toggle", params);
  } catch (err) {
    inFlight = false;
    refused(err, "mods.toggle", params);
    return;
  }
  try {
    await follow(id, params, "mods.toggle");
  } finally {
    inFlight = false;
  }
}

// a toggle job followed to its end: the indicator, "Working 12/40", then the toast or the result popup. method: the
// call a classic_open refusal may queue (the tray's toggle has none: the tray never queues)
async function follow(id, params, method) {
  toast(T("job.running"), { sticky: true });
  try {
    const job = waitJob(id, (p) => toast(T("tray.working", { done: p.current, total: p.total }), { sticky: true }));
    Loading.wait(job).catch(() => {});
    await finished(await job);
  } catch (err) {
    refused(err, method, params);
  }
}

// turn(params): a toggle asked for by another control (the untracked prompt's Add and Turn On Mods): the first
// toggle's explanation first, as from any place (decision 3)
export async function turn(params) {
  const s = state || (await refresh());
  if (!s) return;
  if (!s.explained && !explainedHere && !(await explain({ enabled: !params.enabled }))) return;
  await run(params);
}

// --- the tray: it brings the window to the front, and the page shows what follows ---

// tray.open {view, ...}: "explain", the first toggle's explanation from the tray, whose button submits the toggle the
// tray asked for ({enabled, expect}); "error", the tray's toggle refused at submit ({code, params}), shown as for the
// page's own toggle (the tray never queues for the classic window); "drift", the drift prompt
export async function trayOpen(data = {}) {
  const view = data?.view;
  if (view === "explain") {
    const params = { enabled: !!data.enabled, expect: !!data.expect };
    if (explainedHere || state?.explained || (await explain({ enabled: !params.enabled }))) await run(params);
    return;
  }
  if (view === "error") {
    refused({ code: data.code || "internal", params: data.params || {} });
    return;
  }
  if (view === "drift") await driftPrompt?.();
}

// tray.toggle {job, enabled, expect}: the tray submitted the toggle; the page follows it as its own (progress, the end
// toast, the result popup)
export async function trayToggle(data = {}) {
  if (!data?.job) return;
  await follow(data.job, { enabled: !!data.enabled, expect: !!data.expect }, null);
}

// a toggle's end: a toast, or the result popup when entries were adopted, failed, stuck or left
async function finished(result) {
  const nameOf = await names().catch(() => undefined);
  const summary = resultSummary(result, nameOf);
  if (summary.toast) { toast(summary.toast); return; }
  toast("");
  await Popup.message({ title: summary.title, lines: summary.lines, ok: T("picker.ok") });
}

// a refusal (at submit or from the job): the classic modal for the classic window, else its string; switched
// elsewhere first, the switch redraws from mods.state
export function refused(err, method = null, params = null) {
  const code = err?.code || "internal";
  if (code === "classic_open" && QUEUEABLE.includes(method)) { toast(""); classicModal({ method, params }); return; }
  toast(errorText(code, err?.params || { error: String(err) }), { kind: "error" });
  if (code === "state_changed") refresh();
}

// --- the classic modal (decision 5): "Close the classic UI first", with "Apply automatically once it closes". Any
// way of closing follows the box: ticked, the refused write is queued; unticked, nothing (or, opened on writes already
// queued, the queue is emptied) ---
export async function classicModal({ method = null, params = null, queued = false } = {}) {
  const r = await Popup.message({
    title: T("classic.opened"), lines: [T("error.classic_open")],
    cancel: T("classic.front"), ok: T("picker.ok"),
    check: { label: T("classic.autoApply"), checked: queued },
  });
  if (r.button === "cancel") rpc("classic.front").catch(() => {});
  const what = classicOutcome({ queued, checked: r.checked });
  try {
    if (what === "queue" && method) {
      await rpc("classic.queue", { method, params: params || {} });
      toast(T("classic.queued"));
    } else if (what === "clear") {
      await rpc("classic.clearQueue");
    }
  } catch (err) {
    toast(errorText(err.code, err.params), { kind: "error" });
  }
  return what;
}

// the writes queued for the classic window ran: the dropped ones in one popup; a queued toggle's result as usual
async function queueDone({ submitted = [], dropped = [] } = {}) {
  for (const item of submitted) {
    if (!item.job) continue;
    waitJob(item.job).then((result) => (item.method === "mods.toggle" ? finished(result) : null))
      .catch((err) => toast(errorText(err.code, err.params), { kind: "error" }));
  }
  if (!dropped.length) return;
  const nameOf = await names().catch(() => undefined);
  const what = (d) => {
    if (d.method === "mods.toggle") return T(d.params?.enabled ? "mods.onTitle" : "mods.offTitle");
    if (d.method === "mods.restoreDrift") return T("mods.driftApply");
    return entryLabel({ variant: d.params?.variant, kind: d.params?.kind }, nameOf);
  };
  await Popup.message({
    title: T("classic.notApplied"),
    lines: dropped.map((d) => `${what(d)} - ${errorText(d.error?.code, d.error?.params)}`),
    ok: T("picker.ok"),
  });
}

// --- the help ---

// openHelp(): the "?" help on the message popup (title Enable Mods); a line's button acts, most of them closing it
export async function openHelp() {
  const s = state || (await refresh());
  if (!s) return;
  const act = {
    clear: ({ close }) => { close(null); clearBuilt(); },
    allow: ({ close }) => { close(null); askScan(); },
    retry: ({ close }) => { close(null); run(retryParams(state || s)); },
    details: () => overwritten(),
  };
  const lines = helpLines(s).map((l) => (l.button ? { text: l.text, button: { label: l.button.label, fn: act[l.button.id] } } : l.text));
  await Popup.message({ title: T("mods.switch"), lines, width: 2100 });
}

// Clear Built Mods (decision 11): a library job; kept originals stay, Off needs them
async function clearBuilt() {
  try {
    const id = await rpc("mods.clearBuilt");
    const job = waitJob(id);
    Loading.wait(job).catch(() => {});
    await job;
    toast(T("mods.builtCleared"));
  } catch (err) {
    toast(errorText(err.code, err.params), { kind: "error" });
  }
}

// the scan consent popup, over whatever is open (Settings' File Check, the help's Allow Check); the consent is given
// there, never by the button that opened it
export function askScan() {
  return Consent.scan($("consent"), { over: true }).then((granted) => { refresh(); return granted; });
}

// the Overwritten message for the entries left as they are: their names (known from the last scan with the scan
// consent) and the repair lines of their installs; no button starts a repair (decision 9)
async function overwritten() {
  const s = state || {};
  const entries = s.scan === true ? (await rpc("mods.entries").catch(() => [])).filter((e) => e.state === "pending" && e.overwritten) : [];
  const nameOf = await names().catch(() => undefined);
  const installs = entries.length ? (s.installs || []).filter((i) => entries.some((e) => e.install === i.key)) : s.installs || [];
  const listed = entries.slice(0, MAX_LISTED).map((e) => entryLabel(e, nameOf));
  if (entries.length > MAX_LISTED) listed.push(`+${entries.length - MAX_LISTED}`);
  await Popup.message({ title: T("mods.overwrittenTitle"), lines: overwrittenLines({ names: listed, installs }, T), ok: T("picker.ok") });
}

// Settings' Game Files Check: a scan with the dismissed entries listed again; resolves once it is in (or after 60 s)
export async function check() {
  const done = new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => { off?.(); resolve(null); }, 60000);
    off = on("library.scanned", (data) => { clearTimeout(timer); off(); resolve(data); });
  });
  try {
    await rpc("mods.scan", { dismissed: true });
  } catch (err) {
    toast(errorText(err.code, err.params), { kind: "error" });
    return null;
  }
  const result = await Loading.wait(done);
  await refresh();
  return result;
}
