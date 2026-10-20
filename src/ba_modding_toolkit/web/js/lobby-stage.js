// A memorial lobby drawn the way the game's camera draws it: every skeleton and particle effect of the lobby into one
// target, in the order Unity sorts them. spine-unity gives each submesh of a skeleton the material of its atlas page,
// and Unity sorts every submesh and particle renderer by sorting order, render queue, then back to front, whichever
// renderer it belongs to. So the skeletons of one lobby interleave: Wakamo's lobby draws the scenery pages of both its
// skeletons (2800, 2900), her fire (3000), her own page (3050), the front fire (3100) and the parked intro scene's
// front page (3150); Shigure's and Yuuka (Track)'s lobbies put their bokeh and dust between their scenery and them.
// One canvas per skeleton, stacked, can only draw each skeleton whole above the one before: the effects that sort
// between two pages of the bottom skeleton went over the character with the skeleton above.
//
// So a lobby of several skeletons draws them all in the bottom player's WebGL context (the host): the other players
// (guests) are made with that context and their canvases stay empty; once loaded their own frame loops stop and the
// host runs their frames (animation, clips, drags) at the start of its own, then draws every skeleton part (one per
// render queue of a skeleton's pages, skeleton-parts.js) and the effects between them (particles-gl.js) in the game's
// order, into its linear framebuffer, post-processed once (linear.js). A lobby whose bottom skeleton fails to load
// keeps one context per skeleton, stacked (lobby.js), each drawing its own parts.
import * as Linear from "./linear.js";
import * as Parts from "./skeleton-parts.js";
import { compareKeys, queuesOf, sortKey } from "./particles.js";

const hosts = new WeakMap(); // guest player -> the player whose context it draws with
const own = new WeakMap(); // player -> its renderer's own drawSkeleton
const plans = new WeakMap(); // player -> what it draws: {steps, fx, guests}, and for checks the players
let interleave = true, latest = null; // for checks: the order mode, and the host installed last (a WeakRef)

// The order of a lobby's skeleton parts. layers: the players' layers (sortingLayer, order, queue, pages, z) in stacking
// order; each draws in the parts of queuesOf, one per render queue of its pages, lowest first. Returns [{layer, part,
// sortingLayer, order, queue, z}]: merged (one target), all of them as Unity sorts transparent submeshes, by sorting
// layer, sorting order, render queue, then back to front (particles.js sortKey), equal keys in stacking order; else
// layer after layer, as stacked canvases draw them.
export function order(layers, merged = true) {
  const out = layers.flatMap((l, layer) => queuesOf(l).map((queue, part) => ({
    layer, part, sortingLayer: l?.sortingLayer || 0, order: l?.order || 0, queue, z: l?.z || 0,
  })));
  if (!merged) return out;
  return out.sort((a, b) => compareKeys(sortKey(a), sortKey(b)) || a.layer - b.layer || a.part - b.part);
}

// create() makes a spine-player; with a host (the lobby's bottom player), one that draws with the host's WebGL context:
// the canvas it makes asks for a context while the player is made, and gets the host's. Losing and restoring the
// host's context reaches the guest's textures and shaders too.
export function make(host, create) {
  const gl = host?.context?.gl;
  if (!gl || typeof HTMLCanvasElement === "undefined") return create();
  const proto = HTMLCanvasElement.prototype, getContext = proto.getContext;
  proto.getContext = function (type, ...rest) {
    return this !== gl.canvas && /webgl/i.test(type) ? gl : getContext.call(this, type, ...rest);
  };
  let player;
  try {
    player = create();
  } finally {
    proto.getContext = getContext;
  }
  if (player?.context?.gl !== gl) return player;
  hosts.set(player, host);
  for (const type of ["webglcontextlost", "webglcontextrestored"]) {
    player.addEventListener?.(gl.canvas, type, () => player.canvas?.dispatchEvent(new Event(type)));
  }
  return player;
}

// the player whose context a player draws with, or null
export const hostOf = (player) => hosts.get(player) || null;

// A player is loaded (its success hook, before its first frame). A guest stops drawing and running on its own: its
// renderer draws nothing when its own frame asks, its frame loop stops (the host runs its frames) and a window resize
// no longer runs one. Any other player draws its skeleton's parts (install() adds what goes between them).
export function ready(player) {
  const renderer = player?.sceneRenderer;
  if (!renderer || own.has(player)) return;
  own.set(player, renderer.drawSkeleton.bind(renderer));
  if (hosts.has(player)) {
    renderer.drawSkeleton = () => {};
    player.stopRequestAnimationFrame = true;
    if (Array.isArray(player.eventListeners)) {
      player.eventListeners = player.eventListeners.filter((e) => {
        if (e.target !== globalThis.window || e.event !== "resize") return true;
        e.target.removeEventListener(e.event, e.func);
        return false;
      });
    }
    return;
  }
  const layer = player.bamtLayer || {};
  const parts = Parts.partsOf(layer);
  plans.set(player, { steps: order([layer]).map((s) => ({ ...s, player, parts })), fx: null, guests: [] });
  renderer.drawSkeleton = (skeleton, ...args) => draw(player, skeleton, args);
}

// Every player of a lobby is in (players: in stacking order, the host first; fx: the lobby's effects, particles-gl.js,
// or null): the order every part and effect draws in. Guests of the host go into its plan, the effects into the slots
// of the parts they sort after.
export function install(players, fx) {
  const host = players[0];
  if (!host) return;
  const merged = players.length > 1 && players.slice(1).every((p) => hosts.get(p) === host);
  const layers = players.map((p) => p.bamtLayer || {});
  const parts = layers.map((l) => Parts.partsOf(l));
  const steps = order(layers, merged && interleave)
    .map((s) => ({ ...s, player: players[s.layer], owner: merged ? host : players[s.layer], parts: parts[s.layer] }));
  fx?.layers(players, steps);
  for (const p of players) {
    if (hosts.has(p) && merged) continue;
    ready(p);
    const guests = merged && p === host ? players.slice(1) : [];
    plans.set(p, { steps: steps.filter((s) => s.owner === p), fx, guests, players });
  }
  latest = typeof WeakRef === "undefined" ? null : new WeakRef(host);
}

// for checks: the skeletons of the lobby installed last interleaved by render queue in their one context (true, as
// the game draws them) or one after another in stacking order (false, as one canvas per skeleton drew them)
export function setInterleaved(on) {
  interleave = !!on;
  const plan = plans.get(latest?.deref());
  if (plan?.players) install(plan.players, plan.fx);
}

// for checks: what the lobby installed last draws, in order: [skeleton, render queue] per part of a skeleton, with
// true after it where effects draw next
export function drawn() {
  const players = plans.get(latest?.deref())?.players || [];
  return players.flatMap((p) => {
    const plan = plans.get(p);
    return (plan?.steps || []).map((s, k) => [s.player.bamtLayer?.name, s.queue, !!plan.fx?.drawsAfter(p, k)]);
  });
}

// In the host's frame hook, before anything else: its guests' frames (time, clips, animation, drags, camera), so it
// draws them posed for this frame; the viewport each of them set goes back to the host's
export function frame(player) {
  const guests = plans.get(player)?.guests;
  if (!guests?.length) return;
  for (const g of guests) if (g.skeleton && !g.disposed && !g.error) g.drawFrame(false);
  const gl = player.context?.gl, canvas = player.canvas;
  if (gl && canvas) gl.viewport(0, 0, canvas.width, canvas.height);
}

// In place of spine-player's one drawSkeleton call (its renderer begun): every step of the player's plan, each with
// its own player's renderer and camera, the slots of the step's part only, and after a step the effects that sort
// after it (the batch flushed first). The guests' slot colours are tinted for linear light (linear.js) meanwhile.
function draw(player, skeleton, args) {
  const plan = plans.get(player), steps = plan?.steps || [];
  const base = player.sceneRenderer;
  if (steps.length <= 1 && !plan?.guests.length) { own.get(player)(skeleton, ...args); return; }
  for (const g of plan.guests) Linear.tint(g);
  let open = base;
  try {
    steps.forEach((step, i) => {
      const p = step.player, renderer = p.sceneRenderer, drawSkeleton = own.get(p);
      if (p.skeleton && renderer && drawSkeleton && !p.disposed && !p.error) {
        if (open !== renderer) {
          open?.end();
          renderer.begin();
          open = renderer;
        }
        Parts.drawPart(p.skeleton, step.parts, step.part, () => drawSkeleton(p.skeleton, ...args));
      }
      if (i < steps.length - 1 && plan.fx?.drawsAfter(player, i)) {
        open?.end();
        open = null;
        plan.fx.between(player, i);
      }
    });
  } finally {
    if (open !== base) {
      open?.end();
      base.begin();
    }
    for (const g of plan.guests) Linear.untint(g);
  }
}
