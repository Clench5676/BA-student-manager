"""Memorial lobby layout and interaction (gameassets/lobby.py) on synthetic typetrees, the lobby.json route, and a
read-only check against a local install."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import pytest

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.gameassets import lobby
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState

# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")

SA, CHARACTER, DRAG, BODY, WIDGET, CHAT, UTILITY, CONTAINER = range(5001, 5009)
SCRIPTS = {SA: "SkeletonAnimation", CHARACTER: "SpineCharacter", DRAG: "SpineDragIK", BODY: "SpineCharacterBodyTouch",
           WIDGET: "UIWidget", CHAT: "ChatDialog", UTILITY: "SkeletonUtilityBone", CONTAINER: "UILobbyContainer"}


def ref(pid: int, fid: int = 0) -> dict:
    return {"m_FileID": fid, "m_PathID": pid}


def vec(x: float, y: float) -> dict:
    return {"x": x, "y": y, "z": 0.0}


class Prefab:
    """A tiny prefab: path id -> (type, typetree), built like UnityPy reads them."""

    def __init__(self):
        self.objects: dict[int, tuple[str, dict]] = {}

    def node(self, go: int, name: str, father: int = 0, pos=(0.0, 0.0), scale=(1.0, 1.0), rot: float = 0.0,
             active: int = 1, layer: int = 0) -> int:
        tf = go + 100000
        half = math.radians(rot) / 2
        self.objects[go] = ("GameObject", {"m_Name": name, "m_IsActive": active, "m_Layer": layer,
                                           "m_Component": [{"component": ref(tf)}]})
        self.objects[tf] = ("Transform", {
            "m_GameObject": ref(go), "m_Father": ref(father + 100000 if father else 0), "m_Children": [],
            "m_LocalPosition": vec(*pos), "m_LocalScale": {"x": scale[0], "y": scale[1], "z": 1.0},
            "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": math.sin(half), "w": math.cos(half)}})
        if father:
            self.objects[father + 100000][1]["m_Children"].append(ref(tf))
        return go

    def add(self, go: int, pid: int, kind: str, tree: dict) -> int:
        self.objects[pid] = (kind, {"m_GameObject": ref(go), **tree})
        self.objects[go][1]["m_Component"].append({"component": ref(pid)})
        return pid

    def mb(self, go: int, pid: int, script: int, **fields) -> int:
        return self.add(go, pid, "MonoBehaviour", {"m_Enabled": 1, "m_Script": ref(script), **fields})

    def read(self, root: str, skeletons, clips, resolve=None):
        kinds = {pid: kind for pid, (kind, _) in self.objects.items()}
        return lobby.read_prefab(kinds, lambda pid: self.objects[pid][1], SCRIPTS, root, skeletons, clips, resolve=resolve)


def clip(name: str, track: int, loop: int = 0, **fields) -> dict:
    return {"m_Name": name, "ClipName": name.split("-", 1)[1], "Track": track, "Loop": loop, "PlayMode": 1,
            "FinishMode": 2, "UseDefaultIntroMix": 1, "IntroMix": 0.0, "UseDefaultOutroMix": 1, "OutroMix": 0.0,
            "NextClipObject": ref(0), "SyncPlayClipObjects": [], "BlockInteractionOnPlay": 0,
            "RandomTimingIntroDelayMode": 0, "RandomDelayMin": 3.0, "RandomDelayMax": 4.0,
            "AddRandomLoopMin": 0, "AddRandomLoopMax": 0, **fields}


def skeleton_data(name: str, mix: float) -> dict:
    return {"m_Name": f"{name}_SkeletonData", "scale": 0.01, "skeletonJSON": ref(1, 1), "defaultMix": mix}


SKELETONS = ["Test_home", "Test_bg", "Test_scene"]


def core_clips() -> lobby.Clips:
    return lobby.Clips([
        (9001, skeleton_data("Test_home", 0.4)), (9002, skeleton_data("Test_bg", 0.2)), (9003, skeleton_data("Test_scene", 0.2)),
        # clip assets name their skeleton in any case; the core's own spelling wins
        (8001, clip("test_home-Pat_01_M", 1, loop=1, SyncPlayClipObjects=[ref(8003)])),
        (8003, clip("Test_home-Pat_01_A", 2, loop=1, UseDefaultIntroMix=0, IntroMix=0.0)),
        (8002, clip("Test_home-PatEnd_01_M", 1, UseDefaultOutroMix=0, OutroMix=0.3)),
        (8004, clip("Test_home-Pat_02_M", 1, FinishMode=3, NextClipObject=ref(8001))),
        (8005, clip("Test_home-Eye_Close_01", 4, PlayMode=3, RandomTimingIntroDelayMode=1, RandomDelayMin=8.0,
                    RandomDelayMax=15.0, AddRandomLoopMax=1, BlockInteractionOnPlay=0)),
        (8006, clip("Test_home-Idle_01", 0, loop=1, PlayMode=0, FinishMode=0)),
        (7000, {"m_Name": "PPPV_Lobby_Test", "components": []}),
    ], SKELETONS)


def build_prefab(spine_y: float = -962.0, spine_scale: float = 100.0) -> Prefab:
    p = Prefab()
    p.node(1, "LobbyTest")
    p.mb(1, 1001, CONTAINER, SpineCharacter=ref(303))
    p.node(2, "LobbySpine", father=1, pos=(0.0, spine_y), scale=(spine_scale, spine_scale))
    # the character: SkeletonAnimation, renderer, SpineCharacter with its idle pools, a utility bone below it
    p.node(3, "Test_home", father=2)
    p.mb(3, 301, SA, skeletonDataAsset=ref(9001, 3), initialSkinName="", _animationName="")
    p.add(3, 302, "MeshRenderer", {"m_Enabled": True, "m_SortingOrder": 0})
    p.mb(3, 303, CHARACTER, SkeletonAnimation=ref(301), idleBaseRandomClipPool=[ref(8005, 3)], idleClipPool=[ref(8006, 3)])
    p.node(9, "Touch_Point", father=3, pos=(1.1745, 0.5559))
    p.mb(9, 901, UTILITY, boneName="Touch_Point")
    # the background, drawn first (lower sorting order) and with its own start animation
    p.node(4, "Test_bg", father=2)
    p.mb(4, 401, SA, skeletonDataAsset=ref(9002, 3), initialSkinName="", _animationName="Idle_01")
    p.add(4, 402, "MeshRenderer", {"m_Enabled": True, "m_SortingOrder": -1})
    # a talk-only scene skeleton the prefab keeps inactive
    p.node(10, "Scene", father=2, active=0)
    p.mb(10, 1101, SA, skeletonDataAsset=ref(9003, 3), initialSkinName="", _animationName="Start_Idle_01")
    # head pat: 600 x 400 box at (191, 331), bone values in Unity units (x 100 = skeleton units)
    p.node(5, "HairPatIK", father=1, pos=(191.0, 331.0))
    p.add(5, 501, "BoxCollider", {"m_Enabled": True, "m_Size": vec(600.0, 400.0), "m_Center": vec(0.0, 0.0)})
    p.mb(5, 502, WIDGET, mDepth=-89)
    p.mb(5, 503, DRAG, SpineController=ref(303), IngClip=ref(8001, 3), EndClip=ref(8002, 3), Bone=ref(9 + 100000),
         OrigLocalPos=vec(1.1745, 0.5559), MinLocalPos=vec(1.0847, 0.1002), MaxLocalPos=vec(1.2618, 0.9298),
         BoneCenterOffset=vec(0.0, 0.0), FollowDragSpeed01=0.21, FollowReleaseSpeed01=0.15, TriggerDelay=0.1)
    # the eye follow box is switched off by its collider
    p.node(7, "EyeIK", father=1)
    p.add(7, 701, "BoxCollider", {"m_Enabled": False, "m_Size": vec(3500.0, 2400.0), "m_Center": vec(0.0, 0.0)})
    p.mb(7, 703, DRAG, SpineController=ref(303), IngClip=ref(0), EndClip=ref(0), Bone=ref(0),
         OrigLocalPos=vec(0, 0), MinLocalPos=vec(0, 0), MaxLocalPos=vec(0, 0), BoneCenterOffset=vec(0, 0),
         FollowDragSpeed01=0.16, FollowReleaseSpeed01=0.07, TriggerDelay=0.1)
    # the body box, turned by 10 degrees, its collider centre off the GameObject
    p.node(6, "BodyTouch", father=1, pos=(193.0, -600.0), rot=10.0)
    p.add(6, 601, "BoxCollider", {"m_Enabled": True, "m_Size": vec(1000.0, 1000.0),
                                  "m_Center": vec(-39.0 * math.sin(math.radians(10)), -39.0 * math.cos(math.radians(10)))})
    p.mb(6, 602, WIDGET, mDepth=-90)
    p.mb(6, 603, BODY, SpineCharacter=ref(303))
    # the dialogue bubble anchors
    p.node(8, "ChatDialog", father=1, pos=(10.0, 20.0))
    p.node(11, "Talk", father=8, pos=(477.0, 9.0))
    p.mb(8, 801, CHAT, DialogBoxes=[{"Type": 0, "GameObject": ref(11)}])
    return p


def test_prefab_candidates():
    assert lobby.prefab_candidates("ch0242_home", ["CH0242_home"])[0] == "lobbych0242"
    assert lobby.prefab_candidates("ch0295_home_gl", [])[0] == "lobbych0295_gl"
    assert lobby.prefab_candidates("ako_home_teen", ["ako_home_Teen"])[0] == "lobbyako_teen"
    # two cores share a skeleton; group lobbies are named after the skeleton itself
    assert "lobbyairi" in lobby.prefab_candidates("airi0_home", ["Airi_home"])
    assert "lobbyhoshino_multi" in lobby.prefab_candidates("lobbyhoshino_multi", ["LobbyHoshino_multi"])
    names = lobby.prefab_candidates("hoshino_home", ["Hoshino_home", "Hoshino_home_background"])
    assert names[0] == "lobbyhoshino" and len(names) == len(set(names))


def test_clips_resolve_mixes_chains_and_random():
    clips = core_clips()
    assert clips.mixes == {"Test_home": 0.4, "Test_bg": 0.2, "Test_scene": 0.2}
    home = clips.clips["Test_home"]
    assert set(clips.clips) == {"Test_home"}
    # the default intro is the skeleton's defaultMix, not a fixed value
    assert home["Pat_01_M"] == {"track": 1, "loop": True, "mode": 1, "finish": 2, "intro": 0.4, "outro": 0.4,
                                "outroAt": None, "next": None, "sync": ["Pat_01_A"], "block": False, "random": None}
    assert home["Pat_01_A"]["intro"] == 0.0 and home["PatEnd_01_M"]["outro"] == 0.3
    # its own outro: from the clip's end plus its OutroStartOffset; the default one ends with the clip
    assert home["PatEnd_01_M"]["outroAt"] == 0.0
    assert home["Pat_02_M"]["finish"] == 3 and home["Pat_02_M"]["next"] == "Pat_01_M"
    assert home["Eye_Close_01"]["random"] == {"min": 8.0, "max": 15.0, "loops": [0, 1], "pre": 1, "preDelay": 0.0}
    assert clips.anim(ref(8002, 3)) == "PatEnd_01_M" and clips.anim(ref(0)) is None
    assert "sounds" not in home["Pat_01_M"] and clips.sound_events() == []


def test_idle_sync_clips_and_sound_keys():
    # Shigure's idle starts Train_00_R on track 3: masked at random times, its first wait 3 s plus 10 to 15 s, and a
    # sound key at 3.1 s on an event of the lobbies' shared bundle; a clip of the idle pool beyond the first
    events = {(-2, 1, -900): "cab-common_-900", (-3, 1, -901): "cab-common_-901"}
    asked = []

    def sound(owner, pointer):
        asked.append(owner)
        return events.get((owner, pointer["m_FileID"], pointer["m_PathID"]))
    clips = lobby.Clips([
        (9001, skeleton_data("Test_home", 0.4)),
        (-1, clip("Test_home-Idle_01", 0, loop=1, PlayMode=0, FinishMode=0, SyncPlayClipObjects=[ref(-2), ref(0)])),
        (-2, clip("Test_home-Train_00_R", 3, loop=1, PlayMode=2, UseDefaultIntroMix=0, RandomTimingIntroDelayMode=2,
                  IntroDelayDuration=3.0, RandomDelayMin=10.0, RandomDelayMax=15.0,
                  SoundKeys=[{"Time": 3.0999999046325684, "Event": ref(-900, 1)}, {"Time": 4.0, "Event": ref(0)}])),
        (-3, clip("Test_home-Snow_00_R", 4, loop=1, PlayMode=2, SoundKeys=[{"Time": 0.5, "Event": ref(-901, 1)}])),
    ], ["Test_home"], sound=sound)
    home = clips.clips["Test_home"]
    assert home["Idle_01"]["sync"] == ["Train_00_R"]  # an empty pointer is left out
    train = home["Train_00_R"]
    assert (train["track"], train["mode"], train["loop"], train["intro"]) == (3, 2, True, 0.0)
    assert train["random"] == {"min": 10.0, "max": 15.0, "loops": [0, 0], "pre": 2, "preDelay": 3.0}
    assert train["sounds"] == [[3.1, "cab-common_-900"]]  # a key without an event is dropped
    assert clips.sound_events() == ["cab-common_-900", "cab-common_-901"]
    assert set(asked) == {-2, -3}
    # the idle pool: every clip of it, the first is the idle
    p = build_prefab()
    p.objects[303][1]["idleClipPool"] = [ref(8006, 3), ref(8005, 3), ref(8006, 3), ref(0)]
    info = p.read("LobbyTest", SKELETONS, core_clips())
    assert info["idle"] == {"Test_home": "Idle_01"} and info["idles"] == {"Test_home": ["Idle_01", "Eye_Close_01"]}


def test_sound_events_as_the_game_plays_them():
    def clip_id(pointer):
        return f"cab-sfx_{pointer['m_PathID']}" if pointer.get("m_PathID") else None
    subway = {"m_Name": "SFX_Spine_Subway", "AudioData": {"Volume": 0.699999988079071, "Pitch": 1.0,
                                                          "AudioClips": [ref(655, 5), ref(0)]}}
    assert lobby.sound_event(subway, clip_id) == {"name": "SFX_Spine_Subway", "volume": 0.7, "pitch": 1.0,
                                                  "clips": ["cab-sfx_655"]}
    # a pitch of 0 or below is not set on the source (it keeps 1), one above is the playback rate
    cloth = {"m_Name": "SpineSFX_Cloth", "AudioData": {"Volume": 0.08, "Pitch": -3.0, "AudioClips": [ref(1, 5), ref(2, 5)]}}
    assert lobby.sound_event(cloth, clip_id)["pitch"] == 1.0 and len(lobby.sound_event(cloth, clip_id)["clips"]) == 2
    assert lobby.sound_event({**cloth, "AudioData": {**cloth["AudioData"], "Pitch": 3.0}}, clip_id)["pitch"] == 3.0
    # an ambient event, or one without clips, is not a sound key's
    assert lobby.sound_event({"m_Name": "AmbientAudioEvent_Breeze", "Clip": ref(3, 5), "Command": 0}, clip_id) is None
    assert lobby.sound_event({"AudioData": {"AudioClips": []}}, clip_id) is None


def test_prefab_layout_drags_touches_and_anchors():
    info = build_prefab().read("LobbyTest", SKELETONS, core_clips())
    assert info["prefab"] == "LobbyTest" and info["main"] == "Test_home"
    layers = {l["name"]: l for l in info["layers"]}
    assert layers["Test_home"] == {"name": "Test_home", "x": 0.0, "y": -962.0, "scale": 1.0, "active": True,
                                   "sortingLayer": 0, "order": 0, "queue": 3000, "pages": {}, "z": 0.0, "index": 0,
                                   "skin": None, "animation": None}
    assert layers["Test_bg"]["order"] == -1 and layers["Test_bg"]["animation"] == "Idle_01"
    assert layers["Test_scene"]["active"] is False  # an inactive GameObject on the path
    pat, eye = info["drags"]
    assert pat == {"kind": "pat", "name": "HairPatIK", "skeleton": "Test_home", "bone": "Touch_Point",
                   "rect": [-109.0, 131.0, 491.0, 531.0], "rot": 0.0, "depth": -89, "enabled": True,
                   "orig": [117.45, 55.59], "min": [108.47, 10.02], "max": [126.18, 92.98], "offset": [0.0, 0.0],
                   "drag": 0.21, "release": 0.15, "delay": 0.1, "ing": "Pat_01_M", "end": "PatEnd_01_M"}
    assert eye["enabled"] is False and eye["bone"] is None and eye["ing"] is None
    (body,) = info["touches"]
    assert body["rect"] == [-307.0, -1139.0, 693.0, -139.0] and body["rot"] == 10.0 and body["depth"] == -90
    assert info["randomIdle"] == {"Test_home": ["Eye_Close_01"]} and info["idle"] == {"Test_home": "Idle_01"}
    assert info["dialog"] == {"Talk": [487.0, 29.0]}


def test_enlarged_lobby_scale_and_unknown_skeletons():
    info = build_prefab(-1106.3, 115.0).read("lobbytest", SKELETONS, core_clips())
    home = next(l for l in info["layers"] if l["name"] == "Test_home")
    assert (home["y"], home["scale"]) == (-1106.3, 1.15)
    # the pat box is in NGUI units, the bone values stay skeleton units
    assert info["drags"][0]["rect"] == [-109.0, 131.0, 491.0, 531.0] and info["drags"][0]["orig"] == [117.45, 55.59]
    # a mod with other skeleton names: the prefab places none of them
    assert build_prefab().read("LobbyTest", ["Other_home"], lobby.Clips([], ["Other_home"])) is None
    assert build_prefab().read("LobbyMissing", SKELETONS, core_clips()) is None


def param(value, override: int = 1) -> dict:
    """A volume parameter as its typetree holds it (a Vector4 as x y z w)."""
    if isinstance(value, (list, tuple)):
        value = dict(zip("xyzw", value))
    return {"m_OverrideState": override, "m_Value": value}


def color(r: float, g: float, b: float) -> dict:
    return {"m_OverrideState": 1, "m_Value": {"r": r, "g": g, "b": b, "a": 1.0}}


def component(name: str, active: int = 1, **params) -> dict:
    return {"m_Name": name, "active": active, **params}


def test_post_processing_blends_the_volumes_like_urp():
    ppv = [
        component("ChromaticAberration", intensity=param(0.075)),
        component("LiftGammaGain", lift=param([1.0, 1.0, 1.0, 0.0]), gain=param([0.98568, 1.0, 0.94948, 0.0]),
                  gamma=param([0.5, 0.5, 0.5, 0.3], override=0)),  # not overridden: stays at its default
        component("PaniniProjection", active=0, distance=param(1.0), cropToFit=param(1.0)),  # switched off
        component("DepthOfField", mode=param(1)),  # not drawn: ignored
    ]
    flash = [component("ColorAdjustments", postExposure=param(5.5), colorFilter=color(1.0, 0.81539, 0.74057))]
    volumes = [
        {"weight": 1.0, "priority": 0.0, "global": True, "active": True, "components": ppv},
        # the prefab keeps the flash volume a little on: 1.5 % of it
        {"weight": 0.015, "priority": 0.0, "global": True, "active": True, "components": flash},
        {"weight": 0.0, "priority": 0.0, "global": True, "active": True, "components": [component("DepthOfField")]},
        {"weight": 1.0, "priority": 0.0, "global": True, "active": False, "components": [
            component("ChromaticAberration", intensity=param(1.0))]},
    ]
    post = lobby.post_processing(volumes)
    assert post == {
        "chromaticAberration": 0.075,
        "liftGammaGain": {"lift": [1.0, 1.0, 1.0, 0.0], "gamma": [1.0, 1.0, 1.0, 0.0], "gain": [0.98568, 1.0, 0.94948, 0.0]},
        "colorAdjustments": {"postExposure": 0.0825, "contrast": 0.0, "colorFilter": [1.0, 0.99723, 0.99611],
                             "hueShift": 0.0, "saturation": 0.0},
    }
    assert json.loads(json.dumps(post)) == post


def test_post_processing_priority_weight_and_defaults():
    def ca(value: float, weight: float = 1.0, priority: float = 0.0) -> dict:
        return {"weight": weight, "priority": priority, "global": True, "active": True,
                "components": [component("ChromaticAberration", intensity=param(value))]}
    # the higher priority goes last whatever the hierarchy order; a partial weight lerps from what is below
    assert lobby.post_processing([ca(0.2, priority=1.0), ca(0.1)]) == {"chromaticAberration": 0.2}
    assert lobby.post_processing([ca(0.1), ca(0.3, weight=0.5)]) == {"chromaticAberration": 0.2}
    # effects that end up doing nothing are left out, as are local volumes and a Panini projection at distance 0
    assert lobby.post_processing([ca(0.0)]) == {}
    assert lobby.post_processing([{**ca(0.1), "global": False}]) == {}
    panini = {"weight": 0.368, "priority": 0.0, "global": True, "active": True,
              "components": [component("PaniniProjection", distance=param(1.0), cropToFit=param(1.0))]}
    assert lobby.post_processing([panini]) == {"panini": {"distance": 0.368, "cropToFit": 1.0}}
    assert lobby.post_processing([]) == {}


def test_prefab_volumes_follow_only_the_volumes_that_count():
    p = build_prefab()
    fields = {"m_IsGlobal": 1, "priority": 0.0, "blendDistance": 0.0}
    p.node(12, "PPV", father=1, layer=30)
    p.mb(12, 1201, 7777, weight=1.0, sharedProfile=ref(-501, 4), **fields)
    p.node(13, "PPV_C", father=12, layer=30)
    p.mb(13, 1301, 7777, weight=0.0, sharedProfile=ref(-502, 4), **fields)
    # a volume on the UI layer, which the lobby's camera never blends (Erika's, Yoshimi's)
    p.node(14, "PPV_UI", father=1, layer=5)
    p.mb(14, 1401, 7777, weight=1.0, sharedProfile=ref(-503, 4), **fields)
    profiles = {-501: [component("ChromaticAberration", intensity=param(0.1))],
                -503: [component("PaniniProjection", distance=param(1.0), cropToFit=param(1.0))]}
    asked = []

    def profile(pid, pointer):
        asked.append((pid, pointer["m_PathID"]))
        return profiles.get(pointer["m_PathID"])
    kinds = {pid: kind for pid, (kind, _) in p.objects.items()}
    info = lobby.read_prefab(kinds, lambda pid: p.objects[pid][1], SCRIPTS, "LobbyTest", SKELETONS, core_clips(), profile=profile)
    assert info["post"] == {"chromaticAberration": 0.1}
    assert asked == [(1201, -501)]  # the flash volume at weight 0 and the one on the UI layer are never followed
    # without a resolver (or without volumes) there is nothing to apply
    assert build_prefab().read("LobbyTest", SKELETONS, core_clips())["post"] == {}


def particle_system(rate: float = 5.0, subs=()) -> dict:
    const = lambda v: {"minMaxState": 0, "scalar": v, "minScalar": v}  # noqa: E731
    return {"lengthInSec": 1.0, "looping": 1, "prewarm": 0, "playOnAwake": 1, "moveWithTransform": 0, "scalingMode": 0,
            "InitialModule": {"startLifetime": const(1.0), "startSpeed": const(0.0), "startSize": const(0.5),
                              "startColor": {"minMaxState": 0, "maxColor": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
                              "maxNumParticles": 100},
            "EmissionModule": {"enabled": 1, "rateOverTime": const(rate), "m_Bursts": []},
            "SubModule": {"enabled": 1 if subs else 0,
                          "subEmitters": [{"emitter": ref(pid), "type": kind, "properties": 0, "emitProbability": 1.0}
                                          for kind, pid in subs]}}


def particle_renderer(material: int, order: int = 0, mode: int = 0, fudge: float = 0.0, layer: int = 0) -> dict:
    # layer: the sorting layer's value (the game's one other layer than Default has id 896108637 and value 2)
    return {"m_Enabled": 1, "m_RenderMode": mode, "m_SortingOrder": order, "m_SortingLayerID": 896108637 if layer else 0,
            "m_SortingLayer": layer, "m_Materials": [ref(material, 2)] if material else [], "m_Mesh": ref(0),
            "m_SortingFudge": fudge}


def test_prefab_particle_systems():
    p = build_prefab()
    # the skeletons' own materials sort them in the transparent queue: the character's atlas pages (its skeleton data's
    # atlas assets) in two queues, the background's page by the material its renderer keeps
    p.objects[302][1]["m_Materials"] = [ref(60, 2)]
    p.objects[402][1]["m_Materials"] = [ref(64, 2)]
    # a sparkler under a SkeletonUtilityBone of the character, 0.5 Unity units along the bone, turned 90 degrees
    p.node(20, "SkeletonUtility-SkeletonRoot", father=3)
    p.node(21, "FX_Hand", father=20, pos=(1.0, 2.0))
    p.mb(21, 2101, UTILITY, boneName="FX_Hand", mode=0)
    p.node(22, "FX_Loop", father=21, pos=(0.5, 0.0), rot=90.0)
    p.add(22, 2201, "ParticleSystem", particle_system(subs=[(0, 2301)]))
    p.add(22, 2202, "ParticleSystemRenderer", particle_renderer(61, order=1, fudge=50.0))
    # its birth sub-emitter, drawn with another material
    p.node(23, "Spark", father=22)
    p.add(23, 2301, "ParticleSystem", particle_system(rate=0.0))
    p.add(23, 2302, "ParticleSystemRenderer", particle_renderer(62, order=1, layer=2))
    # dust over the whole scene, in the prefab's own pose; a group parent without a material is left out, an inactive
    # system too
    p.node(24, "Dust", father=1, pos=(100.0, 50.0))
    p.add(24, 2401, "ParticleSystem", particle_system())
    p.add(24, 2402, "ParticleSystemRenderer", particle_renderer(63, order=-2))
    p.node(25, "Group", father=1)
    p.add(25, 2501, "ParticleSystem", particle_system())
    p.add(25, 2502, "ParticleSystemRenderer", particle_renderer(0))
    p.node(26, "Off", father=1, active=0)
    p.add(26, 2601, "ParticleSystem", particle_system())
    p.add(26, 2602, "ParticleSystemRenderer", particle_renderer(63))
    tex = {"id": "cab-fx_9", "name": "FX_Glow", "w": 8, "h": 8, "filter": 1, "mips": 0, "wrap": [0, 0], "srgb": 1}
    materials = {60: ("cab-sk_60", {"queue": 2900}),
                 61: ("cab-fx_61", {"program": "additive", "queue": 3100, "tex": {"_Texture": {**tex, "st": [1, 1, 0, 0]}}}),
                 62: ("cab-fx_62", {"program": "step", "queue": 3100, "tex": {"_Tex_Main": {"default": "white", "st": [1, 1, 0, 0]}}}),
                 63: ("cab-fx_63", {"program": None, "queue": 3000, "tex": {}})}
    asked = []

    pages = {(301, 9001): ("cab-core_9001", {"Test_home": 3050, "Test_home2": 2900}),
             (402, 64): ("cab-sk_64", {"Test_bg": 2950})}

    def resolve(kind, owner, pointer):
        asked.append((kind, owner, pointer["m_PathID"]))
        if kind == "pages":
            return pages.get((owner, pointer["m_PathID"]))
        return materials.get(pointer["m_PathID"]) if kind == "material" else None

    info = p.read("LobbyTest", SKELETONS, core_clips(), resolve)
    layers = {l["name"]: l for l in info["layers"]}
    home, bg = layers["Test_home"], layers["Test_bg"]
    # every atlas page with its queue, the layer's own queue the lowest of them
    assert home["pages"] == {"Test_home": 3050, "Test_home2": 2900} and home["queue"] == 2900 and home["z"] == 0.0
    assert bg["pages"] == {"Test_bg": 2950} and bg["queue"] == 2950
    # the skeleton data's pages are asked first, the renderer's materials only without them
    assert ("pages", 301, 9001) in asked and ("pages", 302, 60) not in asked and ("pages", 401, 9002) in asked
    fx = info["fx"]
    # the dust's material has no ported program, the group has none and the inactive system is not read
    assert [s["name"] for s in fx["systems"]] == ["FX_Loop", "Spark"]
    loop, spark = fx["systems"]
    assert loop["anchor"] == {"skeleton": "Test_home", "bone": "FX_Hand", "go": [100.0, 0.0, 0.0, 0.0, 0.0, 100.0, 0.0, -962.0,
                                                                              0.0, 0.0, 1.0, 0.0], "ds": 0.01}
    # placed below the bone by the transforms under it (Unity units of the bone GameObject)
    assert [round(v, 6) for v in loop["rel"]] == [0.0, -1.0, 0.0, 0.5, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    # and in the prefab's pose: (1 + 0.5, 2) Unity units on the skeleton, x 100 and 962 down
    assert loop["static"][3] == 150.0 and loop["static"][7] == -762.0
    assert (loop["material"], loop["queue"], loop["order"], loop["fudge"]) == ("cab-fx_61", 3100, 1, 50.0)
    assert spark["fudge"] == 0.0
    # the sorting layer by its value, which Unity sorts by first: the skeletons are on Default
    assert (loop["sortingLayer"], spark["sortingLayer"], home["sortingLayer"]) == (0, 2, 0)
    assert "toggle" not in loop and fx["toggles"] == []
    assert loop["subs"] == [{"type": 0, "system": 1, "inherit": 0, "p": 1.0}] and spark["isSub"] == 1
    assert spark["anchor"]["bone"] == "FX_Hand" and spark["material"] == "cab-fx_62"
    assert set(fx["materials"]) == {"cab-fx_61", "cab-fx_62"}
    assert fx["textures"] == {"cab-fx_9": tex} and fx["meshes"] == {}
    assert ("material", 2502, 0) not in asked and not any(owner == 2602 for _, owner, _ in asked)
    # without a resolver nothing draws
    assert build_prefab().read("LobbyTest", SKELETONS, core_clips())["fx"]["systems"] == []


TOGGLE = 5009
SCRIPTS[TOGGLE] = "SpineEventToggleObjects"


def test_prefab_systems_switched_by_spine_events():
    # CH0217's SpineEventToggleObjects on the character's skeleton lists fish GameObjects the prefab keeps inactive;
    # the skeleton's EnableObject / DisableObject events switch them by their index in the list
    p = build_prefab()
    p.node(30, "FX_Fish_0", father=3, active=0)
    p.node(31, "bubble", father=30)
    p.add(31, 3101, "ParticleSystem", particle_system())
    p.add(31, 3102, "ParticleSystemRenderer", particle_renderer(61))
    p.node(32, "FX_Fish_1", father=3)
    p.node(33, "bubble", father=32)
    p.add(33, 3301, "ParticleSystem", particle_system())
    p.add(33, 3302, "ParticleSystemRenderer", particle_renderer(61))
    # inactive below a toggled GameObject by another one: never shown
    p.node(34, "Off", father=30, active=0)
    p.add(34, 3401, "ParticleSystem", particle_system())
    p.add(34, 3402, "ParticleSystemRenderer", particle_renderer(61))
    # a toggled GameObject below an inactive one that no event switches: never shown either
    p.node(35, "Intro", father=3, active=0)
    p.node(36, "FX_Fish_2", father=35)
    p.add(36, 3601, "ParticleSystem", particle_system())
    p.add(36, 3602, "ParticleSystemRenderer", particle_renderer(61))
    p.mb(3, 304, TOGGLE, toggleObjects=[ref(30), ref(32), ref(36)])
    materials = {61: ("cab-fx_61", {"program": "additive", "queue": 3000, "tex": {}})}
    resolve = lambda kind, owner, pointer: materials.get(pointer["m_PathID"]) if kind == "material" else None  # noqa: E731
    fx = p.read("LobbyTest", SKELETONS, core_clips(), resolve)["fx"]
    assert fx["toggles"] == [{"skeleton": "Test_home", "on": [0, 1, 1]}]
    assert [(s["path"].split("/", 2)[-1], s.get("toggle")) for s in fx["systems"]] == [
        ("Test_home/FX_Fish_0/bubble", [[0, 0]]), ("Test_home/FX_Fish_1/bubble", [[0, 1]])]
    # without a toggle component an inactive GameObject keeps its systems out
    del p.objects[304]
    p.objects[3][1]["m_Component"] = [c for c in p.objects[3][1]["m_Component"] if c["component"]["m_PathID"] != 304]
    fx = p.read("LobbyTest", SKELETONS, core_clips(), resolve)["fx"]
    assert [s["path"].split("/", 2)[-1] for s in fx["systems"]] == ["Test_home/FX_Fish_1/bubble"] and fx["toggles"] == []


def test_lobby_info_with_and_without_prefab():
    clips = core_clips()
    info = lobby.lobby_info(SKELETONS, clips, build_prefab().read("LobbyTest", SKELETONS, clips))
    assert info["view"] == {"x": -1480.0, "y": -832.5, "w": 2960.0, "h": 1665.0}
    assert info["defaultMix"]["Test_home"] == 0.4 and "Pat_01_M" in info["clips"]["Test_home"]
    assert json.loads(json.dumps(info)) == info
    bare = lobby.lobby_info(["A_home", "A_bg", "A_home"], lobby.Clips([], []), None)
    assert bare["prefab"] is None and bare["drags"] == [] and bare["touches"] == [] and bare["post"] == {}
    assert bare["idles"] == {} and bare["sounds"] == {} and info["sounds"] == {}
    sounds = {"cab-a_1": {"name": "S", "volume": 0.7, "pitch": 1.0, "clips": ["cab-b_2"]}}
    assert lobby.lobby_info(SKELETONS, clips, None, sounds)["sounds"] == sounds
    assert bare["fx"] == {"systems": [], "materials": {}, "textures": {}, "meshes": {}, "toggles": []}
    assert [(l["name"], l["x"], l["y"], l["scale"], l["active"]) for l in bare["layers"]] == [
        ("A_home", 0.0, -962.0, 1.0, True), ("A_bg", 0.0, -962.0, 1.0, True)]


class _Game:
    resource_version = "rv"

    def __init__(self):
        self.calls = []

    def lobby_info(self, core):
        self.calls.append(core)
        return {"prefab": "LobbyTest", "core": core}

    def spine_files(self, kind, core):
        raise AssertionError("lobby.json must not extract the Spine files")


def test_lobby_json_route_is_memory_only(tmp_path):
    game = _Game()
    services = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                        cache=object(), game=game, catalog=object(), library=object())
    try:
        response = services.asset("spine/lobby/hoshino_home/lobby.json", {})
        assert json.loads(response.body) == {"prefab": "LobbyTest", "core": "hoshino_home"}
        assert response.mime == "application/json" and response.light is False
        assert game.calls == ["hoshino_home"]
    finally:
        services.close()


class _FxGame(_Game):
    def lobby_fx_texture(self, core, tex_id):
        from ba_modding_toolkit.gameassets import AssetNotFound
        self.calls.append((core, tex_id))
        if tex_id != "cab-ab_-12":
            raise AssetNotFound(tex_id)
        return b"png"

    def spine_files(self, kind, core):
        return {"fx_page.png": b"atlas page"}


def test_lobby_fx_texture_route(tmp_path):
    game = _FxGame()
    services = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                        cache=object(), game=game, catalog=object(), library=object())
    try:
        response = services.asset("spine/lobby/ch0113_home/fx_cab-ab_-12.png", {})
        assert (response.body, response.mime, response.light) == (b"png", "image/png", False)
        # a skeleton file that happens to start like one is still served
        assert services.asset("spine/lobby/ch0113_home/fx_page.png", {}).body == b"atlas page"
        assert game.calls == [("ch0113_home", "cab-ab_-12"), ("ch0113_home", "page")]
    finally:
        services.close()


class _SoundGame(_Game):
    def lobby_sound(self, core, clip_id):
        from ba_modding_toolkit.gameassets import AssetNotFound
        self.calls.append((core, clip_id))
        if clip_id != "cab-sfx_655":
            raise AssetNotFound(clip_id)
        return b"RIFF....WAVE"

    def spine_files(self, kind, core):
        return {"sfx_page.wav": b"a skeleton file"}


def test_lobby_sound_route(tmp_path):
    game = _SoundGame()
    services = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"),
                        cache=object(), game=game, catalog=object(), library=object())
    try:
        response = services.asset("spine/lobby/shigure_home/sfx_cab-sfx_655.wav", {})
        assert (response.body, response.mime, response.light) == (b"RIFF....WAVE", "audio/wav", False)
        # a file of the skeletons that happens to start like one is still served
        assert services.asset("spine/lobby/shigure_home/sfx_page.wav", {}).body == b"a skeleton file"
        assert game.calls == [("shigure_home", "cab-sfx_655"), ("shigure_home", "page")]
    finally:
        services.close()


@pytest.fixture(scope="module")
def real_game(tmp_path_factory):
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs
    root = tmp_path_factory.mktemp("lobby") / "cache"
    return GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=root, allowed=True))


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobbies(real_game, monkeypatch):
    from ba_modding_toolkit.gameassets.service import _SCHEMA
    cache, puts = real_game.cache, []
    put = cache.put

    def record(key, value, **kwargs):
        puts.append((key, kwargs.get("disk", True)))
        put(key, value, **kwargs)

    monkeypatch.setattr(cache, "put", record)
    hoshino = real_game.lobby_info("hoshino_home")
    assert hoshino["prefab"] == "LobbyHoshino" and hoshino["main"] == "Hoshino_home"
    assert {d["kind"] for d in hoshino["drags"]} >= {"pat", "look"} and hoshino["touches"]
    assert hoshino["defaultMix"]["Hoshino_home"] == 0.4
    momiji = real_game.lobby_info("momiji_home")
    assert {(l["y"], l["scale"]) for l in momiji["layers"]} == {(-1106.3, 1.15)}
    aru = {l["name"]: l["active"] for l in real_game.lobby_info("aru_home")["layers"]}
    assert aru["Aru_home"] is True and False in aru.values()
    # the camera's post-processing from the prefab's volumes (PPV at weight 1; the flash and depth of field at 0)
    assert hoshino["post"] == {
        "chromaticAberration": 0.12, "panini": {"distance": 1.0, "cropToFit": 1.0},
        "liftGammaGain": {"lift": [1.0, 1.0, 1.0, 0.0], "gamma": [1.0, 1.0, 1.0, 0.0], "gain": [1.0, 0.9116, 0.96201, 0.0]}}
    # Erika's volumes sit on the UI layer, outside the lobby camera's volume mask: no post-processing in the game
    assert real_game.lobby_info("erika_home")["post"] == {}
    # lobby data is derived from character bundles: kept in memory, and nothing but the prefab name index reaches the
    # disk cache (consent is on)
    assert sum(key.startswith(_SCHEMA + "lobby/") and not disk for key, disk in puts) == 4
    on_disk = {key for key, disk in puts if disk}
    assert on_disk == {_SCHEMA + "lobby-prefabs"}
    files = {p for p in cache.root.rglob("*") if p.is_file()}
    assert files == {cache._path(real_game.resource_version, key) for key in on_disk}


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_particles(real_game, monkeypatch):
    from ba_modding_toolkit.gameassets import AssetNotFound
    puts, put = [], real_game.cache.put

    def record(key, value, **kwargs):
        puts.append((key, kwargs.get("disk", True)))
        put(key, value, **kwargs)

    monkeypatch.setattr(real_game.cache, "put", record)
    michiru = real_game.lobby_info("ch0113_home")["fx"]
    names = {s["name"] for s in michiru["systems"]}
    assert {"glow", "Particle", "Fireworks_1", "boke_1", "dust_1"} <= names
    sparkler = [s for s in michiru["systems"] if "/FX_Hanabi/" in s["path"]]
    assert sparkler and all(s["anchor"]["bone"] == "FX_Hanabi" and s["material"] in michiru["materials"] for s in sparkler)
    programs = {m["program"] for m in michiru["materials"].values()}
    assert {"additive", "alphaBlendAdd", "step", "stepDistort", "mask"} <= programs
    # the firework sparks are meshes, spawned by their parents
    assert any(s["renderer"]["mode"] == 4 and s["renderer"]["mesh"] in michiru["meshes"] for s in michiru["systems"])
    assert any(s.get("subs") for s in michiru["systems"])
    # every texture is served from memory as PNG, and only those the lobby lists
    tex_id = next(iter(michiru["textures"]))
    assert real_game.lobby_fx_texture("ch0113_home", tex_id)[:8] == b"\x89PNG\r\n\x1a\n"
    with pytest.raises(AssetNotFound):
        real_game.lobby_fx_texture("ch0187_home", tex_id + "0")
    # game art: kept in memory only
    assert any("lobby-fx/" in key for key, _ in puts) and not any(disk for key, disk in puts if "lobby-fx/" in key)


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_particle_colour_space_layers_and_toggles(real_game):
    # Nodoka's star and meteors keep their colours as stored (Apply Active Color Space off), her other system not
    nodoka = real_game.lobby_info("nodoka_home")["fx"]["systems"]
    assert len(nodoka) == 10 and sum(s["renderer"]["colorSpace"] == 0 for s in nodoka) == 9
    # Aru's dust is on the game's other sorting layer (value 2): over her skeletons, which are on Default
    aru = real_game.lobby_info("aru_home")
    assert sorted(s["name"] for s in aru["fx"]["systems"] if s["sortingLayer"] == 2) == ["dust_00", "dust_02"]
    assert {layer["sortingLayer"] for layer in aru["layers"]} == {0}
    # CH0217: the character's Spine events switch seven GameObjects, all off in the prefab: the fish's bubbles (0 to
    # 3, from Idle_01 and BG_Loop_00_R) and the bubbles from her mouth (4 to 6, Talk_04_M and Idle_01)
    fx = real_game.lobby_info("ch0217_home")["fx"]
    assert fx["toggles"] == [{"skeleton": "CH0217_home", "on": [0] * 7}]
    assert {i for s in fx["systems"] for _, i in s.get("toggle", [])} == set(range(7))
    assert all("_Fish/" in s["path"] or "_Bubble/" in s["path"] for s in fx["systems"] if s.get("toggle"))


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_particle_modules(real_game):
    # CH0318's dust fades by its speed; CH0292's headlights emit by the distance they move
    dust = [s for s in real_game.lobby_info("ch0318_home")["fx"]["systems"] if "colorBySpeed" in s["modules"]]
    assert sorted(s["modules"]["colorBySpeed"]["range"][1] for s in dust) == [7.0, 8.0]
    assert sum(s["emission"]["dist"] > 0 for s in real_game.lobby_info("ch0292_home")["fx"]["systems"]) == 9
    # Hibiki's bokeh: bursts spread along their edges; CH0069's halo: five spread round its arc
    hibiki = real_game.lobby_info("hibiki_home")["fx"]["systems"]
    assert sum(s["shape"]["type"] == 12 and s["shape"]["radiusMode"] == 3 for s in hibiki if s["shape"]) == 10
    halo = next(s for s in real_game.lobby_info("ch0069_home")["fx"]["systems"] if (s["shape"] or {}).get("arcMode") == 3)
    assert halo["emission"]["bursts"][0]["n"] == 5.0 and halo["renderer"]["sort"] == 1


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_page_queues(real_game):
    # Hibiki's background page draws at 2900 and her own at 3050: the river surface (3000, pushed back by its sorting
    # fudge among the other effects of that queue) draws over the river, under her
    hibiki = real_game.lobby_info("hibiki_home")
    layer, = hibiki["layers"]
    assert layer["pages"] == {"Hibiki_home": 3050, "Hibiki_home2": 2900} and layer["queue"] == 2900
    river = next(s for s in hibiki["fx"]["systems"] if s["name"] == "River_surface")
    assert (river["order"], river["queue"], river["fudge"]) == (0, 3000, 50.0)
    # Kisaki (Swimsuit): the scenery at 2900, her at 3100, the mist in front of her at 3200
    kisaki, = real_game.lobby_info("ch0356_home")["layers"]
    assert kisaki["pages"] == {"CH0356_home": 3100, "CH0356_home_2": 3200, "CH0356_home_3": 2900, "CH0356_home_4": 2900}
    # every page of the atlas the web UI loads has its queue (the page's file name without its extension)
    for core, layer in (("hibiki_home", layer), ("ch0356_home", kisaki)):
        atlas = real_game.spine_files("lobby", core)[f"{layer['name']}.atlas"].decode("utf8")
        names = [line.strip()[:-4] for line in atlas.splitlines() if line.strip().lower().endswith(".png")]
        assert names and set(names) == set(layer["pages"])


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_idle_clips_and_sounds(real_game, monkeypatch):
    from ba_modding_toolkit.gameassets import AssetNotFound
    puts, put = [], real_game.cache.put

    def record(key, value, **kwargs):
        puts.append((key, kwargs.get("disk", True)))
        put(key, value, **kwargs)

    monkeypatch.setattr(real_game.cache, "put", record)
    # Shigure's idle starts her train: track 3, at random times, with the subway's sound 3.1 s in
    shigure = real_game.lobby_info("shigure_home")
    assert shigure["idles"]["Shigure_home"] == ["Idle_01"]
    assert shigure["clips"]["Shigure_home"]["Idle_01"]["sync"] == ["Train_00_R"]
    train = shigure["clips"]["Shigure_home"]["Train_00_R"]
    assert (train["track"], train["mode"], train["loop"]) == (3, 2, True)
    assert train["random"] == {"min": 10.0, "max": 15.0, "loops": [0, 0], "pre": 2, "preDelay": 3.0}
    (time, event), = train["sounds"]
    assert time == 3.1 and shigure["sounds"][event]["name"] == "SFX_Spine_Subway"
    assert shigure["sounds"][event]["volume"] == 0.7 and len(shigure["sounds"][event]["clips"]) == 1
    # Yuzu's idle pool plays two background clips besides the idle
    assert real_game.lobby_info("ch0336_home")["idles"]["CH0336_home"] == ["Idle_01", "Idle_BG_B_01_R", "Idle_Cloud_01_R"]
    # the sound, decoded in memory (WAV), and only for clips the lobby lists
    clip_id = shigure["sounds"][event]["clips"][0]
    wav = real_game.lobby_sound("shigure_home", clip_id)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE" and len(wav) > 10000
    with pytest.raises(AssetNotFound):
        real_game.lobby_sound("aru_home", clip_id)
    assert any("lobby-sound/" in key for key, _ in puts) and not any(disk for key, disk in puts if "lobby-sound/" in key)
