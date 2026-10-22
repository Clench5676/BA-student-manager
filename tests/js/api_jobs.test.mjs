import assert from "node:assert/strict";
import { test } from "node:test";
import { rpc, waitJob } from "../../src/ba_modding_toolkit/web/js/api.js";

let stream;
globalThis.EventSource = class {
  events = new Map();
  constructor() { stream = this; }
  addEventListener(name, fn) { this.events.set(name, fn); }
  emit(name, value) { this.events.get(name)?.({ data: JSON.stringify(value) }); }
};
const answer = (body) => ({ ok: true, json: async () => body });
const options = { pollEvery: 1, timeout: 200 };

test("polling observes a failed apply even when its event was lost, and done needs no event", async () => {
  globalThis.fetch = async () => answer({ result: { state: "failed", error: { code: "mod_target_mismatch", params: { variant: "test" } } } });
  await assert.rejects(waitJob("j1", null, options), (e) => e.code === "mod_target_mismatch");
  globalThis.fetch = async () => answer({ result: { state: "done", result: "recovered" } });
  assert.equal(await waitJob("j2", null, options), "recovered");
});

test("missing, dropped, repeatedly unreadable and permanently running jobs end the waiter", async () => {
  for (const result of [{ error: { code: "job_not_found" } }, { result: { state: "dropped" } }, null, { result: { state: "running" } }]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; if (!result) throw new Error("offline"); return answer(result); };
    await assert.rejects(waitJob("missing", null, { ...options, timeout: 15 }));
    if (!result) assert.equal(calls, 3);
  }
});

test("a transient failure retries; server shutdown rejects and a stale end cannot settle twice", async () => {
  let calls = 0;
  globalThis.fetch = async () => { if (!calls++) throw new Error("offline"); return answer({ result: { state: "done", result: 7 } }); };
  assert.equal(await waitJob("retry", null, options), 7);
  globalThis.fetch = async () => answer({ result: { state: "running" } });
  const pending = waitJob("shutdown", null, options);
  stream.emit("server.closing", {});
  await assert.rejects(pending, /internal/);
  stream.emit("job.done", { id: "shutdown", result: 8 });
});

test("an RPC that never answers is aborted and reported as an internal error", async () => {
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
  });
  await assert.rejects(rpc("actions.apply", {}, { timeout: 5 }), (e) => e.code === "internal" && /timed out/.test(e.params.error));
});

test("polling forwards durable progress after a lost event and retries transient errors", async () => {
  const seen = [];
  const progress = { id: "add", current: 2, total: 3, label: "dress_home.bundle" };
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new Error("offline");
    return answer({ result: calls === 2 ? { state: "running", progress }
      : { state: "done", progress: { ...progress, current: 3 }, result: ["added"] } });
  };
  assert.deepEqual(await waitJob("add", (p) => seen.push(p), options), ["added"]);
  assert.deepEqual(seen, [progress, { ...progress, current: 3 }]);
});

test("a late poll cannot forward progress after the waiter has ended", async () => {
  for (const end of ["event", "timeout", "shutdown"]) {
    const seen = [];
    let respond;
    globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
    const pending = waitJob("late", (p) => seen.push(p), { ...options, timeout: 10 });
    if (end === "event") {
      stream.emit("job.done", { id: "late", result: "done" });
      assert.equal(await pending, "done");
    } else {
      if (end === "shutdown") stream.emit("server.closing", {});
      await assert.rejects(pending, /internal/);
    }
    respond(answer({ result: { state: "running", progress: { id: "late", current: 1, total: 2 } } }));
    await new Promise(setImmediate);
    assert.deepEqual(seen, []);
  }
});

test("a delayed poll and duplicate SSE cannot overwrite newer sequenced progress", async () => {
  let respond;
  const seen = [];
  globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
  const pending = waitJob("ordered", (p) => seen.push(p), { pollEvery: 1000, timeout: 200 });
  stream.emit("job.progress", { id: "ordered", sequence: 4, done: 39, total: 47 });
  respond(answer({ result: { state: "running", progress: { id: "ordered", sequence: 3, done: 38, total: 47 } } }));
  await new Promise(setImmediate);
  stream.emit("job.progress", { id: "ordered", sequence: 4, done: 39, total: 47 });
  stream.emit("job.progress", { id: "ordered", sequence: 2, done: 37, total: 47 });
  stream.emit("job.progress", { id: "ordered", sequence: 5, done: 40, total: 47 });
  stream.emit("job.done", { id: "ordered", result: "done" });
  assert.equal(await pending, "done");
  assert.deepEqual(seen.map((p) => [p.sequence, p.done]), [[4, 39], [5, 40]]);
});

test("polling recovers a missing progress event and ordering starts afresh for each job", async () => {
  for (const id of ["first", "next"]) {
    const seen = [];
    globalThis.fetch = async () => answer({ result: {
      state: "done", progress: { id, sequence: 1, done: 1, total: 1 }, result: "done",
    } });
    assert.equal(await waitJob(id, (p) => seen.push(p), options), "done");
    assert.deepEqual(seen, [{ id, sequence: 1, done: 1, total: 1 }]);
  }
});
