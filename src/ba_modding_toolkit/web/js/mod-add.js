// Shared by the native picker and file drops. The backend owns every target decision.
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { toast } from "./util.js";
import * as Compatibility from "./mod-compatibility.js";
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
  const report = await Loading.task((update) => waitJob(id, update));
  const added = Array.isArray(report) ? report : report?.added || [];
  const duplicates = report?.duplicates || [], installed = report?.installed || [];
  if (!added.length && !duplicates.length) return report;
  if (added.length || installed.length) context.changed?.();
  const failures = new Map((report?.failed || []).map((failure) => [failure.id,
    T("add.applyFailed", { reason: T(`error.${failure.code}`, failure.params) })]));
  for (const mod of added) {
    const checked = report?.compatibility?.[mod.id];
    if (checked && Compatibility.compare(checked).issues.length) await Compatibility.show(checked, { label: mod.label,
      onUpdate: async () => {
        await Loading.task(async (update) => waitJob(await rpc("actions.update", { mod: mod.id }), update));
        context.changed?.();
        await Compatibility.check(mod.id, mod.label);
      } });
  }
  const installedIds = new Set(installed.map((m) => m.id));
  const visibleAdded = added.filter((mod) => !from || destination(mod) !== from || installedIds.has(mod.id) || failures.has(mod.id));
  if (visibleAdded.length < added.length) toast(T("add.done"));
  if (!visibleAdded.length && !duplicates.length) return report;
  const name = await context.names();
  const go = (mod) => context.go(destination(mod));
  const elsewhere = added.filter((mod) => !from || destination(mod) !== from);
  const addedLines = new Map(resultLines(elsewhere, name).map(({ mod, text }) => [mod, text]));
  const rows = [
    ...visibleAdded.map((mod) => ({ mod, text: [addedLines.get(mod), installedIds.has(mod.id) ? T("add.installed") : null, failures.get(mod.id)]
      .filter(Boolean).join("\n") })),
    ...duplicates.map((mod) => ({ mod, text: T("add.duplicate", { name: mod.label.trim() })
      + (installedIds.has(mod.id) ? `\n${T("add.installed")}` : "") })),
  ];
  const destinations = rows.filter(({ mod }) => !from || destination(mod) !== from);
  const multiple = new Set(rows.map(({ mod }) => destination(mod))).size > 1;
  const result = await Popup.message({ title: T("popup.add"),
    lines: rows.map(({ mod, text }) => multiple && (!from || destination(mod) !== from) ? { text, button: {
      label: T("add.go"), fn: ({ close }) => { close("cancel"); go(mod); },
    } } : text),
    ok: T(destinations.length ? "add.go" : "picker.ok"),
    cancel: destinations.length ? T(duplicates.length && !added.length ? "picker.ok" : "add.stay") : null,
  });
  if (result.button === "ok" && destinations.length) go(destinations[0].mod);
  return report;
}
