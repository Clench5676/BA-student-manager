// Talks to the Python side: POST /api/rpc for calls, /api/events (Server-Sent Events) for jobs, drops and changes.

export class RpcError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export async function rpc(method, params = {}) {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) throw new RpcError("internal", { error: `HTTP ${res.status}` });
  const body = await res.json();
  if (body.error) throw new RpcError(body.error.code, body.error.params || {});
  return body.result;
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
export function waitJob(id, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; offs.forEach((f) => f()); fn(value); };
    const offs = [
      on("job.progress", (d) => { if (d.id === id) onProgress?.(d); }),
      on("job.done", (d) => { if (d.id === id) finish(resolve, d.result); }),
      on("job.failed", (d) => { if (d.id === id) finish(reject, new RpcError(d.code, d.params)); }),
    ];
    const poll = async () => {
      if (settled) return;
      try {
        const job = await rpc("jobs.get", { id });
        if (job.state === "done") return finish(resolve, job.result);
        if (job.state === "failed") return finish(reject, new RpcError(job.error?.code || "internal", job.error?.params || {}));
      } catch { /* try again */ }
      setTimeout(poll, 1500);
    };
    poll();
  });
}

// asset URLs
export const spriteUrl = (atlas, name) => `/asset/ui/sprite/${encodeURIComponent(atlas)}/${encodeURIComponent(name)}.png`;
export const textureUrl = (name) => `/asset/ui/texture/${encodeURIComponent(name)}.png`;
// what every skeleton URL of a core starts with, whatever the file: the library.changed handler forgets the
// thumbnails under it once the core's game files were switched (a mod and the official file share one URL)
export const spinePrefix = (kind, key) => `/asset/spine/${kind}/${encodeURIComponent(key)}`;
// a skeleton's base path: <base>.skel and <base>.atlas; the atlas pages resolve next to them
export const spineBase = (kind, key) => `${spinePrefix(kind, key)}/skeleton`;
export const spineFiles = (kind, key) => `/asset/spine/${kind}/${encodeURIComponent(key)}/files.json`;
