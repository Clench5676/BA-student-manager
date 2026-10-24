// Shared ZIP journey: UIPopup_Sort frame and UIPopup_Option_PC / Toggle rows.
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Loading from "./loading.js";
import { rowBase, radioRow } from "./settings-rows.js";
import { rpc, waitJob } from "./api.js";
import { T } from "./i18n.js";
import { S, hitButton, wrapPath } from "./util.js";

let active = false;

// A picker return updates the confirmation draft. Only an explicit Confirm starts a job.
export async function journey(request, deps) {
  const options = await deps.options();
  let draft = { ...options, defaultFolder: options.folder };
  for (;;) {
    const choice = await deps.confirm(draft);
    if (!choice) return null;
    draft = { ...draft, ...choice };
    if (choice.action === "choose") {
      const selected = await deps.pick(draft.folder);
      if (selected) draft.folder = selected;
      continue;
    }
    if (choice.action !== "confirm") continue;
    const result = await deps.run({ ...request, folder: draft.folder, server: draft.server, platform: draft.platform });
    if (await deps.success(result)) await deps.reveal(result.folder);
    return result;
  }
}

function confirmation(initial) {
  return new Promise((resolve, reject) => {
    const host = document.getElementById("dialog"), layer = document.createElement("div");
    layer.className = "popup-layer";
    layer.tabIndex = -1;
    host.appendChild(layer);
    host.hidden = false;
    const previous = document.activeElement;
    const draft = { ...initial };
    let ended = false, generation = 0;
    const finish = (action) => {
      if (ended) return;
      ended = true;
      Popup.closed(host, layer);
      layer.remove();
      if (!host.children.length) host.hidden = true;
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
      resolve(action ? { ...draft, action } : null);
    };
    Popup.opened(host, () => finish(null), { el: layer });
    const render = async () => {
      const mine = ++generation;
      await Popup.frameReady();
      const tree = Popup.popupFrame(T("export.title"), 1800, 1400,
        { ok: T("export.confirm"), cancel: T("export.chooseDirectory") });
      const popup = NGUI.find(tree, "Popup");
      const path = rowBase("Destination", 385, 260, T(draft.folder === draft.defaultFolder ? "export.defaultDestination" : "export.destination"));
      const fit = wrapPath(draft.folder, 44, 30, 1400, 3);
      path.children.push(NGUI.node("Path", [-718, -45], [NGUI.label(fit.text, fit.fs, "#2d4664/1.00", 1440,
        fit.fs * fit.lines * 1.3 + 10, { pivot: 3, depth: 8 })]));
      const targets = draft.targets?.length ? draft.targets : [{ server: draft.server, platform: draft.platform }];
      const servers = [...new Set(targets.map((target) => target.server))];
      const platforms = [...new Set(targets.filter((target) => target.server === draft.server).map((target) => target.platform))];
      const rows = [radioRow("Server", 85, T("export.server"), servers.map((value) => [value, T(`settings.server.${value}`)]),
        draft.server, (value) => {
          draft.server = value;
          if (!targets.some((target) => target.server === value && target.platform === draft.platform))
            draft.platform = targets.find((target) => target.server === value).platform;
          redraw();
        }), radioRow("Platform", -175, T("export.platform"), platforms.map((value) => [value, T(`import.source.${value}`)]),
        draft.platform, (value) => { draft.platform = value; redraw(); })];
      popup.children.push(path, ...rows.map((row) => row.tree));
      const next = document.createElement("div");
      const view = await NGUI.render(tree, next, { scale: S, origin: [960, 540], z: 10 });
      for (const row of rows) for (const hit of row.hits) {
        const element = view.nodes.get(`Center/Popup/${hit.path}`)?.els[0];
        if (!element) continue;
        const [x, y, w, h] = NGUI.rect(element);
        hitButton(next, [x, y, (hit.w || w / S) * S, h], hit.fn, hit.name, 80);
      }
      Popup.hit(next, view, "Center/Popup/Btn/Btn_Ok/BG (1)", () => finish("confirm"), { name: T("export.confirm"), action: "export-confirm" });
      Popup.hit(next, view, "Center/Popup/Btn/Btn_Cancel/BG (1)", () => finish("choose"), { name: T("export.chooseDirectory"), action: "export-choose" });
      Popup.hit(next, view, "Center/Popup/Base/BG/Btn_Close", () => finish(null), { name: T("display.close"), action: "close" });
      if (ended || mine !== generation) return;
      Popup.closable(view, host, () => finish(null), { el: layer });
      layer.replaceChildren(...next.childNodes);
      layer.focus?.({ preventScroll: true });
    };
    const redraw = () => render().catch((error) => { reject(error); finish(null); });
    redraw();
  });
}

export async function open(request) {
  if (active) return null;
  active = true;
  try {
    return await journey(request, {
      options: () => rpc("export.options"), confirm: confirmation,
      pick: (start) => rpc("settings.pickFolder", { start }),
      run: (params) => Loading.task(async (update) => {
        const id = await rpc("export.start", params);
        return waitJob(id, (progress) => update({ ...progress, label: T("import.step.export") }));
      }, { label: T("import.step.export") }),
      success: async () => (await Popup.message({ title: T("export.title"), lines: [T("export.success")],
        ok: T("export.openFolder"), cancel: T("popup.cancel") })).button === "ok",
      reveal: (path) => rpc("os.reveal", { path }),
    });
  } catch (error) {
    Popup.notify(T(`error.${error.code || "internal"}`, error.params || { error: String(error) }), { kind: "error", error });
    return null;
  } finally { active = false; }
}
