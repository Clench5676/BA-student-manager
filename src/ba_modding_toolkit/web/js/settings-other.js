// Generic library sources in Settings, using the same rows and writer jobs as the other controls.
import { notify } from "./popup.js";
import * as Loading from "./loading.js";
import * as ModSwitch from "./mod-switch.js";
import * as Popup from "./popup.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";


let busy = false;

async function write(method, params, name, changed) {
  if (busy) return;
  busy = true;
  try {
    await Loading.task(async (update) => waitJob(await rpc(method, params), update), {
      label: T(method === "mods.remove" ? "progress.delete" : method === "actions.restore" ? "progress.restore" : "progress.apply", { name }),
    }).then((result) => {
      if (result?.failed?.length) notify(T("mods.deletePending"), { kind: "error" });
    });
    await ModSwitch.refresh();
    await changed();
  } catch (err) {
    ModSwitch.refused(err, method, params);
  } finally { busy = false; }
}

export async function select(mod, changed, useMod = !mod.selected) {
  const method = useMod ? "actions.apply" : "actions.restore";
  const params = { variant: mod.target, kind: "other", ...(useMod ? { source: `mod:${mod.id}` } : {}) };
  return write(method, params, mod.label, changed);
}

export async function remove(mod, changed) {
  if (busy) return;
  try {
    const info = await rpc("mods.removalInfo", { id: mod.id });
    const answer = await Popup.message({ title: T("btn.delete"),
      lines: [T("mods.deleteConfirm", { name: info.name }), ...(info.used ? [T("mods.deleteRestore")] : [])],
      ok: T("btn.delete"), cancel: T("popup.cancel") });
    if (answer.button === "ok") await write("mods.remove", { id: mod.id, confirm: true }, info.name, changed);
  } catch (err) { ModSwitch.refused(err); }
}

export function rows(mods, valueRow, changed) {
  return mods.map((mod, i) => valueRow(`Other_${i}`, 0, mod.label,
    [T(`settings.mods.otherState.${mod.state}`), ...mod.files].join(" - "), [
      [T("settings.mods.useMod"), () => select(mod, changed, true), mod.state !== "missing" && (!mod.selected || mod.state === "changed")],
      [T("settings.mods.official"), () => select(mod, changed, false), mod.state !== "missing"],
      [T("btn.delete"), () => remove(mod, changed)],
    ], { below: true }));
}
