// Read structural data with the same bundled Spine runtime as the preview, without creating textures or a player.
import { T, language } from "./i18n.js";
import { rpc, waitJob } from "./api.js";
import * as Loading from "./loading.js";
import * as Popup from "./popup.js";
import * as Compare from "./mod-compare.js";

const key = (name) => name.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.png$/i, "");
const names = (items) => items.map((item) => item.name);
const difference = (a, b) => [...new Set(a)].filter((name) => !b.includes(name)).sort();
const joined = (items) => items.join(/^(zh|ja)/i.test(language()) ? "、" : ", ") || "—";
const shortList = (items) => items.length > 3 ? T("compatibility.more", { names: joined(items.slice(0, 3)), n: items.length - 3 }) : joined(items);
const reports = new Map();
export const canRemap = (id) => reports.get(id)?.remappable === true;
const geometry = (attachment) => JSON.stringify(Object.fromEntries(["type", "path", "vertexCount", "worldVerticesLength",
  "uvs", "regionUVs", "vertices", "bones", "triangles", "parent", "skin", "width", "height", "x", "y", "rotation", "scaleX", "scaleY"]
  .filter((key) => attachment[key] !== undefined).map((key) => [key,
    ArrayBuffer.isView(attachment[key]) ? Array.from(attachment[key]) : attachment[key]])));
const boneGeometry = (bones) => JSON.stringify(bones.map((bone) => [bone.name, bone.parent?.name || bone.parent,
  ...["length", "x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "transformMode", "inherit"].map((key) => bone[key])]));

export function readSkeleton(input, runtime = globalThis.spine) {
  const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes).trim();
  let json = null;
  if (text.startsWith("{")) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.bones) || !data.bones.length) throw new Error("Invalid skeleton data");
    json = data;
    if (!Array.isArray(json.skins)) json.skins = Object.entries(json.skins || {}).map(([name, attachments]) => ({ name, attachments }));
    if (!runtime) {
      const skins = data.skins.map((skin) => skin.attachments);
      return { bones: data.bones, slots: data.slots || [], animations: Object.keys(data.animations || {}).map((name) => ({ name })),
        attachments: skins.flatMap((skin) => Object.entries(skin || {}).flatMap(([slot, entries]) =>
          Object.keys(entries).map((name) => `${slot}/${name}`))),
        geometry: skins.map((skin) => Object.fromEntries(Object.entries(skin || {}).flatMap(([slot, entries]) =>
          Object.entries(entries).map(([name, attachment]) => [`${slot}/${name}`, geometry(attachment)])))) };
    }
  }
  if (!runtime || (!json && !input.version?.startsWith("4.2."))) throw new Error("Unsupported skeleton version");
  // Read actual attachment geometry without allocating textures.
  const create = (type, name) => {
    const attachment = new runtime[type](name);
    if (attachment.updateRegion) attachment.updateRegion = () => {};
    return attachment;
  };
  const loader = Object.fromEntries(["Region", "Mesh", "BoundingBox", "Path", "Point", "Clipping"].map((type) =>
    [`new${type}Attachment`, (_skin, name) => create(`${type}Attachment`, name)]));
  const data = json ? new runtime.SkeletonJson(loader).readSkeletonData(json)
    : new runtime.SkeletonBinary(loader).readSkeletonData(bytes);
  return { bones: data.bones, slots: data.slots, animations: data.animations,
    attachments: data.skins.flatMap((skin) => skin.getAttachments().map((entry) =>
      `${data.slots[entry.slotIndex].name}/${entry.name}`)),
    geometry: data.skins.map((skin) => Object.fromEntries(skin.getAttachments().map((entry) =>
      [`${data.slots[entry.slotIndex].name}/${entry.name}`, geometry(entry.attachment)]))) };
}

export function compare(report, runtime = globalThis.spine, summarize = false) {
  const issues = [], add = (key, params = {}, detail = null) => issues.push({ key, params, ...(detail ? { detail } : {}) });
  const list = summarize ? shortList : joined;
  const official = report.official, mod = report.mod;
  if (report.unavailable) add("unavailable");
  if (report.outdated) add("outdated");
  for (const name of new Set([...Object.keys(official.skeletons), ...Object.keys(mod.skeletons)])) {
    const source = mod.skeletons[name], target = official.skeletons[name];
    if (!source || !target) { add("skeletons", { name }); continue; }
    if (source.version !== target.version) add("version", { name, mod: source.version || "?", official: target.version || "?" });
    let left, right;
    try { left = readSkeleton(source, runtime); right = readSkeleton(target, runtime); }
    catch { add("unreadable", { name }); continue; }
    for (const [field, a, b] of [["animations", names(left.animations), names(right.animations)],
      ["slots", names(left.slots), names(right.slots)], ["attachments", left.attachments, right.attachments]]) {
      const removed = difference(b, a), added = difference(a, b);
      if (removed.length || added.length) add(field, { name, missing: list(removed), added: list(added) },
        summarize ? { name, missing: joined(removed), added: joined(added) } : null);
    }
    if (left.bones.length !== right.bones.length) add("bones", { name, mod: left.bones.length, official: right.bones.length });
    else if (boneGeometry(left.bones) !== boneGeometry(right.bones)) add("rig", { name });
    if (JSON.stringify(left.attachments) === JSON.stringify(right.attachments)
      && JSON.stringify(left.geometry) !== JSON.stringify(right.geometry)) add("geometry", { name });
  }
  const pages = (input) => Object.entries(input.atlases).flatMap(([name, text]) => {
    try {
      const pages = new runtime.TextureAtlas(text).pages;
      if (!pages.length || text.includes("\ufffd")) throw new Error("Invalid atlas data");
      return pages;
    } catch { add("atlasUnreadable", { name }); return []; }
  });
  const leftPages = pages(mod), rightPages = pages(official);
  const leftNames = leftPages.map((p) => p.name), rightNames = rightPages.map((p) => p.name);
  const missing = difference(rightNames, leftNames), added = difference(leftNames, rightNames);
  if (missing.length || added.length) add("pages", { missing: list(missing), added: list(added) },
    summarize ? { missing: joined(missing), added: joined(added) } : null);
  for (const page of leftPages) {
    const size = mod.textures[key(page.name)];
    const expected = official.textures[key(page.name)];
    if (!size || (page.width && page.height && (page.width !== size[0] || page.height !== size[1])))
      add("atlasSize", { name: page.name, atlas: `${page.width} × ${page.height}`, texture: size?.join(" × ") || "—" });
    if (size && expected && (size[0] !== expected[0] || size[1] !== expected[1]))
      add("textureSize", { name: page.name, mod: size.join(" × "), official: expected.join(" × ") });
  }
  for (const name of report.atlasLayout || []) add("atlasLayout", { name });
  const author = issues.some(({ key }) => ["skeletons", "animations", "slots", "attachments", "bones", "pages", "atlasSize", "textureSize", "atlasUnreadable"].includes(key));
  const update = issues.some(({ key }) => ["outdated", "version"].includes(key));
  return { issues, author: author || issues.some(({ key }) => ["rig", "geometry"].includes(key)), update,
    remap: report.remappable === true };
}

export async function show(report, { label = "", onUpdate, onRemap } = {}) {
  const result = compare(report, globalThis.spine, true);
  const lines = result.issues.map(({ key, params, detail }) => {
    const text = T(`compatibility.${key}`, params), full = detail ? T(`compatibility.${key}`, detail) : text;
    return text === full ? text : { text, button: { label: T("info.details"), fn: () =>
      Popup.message({ title: T("info.details"), lines: [full], scroll: true, ok: T("picker.ok") }) } };
  });
  if (!lines.length) lines.push(T("compatibility.matches"));
  if (result.update && !result.remap) lines.push(T("compatibility.updateHint"));
  if (result.author) lines.push(T("compatibility.authorHint"));
  if (result.update || result.author || result.remap || result.issues.some(({ key }) => key === "unreadable")) lines.push(T("compatibility.crcHint"));
  const response = await Popup.message({ title: T("compatibility.check"), lines: [...(label ? [label] : []), ...lines],
    scroll: true,
    ok: T(result.remap && onRemap ? "remap.action" : result.update && onUpdate ? "act.update" : "picker.ok"),
    cancel: ((result.remap && onRemap) || (result.update && onUpdate)) ? T("popup.cancel") : null });
  if (response.button === "ok") {
    if (result.remap && onRemap) await onRemap();
    else if (result.update && onUpdate) await onUpdate();
  }
}

export async function remap(id, onRemapped = () => {}, label = "") {
  const result = await Loading.task(async (update) => waitJob(await rpc("actions.remap", { mod: id }), update),
    { label: T("progress.remap", { name: label || T("progress.mods") }) });
  const report = result.report;
  await Popup.message({ title: T(report.partial ? "remap.partial" : "remap.done"),
    scroll: true,
    lines: [T("remap.counts", { moved: report.moved.length, added: report.added.length, dropped: report.dropped.length }),
      ...new Set((report.upscaled || []).map(({ w, h }) => T("remap.upscaled", { w, h }))),
      ...(report.dropped.length ? [T("remap.dropped", { names: joined(report.dropped) })] : []),
      ...report.warnings.map(({ key, name }) => T(`remap.${key}`, { name }))], ok: T("picker.ok") });
  await onRemapped(result);
  await Compare.show(result.compare, label ? `${label} - ${result.mod.label}` : result.mod.label, "dialog");
  return result;
}

export async function check(id, label = "", onUpdated = () => {}, onRemapped = () => {}) {
  const report = await Loading.task(async (update) => waitJob(await rpc("actions.compatibility", { mod: id }), update),
    { label: T("progress.compatibility", { name: label || T("progress.mods") }) });
  reports.set(id, report);
  return show(report, { label, onUpdate: async () => {
    await Loading.task(async (update) => waitJob(await rpc("actions.update", { mod: id }), update),
      { label: T("progress.repair", { name: label || T("progress.mods") }) });
    await onUpdated(true);
    await check(id, label, onUpdated, onRemapped);
  }, onRemap: () => remap(id, onRemapped, label) });
}
