// Read structural data with the same bundled Spine runtime as the preview, without creating textures or a player.
import { T, language } from "./i18n.js";
import { rpc, waitJob } from "./api.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";
import * as Compare from "./mod-compare.js";
import { ensureSpine } from "./spine-runtime.js";
import { spine as confirmLicence } from "./consent.js";
import { jobProgress } from "./job-progress.js";

const key = (name) => name.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.png$/i, "");
const joined = (items) => items.join(/^(zh|ja)/i.test(language()) ? "、" : ", ") || "—";
const shortList = (items) => items.length > 3 ? T("compatibility.more", { names: joined(items.slice(0, 3)), n: items.length - 3 }) : joined(items);
const reports = new Map(), stamps = new Map();
function progressTask(action, name, run) {
  const text = (p = {}) => jobProgress({ action: `progress.action${action}`, name: name || T("progress.mods"),
    current: p.current || 1, total: p.total || 1, step: p.step || "" });
  return Loading.task((update) => run((p) => update({ label: text(p) })), { label: text() });
}
export const eligible = (mod) => mod?.kind !== "model" && !mod?.repaired_from && !mod?.repaired_id;
export const canRemap = (id, mod = null) => eligible(mod) && eligible(reports.get(id)) && reports.get(id)?.remappable === true;

export function readSkeleton(input, runtime = globalThis.spine) {
  const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes).trim();
  const regions = new Set();
  const use = (path, sequence) => {
    if (sequence) for (let i = 0; i < sequence.count; i++) regions.add(`${path}${String((sequence.start ?? 1) + i).padStart(sequence.digits ?? 0, "0")}`);
    else regions.add(path);
  };
  let json = null;
  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.bones) || !data.bones.length) throw new Error("Invalid skeleton data");
    json = data;
    if (!Array.isArray(json.skins)) json.skins = Object.entries(json.skins || {}).map(([name, attachments]) => ({ name, attachments }));
    if (!runtime) {
      const skins = data.skins.map((skin) => skin.attachments);
      for (const skin of skins) for (const entries of Object.values(skin || {})) for (const [name, attachment] of Object.entries(entries)) {
        if (!["boundingbox", "path", "point", "clipping"].includes(attachment.type)) use(attachment.path || name, attachment.sequence);
      }
      return { regions: [...regions], animations: Object.keys(data.animations || {}) };
    }
  }
  if (!runtime || (!json && !input.version?.startsWith("4.2."))) throw new Error("Unsupported skeleton version");
  // Read attachment paths without allocating textures.
  const create = (type, name) => {
    const attachment = new runtime[type](name);
    if (attachment.updateRegion) attachment.updateRegion = () => {};
    return attachment;
  };
  const loader = Object.fromEntries(["Region", "Mesh", "BoundingBox", "Path", "Point", "Clipping"].map((type) =>
    [`new${type}Attachment`, (_skin, name, path, sequence) => {
      if (type === "Region" || type === "Mesh") use(path || name, sequence);
      return create(`${type}Attachment`, name);
    }]));
  const data = json ? new runtime.SkeletonJson(loader).readSkeletonData(json)
    : new runtime.SkeletonBinary(loader).readSkeletonData(bytes);
  return { regions: [...regions], animations: data.animations.map((animation) => animation.name) };
}

export function compare(report, runtime = globalThis.spine, summarize = false) {
  const issues = [], add = (key, params = {}, detail = null) => issues.push({ key, params, ...(detail ? { detail } : {}) });
  const list = summarize ? shortList : joined;
  const official = report.official, mod = report.mod;
  if (report.unavailable) add("unavailable");
  const stem = (name) => key(name).replace(/\.(skel|atlas)$/i, "");
  const uses = [];
  for (const [name, source] of Object.entries(mod.skeletons)) {
    const target = official.skeletons[name] || Object.entries(official.skeletons).find(([other]) => stem(other) === stem(name))?.[1]
      || (Object.keys(mod.skeletons).length === 1 && Object.keys(official.skeletons).length === 1 ? Object.values(official.skeletons)[0] : null);
    if (target && source.version?.split(".").slice(0, 2).join(".") !== target.version?.split(".").slice(0, 2).join("."))
      add("runtimeVersion", { name, version: source.version || "?", runtime: target.version || "?" });
    try {
      const data = readSkeleton(source, runtime);
      uses.push({ name, regions: data.regions });
      if (target) {
        let required;
        try { required = readSkeleton(target, runtime).animations; } catch { add("unavailable"); }
        const missing = required?.filter((animation) => !data.animations.includes(animation)) || [];
        if (missing.length) add("missingAnimations", { name, names: list(missing) }, summarize ? { name, names: joined(missing) } : null);
      }
    } catch { add("unreadable", { name }); }
  }
  if (!Object.keys(mod.skeletons).length && Object.keys(official.skeletons).length)
    add("skeletons", { name: joined(Object.keys(official.skeletons)) });
  const atlases = (input) => Object.entries(input.atlases).map(([name, text]) => {
    try {
      const atlas = new runtime.TextureAtlas(text);
      if (!atlas.pages.length || text.includes("\ufffd")) throw new Error("Invalid atlas data");
      return { name, ...atlas };
    } catch { add("atlasUnreadable", { name }); return { name, pages: [], regions: [] }; }
  });
  const left = atlases(mod);
  const unpaired = left.filter((a) => !uses.some((s) => stem(s.name) === stem(a.name)));
  const unnamed = uses.filter((s) => !left.some((a) => stem(s.name) === stem(a.name)));
  const missing = [];
  for (const skeleton of uses) {
    const atlas = left.find((a) => stem(a.name) === stem(skeleton.name))
      || (left.length === 1 ? left[0] : unpaired.length === 1 && unnamed.length === 1 ? unpaired[0] : null);
    for (const path of skeleton.regions) {
      if (!atlas?.regions.some((r) => r.name === path)) missing.push(path);
    }
  }
  if (missing.length) add("regions", { names: list(missing) }, summarize ? { names: joined(missing) } : null);
  for (const atlas of left) for (const page of atlas.pages) {
    const size = mod.textures[key(page.name)];
    if (!size || !page.width || !page.height || size[0] * page.height !== size[1] * page.width)
      add("atlasSize", { name: page.name, atlas: `${page.width} × ${page.height}`, texture: size?.join(" × ") || "—" });
  }
  return { issues, author: issues.some(({ key }) => key !== "unavailable"),
    remap: eligible(report) && report.remappable === true && issues.some(({ key }) => ["regions", "atlasSize"].includes(key)) };
}

export async function show(report, { onRemap } = {}) {
  if (report.kind !== "model" && !await requireRuntime()) return;
  const result = compare(report, globalThis.spine, true);
  const lines = result.issues.map(({ key, params, detail }) => {
    const text = T(`compatibility.${key}`, params), full = detail ? T(`compatibility.${key}`, detail) : text;
    return text === full ? text : { text, button: { label: T("info.details"), fn: () =>
      Popup.message({ title: T("info.details"), lines: [full], scroll: true, ok: T("picker.ok") }) } };
  });
  if (!lines.length) lines.push(T("compatibility.matches"));
  if (result.author) lines.push(T("compatibility.authorHint"));
  if (result.author || result.remap) lines.push(T("compatibility.crcHint"));
  const response = await Popup.message({ title: T("compatibility.check"), lines,
    scroll: true,
    ok: T(result.remap && onRemap ? "remap.action" : "picker.ok"),
    cancel: (result.remap && onRemap) ? T("popup.cancel") : null });
  if (response.button === "ok") {
    if (result.remap && onRemap) await onRemap();
  }
}

export async function remap(id, onRemapped = () => {}, label = "", subject = label) {
  const result = await Loading.hold(() => Loading.page(() => progressTask("Remap", subject,
    async (update) => waitJob(await rpc("actions.remap", { mod: id }), update),
  )), { all: true });
  if (result.unchanged) {
    reports.set(id, { ...reports.get(id), remappable: false });
    await Popup.message({ title: T("remap.action"), lines: [T("remap.unneeded")], ok: T("picker.ok") });
    return result;
  }
  const report = result.report;
  const lines = [T("remap.counts", { moved: report.moved.length, dropped: report.dropped.length }),
    ...new Set((report.upscaled || []).map(({ w, h }) => T("remap.upscaled", { w, h }))),
    ...(report.added.length ? [T("remap.unpainted", { names: joined(report.added) })] : []),
    ...(report.dropped.length ? [T("remap.dropped", { names: joined(report.dropped) })] : []),
    ...report.warnings.map(({ key, name }) => T(`remap.${key}`, { name }))];
  try {
    const accepted = await Compare.show({ ...result.compare, pages: result.pages, drawings: result.drawings }, label || T("remap.action"), "dialog", {
      lines, partial: report.partial, accept: T("remap.accept"), discard: T("remap.discard"),
    });
    if (!accepted) return null;
    const saved = await Loading.hold(() => Loading.page(() => progressTask("Repair", subject, async (update) => {
      const saved = await waitJob(await rpc("actions.acceptRemap", { preview: result.preview }), update);
      reports.set(id, { ...reports.get(id), remappable: false, repaired_id: saved.mod.id });
      stamps.delete(id); stamps.delete(saved.mod.id);
      reports.set(saved.mod.id, { remappable: false, repaired_from: id });
      await onRemapped(saved);
      return saved;
    })), { all: true });
    return saved;
  } finally {
    await rpc("actions.discardRemap", { preview: result.preview });
  }
}

export async function inspect(id, label = "", stamp = null, subject = label) {
  stamp ??= await rpc("actions.compatibilityStamp", { mod: id });
  const report = await progressTask("Compatibility", subject,
    async (update) => waitJob(await rpc("actions.compatibility", { mod: id }), update));
  const current = await rpc("actions.compatibilityStamp", { mod: id });
  if (current !== stamp) {
    stamps.delete(id); reports.delete(id);
    throw Object.assign(new Error("Compatibility inputs changed"), { code: "entry_changed" });
  }
  stamps.set(id, stamp);
  reports.set(id, { ...report, remappable: report.kind !== "model" && await ensureSpine() ? compare(report).remap : false });
  return report;
}

// Reuse a report only while the exact Mod, install and candidate official source files still match.
export async function forUpdate(id, label = "", subject = label) {
  const stamp = await rpc("actions.compatibilityStamp", { mod: id });
  return stamps.get(id) === stamp && reports.has(id) ? reports.get(id) : inspect(id, label, stamp, subject);
}

export async function check(id, label = "", onRemapped = () => {}, mod = null, subject = label) {
  if (mod?.kind !== "model" && !await requireRuntime()) return;
  const report = await Loading.hold(() => inspect(id, label, null, subject), { all: true });
  return show(report, { onRemap: () => remap(id, onRemapped, label, subject) });
}

async function requireRuntime() {
  if (await ensureSpine()) return true;
  const response = await Popup.message({ title: T("spine.license.title"), lines: [T("spine.license.required")],
    ok: T("spine.license.confirm"), cancel: T("popup.cancel") });
  if (response.button !== "ok") return false;
  return await confirmLicence(document.getElementById("consent"), { over: true }) === true && await ensureSpine();
}
