"""Memorial lobby stage and interaction data, read from the game's own prefab and clip assets.

The game places a memorial lobby with its UILobbyElement prefab (Lobby<Name>.prefab): every skeleton sits at a fixed
place in NGUI units around the prefab root, which is the screen centre, and at 16:9 the game shows 2960 x 1665 of those
units. SpineDragIK components (head pat, eye follow, pinch, ...) and SpineCharacterBodyTouch (a tap plays the next
dialogue) carry the touch boxes, SpineCharacter the idle and random idle clips, and the lobby's clip assets
("<skeleton>-<animation>" MonoBehaviours) the track, loop, mixes and chains of every animation. Its URP Volumes (PPV,
PPV_C, PPV_D) point to the post-processing profiles the game's camera applies over the lobby.

Everything here works on plain typetrees (dicts), so it runs without game files; the service reads the bundles.
Lengths are NGUI units with y up and the prefab root at (0, 0), except a drag's orig / min / max / offset, which are
skeleton units in the dragged bone's parent space (the space the bone's own x / y are set in).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable
from typing import Any

# the game's 16:9 view around the prefab root (the UI's 2960-unit NGUI width, util.js S = 1920 / 2960)
GAME_VIEW = {"x": -1480.0, "y": -832.5, "w": 2960.0, "h": 1665.0}
# where the game puts a lobby skeleton: prefab (0, -962) at transform scale 100 x SkeletonDataAsset.scale 0.01
STANDARD = {"x": 0.0, "y": -962.0, "scale": 1.0}
_DATA_SCALE = 0.01
_TRANSFORMS = ("Transform", "RectTransform")


def _r(value: float, digits: int = 2) -> float:
    return round(float(value), digits) + 0.0  # never "-0.0" in the JSON


def prefab_candidates(core: str, skeletons: Iterable[str]) -> list[str]:
    """Prefab names (lower case) to try for a lobby core, best first: ch0187_home -> lobbych0187, then the same rule
    on each skeleton name (two cores share Airi_home) and the skeleton name itself (LobbyHoshino_multi)."""
    out = ["lobby" + core.lower().replace("_home", "", 1)]
    for name in skeletons:
        low = name.lower()
        out += ["lobby" + low.replace("_home", "", 1), low, "lobby" + low]
    return list(dict.fromkeys(out))


def _short(name: str | None) -> str | None:
    """'Hoshino_home-Pat_01_M' -> 'Pat_01_M' (clip assets are named <skeleton>-<animation>)."""
    return name.split("-", 1)[1] if name and "-" in name else name


def clip_entry(tree: dict, default_mix: float, names: dict[int, str]) -> dict:
    """One clip asset: where and how its animation plays, the mixes resolved against the skeleton's default."""
    nxt = tree.get("NextClipObject", {}).get("m_PathID", 0)
    mode = tree.get("PlayMode", 1)
    random = None
    if mode in (2, 3) or tree.get("RandomTimingIntroDelayMode"):
        random = {"min": _r(tree.get("RandomDelayMin", 0)), "max": _r(tree.get("RandomDelayMax", 0)),
                  "loops": [tree.get("AddRandomLoopMin", 0), tree.get("AddRandomLoopMax", 0)]}
    return {
        "track": tree.get("Track", 0), "loop": bool(tree.get("Loop")), "mode": mode, "finish": tree.get("FinishMode", 0),
        "intro": _r(default_mix if tree.get("UseDefaultIntroMix") else tree.get("IntroMix", 0), 3),
        "outro": _r(default_mix if tree.get("UseDefaultOutroMix") else tree.get("OutroMix", 0), 3),
        "next": _short(names.get(nxt)) if nxt else None,
        "sync": [_short(names[p["m_PathID"]]) for p in tree.get("SyncPlayClipObjects", []) if p.get("m_PathID") in names],
        "block": bool(tree.get("BlockInteractionOnPlay")), "random": random,
    }


class Clips:
    """The clip assets and skeleton data assets of a lobby core, from its MonoBehaviour typetrees."""

    def __init__(self, behaviours: Iterable[tuple[int, dict]], skeletons: Iterable[str] = ()):
        named = {s.lower(): s for s in skeletons}
        raw, names = [], {}
        self.mixes: dict[str, float] = {}      # skeleton -> SkeletonDataAsset.defaultMix
        self.scales: dict[str, float] = {}     # skeleton -> SkeletonDataAsset.scale (Unity units per skeleton unit)
        self.data: dict[int, str] = {}         # SkeletonDataAsset path id -> skeleton
        self.by_pid: dict[int, tuple[str, str]] = {}  # clip asset path id -> (skeleton, animation)
        for pid, tree in behaviours:
            name = tree.get("m_Name", "")
            names[pid] = name
            if "ClipName" in tree:
                raw.append((pid, tree))
            elif "skeletonJSON" in tree and "defaultMix" in tree:
                skel = name.removesuffix("_SkeletonData")
                skel = named.get(skel.lower(), skel)
                self.mixes[skel] = _r(tree["defaultMix"], 3)
                self.scales[skel] = float(tree.get("scale") or _DATA_SCALE)
                self.data[pid] = skel
        mixes = {k.lower(): v for k, v in self.mixes.items()}
        self.clips: dict[str, dict[str, dict]] = {}  # skeleton -> animation -> clip_entry
        for pid, tree in raw:
            skel, _, anim = tree.get("m_Name", "").partition("-")
            skel = named.get(skel.lower(), skel)
            anim = anim or tree["ClipName"]
            self.clips.setdefault(skel, {})[anim] = clip_entry(tree, mixes.get(skel.lower(), 0.2), names)
            self.by_pid[pid] = (skel, anim)

    def anim(self, pointer: dict | None) -> str | None:
        """The animation a clip pointer plays (pointers into the core bundles match by path id)."""
        return self.by_pid.get((pointer or {}).get("m_PathID", 0), (None, None))[1]


def _local(t: dict) -> tuple[float, ...]:
    """A transform's 2D affine (a, b, c, d, tx, ty): z rotation and scale, then position."""
    q, s, p = t["m_LocalRotation"], t["m_LocalScale"], t["m_LocalPosition"]
    r = 2 * math.atan2(q.get("z", 0), q.get("w", 1))
    c, n = math.cos(r), math.sin(r)
    return (c * s["x"], n * s["x"], -n * s["y"], c * s["y"], p["x"], p["y"])


def _mul(m: tuple[float, ...], l: tuple[float, ...]) -> tuple[float, ...]:
    a, b, c, d, tx, ty = m
    return (a * l[0] + c * l[1], b * l[0] + d * l[1], a * l[2] + c * l[3], b * l[2] + d * l[3],
            a * l[4] + c * l[5] + tx, b * l[4] + d * l[5] + ty)


def _box(m: tuple[float, ...], box: dict) -> tuple[list[float], float]:
    """A BoxCollider in root space: [left, bottom, right, top] of its box unrotated around its centre, and the
    rotation in degrees (counter-clockwise)."""
    a, b, c, d, tx, ty = m
    cx, cy = box.get("m_Center", {}).get("x", 0), box.get("m_Center", {}).get("y", 0)
    x, y = a * cx + c * cy + tx, b * cx + d * cy + ty
    hw, hh = box["m_Size"]["x"] * math.hypot(a, b) / 2, box["m_Size"]["y"] * math.hypot(c, d) / 2
    return [_r(x - hw, 1), _r(y - hh, 1), _r(x + hw, 1), _r(y + hh, 1)], _r(math.degrees(math.atan2(b, a)))


def _kind(go: str, bone: str | None) -> str:
    low = (bone or "").lower()
    if low == "touch_point":
        return "pat"
    if low == "touch_eye":
        return "look"
    return re.sub(r"ik$", "", go.lower()) or "drag"  # PinchIK -> pinch, HandFollowIK -> handfollow, TouchIK -> touch


# --- post-processing: the URP volumes a lobby prefab carries (PPV at weight 1; PPV_C and PPV_D, the flash and the
# depth of field a talk's timeline drives, mostly at 0) ---

# the volume components the lobbies use and their parameters' defaults in URP 12 (Unity 2021.3): every camera frame
# starts from these and each global volume blends its overridden parameters over them by its weight
VOLUME_DEFAULTS: dict[str, dict[str, Any]] = {
    "ChromaticAberration": {"intensity": 0.0},
    "LiftGammaGain": {"lift": [1.0, 1.0, 1.0, 0.0], "gamma": [1.0, 1.0, 1.0, 0.0], "gain": [1.0, 1.0, 1.0, 0.0]},
    "PaniniProjection": {"distance": 0.0, "cropToFit": 1.0},
    "ColorAdjustments": {"postExposure": 0.0, "contrast": 0.0, "colorFilter": [1.0, 1.0, 1.0, 1.0], "hueShift": 0.0,
                         "saturation": 0.0},
}
_POST_KEYS = {"ChromaticAberration": "chromaticAberration", "LiftGammaGain": "liftGammaGain",
              "PaniniProjection": "panini", "ColorAdjustments": "colorAdjustments"}


def is_volume(tree: dict) -> bool:
    """A URP Volume (its MonoScript lives in the render pipeline's assembly, outside the prefab bundle)."""
    return "sharedProfile" in tree and "weight" in tree and "m_IsGlobal" in tree


def _value(raw: Any) -> Any:
    """A volume parameter's m_Value as a float or a list (Vector4 x y z w, Color r g b a)."""
    if isinstance(raw, dict):
        return [float(raw.get(k, 0.0)) for k in (("r", "g", "b", "a") if "r" in raw else ("x", "y", "z", "w"))]
    return float(raw)


def _lerp(a: Any, b: Any, t: float) -> Any:
    return [x + (y - x) * t for x, y in zip(a, b)] if isinstance(a, list) else a + (b - a) * t


def counts(volume: dict) -> bool:
    """Whether a volume takes part in the blend: enabled on an active GameObject, global, with a weight above 0."""
    return bool(volume.get("active")) and bool(volume.get("global")) and float(volume.get("weight", 0.0)) > 0


def post_processing(volumes: Iterable[dict]) -> dict:
    """What the lobby's post-processing volumes leave on screen, blended the way URP's VolumeManager does it: the
    enabled global volumes with a weight above 0, by priority (equal ones in hierarchy order), each active component
    lerping its overridden parameters from the stack's value by the volume's weight. Only effects that end up doing
    something are kept (URP's IsActive): {"chromaticAberration": intensity, "panini": {distance, cropToFit},
    "liftGammaGain": {lift, gamma, gain}, "colorAdjustments": {postExposure, contrast, colorFilter, hueShift,
    saturation}}. volumes: {"weight", "priority", "global", "active", "components"} (the profile's component
    typetrees)."""
    stack = {kind: {k: list(v) if isinstance(v, list) else v for k, v in params.items()}
             for kind, params in VOLUME_DEFAULTS.items()}
    ordered = sorted(enumerate(volumes), key=lambda iv: (iv[1].get("priority", 0.0), iv[0]))
    for _, vol in ordered:
        if not counts(vol):
            continue
        weight = min(1.0, float(vol["weight"]))
        for comp in vol.get("components") or []:
            params = stack.get(comp.get("m_Name", ""))
            if params is None or not comp.get("active", 1):
                continue
            for key in params:
                field = comp.get(key)
                if isinstance(field, dict) and field.get("m_OverrideState") and "m_Value" in field:
                    params[key] = _lerp(params[key], _value(field["m_Value"]), weight)

    def rounded(v: Any) -> Any:
        return [_r(x, 5) for x in v] if isinstance(v, list) else _r(v, 5)
    post: dict[str, Any] = {}
    for kind, params in stack.items():
        if params == VOLUME_DEFAULTS[kind] or (kind == "PaniniProjection" and params["distance"] <= 0) or (
                kind == "ChromaticAberration" and params["intensity"] <= 0):
            continue
        values = {k: rounded(v) for k, v in params.items()}
        if kind == "ColorAdjustments":
            values["colorFilter"] = values["colorFilter"][:3]  # the alpha is not used
        post[_POST_KEYS[kind]] = values["intensity"] if kind == "ChromaticAberration" else values
    return post


def read_prefab(kinds: dict[int, str], tree: Callable[[int], dict], scripts: dict[int, str], root: str,
                skeletons: Iterable[str], clips: Clips,
                profile: Callable[[int, dict], list[dict] | None] | None = None) -> dict | None:
    """The lobby's layout and touch boxes from one prefab bundle: kinds maps path ids to object types, tree reads a
    typetree, scripts maps MonoScript path ids to class names, profile(volume path id, sharedProfile pointer) gives a
    volume profile's component typetrees. None when the root is missing or places none of the skeletons."""
    wanted = {s.lower(): s for s in skeletons}
    top = next((pid for pid, kind in kinds.items() if kind in _TRANSFORMS and not tree(pid)["m_Father"]["m_PathID"]
                and tree(tree(pid)["m_GameObject"]["m_PathID"])["m_Name"].lower() == root.lower()), None)
    if top is None:
        return None

    def components(go: int) -> list[tuple[str, int, dict]]:
        out = []
        for c in tree(go).get("m_Component", []):
            pid = c["component"]["m_PathID"]
            kind = kinds.get(pid)
            if kind == "MonoBehaviour":
                t = tree(pid)
                out.append((scripts.get(t.get("m_Script", {}).get("m_PathID"), "?"), pid, t))
            elif kind in ("BoxCollider", "MeshRenderer"):
                out.append((kind, pid, tree(pid)))
        return out

    # one walk from the root: world transform, activity and components of every GameObject, in hierarchy order
    nodes: list[dict] = []

    def walk(tf: int, m: tuple[float, ...], active: bool) -> None:
        t = tree(tf)
        go = t["m_GameObject"]["m_PathID"]
        m = _mul(m, _local(t))
        active = active and bool(tree(go).get("m_IsActive", 1))
        comps = components(go)
        nodes.append({"go": go, "name": tree(go)["m_Name"], "m": m, "active": active, "all": comps,
                      "first": {cls: c for cls, _, c in reversed(comps)}})
        for child in t.get("m_Children", []):
            if child["m_PathID"] in kinds:
                walk(child["m_PathID"], m, active)

    walk(top, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), True)
    by_go = {n["go"]: n for n in nodes}

    # skeletons: SkeletonAnimation GameObjects named (by their data asset, else by themselves) after a core skeleton
    layers, skeleton_of_sa = [], {}
    for n in nodes:
        for cls, pid, sa in n["all"]:
            if cls != "SkeletonAnimation":
                continue
            data = clips.data.get(sa.get("skeletonDataAsset", {}).get("m_PathID", 0))
            name = next((wanted[k.lower()] for k in (data, n["name"]) if k and k.lower() in wanted), None)
            if name is None:
                continue
            skeleton_of_sa[pid] = name
            renderer = n["first"].get("MeshRenderer", {})
            layers.append({
                "name": name, "x": _r(n["m"][4]), "y": _r(n["m"][5]),
                # NGUI units per skeleton unit: the GameObject's world scale times SkeletonDataAsset.scale
                "scale": _r(math.hypot(n["m"][0], n["m"][1]) * clips.scales.get(name, _DATA_SCALE), 5),
                "active": n["active"] and bool(sa.get("m_Enabled", 1)) and bool(renderer.get("m_Enabled", True)),
                "order": renderer.get("m_SortingOrder", 0), "index": len(layers),
                "skin": sa.get("initialSkinName") or None, "animation": sa.get("_animationName") or None,
            })
    if not layers:
        return None

    def skeleton_of(character: dict | None) -> str | None:
        # a SpineCharacter pointer -> the skeleton its SkeletonAnimation draws
        pid = (character or {}).get("m_PathID", 0)
        if kinds.get(pid) != "MonoBehaviour":
            return None
        return skeleton_of_sa.get(tree(pid).get("SkeletonAnimation", {}).get("m_PathID", 0))

    def bone_of(pointer: dict | None) -> str | None:
        # the dragged bone: a SkeletonUtilityBone's GameObject (its boneName, else the GameObject's own name)
        pid = (pointer or {}).get("m_PathID", 0)
        kind = kinds.get(pid)
        go = pid if kind == "GameObject" else tree(pid)["m_GameObject"]["m_PathID"] if kind else None
        if go not in kinds:
            return None
        utility = next((t for cls, _, t in components(go) if cls == "SkeletonUtilityBone"), {})
        return utility.get("boneName") or tree(go)["m_Name"]

    def box_of(n: dict, t: dict) -> dict:
        box = n["first"]["BoxCollider"]
        widget = n["first"].get("UIWidget") or n["first"].get("UISprite") or {}
        rect, rot = _box(n["m"], box)
        return {"rect": rect, "rot": rot, "depth": widget.get("mDepth", 0),
                "enabled": n["active"] and bool(t.get("m_Enabled", 1)) and bool(box.get("m_Enabled", True))}

    drags, touches, random_idle, idle, dialog, container, volumes = [], [], {}, {}, {}, None, []
    for n in nodes:
        for cls, pid, t in n["all"]:
            if is_volume(t):
                vol = {"weight": float(t.get("weight", 0.0)), "priority": float(t.get("priority", 0.0)),
                       "global": bool(t.get("m_IsGlobal")), "active": n["active"] and bool(t.get("m_Enabled", 1))}
                # only the volumes that take part are followed into their profile (often in another bundle)
                if profile is not None and counts(vol):
                    vol["components"] = profile(pid, t["sharedProfile"]) or []
                volumes.append(vol)
            elif cls == "SpineDragIK" and "BoxCollider" in n["first"]:
                skel = skeleton_of(t.get("SpineController"))
                if skel is None:
                    continue
                per = 1 / clips.scales.get(skel, _DATA_SCALE)  # Unity units -> skeleton units

                def v(key: str) -> list[float]:
                    return [_r(t.get(key, {}).get("x", 0) * per), _r(t.get(key, {}).get("y", 0) * per)]
                bone = bone_of(t.get("Bone"))
                drags.append({
                    "kind": _kind(n["name"], bone), "name": n["name"], "skeleton": skel, "bone": bone, **box_of(n, t),
                    "orig": v("OrigLocalPos"), "min": v("MinLocalPos"), "max": v("MaxLocalPos"),
                    "offset": v("BoneCenterOffset"), "drag": _r(t.get("FollowDragSpeed01", 0.2), 3),
                    "release": _r(t.get("FollowReleaseSpeed01", 0.1), 3), "delay": _r(t.get("TriggerDelay", 0.1), 3),
                    "ing": clips.anim(t.get("IngClip")), "end": clips.anim(t.get("EndClip")),
                })
            elif cls == "SpineCharacterBodyTouch" and "BoxCollider" in n["first"]:
                skel = skeleton_of(t.get("SpineCharacter"))
                if skel is not None:
                    touches.append({"name": n["name"], "skeleton": skel, **box_of(n, t)})
            elif cls == "SpineCharacter":
                skel = skeleton_of_sa.get(t.get("SkeletonAnimation", {}).get("m_PathID", 0))
                if skel is None:
                    continue
                pool = [a for a in map(clips.anim, t.get("idleBaseRandomClipPool", [])) if a]
                if pool:
                    random_idle[skel] = pool
                first = next((a for a in map(clips.anim, t.get("idleClipPool", [])) if a), None)
                if first:
                    idle[skel] = first
            elif cls == "ChatDialog":
                for b in t.get("DialogBoxes", []):
                    box_node = by_go.get(b.get("GameObject", {}).get("m_PathID", 0))
                    if box_node:
                        dialog[box_node["name"]] = [_r(box_node["m"][4], 1), _r(box_node["m"][5], 1)]
            elif cls == "UILobbyContainer":
                container = skeleton_of(t.get("SpineCharacter"))
    # the character: whose head is patted, else whose body is touched, else the container's
    main = next((d["skeleton"] for d in drags if d["kind"] == "pat"), None) or next(
        (d["skeleton"] for d in drags), None) or next((t["skeleton"] for t in touches), None) or container
    return {"prefab": tree(tree(top)["m_GameObject"]["m_PathID"])["m_Name"], "main": main, "layers": layers,
            "drags": drags, "touches": touches, "randomIdle": random_idle, "idle": idle, "dialog": dialog,
            "post": post_processing(volumes)}


def lobby_info(skeletons: Iterable[str], clips: Clips, prefab: dict | None) -> dict:
    """Everything the web UI's lobby needs. Without a prefab (e.g. a mod with other skeleton names) every skeleton
    sits at the standard place; the front end then finds the touch boxes from the bones."""
    if prefab is None:
        prefab = {"prefab": None, "main": None, "drags": [], "touches": [], "randomIdle": {}, "idle": {}, "dialog": {},
                  "post": {},
                  "layers": [{"name": s, **STANDARD, "active": True, "order": 0, "index": i, "skin": None,
                              "animation": None} for i, s in enumerate(dict.fromkeys(skeletons))]}
    return {"view": dict(GAME_VIEW), **prefab, "defaultMix": dict(clips.mixes), "clips": clips.clips}
