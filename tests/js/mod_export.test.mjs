import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-export.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export async function journey"), source.indexOf("function confirmation"))
  .replace("export async", "async");
const journey = new Function(`${body}; return journey;`)();

function harness(choices, picked = "/chosen") {
  const events = [];
  const deps = {
    options: async () => ({ folder: "/default", server: "global", platform: "windows" }),
    confirm: async (draft) => { events.push(["confirm", draft.folder]); return choices.shift(); },
    pick: async (start) => { events.push(["pick", start]); return picked; },
    run: async (params) => { events.push(["run", params]); return { folder: params.folder, archive: "done.zip" }; },
    success: async () => { events.push(["success"]); return true; },
    reveal: async (folder) => events.push(["reveal", folder]),
  };
  return { deps, events };
}

test("choosing a directory returns to confirmation and exports only on explicit Confirm", async () => {
  const h = harness([{ action: "choose" }, { action: "confirm", server: "japan", platform: "android" }]);
  await journey({ scope: "applied" }, h.deps);
  assert.deepEqual(h.events, [["confirm", "/default"], ["pick", "/default"], ["confirm", "/chosen"],
    ["run", { scope: "applied", folder: "/chosen", server: "japan", platform: "android" }], ["success"], ["reveal", "/chosen"]]);
});

test("cancelled picker retains default path; closing confirmation never starts export", async () => {
  const h = harness([{ action: "choose" }, null], null);
  assert.equal(await journey({ scope: "library" }, h.deps), null);
  assert.deepEqual(h.events, [["confirm", "/default"], ["pick", "/default"], ["confirm", "/default"]]);
});

test("failed jobs never offer success or open a directory", async () => {
  const h = harness([{ action: "confirm" }]);
  h.deps.run = async () => { throw new Error("conversion failed"); };
  await assert.rejects(journey({ scope: "single", target: "mod:1" }, h.deps), /conversion failed/);
  assert.deepEqual(h.events, [["confirm", "/default"]]);
});

test("success can be dismissed without opening a folder", async () => {
  const h = harness([{ action: "confirm" }]);
  h.deps.success = async () => false;
  await journey({ scope: "library" }, h.deps);
  assert.equal(h.events.some(([kind]) => kind === "reveal"), false);
});
