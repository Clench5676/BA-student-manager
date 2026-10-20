import assert from "node:assert/strict";
import { test } from "node:test";
import { lobbyIdle } from "../../src/ba_modding_toolkit/web/js/rest-pose.js";
import * as Lobby from "../../src/ba_modding_toolkit/web/js/lobby.js";

const data = (names) => ({ animations: names.map((name) => ({ name })), findAnimation: (n) => (names.includes(n) ? { name: n } : null) });

test("a lobby rests in the prefab's idle, else Idle_01, never in an intro", () => {
  assert.equal(lobbyIdle(data(["Start_Idle_01", "Idle_01", "Idle_02"]), { idle: "Idle_02" }), "Idle_02");
  assert.equal(lobbyIdle(data(["Start_Idle_01", "Idle_01"])), "Idle_01");
  assert.equal(lobbyIdle(data(["Start_Idle_01", "Idle_01"]), { idle: "Start_Idle_01" }), "Idle_01");
  assert.equal(lobbyIdle(data(["Start_Idle_01", "Dummy", "Loop_00"])), "Loop_00");
  assert.equal(lobbyIdle(data(["Start_Idle_00", "Start_Idle_01"])), null);
});

test("the lobby player and the thumbnails choose the idle with the same rule", () => {
  for (const names of [["Start_Idle_01", "Idle_01"], ["Dummy", "Start_Idle_01", "BG_Loop_00_R"], ["Start_Idle_00"]]) {
    assert.equal(Lobby.idleOf(data(names), { name: "X" }, null), lobbyIdle(data(names)));
  }
});
