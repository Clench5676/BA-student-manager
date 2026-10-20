// Item 1's prompts (docs/web-ui.md, "Mods already in use"): the mods the last scan found outside the library ("Mods
// Not in the Library"), the configured entries a Steam check, a repair or a game update put back to official ("Mods
// Back to Official"), and the messages of an overwritten entry (no official copy anywhere): Add First while its mod is
// not in the library, the Overwritten message with the repair lines once it is. Every list comes from the scan
// (mods.entries), so the prompts exist only with the scan consent; the messages need none (the detail screen judges its
// files cheaply). The pure parts (which entries a prompt lists, its cards and details, what its buttons do, the drift
// result) are tested in Node (tests/js/prompts.test.mjs).
import * as Loading from "./loading.js";
import * as ModSwitch from "./mod-switch.js";
import * as Popup from "./popup.js";
import { on, rpc, spineBase, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { addFirstLines, overwrittenLines } from "./repairs.js";
import { thumb } from "./thumbs.js";
import { toast } from "./util.js";

// --- pure parts ---

export const entryKey = (e) => `${e?.install}|${e?.core}`;

// an alternate lobby core's suffix ("gl", "teen"), shown after the kind; none for the primary core and portraits
export function lobbySuffix(core) {
  const m = /_home_([a-z0-9]+)$/i.exec(String(core || ""));
  return m ? m[1].toLowerCase() : "";
}

// the kind chip: Portrait, Memorial Lobby, or the memorial lobby of an alternate core with its suffix
export function kindLabel(entry) {
  const kind = entry?.kind || (/_spr$/i.test(entry?.core || "") ? "spr" : "lobby");
  if (kind !== "lobby") return T("tab.portrait");
  const suffix = lobbySuffix(entry?.core);
  return suffix ? `${T("tab.lobby")} ${suffix}` : T("tab.lobby");
}

// the install an entry is in, from mods.state.installs
export const installOf = (state, key) => (state?.installs || []).find((i) => i.key === key) || null;

// the id that names another install's files in a skeleton URL (<core>@<id>); null for the current install's
export function installId(state, key) {
  if (!key || key === state?.current) return null;
  return installOf(state, key)?.id || null;
}

// a card's skeleton: the entry's core in its own install, so a card never shows the current install's file of the
// same name
export const entryBase = (entry, state) => spineBase(entry?.kind === "lobby" ? "lobby" : "spr", entry?.core, installId(state, entry?.install));

// the entries a prompt lists, from the last scan (mods.entries), leaving out the dismissed ones unless asked (Settings'
// Check lists them again):
//   drift: the reset and updated entries ("listed", while mods are on), and the stuck ones (pending, overwritten),
//          which no repair brought back, apart ("apart")
//   untracked: the untracked entries and the configured changed ones ("listed"), the damaged ones apart
export function promptEntries(entries, which, { dismissed = false, enabled = true } = {}) {
  const open = (e) => dismissed || !e.dismissed;
  const list = (entries || []).filter((e) => e && typeof e === "object");
  if (which === "drift") {
    return {
      listed: enabled ? list.filter((e) => open(e) && ["reset", "updated"].includes(e.state)) : [],
      apart: list.filter((e) => e.state === "pending" && e.overwritten),
    };
  }
  return {
    listed: list.filter((e) => open(e) && ["untracked", "changed"].includes(e.state)),
    apart: list.filter((e) => e.state === "damaged"),
  };
}

// whether a scan's entries give a prompt something new to show: an entry it lists that it has not shown in this state
export function fresh(listed, shown) {
  return listed.some((e) => !shown.has(`${entryKey(e)}|${e.state}`));
}

// the official copy of an entry's non-official files, as its details name it: Kept, Backup, Other Folder, or No
// Official Copy
export function copyText(entry) {
  const files = (entry?.files || []).filter((f) => !f.official);
  if (!files.length) return T("mods.copy.kept");
  if (files.some((f) => !f.copy)) return T("mods.copy.none");
  const order = ["kept", "backup", "elsewhere", "game"];
  const best = order.find((c) => files.every((f) => f.copy === c)) || files.map((f) => f.copy).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  return T(best === "game" ? "mods.copy.kept" : `mods.copy.${best}`);
}

// an entry's CRC state as the details name it: Fixed (trailing bytes), Needs Fix (only from a switch's record), else
// Not Needed
export function crcText(entry) {
  const states = (entry?.files || []).filter((f) => !f.official).map((f) => f.crc);
  if (states.includes("needs_fix")) return T("crc.needed");
  if (states.includes("fixed") || entry?.fixed) return T("crc.fixed");
  return T("crc.original");
}

// sizes as the prompts show them
export const sizeText = (bytes) => ModSwitch.sizeText(bytes);

// card(entry, {state, nameOf, kind}): one card of a prompt, for popup.js listPopup (its thumbnail is added by the page):
//   the variant's name, the kind and install chips (the install only when more than one is known), "No Official Copy"
//   on an overwritten entry; damaged and stuck entries cannot be ticked and are drawn dim with their state
export function card(entry, { state = null, nameOf = (e) => e?.variant || e?.core || "", which = "untracked", sep = ModSwitch.listSep() } = {}) {
  const name = nameOf(entry) || entry?.variant || entry?.core || "";
  // a variant's portrait and lobby are two cards: the kind follows the name
  const label = `${name}${sep}${kindLabel(entry)}`;
  const installs = state?.installs || [];
  const chips = [kindLabel(entry)];
  if (installs.length > 1) chips.push(installOf(state, entry.install)?.label || entry.install);
  if (entry.overwritten) chips.push(T("mods.copy.none"));
  const apart = which === "untracked" ? entry.state === "damaged" : entry.state === "pending" && entry.overwritten;
  const badge = entry.state === "damaged" ? { text: T("mods.damaged"), color: "#9aa3ad", ink: "#ffffff" }
    : entry.overwritten ? { text: which === "drift" ? T("mods.overwritten") : T("mods.copy.none"), color: "#9aa3ad", ink: "#ffffff" }
      : null;
  return {
    key: entryKey(entry), label, full: name, kind: entry.kind, size: apart ? 0 : entry.size || 0, chips,
    disabled: apart, dim: apart, badge, entry,
  };
}

// details(entry, which): the panel on the left: File, Size, CRC state and Official Copy; a damaged or stuck entry's
// Details button opens its repair lines
export function details(entry, { which = "untracked" } = {}) {
  const files = entry?.files || [];
  // the files not official (an entry back to official: all of them)
  const modded = files.filter((f) => !f.official);
  const shown = modded.length ? modded : files;
  const name = (shown[0] || files[0])?.file?.split(/[\\/]/).pop() || entry?.core || "-";
  const more = shown.length > 1 ? ` +${shown.length - 1}` : "";
  const size = shown.reduce((n, f) => n + (f.size || 0), 0);
  const fields = [[T("field.file"), `${name}${more}`], [T("field.size"), size ? sizeText(size) : "-"]];
  if (entry?.state !== "damaged") fields.push([T("field.crc"), crcText(entry)], [T("field.copy"), copyText(entry)]);
  const repair = entry?.state === "damaged" || (which === "drift" ? entry?.state === "pending" && entry?.overwritten : false);
  return { title: kindLabel(entry), fields, repair };
}

// the footer of a prompt: the ticked cards and, for what Add to Library copies, their total size
export function footer(items, selection, { sep = ModSwitch.listSep(), size = true } = {}) {
  const ticked = items.filter((it) => selection.has(it.key));
  const count = T("mods.selected", { n: ticked.length });
  return size ? `${count}${sep}${T("mods.size", { size: sizeText(Popup.sizeOf(items, selection)) })}` : count;
}

// what the untracked prompt's buttons do: add the ticked cards (and, with Add and Turn On Mods, turn mods on after);
// with Don't Ask Again ticked, the cards not added are dismissed (by their files' names, sizes and dates). Later adds
// nothing, and with the box ticked dismisses every card.
export function untrackedOutcome(button, items, selection, dontAsk = false) {
  const entries = (pick) => items.filter(pick).map((it) => ({ install: it.entry.install, core: it.entry.core }));
  const adding = button === "add" || button === "addTurnOn";
  const adopt = adding ? entries((it) => !it.disabled && selection.has(it.key)) : [];
  const dismiss = dontAsk ? entries((it) => !it.disabled && !(adding && selection.has(it.key))) : [];
  return { adopt, dismiss, turnOn: button === "addTurnOn" };
}

// Apply Mod Configuration's result: a toast when everything was done; otherwise the failed entries with their error
// strings, and the ones skipped because their files changed since the scan (another tool, the classic UI) with
// "Game files changed, check again"
export function driftSummary(result, nameOf) {
  const list = (k) => result?.[k] || [];
  const skipped = list("skipped").filter((s) => ["changed", "untracked", "entry_changed"].includes(s.why));
  if (!list("failed").length && !skipped.length && !list("stuck").length) return { toast: T("job.done") };
  const label = (e) => ModSwitch.entryLabel(e, nameOf);
  const lines = [T("mods.result", { done: list("done").length, failed: list("failed").length + skipped.length })];
  if (list("stuck").length) lines.push(T("mods.stuck", { n: list("stuck").length }));
  const failures = [
    ...list("failed").map((f) => `${label(f.entry)} - ${ModSwitch.errorText(f.code, f.params)}`),
    ...skipped.map((s) => `${label(s)} - ${T("error.entry_changed")}`),
  ];
  lines.push(...failures.slice(0, 6));
  if (failures.length > 6) lines.push(`+${failures.length - 6}`);
  return { title: T("mods.driftTitle"), lines };
}

// the message for an overwritten entry's files: Add First while the mod in the game is not in the library (no library
// source carries its non-official parts), else the Overwritten message with the repair lines
export function overwrittenKind(files) {
  const modded = (files || []).filter((f) => !(typeof f.official === "boolean" ? f.official : f.applied === "official"));
  return modded.length && modded.every((f) => /^(mod|variant):/.test(f.applied || "")) ? "overwritten" : "addFirst";
}

// --- the page ---

let names = async () => (e) => e?.variant || e?.core || "";
const shown = { drift: new Set(), untracked: new Set() }; // entry|state shown by each prompt in this page
let busy = false; // a prompt is open (or its action runs)
let startScan = null;
let started = false; // the start sequence reached its prompts: later scans may show them

export function init(options = {}) {
  if (options.names) names = options.names;
  ModSwitch.setDriftPrompt(() => show("drift", { force: true }));
  // a scan after the start (the window back in front, the classic window closed, a game folder change): the prompts
  // that have something new show once no other popup is open
  on("library.scanned", () => { later().catch((err) => console.error("prompts", err)); });
}

// the start scan: resolves once one has come in (or one was in before the page), at most 10 s
function scanned() {
  startScan ||= new Promise((resolve) => {
    if (ModSwitch.current()?.scanned || ModSwitch.current()?.scan !== true) { resolve(); return; }
    let off = null;
    const timer = setTimeout(() => { off?.(); resolve(); }, 10000);
    off = on("library.scanned", () => { clearTimeout(timer); off(); resolve(); });
  });
  return startScan;
}

// a step of the start sequence (main.js): the drift prompt, then the untracked prompt, each only when due
export async function start(which, info) {
  try {
    await scanned();
    const s = await ModSwitch.refresh();
    const entries = s?.scan === true ? await rpc("mods.entries").catch(() => []) : [];
    if (ModSwitch.startDue(which, { info, state: s, entries })) await show(which, { entries });
  } finally {
    if (which === "untracked") started = true;
  }
}

async function later() {
  if (busy || !started) return;
  await Popup.whenIdle();
  if (busy) return;
  const s = await ModSwitch.refresh();
  if (s?.scan !== true) return;
  const entries = await rpc("mods.entries").catch(() => []);
  for (const which of ["drift", "untracked"]) {
    if (!ModSwitch.startDue(which, { info: {}, state: s, entries })) continue;
    if (!fresh(promptEntries(entries, which, { enabled: s.enabled !== false }).listed, shown[which])) continue;
    await show(which, { entries });
  }
}

// show(which, {entries, dismissed, force}): a prompt over the current screen. force: from Settings' Check or the tray,
// whatever was shown before (an empty list says so with a toast)
export async function show(which, { entries = null, dismissed = false, force = false } = {}) {
  if (busy) return null;
  const s = ModSwitch.current() || (await ModSwitch.refresh()) || {};
  const all = entries || (await rpc("mods.entries").catch(() => []));
  const lists = promptEntries(all, which, { dismissed, enabled: s.enabled !== false });
  if (!lists.listed.length) {
    if (force) toast(T("settings.mods.clean"));
    return null;
  }
  for (const e of lists.listed) shown[which].add(`${entryKey(e)}|${e.state}`);
  busy = true;
  try {
    return which === "drift" ? await driftPrompt(lists, s) : await untrackedPrompt(lists, s);
  } finally {
    busy = false;
  }
}

async function cardsOf(entries, state, which) {
  const nameOf = await names().catch(() => undefined);
  return entries.map((e) => {
    const base = entryBase(e, state), lobby = e?.kind === "lobby";
    return { ...card(e, { state, nameOf, which }), thumb: thumb(base, "card", null, lobby), big: () => thumb(base, "bust", null, lobby) };
  });
}

// a prompt as a list popup in #prompt, every card that can be ticked ticked; resolves with {button, selection,
// checked} once one of its buttons (or, where it has one, its close) answered it
function listPrompt({ title, items, buttons, hint, check, closable, which }) {
  const host = document.getElementById("prompt");
  let selection = Popup.selectable(items);
  let focus = null;
  return new Promise((resolve) => {
    const done = (button) => {
      host.hidden = true;
      host.innerHTML = "";
      resolve({ button, selection, checked: !!check?.checked });
    };
    const draw = (scroll = 0) => Popup.listPopup({
      host, title, items, selected: [...selection], multi: true, focus, keepScroll: scroll, hint,
      footer: footer(items, selection, { size: which === "untracked" }), check,
      buttons: buttons.map((b) => ({ ...b, fn: () => (b.greyed ? toast(b.why || "", { kind: "error" }) : done(b.action)) })),
      onClose: closable ? () => done("later") : null,
      onSelect: (key, s) => { focus = key; selection = Popup.toggled(selection, items, key); draw(s); },
      details: (it) => {
        const d = details(it.entry, { which });
        const actions = d.repair ? [[T("mods.details"), () => repairMessage([it], currentState())]] : [];
        return { title: d.title, fields: d.fields, actions };
      },
    }).catch((err) => { console.error("prompt", err); done(null); });
    draw();
  });
}
const currentState = () => ModSwitch.current() || {};

// the repair lines of damaged or stuck entries (Details): their names and what the user runs
function repairMessage(items, s) {
  const installs = (s.installs || []).filter((i) => items.some((it) => it.entry.install === i.key));
  const named = items.map((it) => ModSwitch.entryLabel(it.entry, () => it.full));
  const title = items.some((it) => it.entry.state === "damaged") ? T("mods.damaged") : T("mods.overwrittenTitle");
  return Popup.message({ title, lines: overwrittenLines({ names: named, installs }, T), ok: T("picker.ok") });
}

// "Mods Back to Official": exactly two buttons (decision 16), no Later and no close; Escape and the backdrop do
// nothing. Apply Mod Configuration sends the ticked cards (the others are kept as they are); Keep as Is keeps them all.
async function driftPrompt(lists, s) {
  const items = [...(await cardsOf(lists.listed, s, "drift")), ...(await cardsOf(lists.apart, s, "drift"))];
  const blocked = s.available === false ? ModSwitch.reasonText(s) : "";
  const hint = lists.apart.length ? `${T("mods.driftWhy")}${ModSwitch.listSep()}${T("mods.stillOverwritten", { n: lists.apart.length })}` : T("mods.driftWhy");
  const answer = await listPrompt({
    title: T("mods.driftTitle"), items, hint, closable: false, which: "drift",
    buttons: [
      { label: T("mods.driftKeep"), action: "keep" },
      { label: T("mods.driftApply"), action: "apply", primary: true, greyed: !!blocked && s.reason !== "classic_open", why: blocked },
    ],
  });
  if (!answer.button) return null;
  const listed = items.filter((it) => !it.disabled).map((it) => it.entry);
  const choice = ModSwitch.driftChoice(answer.button, listed, [...answer.selection]);
  const plain = (e) => ({ install: e.install, core: e.core, state: e.state });
  if (choice.dismiss.length) {
    await rpc("mods.dismiss", { kind: "drift", entries: choice.dismiss.map(plain) }).catch((err) => toast(ModSwitch.errorText(err.code, err.params), { kind: "error" }));
  }
  if (choice.restore.length) await applyDrift(choice.restore.map(plain));
  return answer.button;
}

// Apply Mod Configuration: the job, its progress, and its result; refused while the classic UI is open, the classic
// modal (which can keep it for when the window closes)
async function applyDrift(entries) {
  const params = { entries };
  let id;
  try {
    id = await rpc("mods.restoreDrift", params);
  } catch (err) {
    ModSwitch.refused(err, "mods.restoreDrift", params);
    return;
  }
  toast(T("job.running"), { sticky: true });
  try {
    const job = waitJob(id, (p) => toast(T("tray.working", { done: p.current, total: p.total }), { sticky: true }));
    Loading.wait(job).catch(() => {});
    const result = await job;
    const summary = driftSummary(result, await names().catch(() => undefined));
    if (summary.toast) { toast(summary.toast); return; }
    toast("");
    await Popup.message({ title: summary.title, lines: summary.lines, ok: T("picker.ok") });
  } catch (err) {
    ModSwitch.refused(err, "mods.restoreDrift", params);
  }
}

// "Mods Not in the Library": every card ticked; Add to Library, with mods off also Add and Turn On Mods, and Later;
// Don't Ask Again dismisses the cards not added. The damaged entries are listed apart and cannot be ticked.
async function untrackedPrompt(lists, s) {
  const items = [...(await cardsOf(lists.listed, s, "untracked")), ...(await cardsOf(lists.apart, s, "untracked"))];
  const check = { label: T("mods.dontAsk"), checked: false, onChange: () => {} };
  const labels = { add: T("mods.untrackedAdd"), addTurnOn: T("mods.addTurnOn"), later: T("update.later") };
  const answer = await listPrompt({
    title: T("mods.untrackedTitle"), items, hint: T("mods.untrackedHint"), check, closable: true, which: "untracked",
    buttons: ModSwitch.untrackedButtons(s).reverse().map((id) => ({ label: labels[id], action: id, primary: id === "add" })),
  });
  if (!answer.button) return null;
  const outcome = untrackedOutcome(answer.button, items, answer.selection, answer.checked);
  if (outcome.dismiss.length) {
    await rpc("mods.dismiss", { kind: "untracked", entries: outcome.dismiss }).catch((err) => toast(ModSwitch.errorText(err.code, err.params), { kind: "error" }));
  }
  if (outcome.adopt.length) {
    const added = await adopt(outcome.adopt);
    if (added && outcome.turnOn) await ModSwitch.turn({ enabled: true, expect: false });
  }
  return answer.button;
}

// Add to Library: the library.adopt job (allowed while the game runs); a toast, or a result popup for failures
export async function adopt(entries) {
  let id;
  try {
    id = await rpc("mods.adopt", { entries });
  } catch (err) {
    toast(ModSwitch.errorText(err.code, err.params), { kind: "error" });
    return false;
  }
  toast(T("job.running"), { sticky: true });
  try {
    const job = waitJob(id, (p) => toast(T("tray.working", { done: p.current, total: p.total }), { sticky: true }));
    Loading.wait(job).catch(() => {});
    const result = await job;
    const failed = [...(result?.failed || []), ...(result?.skipped || []).map((s) => ({ entry: s, code: "entry_changed" }))];
    if (!failed.length) { toast(T("job.done")); return true; }
    toast("");
    const nameOf = await names().catch(() => undefined);
    await Popup.message({
      title: T("mods.untrackedAdd"),
      lines: [T("mods.result", { done: (result?.added || []).length, failed: failed.length }),
        ...failed.slice(0, 6).map((f) => `${ModSwitch.entryLabel(f.entry, nameOf)} - ${ModSwitch.errorText(f.code, f.params)}`)],
      ok: T("picker.ok"),
    });
    return (result?.added || []).length > 0;
  } catch (err) {
    toast(ModSwitch.errorText(err.code, err.params), { kind: "error" });
    return false;
  }
}

// the message of an overwritten entry of the current install (the switch popup's greyed cards, an
// original_unavailable refusal): Add First, whose Add to Library adopts this entry, or the Overwritten message with
// the repair lines of its install; resolves once it closes (true when the entry was added)
export async function overwritten({ name, core, files }) {
  const s = currentState();
  const install = s.current;
  const installs = (s.installs || []).filter((i) => i.key === install);
  if (overwrittenKind(files) === "overwritten") {
    await Popup.message({ title: T("mods.overwrittenTitle"), lines: overwrittenLines({ names: name ? [name] : [], installs }, T), ok: T("picker.ok") });
    return false;
  }
  const r = await Popup.message({
    title: T("mods.overwrittenTitle"), lines: addFirstLines({ names: name ? [name] : [] }, T),
    ok: T("mods.untrackedAdd"), cancel: T("popup.cancel"),
  });
  if (r.button !== "ok" || !install || !core) return false;
  return adopt([{ install, core: String(core).toLowerCase() }]);
}
