import assert from "node:assert/strict";
import { test } from "node:test";
import { captureRetries } from "../../src/ba_modding_toolkit/web/js/capture-retries.js";

test("a busy queue cannot spend retry backoff or attempts, including work arriving during backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wakes = 0;
  const retries = captureRetries(() => wakes++), item = {}, error = new Error("capture: timed out");
  try {
    for (const delay of [2000, 5000, 15000]) {
      assert.equal(retries.defer(item, error), true);
      retries.busy(); t.mock.timers.tick(60000);
      assert.equal(retries.take(), null);
      retries.idle(); t.mock.timers.tick(delay - 1); assert.equal(retries.take(), null);
      // A new foreground capture interrupts the idle interval without using an attempt.
      retries.busy(); t.mock.timers.tick(60000); assert.equal(retries.take(), null);
      retries.idle(); t.mock.timers.tick(delay - 1); assert.equal(retries.take(), null);
      t.mock.timers.tick(1); assert.equal(retries.take(), item);
    }
    assert.equal(wakes, 3); assert.equal(item.retries, 3);
    assert.equal(retries.defer(item, error), false);
    assert.equal(retries.defer({}, new Error("invalid skeleton")), false);
  } finally { t.mock.timers.reset(); }
});

test("modal eligibility suspends background retries and cancellation removes armed timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retries = captureRetries(() => {}), foreground = {}, background = {}, error = new Error("capture: timed out");
  try {
    retries.defer(foreground, error); retries.defer(background, error);
    retries.idle((item) => item === foreground); t.mock.timers.tick(60000);
    assert.equal(retries.take((item) => item === background), null);
    assert.equal(retries.take(), foreground);
    retries.idle(); retries.delete(background); t.mock.timers.tick(60000);
    assert.equal(retries.take(), null);
  } finally { t.mock.timers.reset(); }
});
