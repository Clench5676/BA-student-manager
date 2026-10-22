// Batch import's RPC contract and session state, independent of the screen and its artwork.
export const STATES = Object.freeze(["ready", "convert", "update", "library", "installed", "blocked", "done"]);
export const RESOURCE_TYPES = Object.freeze(["ALL", "Texture2D", "TextAsset", "Mesh", "AnimationClip"]);
export const eligible = (entry) => ["ready", "convert", "update"].includes(entry?.state);
export const pathsOf = (entries) => [...new Set(entries.flatMap((entry) => entry.paths || []))];
const snapshot = (options) => ({ ...options, types: [...options.types] });

export function countsOf(entries) {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const entry of entries) if (entry.state in counts) counts[entry.state]++;
  return counts;
}

export function createImportState({ rpc, waitJob, changed = () => {}, suggest = async () => [] }) {
  const state = { entries: [], checked: new Set(), selected: null, phase: "idle", progress: null, error: null,
    options: null, results: [], taskEntries: [], taskOptions: null, suggestions: [], valid: false, analysisRevision: null };
  const listeners = new Set();
  const pendingAnalyses = new Set();
  let revision = 0, contextRevision = 0, retryPaths = [], retryRecursive = false, starting = false, optionsRead = null;
  const emit = () => { for (const fn of listeners) fn(state); };
  const busy = () => starting || ["picking", "analyzing", "running", "saving"].includes(state.phase);
  const selected = () => state.entries.filter((entry) => eligible(entry) && state.checked.has(entry.id));
  const fail = (error) => { state.error = error; state.phase = "error"; emit(); };
  const progress = (data) => { state.progress = { ...data }; emit(); };
  const resetResults = () => { state.results = []; state.taskEntries = []; state.taskOptions = null; state.progress = null; };
  globalThis.BAMTRecovery?.importList?.(() => ({ phase: state.phase, revision: state.analysisRevision,
    rows: state.entries.map((entry) => ({ ...entry, selected: eligible(entry) && state.checked.has(entry.id) })) }));

  async function loadOptions() {
    if (state.options) return true;
    optionsRead ||= Promise.resolve().then(() => rpc("import.options")).then((options) => {
      state.options = snapshot(options); emit(); return true;
    }).catch((error) => { if (!busy() || starting) fail(error); return false; }).finally(() => { optionsRead = null; });
    return optionsRead;
  }

  async function analyze(paths, recursive = false) {
    if (busy() || !paths.length) return false;
    retryPaths = [...new Set(paths)]; retryRecursive = recursive;
    const before = new Map(state.entries.map((entry) => [entry.id, entry]));
    const checked = new Set(state.checked);
    const contextAtStart = contextRevision;
    const removed = new Set();
    pendingAnalyses.add(removed);
    state.phase = "analyzing"; state.error = null; state.valid = false;
    resetResults(); revision++; emit();
    try {
      const id = await rpc("import.analyze", { paths: retryPaths, recursive });
      const result = await waitJob(id, progress);
      state.analysisRevision = result.revision;
      state.entries = [...new Map(result.entries.filter((entry) => !removed.has(entry.id)).map((entry) => [entry.id, entry])).values()];
      state.checked = new Set(state.entries.filter((entry) => eligible(entry)
        && (!eligible(before.get(entry.id)) || checked.has(entry.id))).map((entry) => entry.id));
      if (!state.entries.some((entry) => entry.id === state.selected)) state.selected = state.entries[0]?.id ?? null;
      retryPaths = pathsOf(state.entries); retryRecursive = false;
      state.valid = contextAtStart === contextRevision; state.phase = state.valid ? "idle" : "error";
      state.error = state.valid ? null : { code: "entry_changed" }; state.progress = null; revision++; emit();
      const at = revision;
      // Providers receive copies and can only suggest; authoritative matches remain the analyzer's.
      Promise.resolve(suggest({ entries: structuredClone(state.entries), selection: [...state.checked] }))
        .then((suggestions) => { if (revision === at) state.suggestions = suggestions; }).catch(() => {});
      return true;
    } catch (error) { fail(error); return false; }
    finally { pendingAnalyses.delete(removed); }
  }

  async function add(paths, recursive = false) {
    if (busy()) return false;
    const known = pathsOf(state.entries), fresh = paths.filter((path) => typeof path === "string" && path && !known.includes(path));
    if (!fresh.length) return false;
    return analyze([...known, ...fresh], recursive);
  }

  return {
    state, busy, selected, loadOptions,
    invalidate() {
      if (state.phase === "running") return;
      contextRevision++; revision++; state.valid = false;
      if (state.entries.length && !busy() && state.phase !== "done") { state.phase = "error"; state.error = { code: "entry_changed" }; }
      emit();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add,
    async pick(folder, recursive = false) {
      if (busy()) return false;
      const previous = state.phase;
      state.phase = "picking"; state.error = null; emit();
      try {
        const { paths } = await rpc("import.pick", { folder, recursive: folder && recursive });
        state.phase = previous; emit();
        return paths.length ? add(paths, folder && recursive) : false;
      } catch (error) { fail(error); return false; }
    },
    recheck() { return analyze(retryPaths.length ? retryPaths : pathsOf(state.entries), retryRecursive); },
    async setSource(id, server, platform) {
      if (busy() || !state.entries.some((entry) => entry.id === id)) return false;
      const contextAtStart = contextRevision;
      state.phase = "analyzing"; state.error = null; resetResults(); revision++; emit();
      try {
        const job = await rpc("import.setSource", { id, server, platform });
        const entry = await waitJob(job, progress);
        state.analysisRevision = entry.revision;
        state.entries = state.entries.map((item) => item.id === id ? entry : item);
        if (eligible(entry)) state.checked.add(id); else state.checked.delete(id);
        state.valid = contextAtStart === contextRevision;
        state.phase = state.valid ? "idle" : "error";
        state.error = state.valid ? null : { code: "entry_changed" };
        state.progress = null; revision++; emit(); return state.valid;
      } catch (error) { state.valid = false; fail(error); return false; }
    },
    toggle(id, checked) {
      if (busy() || state.phase === "done" || !state.valid || !eligible(state.entries.find((entry) => entry.id === id))) return;
      if (checked) state.checked.add(id); else state.checked.delete(id);
      state.selected = id;
      revision++; emit();
    },
    toggleGroup(ids, checked) {
      if (busy() || state.phase === "done" || !state.valid) return;
      for (const entry of state.entries) if (ids.includes(entry.id) && eligible(entry)) {
        if (checked) state.checked.add(entry.id); else state.checked.delete(entry.id);
      }
      state.selected = state.entries.find((entry) => ids.includes(entry.id) && eligible(entry))?.id || state.selected;
      revision++; emit();
    },
    select(id) {
      if (!state.entries.some((entry) => entry.id === id)) return;
      state.selected = id; emit();
    },
    checkAll(checked) {
      if (busy() || state.phase === "done" || !state.valid) return;
      state.checked = new Set(checked ? state.entries.filter(eligible).map((entry) => entry.id) : []);
      revision++; emit();
    },
    remove(id = state.selected) {
      if (busy()) return;
      state.entries = state.entries.filter((entry) => entry.id !== id); state.checked.delete(id);
      if (state.selected === id) state.selected = state.entries[0]?.id ?? null;
      retryPaths = pathsOf(state.entries); retryRecursive = false;
      revision++; emit();
    },
    leave() {
      const completed = new Set(state.entries.filter((entry) => entry.state === "done").map((entry) => entry.id));
      if (!completed.size) return;
      for (const removed of pendingAnalyses) for (const id of completed) removed.add(id);
      state.entries = state.entries.filter((entry) => !completed.has(entry.id));
      for (const id of completed) state.checked.delete(id);
      if (completed.has(state.selected)) state.selected = state.entries[0]?.id ?? null;
      retryPaths = pathsOf(state.entries); retryRecursive = false;
      if (state.phase === "done") { state.phase = "idle"; resetResults(); }
      revision++; emit();
    },
    clear() {
      if (busy()) return;
      state.entries = []; state.checked.clear(); state.selected = null; state.error = null; state.phase = "idle";
      state.valid = false; state.suggestions = []; retryPaths = []; resetResults(); revision++; emit();
    },
    async saveOptions(options) {
      if (busy()) return false;
      const previous = state.phase;
      state.phase = "saving"; emit();
      try {
        state.options = snapshot(await rpc("import.setOptions", snapshot(options)));
        state.phase = previous; state.error = null; revision++; emit(); return true;
      } catch (error) { fail(error); return false; }
    },
    async start() {
      if (busy() || !state.valid || state.phase === "done" || !selected().length) return false;
      const at = revision;
      starting = true; emit();
      try {
        if (!await loadOptions() || at !== revision || !state.valid || !selected().length) return false;
      } finally { starting = false; emit(); }
      if (at !== revision || !state.valid || !selected().length) return false;
      const entries = structuredClone(selected()), options = snapshot(state.options);
      state.taskEntries = entries; state.taskOptions = options; state.results = [];
      state.phase = "running"; state.error = null;
      state.progress = { done: 0, total: entries.length, current: entries[0].id, index: 1,
        phase: entries[0].state === "ready" ? "add" : entries[0].state === "convert" ? "convert" : "update",
        step: "import.step.check" }; emit();
      try {
        const id = await rpc("import.run", { ids: entries.map((entry) => entry.id), options,
          ...(state.analysisRevision == null ? {} : { revision: state.analysisRevision }) });
        const result = await waitJob(id, progress);
        state.results = result.results;
        const completed = new Map(state.results.filter((item) => ["imported", "updated", "unchanged"].includes(item.outcome)).map((item) => [item.id, item]));
        const blocked = new Map(state.results.filter((item) => item.state === "blocked").map((item) => [item.id, item]));
        state.entries = state.entries.map((entry) => completed.has(entry.id)
          ? { ...entry, state: "done", libraryId: completed.get(entry.id).libraryId || entry.libraryId }
          : blocked.has(entry.id) ? { ...entry, ...blocked.get(entry.id) } : entry);
        for (const id of blocked.keys()) state.checked.delete(id);
        for (const id of completed.keys()) state.checked.delete(id);
        state.phase = "done"; state.valid = false;
        state.progress = null; changed(); emit(); return true;
      } catch (error) { state.valid = false; changed(); fail(error); return false; }
    },
  };
}
