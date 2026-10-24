import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ROUTE, routeHistory } from "../../src/ba_modding_toolkit/web/js/route-history.js";

test("menu entry points preserve a return stack rooted at Student Hall", () => {
  const h = routeHistory();
  for (const route of ["#/roster", "#/student/aru/aru", "#/import", "#/student/hoshino/hoshino/lobby"]) h.commit(route);
  assert.equal(h.back(), "#/import"); h.commit("#/import");
  assert.equal(h.back(), "#/student/aru/aru"); h.commit("#/student/aru/aru");
  assert.equal(h.back(), "#/roster"); h.commit("#/roster");
  assert.equal(h.back(), ROOT_ROUTE); h.commit(ROOT_ROUTE);
  assert.equal(h.back(), null);
});

test("detail arrows and tabs replace the current entry without losing its import origin", () => {
  const h = routeHistory(); h.commit("#/import");
  h.commit("#/student/aru/aru/portrait"); h.commit("#/student/aru/dress/lobby");
  assert.deepEqual(h.entries(), [ROOT_ROUTE, "#/import", "#/student/aru/dress/lobby"]);
  assert.equal(h.back(), "#/import");
});

test("Back cancels uncommitted navigation and repeated page refreshes add no entries", () => {
  const h = routeHistory(); h.commit("#/roster"); h.commit("#/roster");
  assert.equal(h.back("#/student/missing/missing"), "#/roster");
  assert.deepEqual(h.entries(), [ROOT_ROUTE, "#/roster"]);
  assert.equal(h.back(), ROOT_ROUTE);
});

test("a committed Home action resets the return path to the root", () => {
  const h = routeHistory();
  h.commit("#/import"); h.commit("#/student/hoshino/hoshino");
  h.commit(ROOT_ROUTE, { home: true });
  assert.deepEqual(h.entries(), [ROOT_ROUTE]);
  h.commit("#/roster");
  assert.equal(h.back(), ROOT_ROUTE);
});
