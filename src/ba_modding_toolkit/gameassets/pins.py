"""The bones a memorial lobby prefab pins, for web/js/skeleton-pins.js.

A SkeletonUtilityBone in Override mode (mode 1) sets its bone from its GameObject every frame, after the animation
and before the world transform (spine-unity's SkeletonUtility.UpdateLocal: the bone's local x / y from the
GameObject's local position, its rotation from the local Euler z angle, its scale from the local scale, each where
the component says so, lerped by overrideAlpha). The SpineDragIK touch targets (Touch_Point, Touch_Eye, the pinch and
hand bones) are such bones, and lobby-touch.js moves them; the others nothing moves, so their bone stays where the
prefab put the GameObject whatever the animation does: Hihumi's Hip, whose driver (SpineCharacterGyro) is switched
off, and CH0242's cheek_02, which PinchEnd_01_M animates.

A pin is {"skeleton", "bone", "alpha", "x", "y" (with position), "rotation" (degrees, with rotation), "scaleX",
"scaleY" (with scale)}, lengths in skeleton units (the GameObject's Unity units over SkeletonDataAsset.scale, which
spine-unity's skeleton is loaded with). Plain typetrees in, so it runs without game files.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from typing import Any


def _r(value: float, digits: int = 4) -> float:
    return round(float(value), digits) + 0.0


def pins(nodes: list[dict], skeleton_of_go: Callable[[int], str | None], data_scale: Callable[[str], float],
         dragged: Iterable[tuple[str, str]]) -> list[dict]:
    """The Override SkeletonUtilityBones of a prefab walk (lobby.read_prefab nodes) that no drag moves (dragged:
    (skeleton, bone) of the SpineDragIK targets), on active GameObjects and enabled."""
    by_go = {n["go"]: n for n in nodes}
    skip = set(dragged)
    out = []
    for n in nodes:
        u: Mapping[str, Any] | None = n["first"].get("SkeletonUtilityBone")
        if u is None or u.get("mode") != 1 or not n["active"] or not u.get("m_Enabled", 1):
            continue
        if (u.get("parentReference") or {}).get("m_PathID"):
            continue  # a bone set in another transform's space: no lobby has one
        skel = n
        while skel is not None and "SkeletonAnimation" not in skel["first"]:
            skel = by_go.get(skel["parent"])
        skeleton = skeleton_of_go(skel["go"]) if skel is not None else None
        bone = u.get("boneName") or n["name"]
        if skeleton is None or (skeleton, bone) in skip:
            continue
        t, per = n["t"], 1 / data_scale(skeleton)
        pin: dict[str, Any] = {"skeleton": skeleton, "bone": bone, "alpha": _r(u.get("overrideAlpha", 1.0))}
        if u.get("position"):
            pin["x"], pin["y"] = _r(t["m_LocalPosition"]["x"] * per, 3), _r(t["m_LocalPosition"]["y"] * per, 3)
        if u.get("rotation"):
            q = t["m_LocalRotation"]
            pin["rotation"] = _r(math.degrees(2 * math.atan2(q.get("z", 0.0), q.get("w", 1.0))) % 360, 3)
        if u.get("scale"):
            pin["scaleX"], pin["scaleY"] = _r(t["m_LocalScale"]["x"]), _r(t["m_LocalScale"]["y"])
        if len(pin) > 3:
            out.append(pin)
    return out
