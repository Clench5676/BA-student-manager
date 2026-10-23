import assert from "node:assert/strict";
import { test } from "node:test";
import { waitJob } from "../../src/ba_modding_toolkit/web/js/api.js";

class Events {
  listeners = new Map();
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, value = {}) { for (const fn of this.listeners.get(name) || []) fn(value); }
  count() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
}
let stream;
globalThis.EventSource = class extends Events {
  constructor() { super(); stream = this; }
  emit(name, data = {}) { super.emit(name, { data: JSON.stringify(data) }); }
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const answer = (job) => ({ ok: true, json: async () => ({ result: job }) });

async function virtualSession(run) {
  const keys = ["setTimeout", "clearTimeout", "fetch", "addEventListener", "removeEventListener", "document"];
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 0, next = 0;
  const timers = new Map(), windowEvents = new Events(), document = new Events();
  document.hidden = false;
  Object.assign(globalThis, {
    document,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const advance = async (ms = 0) => {
    now += ms;
    for (let guard = 0; guard < 100; guard++) {
      const due = [...timers].filter(([, timer]) => timer.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) { await flush(); return; }
      timers.delete(due[0]); due[1].fn(); await flush();
    }
    assert.fail("Unexpected timer loop");
  };
  const requests = [];
  const serve = (handler) => {
    globalThis.fetch = (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, "jobs.get", "recovery may only read the original job");
      requests.push({ ...request, signal: options.signal });
      return handler(request.params.id, options.signal, requests.length);
    };
  };
  try { await run({ advance, sleep: (ms) => { now += ms; }, windowEvents, document, serve, requests, timers }); }
  finally {
    stream?.emit("server.closing"); await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test("a healthy batch can run longer than thirty minutes and resume after an eight-hour sleep", async () => {
  await virtualSession(async ({ serve, advance, sleep, windowEvents, requests, timers, document }) => {
    let done = 30, state = "running", result, sequence = 0;
    serve(async (id) => answer({ state, progress: { id, sequence: ++sequence, done, total: 80 }, result: { imported: 80 } }));
    const progress = [];
    const waiting = waitJob("batch", (p) => progress.push(p.done)).then((value) => { result = value; });
    await flush();
    for (let i = 0; i < 4; i++) { done++; await advance(10 * 60 * 1000); }
    assert.equal(result, undefined);
    sleep(8 * 60 * 60 * 1000); done = 66;
    windowEvents.emit("focus"); await advance();
    assert.equal(result, undefined); assert.equal(progress.at(-1), 66);
    state = "done"; done = 80;
    stream.emit("open"); await advance(); await waiting;
    assert.deepEqual(result, { imported: 80 });
    assert.ok(requests.every((request) => request.params.id === "batch"));
    assert.equal(timers.size, 0); assert.equal(windowEvents.count(), 0); assert.equal(document.count(), 0);
  });
});

for (const event of ["focus", "pageshow", "visibilitychange", "open"]) test(`${event} replaces a stale pre-sleep read and recovers a lost completion`, async () => {
  await virtualSession(async ({ serve, advance, sleep, windowEvents, document, requests }) => {
    let oldReply, result;
    const seen = [];
    serve(async (_id, _signal, number) => number === 1 ? new Promise((resolve) => { oldReply = resolve; })
      : answer({ state: "done", progress: { sequence: 9, done: 80, total: 80 }, result: "recovered" }));
    const waiting = waitJob("same-job", (p) => seen.push(p.done)).then((value) => { result = value; });
    await flush(); sleep(8 * 60 * 60 * 1000);
    if (event === "open") stream.emit(event);
    else (event === "visibilitychange" ? document : windowEvents).emit(event);
    await advance(); await waiting;
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(result, "recovered"); assert.equal(requests.length, 2);
    oldReply(answer({ state: "failed", error: { code: "stale" }, progress: { sequence: 1, done: 30 } }));
    await flush(); assert.deepEqual(seen, [80]);
    windowEvents.emit("focus"); stream.emit("open"); document.emit("visibilitychange");
    await advance(); assert.equal(requests.length, 2, "finished waits release all recovery listeners");
  });
});

test("several transient failures preserve the task and recover without resubmitting", async () => {
  await virtualSession(async ({ serve, advance, requests }) => {
    let result;
    const connection = [], progress = [];
    serve(async (id, _signal, number) => {
      if (number > 1 && number < 7) throw new Error("Connection unavailable");
      return answer({ state: number === 7 ? "done" : "running", progress: { id, sequence: number, done: number === 7 ? 80 : 66, total: 80 }, result: "finished" });
    });
    const waiting = waitJob("retained", (p) => progress.push(p.done), { onConnection: (value) => connection.push(value) })
      .then((value) => { result = value; });
    await flush();
    for (let i = 0; i < 5; i++) {
      await advance(15000);
      assert.equal(result, undefined); assert.deepEqual(progress, [66]);
    }
    await advance(15000); await waiting;
    assert.equal(requests.length, 7); assert.deepEqual(connection, [false, true]);
    assert.deepEqual(progress, [66, 80]); assert.equal(result, "finished");
  });
});

test("a stalled status read is bounded but cannot fail the backend job", async () => {
  await virtualSession(async ({ serve, advance }) => {
    const connection = [];
    serve(async (_id, signal, number) => number === 1 ? new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Read timed out")), { once: true });
    }) : answer({ state: "done", result: "finished" }));
    const waiting = waitJob("slow-read", null, { onConnection: (value) => connection.push(value) });
    await flush(); await advance(15000);
    assert.deepEqual(connection, [false]);
    stream.emit("open"); await advance();
    assert.equal(await waiting, "finished"); assert.deepEqual(connection, [false, true]);
  });
});

test("wake still reports a confirmed backend failure and does not poll hidden transitions", async () => {
  await virtualSession(async ({ serve, advance, document, requests }) => {
    let state = "running";
    serve(async () => answer({ state, error: { code: "conversion_failed" } }));
    const waiting = waitJob("failed"); const rejected = assert.rejects(waiting, (error) => error.code === "conversion_failed");
    await flush(); document.hidden = true; document.emit("visibilitychange");
    await advance(); assert.equal(requests.length, 1);
    state = "failed"; document.hidden = false; document.emit("visibilitychange");
    await advance(); await rejected;
  });
});

test("a failing UI observer cannot strand reconnection or discard a backend result", async () => {
  const errors = [], previous = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await virtualSession(async ({ serve, advance, requests }) => {
      serve(async (_id, _signal, number) => {
        if (number === 1) throw new Error("Temporary disconnect");
        return answer({ state: number === 3 ? "done" : "running", progress: { sequence: number, done: number }, result: "finished" });
      });
      const observer = () => { throw new Error("UI observer failed"); };
      const waiting = waitJob("observer", observer, { onConnection: observer });
      await flush(); await advance(15000); await advance(15000);
      assert.equal(await waiting, "finished"); assert.equal(requests.length, 3);
      assert.equal(errors.length, 4, "both connection changes and both progress snapshots were isolated");
    });
  } finally { console.error = previous; }
});
