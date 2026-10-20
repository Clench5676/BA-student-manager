// The bones a memorial lobby prefab pins (lobby.json "pins", gameassets/pins.py): SkeletonUtilityBones in Override
// mode that no drag moves set their bone from their GameObject every frame, after the animation and before the world
// transform, so the bone stays where the prefab put it whatever the animation does (Hihumi's Hip, and with it her
// whole scene; CH0242's cheek_02). lobby-touch.js moves the dragged ones.

const cache = new WeakMap(); // skeleton -> [pin, bone] of its pins

// for checks: pin the bones (true) or let the animation move them (false)
export let shown = true;
export const show = (on) => { shown = !!on; };

// Unity's Mathf.LerpAngle: the shorter way round
export function lerpAngle(a, b, t) {
  let d = b - a - Math.floor((b - a) / 360) * 360;
  if (d > 180) d -= 360;
  return a + d * t;
}

// after the animation, before the world transform: the pinned bones of a skeleton (the layer named name) to their
// prefab place, lerped by the component's overrideAlpha as spine-unity does
export function pin(skeleton, name, pins) {
  if (!skeleton || !pins?.length || !shown) return;
  let list = cache.get(skeleton);
  if (!list) {
    list = pins.filter((p) => p.skeleton === name).map((p) => [p, skeleton.findBone(p.bone)]).filter(([, b]) => b);
    cache.set(skeleton, list);
  }
  for (const [p, b] of list) {
    const k = p.alpha ?? 1;
    if (p.x != null) { b.x += (p.x - b.x) * k; b.y += (p.y - b.y) * k; }
    if (p.rotation != null) b.rotation = lerpAngle(b.rotation, p.rotation, k);
    if (p.scaleX != null) { b.scaleX += (p.scaleX - b.scaleX) * k; b.scaleY += (p.scaleY - b.scaleY) * k; }
  }
}

// a layer's player (its skeleton, its layer's name)
export const apply = (player, pins) => pin(player?.skeleton, player?.bamtLayer?.name, pins);
