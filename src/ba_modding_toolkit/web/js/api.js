// Talks to the Python side: POST /api/rpc for calls, /api/events (Server-Sent Events) for jobs, drops and changes.
import { withPreviewTimeout as withTimeout } from "./async.js";

export class RpcError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

// timeout (ms) is opt-in: a read can wait on a writer's library lock for as long as an apply runs
export async function rpc(method, params = {}, { timeout = 0 } = {}) {
  const controller = new AbortController();
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetch("/api/rpc", {
      signal: controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) throw new RpcError("internal", { error: `HTTP ${res.status}` });
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.code, body.error.params || {});
    return body.result;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError("internal", { error: String(err) });
  } finally { clearTimeout(timer); }
}

const listeners = new Map();
let source = null;

// on("job.done", (data) => ...); returns an unsubscribe function
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  connect();
  if (source && !source.bamtEvents.has(event)) {
    source.bamtEvents.add(event);
    source.addEventListener(event, (e) => dispatch(event, e.data));
  }
  return () => listeners.get(event)?.delete(fn);
}

function dispatch(event, raw) {
  let data = {};
  try { data = JSON.parse(raw); } catch { /* keep {} */ }
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

function connect() {
  if (source) return;
  source = new EventSource("/api/events");
  source.bamtEvents = new Set();
  for (const event of listeners.keys()) {
    source.bamtEvents.add(event);
    source.addEventListener(event, (e) => dispatch(event, e.data));
  }
}

// a job's end as a promise (resolves with the result, rejects with RpcError). Events can arrive before this
// subscribes, or be lost while the event stream reconnects, so the job's state is also polled.
export function waitJob(id, onProgress, { pollEvery = 1500, maxErrors = 3, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer, deadline, errors = 0, progressSequence = 0;
    const offs = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      offs.forEach((f) => f());
      fn(value);
    };
    const failed = (error) => finish(reject, error);
    const progress = (data) => {
      if (settled) return;
      if (Number.isSafeInteger(data?.sequence)) {
        if (data.sequence <= progressSequence) return;
        progressSequence = data.sequence;
      } else if (progressSequence) return;
      onProgress?.(data);
    };
    try {
      offs.push(
        on("job.progress", (d) => { if (d.id === id) progress(d); }),
        on("job.done", (d) => { if (d.id === id) finish(resolve, d.result); }),
        on("job.failed", (d) => { if (d.id === id) failed(new RpcError(d.code, d.params)); }),
        on("server.closing", () => failed(new RpcError("internal", { error: "Server closed" }))),
      );
    } catch (err) { failed(err); return; }
    deadline = setTimeout(() => failed(new RpcError("internal", { error: "Job wait timed out" })), timeout);
    const poll = async () => {
      if (settled) return;
      try {
        const job = await rpc("jobs.get", { id }, { timeout: 15000 });
        if (settled) return;
        errors = 0;
        if (job.progress) progress(job.progress);
        if (job.state === "done") return finish(resolve, job.result);
        if (job.state === "failed") return failed(new RpcError(job.error?.code || "internal", job.error?.params || {}));
        if (job.state !== "queued" && job.state !== "running") return failed(new RpcError("internal", { error: `Job ${job.state}` }));
      } catch (err) {
        if (err.code === "job_not_found" || ++errors >= maxErrors) return failed(err);
      }
      if (!settled) timer = setTimeout(poll, pollEvery);
    };
    poll();
  });
}

// asset URLs
// The bootstrap epoch bypasses legacy max-age entries. Every new light response
// also revalidates its schema/content ETag, including after game resource changes.
export function uiExportUrl(url) {
  const epoch = globalThis.document?.querySelector?.('meta[name="bamt-ui-exports"]')?.content;
  if (!epoch || !url.startsWith("/asset/ui/")) return url;
  const parsed = new URL(url, "http://exports.invalid"); parsed.searchParams.set("export", epoch);
  return `${parsed.pathname}${parsed.search}`;
}
export const spriteUrl = (atlas, name) => uiExportUrl(`/asset/ui/sprite/${encodeURIComponent(atlas)}/${encodeURIComponent(name)}.png`);
export const textureUrl = (name) => uiExportUrl(`/asset/ui/texture/${encodeURIComponent(name)}.png`);
// what every skeleton URL of a core starts with, whatever the file: the library.changed handler forgets the
// thumbnails under it once the core's game files were switched
export const spinePrefix = (kind, key) => `/asset/spine/${kind}/${encodeURIComponent(key)}`;
// a skeleton's base path: <base>.skel and <base>.atlas; the atlas pages resolve next to them. install: the id of
// another known install (mods.state.installs[].id), whose own files the core segment <core>@<id> reads (an entry card
// of that install); none for the current install's. The id is in the path, not a query: the player fetches every
// file relative to the base.
export const spineBase = (kind, key, install = null) => `${spinePrefix(kind, key)}${install ? `@${encodeURIComponent(install)}` : ""}/skeleton`;

// Resolve on every load: the logical source can carry different files after a switch or a mod update. Keep the
// revision in the directory so the player also requests atlas pages from that same revision. A missing original
// returns null and uses the existing empty thumbnail treatment.
// Requests for one directory that overlap (a card and its big picture, the same skeleton asked for twice) share one
// answer; a request after it settled asks again.
const resolving = new Map();
export function forgetSpineAssets(prefix = "") {
  const want = prefix.toLowerCase();
  for (const dir of resolving.keys()) if (dir.toLowerCase().startsWith(want)) resolving.delete(dir);
}

export function spineAssetBase(base, { signal } = {}) {
  if (!base || /\/[a-f0-9]{64}\/skeleton$/.test(base)) return Promise.resolve(base);
  const dir = base.slice(0, base.lastIndexOf("/"));
  if (signal || !resolving.has(dir)) {
    const url = `${dir}/manifest.json`;
    const asking = withTimeout(fetch(url, { cache: "no-store", ...(signal ? { signal } : {}) }).then(async (res) => {
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        if (res.status !== 404) throw error;
        console.warn(new Error(`Spine manifest ${url}: ${error.message}`, { cause: error }));
        return null;
      }
      let manifest;
      try { manifest = await res.json(); } catch (cause) {
        throw new Error(`HTTP ${res.status}: invalid JSON`, { cause });
      }
      const revision = manifest?.revision;
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error(`HTTP ${res.status}: invalid revision`);
      return `${dir}/${revision}/skeleton`;
    }), 15000, `Spine manifest ${url}`, { signal }).catch((cause) => {
      const error = new Error(`Spine manifest ${url}: ${cause?.message || String(cause)}`, { cause });
      error.url = url;
      error.step = "manifest";
      throw error;
    }).finally(() => { if (resolving.get(dir) === asking) resolving.delete(dir); });
    // A scoped reader owns its cancellation; it must not cancel an unrelated reader of the same directory.
    if (signal) return asking;
    resolving.set(dir, asking);
  }
  return resolving.get(dir);
}

// A cold extraction can overlap a source change after its manifest answered. Retry that composition once, with
// the current manifest; every skeleton, atlas and page of an attempt still belongs to one revision.
export async function loadSpineAssets(base, load, { signal } = {}) {
  let resolved = await spineAssetBase(base, { signal });
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return null;
    if (!resolved) throw new Error(`Spine source unavailable: ${base}`);
    try { return await load(resolved); } catch (err) {
      if (signal?.aborted || attempt) throw err;
      forgetSpineAssets(base.slice(0, base.lastIndexOf("/")));
      let fresh;
      try { fresh = await spineAssetBase(base, { signal }); } catch (cause) {
        console.warn("Cannot refresh Spine source", base, cause);
        throw err;
      }
      if (!fresh || fresh === resolved) throw err;
      console.warn("Spine source changed during load", base, err);
      resolved = fresh;
    }
  }
}
