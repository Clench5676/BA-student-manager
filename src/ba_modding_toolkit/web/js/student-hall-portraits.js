// One full-quality WebGL target. Repeated sources share textures and SkeletonData, while every entry owns its pose.
import { loadSpineAssets, spineBase } from "./api.js";
import { loadPlayer } from "./spine-load.js";
import { ensureSpine } from "./spine-runtime.js";
import { idleAnimation } from "./thumbs.js";
import * as Stage from "./lobby-stage.js";
import { portraitScale } from "./student-hall-framing.js";

const VIEW = { x: 0, y: 0, width: 1920, height: 1080, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
  transitionTime: 0, animations: {} };
function startIdle(player) {
  const idle = idleAnimation(player.skeleton.data);
  if (idle) player.animationState.setAnimation(0, idle, true);
  else player.animationState.setEmptyAnimation(0, 0).trackEnd = Number.MAX_VALUE;
  if (player.skeleton.data.findAnimation("00")) player.animationState.setAnimation(1, "00", true);
  player.blinkAt = 2.5 + Math.random() * 3.5;
}
// Applying stage coordinates to the skeleton keeps the game's absolute framing and never fits to art bounds.
export function pose(entry, skeleton, globalScale = 1) {
  skeleton.x = entry.x; skeleton.y = 1080 - entry.y;
  skeleton.scaleY = portraitScale(entry, globalScale);
  skeleton.scaleX = skeleton.scaleY * (entry.mirror ? -1 : 1);
}

export async function createPortraits(host, entries, choiceOf, { signal, onError, onRecover, globalScale = 1 } = {}) {
  const actors = new Map(), cachedActors = new Map(), loads = [], sources = new Map();
  let disposed = false, owner = null, revision = 0, tail = Promise.resolve(), pendingUpdates = 0, cover = null, active = true, recoveryPending = false;
  let cameraView = VIEW;
  const baseOf = (entry) => {
    const choice = choiceOf(entry);
    return choice && spineBase(choice.source.startsWith("mod:") ? "mod" : "official-spr", choice.source.startsWith("mod:") ? choice.source.slice(4) : choice.core);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; revision++;
    signal?.removeEventListener("abort", dispose);
    // Guests release their GPU objects before their shared-context owner.
    for (const load of [...loads].reverse()) load.dispose();
    actors.clear(); cachedActors.clear(); sources.clear(); cover?.remove?.(); cover = null; host.replaceChildren();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  if (!(await ensureSpine()) || signal?.aborted) return { actors, dispose, allowed: false };
  function freeze() {
    if (!owner || cover || !actors.size) return;
    // A guest bootstraps in the shared GL context and can clear its target before success.
    // Keep the complete last frame at its exact backing resolution until the batch is committed.
    const canvas = document.createElement("canvas"); canvas.width = owner.canvas?.width || 0; canvas.height = owner.canvas?.height || 0;
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
    const context = canvas.getContext?.("2d");
    if (context && canvas.width && canvas.height) context.drawImage(owner.canvas, 0, 0);
    host.appendChild(canvas); cover = canvas;
    owner.hallLayer.style.visibility = "hidden";
  }
  function reveal() {
    owner?.drawFrame?.(false);
    if (owner?.hallLayer) owner.hallLayer.style.visibility = "";
    cover?.remove?.(); cover = null;
  }
  async function sourceFor(base, entry) {
    if (sources.has(base)) return sources.get(base);
    freeze();
    const layer = document.createElement("div"); layer.className = "lobby-layer";
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", visibility: "hidden" });
    host.appendChild(layer);
    try { await loadSpineAssets(base, async (resolved) => {
      if (disposed || signal?.aborted) return;
      const load = loadPlayer((config) => Stage.make(owner, () => new spine.SpinePlayer(layer, config)), {
        skeleton: `${resolved}.skel`, atlas: `${resolved}.atlas`, animation: undefined,
        premultipliedAlpha: false, alpha: true, backgroundColor: "#00000000", showControls: false, showLoading: false,
        preserveDrawingBuffer: true, viewport: VIEW,
        frame: (p, delta) => {
          if (p !== owner || !active) return;
          p.currentViewport = cameraView; p.previousViewport = null;
          for (const { entry, player: actor } of actors.values()) {
            pose(entry, actor.skeleton, globalScale);
            actor.blinkAt -= delta;
            if (actor.blinkAt <= 0) {
              if (actor.skeleton.data.findAnimation("Eye_Close_01")) { actor.animationState.setAnimation(2, "Eye_Close_01", false); actor.animationState.addEmptyAnimation(2, .1, 0); }
              actor.blinkAt = 2.5 + Math.random() * 3.5;
            }
            actor.skeleton.update(delta); actor.animationState.update(delta); actor.animationState.apply(actor.skeleton);
            actor.skeleton.updateWorldTransform(spine.Physics.update);
          }
        },
        success: (p) => {
          startIdle(p);
          if (!owner) {
            owner = p; owner.hallLayer = layer;
            const draw = p.sceneRenderer.drawSkeleton.bind(p.sceneRenderer);
            p.sceneRenderer.drawSkeleton = (_skeleton, ...args) => {
              for (const { player: actor } of actors.values()) draw(actor.skeleton, ...args);
            };
          } else Stage.ready(p);
        },
      }, { signal, onError: (error) => onError?.(error, entry), onRecover: () => {
        if (active) onRecover?.(); else recoveryPending = true;
      }, onResume: () => active && !Stage.hostOf(load.player) });
      loads.push(load);
      let player;
      try { player = await load.ready; }
      catch (error) { if (owner === load.player) owner = null; load.dispose(); loads.splice(loads.indexOf(load), 1); throw error; }
      if (player && !disposed && !signal?.aborted) sources.set(base, { data: player.skeleton.data, skin: player.skeleton.skin, player, load, layer });
    }, { signal }); } catch (error) { layer.remove?.(); throw error; }
    return sources.get(base);
  }
  function actorFor(entry, base) {
    const old = cachedActors.get(entry.id);
    if (old?.base === base) return old;
    const source = sources.get(base);
    if (!source) return null;
    const player = { skeleton: new spine.Skeleton(source.data), animationState: new spine.AnimationState(new spine.AnimationStateData(source.data)) };
    if (source.skin) { player.skeleton.setSkin(source.skin); player.skeleton.setSlotsToSetupPose(); }
    // Cache canonical local bounds once; mirror and scale transform those same bounds everywhere.
    startIdle(player); pose({ ...entry, mirror: false }, player.skeleton, globalScale); player.animationState.apply(player.skeleton);
    player.skeleton.updateWorldTransform(spine.Physics.update);
    let bounds = null;
    if (player.skeleton.getBounds) {
      const offset = new spine.Vector2(), size = new spine.Vector2(), scale = portraitScale(entry, globalScale);
      player.skeleton.getBounds(offset, size, []);
      if ([offset.x, offset.y, size.x, size.y].every(Number.isFinite) && size.x > 0 && size.y > 0)
        bounds = { x: (offset.x - entry.x) / scale, y: (offset.y - (1080 - entry.y)) / scale, width: size.x / scale, height: size.y / scale };
    }
    const actor = { entry, player, bounds, base }; cachedActors.set(entry.id, actor); return actor;
  }
  function commit(next, value, retain = []) {
    globalScale = value;
    const ordered = [];
    for (const entry of next) {
      const base = baseOf(entry), actor = base && actorFor(entry, base);
      if (!actor) continue;
      actor.entry = entry; pose(entry, actor.player.skeleton, globalScale);
      actor.player.skeleton.updateWorldTransform(spine.Physics.update); ordered.push([entry.id, actor]);
    }
    // The visible map changes once, only after every requested source is ready.
    actors.clear(); for (const [id, actor] of ordered) actors.set(id, actor);
    const keptIds = new Set([...next, ...retain].map((entry) => entry.id));
    for (const id of cachedActors.keys()) if (!keptIds.has(id)) cachedActors.delete(id);
    const keptSources = new Set([...cachedActors.values()].map((actor) => actor.base));
    for (const [base, source] of sources) if (source.player !== owner && !keptSources.has(base)) {
      source.load.dispose(); source.layer.remove?.(); sources.delete(base);
      loads.splice(loads.indexOf(source.load), 1);
    }
    reveal();
  }
  const needsLoad = (next) => next.some((entry) => { const base = baseOf(entry); return base && !sources.has(base); });
  function update(next, value = globalScale, { retain = [] } = {}) {
    const version = ++revision;
    if (disposed) return Promise.resolve(false);
    if (!pendingUpdates && !needsLoad(next)) { commit(next, value, retain); return Promise.resolve(true); }
    pendingUpdates++;
    const pending = tail.catch(() => {}).then(async () => {
      try {
        for (const entry of next) {
          if (disposed || signal?.aborted || version !== revision) return false;
          const base = baseOf(entry);
          if (base) await sourceFor(base, entry);
        }
        if (disposed || signal?.aborted || version !== revision) return false;
        commit(next, value, retain); return true;
      } catch (error) {
        if (!disposed && version === revision) reveal();
        throw error;
      } finally { pendingUpdates--; }
    });
    tail = pending; return pending;
  }

  try { await update(entries); } catch (error) { dispose(); throw error; }
  return { actors, dispose, allowed: true, needsLoad, update, setActive(value) {
    if (disposed || active === !!value) return;
    active = !!value;
    if (!active) { for (const load of loads) load.player?.stopRendering?.(); return; }
    if (recoveryPending) { recoveryPending = false; onRecover?.(); return; }
    owner?.time?.update?.(); if (owner?.time) owner.time.delta = 0;
    const load = loads.find((item) => item.player === owner);
    (globalThis.requestAnimationFrame || queueMicrotask)(() => {
      if (active && !disposed && load?.active?.() !== false && owner?.stopRequestAnimationFrame) owner.startRendering?.();
    });
  }, setView(value, { draw = false } = {}) {
    if (disposed) return;
    const valid = value && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.width > 0 && value.height > 0;
    cameraView = valid ? { ...VIEW, ...value } : VIEW;
    if (owner) { owner.currentViewport = cameraView; owner.previousViewport = null; if (draw) owner.drawFrame?.(false); }
  }, setScale(value) {
    if (disposed) return;
    globalScale = value;
    for (const { entry, player } of actors.values()) {
      pose(entry, player.skeleton, globalScale); player.skeleton.updateWorldTransform(spine.Physics.update);
    }
  } };
}

const speechTracks = new WeakMap();
export function talkExpression(actor, talking, expression = null) {
  const p = actor?.player;
  if (!p?.skeleton) return;
  const state = p.animationState;
  const restore = (track, saved) => {
    if (saved.name && p.skeleton.data.findAnimation(saved.name)) {
      const restored = state.setAnimation(track, saved.name, saved.loop);
      restored.trackTime = saved.time; restored.mixDuration = saved.outro;
      restored.timeScale = saved.timeScale; restored.alpha = saved.alpha;
    } else state.setEmptyAnimation(track, saved.outro);
  };
  if (!talking) {
    for (const [track, saved] of speechTracks.get(p) || []) restore(track, saved);
    speechTracks.delete(p); return;
  }
  // Numbered portrait faces use track 1 in the game's SpineClip assets. An explicit authored clip can override
  // its track, looping and synchronized clips. Do not guess a Talk animation or a random face for missing data.
  const spec = typeof expression === "string" ? { animation: expression, track: 1, loop: true, mix: 0, outro: 0 } : expression;
  const seen = new Set(), selected = new Map();
  function collect(clip) {
    if (!clip || seen.has(clip.animation) || !Number.isInteger(clip.track) || clip.track < 0
        || !p.skeleton.data.findAnimation(clip.animation)) return;
    seen.add(clip.animation);
    selected.set(clip.track, clip);
    for (const child of clip.sync || []) collect(child);
  }
  collect(spec);
  for (const [track, saved] of speechTracks.get(p) || []) if (!selected.has(track)) {
    restore(track, saved); speechTracks.get(p).delete(track);
  }
  for (const clip of selected.values()) {
    let tracks = speechTracks.get(p);
    if (!tracks) { tracks = new Map(); speechTracks.set(p, tracks); }
    const before = state.getCurrent(clip.track);
    if (!tracks.has(clip.track)) tracks.set(clip.track, { name: before?.animation?.name, loop: before?.loop ?? true,
      time: before?.trackTime || 0, timeScale: before?.timeScale ?? 1, alpha: before?.alpha ?? 1, outro: clip.outro || 0 });
    if (before?.animation?.name !== clip.animation) {
      const next = state.setAnimation(clip.track, clip.animation, !!clip.loop); next.mixDuration = clip.mix || 0;
    }
  }
}
