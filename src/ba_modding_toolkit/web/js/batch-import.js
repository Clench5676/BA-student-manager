// Unified import behaviour over runtime Items, Mailbox and FilterSort prefab widgets (import-layout.js).
import { importGroups } from "./import-groups.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Loading from "./loading.js";
import { rpc, spineBase, waitJob } from "./api.js";
import { L, T, language } from "./i18n.js";
import { customAliases, studentName } from "./names.js";
import { specialFraming } from "./special-view.js";
import { spineAllowed } from "./spine-runtime.js";
import { thumbnailScope } from "./thumbs.js";
import { S } from "./util.js";
import { ROW_W as OPTION_WIDTH, rowBase, radioRow } from "./settings-rows.js";
import { loadImportLayouts, importArtwork, clipButtonPatterns, ROW_SCALE, ROW_WIDTH, ROW_HEIGHT } from "./import-layout.js";
import { suggestImports } from "./import-assistants.js";
import { createImportState, countsOf, eligible, RESOURCE_TYPES, STATES } from "./import-state.js";

const KIND_KEYS = { spr: "tab.portrait", lobby: "tab.lobby", model: "tab.model", other: "import.other" };
const REASONS = new Set(["unreadable", "no_target", "conflict", "spine_version", "unsupported",
  "source_unknown", "source_conflict", "platform_unsupported", "target_unknown", "conversion_names", "no_matching_assets", "conversion_failed"]);
const OUTCOMES = new Set(["imported", "updated", "unchanged", "failed", "skipped"]);
const sizeText = (size) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil((size || 0) / 1024)} KB`;
const baseName = (path) => path?.split(/[\\/]/).pop() || "";
const listSeparator = () => /^(zh|ja)/i.test(language()) ? "、" : ", ";

export function catalogEntries(data) {
  return (data?.families || []).flatMap((family) => (family.variants || []).map((variant) => ({ ...variant, family })));
}
export function entryIdentity(entry, catalog) {
  const variant = catalog.find((item) => item.key === entry.variant)
    || catalog.find((item) => entry.core && [item.fileId, item.spr, item.lobby, item.model].includes(entry.core));
  const names = L(variant?.names);
  const name = studentName(variant?.family, names?.full || names?.short || entry.core || baseName(entry.paths?.[0]) || entry.id);
  return { variant, name, core: entry.core || variant?.fileId || entry.variant || baseName(entry.paths?.[0]),
    search: [name, entry.core, entry.variant, ...(entry.paths || []), ...customAliases(variant?.family),
      ...Object.values(variant?.names || {}).flatMap((value) => typeof value === "string" ? [value] : Object.values(value))].filter(Boolean).join(" ").toLocaleLowerCase() };
}

export function createImportPage({ host, call = rpc, jobs = waitJob, ui = NGUI, popups = Popup,
  thumbnails = thumbnailScope, allowed = spineAllowed, suggest = suggestImports, loading = Loading } = {}) {
  const model = createImportState({ rpc: call, waitJob: jobs, suggest, changed: () => context?.invalidateRoster?.() });
  let context = null, catalog = [], visible = false, root = null, scope = null;
  let query = "", filter = "all", ascending = true, searchOpen = false, rowsKey = null, previewKey = null, generation = 0;
  let rows = new Map(), identities = new WeakMap(), dom = {}, dialogClose = null, countsKey = null;
  let art = null, merged = false;
  const drawings = new Set();
  let loadingHold = null, left = Promise.resolve(), leave = () => {};
  const waiters = new Set();
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const waiting = () => drawings.size || ["analyzing", "running", "picking", "saving"].includes(model.state.phase);
  function importProgress() {
    const { phase, progress: p } = model.state;
    if (phase === "running") {
      const current = model.state.taskEntries.find((entry) => entry.id === p?.current);
      const action = ["update", "convert", "add", "apply"].includes(p?.phase) ? T(`import.phase.${p.phase}`) : T("job.running");
      return T("import.progress", { phase: action, name: current ? identified(current).name : "",
        kind: current ? T(KIND_KEYS[current.kind] || KIND_KEYS.other) : "", index: p?.index || 1,
        total: p?.total || model.state.taskEntries.length, step: T(p?.step || "import.step.check") });
    }
    const label = T(["analyzing", "picking", "saving"].includes(phase) ? `import.${phase}` : "app.loading");
    return p?.total > 0 ? T("import.waitProgress", { label, done: p.done || 0, total: p.total }) : label;
  }
  function holdArtwork() {
    if (!visible || loadingHold || !waiting()) return;
    const token = generation;
    const work = loading.hold(async () => {
      while (visible && token === generation && waiting()) {
        await new Promise((resolve) => waiters.add(resolve));
      }
    }, { until: left, all: true, progress: importProgress });
    loadingHold = work;
    work.catch((error) => console.error("Import loading", error)).finally(() => {
      if (loadingHold === work) { loadingHold = null; holdArtwork(); }
    });
  }
  const report = (error, entry = null) => {
    const code = typeof error === "string" ? error : error?.code;
    if (REASONS.has(code)) return T(`import.reason.${code}`);
    const key = `error.${code}`, text = T(key, { file: entry?.paths?.[0] || "", ...(error?.params || {}) });
    return code && code !== "internal" && text !== key ? text : T("import.failed");
  };
  const el = (tag, className = "", text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const tracked = (work) => {
    drawings.add(work);
    holdArtwork();
    work.catch((error) => console.error("Import artwork", error)).finally(() => { drawings.delete(work); wake(); });
    return work;
  };
  // DOM below is geometry, scrolling and accessible hit areas only. All visible widgets come from import-layout.js.
  const place = (element, x, y, width, height) => {
    Object.assign(element.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    return element;
  };
  function paint(element, tree, { scale = S, origin = [0, 0], textures = {}, onRender = null } = {}) {
    const version = element.paintVersion = (element.paintVersion || 0) + 1;
    const next = el("div", "import-art");
    const drawing = ui.render(tree, next, { scale, origin, textures, deferImages: true }).then((view) => {
      clipButtonPatterns(view);
      if (element.paintVersion === version) {
        element.art?.remove(); element.art = next; element.appendChild(next);
        onRender?.(view);
      }
      return Promise.allSettled(view.images || []).then(() => view);
    });
    return tracked(drawing);
  }
  function textWidget(element, caption, source = "note", { scale = 0.5, origin = [0, 0] } = {}) {
    if (element.caption === `${source}/${caption}`) return;
    element.caption = `${source}/${caption}`; paint(element, art[source](caption), { scale, origin });
  }
  function button(caption, action, { width = 180, primary = false, scale = 0.4 } = {}) {
    const b = el("button", "hit import-button"); b.type = "button"; b.dataset.action = action;
    Object.assign(b.style, { width: `${width}px`, height: `${(primary ? 166 : 162) * scale}px` });
    b.refresh = () => {
      const key = JSON.stringify([b.caption, b.disabled]); if (key === b.drawKey) return; b.drawKey = key;
      paint(b, art.button(b.caption, width / scale, primary, !b.disabled), { scale, origin: [width / 2, (primary ? 166 : 162) * scale / 2] });
    };
    setCaption(b, caption); return b;
  }
  function setCaption(b, caption) {
    b.caption = caption; b.setAttribute("aria-label", caption); b.refresh();
  }
  function checkbox(caption, checked, onChange) {
    const label = el("label", "import-check"), input = el("input", "hit"); input.type = "checkbox"; input.checked = checked;
    const graphic = place(el("div", "import-check-art"), 0, 0, 50, 50);
    input.setAttribute("aria-label", caption || T("import.select"));
    label.append(graphic, input);
    if (caption) {
      const copy = place(el("div"), 65, 0, 540, 55); label.appendChild(copy);
      textWidget(copy, caption, "empty", { scale: 0.4, origin: [280, 26] });
    }
    let previous = null;
    const refresh = () => {
      const key = `${input.checked}/${input.disabled}`; if (key === previous) return; previous = key;
      paint(graphic, art.checkbox(input.checked, input.disabled), { scale: 0.5, origin: [25, 25] });
    };
    input.addEventListener("change", () => { onChange(input.checked); refresh(); }); refresh();
    return { label, input, refresh };
  }
  function toggle(caption, checked, onChange) {
    const label = el("label", "import-toggle"), input = el("input", "hit"); input.type = "checkbox"; input.checked = checked;
    const graphic = el("div", "import-check-art"); input.setAttribute("aria-label", caption);
    label.append(graphic, input);
    let previous = null;
    const refresh = () => {
      const key = String(input.checked); if (key === previous) return; previous = key;
      const tree = art.toggle(caption, input.checked), body = tree.widgets.find((w) => "sprite" in w);
      label.style.width = `${body.w_ * S}px`; label.style.height = `${body.h_ * S}px`;
      paint(graphic, tree, { origin: [0, body.h_ * S / 2] });
    };
    input.addEventListener("change", () => { onChange(input.checked); refresh(); }); refresh();
    return { label, input, refresh };
  }
  // Match roster.js's native input and clear hit area to the rendered prefab labels/icons.
  function inputControl(caption, value, { type = "text", width = 650, search = false } = {}) {
    const wrap = el("div", "import-input-wrap"), input = el("input", `roster-search${search ? " import-search" : ""}`);
    input.type = type; input.value = value; input.setAttribute("aria-label", caption);
    input.autocomplete = "off"; input.spellcheck = false;
    Object.assign(wrap.style, { position: "relative", width: `${width}px`, height: `${112 * S}px` });
    Object.assign(input.style, art.inputStyle(S)); wrap.appendChild(input);
    const clear = search ? el("button", "hit import-search-clear") : null;
    if (clear) { clear.type = "button"; clear.setAttribute("aria-label", T("display.reset")); wrap.appendChild(clear); }
    paint(wrap, art.search(width / S, search), { scale: S, origin: [width / 2, 0], onRender: (view) => {
      const [x, y, w, h] = Popup.nodeRect(view, "SearchNameArea/InputField/Label_Search");
      place(input, x, y + h / 2 - 46 * S, w, 92 * S);
      if (clear) {
        const [cx, cy, cw, ch] = Popup.nodeRect(view, "SearchNameArea/Btn_Close");
        place(clear, cx + cw / 2 - 55 * S, cy + ch / 2 - 55 * S, 110 * S, 110 * S);
      }
    } });
    return { wrap, input, clear };
  }
  // The state filter uses FilterSort/UISortObjectListUnit, as in display.js.
  function radioOptions(area, values, value, onChange, { width = 1370, columns = 1 } = {}) {
    const controls = [];
    const refresh = () => {
      for (const c of controls) {
        c.button.setAttribute("aria-checked", String(c.value === value));
        paint(c.button, art.radio(c.caption, c.value === value, width / columns / 0.5 - 50), { scale: 0.5, origin: [35, 44] });
      }
    };
    const group = el("div", "import-radio-group"); group.setAttribute("role", "radiogroup");
    Object.assign(group.style, { position: "relative", height: `${Math.ceil(values.length / columns) * 96}px` });
    values.forEach(([key, caption], i) => {
      const button = place(el("button", "hit"), i % columns * width / columns, Math.floor(i / columns) * 96, width / columns - 15, 92);
      button.type = "button"; button.setAttribute("role", "radio"); button.setAttribute("aria-label", caption); button.dataset.value = key;
      button.addEventListener("click", () => { value = key; onChange(key); refresh(); });
      controls.push({ value: key, caption, button }); group.appendChild(button);
    });
    area.appendChild(group); refresh(); return group;
  }
  const identified = (entry) => {
    if (!identities.has(entry)) identities.set(entry, entryIdentity(entry, catalog));
    return identities.get(entry);
  };
  const rowNote = (entry) => entry.state === "blocked" ? report(entry.reason, entry) : "";

  function build() {
    root = el("div", "import-page"); root.dataset.phase = model.state.phase;
    dom.background = el("div", "import-background"); root.appendChild(dom.background);
    paint(dom.background, art.background(), { origin: [960, 540] });
    dom.preview = place(el("div", "import-detail"), 46, 132, 524, 700); root.appendChild(dom.preview);
    // Items/ListBG: the two-column frame retains its paper/inbox insets, with a mail list in place of the item grid.
    const panel = place(el("div", "import-panel"), 602, 132, 1272, 704);
    paint(panel, art.panel(1272 / S, 704 / S), { origin: [636, 352] });
    dom.header = place(el("div", "import-header"), 0, 0, 1272, 136 * S);
    dom.count = el("div", "import-count"); panel.append(dom.header, dom.count);
    const search = inputControl(T("import.search"), query, { width: 1220, search: true });
    dom.search = search.input; dom.search.placeholder = T("import.search"); dom.search.enterKeyHint = "search";
    dom.searchWrap = place(search.wrap, 26, art.searchTop() * S + 58, 1220, 112 * S);
    const runSearch = () => { query = dom.search.value.toLocaleLowerCase(); renderRows(); };
    dom.search.addEventListener("input", (event) => { if (!event.isComposing) runSearch(); }); dom.search.addEventListener("compositionend", runSearch);
    search.clear.addEventListener("click", () => { dom.search.value = ""; runSearch(); dom.search.focus(); });
    dom.search.addEventListener("keydown", (event) => {
      if (!event.isComposing && event.keyCode !== 229 && event.key === "Enter") dom.search.blur();
    });
    for (const key of ["searchToggle", "filter", "order"]) {
      dom[key] = el("button", "hit"); dom[key].type = "button"; dom[key].dataset.action = key;
      dom.header.appendChild(dom[key]);
    }
    dom.searchToggle.setAttribute("aria-label", T("import.search"));
    panel.appendChild(search.wrap);
    dom.merge = toggle(T("import.merge"), merged, (checked) => { merged = checked; rowsKey = null; renderRows(); });
    dom.merge.label.dataset.action = "merge"; panel.appendChild(dom.merge.label);
    dom.list = el("div", "import-list"); dom.list.setAttribute("aria-label", T("import.list")); panel.appendChild(dom.list);
    layoutList();
    for (const [key, caption, x, width] of [["files", "addFiles", 26, 196], ["folder", "addFolder", 238, 220],
      ["all", "all", 474, 150], ["none", "none", 640, 180], ["remove", "remove", 836, 180], ["clear", "clear", 1032, 214]]) {
      dom[key] = button(T(`import.${caption}`), key, { width, scale: 0.34 }); place(dom[key], x, 629, width, 56); panel.appendChild(dom[key]);
    }
    root.appendChild(panel);
    dom.status = place(el("div", "import-progress"), 50, 858, 800, 90); dom.status.setAttribute("role", "status"); dom.status.setAttribute("aria-live", "polite"); root.appendChild(dom.status);
    dom.options = button(T("import.options.title"), "options", { width: 290, scale: 0.5 });
    dom.recheck = button(T("import.recheck"), "recheck", { width: 230, scale: 0.5 });
    dom.start = button(T("import.action", { n: 0 }), "start", { width: 330, scale: 0.6, primary: true });
    // As on the roster/detail screens, reserve the nav's entire 104 px area, with 24 px above it.
    const footerY = 902;
    place(dom.options, 958, footerY - 40.5, 290, 81); place(dom.recheck, 1272, footerY - 40.5, 230, 81);
    place(dom.start, 1528, footerY - 49.8, 330, 99.6);
    root.append(dom.options, dom.recheck, dom.start);
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target || target.disabled) return;
      const actions = { files: () => model.pick(false), folder: pickFolder, filter: openFilter, searchToggle: () => {
        searchOpen = !searchOpen; layoutList(); renderToolbar();
        if (searchOpen) dom.search.focus(); else dom.search.blur();
      }, order: () => {
        ascending = !ascending; renderToolbar(); renderRows();
      }, all: () => model.checkAll(true), none: () => model.checkAll(false), remove: () => model.remove(), clear: () => model.clear(),
      options: openOptions, recheck: () => model.recheck(), start: () => model.state.phase === "done" ? results() : start() };
      Promise.resolve(actions[target.dataset.action]?.()).catch((error) => { textWidget(dom.status, report(error)); });
    });
    root.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = model.busy() ? "none" : "copy"; });
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      const paths = [...(event.dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
      if (paths.length) model.add(paths);
      // Browser File objects do not expose native paths; the native window drop event handles them in the app.
      else if (!context?.info?.native) textWidget(dom.status, T("error.native_unavailable"));
    });
    host.replaceChildren(root); rowsKey = previewKey = countsKey = null;
  }

  function layoutList() {
    const top = searchOpen ? 294 : 202;
    dom.searchWrap.hidden = !searchOpen;
    dom.searchToggle.setAttribute("aria-expanded", String(searchOpen));
    place(dom.count, 996, 90, 250, 32);
    place(dom.list, 26, top, 1220, 616 - top);
  }
  function renderToolbar() {
    const options = filterOptions(), caption = options.find(([value]) => value === filter)?.[1] || options[0][1];
    const key = JSON.stringify([T("import.list"), caption, filter, ascending, searchOpen]);
    if (countsKey === key) return; countsKey = key;
    dom.filter.setAttribute("aria-label", caption);
    dom.order.setAttribute("aria-label", T(ascending ? "roster.asc" : "roster.desc"));
    paint(dom.header, art.header(1272 / S, T("import.list"), caption, filter !== "all", ascending, searchOpen), { onRender: (view) => {
      for (const [key, path] of [["searchToggle", `SearchBtn/${searchOpen ? "Btn_Pressed" : "Btn_Normal"}`], ["filter", "SortBtn/Btn_Normal"], ["order", "OrderBtn/Btn_Normal"]]) {
        place(dom[key], ...Popup.nodeRect(view, `BG_Top_Widget/${path}`));
      }
      // as on the roster's top menu: the toggle follows the title, ending a gap before the first tool
      const [x, y, , h] = Popup.nodeRect(view, `BG_Top_Widget/SearchBtn/${searchOpen ? "Btn_Pressed" : "Btn_Normal"}`), style = dom.merge.label.style;
      Object.assign(style, { left: `${x - 16 - parseFloat(style.width)}px`, top: `${y + (h - parseFloat(style.height)) / 2}px` });
    } });
  }
  const filterOptions = () => {
    const counts = countsOf(model.state.entries);
    return [["all", T("import.filterCount", { state: T("seg.all"), n: model.state.entries.length })],
      ...STATES.map((state) => [state, T("import.filterCount", { state: T(`import.state.${state}`), n: counts[state] })])];
  };
  async function openFilter() {
    let draft = filter;
    await dialog(T("import.filter"), { action: T("picker.ok"), cancel: T("popup.cancel"), onAction: () => {
      filter = draft; countsKey = null; render(); return true;
    } }, (area) => radioOptions(area, filterOptions(), draft, (value) => { draft = value; }));
  }

  // Pictures stay in the actual prefab UITexture widgets; no separate DOM picture/frame is assembled.
  function setTexture(image, source, large) {
    if (!source) return;
    image.dataset.source = source;
    Object.assign(image.style, { backgroundImage: `url(${JSON.stringify(source)})`, backgroundSize: large ? "contain" : "cover", backgroundPosition: large ? "center top" : "center", backgroundRepeat: "no-repeat" });
  }
  function bindTexture(drawing, path, source, className, large = false) {
    const token = generation;
    // Retain the UITexture rectangle while its generated still is pending. No catalog/game texture is shown first.
    drawing.then((view) => {
      const image = view.nodes.get(path)?.els[0];
      if (image) {
        image.classList.add(className);
        Object.assign(image.style, { overflow: "hidden", clipPath: "inset(0)" });
      }
    }).catch(() => {});
    return tracked(Promise.all([drawing, source]).then(([view, url]) => {
      const image = view.nodes.get(path)?.els[0];
      if (image && visible && token === generation && image.isConnected) setTexture(image, url, large);
      return image;
    }));
  }
  function incomingBase(entry) {
    if (!["spr", "lobby"].includes(entry.kind)) return null;
    const libraryId = model.state.results.find((result) => result.id === entry.id)?.libraryId || entry.libraryId;
    if (libraryId) return spineBase("mod", libraryId);
    return entry.preview?.kind === "import" && entry.preview.key ? spineBase("import", entry.preview.key) : null;
  }
  const representative = (entries) => entries.find((entry) => incomingBase(entry)) || entries.find(eligible) || entries[0];
  function thumbnail(entry, { incoming = false, large = false } = {}) {
    const { variant } = identified(entry);
    const signal = scope?.signal;
    const kind = entry.kind;
    const key = kind === "spr" ? variant?.spr || entry.core : kind === "lobby" ? variant?.lobby || entry.core : null;
    const base = incoming ? incomingBase(entry)
      : key ? spineBase(kind, key) : null;
    const work = allowed() && base && scope
      ? scope.thumb(base, large ? "bust" : "card", null, kind === "lobby", specialFraming(variant), variant?.bg) : Promise.resolve(null);
    if (large) work.bump?.();
    const source = Promise.resolve(work).then(async (url) => {
      if (url && ui.load) await ui.load(url, { signal });
      return url;
    }).catch(() => null);
    return source;
  }

  function renderPreview() {
    const entry = model.state.entries.find((item) => item.id === model.state.selected);
    const key = JSON.stringify([entry?.id, entry?.libraryId, entry?.preview, entry?.source, entry?.target, model.busy(), model.state.phase, model.state.results, allowed()]);
    if (key === previewKey) return; previewKey = key;
    const next = el("div", "import-detail-content");
    if (entry) {
      const identity = identified(entry);
      for (const incoming of [false, true]) {
        const box = place(el("div", `import-preview${incoming ? " incoming" : ""}`), incoming ? 270 : 0, 0, 254, 136 * S + 837 * 0.46);
        const source = thumbnail(entry, { incoming, large: true });
        const drawing = paint(box, art.preview(T(incoming ? "import.incoming" : "import.current"), 136 * S / 0.46), {
          scale: 0.46, origin: [127, 0], textures: { "Texture": Promise.resolve(null) },
        });
        bindTexture(drawing, "EquipPos/Texture", source, "import-preview-image", true);
        if (incoming && !incomingBase(entry)) {
          const note = place(el("div"), 0, 474, 254, 45); note.style.zIndex = "20"; box.appendChild(note);
          textWidget(note, T("import.previewUnavailable"), "empty", { scale: 0.4, origin: [127, 23] });
        }
        next.appendChild(box);
      }
      const banner = place(el("div", "import-name-banner"), 0, 526, 524, 120);
      paint(banner, art.banner(identity.name, T(KIND_KEYS[entry.kind] || KIND_KEYS.other)), { scale: 0.42, origin: [255, 104] });
      next.appendChild(banner);
      if (entry.target) next.appendChild(sourceControl(entry));
    }
    dom.preview.replaceChildren(next);
  }

  function sourceLabel(source) {
    if (!source || !source.platform) return T("import.source.unknown");
    return `${T(`settings.server.${source.server}`)} ${T(`import.source.${source.platform}`)}`;
  }
  function sourceControl(entry) {
    const group = el("div", "import-source");
    const choose = button(T("import.source.choose"), "source", { width: 524, scale: 0.34 });
    place(choose, 0, 645, 524, 55); choose.disabled = model.busy() || model.state.phase === "done"; choose.refresh();
    choose.addEventListener("click", () => openSource(entry).catch((error) => textWidget(dom.status, report(error)))); group.append(choose); return group;
  }
  async function openSource(entry) {
    if (model.busy()) return;
    let server = entry.source?.server || entry.target.server, platform = entry.source?.platform || "android";
    await dialog(T("import.source.choose"), { action: T("picker.ok"), cancel: T("popup.cancel"),
      onAction: () => model.setSource(entry.id, server, platform) }, (area) => {
      const choices = (key, values, value, change) => {
        const title = el("div"); title.style.height = "60px"; area.appendChild(title);
        textWidget(title, T(`import.source.${key}`), "empty", { scale: 0.5, origin: [685, 30] });
        const group = radioOptions(area, values, value, change, { columns: values.length });
        group.setAttribute("aria-label", T(`import.source.${key}`));
      };
      choices("server", ["global", "japan"].map((value) => [value, T(`settings.server.${value}`)]), server, (value) => { server = value; });
      choices("platform", ["android", "ios", "windows"].map((value) => [value, T(`import.source.${value}`)]), platform, (value) => { platform = value; });
    });
  }

  function renderRows() {
    if (!visible || !root) return;
    const groups = importGroups(model.state.entries, merged, identified).filter((group) => group.entries.some((entry) =>
      (filter === "all" || entry.state === filter) && identified(entry).search.includes(query)));
    const entries = groups.map((group) => group.entries[0]);
    const collator = new Intl.Collator(language(), { numeric: true, sensitivity: "base" });
    groups.sort((a, b) => (ascending ? 1 : -1) * collator.compare(identified(a.entries[0]).name, identified(b.entries[0]).name));
    const key = JSON.stringify([merged, groups]);
    if (key !== rowsKey) {
      rowsKey = key; const previous = rows; rows = new Map();
      const contents = [];
      if (!entries.length) {
        const empty = place(el("div", "import-empty"), 0, 120, 1200, 180);
        textWidget(empty, T(model.state.entries.length ? "import.noMatch" : "import.empty"), "empty", { origin: [600, 40] });
        if (!model.state.entries.length) {
          const note = place(el("div"), 0, 80, 1200, 100); empty.appendChild(note);
          textWidget(note, T("import.drop"), "empty", { scale: 0.5, origin: [600, 45] });
        }
        contents.push(empty);
      }
      for (const group of groups) {
        const entry = representative(group.entries);
        const existing = previous.get(group.key), signature = JSON.stringify(group);
        if (existing?.signature === signature) { rows.set(group.key, existing); contents.push(existing.row); continue; }
        const row = existing?.row || el("div", "import-row"); row.dataset.entry = entry.id;
        row.replaceChildren(); row.paintVersion = (row.paintVersion || 0) + 1; row.art = null;
        const name = identified(entry).name;
        const source = thumbnail(entry, { incoming: true });
        const drawing = paint(row, art.row({ name, kind: T(KIND_KEYS[entry.kind] || KIND_KEYS.other), state: T(`import.state.${entry.state}`), stateKey: entry.state,
          counts: merged ? group.counts : null, badge: !merged, meta: merged ? [...new Set(group.entries.map((item) => T(`import.state.${item.state}`)))].join(listSeparator())
            : T(entry.files?.length === 1 ? "import.metaOne" : "import.meta", { id: identified(entry).core, n: entry.files?.length || 0, size: sizeText(entry.size) }),
          route: [...new Set(group.entries.filter((item) => item.target).map((item) => T("import.source.route", {
            source: sourceLabel(item.source), target: sourceLabel(item.target) })))].join(listSeparator()),
          note: [...new Set(group.entries.map(rowNote).filter(Boolean))].join(listSeparator()), muted: !eligible(entry) }),
        { scale: ROW_SCALE, origin: [ROW_WIDTH / 2, 329 * ROW_SCALE / 2], textures: { "Icon_Arona": Promise.resolve(null) } });
        // MailboxContent/List_01 or List_02/BG_Icon/Icon_Arona is the incoming Mod's real texture slot.
        bindTexture(drawing, `${eligible(entry) ? "List_01" : "List_02"}/BG_Icon/Icon_Arona`, source, "import-thumb");
        const copy = place(el("button", "hit import-row-copy"), 0, 0, ROW_WIDTH - 72, ROW_HEIGHT - 10); copy.type = "button"; copy.setAttribute("aria-label", name);
        copy.addEventListener("click", () => model.select(entry.id));
        const check = checkbox("", model.state.checked.has(entry.id), (checked) => model.toggleGroup(group.entries.map((item) => item.id), checked));
        check.input.setAttribute("aria-label", T("import.selectNamed", { name })); place(check.label, ROW_WIDTH - 66, 78, 50, 50);
        const selection = place(el("div", "import-selection"), 19, 8, 164, 160);
        paint(selection, art.selection(), { scale: 0.68, origin: [82, 80] });
        row.append(selection, copy, check.label); contents.push(row); rows.set(group.key, { row, copy, selection, input: check.input, refresh: check.refresh, group, signature });
      }
      dom.list.replaceChildren(...contents);
    }
    for (const row of rows.values()) {
      const ids = row.group.entries.map((entry) => entry.id), selectable = row.group.entries.filter(eligible);
      // Items' selection mark is kept on the thumbnail, separate from the import checkbox.
      row.row.dataset.selected = String(ids.includes(model.state.selected));
      row.selection.hidden = !ids.includes(model.state.selected);
      row.copy.setAttribute("aria-pressed", String(ids.includes(model.state.selected)));
      row.input.checked = selectable.length > 0 && selectable.every((entry) => model.state.checked.has(entry.id));
      row.input.indeterminate = !row.input.checked && selectable.some((entry) => model.state.checked.has(entry.id));
      row.input.disabled = model.busy() || !model.state.valid || model.state.phase === "done" || !selectable.length;
      row.refresh();
    }
  }

  function render() {
    if (!visible || !root) return;
    const state = model.state, busy = model.busy(); root.dataset.phase = state.phase; root.setAttribute("aria-busy", String(busy));
    textWidget(dom.count, T("import.count", { n: state.entries.length }), "count", { scale: 0.5, origin: [250, 0] });
    renderToolbar();
    dom.merge.input.disabled = busy; dom.merge.refresh();
    for (const key of ["files", "folder", "options", "clear", "remove", "all", "none", "recheck"]) dom[key].disabled = busy;
    dom.clear.disabled ||= !state.entries.length; dom.remove.disabled ||= !state.selected;
    dom.recheck.disabled ||= !state.entries.length && !state.error;
    dom.all.disabled ||= !state.valid || state.phase === "done" || !state.entries.some(eligible);
    dom.none.disabled ||= !state.valid || state.phase === "done" || !state.checked.size;
    dom.start.disabled = busy || state.phase !== "done" && (!state.valid || !model.selected().length);
    setCaption(dom.start, state.phase === "done" ? T("import.results") : T("import.action", { n: model.selected().length }));
    for (const key of ["files", "folder", "options", "clear", "remove", "all", "none", "recheck"]) dom[key].refresh();
    let status = "";
    if (state.error) status = report(state.error);
    else if (["analyzing", "picking", "saving"].includes(state.phase)) status = T(`import.${state.phase}`);
    else if (state.phase === "done") status = T("import.complete", { n: state.results.filter((r) => r.outcome !== "failed" && r.outcome !== "skipped").length, failed: state.results.filter((r) => r.outcome === "failed").length });
    dom.status.hidden = state.phase === "running";
    textWidget(dom.status, status, state.error ? "error" : "note", { scale: 0.5, origin: [state.error ? 400 : 0, 35] });
    renderRows(); renderPreview();
  }

  const start = () => model.start();
  // Popup.message adds UIPopup_GachaCharList/Btn_Checkbox to the same Sort frame for recursive scanning.
  async function pickFolder() {
    const result = await popups.message({ title: T("import.addFolder"), lines: [],
      check: { label: T("import.recursive"), checked: false }, ok: T("picker.ok"), cancel: T("popup.cancel") });
    if (visible && result.button === "ok") await model.pick(true, result.checked);
  }

  // Popup.popupFrame clones UIPopup_Sort/Center: Base/BG, Btn_Close and Btn/Btn_Ok / Btn_Cancel.
  async function dialog(title, { action = T("display.close"), cancel = null, onAction = () => true, width = 2458, bodyWidth = null } = {}, content) {
    await popups.ready();
    if (!visible || dialogClose) return;
    const dialogHost = document.getElementById("dialog"), layer = el("div", "popup-layer import-dialog-layer"), before = document.activeElement;
    layer.tabIndex = -1; dialogHost.hidden = false; dialogHost.appendChild(layer);
    let ended = false, working = false;
    const close = (force = false) => {
      if (ended || working && force !== true) return; ended = true; layer.remove(); popups.closed(dialogHost, layer);
      if (!dialogHost.children.length) dialogHost.hidden = true;
      dialogClose = null; if (before?.isConnected) before.focus?.({ preventScroll: true });
    };
    dialogClose = () => close(true);
    popups.opened(dialogHost, close, { el: layer, loading: true });
    try {
      const view = await ui.render(popups.popupFrame(title, width, 1360, { ok: action, cancel }), layer, { scale: S, origin: [960, 540], z: 10 });
      if (ended) return;
      const area = el("div", "import-dialog-content");
      if (bodyWidth) Object.assign(area.style, { left: `${960 - bodyWidth / 2 - 16}px`, width: `${bodyWidth + 32}px` });
      layer.appendChild(area); await content(area);
      const finish = async () => {
        if (working) return; working = true; layer.setAttribute("aria-busy", "true");
        try {
          if (await onAction(area)) { working = false; close(); }
        } finally { working = false; layer.setAttribute("aria-busy", "false"); }
      };
      popups.hit(layer, view, "Center/Popup/Btn/Btn_Ok/BG (1)", finish, { name: action, action: "ok" });
      if (cancel) popups.hit(layer, view, "Center/Popup/Btn/Btn_Cancel/BG (1)", close, { name: cancel, action: "cancel" });
      popups.hit(layer, view, "Center/Popup/Base/BG/Btn_Close", close, { name: T("display.close"), action: "close" });
      popups.closable(view, dialogHost, close, { el: layer });
      layer.setAttribute("role", "dialog"); layer.setAttribute("aria-modal", "true"); layer.setAttribute("aria-label", title);
      layer.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const focusable = [...layer.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")];
        const first = focusable[0], last = focusable.at(-1);
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === layer)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === layer)) { event.preventDefault(); first.focus(); }
      });
      await (popups.reveal ? popups.reveal(layer, [...drawings]) : Promise.all([...drawings]));
      if (!ended) layer.focus?.({ preventScroll: true });
    } catch (error) { close(); throw error; }
  }

  async function openOptions() {
    if (model.busy() || !await model.loadOptions()) return;
    const draft = { ...model.state.options, types: [...model.state.options.types] };
    let error;
    await dialog(T("import.options.title"), { action: T("picker.ok"), cancel: T("popup.cancel"), width: 1800, bodyWidth: OPTION_WIDTH * S, onAction: async () => {
      if (!draft.types.length || !Number.isSafeInteger(draft.workers) || draft.workers < 1) {
        textWidget(error, T(!draft.types.length ? "import.options.typesRequired" : "import.options.workersInvalid"), "error", { origin: [OPTION_WIDTH * S / 2, 35] }); return false;
      }
      const saved = await model.saveOptions(draft); if (!saved) textWidget(error, report(model.state.error), "error", { origin: [OPTION_WIDTH * S / 2, 35] }); return saved;
    } }, (area) => {
      const add = (key, height) => {
        const group = el("div", "import-option"); group.dataset.option = key;
        Object.assign(group.style, { width: `${OPTION_WIDTH * S}px`, height: `${height * S}px`, marginBottom: `${24 * S}px` });
        area.appendChild(group); return group;
      };
      const choice = (key, title, values, getValue, onPick, { multiple = false, parent = area } = {}) => {
        const makeRow = () => radioRow(`Option_${key}`, 0, title, values, getValue(), onPick, { columns: Math.min(values.length, 3) });
        const group = add(key, makeRow().h), controls = [];
        if (parent !== area) parent.appendChild(group);
        group.setAttribute("role", multiple ? "group" : "radiogroup"); group.setAttribute("aria-label", title);
        const refresh = () => {
          const row = makeRow();
          values.forEach(([value], i) => {
            const checked = multiple ? getValue().has(value) : value === getValue();
            const option = ui.find(row.tree, `Opt_${i}`), control = controls[i];
            if (multiple) {
              const check = art.checkbox(checked); check.scale = [0.6, 0.6];
              option.children = [check, ui.find(option, "Label")]; control.checked = checked;
            } else control.setAttribute("aria-checked", String(checked));
          });
          paint(group, row.tree, { scale: S, origin: [OPTION_WIDTH * S / 2, row.h * S / 2] });
        };
        const row = makeRow();
        values.forEach(([value, caption], i) => {
          const option = ui.find(row.tree, `Opt_${i}`), hit = row.hits[i];
          const control = place(el(multiple ? "input" : "button", "hit import-option-control"),
            (OPTION_WIDTH / 2 + option.pos[0] - 30) * S, (row.h / 2 - option.pos[1] - 30) * S, hit.w * S, 60 * S);
          control.type = multiple ? "checkbox" : "button";
          if (!multiple) control.setAttribute("role", "radio");
          control.setAttribute("aria-label", caption); control.dataset.value = String(value);
          control.addEventListener(multiple ? "change" : "click", () => { onPick(value, control.checked); refresh(); });
          controls.push(control); group.appendChild(control);
        });
        refresh(); return refresh;
      };
      const onOff = [[true, T("settings.post.on")], [false, T("settings.post.off")]];
      for (const key of ["enableAfterImport", "skipUnchanged", "backup"]) {
        choice(key, T(`import.options.${key}`), onOff, () => draft[key], (value) => { draft[key] = value; });
      }
      const radio = (key, values) => choice(key, T(`import.options.${key}`), values, () => draft[key], (value) => { draft[key] = value; });
      radio("strategy", ["cont_name_type", "path_id", "name_type"].map((key) => [key, T(`import.strategy.${key}`)]));
      radio("crc", [["auto", T("import.auto")], ["on", T("settings.post.on")], ["off", T("settings.post.off")]]);
      radio("compression", [["lzma", "LZMA"], ["lz4", "LZ4"], ["original", T("import.original")], ["none", T("import.uncompressed")]]);
      const types = el("fieldset", "import-resource-types"); types.setAttribute("aria-label", T("import.options.types")); area.appendChild(types);
      choice("types", T("import.options.types"), RESOURCE_TYPES.map((type) => [type, type === "ALL" ? T("import.options.allTypes") : type]),
        () => new Set(draft.types), (type, checked) => {
          const values = new Set(draft.types); if (checked) values.add(type); else values.delete(type);
          if (checked && type === "ALL") { values.clear(); values.add("ALL"); } else if (checked) values.delete("ALL");
          draft.types = [...values];
        }, { multiple: true, parent: types });
      for (const key of ["extraBytes", "workers", "output"]) {
        const group = add(key, 240);
        paint(group, rowBase(`Option_${key}`, 0, 240, T(`import.options.${key}`)), { scale: S, origin: [OPTION_WIDTH * S / 2, 120 * S] });
        const control = inputControl(T(`import.options.${key}`), draft[key] ?? "", { type: key === "workers" ? "number" : "text", width: (OPTION_WIDTH - 110) * S });
        place(control.wrap, 55 * S, 120 * S, (OPTION_WIDTH - 110) * S, 112 * S); group.appendChild(control.wrap);
        const input = control.input;
        if (key === "workers") { input.min = "1"; input.step = "1"; }
        input.addEventListener("input", () => { draft[key] = key === "workers" ? Number(input.value) : key === "output" ? input.value.trim() || null : input.value; });
      }
      const note = el("div", "import-option-note"); note.style.height = "70px"; area.appendChild(note);
      textWidget(note, T("import.options.bytesHint"), "empty", { origin: [OPTION_WIDTH * S / 2, 35] });
      error = el("div", "import-option-error"); error.style.height = "80px"; error.setAttribute("role", "alert"); area.appendChild(error);
    });
  }

  async function results() {
    await dialog(T("import.resultTitle"), {}, (area) => {
      area.classList.add("import-results");
      for (const group of importGroups(model.state.taskEntries, merged, identified)) {
        const entry = representative(group.entries), row = el("div", "import-result-row");
        const resultItems = group.entries.map((item) => ({ entry: item, result: model.state.results.find((result) => result.id === item.id) }));
        row.dataset.result = entry.id;
        const outcomes = [...new Set(resultItems.map(({ result }) => T(`import.outcome.${OUTCOMES.has(result?.outcome) ? result.outcome : "failed"}`)))];
        const notes = [...new Set(resultItems.map(({ entry, result }) => result?.reason ? report(result.reason, entry)
          : ["imported", "updated", "unchanged"].includes(result?.outcome) ? T(result.applied ? "import.applied" : "import.notApplied") : "").filter(Boolean))];
        const source = thumbnail(entry, { incoming: true });
        const drawing = paint(row, art.row({ name: identified(entry).name, kind: T(KIND_KEYS[entry.kind] || KIND_KEYS.other),
          badge: false, counts: merged ? group.counts : null, meta: outcomes.join(", "), note: notes.join(", ") }),
        { scale: 0.62, origin: [700, 104], textures: { "Icon_Arona": Promise.resolve(null) } });
        bindTexture(drawing, "List_01/BG_Icon/Icon_Arona", source, "import-thumb");
        const go = button(T("add.go"), "go", { width: 225, scale: 0.4 });
        place(go, 1115, 86, 225, 65);
        const navigate = (item) => {
          dialogClose?.();
          const variant = identified(item).variant;
          if (item.kind === "other" || !variant) context?.goOther?.();
          else context?.go?.(variant.family.key, variant.key, item.kind === "spr" ? "portrait" : item.kind);
        };
        go.addEventListener("click", () => navigate(entry));
        if (merged) drawing.then((view) => {
          for (const kind of Object.keys(group.counts).filter((kind) => group.counts[kind])) {
            const item = group.entries.find((item) => item.kind === kind);
            const path = `List_01/Label_From/${kind}`;
            const boxes = ["Count", "Icon"].map((part) => Popup.nodeRect(view, `${path}/${part}`)).filter(Boolean);
            const x = Math.min(...boxes.map(([x]) => x)), y = Math.min(...boxes.map(([, y]) => y));
            const right = Math.max(...boxes.map(([x, , w]) => x + w)), bottom = Math.max(...boxes.map(([, y, , h]) => y + h));
            const count = place(el("button", "hit import-result-count"), x, y, right - x, bottom - y);
            count.style.zIndex = "40";
            count.type = "button"; count.dataset.kind = kind;
            count.setAttribute("aria-label", T(KIND_KEYS[kind] || KIND_KEYS.other));
            count.addEventListener("click", () => navigate(item)); row.appendChild(count);
          }
        });
        row.appendChild(go); area.appendChild(row);
      }
    });
  }

  model.subscribe(() => { render(); wake(); holdArtwork(); loading.refresh?.(); });
  return {
    model,
    async show(ctx, data) {
      leave(); wake(); left = new Promise((resolve) => { leave = resolve; });
      context = ctx; catalog = catalogEntries(data); identities = new WeakMap(); visible = true;
      const token = ++generation;
      scope?.cancel(); scope = thumbnails();
      if (!art) { await ui.init(); art = importArtwork({ ...ui, translate: T }, await loadImportLayouts(ui)); }
      if (!visible || token !== generation) return;
      if (!root) build();
      for (const row of rows.values()) row.signature = null;
      rowsKey = previewKey = null; render();
      // The page is usable while these read; a failed options read can be retried from Advanced Options or Import.
      model.loadOptions();
      await Promise.all([...drawings]); await ui.decoded(root, 15000);
    },
    hide() { visible = false; generation++; leave(); wake(); scope?.cancel(); dialogClose?.(); },
    drop(paths) { return model.add(paths); },
    openOptions, results,
    async settled() { await Promise.all([...drawings]); },
  };
}

let page;
export function show(context, data) {
  page ||= createImportPage({ host: document.getElementById("import") });
  return page.show(context, data);
}
export function hide() { page?.hide(); }
export function drop(paths) { return page?.drop(paths); }
export function invalidate() { page?.model.invalidate(); }
