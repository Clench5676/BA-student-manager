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

GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR", str(
    Path.home() / "Library/Application Support/Blue Archive/Game")))

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
             active: int = 1) -> int:
        tf = go + 100000
        half = math.radians(rot) / 2
        self.objects[go] = ("GameObject", {"m_Name": name, "m_IsActive": active, "m_Component": [{"component": ref(tf)}]})
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

    def read(self, root: str, skeletons, clips):
        kinds = {pid: kind for pid, (kind, _) in self.objects.items()}
        return lobby.read_prefab(kinds, lambda pid: self.objects[pid][1], SCRIPTS, root, skeletons, clips)


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
                                "next": None, "sync": ["Pat_01_A"], "block": False, "random": None}
    assert home["Pat_01_A"]["intro"] == 0.0 and home["PatEnd_01_M"]["outro"] == 0.3
    assert home["Pat_02_M"]["finish"] == 3 and home["Pat_02_M"]["next"] == "Pat_01_M"
    assert home["Eye_Close_01"]["random"] == {"min": 8.0, "max": 15.0, "loops": [0, 1]}
    assert clips.anim(ref(8002, 3)) == "PatEnd_01_M" and clips.anim(ref(0)) is None


def test_prefab_layout_drags_touches_and_anchors():
    info = build_prefab().read("LobbyTest", SKELETONS, core_clips())
    assert info["prefab"] == "LobbyTest" and info["main"] == "Test_home"
    layers = {l["name"]: l for l in info["layers"]}
    assert layers["Test_home"] == {"name": "Test_home", "x": 0.0, "y": -962.0, "scale": 1.0, "active": True,
                                   "order": 0, "index": 0, "skin": None, "animation": None}
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
    p.node(12, "PPV", father=1)
    p.mb(12, 1201, 7777, weight=1.0, sharedProfile=ref(-501, 4), **fields)
    p.node(13, "PPV_C", father=12)
    p.mb(13, 1301, 7777, weight=0.0, sharedProfile=ref(-502, 4), **fields)
    profiles = {-501: [component("ChromaticAberration", intensity=param(0.1))]}
    asked = []

    def profile(pid, pointer):
        asked.append((pid, pointer["m_PathID"]))
        return profiles.get(pointer["m_PathID"])
    kinds = {pid: kind for pid, (kind, _) in p.objects.items()}
    info = lobby.read_prefab(kinds, lambda pid: p.objects[pid][1], SCRIPTS, "LobbyTest", SKELETONS, core_clips(), profile)
    assert info["post"] == {"chromaticAberration": 0.1}
    assert asked == [(1201, -501)]  # the flash volume at weight 0 is never followed
    # without a resolver (or without volumes) there is nothing to apply
    assert build_prefab().read("LobbyTest", SKELETONS, core_clips())["post"] == {}


def test_lobby_info_with_and_without_prefab():
    clips = core_clips()
    info = lobby.lobby_info(SKELETONS, clips, build_prefab().read("LobbyTest", SKELETONS, clips))
    assert info["view"] == {"x": -1480.0, "y": -832.5, "w": 2960.0, "h": 1665.0}
    assert info["defaultMix"]["Test_home"] == 0.4 and "Pat_01_M" in info["clips"]["Test_home"]
    assert json.loads(json.dumps(info)) == info
    bare = lobby.lobby_info(["A_home", "A_bg", "A_home"], lobby.Clips([], []), None)
    assert bare["prefab"] is None and bare["drags"] == [] and bare["touches"] == [] and bare["post"] == {}
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
    # lobby data is derived from character bundles: kept in memory, and nothing but the prefab name index reaches the
    # disk cache (consent is on)
    assert sum(key.startswith(_SCHEMA + "lobby/") and not disk for key, disk in puts) == 3
    on_disk = {key for key, disk in puts if disk}
    assert on_disk == {_SCHEMA + "lobby-prefabs"}
    files = {p for p in cache.root.rglob("*") if p.is_file()}
    assert files == {cache._path(real_game.resource_version, key) for key in on_disk}
