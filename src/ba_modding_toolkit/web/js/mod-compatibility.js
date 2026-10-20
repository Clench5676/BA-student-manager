// Read structural data with the same bundled Spine runtime as the preview, without creating textures or a player.
import { T, language } from "./i18n.js";
import { rpc, waitJob } from "./api.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";
import * as Compare from "./mod-compare.js";

const key = (name) => name.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.png$/i, "");
const joined = (items) => items.join(/^(zh|ja)/i.test(language()) ? "、" : ", ") || "—";
const shortList = (items) => items.length > 3 ? T("compatibility.more", { names: joined(items.slice(0, 3)), n: items.length - 3 }) : joined(items);
const reports = new Map();
export const eligible = (mod) => !mod?.repaired_from && !mod?.repaired_id;
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
      return { regions: [...regions] };
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
  json ? new runtime.SkeletonJson(loader).readSkeletonData(json)
    : new runtime.SkeletonBinary(loader).readSkeletonData(bytes);
  return { regions: [...regions] };
}

export function compare(report, runtime = globalThis.spine, summarize = false) {
  const issues = [], add = (key, params = {}, detail = null) => issues.push({ key, params, ...(detail ? { detail } : {}) });
  const list = summarize ? shortList : joined;
  const official = report.official, mod = report.mod;
  if (report.unavailable) add("unavailable");
  const uses = [];
  for (const [name, source] of Object.entries(mod.skeletons)) {
    const target = official.skeletons[name];
    if (target && source.version?.split(".").slice(0, 2).join(".") !== target.version?.split(".").slice(0, 2).join("."))
      add("version", { name, mod: source.version || "?", official: target.version || "?" });
    try { uses.push({ name, regions: readSkeleton(source, runtime).regions }); }
    catch { add("unreadable", { name }); }
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
  const left = atlases(mod), right = atlases(official);
  const stem = (name) => key(name).replace(/\.(skel|atlas)$/i, "");
  const unpaired = left.filter((a) => !uses.some((s) => stem(s.name) === stem(a.name)));
  const unnamed = uses.filter((s) => !left.some((a) => stem(s.name) === stem(a.name)));
  const used = new Map(left.map((a) => [a, new Set()])), missing = [];
  for (const skeleton of uses) {
    const atlas = left.find((a) => stem(a.name) === stem(skeleton.name))
      || (left.length === 1 ? left[0] : unpaired.length === 1 && unnamed.length === 1 ? unpaired[0] : null);
    for (const path of skeleton.regions) {
      if (atlas) used.get(atlas).add(path);
      if (!atlas?.regions.some((r) => r.name === path)) missing.push(path);
    }
  }
  if (missing.length) add("regions", { names: list(missing) }, summarize ? { names: joined(missing) } : null);
  for (const atlas of left) for (const page of atlas.pages) {
    if (!page.regions.some((r) => used.get(atlas).has(r.name))) continue;
    const size = mod.textures[key(page.name)];
    if (!size || !page.width || !page.height || size[0] * page.height !== size[1] * page.width)
      add("atlasSize", { name: page.name, atlas: `${page.width} × ${page.height}`, texture: size?.join(" × ") || "—" });
  }
  const rect = (r) => [key(r.page.name), r.index, r.degrees, r.x / r.page.width, r.y / r.page.height,
    r.width / r.page.width, r.height / r.page.height, r.offsetX / r.originalWidth, r.offsetY / r.originalHeight,
    r.width / r.originalWidth, r.height / r.originalHeight];
  for (const atlas of right) {
    const source = left.find((a) => key(a.name) === key(atlas.name)) || (left.length === 1 && right.length === 1 ? left[0] : null);
    if (!source) continue;
    const layout = (a, path) => JSON.stringify(a.regions.filter((r) => r.name === path).map(rect).sort());
    if ([...used.get(source)].some((path) => atlas.regions.some((r) => r.name === path) && layout(source, path) !== layout(atlas, path)))
      add("atlasLayout", { name: atlas.name });
  }
  return { issues, author: issues.some(({ key }) => !["atlasLayout", "unavailable"].includes(key)),
    remap: eligible(report) && report.remappable === true && issues.some(({ key }) => ["atlasLayout", "regions", "atlasSize"].includes(key)) };
}

export async function show(report, { label = "", onRemap } = {}) {
  const result = compare(report, globalThis.spine, true);
  const lines = result.issues.map(({ key, params, detail }) => {
    const text = T(`compatibility.${key}`, params), full = detail ? T(`compatibility.${key}`, detail) : text;
    return text === full ? text : { text, button: { label: T("info.details"), fn: () =>
      Popup.message({ title: T("info.details"), lines: [full], scroll: true, ok: T("picker.ok") }) } };
  });
  if (!lines.length) lines.push(T("compatibility.matches"));
  if (result.author) lines.push(T("compatibility.authorHint"));
  if (result.author || result.remap) lines.push(T("compatibility.crcHint"));
  const response = await Popup.message({ title: T("compatibility.check"), lines: [...(label ? [label] : []), ...lines],
    scroll: true,
    ok: T(result.remap && onRemap ? "remap.action" : "picker.ok"),
    cancel: (result.remap && onRemap) ? T("popup.cancel") : null });
  if (response.button === "ok") {
    if (result.remap && onRemap) await onRemap();
  }
}

export async function remap(id, onRemapped = () => {}, label = "") {
  const result = await Loading.hold(() => Loading.scene(() => rpc("actions.remap", { mod: id }).then((job) => waitJob(job))), { all: true });
  if (result.unchanged) {
    reports.set(id, { ...reports.get(id), remappable: false });
    await Popup.message({ title: T("remap.action"), lines: [T("remap.unneeded")], ok: T("picker.ok") });
    return result;
  }
  const report = result.report;
  const lines = [T("remap.counts", { moved: report.moved.length, added: report.added.length, dropped: report.dropped.length }),
    ...new Set((report.upscaled || []).map(({ w, h }) => T("remap.upscaled", { w, h }))),
    ...(report.dropped.length ? [T("remap.dropped", { names: joined(report.dropped) })] : []),
    ...report.warnings.map(({ key, name }) => T(`remap.${key}`, { name }))];
  try {
    const accepted = await Compare.show({ ...result.compare, pages: result.pages, drawings: result.drawings }, label || T("remap.action"), "dialog", {
      lines, partial: report.partial, accept: T("remap.accept"), discard: T("remap.discard"),
    });
    if (!accepted) return null;
    const saved = await Loading.hold(() => Loading.scene(async () => {
      const saved = await waitJob(await rpc("actions.acceptRemap", { preview: result.preview }));
      reports.set(id, { ...reports.get(id), remappable: false, repaired_id: saved.mod.id });
      reports.set(saved.mod.id, { remappable: false, repaired_from: id });
      await onRemapped(saved);
      return saved;
    }), { all: true });
    return saved;
  } finally {
    await rpc("actions.discardRemap", { preview: result.preview });
  }
}

export async function check(id, label = "", onRemapped = () => {}) {
  const report = await Loading.task(async (update) => waitJob(await rpc("actions.compatibility", { mod: id }), update));
  reports.set(id, { ...report, remappable: compare(report).remap });
  return show(report, { label, onRemap: () => remap(id, onRemapped, label) });
}
