// Measure the art that can actually draw, rather than the export header's bounds or a prefab's old scale.
import { lobbyIdles } from "./rest-pose.js";

export const validRect = (r) => r && [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 > r.x0 && r.y1 > r.y0;
export const overlaps = (a, b) => validRect(a) && validRect(b) && a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export function artBounds(sk) {
  const out = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const slot of sk.drawOrder) {
    const a = slot.getAttachment();
    if (!a?.region || !slot.bone.active || (sk.color.a * slot.color.a * (a.color?.a ?? 1)) <= 0.001) continue;
    let v;
    if (a instanceof spine.RegionAttachment) { v = new Float32Array(8); a.computeWorldVertices(slot, v, 0, 2); }
    else if (a instanceof spine.MeshAttachment) { v = new Float32Array(a.worldVerticesLength); a.computeWorldVertices(slot, 0, v.length, v, 0, 2); }
    else continue;
    if (!v.length || !v.every(Number.isFinite)) throw new Error("Non-finite lobby vertices");
    for (let i = 0; i < v.length; i += 2) {
      out.x0 = Math.min(out.x0, v[i]); out.x1 = Math.max(out.x1, v[i]);
      out.y0 = Math.min(out.y0, v[i + 1]); out.y1 = Math.max(out.y1, v[i + 1]);
    }
  }
  return validRect(out) ? out : null;
}

export function worldBounds(r, layer) {
  if (!validRect(r)) return null;
  const { x, y, scale } = layer;
  const out = { x0: x + r.x0 * scale, x1: x + r.x1 * scale, y0: y + r.y0 * scale, y1: y + r.y1 * scale };
  if (!validRect(out)) throw new Error(`Invalid lobby transform: ${layer.name}`);
  return out;
}

export function containingView(r) {
  if (!validRect(r)) throw new Error("No drawable lobby bounds");
  const w = Math.max(r.x1 - r.x0, (r.y1 - r.y0) * 16 / 9);
  return { x: (r.x0 + r.x1 - w) / 2, y: (r.y0 + r.y1 - w * 9 / 16) / 2, w, h: w * 9 / 16 };
}

export function resumeRest(player, layer) {
  const rest = layer.rest, entry = player.animationState?.getCurrent(0);
  if (rest?.name && (!entry || (entry.animation.name === "<empty>" && !entry.mixingFrom)))
    player.animationState.setAnimation(0, rest.name, true).trackTime = rest.time;
}

// The player runtime needs a track even for a static setup pose. Test candidate poses on a separate skeleton so
// a rejected empty/hiding idle never leaks into the live tracks. Intro-only scenes may legitimately be empty.
export function settle(player, layer, info, pin) {
  const data = player.skeleton.data;
  if (data.version && !/^4\.2(?:\.|$)/.test(data.version)) throw new Error(`Unsupported lobby Spine version: ${data.version}`);
  const names = lobbyIdles(data, { idle: info?.idle?.[layer.name], animation: layer.animation });
  const sk = new spine.Skeleton(data);
  if (layer.skin && data.findSkin(layer.skin)) sk.setSkinByName(layer.skin);
  else layer.skin = null;
  const st = new spine.AnimationState(new spine.AnimationStateData(data));
  for (const ignorePins of info?.pins?.length ? [false, true] : [false]) for (const name of [...names, null]) {
    const duration = name ? data.findAnimation(name).duration : 0;
    const times = name && duration > 0 ? [0, duration / 2, duration * 0.9] : [0];
    for (const time of times) {
      st.clearTracks(); sk.setToSetupPose();
      if (name) { st.setAnimation(0, name, true).trackTime = time; st.update(0); st.apply(sk); }
      pin(sk, layer.name, ignorePins ? null : info?.pins);
      sk.updateWorldTransform(spine.Physics.reset);
      const bounds = artBounds(sk);
      if (!bounds && !layer.introOnly) continue;
      layer.ignorePins = ignorePins;
      layer.rest = { name, time, bounds };
      const live = player.animationState;
      live.clearTracks(); player.skeleton.setToSetupPose();
      const entry = name ? live.setAnimation(0, name, true) : live.setEmptyAnimation(0, 0);
      entry.trackTime = time;
      if (!name) entry.trackEnd = Infinity;
      live.update(0); live.apply(player.skeleton);
      pin(player.skeleton, layer.name, ignorePins ? null : info?.pins);
      player.skeleton.updateWorldTransform(spine.Physics.reset);
      return name;
    }
  }
  throw new Error(`No drawable lobby pose: ${layer.name} (${names.join(", ") || "setup"})`);
}
