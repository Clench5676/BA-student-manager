// Shared by the native picker and file drops. The backend owns every target decision.
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { toast } from "./util.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";

let context = {};
export function init(ctx) { context = ctx; }

// ModEntry.target and the selected roster variant's key are catalog keys, not family keys or Spine cores.
const variantKey = (key) => String(key || "").trim().toLowerCase();
const destination = (mod) => variantKey(mod.target || mod.variant);

export function resultLines(added, name) {
  const mixed = new Set(added.map((m) => m.kind)).size > 1;
  return added.map((m) => ({ mod: m, text: T(mixed ? "add.part" : "add.belongs", {
    name: name({ ...m, variant: destination(m) }).trim(), kind: T(`tab.${m.kind === "spr" ? "portrait" : "lobby"}`),
  }) }));
}

export async function add(paths = null, currentVariant = null) {
  const from = variantKey(currentVariant);
  const id = await rpc(paths ? "mods.add" : "mods.pick", { ...(paths ? { paths } : {}), background: true });
  if (Array.isArray(id)) return id; // the native picker was cancelled
  const added = await Loading.task((update) => waitJob(id, update));
  if (!added?.length) return added;
  context.changed?.();
  const elsewhere = added.filter((mod) => !from || destination(mod) !== from);
  if (!elsewhere.length) { toast(T("add.done")); return added; }
  const name = await context.names();
  const go = (mod) => context.go(destination(mod));
  const rows = resultLines(elsewhere, name);
  const multiple = new Set(elsewhere.map(destination)).size > 1;
  const result = await Popup.message({ title: T("popup.add"),
    lines: rows.map(({ mod, text }) => multiple ? { text, button: {
      label: T("add.go"), fn: ({ close }) => { close("cancel"); go(mod); },
    } } : text),
    ok: T("add.go"), cancel: T("add.stay"),
  });
  if (result.button === "ok") go(elsewhere[0]);
  return added;
}
