// Unified import screen. The game supplies the frame, plates and button artwork; native controls provide input.
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, spineBase, spriteUrl, waitJob } from "./api.js";
import { resizeButton } from "./button-layout.js";
import { L, T, language } from "./i18n.js";
import { customAliases, studentName } from "./names.js";
import { specialFraming } from "./special-view.js";
import { spineAllowed } from "./spine-runtime.js";
import { thumbnailScope } from "./thumbs.js";
import { S, clone } from "./util.js";
import { suggestImports } from "./import-assistants.js";
import { createImportState, countsOf, eligible, RESOURCE_TYPES, STATES } from "./import-state.js";

const KIND_KEYS = { spr: "tab.portrait", lobby: "tab.lobby", model: "tab.model", other: "import.other" };
const REASONS = new Set(["unreadable", "no_target", "conflict", "spine_version", "unsupported"]);
const OUTCOMES = new Set(["imported", "updated", "unchanged", "failed", "skipped"]);
const fallbackIcon = () => spriteUrl("Common", "Common_Icon_Student");
const sizeText = (size) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil((size || 0) / 1024)} KB`;
const baseName = (path) => path?.split(/[\\/]/).pop() || "";

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
  thumbnails = thumbnailScope, allowed = spineAllowed, suggest = suggestImports } = {}) {
  const model = createImportState({ rpc: call, waitJob: jobs, suggest, changed: () => context?.invalidateRoster?.() });
  let context = null, catalog = [], visible = false, root = null, scope = null, observer = null;
  let query = "", filter = "all", ascending = true, rowsKey = null, previewKey = null, generation = 0;
  let rows = new Map(), identities = new WeakMap(), dom = {}, dialogClose = null, countsKey = null;
  const drawings = new Set();
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
    work.catch((error) => console.error("Import artwork", error)).finally(() => drawings.delete(work));
    return work;
  };
  const skin = (element, width, height, { color = "#ffffff", sprite = "Common_Bg_Raius10px", border = null } = {}) => {
    const plate = el("div", "import-skin"); element.appendChild(plate); plate.setAttribute("aria-hidden", "true");
    const tree = ui.node("Plate", [width / 2, -height / 2], [ui.sprite(sprite, width, height, { color: `${color}/1.00` })],
      border ? [ui.node("Border", [0, 0], [ui.sprite("Common_Line_Raius10px", width, height, { depth: 7, color: `${border}/1.00` })])] : []);
    tracked(ui.render(tree, plate, { scale: 1, origin: [0, 0] }));
    return plate;
  };
  function button(caption, action, { width = 170, height = 48, primary = false } = {}) {
    const b = el("button", `import-button${primary ? " primary" : ""}`); b.type = "button";
    b.dataset.action = action; b.setAttribute("aria-label", caption);
    Object.assign(b.style, { width: `${width}px`, height: `${height}px` });
    const plate = el("div", "import-skin"); plate.setAttribute("aria-hidden", "true");
    const text = el("span", "import-button-label", caption); b.append(plate, text);
    const tree = ui.node("Button", [width / 2, -height / 2], [ui.sprite("Common_Btn_BG", 300, height,
      { incline: 10, color: `${primary ? "#ffe34f" : "#8de4ff"}/1.00` })], [
      ui.node("Pattern", [80, 0], [ui.sprite("Common_Btn_Normal_B_S_Pt", 170, height, { type: 0, depth: 6 })]),
    ]);
    resizeButton(tree, width, height);
    tracked(ui.render(tree, plate, { scale: 1, origin: [0, 0] }));
    const fitted = ui.fitText(caption, primary ? 32 : 24, primary ? 24 : 18, width - 24, 2);
    text.style.fontSize = `${fitted.fs}px`; text.textContent = fitted.text;
    return b;
  }
  const setCaption = (b, caption) => {
    b.setAttribute("aria-label", caption);
    const text = b.querySelector(".import-button-label");
    text.textContent = caption;
    text.style.fontSize = `${ui.fitText(caption, b.classList.contains("primary") ? 32 : 24, 18, parseFloat(b.style.width) - 24, 2).fs}px`;
  };
  function checkbox(caption, checked, onChange) {
    const label = el("label", "import-check"), input = el("input"); input.type = "checkbox"; input.checked = checked;
    const box = el("i", "import-check-box"); box.setAttribute("aria-hidden", "true");
    label.append(input, box);
    if (caption) label.appendChild(el("span", "", caption));
    else input.setAttribute("aria-label", T("import.select"));
    input.addEventListener("change", () => onChange(input.checked));
    return { label, input };
  }
  function selectControl(caption, options, value, onChange) {
    const select = el("select", "import-input"); select.setAttribute("aria-label", caption);
    for (const [key, label] of options) { const option = el("option", "", label); option.value = key; select.appendChild(option); }
    select.value = value; select.addEventListener("change", () => onChange(select.value)); return select;
  }
  const badge = (entry) => el("span", `import-status ${STATES.includes(entry.state) ? entry.state : "blocked"}`, T(`import.state.${STATES.includes(entry.state) ? entry.state : "blocked"}`));
  const identified = (entry) => {
    if (!identities.has(entry)) identities.set(entry, entryIdentity(entry, catalog));
    return identities.get(entry);
  };
  const rowNote = (entry) => entry.state === "blocked" ? report(entry.reason, entry) : "";

  function build() {
    root = el("div", "import-page"); root.dataset.phase = model.state.phase;
    const back = el("div", "import-background"); dom.background = back; root.appendChild(back);
    const workspace = el("div", "import-workspace");
    dom.preview = el("div", "import-detail"); workspace.appendChild(dom.preview);
    const panel = el("div", "import-panel"); skin(panel, 1272, 730, { color: "#edf6fa", border: "#9ab6c7" });
    const head = el("div", "import-panel-head");
    const heading = el("div", "import-heading"); heading.appendChild(el("h2", "", T("import.list")));
    dom.count = el("span", "import-count"); heading.appendChild(dom.count);
    const add = el("div", "import-add");
    dom.files = button(T("import.addFiles"), "files", { width: 180 });
    dom.folder = button(T("import.addFolder"), "folder", { width: 220 }); add.append(dom.files, dom.folder); heading.appendChild(add);
    const filters = el("div", "import-filters");
    dom.search = el("input", "import-input import-search"); dom.search.type = "search"; dom.search.value = query;
    dom.search.placeholder = T("import.search"); dom.search.setAttribute("aria-label", T("import.search"));
    dom.search.autocomplete = "off"; dom.search.spellcheck = false;
    const search = () => { query = dom.search.value.toLocaleLowerCase(); renderRows(); };
    dom.search.addEventListener("input", (event) => { if (!event.isComposing) search(); });
    dom.search.addEventListener("compositionend", search);
    dom.filter = selectControl(T("import.filter"), [], filter, (value) => { filter = value; renderRows(); });
    dom.order = button(T(ascending ? "roster.asc" : "roster.desc"), "order", { width: 120 });
    filters.append(dom.search, dom.filter, dom.order); head.append(heading, filters); panel.appendChild(head);
    dom.list = el("div", "import-list"); dom.list.setAttribute("aria-label", T("import.list")); panel.appendChild(dom.list);
    const tools = el("div", "import-list-tools");
    for (const [key, width] of [["all", 150], ["none", 160], ["remove", 160], ["clear", 140]]) {
      dom[key] = button(T(`import.${key}`), key, { width, height: 42 }); tools.appendChild(dom[key]);
    }
    panel.appendChild(tools); workspace.appendChild(panel); root.appendChild(workspace);
    const footer = el("div", "import-footer");
    dom.status = el("div", "import-progress"); dom.status.setAttribute("role", "status"); dom.status.setAttribute("aria-live", "polite");
    const actions = el("div", "import-footer-actions");
    dom.options = button(T("import.options.title"), "options", { width: 230, height: 66 });
    dom.recheck = button(T("import.recheck"), "recheck", { width: 210, height: 66 });
    dom.start = button(T("import.action", { n: 0 }), "start", { width: 290, height: 76, primary: true });
    actions.append(dom.options, dom.recheck, dom.start); footer.append(dom.status, actions); root.appendChild(footer);
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target || target.disabled) return;
      const actions = { files: () => model.pick(false), folder: pickFolder, order: () => {
        ascending = !ascending; setCaption(dom.order, T(ascending ? "roster.asc" : "roster.desc")); renderRows();
      }, all: () => model.checkAll(true), none: () => model.checkAll(false), remove: () => model.remove(), clear: () => model.clear(),
      options: openOptions, recheck: () => model.recheck(), start: () => model.state.phase === "done" ? results() : start() };
      Promise.resolve(actions[target.dataset.action]?.()).catch((error) => { dom.status.textContent = report(error); });
    });
    root.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = model.busy() ? "none" : "copy"; });
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      const paths = [...(event.dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
      if (paths.length) model.add(paths);
      // Browser File objects do not expose native paths. The window's native drop event handles these in the app.
      else if (!context?.info?.native) { dom.status.textContent = T("error.native_unavailable"); dom.status.classList.add("error"); }
    });
    host.replaceChildren(root);
    rowsKey = previewKey = null;
  }

  function staticImage(image, portrait) {
    image.src = portrait || fallbackIcon(); image.alt = ""; image.draggable = false;
    image.addEventListener("error", () => { if (image.src !== fallbackIcon()) image.src = fallbackIcon(); }, { once: true });
  }
  function thumbImage(entry, image, { incoming = false, large = false, token = generation } = {}) {
    const { variant } = identified(entry);
    staticImage(image, variant?.portrait);
    const libraryId = entry.libraryId || model.state.results.find((result) => result.id === entry.id)?.libraryId;
    const kind = variant?.spineCategory || entry.kind;
    const key = kind === "spr" ? variant?.spr : kind === "lobby" ? variant?.lobby : null;
    const base = incoming ? libraryId && ["spr", "lobby"].includes(entry.kind) ? spineBase("mod", libraryId) : null
      : key ? spineBase(kind, key) : null;
    if (!allowed() || !base || !scope) return;
    const work = scope.thumb(base, large ? "bust" : "card", null, kind === "lobby", specialFraming(variant));
    if (large) work.bump?.();
    Promise.resolve(work).then((url) => {
      if (url && visible && token === generation && image.isConnected) image.src = url;
    }).catch(() => {});
  }

  function renderPreview() {
    const entry = model.state.entries.find((item) => item.id === model.state.selected);
    const key = JSON.stringify([entry?.id, entry?.libraryId, model.state.results, allowed()]);
    if (key === previewKey) return; previewKey = key;
    const next = el("div", "import-detail-content");
    if (!entry) {
      const empty = el("div", "import-detail-empty"); empty.appendChild(el("span", "", T("import.choose"))); next.appendChild(empty);
    } else {
      const identity = identified(entry), pair = el("div", "import-preview-pair");
      for (const incoming of [false, true]) {
        const box = el("div", `import-preview${incoming ? " incoming" : ""}`);
        skin(box, 254, 440, { color: incoming ? "#dff6ff" : "#f0f7fa", border: "#ffffff" });
        box.appendChild(el("span", "import-preview-label", T(incoming ? "import.incoming" : "import.current")));
        const image = el("img", "import-preview-image"); box.appendChild(image);
        const libraryId = entry.libraryId || model.state.results.find((result) => result.id === entry.id)?.libraryId;
        if (incoming && !libraryId) box.appendChild(el("span", "import-preview-unavailable", T("import.previewUnavailable")));
        pair.appendChild(box); thumbImage(entry, image, { incoming, large: true });
      }
      const banner = el("div", "import-name-banner"); skin(banner, 524, 152, { color: "#2d4765" });
      banner.append(el("h2", "", identity.name), el("small", "", `${identity.core} / ${T(KIND_KEYS[entry.kind] || KIND_KEYS.other)}`));
      next.append(pair, banner);
    }
    dom.preview.replaceChildren(next);
  }

  function renderRows() {
    if (!visible || !root) return;
    const entries = model.state.entries.filter((entry) => (filter === "all" || entry.state === filter) && identified(entry).search.includes(query));
    const collator = new Intl.Collator(language(), { numeric: true, sensitivity: "base" });
    entries.sort((a, b) => (ascending ? 1 : -1) * collator.compare(identified(a).name, identified(b).name));
    const key = JSON.stringify(entries);
    if (key !== rowsKey) {
      rowsKey = key; observer?.disconnect(); observer = null; rows = new Map();
      const contents = [];
      if (!entries.length) {
        const empty = el("div", "import-empty"); empty.appendChild(el("h3", "", T(model.state.entries.length ? "import.noMatch" : "import.empty")));
        if (!model.state.entries.length) empty.appendChild(el("p", "", T("import.drop"))); contents.push(empty);
      }
      for (const entry of entries) {
        const row = el("div", "import-row"); row.dataset.entry = entry.id;
        skin(row, 1216, 116, { color: eligible(entry) ? "#ffffff" : "#e9eef2" });
        const thumb = el("img", "import-thumb"); staticImage(thumb, identified(entry).variant?.portrait);
        const copy = el("button", "import-row-copy"); copy.type = "button";
        const name = identified(entry).name; copy.setAttribute("aria-label", name);
        copy.appendChild(el("span", "import-row-name", name));
        copy.appendChild(el("small", "import-row-meta", T("import.meta", { id: identified(entry).core, n: entry.files?.length || 0, size: sizeText(entry.size) })));
        const note = rowNote(entry); if (note) copy.appendChild(el("small", "import-row-note", note));
        row.addEventListener("click", (event) => { if (!event.target.closest?.(".import-check")) model.select(entry.id); });
        const kind = el("span", "import-row-kind", T(KIND_KEYS[entry.kind] || KIND_KEYS.other));
        const check = checkbox("", model.state.checked.has(entry.id), (checked) => model.toggle(entry.id, checked));
        check.input.setAttribute("aria-label", T("import.selectNamed", { name }));
        row.append(thumb, copy, kind, badge(entry), check.label); contents.push(row); rows.set(entry.id, { row, copy, input: check.input });
        if (typeof IntersectionObserver !== "undefined" && allowed()) {
          observer ||= new IntersectionObserver((changes) => {
            for (const change of changes) if (change.isIntersecting) {
              const item = model.state.entries.find((item) => item.id === change.target.dataset.entry);
              if (item) thumbImage(item, change.target.querySelector(".import-thumb")); observer?.unobserve(change.target);
            }
          }, { root: dom.list, rootMargin: "100px" });
          observer.observe(row);
        }
      }
      dom.list.replaceChildren(...contents);
    }
    for (const [id, row] of rows) {
      row.row.classList.toggle("selected", model.state.selected === id);
      row.copy.setAttribute("aria-pressed", String(model.state.selected === id));
      row.input.checked = model.state.checked.has(id);
      row.input.disabled = model.busy() || !model.state.valid || model.state.phase === "done" || !eligible(model.state.entries.find((entry) => entry.id === id));
    }
  }

  function render() {
    if (!visible || !root) return;
    const state = model.state, busy = model.busy(); root.dataset.phase = state.phase; root.setAttribute("aria-busy", String(busy));
    dom.count.textContent = T("import.count", { n: state.entries.length });
    const counts = countsOf(state.entries), options = [["all", T("import.filterCount", { state: T("seg.all"), n: state.entries.length })],
      ...STATES.map((state) => [state, T("import.filterCount", { state: T(`import.state.${state}`), n: counts[state] })])];
    const key = JSON.stringify(options);
    if (countsKey !== key) {
      countsKey = key;
      dom.filter.replaceChildren(...options.map(([value, text]) => { const option = el("option", "", text); option.value = value; return option; })); dom.filter.value = filter;
    }
    for (const key of ["files", "folder", "options", "clear", "remove", "all", "none", "recheck"]) dom[key].disabled = busy;
    dom.clear.disabled ||= !state.entries.length; dom.remove.disabled ||= !state.selected;
    dom.recheck.disabled ||= !state.entries.length && !state.error;
    dom.all.disabled ||= !state.valid || state.phase === "done" || !state.entries.some(eligible);
    dom.none.disabled ||= !state.valid || state.phase === "done" || !state.checked.size;
    dom.start.disabled = busy || state.phase !== "done" && (!state.valid || !model.selected().length);
    setCaption(dom.start, state.phase === "done" ? T("import.results") : T("import.action", { n: model.selected().length }));
    dom.status.replaceChildren(); dom.status.classList.toggle("error", !!state.error);
    if (state.error) dom.status.textContent = report(state.error);
    else if (state.phase === "analyzing" || state.phase === "picking" || state.phase === "saving") dom.status.textContent = T(`import.${state.phase}`);
    else if (state.phase === "running") {
      const p = state.progress || {}, total = Math.max(1, Number(p.total) || state.taskEntries.length), done = Math.min(total, Math.max(0, Number(p.done) || 0));
      const phase = ["update", "add", "apply"].includes(p.phase) ? T(`import.phase.${p.phase}`) : T("job.running");
      const current = state.taskEntries.find((entry) => entry.id === p.current || entry.core === p.current);
      dom.status.appendChild(el("span", "", T("import.progress", { phase, done, total, name: current ? identified(current).name : "" })));
      const bar = el("progress"); bar.max = total; bar.value = done; bar.setAttribute("aria-label", T("job.running")); dom.status.appendChild(bar);
    } else if (state.phase === "done") dom.status.textContent = T("import.complete", { n: state.results.filter((r) => r.outcome !== "failed" && r.outcome !== "skipped").length, failed: state.results.filter((r) => r.outcome === "failed").length });
    renderRows(); renderPreview();
  }

  async function start() {
    await model.start(async (counts, n) => {
      const result = await popups.message({ title: T("import.confirm"),
        lines: STATES.filter((state) => counts[state]).map((state) => T("import.confirmCount", { state: T(`import.state.${state}`), n: counts[state] })),
        ok: T("import.action", { n }), cancel: T("popup.cancel") });
      return visible && result.button === "ok";
    });
  }
  async function pickFolder() {
    const result = await popups.message({ title: T("import.addFolder"), lines: [],
      check: { label: T("import.recursive"), checked: false }, ok: T("picker.ok"), cancel: T("popup.cancel") });
    if (visible && result.button === "ok") await model.pick(true, result.checked);
  }

  async function dialog(title, { action = T("display.close"), cancel = null, onAction = () => true } = {}, content) {
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
    popups.opened(dialogHost, close, { el: layer });
    try {
      const view = await ui.render(popups.popupFrame(title, 2458, 1360, { ok: action, cancel }), layer, { scale: S, origin: [960, 540], z: 10 });
      if (ended) return;
      const area = el("div", "import-dialog-content"); layer.appendChild(area); await content(area);
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
      layer.focus?.({ preventScroll: true });
    } catch (error) { close(); throw error; }
  }

  async function openOptions() {
    if (model.busy() || !await model.loadOptions()) return;
    const draft = { ...model.state.options, types: [...model.state.options.types] };
    let error;
    await dialog(T("import.options.title"), { action: T("picker.ok"), cancel: T("popup.cancel"), onAction: async () => {
      if (!draft.types.length || !Number.isSafeInteger(draft.workers) || draft.workers < 1) {
        error.textContent = T(!draft.types.length ? "import.options.typesRequired" : "import.options.workersInvalid"); return false;
      }
      const saved = await model.saveOptions(draft); if (!saved) error.textContent = report(model.state.error); return saved;
    } }, (area) => {
      const row = (key, control) => {
        const label = el("div", `import-option${key === "output" ? " wide" : ""}`);
        control.querySelector("input")?.setAttribute("aria-label", T(`import.options.${key}`));
        label.append(el("span", "", T(`import.options.${key}`)), control); area.appendChild(label);
      };
      for (const key of ["enableAfterImport", "skipUnchanged", "backup"]) row(key, checkbox("", draft[key], (value) => { draft[key] = value; }).label);
      const select = (key, values) => row(key, selectControl(T(`import.options.${key}`), values, draft[key], (value) => { draft[key] = value; }));
      select("strategy", ["cont_name_type", "path_id", "name_type"].map((key) => [key, T(`import.strategy.${key}`)]));
      select("crc", [["auto", T("import.auto")], ["on", T("settings.post.on")], ["off", T("settings.post.off")]]);
      select("compression", [["lzma", "LZMA"], ["lz4", "LZ4"], ["original", T("import.original")], ["none", T("import.uncompressed")]]);
      const types = el("fieldset", "import-resource-types"); types.appendChild(el("legend", "", T("import.options.types")));
      const checks = new Map();
      for (const type of RESOURCE_TYPES) {
        const check = checkbox(type === "ALL" ? T("import.options.allTypes") : type, draft.types.includes(type), (checked) => {
          const values = new Set(draft.types); if (checked) values.add(type); else values.delete(type);
          if (checked && type === "ALL") { values.clear(); values.add("ALL"); } else if (checked) values.delete("ALL");
          draft.types = [...values]; for (const [key, input] of checks) input.checked = values.has(key);
        }); types.appendChild(check.label); checks.set(type, check.input);
      }
      area.appendChild(types);
      for (const key of ["extraBytes", "workers", "output"]) {
        const input = el("input", "import-input"); input.type = key === "workers" ? "number" : "text"; input.value = draft[key] ?? "";
        input.setAttribute("aria-label", T(`import.options.${key}`));
        if (key === "workers") { input.min = "1"; input.step = "1"; }
        input.addEventListener("input", () => { draft[key] = key === "workers" ? Number(input.value) : key === "output" ? input.value.trim() || null : input.value; }); row(key, input);
      }
      area.appendChild(el("p", "import-option-note", T("import.options.bytesHint")));
      error = el("p", "import-option-error"); error.setAttribute("role", "alert"); area.appendChild(error);
    });
  }

  async function results() {
    await dialog(T("import.resultTitle"), {}, (area) => {
      area.classList.add("import-results");
      const table = el("table"), head = el("thead"), tr = el("tr");
      for (const key of ["mod", "detected", "resultLabel"]) tr.appendChild(el("th", "", T(`import.${key}`)));
      head.appendChild(tr); table.appendChild(head); const body = el("tbody");
      for (const entry of model.state.taskEntries) {
        const result = model.state.results.find((item) => item.id === entry.id), row = el("tr");
        row.dataset.result = entry.id; row.appendChild(el("td", "", identified(entry).name));
        const detected = el("td"); detected.appendChild(badge(entry)); row.appendChild(detected);
        const outcome = el("td"); outcome.appendChild(el("span", "", T(`import.outcome.${OUTCOMES.has(result?.outcome) ? result.outcome : "failed"}`)));
        if (result?.reason) outcome.appendChild(el("small", "import-row-note", report(result.reason, entry)));
        if (["imported", "updated"].includes(result?.outcome)) outcome.appendChild(el("small", "import-row-note", T(result.applied ? "import.applied" : "import.notApplied")));
        row.appendChild(outcome); body.appendChild(row);
      }
      table.appendChild(body); area.appendChild(table);
    });
  }

  model.subscribe(render);
  return {
    model,
    async show(ctx, data) {
      context = ctx; catalog = catalogEntries(data); identities = new WeakMap(); visible = true; generation++;
      scope?.cancel(); scope = thumbnails(); observer?.disconnect();
      if (!root) build(); else { rowsKey = previewKey = null; render(); }
      await ui.init();
      const collection = await ui.layout("UICharacterCollection");
      const bg = ui.find(collection, "BG");
      if (bg) { const next = el("div"); await ui.render(clone(bg), next, { scale: S, origin: [960, 540] }); if (visible) dom.background.replaceChildren(...next.childNodes); }
      render();
      // The page is usable while these read; a failed options read can be retried from Advanced Options or Import.
      model.loadOptions();
      await Promise.all([...drawings]); await ui.decoded(root, 15000);
    },
    hide() { visible = false; generation++; scope?.cancel(); observer?.disconnect(); dialogClose?.(); },
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
