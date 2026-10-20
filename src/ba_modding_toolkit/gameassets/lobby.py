"""Memorial lobby stage and interaction data, read from the game's own prefab and clip assets.

The game places a memorial lobby with its UILobbyElement prefab (Lobby<Name>.prefab): every skeleton sits at a fixed
place in NGUI units around the prefab root, which is the screen centre, and at 16:9 the game shows 2960 x 1665 of those
units. SpineDragIK components (head pat, eye follow, pinch, ...) and SpineCharacterBodyTouch (a tap plays the next
dialogue) carry the touch boxes, SpineCharacter the idle and random idle clips, and the lobby's clip assets
("<skeleton>-<animation>" MonoBehaviours) the track, loop, mixes, chains, sync clips, random timing and sound keys of
every animation. Its URP Volumes (PPV, PPV_C, PPV_D) point to the post-processing profiles the game's camera applies
over the lobby.

Everything here works on plain typetrees (dicts), so it runs without game files; the service reads the bundles.
Lengths are NGUI units with y up and the prefab root at (0, 0), except a drag's orig / min / max / offset, which are
skeleton units in the dragged bone's parent space (the space the bone's own x / y are set in).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable
from typing import Any

from . import intro, particles

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


def clip_entry(tree: dict, default_mix: float, names: dict[int, str],
               sound: Callable[[dict], str | None] | None = None) -> dict:
    """One clip asset: where and how its animation plays, the mixes resolved against the skeleton's default.

    As the game's SpineClip and SpineBase use them (GameAssembly.dll): mode is the PlayMode (0 the base track,
    1 masked, 2 masked at random times, 3 a random idle clip), finish the FinishMode (0 nothing, 1 the idle, 2 the
    track fades out, 3 the next clip). random holds the waits of modes 2 and 3: the first wait by "pre"
    (RandomTimingIntroDelayMode: 0 none, 1 min to max, 2 preDelay plus min to max), then min to max after each
    play, and "loops" the extra plays queued after the first. outroAt is when the clip's own outro starts,
    seconds after its end (null: the outro ends with the clip). sounds are its SoundKeys, [time, event id], with
    sound(pointer) giving an event's id."""
    nxt = tree.get("NextClipObject", {}).get("m_PathID", 0)
    mode = tree.get("PlayMode", 1)
    random = None
    if mode in (2, 3) or tree.get("RandomTimingIntroDelayMode"):
        random = {"min": _r(tree.get("RandomDelayMin", 0)), "max": _r(tree.get("RandomDelayMax", 0)),
                  "loops": [tree.get("AddRandomLoopMin", 0), tree.get("AddRandomLoopMax", 0)],
                  "pre": tree.get("RandomTimingIntroDelayMode", 0), "preDelay": _r(tree.get("IntroDelayDuration", 0))}
    entry = {
        "track": tree.get("Track", 0), "loop": bool(tree.get("Loop")), "mode": mode, "finish": tree.get("FinishMode", 0),
        "intro": _r(default_mix if tree.get("UseDefaultIntroMix") else tree.get("IntroMix", 0), 3),
        "outro": _r(default_mix if tree.get("UseDefaultOutroMix") else tree.get("OutroMix", 0), 3),
        "outroAt": None if tree.get("UseDefaultOutroMix") else _r(tree.get("OutroStartOffset", 0), 3),
        "next": _short(names.get(nxt)) if nxt else None,
        "sync": [_short(names[p["m_PathID"]]) for p in tree.get("SyncPlayClipObjects", []) if p.get("m_PathID") in names],
        "block": bool(tree.get("BlockInteractionOnPlay")), "random": random,
    }
    keys = [[_r(k.get("Time", 0), 3), sound(k.get("Event") or {})] for k in tree.get("SoundKeys") or []] if sound else []
    if any(event for _, event in keys):
        entry["sounds"] = [k for k in keys if k[1]]
    return entry


def sound_event(tree: dict, clip_id: Callable[[dict], str | None]) -> dict | None:
    """A sound key's AnimationAudioEvent as the game plays it (AudioPlayer.PlayByAudioData, AudioSourceData
    .SetAudioSources): one of its clips picked at random, at its volume, and at its pitch when that is above 0 (as
    a playback rate; a pitch of 0 or below keeps the source's 1). clip_id(pointer) gives an AudioClip's id. None for
    other events (an AmbientAudioEvent, which no lobby clip's sound key uses) or without clips."""
    data = tree.get("AudioData")
    if not isinstance(data, dict):
        return None
    clips = [c for c in (clip_id(p) for p in data.get("AudioClips") or []) if c]
    if not clips:
        return None
    pitch = float(data.get("Pitch", 1.0))
    return {"name": tree.get("m_Name", ""), "volume": _r(data.get("Volume", 1.0), 3),
            "pitch": _r(pitch, 3) if pitch > 0 else 1.0, "clips": clips}


class Clips:
    """The clip assets and skeleton data assets of a lobby core, from its MonoBehaviour typetrees."""

    def __init__(self, behaviours: Iterable[tuple[int, dict]], skeletons: Iterable[str] = (),
                 sound: Callable[[int, dict], str | None] | None = None):
        # sound(clip asset path id, event pointer) gives a sound key event's id (clip_entry)
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
            resolve = (lambda pointer, pid=pid: sound(pid, pointer)) if sound else None
            self.clips.setdefault(skel, {})[anim] = clip_entry(tree, mixes.get(skel.lower(), 0.2), names, resolve)
            self.by_pid[pid] = (skel, anim)

    def sound_events(self) -> list[str]:
        """The ids of the events the clips' sound keys play, sorted."""
        return sorted({event for anims in self.clips.values() for c in anims.values()
                       for _, event in c.get("sounds", [])})

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


def _pages(resolve: Callable[[str, int, dict], tuple[str, Any] | None] | None, sa_pid: int, sa: dict,
           renderer_pid: int, renderer: dict) -> dict[str, int]:
    """The render queue of each atlas page of a skeleton, {texture name: queue}. spine-unity gives each submesh the
    material of its page, and Unity sorts every submesh by its own material's queue: a skeleton whose pages sit in
    several queues (the background page at 2900, the character's at 3050) is drawn in as many steps, in queue order,
    and a particle system that sorts between two of them draws between them (Hibiki's river surface over the river,
    under her). Read from the skeleton data's atlas assets, else from the materials the prefab's renderer keeps."""
    if resolve is None:
        return {}
    pointer = sa.get("skeletonDataAsset") or {}
    found = resolve("pages", sa_pid, pointer) if pointer.get("m_PathID") else None
    if found and found[1]:
        return dict(found[1])
    out: dict[str, int] = {}
    for mat in renderer.get("m_Materials") or []:
        found = resolve("pages", renderer_pid, mat) if mat.get("m_PathID") else None
        for page, queue in (found[1] if found else {}).items():
            out.setdefault(page, queue)
    return out


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
# The lobby is drawn by the PC client's main Camera (level1 Persistent/Camera, whose culling mask has the lobby's layer
# 12), and URP blends only the volumes on the layers of that camera's volume mask (UniversalAdditionalCameraData
# m_VolumeLayerMask 0x40020000). Every lobby keeps its volumes on 30, but for four (Erika, Yoshimi, Shimiko and
# CH0356) on the UI layer 5, which the camera never blends.
CAMERA_VOLUME_LAYERS = frozenset({17, 30})


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
    """Whether a volume takes part in the blend: enabled on an active GameObject in the camera's volume layers (when
    the layer is known), global, with a weight above 0."""
    seen = volume.get("layer") is None or volume["layer"] in CAMERA_VOLUME_LAYERS
    return seen and bool(volume.get("active")) and bool(volume.get("global")) and float(volume.get("weight", 0.0)) > 0


def post_processing(volumes: Iterable[dict]) -> dict:
    """What the lobby's post-processing volumes leave on screen, blended the way URP's VolumeManager does it: the
    enabled global volumes on the camera's volume layers with a weight above 0, by priority (equal ones in hierarchy
    order), each active component lerping its overridden parameters from the stack's value by the volume's weight.
    Only effects that end up doing something are kept (URP's IsActive): {"chromaticAberration": intensity, "panini":
    {distance, cropToFit}, "liftGammaGain": {lift, gamma, gain}, "colorAdjustments": {postExposure, contrast,
    colorFilter, hueShift, saturation}}. volumes: {"weight", "priority", "global", "active", "layer" (optional),
    "components"} (the profile's component typetrees)."""
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
                profile: Callable[[int, dict], list[dict] | None] | None = None,
                resolve: Callable[[str, int, dict], tuple[str, Any] | None] | None = None) -> dict | None:
    """The lobby's layout, touch boxes, post-processing and particle effects from one prefab bundle: kinds maps
    path ids to object types, tree reads a typetree, scripts maps MonoScript path ids to class names,
    profile(volume path id, sharedProfile pointer) gives a volume profile's component typetrees, resolve(kind,
    owner path id, pointer) reads a material ("material") or mesh ("mesh") in another bundle as (id, data)
    (particles.build). None when the root is missing or places none of the skeletons."""
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
            elif kind in ("BoxCollider", "MeshRenderer", "ParticleSystem", "ParticleSystemRenderer",
                          "PlayableDirector", "SpriteRenderer", "Animator"):
                out.append((kind, pid, tree(pid)))
        return out

    # one walk from the root: world transform, activity and components of every GameObject, in hierarchy order
    nodes: list[dict] = []

    def walk(tf: int, m: tuple[float, ...], m3: list[float], active: bool, parent: int, path: str) -> None:
        t = tree(tf)
        go = t["m_GameObject"]["m_PathID"]
        m = _mul(m, _local(t))
        local3 = particles.trs(t)
        m3 = particles.mul(m3, local3)  # the full 3D transform, for the particle systems
        own = bool(tree(go).get("m_IsActive", 1))
        active = active and own
        comps = components(go)
        name = tree(go)["m_Name"]
        path = f"{path}/{name}" if path else name
        nodes.append({"go": go, "name": name, "m": m, "active": active, "own": own, "all": comps,
                      "first": {cls: c for cls, _, c in reversed(comps)},
                      "pids": {cls: pid for cls, pid, _ in reversed(comps)},
                      "parent": parent, "path": path, "t": t, "local3": local3, "m3": m3})
        for child in t.get("m_Children", []):
            if child["m_PathID"] in kinds:
                walk(child["m_PathID"], m, m3, active, go, path)

    walk(top, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), particles.IDENTITY, True, 0, "")
    by_go = {n["go"]: n for n in nodes}
    plan = _intro_plan(nodes, kinds, resolve)

    # skeletons: SkeletonAnimation GameObjects named (by their data asset, else by themselves) after a core skeleton
    layers, skeleton_of_sa, layer_nodes = [], {}, {}
    for n in nodes:
        for cls, pid, sa in n["all"]:
            if cls != "SkeletonAnimation":
                continue
            data = clips.data.get(sa.get("skeletonDataAsset", {}).get("m_PathID", 0))
            name = next((wanted[k.lower()] for k in (data, n["name"]) if k and k.lower() in wanted), None)
            if name is None:
                continue
            skeleton_of_sa[pid] = name
            layer_nodes.setdefault(name, n)
            renderer = n["first"].get("MeshRenderer", {})
            pages = _pages(resolve, pid, sa, n["pids"].get("MeshRenderer", 0), renderer)
            layers.append({
                "name": name, "x": _r(n["m"][4]), "y": _r(n["m"][5]),
                # NGUI units per skeleton unit: the GameObject's world scale times SkeletonDataAsset.scale
                "scale": _r(math.hypot(n["m"][0], n["m"][1]) * clips.scales.get(name, _DATA_SCALE), 5),
                "active": n["active"] and bool(sa.get("m_Enabled", 1)) and bool(renderer.get("m_Enabled", True)),
                "order": renderer.get("m_SortingOrder", 0), "queue": min(pages.values(), default=3000), "pages": pages,
                "z": particles.rounded(n["m3"])[11], "index": len(layers),
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

    drags, touches, random_idle, idle, idles, dialog, container, volumes = [], [], {}, {}, {}, {}, None, []
    for n in nodes:
        for cls, pid, t in n["all"]:
            if is_volume(t):
                vol = {"weight": float(t.get("weight", 0.0)), "priority": float(t.get("priority", 0.0)),
                       "global": bool(t.get("m_IsGlobal")), "active": n["active"] and bool(t.get("m_Enabled", 1)),
                       "layer": int(tree(n["go"]).get("m_Layer", 0))}
                # only the volumes that take part are followed into their profile (often in another bundle), and those
                # the intro turns up or on (the flash, the depth of field)
                if profile is not None and (counts(vol) or (plan is not None and plan.touches(n, pid))):
                    vol["components"] = profile(pid, t["sharedProfile"]) or []
                volumes.append(vol)
                # for the intro (intro.build): the volume's own switch and node
                vol.update(_pid=pid, _node=n, enabled=bool(t.get("m_Enabled", 1)),
                           layer_ok=vol["layer"] in CAMERA_VOLUME_LAYERS)
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
                # every clip of the idle pool plays at once, each on its own track with its sync clips
                # (SpineBase.PlayBaseClip); the first is the looping idle
                pool = list(dict.fromkeys(a for a in map(clips.anim, t.get("idleClipPool", [])) if a))
                if pool:
                    idle[skel], idles[skel] = pool[0], pool
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
    sa_go = {n["go"]: skeleton_of_sa.get(n["pids"].get("SkeletonAnimation", 0)) for n in nodes}
    scale_of = lambda skel: clips.scales.get(skel, _DATA_SCALE)  # noqa: E731
    fx = particles.build(nodes, lambda go: sa_go.get(go), scale_of, resolve, gates=plan.gates if plan else ())
    out = {"prefab": tree(tree(top)["m_GameObject"]["m_PathID"])["m_Name"], "main": main, "layers": layers,
           "drags": drags, "touches": touches, "randomIdle": random_idle, "idle": idle, "idles": idles,
           "dialog": dialog, "post": post_processing(volumes), "fx": fx}
    # the intro's flash and fade sprites are effects too; then the intro itself (intro.py)
    sprites = []
    for n in nodes:
        for cls, pid, t in n["all"]:
            if cls == "SpriteRenderer" and (n["active"] or (plan is not None and intro.kept(n, by_go, plan.gates))):
                found = intro.sprite(n, pid, t, resolve, by_go, lambda go: sa_go.get(go), scale_of)
                if found:
                    sprites.append(found[0])
                    fx["materials"].update(found[1])
                    fx["textures"].update(found[2])
    if plan is not None:
        out["intro"] = intro.build(plan, layers=layers, layer_nodes=layer_nodes, skeleton_of_sa=skeleton_of_sa,
                                   volumes=volumes, fx=fx, sprites=sprites)
    for s in sprites:
        for key in ("_node", "_renderer", "_anchor_go"):
            s.pop(key, None)
    if sprites:
        fx["sprites"] = sprites
    for s in fx["systems"]:
        s.pop("_go", None)
    return out


def _intro_plan(nodes: list[dict], kinds: dict[int, str],
                resolve: Callable[[str, int, dict], tuple[str, Any] | None] | None) -> intro.Plan | None:
    """The intro of a lobby prefab: its PlayableDirector's timeline (resolve "timeline") placed in the walk."""
    director = next(((pid, t) for n in nodes for cls, pid, t in n["all"] if cls == "PlayableDirector"), None)
    if director is None or resolve is None or not (director[1].get("m_PlayableAsset") or {}).get("m_PathID"):
        return None
    found = resolve("timeline", director[0], director[1]["m_PlayableAsset"])
    return intro.Plan(found[1], director[1], nodes, kinds) if found and found[1] else None


def lobby_info(skeletons: Iterable[str], clips: Clips, prefab: dict | None, sounds: dict | None = None) -> dict:
    """Everything the web UI's lobby needs. Without a prefab (e.g. a mod with other skeleton names) every skeleton
    sits at the standard place; the front end then finds the touch boxes from the bones. sounds: the sound key
    events by id (sound_event)."""
    if prefab is None:
        prefab = {"prefab": None, "main": None, "drags": [], "touches": [], "randomIdle": {}, "idle": {}, "idles": {},
                  "dialog": {}, "post": {},
                  "layers": [{"name": s, **STANDARD, "active": True, "order": 0, "queue": 3000, "pages": {}, "z": 0.0,
                              "index": i, "skin": None, "animation": None}
                             for i, s in enumerate(dict.fromkeys(skeletons))],
                  "fx": {"systems": [], "materials": {}, "textures": {}, "meshes": {}}}
    # the intro's sounds are sound events like the clips' (served the same way)
    events = (prefab.get("intro") or {}).pop("events", {})
    return {"view": dict(GAME_VIEW), **prefab, "defaultMix": dict(clips.mixes), "clips": clips.clips,
            "sounds": {**(sounds or {}), **events}}
