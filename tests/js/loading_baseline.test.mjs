import assert from "node:assert/strict";
import { test } from "node:test";
import { rangeBaseline, alignBaseline, publishAligned } from "../../src/ba_modding_toolkit/web/js/loading-baseline.js";

test("the owner's DOM metrics require an upward 15.3-stage-unit correction", () => {
  const measured = rangeBaseline({ top: 998.5, height: 37.5 }, { fontBoundingBoxAscent: 30, fontBoundingBoxDescent: 7 });
  assert.equal(measured, 1028.75);
  for (const scale of [.5, 1, 1.75]) {
    const style = {}, element = { style }, stage = { getBoundingClientRect: () => ({ top: 73, width: 1920 * scale }) };
    const read = () => 73 + (measured + (element.baselineShift || 0)) * scale;
    alignBaseline(element, 1013.45, stage, read);
    assert.ok(Math.abs(element.baselineShift + 15.3) < 1e-8);
    assert.ok(Math.abs((read() - 73) / scale - 1013.45) < 1e-8);
    alignBaseline(element, 1013.45, stage, read);
    assert.ok(Math.abs(element.baselineShift + 15.3) < 1e-8, "remeasuring cannot accumulate drift");
  }
});

test("hidden connected content is aligned before publication and remeasured after text changes", () => {
  const stage = { getBoundingClientRect: () => ({ top: 0, width: 1920 }) }, events = [];
  const next = { style: { visibility: "hidden" } }, host = { replaceChildren: (child) => events.push([child.style.visibility, child.baselineShift]) };
  publishAligned(host, next, 1013.45, stage, () => 1028.75 + (next.baselineShift || 0));
  assert.deepEqual(events, [["", -15.299999999999955]]);
  alignBaseline(next, 1013.45, stage, () => 1030.5 + next.baselineShift);
  assert.ok(Math.abs(next.baselineShift + 17.05) < 1e-8);
});
