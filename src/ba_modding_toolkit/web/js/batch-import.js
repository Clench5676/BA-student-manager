// Unified import behaviour over runtime Items, Mailbox and FilterSort prefab widgets (import-layout.js).
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { rpc, spineBase, spriteUrl, waitJob } from "./api.js";
import { L, T, language } from "./i18n.js";
import { customAliases, studentName } from "./names.js";
import { specialFraming } from "./special-view.js";
import { spineAllowed } from "./spine-runtime.js";
import { thumbnailScope } from "./thumbs.js";
import { S } from "./util.js";
import { loadImportLayouts, importArtwork, clipButtonPatterns, ROW_SCALE, ROW_WIDTH, ROW_HEIGHT } from "./import-layout.js";
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
  let art = null;
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
  // DOM below is geometry, scrolling and accessible hit areas only. All visible widgets come from import-layout.js.
  const place = (element, x, y, width, height) => {
    Object.assign(element.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    return element;
  };
  function paint(element, tree, { scale = S, origin = [0, 0], textures = {} } = {}) {
    const version = element.paintVersion = (element.paintVersion || 0) + 1;
    const next = el("div", "import-art");
    const drawing = ui.render(tree, next, { scale, origin, textures, deferImages: true }).then((view) => {
      clipButtonPatterns(view);
      if (element.paintVersion === version) {
        element.art?.remove(); element.art = next; element.appendChild(next);
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
  // Native text/number entry uses Items/SearchNameArea, including its outline and the game's input colour/font.
  function inputControl(caption, value, { type = "text", width = 650, search = false } = {}) {
    const wrap = el("div", "import-input-wrap"), input = el("input", `roster-search${search ? " import-search" : ""}`);
    input.type = type; input.value = value; input.setAttribute("aria-label", caption);
    input.autocomplete = "off"; input.spellcheck = false;
    Object.assign(wrap.style, { position: "relative", width: `${width}px`, height: "56px" });
    const tree = art.search(width / 0.5);
    if (!search) { ui.find(tree, "Icon_Search").active = false; ui.find(tree, "Btn_Close").active = false; }
    paint(wrap, tree, { scale: 0.5, origin: [width / 2, 0] });
    place(input, search ? 58 : 18, 0, width - (search ? 118 : 36), 56);
    Object.assign(input.style, art.inputStyle(0.5)); wrap.appendChild(input);
    return { wrap, input };
  }
  // FilterSort/UISortObjectListUnit supplies every option; native selects would introduce a foreign widget.
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
    dom.preview = place(el("div", "import-detail"), 46, 150, 524, 700); root.appendChild(dom.preview);
    // Items/ListBG: the two-column frame retains its paper/inbox insets, with a mail list in place of the item grid.
    const panel = place(el("div", "import-panel"), 602, 132, 1272, 730);
    paint(panel, art.panel(1272 / S, 730 / S), { origin: [636, 365] });
    const title = place(el("div"), 26, 22, 400, 55); panel.appendChild(title);
    textWidget(title, T("import.list"), "title", { scale: 0.5, origin: [0, 27] });
    dom.count = place(el("div"), 372, 24, 330, 48); panel.appendChild(dom.count);
    dom.files = button(T("import.addFiles"), "files", { width: 196 }); place(dom.files, 818, 7, 196, 65);
    dom.folder = button(T("import.addFolder"), "folder", { width: 220 }); place(dom.folder, 1028, 7, 220, 65);
    const search = inputControl(T("import.search"), query, { width: 802, type: "search", search: true });
    dom.search = search.input; dom.search.placeholder = T("import.search"); place(search.wrap, 26, 94, 802, 56);
    const runSearch = () => { query = dom.search.value.toLocaleLowerCase(); renderRows(); };
    dom.search.addEventListener("input", (event) => { if (!event.isComposing) runSearch(); }); dom.search.addEventListener("compositionend", runSearch);
    const clearSearch = place(el("button", "hit"), 740, 0, 60, 56); clearSearch.type = "button";
    clearSearch.setAttribute("aria-label", T("display.reset")); clearSearch.addEventListener("click", () => { dom.search.value = ""; runSearch(); dom.search.focus(); });
    search.wrap.appendChild(clearSearch);
    dom.filter = place(el("button", "hit"), 852, 92, 285, 60); dom.filter.type = "button"; dom.filter.dataset.action = "filter";
    dom.order = place(el("button", "hit"), 1158, 92, 84, 60); dom.order.type = "button"; dom.order.dataset.action = "order";
    panel.append(dom.files, dom.folder, search.wrap, dom.filter, dom.order);
    dom.list = place(el("div", "import-list"), 26, 178, 1220, 464); dom.list.setAttribute("aria-label", T("import.list")); panel.appendChild(dom.list);
    for (const [key, x, width] of [["all", 28, 180], ["none", 225, 200], ["remove", 840, 180], ["clear", 1040, 180]]) {
      dom[key] = button(T(`import.${key}`), key, { width, scale: 0.34 }); place(dom[key], x, 655, width, 56); panel.appendChild(dom[key]);
    }
    root.appendChild(panel);
    dom.status = place(el("div", "import-progress"), 50, 900, 800, 90); dom.status.setAttribute("role", "status"); dom.status.setAttribute("aria-live", "polite"); root.appendChild(dom.status);
    dom.options = button(T("import.options.title"), "options", { width: 290, scale: 0.5 });
    dom.recheck = button(T("import.recheck"), "recheck", { width: 230, scale: 0.5 });
    dom.start = button(T("import.action", { n: 0 }), "start", { width: 330, scale: 0.6, primary: true });
    place(dom.options, 958, 904, 290, 81); place(dom.recheck, 1272, 904, 230, 81); place(dom.start, 1528, 894, 330, 100);
    root.append(dom.options, dom.recheck, dom.start);
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target || target.disabled) return;
      const actions = { files: () => model.pick(false), folder: pickFolder, filter: openFilter, order: () => {
        ascending = !ascending; renderOrder(); renderRows();
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
    host.replaceChildren(root); rowsKey = previewKey = countsKey = null; renderOrder();
  }

  function renderOrder() {
    dom.order.setAttribute("aria-label", T(ascending ? "roster.asc" : "roster.desc"));
    paint(dom.order, art.order(ascending), { scale: 0.5, origin: [42, 29] });
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
  function portraitSource(entry) {
    const source = identified(entry).variant?.portrait || fallbackIcon();
    return ui.load ? ui.load(source).then(() => source, () => fallbackIcon()) : source;
  }
  function setTexture(image, source) {
    image.dataset.source = source;
    Object.assign(image.style, { backgroundImage: `url(${JSON.stringify(source)})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" });
  }
  function bindTexture(drawing, path, source, className) {
    return tracked(Promise.all([drawing, source]).then(([view, url]) => {
      const image = view.nodes.get(path)?.els[0];
      if (image) { image.classList.add(className); setTexture(image, url); }
      return image;
    }));
  }
  function incomingBase(entry) {
    if (!["spr", "lobby"].includes(entry.kind)) return null;
    const libraryId = entry.libraryId || model.state.results.find((result) => result.id === entry.id)?.libraryId;
    if (libraryId) return spineBase("mod", libraryId);
    return entry.preview?.kind === "import" && entry.preview.key ? spineBase("import", entry.preview.key) : null;
  }
  function thumbImage(entry, image, { incoming = false, large = false, token = generation } = {}) {
    const { variant } = identified(entry);
    if (!image) return;
    const kind = entry.kind;
    const key = kind === "spr" ? variant?.spr || entry.core : kind === "lobby" ? variant?.lobby || entry.core : null;
    const base = incoming ? incomingBase(entry)
      : key ? spineBase(kind, key) : null;
    if (!allowed() || !base || !scope) return;
    const work = scope.thumb(base, large ? "bust" : "card", null, kind === "lobby", specialFraming(variant));
    if (large) work.bump?.();
    Promise.resolve(work).then((url) => {
      if (url && visible && token === generation && image.isConnected) setTexture(image, url);
    }).catch(() => {});
  }

  function renderPreview() {
    const entry = model.state.entries.find((item) => item.id === model.state.selected);
    const key = JSON.stringify([entry?.id, entry?.libraryId, entry?.preview, model.state.results, allowed()]);
    if (key === previewKey) return; previewKey = key;
    const next = el("div", "import-detail-content");
    if (entry) {
      const identity = identified(entry);
      for (const incoming of [false, true]) {
        const box = place(el("div", `import-preview${incoming ? " incoming" : ""}`), incoming ? 270 : 0, 0, 254, 438);
        const source = portraitSource(entry), token = generation;
        const drawing = paint(box, art.preview(T(incoming ? "import.incoming" : "import.current")), {
          scale: 0.46, origin: [127, 230], textures: { "Texture": source },
        });
        bindTexture(drawing, "EquipPos/Texture", source, "import-preview-image").then((image) => {
          if (visible && token === generation && image?.isConnected) thumbImage(entry, image, { incoming, large: true, token });
        }).catch(() => {});
        if (incoming && !incomingBase(entry)) {
          const note = place(el("div"), 0, 388, 254, 45); note.style.zIndex = "20"; box.appendChild(note);
          textWidget(note, T("import.previewUnavailable"), "empty", { scale: 0.4, origin: [127, 23] });
        }
        next.appendChild(box);
      }
      const banner = place(el("div", "import-name-banner"), 0, 466, 524, 120);
      paint(banner, art.banner(identity.name, T(KIND_KEYS[entry.kind] || KIND_KEYS.other)), { scale: 0.42, origin: [255, 104] });
      next.appendChild(banner);
    }
    // Intentionally no empty-selection caption, description or controls under the name banner.
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
        const empty = place(el("div", "import-empty"), 0, 120, 1200, 180);
        textWidget(empty, T(model.state.entries.length ? "import.noMatch" : "import.empty"), "empty", { origin: [600, 40] });
        if (!model.state.entries.length) {
          const note = place(el("div"), 0, 80, 1200, 100); empty.appendChild(note);
          textWidget(note, T("import.drop"), "empty", { scale: 0.5, origin: [600, 45] });
        }
        contents.push(empty);
      }
      for (const entry of entries) {
        const row = el("div", "import-row"); row.dataset.entry = entry.id;
        const name = identified(entry).name;
        const source = portraitSource(entry);
        const drawing = paint(row, art.row({ name, kind: T(KIND_KEYS[entry.kind] || KIND_KEYS.other), state: T(`import.state.${entry.state}`), stateKey: entry.state,
          meta: T("import.meta", { id: identified(entry).core, n: entry.files?.length || 0, size: sizeText(entry.size) }), note: rowNote(entry), muted: !eligible(entry) }),
        { scale: ROW_SCALE, origin: [ROW_WIDTH / 2, 329 * ROW_SCALE / 2], textures: { "Icon_Arona": source } });
        // MailboxContent/List_01 or List_02/BG_Icon/Icon_Arona is the incoming Mod's real texture slot.
        row.image = bindTexture(drawing, `${eligible(entry) ? "List_01" : "List_02"}/BG_Icon/Icon_Arona`, source, "import-thumb");
        const copy = place(el("button", "hit import-row-copy"), 0, 0, ROW_WIDTH - 72, ROW_HEIGHT - 10); copy.type = "button"; copy.setAttribute("aria-label", name);
        row.addEventListener("click", (event) => { if (!event.target.closest?.(".import-check")) model.select(entry.id); });
        const check = checkbox("", model.state.checked.has(entry.id), (checked) => model.toggle(entry.id, checked));
        check.input.setAttribute("aria-label", T("import.selectNamed", { name })); place(check.label, ROW_WIDTH - 66, 78, 50, 50);
        const selection = place(el("div", "import-selection"), 19, 8, 164, 160);
        paint(selection, art.selection(), { scale: 0.68, origin: [82, 80] });
        row.append(selection, copy, check.label); contents.push(row); rows.set(entry.id, { row, copy, selection, input: check.input, refresh: check.refresh });
        if (typeof IntersectionObserver !== "undefined" && allowed()) {
          observer ||= new IntersectionObserver((changes) => {
            for (const change of changes) if (change.isIntersecting) {
              const item = model.state.entries.find((item) => item.id === change.target.dataset.entry);
              if (item) {
                const token = generation;
                change.target.image.then((image) => {
                  if (visible && token === generation && image?.isConnected) thumbImage(item, image, { incoming: true, token });
                }).catch(() => {});
              }
              observer?.unobserve(change.target);
            }
          }, { root: dom.list, rootMargin: "100px" });
          observer.observe(row);
        }
      }
      dom.list.replaceChildren(...contents);
    }
    for (const [id, row] of rows) {
      // Items' selection mark is kept on the thumbnail, separate from the import checkbox.
      row.row.dataset.selected = String(model.state.selected === id);
      row.selection.hidden = model.state.selected !== id;
      row.copy.setAttribute("aria-pressed", String(model.state.selected === id));
      row.input.checked = model.state.checked.has(id);
      row.input.disabled = model.busy() || !model.state.valid || model.state.phase === "done" || !eligible(model.state.entries.find((entry) => entry.id === id));
      row.refresh();
    }
  }

  function render() {
    if (!visible || !root) return;
    const state = model.state, busy = model.busy(); root.dataset.phase = state.phase; root.setAttribute("aria-busy", String(busy));
    textWidget(dom.count, T("import.count", { n: state.entries.length }), "count", { scale: 0.5, origin: [320, 24] });
    const options = filterOptions(), caption = options.find(([value]) => value === filter)?.[1] || options[0][1];
    const key = JSON.stringify([caption, filter]);
    if (countsKey !== key) {
      countsKey = key; dom.filter.setAttribute("aria-label", caption);
      paint(dom.filter, art.stateButton(caption, filter !== "all", 570), { scale: 0.5, origin: [142.5, 29] });
    }
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
    else if (state.phase === "running") {
      const p = state.progress || {}, total = Math.max(1, Number(p.total) || state.taskEntries.length), done = Math.min(total, Math.max(0, Number(p.done) || 0));
      const phase = ["update", "add", "apply"].includes(p.phase) ? T(`import.phase.${p.phase}`) : T("job.running");
      const current = state.taskEntries.find((entry) => entry.id === p.current || entry.core === p.current);
      status = T("import.progress", { phase, done, total, name: current ? identified(current).name : "" });
      dom.status.setAttribute("role", "progressbar"); dom.status.setAttribute("aria-valuemin", "0");
      dom.status.setAttribute("aria-valuemax", total); dom.status.setAttribute("aria-valuenow", done);
    } else if (state.phase === "done") status = T("import.complete", { n: state.results.filter((r) => r.outcome !== "failed" && r.outcome !== "skipped").length, failed: state.results.filter((r) => r.outcome === "failed").length });
    if (state.phase !== "running") { dom.status.setAttribute("role", "status"); for (const attr of ["aria-valuemin", "aria-valuemax", "aria-valuenow"]) dom.status.removeAttribute(attr); }
    textWidget(dom.status, status, state.error ? "error" : "note", { scale: 0.5, origin: [state.error ? 400 : 0, 35] });
    renderRows(); renderPreview();
  }

  // Confirmation uses Popup.message: UIPopup_Sort/Center/Popup, shared with the other screens.
  async function start() {
    await model.start(async (counts, n) => {
      const result = await popups.message({ title: T("import.confirm"),
        lines: STATES.filter((state) => counts[state]).map((state) => T("import.confirmCount", { state: T(`import.state.${state}`), n: counts[state] })),
        ok: T("import.action", { n }), cancel: T("popup.cancel") });
      return visible && result.button === "ok";
    });
  }
  // Popup.message adds UIPopup_GachaCharList/Btn_Checkbox to the same Sort frame for recursive scanning.
  async function pickFolder() {
    const result = await popups.message({ title: T("import.addFolder"), lines: [],
      check: { label: T("import.recursive"), checked: false }, ok: T("picker.ok"), cancel: T("popup.cancel") });
    if (visible && result.button === "ok") await model.pick(true, result.checked);
  }

  // Popup.popupFrame clones UIPopup_Sort/Center: Base/BG, Btn_Close and Btn/Btn_Ok / Btn_Cancel.
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
        textWidget(error, T(!draft.types.length ? "import.options.typesRequired" : "import.options.workersInvalid"), "error", { origin: [650, 35] }); return false;
      }
      const saved = await model.saveOptions(draft); if (!saved) textWidget(error, report(model.state.error), "error", { origin: [650, 35] }); return saved;
    } }, (area) => {
      const row = (key, control, height = 145) => {
        const group = el("div", "import-option"); group.style.height = `${height}px`;
        const heading = place(el("div"), 0, 0, 1390, 58);
        paint(heading, art.optionHeading(T(`import.options.${key}`)), { scale: 0.6, origin: [0, 78] });
        const content = place(el("div"), 12, 66, 1370, height - 66); content.appendChild(control);
        group.append(heading, content); area.appendChild(group); return content;
      };
      for (const key of ["enableAfterImport", "skipUnchanged", "backup"]) {
        const check = checkbox("", draft[key], (value) => { draft[key] = value; });
        check.input.setAttribute("aria-label", T(`import.options.${key}`)); row(key, check.label, 140);
      }
      const radio = (key, values) => {
        const controls = el("div");
        radioOptions(controls, values, draft[key], (value) => { draft[key] = value; }, { columns: values.length > 2 ? 2 : 1 });
        row(key, controls, 78 + Math.ceil(values.length / (values.length > 2 ? 2 : 1)) * 96);
      };
      radio("strategy", ["cont_name_type", "path_id", "name_type"].map((key) => [key, T(`import.strategy.${key}`)]));
      radio("crc", [["auto", T("import.auto")], ["on", T("settings.post.on")], ["off", T("settings.post.off")]]);
      radio("compression", [["lzma", "LZMA"], ["lz4", "LZ4"], ["original", T("import.original")], ["none", T("import.uncompressed")]]);
      const types = el("fieldset", "import-resource-types"); types.setAttribute("aria-label", T("import.options.types"));
      const checks = new Map();
      for (const [i, type] of RESOURCE_TYPES.entries()) {
        const check = checkbox(type === "ALL" ? T("import.options.allTypes") : type, draft.types.includes(type), (checked) => {
          const values = new Set(draft.types); if (checked) values.add(type); else values.delete(type);
          if (checked && type === "ALL") { values.clear(); values.add("ALL"); } else if (checked) values.delete("ALL");
          draft.types = [...values]; for (const [key, check] of checks) { check.input.checked = values.has(key); check.refresh(); }
        });
        place(check.label, i % 2 * 685, Math.floor(i / 2) * 70, 670, 60); types.appendChild(check.label); checks.set(type, check);
      }
      row("types", types, 80 + Math.ceil(RESOURCE_TYPES.length / 2) * 70);
      for (const key of ["extraBytes", "workers", "output"]) {
        const control = inputControl(T(`import.options.${key}`), draft[key] ?? "", { type: key === "workers" ? "number" : "text", width: key === "output" ? 1350 : 900 });
        const input = control.input;
        if (key === "workers") { input.min = "1"; input.step = "1"; }
        input.addEventListener("input", () => { draft[key] = key === "workers" ? Number(input.value) : key === "output" ? input.value.trim() || null : input.value; }); row(key, control.wrap);
      }
      const note = el("div", "import-option-note"); note.style.height = "70px"; area.appendChild(note);
      textWidget(note, T("import.options.bytesHint"), "empty", { origin: [650, 35] });
      error = el("div", "import-option-error"); error.style.height = "80px"; error.setAttribute("role", "alert"); area.appendChild(error);
    });
  }

  async function results() {
    await dialog(T("import.resultTitle"), {}, (area) => {
      area.classList.add("import-results");
      for (const entry of model.state.taskEntries) {
        const result = model.state.results.find((item) => item.id === entry.id), row = el("div", "import-result-row");
        row.dataset.result = entry.id;
        const outcome = T(`import.outcome.${OUTCOMES.has(result?.outcome) ? result.outcome : "failed"}`);
        const note = result?.reason ? report(result.reason, entry) : ["imported", "updated"].includes(result?.outcome) ? T(result.applied ? "import.applied" : "import.notApplied") : "";
        const source = portraitSource(entry);
        const drawing = paint(row, art.row({ name: identified(entry).name, kind: T(KIND_KEYS[entry.kind] || KIND_KEYS.other),
          state: T(`import.state.${entry.state}`), stateKey: entry.state, meta: outcome, note, muted: !eligible(entry) }),
        { scale: 0.62, origin: [700, 104], textures: { "Icon_Arona": source } });
        bindTexture(drawing, `${eligible(entry) ? "List_01" : "List_02"}/BG_Icon/Icon_Arona`, source, "import-thumb");
        area.appendChild(row);
      }
    });
  }

  model.subscribe(render);
  return {
    model,
    async show(ctx, data) {
      context = ctx; catalog = catalogEntries(data); identities = new WeakMap(); visible = true; generation++;
      scope?.cancel(); scope = thumbnails(); observer?.disconnect();
      if (!art) { await ui.init(); art = importArtwork(ui, await loadImportLayouts(ui)); }
      if (!visible) return;
      if (!root) build();
      rowsKey = previewKey = null; render();
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
