import assert from "node:assert/strict";
import { test } from "node:test";
import { latestLoad, loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";

const tick = () => new Promise(setImmediate);
function runtime() {
  const players = [], calls = [];
  return { players, calls, create(config) {
    const p = { config, disposed: false, dispose() { assert.equal(this.disposed, false); this.disposed = true; calls.push("dispose"); } };
    players.push(p);
    calls.push("create");
    return p;
  } };
}

test("only the newest view starts, and the old GPU owner is disposed before the next is created", async () => {
  const queue = latestLoad(), r = runtime(), shown = [];
  const show = (name) => queue.run(async (signal) => {
    const load = loadPlayer(r.create, { skeleton: `${name}.skel`, atlas: `${name}.atlas`, success(p) {
      assert.equal(p.disposed, false);
      shown.push([p.config.skeleton, p.config.atlas]);
    } }, { signal });
    return load.ready;
  });
  const a = show("a");
  await tick();
  const old = r.players[0];
  const b = show("b"), c = show("c");
  await tick();
  assert.deepEqual(r.calls, ["create", "dispose", "create"]);
  assert.equal(r.players[1].config.atlas, "c.atlas");
  old.config.success(old); // an already queued callback from the cancelled load
  old.config.frame?.(old);
  assert.deepEqual(shown, []);
  r.players[1].config.success(r.players[1]);
  assert.deepEqual(await Promise.all([a, b, c]), [null, null, r.players[1]]);
  assert.deepEqual(shown, [["c.skel", "c.atlas"]]);
  queue.cancel();
});

test("leaving ends a missing callback and queued metadata cannot resurrect a hidden view", async () => {
  const queue = latestLoad(), r = runtime();
  let finishMetadata;
  const old = queue.run(async (signal) => {
    await new Promise((resolve) => { finishMetadata = resolve; });
    if (signal.aborted) return null;
    return loadPlayer(r.create, {}, { signal }).ready;
  });
  await tick();
  queue.cancel();
  assert.equal(await old, null);
  const next = queue.run(() => "next");
  assert.equal(await next, "next");
  finishMetadata();
  await tick();
  assert.equal(r.players.length, 0);
});

test("constructor, success hook, failed bundle and absent callbacks all settle, then a later load works", async () => {
  for (const fail of ["constructor", "success", "bundle", "missing"]) {
    const queue = latestLoad(), r = runtime();
    const failed = queue.run((signal) => {
      const load = loadPlayer((config) => {
        if (fail === "constructor") throw new Error("constructor");
        return r.create(config);
      }, { success() { throw new Error("success"); } }, { signal, timeout: 10 });
      if (fail === "success") load.player.config.success(load.player);
      if (fail === "bundle") load.player.config.error(load.player, "bundle");
      return load.ready;
    });
    await assert.rejects(failed, /constructor|success|bundle|timed out/);
    assert.ok(r.players.every((p) => p.disposed));
    assert.equal(await queue.run(() => "recovered"), "recovered");
    queue.cancel();
  }
});

test("a timed-out async success and disposed frames cannot use freed textures", async () => {
  const r = runtime();
  let finish, live, frames = 0;
  const load = loadPlayer(r.create, { frame() { frames++; }, async success(_p, alive) {
    live = alive;
    await new Promise((resolve) => { finish = resolve; });
    assert.equal(alive(), false);
  } }, { timeout: 10 });
  load.player.config.success(load.player);
  await assert.rejects(load.ready, /timed out/);
  assert.equal(live(), false);
  load.player.config.frame(load.player);
  assert.equal(frames, 0);
  finish();
  load.dispose(); // disposal is idempotent
});

test("runtime errors and hook exceptions after readiness notify the owner with URL and step", async () => {
  for (const step of ["render", "frame", "draw", "update", "updateWorldTransform"]) {
    const r = runtime(), errors = [];
    const hooks = step === "render" ? {} : { [step]() { throw new Error("Late failure"); } };
    const load = loadPlayer(r.create, { skeleton: "/revision/shun_home.skel", ...hooks }, { onError: (err) => errors.push(err) });
    load.player.config.success(load.player);
    await load.ready;
    if (step === "render") load.player.config.error(load.player, "Late failure");
    else load.player.config[step](load.player);
    load.player.config.error(load.player, "Duplicate failure");
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].url, "/revision/shun_home.skel");
    assert.equal(errors[0].step, step);
    assert.equal(load.player.disposed, true);
  }
});
