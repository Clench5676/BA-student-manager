// Shared by the native picker and file drops. The backend owns every target decision.
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";

let context = {};
export function init(ctx) { context = ctx; }

export function resultLines(added, name) {
  const mixed = new Set(added.map((m) => m.kind)).size > 1;
  return added.map((m) => ({ mod: m, text: T(mixed ? "add.part" : "add.belongs", {
    name: name({ variant: m.target }), kind: T(`tab.${m.kind === "spr" ? "portrait" : "lobby"}`),
  }) }));
}

export async function add(paths = null) {
  const id = await rpc(paths ? "mods.add" : "mods.pick", { ...(paths ? { paths } : {}), background: true });
  if (Array.isArray(id)) return id; // the native picker was cancelled
  const added = await Loading.task((update) => waitJob(id, update));
  if (!added?.length) return added;
  context.changed?.();
  const name = await context.names();
  const go = (mod) => context.go(mod.target);
  const rows = resultLines(added, name);
  const multiple = new Set(added.map((m) => m.target)).size > 1;
  const result = await Popup.message({ title: T("popup.add"),
    lines: rows.map(({ mod, text }) => multiple ? { text, button: {
      label: T("add.go"), fn: ({ close }) => { close("cancel"); go(mod); },
    } } : text),
    ok: T("add.go"), cancel: T("add.stay"),
  });
  if (result.button === "ok") go(added[0]);
  return added;
}
