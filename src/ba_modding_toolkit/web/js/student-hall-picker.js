// Portrait rows and the quick-formation memorial picker share the roster's search, filter and sort semantics.
import * as UI from "./student-hall-ui.js";
import * as Display from "./display.js";
import * as Popup from "./popup.js";
import { bindReorder, dragFeedback } from "./student-hall-reorder.js";
import { normalizeView } from "./roster-order.js";
import { portraitRows, studentChoices, memorialChoices, sourceKey } from "./student-hall-model.js";
import { thumbnailScope } from "./thumbs.js";
import { lazyThumbnail } from "./lazy-thumbnail.js";
import { spineBase } from "./api.js";
import { L, T, language } from "./i18n.js";

const titleOf = (choice) => [L(choice.names)?.full || choice.variant, choice.label].filter(Boolean).join(" - ");
export function openPicker({ kind, choices, draft, onPreview, onChange, onSave, onCancel, onDone, onError, onViewed, isSaving = () => false }) {
  const memorial = kind === "lobby", work = thumbnailScope({ priority: "popup" }), pictures = new Map(), headsPictures = new Map(), viewed = {}, positions = new Map();
  let view = normalizeView({ sort: memorial ? "recent" : "name", order: memorial ? "desc" : "asc" }), query = "", searching = false, student = null;
  let debounce, displayOwned = false;
  const close = () => memorial ? onCancel() : onDone();
  const modal = UI.createModal(T(memorial ? "hall.adjust" : "hall.addPortraits"), close);
  const safe = (action) => (...args) => isSaving() ? null : Promise.resolve(action(...args)).catch((error) => { if (modal.live()) onError(error); });
  const picture = (choice) => {
    const key = sourceKey(choice);
    if (!pictures.has(key)) {
      const base = spineBase(choice.source.startsWith("mod:") ? "mod" : `official-${choice.kind}`, choice.source.startsWith("mod:") ? choice.source.slice(4) : choice.core);
      pictures.set(key, lazyThumbnail(() => work.thumb(base, choice.kind === "spr" ? "portrait" : "landscape", null, choice.kind === "lobby"), work.signal));
    }
    return pictures.get(key);
  };
  const item = (choice, key = sourceKey(choice)) => ({ key, full: titleOf(choice), label: choice.label || L(choice.names)?.full || choice.variant, thumb: picture(choice) });
  const canAdd = (choice) => !(choice.kind === "spr" ? draft.current().portraits : draft.current().memorials).some((entry) => sourceKey(entry) === sourceKey(choice));
  const addLabel = (choice) => T(canAdd(choice) ? "hall.add" : "hall.added");
  const add = async (choice, hit) => { if (isSaving()) return false; const entry = draft.add(choice); if (!entry) return false; if (hit) hit.disabled = true; onChange?.(); if (modal.live()) await draw(); return true; };
  const rows = () => portraitRows(choices, view, query, L, language());
  const students = () => studentChoices(choices, view, query, L, language(), "lobby").filter((s) => s.lobby);
  const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (modal.live()) draw().catch(onError); }, 100); };
  async function toolbar(layer) {
    const openDisplay = async (settings) => {
      const focus = document.activeElement; modal.host.inert = true;
      await Display.warm(); if (!modal.live()) return; displayOwned = true;
      try { await Display.open({ ...settings, onDone: (next) => { displayOwned = false; if (!modal.live()) return; modal.host.inert = false; focus?.focus?.(); settings.onDone(next); } }); }
      catch (error) { if (modal.live()) modal.host.inert = false; throw error; }
    };
    const display = () => openDisplay({ view, sorts: ["recent", "name", "added", "mods", "default"],
      count: (next) => studentChoices(choices, next, query, L, language(), memorial ? "lobby" : "spr").length,
      onDone: (next) => { if (next && modal.live()) { view = normalizeView({ ...view, ...next }); positions.clear(); draw().catch(onError); } } });
    await UI.rosterToolbar(layer, view, searching, {
      change: (next) => { if (isSaving()) return; view = normalizeView({ ...view, ...next }); student = null; positions.clear(); draw().catch(onError); },
      search: () => {
        searching = !searching; if (!searching) query = ""; positions.clear();
        draw().then(() => { if (searching && modal.live()) modal.host.querySelector('[data-focus-key="hall-search"]')?.focus(); }).catch(onError);
      },
      display: safe(display),
    }, memorial ? {} : { x: 300, y: 250, width: 1320 });
    if (searching) await UI.search(layer, query, (value) => { query = value; positions.clear(); changed(); }, memorial ? [130, 252, 1640] : [300, 298, 1320]);
  }
  async function drawPortraits(layer, alive, signal) {
    const groups = rows();
    if (!groups.length) return UI.caption(layer, T("hall.noCandidates"), [320, 390, 1200]);
    const list = UI.virtualArea(layer, [300, searching ? 370 : 300, 1320, searching ? 485 : 555], groups.length, 406, async (rowHost, rowIndex, rowSignal) => {
      const row = groups[rowIndex];
      await UI.rowPlate(rowHost, [1320, 402]);
      await UI.caption(rowHost, row.student.name, [90, 170, 150], { size: 44 });
      if (rowSignal.aborted) return;
      const strip = UI.virtualArea(rowHost, [240, 0, 960, 402], row.choices.length, 220, (cell, i) => UI.card(cell, item(row.choices[i]), {
        x: 105, y: 154, kind: "spr", scale: .46, onAdd: safe((event) => add(row.choices[i], event?.currentTarget)), addLabel: addLabel(row.choices[i]), addEnabled: canAdd(row.choices[i]) }),
        { key: `portrait-${row.key}`, horizontal: true, signal: rowSignal, positions, onError });
      await strip.ready;
    }, { key: "portrait-rows", signal, positions, onError });
    await list.ready;
  }
  async function drawMemorials(layer, alive, signal) {
    const shown = students(); if (student && !shown.some((s) => s.key === student)) student = null;
    const candidates = memorialChoices(choices, shown, student, view, query, viewed, L, language());
    const top = searching ? 330 : 250, height = searching ? 370 : 450;
    await Promise.all([
      UI.panel(layer, "StudentsPanel", [115, top, 980, height], T("top.students")),
      UI.panel(layer, "CandidatesPanel", [1115, top, 685, height], student ? shown.find((s) => s.key === student)?.name || T("hall.memorial") : T(view.sort === "recent" ? "hall.recentMemorials" : "hall.memorialCandidates")),
    ]);
    const heads = UI.virtualArea(layer, [130, top + 58, 945, height - 73], Math.ceil(shown.length / 6), 195, (cell, row) => Promise.all(shown.slice(row * 6, row * 6 + 6).map((entry, i) => {
      if (!headsPictures.has(entry.key)) headsPictures.set(entry.key, lazyThumbnail(() => entry.portrait, work.signal));
      return UI.studentCard(cell, { ...entry, thumb: headsPictures.get(entry.key) }, [84 + i * 155, 4], student === entry.key,
        () => { student = student === entry.key ? null : entry.key; if (!student) { view.sort = "recent"; view.order = "desc"; } positions.delete("memorial-candidates"); draw().catch(onError); });
    })), { key: "memorial-students", signal, positions, onError });
    const cards = UI.virtualArea(layer, [1130, top + 58, 650, height - 73], Math.ceil(candidates.length / 2), 275,
      (cell, row) => Promise.all(candidates.slice(row * 2, row * 2 + 2).map((choice, i) => UI.card(cell, item(choice), {
        x: 177 + i * 315, y: 93, scale: .39, onAdd: safe((event) => add(choice, event?.currentTarget)), addLabel: addLabel(choice), addEnabled: canAdd(choice) }))),
      { key: "memorial-candidates", signal, positions, onError });
    await Promise.all([heads.ready, cards.ready]); if (!alive()) return;
    if (!candidates.length) await UI.caption(cards.inner, T("hall.noCandidates"), [30, 70, 590]);
    const list = draft.current().memorials;
    await UI.queuePanel(layer, [115, 720, 1685, 195]);
    const pitch = UI.MEMORIAL_QUEUE_PITCH;
    const reorder = (id, index) => { const target = list[index]; if (target && !isSaving() && draft.move(id, target.id)) { onChange?.(); draw().catch(onError); } };
    let marker;
    const queue = UI.virtualArea(layer, [130, 735, 1640, 175], list.length, pitch, async (cell, index, rowSignal) => {
      const entry = list[index];
      const choice = choices.find((c) => c.kind === "lobby" && sourceKey(c) === sourceKey(entry));
      const box = document.createElement("div"); Object.assign(box.style, { position: "absolute", left: "0", top: "0", width: `${pitch}px`, height: "175px" });
      box.dataset.queue = entry.id; cell.append(box);
      let actionBox = [45, 119, 190, 36];
      if (choice) {
        const drawn = await UI.card(box, item(choice, entry.id), { x: pitch / 2, y: 60, scale: .25, label: false });
        actionBox = drawn.actionBox;
        // The entire area above Remove is a grab target, including the slanted artwork's transparent edges.
        Object.assign(drawn.hit.style, { left: "0", top: "0", width: `${pitch}px`, height: `${Math.max(0, actionBox[1] - 5)}px` });
        bindReorder(drawn.hit, { id: entry.id, index, count: list.length, scroll: cell.parentElement.parentElement, pitch,
          move: reorder, enabled: () => !isSaving(), signal: rowSignal, feedback: dragFeedback(drawn.visual, () => marker, pitch, list.length) });
      } else await UI.caption(box, T("hall.missing"), [5, 60, 240], { size: 28 });
      await UI.button(box, `Remove${entry.id}`, T("hall.remove"), actionBox, () => { if (!isSaving() && draft.remove(entry.id)) { onChange?.(); draw().catch(onError); } }, { enabled: list.length > 1 });
    }, { key: "memorial-playlist", horizontal: true, signal, positions, onError });
    marker = await UI.queueMarker(queue.inner, pitch);
    await queue.ready;
  }

  async function draw() {
    await modal.draw(async (layer, alive, signal) => { await toolbar(layer); if (!alive()) return; await (memorial ? drawMemorials(layer, alive, signal) : drawPortraits(layer, alive, signal)); },
      memorial ? [{ label: T("popup.cancel"), fn: safe(onCancel) }, { label: T("hall.savePlaylist"), fn: safe(onSave), enabled: draft.current().memorials.length > 0 }]
        : [{ label: T("hall.doneAdding"), fn: safe(onDone) }], memorial ? {} : { width: 2150, height: 1300 });
  }
  draw().catch(onError);
  const closeNested = () => { if (displayOwned && Popup.top()?.host?.id === "display") Popup.top().close?.("navigation"); displayOwned = false; };
  return { modal, redraw: draw, closeNested, close() { closeNested(); clearTimeout(debounce); work.cancel(); modal.close(); } };
}
