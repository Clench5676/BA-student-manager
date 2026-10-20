"""The memorial lobby's intro timeline (gameassets/intro.py): built AnimationClips decoded, the timeline read through a
graph, placed in a synthetic prefab by lobby.read_prefab; its player (web/js/lobby-intro.js) in Node; and a read-only
check against an official game folder."""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.gameassets import intro, lobby

GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
NODE = shutil.which("node")
JS_TESTS = Path(__file__).parent / "js" / "lobby_intro.test.mjs"


def ref(pid: int, fid: int = 0) -> dict:
    return {"m_FileID": fid, "m_PathID": pid}


def words(frames: list[tuple[float, list[tuple[int, float, float, float, float]]]]) -> list[int]:
    """A StreamedClip's data: frames of (time, keys of (curve, a, b, c, d)) as 32-bit words."""
    buf = b""
    for time, keys in frames:
        buf += struct.pack("<fi", time, len(keys))
        for k in keys:
            buf += struct.pack("<i4f", *k)
    return list(struct.unpack(f"<{len(buf) // 4}I", buf))


# Shiroko's flash sprite alpha and flash volume weight, as the game stores them (rounded)
SHIROKO = [(-intro.FLT_MAX, [(0, 0, 0, 0, 1.0), (1, 0, 0, 0, 0.3)]),
           (0.0, [(0, 0.25, -0.75, 0, 1.0), (1, 4.8, -3.6, 0, 0.3)]),
           (0.5, [(1, 0, 0, 0, 0.0)]),
           (2.0, [(0, 0, 0, 0, 0.0)]),
           (intro.FLT_MAX, [])]


def test_streamed_clip_keys_and_their_cubic_segments():
    curves = intro.streamed(words(SHIROKO), 2)
    assert [k[0] for k in curves[0]] == [-1e9, 0.0, 2.0]
    glow = intro._streamed_curve(curves[0])
    assert intro.evaluate(glow, -5) == 1.0
    assert math.isclose(intro.evaluate(glow, 0.5), 0.84375, abs_tol=1e-6)
    assert math.isclose(intro.evaluate(glow, 2.0), 0.0, abs_tol=1e-6) and intro.evaluate(glow, 60) == 0.0
    weight = intro._streamed_curve(curves[1])
    assert math.isclose(intro.evaluate(weight, 0.25), 4.8 * 0.25 ** 3 - 3.6 * 0.25 ** 2 + 0.3, rel_tol=1e-6)
    assert intro.evaluate(weight, 1.0) == 0.0
    # a curve that never changes is a constant; a stream cut short stops where it ends
    assert intro._streamed_curve([[-1e9, 0, 0, 0, 2.5], [1.0, 0, 0, 0, 2.5]]) == {"k": 2.5}
    assert intro.streamed(words(SHIROKO)[:-3], 2)[0][-1][0] == 0.0
    # dense frames lerp, clamped
    dense = {"d": [0.0, 10.0, [0.0, 1.0, 3.0]]}
    assert intro.evaluate(dense, 0.05) == 0.5 and intro.evaluate(dense, 1.0) == 3.0


def test_clip_curves_bind_streamed_dense_and_constant_curves_in_order():
    # 2 streamed, 1 dense, 6 constant curves: the sprite's alpha, the volume's weight, the sprite's object curve (its
    # pptrCurveMapping index), the quad's activity, then a transform's position (3 curves), a material colour... in
    # binding order, as Unity counts them (every binding takes its components' curves, an object curve one)
    clip = {"m_MuscleClip": {"m_StartTime": 0.0, "m_StopTime": 5.3, "m_Clip": {"data": {
        "m_StreamedClip": {"data": words(SHIROKO), "curveCount": 2},
        "m_DenseClip": {"m_FrameCount": 2, "m_CurveCount": 1, "m_SampleRate": 30.0, "m_BeginTime": 0.0, "m_SampleArray": [0.0, 0.0]},
        "m_ConstantClip": {"data": [1.0, -115.0, 388.0, 0.0, 0.5]}}}},
        "m_ClipBindingConstant": {"genericBindings": [
            {"path": intro.crc("Glow"), "attribute": intro.crc("m_Color.a"), "typeID": 212, "customType": 0, "isPPtrCurve": 0},
            {"path": intro.crc("PPV/PPV_C"), "attribute": intro.crc("weight"), "typeID": 114, "customType": 0, "isPPtrCurve": 0},
            {"path": intro.crc("Glow"), "attribute": 0, "typeID": 212, "customType": 23, "isPPtrCurve": 1},
            {"path": intro.crc("Quad"), "attribute": intro.crc("m_IsActive"), "typeID": 1, "customType": 0, "isPPtrCurve": 0},
            {"path": intro.crc("Quad"), "attribute": 1, "typeID": 4, "customType": 0, "isPPtrCurve": 0},
            {"path": intro.crc("Quad"), "attribute": 0x4DAF8B71, "typeID": 23, "customType": 22, "isPPtrCurve": 0}]}}
    out = intro.clip_curves(clip)
    assert out["length"] == 5.3
    b = out["bindings"]
    assert "s" in b[0]["curves"][0] and "s" in b[1]["curves"][0]
    assert "curves" not in b[2]  # an object curve: its slot (the dense one) is not a float curve of anyone's
    assert b[3]["curves"] == [{"k": 1.0}]
    assert b[4]["curves"] == [{"k": -115.0}, {"k": 388.0}, {"k": 0.0}]
    assert b[5]["curves"] == [{"k": 0.5}]
    # a material binding: the low 28 bits of the name's CRC-32, its component in the top 4 (4 + r g b a)
    assert intro.material_attribute(0x4DAF8B71) == ("_Color", 0)
    assert intro.material_attribute((intro.crc("_Color0") & 0x0FFFFFFF) | (7 << 28)) == ("_Color0", 3)
    assert intro.material_attribute(intro.crc("_Nothing")) is None


class Obj:
    def __init__(self, pid: int, kind: str, tree: dict, cab: str = "CAB-tl"):
        self.path_id, self.type, self.assets_file, self._tree = pid, SimpleNamespace(name=kind), SimpleNamespace(name=cab), tree


class Graph:
    """What read_timeline asks of model.BundleGraph: trees and pointers."""

    def __init__(self, objs: list[Obj]):
        self.objs = {o.path_id: o for o in objs}

    def tree(self, obj: Obj) -> dict:
        return obj._tree

    def deref(self, obj: Obj, pointer: dict | None):
        return self.objs.get((pointer or {}).get("m_PathID")) if pointer and pointer.get("m_PathID") else None


def script(pid: int, name: str) -> Obj:
    return Obj(pid, "MonoScript", {"m_ClassName": name})


def tclip(start: float, dur: float, asset: int, **over) -> dict:
    return {"m_Start": start, "m_Duration": dur, "m_ClipIn": 0.0, "m_TimeScale": 1.0, "m_Asset": ref(asset),
            "m_EaseInDuration": 0.0, "m_EaseOutDuration": 0.0, "m_BlendInDuration": -1.0, "m_BlendOutDuration": -1.0,
            "m_PreExtrapolationMode": 0, "m_PostExtrapolationMode": 0, "m_DisplayName": "", **over}


def test_read_timeline_through_the_graph():
    objs = [script(1, "TimelineAsset"), script(2, "SpineAnimationStateTrack"), script(3, "SpineAnimationStateClip"),
            script(4, "AnimationTrack"), script(5, "ControlTrack"), script(6, "ControlPlayableAsset"),
            script(7, "PlayableTrack"), script(8, "TimeLineAudioController"), script(9, "TimeLineUILobbyController"),
            script(10, "GroupTrack"), script(11, "SpineClip")]
    objs += [
        Obj(100, "MonoBehaviour", {"m_Script": ref(1), "m_Name": "T", "m_DurationMode": 0, "m_FixedDuration": 0.0,
                                   "m_Tracks": [ref(200), ref(300), ref(400), ref(600)]}),
        # the game's SpineClip names the animation in ClipName (its animationName is empty)
        Obj(150, "MonoBehaviour", {"m_Script": ref(11), "animationName": "", "ClipName": "Start_Idle_01"}),
        Obj(151, "MonoBehaviour", {"m_Script": ref(11), "animationName": "", "ClipName": "Idle_01"}),
        Obj(200, "MonoBehaviour", {"m_Script": ref(2), "m_Name": "Spine", "m_Muted": 0, "trackIndex": 0, "m_Children": [],
                                   "m_Clips": [tclip(0, 6.1667, 201), tclip(6.1667, 3.3333, 202, m_EaseInDuration=0.25)]}),
        Obj(201, "MonoBehaviour", {"m_Script": ref(3), "template": {"animationReference": ref(150), "loop": 0,
                                                                     "customDuration": 0, "dontEndWithClip": 0}}),
        Obj(202, "MonoBehaviour", {"m_Script": ref(3), "template": {"animationReference": ref(151), "loop": 1, "customDuration": 1,
                                                                     "useBlendDuration": 1, "mixDuration": 0.1,
                                                                     "dontEndWithClip": 1}}),
        Obj(300, "MonoBehaviour", {"m_Script": ref(4), "m_Name": "Anim", "m_Clips": [], "m_Children": [],
                                   "m_InfiniteClip": ref(301), "m_InfiniteClipPreExtrapolation": 1,
                                   "m_InfiniteClipPostExtrapolation": 1}),
        Obj(301, "AnimationClip", {"m_MuscleClip": {"m_StartTime": 0.0, "m_StopTime": 9.6, "m_Clip": {"data": {
            "m_StreamedClip": {"data": words(SHIROKO), "curveCount": 2}, "m_DenseClip": {}, "m_ConstantClip": {"data": []}}}},
            "m_ClipBindingConstant": {"genericBindings": []}}),
        Obj(400, "MonoBehaviour", {"m_Script": ref(10), "m_Name": "Group", "m_Clips": [], "m_Children": [ref(500)]}),
        Obj(500, "MonoBehaviour", {"m_Script": ref(5), "m_Name": "Ctrl", "m_Children": [], "m_Clips": [tclip(1.0, 2.0, 501, m_ClipIn=0.5)]}),
        Obj(501, "MonoBehaviour", {"m_Script": ref(6), "sourceGameObject": {"exposedName": 123, "defaultValue": ref(0)},
                                   "prefabGameObject": ref(0), "updateParticle": 1, "particleRandomSeed": 77,
                                   "searchHierarchy": 0, "active": 1, "postPlayback": 2}),
        Obj(600, "MonoBehaviour", {"m_Script": ref(7), "m_Name": "SFX", "m_Children": [],
                                   "m_Clips": [tclip(0.5, 0.4, 601), tclip(0.0, 0.1, 602)]}),
        Obj(601, "MonoBehaviour", {"m_Script": ref(8), "VoiceId": "", "PlaySoundManager": 0, "SyncEndTimeByClipLength": 0,
                                   "AudioData": {"Volume": 0.4, "Pitch": 1.3, "Loop": 0, "Delay": 0.0, "AudioClips": [ref(9001, 2)]}}),
        Obj(602, "MonoBehaviour", {"m_Script": ref(9), "IsShowLobbyIcons": 0}),
    ]
    g = Graph(objs)
    raw = intro.read_timeline(g, g.objs[100], sound=lambda a, data: {"id": f"cab-tl_{a.path_id}", "volume": data["Volume"]})
    tracks = {t["name"]: t for t in raw["tracks"]}
    assert [t["name"] for t in raw["tracks"]] == ["Spine", "Anim", "Group", "Ctrl", "SFX"]  # a group's children after it
    assert tracks["Ctrl"]["depth"] == 1
    start, idle = tracks["Spine"]["clips"]
    assert (start["asset"]["anim"], start["asset"]["customDuration"], start["asset"]["endWithClip"]) == ("Start_Idle_01", False, True)
    assert (idle["asset"]["anim"], idle["asset"]["loop"], idle["asset"]["endWithClip"]) == ("Idle_01", True, False)
    # the mix a clip starts with: the timeline clip's blend or ease-in with useBlendDuration, None for the default mix
    assert intro._custom_mix(start) is None and intro._custom_mix(idle) == 0.25
    ctrl = tracks["Ctrl"]["clips"][0]
    assert (ctrl["clipIn"], ctrl["asset"]["exposed"], ctrl["asset"]["seed"], ctrl["asset"]["post"]) == (0.5, "123", 77, 2)
    sfx, icons = tracks["SFX"]["clips"]
    assert sfx["asset"]["sound"] == {"id": "cab-tl_601", "volume": 0.4} and icons["asset"]["icons"] is False
    assert tracks["Anim"]["infinite"]["length"] == 9.6
    # the duration: the last clip's end, a recorded clip counting its length
    assert intro.duration(raw) == 9.6
    assert intro.duration({**raw, "durationMode": 1, "fixedDuration": 4.0}) == 4.0


# --- the intro placed in a prefab (lobby.read_prefab) ----------------------------------------------------------------

SA, CHARACTER, VOLUME = 5001, 5002, 7777
SCRIPTS = {SA: "SkeletonAnimation", CHARACTER: "SpineCharacter"}
SKELETONS = ["Test_home", "Test_scene"]
T_SPINE, T_SCENE, T_ANIM, T_CTRL, T_SFX = 61, 62, 63, 64, 65


class Prefab:
    def __init__(self):
        self.objects: dict[int, tuple[str, dict]] = {}

    def node(self, go: int, name: str, father: int = 0, pos=(0.0, 0.0), scale=(1.0, 1.0), active: int = 1, layer: int = 0):
        tf = go + 100000
        self.objects[go] = ("GameObject", {"m_Name": name, "m_IsActive": active, "m_Layer": layer,
                                           "m_Component": [{"component": ref(tf)}]})
        self.objects[tf] = ("Transform", {
            "m_GameObject": ref(go), "m_Father": ref(father + 100000 if father else 0), "m_Children": [],
            "m_LocalPosition": {"x": pos[0], "y": pos[1], "z": 0.0}, "m_LocalScale": {"x": scale[0], "y": scale[1], "z": 1.0},
            "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}})
        if father:
            self.objects[father + 100000][1]["m_Children"].append(ref(tf))
        return go

    def add(self, go: int, pid: int, kind: str, tree: dict) -> int:
        self.objects[pid] = (kind, {"m_GameObject": ref(go), **tree})
        self.objects[go][1]["m_Component"].append({"component": ref(pid)})
        return pid


def binding(path: str, attr: str | int, type_id: int, curves: list[dict], custom: int = 0) -> dict:
    return {"path": intro.crc(path), "type": type_id, "attr": intro.crc(attr) if isinstance(attr, str) else attr,
            "custom": custom, "script": {}, "pptr": False, "curves": curves}


def spine_clip(start: float, dur: float, anim: str, custom: bool = False, loop: bool = False, end: bool = True) -> dict:
    return {"start": start, "dur": dur, "clipIn": 0.0, "scale": 1.0, "easeIn": 0.0, "easeOut": 0.0, "blendIn": -1.0,
            "blendOut": -1.0, "pre": 0, "post": 0, "name": anim,
            "asset": {"class": "SpineAnimationStateClip", "anim": anim, "loop": loop, "customDuration": custom,
                      "useBlendDuration": True, "mix": 0.1, "endWithClip": end, "endMix": 0.1, "alpha": 1.0}}


ON_OFF = {"s": [[-1e9, 0, 0, 0, 1.0], [0.0, 0, 0, 0, 1.0], [2.0, 0, 0, 0, 0.0]]}
OFF_ON_OFF = {"s": [[-1e9, 0, 0, 0, 0.0], [1.0, 0, 0, 0, 1.0], [2.0, 0, 0, 0, 0.0]]}


def raw_timeline() -> dict:
    return {"name": "Test_Timeline", "durationMode": 0, "fixedDuration": 0.0, "tracks": [
        {"pid": T_SPINE, "class": "SpineAnimationStateTrack", "name": "Spine", "muted": False, "depth": 0, "trackIndex": 0,
         "clips": [spine_clip(2.0, 3.0, "Start_Idle_01"), spine_clip(5.0, 3.0, "Idle_01", custom=True, loop=True, end=False)]},
        {"pid": T_SCENE, "class": "SpineAnimationStateTrack", "name": "Scene", "muted": False, "depth": 0, "trackIndex": 0,
         "clips": [spine_clip(0.0, 2.0, "Start_Idle_01")]},
        {"pid": T_ANIM, "class": "AnimationTrack", "name": "Anim", "muted": False, "depth": 0, "clips": [], "pre": 1, "post": 1,
         "infinite": {"length": 3.0, "bindings": [
             binding("BG/Glow", "m_IsActive", 1, [ON_OFF]),
             binding("BG/Glow", "m_Color.a", 212, [{"s": [[-1e9, 0, 0, 0, 1.0], [0.0, 0, 0, -0.5, 1.0], [2.0, 0, 0, 0, 0.0]]}]),
             binding("LobbySpine/Scene", "m_IsActive", 1, [ON_OFF]),
             binding("LobbySpine/Scene", 1, 4, [{"k": -500.0}, {"k": -962.0}, {"k": 0.0}]),
             binding("BG/PPV/PPV_D", "m_IsActive", 1, [OFF_ON_OFF]),
             binding("BG/PPV/PPV_D", "weight", 114, [{"k": 1.0}]),
             binding("FX/Spark", (intro.crc("_Color") & 0x0FFFFFFF) | (7 << 28), 199, [{"k": 0.5}], custom=22),
             binding("Missing/Thing", "m_IsActive", 1, [ON_OFF]),
         ]}},
        {"pid": T_CTRL, "class": "ControlTrack", "name": "Ctrl", "muted": False, "depth": 0, "clips": [
            {"start": 1.0, "dur": 2.0, "clipIn": 0.5, "scale": 1.0, "name": "FX", "asset": {
                "class": "ControlPlayableAsset", "exposed": "123", "default": 0, "prefab": False, "particles": True,
                "seed": 7, "directors": True, "timeControl": True, "hierarchy": False, "active": True, "post": 2}}]},
        {"pid": T_SFX, "class": "PlayableTrack", "name": "SFX", "muted": False, "depth": 0, "clips": [
            {"start": 0.5, "dur": 0.4, "clipIn": 0.0, "scale": 1.0, "name": "SFX", "asset": {
                "class": "TimeLineAudioController", "voice": "",
                "sound": {"id": "cab-tl_77", "name": "Intro", "volume": 0.4, "pitch": 1.3, "clips": ["cab-sfx_1"]}}},
            {"start": 0.0, "dur": 0.1, "clipIn": 0.0, "scale": 1.0, "name": "UI",
             "asset": {"class": "TimeLineUILobbyController", "icons": False}},
            {"start": 6.0, "dur": 0.1, "clipIn": 0.0, "scale": 1.0, "name": "UI",
             "asset": {"class": "TimeLineUILobbyController", "icons": True}}]},
    ]}


def particle_system() -> dict:
    const = lambda v: {"minMaxState": 0, "scalar": v, "minScalar": v}  # noqa: E731
    return {"lengthInSec": 1.0, "looping": 1, "prewarm": 0, "playOnAwake": 1, "moveWithTransform": 0, "scalingMode": 0,
            "InitialModule": {"startLifetime": const(1.0), "startSpeed": const(0.0), "startSize": const(0.5),
                              "startColor": {"minMaxState": 0, "maxColor": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
                              "maxNumParticles": 100},
            "EmissionModule": {"enabled": 1, "rateOverTime": const(5.0), "m_Bursts": []}, "SubModule": {"enabled": 0}}


def build_prefab() -> Prefab:
    p = Prefab()
    p.node(1, "LobbyTest")
    p.add(1, 1002, "Animator", {"m_Enabled": 1})
    p.node(2, "LobbySpine", father=1, pos=(0.0, -962.0), scale=(100.0, 100.0))
    p.node(3, "Test_home", father=2)
    p.add(3, 301, "MonoBehaviour", {"m_Enabled": 1, "m_Script": ref(SA), "skeletonDataAsset": ref(9001, 3),
                                    "initialSkinName": "", "_animationName": ""})
    p.add(3, 302, "MeshRenderer", {"m_Enabled": True, "m_SortingOrder": 0})
    # an intro scene: inactive at rest, switched on by the intro
    p.node(4, "Scene", father=2, active=0)
    p.add(4, 401, "MonoBehaviour", {"m_Enabled": 1, "m_Script": ref(SA), "skeletonDataAsset": ref(9002, 3),
                                    "initialSkinName": "", "_animationName": ""})
    p.add(4, 402, "MeshRenderer", {"m_Enabled": True, "m_SortingOrder": 1})
    p.node(5, "BG", father=1)
    p.node(6, "Glow", father=5, scale=(3000.0, 3000.0), active=0)
    p.add(6, 601, "SpriteRenderer", {"m_Enabled": True, "m_Materials": [ref(70, 2)], "m_Sprite": ref(71, 2),
                                     "m_Color": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}, "m_SortingOrder": 6,
                                     "m_SortingLayerID": 0, "m_FlipX": False, "m_FlipY": False})
    p.node(7, "Timeline", father=5)
    p.add(7, 701, "PlayableDirector", {"m_Enabled": 1, "m_PlayableAsset": ref(7000, 1), "m_WrapMode": 2,
                                       "m_InitialState": 0, "m_SceneBindings": [
                                           {"key": ref(T_SPINE, 1), "value": ref(301)},
                                           {"key": ref(T_SCENE, 1), "value": ref(401)},
                                           {"key": ref(T_ANIM, 1), "value": ref(1002)}],
                                       "m_ExposedReferences": {"m_References": [["123", ref(9)]]}})
    fields = {"m_Enabled": 1, "m_Script": ref(VOLUME), "m_IsGlobal": 1, "priority": 0.0, "blendDistance": 0.0}
    p.node(8, "PPV", father=5, layer=30)
    p.add(8, 801, "MonoBehaviour", {**fields, "weight": 1.0, "sharedProfile": ref(-501, 4)})
    p.node(10, "PPV_D", father=8, layer=30, active=0)
    p.add(10, 1001, "MonoBehaviour", {**fields, "weight": 0.0, "sharedProfile": ref(-502, 4)})
    # intro-only effects: a control clip's target, inactive at rest, with a particle system below it
    p.node(9, "FX", father=1, active=0)
    p.node(11, "Spark", father=9)
    p.add(11, 1101, "ParticleSystem", particle_system())
    p.add(11, 1102, "ParticleSystemRenderer", {"m_Enabled": 1, "m_RenderMode": 0, "m_SortingOrder": 2, "m_SortingLayerID": 0,
                                               "m_Materials": [ref(72, 2)], "m_Mesh": ref(0), "m_SortingFudge": 0.0})
    return p


def param(value) -> dict:
    return {"m_OverrideState": 1, "m_Value": value}


PROFILES = {-501: [{"m_Name": "ChromaticAberration", "active": 1, "intensity": param(0.2)}],
            -502: [{"m_Name": "DepthOfField", "active": 1, "mode": param(1), "gaussianStart": param(0.0),
                    "gaussianEnd": param(0.0), "gaussianMaxRadius": param(1.5)}]}
TEX = {"id": "cab-fx_9", "name": "Square", "w": 4, "h": 4, "filter": 1, "mips": 0, "wrap": [1, 1], "srgb": 1}


def read(p: Prefab, timeline: dict | None = None):
    clips = lobby.Clips([(9001, {"m_Name": "Test_home_SkeletonData", "scale": 0.01, "skeletonJSON": ref(1, 1), "defaultMix": 0.2}),
                         (9002, {"m_Name": "Test_scene_SkeletonData", "scale": 0.01, "skeletonJSON": ref(1, 1),
                                 "defaultMix": 0.2})], SKELETONS)
    asked = []

    def resolve(kind, owner, pointer):
        asked.append((kind, owner, pointer.get("m_PathID")))
        pid = pointer.get("m_PathID")
        if kind == "timeline":
            return ("cab-tl_7000", timeline) if timeline else None
        if kind == "material" and pid == 70:
            return "cab-mat_70", {"program": "sprite", "queue": 3000, "src": 1, "dst": 10, "tex": {}, "colors": {}}
        if kind == "material" and pid == 72:
            tex = {"_Texture": {**TEX, "id": "cab-fx_10", "st": [1, 1, 0, 0]}}
            return "cab-mat_72", {"program": "additive", "queue": 3000, "tex": tex, "colors": {}}
        if kind == "sprite" and pid == 71:
            return "cab-sp_71", {"tex": TEX, "rect": [0.0, 0.0, 4.0, 4.0], "size": [1.0, 1.0], "pivot": [0.5, 0.5]}
        return None

    kinds = {pid: kind for pid, (kind, _) in p.objects.items()}
    prefab = lobby.read_prefab(kinds, lambda pid: p.objects[pid][1], {**SCRIPTS}, "LobbyTest", SKELETONS, clips,
                               profile=lambda pid, ptr: PROFILES.get(ptr["m_PathID"]), resolve=resolve)
    return lobby.lobby_info(SKELETONS, clips, prefab, {"cab-a_1": {"name": "Other", "clips": ["cab-b_2"]}}), asked


def test_the_intro_placed_in_the_prefab():
    info, asked = read(build_prefab(), raw_timeline())
    it = info["intro"]
    assert (it["duration"], it["wrap"], it["idle"]) == (8.0, "none", 5.0)
    assert it["icons"] == [[0.0, False], [6.0, True]]
    # the Spine tracks by skeleton: the default mix without a custom duration
    spine = {s["skeleton"]: s for s in it["spine"]}
    assert [(c["anim"], c["t"], c["mix"], c["end"]) for c in spine["Test_home"]["clips"]] == [
        ("Start_Idle_01", 2.0, None, True), ("Idle_01", 5.0, 0.0, False)]
    assert spine["Test_scene"]["clips"][0]["anim"] == "Start_Idle_01"
    # the GameObjects it switches or moves, with their own activity at rest
    nodes = {n["path"]: n for n in it["nodes"]}
    paths = [n["path"] for n in it["nodes"]]
    assert set(paths) == {"LobbyTest/LobbySpine/Scene", "LobbyTest/BG/Glow", "LobbyTest/BG/PPV/PPV_D", "LobbyTest/FX"}
    assert nodes["LobbyTest/LobbySpine/Scene"]["trs"][:3] == [0.0, 0.0, 0.0] and not nodes["LobbyTest/FX"]["own"]
    index = {p: i for i, p in enumerate(paths)}
    props = {(p["on"], p["i"], p["attr"], p["k"]) for p in it["props"]}
    assert ("node", index["LobbyTest/BG/Glow"], "active", 0) in props
    assert ("sprite", 0, "color", 3) in props
    assert ("node", index["LobbyTest/LobbySpine/Scene"], "position", 0) in props
    assert ("volume", 1, "weight", 0) in props
    spark_color = next(p for p in it["props"] if p["on"] == "system")
    assert ("system", 0, "material", 3) in props and spark_color["name"] == "_Color"
    assert spark_color["base"] == [1.0, 1.0, 1.0, 1.0]  # the material's own colour for the components it leaves
    assert it["skipped"] == {"unbound": 1}  # a binding to a GameObject the prefab does not have
    assert it["control"] == [{"node": index["LobbyTest/FX"], "t": 1.0, "d": 2.0, "in": 0.5, "particles": True}]
    # its sound is a lobby sound event like the clips' (served by the same route)
    assert it["sounds"] == [{"t": 0.5, "id": "cab-tl_77"}] and "events" not in it
    assert info["sounds"]["cab-tl_77"]["clips"] == ["cab-sfx_1"] and "cab-a_1" in info["sounds"]
    # the scene the intro shows is loaded, hidden at rest; the depth of field volume's profile is read though its
    # weight is 0 at rest, and it carries its switch
    layers = {l["name"]: l for l in info["layers"]}
    assert layers["Test_scene"]["intro"] is True and layers["Test_scene"]["gate"] == [index["LobbyTest/LobbySpine/Scene"]]
    assert layers["Test_scene"]["moves"]["of"] == "static" and "intro" not in layers["Test_home"]
    assert ("pages", 401, 9002) in asked
    vols = it["volumes"]
    assert vols[1]["gate"] == [index["LobbyTest/BG/PPV/PPV_D"]] and vols[1]["rest"] == 0 and vols[1]["components"] == [
        {"name": "DepthOfField", "active": True, "params": {"mode": 1.0, "gaussianStart": 0.0, "gaussianEnd": 0.0,
                                                            "gaussianMaxRadius": 1.5}}]
    assert info["post"] == {"chromaticAberration": 0.2}
    # the intro-only particle system: off at rest, switched by its gate; no private keys left
    spark, = info["fx"]["systems"]
    assert (spark["name"], spark["rest"], spark["gate"], spark["base"]) == ("Spark", 0, [index["LobbyTest/FX"]], True)
    assert "_go" not in spark
    # the flash sprite: its quad, UVs and material (the sprite's texture as _MainTex), off at rest
    glow, = info["fx"]["sprites"]
    assert glow["quad"] == [-0.5, -0.5, 0.5, 0.5] and glow["uv"] == [0.0, 0.0, 1.0, 1.0] and glow["rest"] == 0
    assert glow["material"] == "cab-mat_70~cab-fx_9" and glow["static"][0] == 3000.0
    assert info["fx"]["materials"][glow["material"]]["tex"]["_MainTex"]["id"] == "cab-fx_9"
    assert set(info["fx"]["textures"]) == {"cab-fx_9", "cab-fx_10"}
    assert not any(k.startswith("_") for s in info["fx"]["sprites"] for k in s)
    assert json.loads(json.dumps(info)) == info


def test_without_a_timeline_nothing_changes():
    info, asked = read(build_prefab(), None)
    assert "intro" not in info
    # the inactive scene, sprite and effects stay out; the depth of field's profile is not read
    assert [l["name"] for l in info["layers"] if l["active"]] == ["Test_home"] and not any(l.get("intro") for l in info["layers"])
    assert info["fx"]["systems"] == [] and "sprites" not in info["fx"]
    assert ("timeline", 701, 7000) in asked


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_intro_player_in_node():
    result = subprocess.run([NODE, "--test", str(JS_TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


# --- an official game folder -----------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def real_game(tmp_path_factory):
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs
    root = tmp_path_factory.mktemp("intro") / "cache"
    return GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=root, allowed=False))


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_intros(real_game):
    # Shiroko: Start_Idle_01, then Idle_01 from 6.17 s; the flash sprite fades from white over 2 s; the flash volume and
    # the depth of field (switched on from 2.83 to 4.17 s); her timeline holds its last frame
    shiroko = real_game.lobby_info("shiroko_home")
    it = shiroko["intro"]
    assert (it["duration"], it["wrap"]) == (9.5, "hold")
    clips = it["spine"][0]["clips"]
    assert [c["anim"] for c in clips] == ["Start_Idle_01", "Idle_01"] and math.isclose(clips[1]["t"], 6.166667)
    glow = next(p for p in it["props"] if p["on"] == "sprite" and p["attr"] == "color" and p["k"] == 3)
    assert intro.evaluate(glow["c"], 0) == 1.0 and math.isclose(intro.evaluate(glow["c"], 0.5), 0.84375, abs_tol=1e-4)
    assert intro.evaluate(glow["c"], 2.0) == 0.0
    names = [n["path"].rsplit("/", 1)[-1] for n in it["nodes"]]
    dof = next(p for p in it["props"] if p["on"] == "node" and names[p["i"]] == "PPV_D")
    assert [intro.evaluate(dof["c"], t) > 0.5 for t in (2.0, 3.0, 4.5)] == [False, True, False]
    assert len(it["sounds"]) == 5 and all(s["id"] in shiroko["sounds"] for s in it["sounds"])
    # the bokeh it moves (their transforms below the bone), the flash sprite drawn with the sprite's own texture
    assert sum(1 for s in shiroko["fx"]["systems"] if s.get("moves")) == 3
    sprite, = shiroko["fx"]["sprites"]
    assert sprite["name"] == "Glow" and sprite["order"] == 6
    assert real_game.lobby_fx_texture("shiroko_home", sprite["material"].split("~")[1])[:4] == b"\x89PNG"
    # Hoshino's background slides and zooms; Akari's sushi scene is loaded for the intro only
    hoshino = real_game.lobby_info("hoshino_home")
    bg = next(l for l in hoshino["layers"] if l["name"] == "Hoshino_home_background")
    assert bg["moves"]["of"] == "static" and hoshino["intro"]["wrap"] == "none"
    akari = {l["name"]: l for l in real_game.lobby_info("akari_home")["layers"]}
    assert akari["akari_scene"]["intro"] is True and akari["akari_scene"]["active"] is False
    # Nonomi's control clips play effects that are off at rest
    nonomi = real_game.lobby_info("nonomi_home")
    assert len(nonomi["intro"]["control"]) == 2
    assert any(s.get("rest") == 0 and s.get("gate") for s in nonomi["fx"]["systems"])
    # Shun's glow: its clip's object curve (the sprite) sits before its colour's red, green and blue, which stay white
    # (they took the curve after theirs, red 0: a cyan glow)
    props = [p for p in real_game.lobby_info("shun_home")["intro"]["props"] if p["on"] == "sprite" and p["attr"] == "color"]
    assert {p["k"]: intro.evaluate(p["c"], 0.0) for p in props if p["k"] < 3} == {0: 1.0, 1: 1.0, 2: 1.0}
    # an intro sound decodes from memory like the clips' sounds
    clip = shiroko["sounds"][it["sounds"][0]["id"]]["clips"][0]
    assert real_game.lobby_sound("shiroko_home", clip)[:4] == b"RIFF"
