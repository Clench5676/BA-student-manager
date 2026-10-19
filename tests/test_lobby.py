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

    def read(self, root: str, skeletons, clips, resolve=None):
        kinds = {pid: kind for pid, (kind, _) in self.objects.items()}
        return lobby.read_prefab(kinds, lambda pid: self.objects[pid][1], SCRIPTS, root, skeletons, clips, resolve)


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
                                   "order": 0, "queue": 3000, "z": 0.0, "index": 0, "skin": None, "animation": None}
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


def particle_renderer(material: int, order: int = 0, mode: int = 0) -> dict:
    return {"m_Enabled": 1, "m_RenderMode": mode, "m_SortingOrder": order, "m_SortingLayerID": 0,
            "m_Materials": [ref(material, 2)] if material else [], "m_Mesh": ref(0)}


def test_prefab_particle_systems():
    p = build_prefab()
    # the skeleton's own material sorts it in the transparent queue
    p.objects[302][1]["m_Materials"] = [ref(60, 2)]
    # a sparkler under a SkeletonUtilityBone of the character, 0.5 Unity units along the bone, turned 90 degrees
    p.node(20, "SkeletonUtility-SkeletonRoot", father=3)
    p.node(21, "FX_Hand", father=20, pos=(1.0, 2.0))
    p.mb(21, 2101, UTILITY, boneName="FX_Hand", mode=0)
    p.node(22, "FX_Loop", father=21, pos=(0.5, 0.0), rot=90.0)
    p.add(22, 2201, "ParticleSystem", particle_system(subs=[(0, 2301)]))
    p.add(22, 2202, "ParticleSystemRenderer", particle_renderer(61, order=1))
    # its birth sub-emitter, drawn with another material
    p.node(23, "Spark", father=22)
    p.add(23, 2301, "ParticleSystem", particle_system(rate=0.0))
    p.add(23, 2302, "ParticleSystemRenderer", particle_renderer(62, order=1))
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

    def resolve(kind, owner, pointer):
        asked.append((kind, owner, pointer["m_PathID"]))
        return materials.get(pointer["m_PathID"]) if kind == "material" else None

    info = p.read("LobbyTest", SKELETONS, core_clips(), resolve)
    home = next(l for l in info["layers"] if l["name"] == "Test_home")
    assert home["queue"] == 2900 and home["z"] == 0.0
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
    assert (loop["material"], loop["queue"], loop["order"]) == ("cab-fx_61", 3100, 1)
    assert loop["subs"] == [{"type": 0, "system": 1, "inherit": 0, "p": 1.0}] and spark["isSub"] == 1
    assert spark["anchor"]["bone"] == "FX_Hand" and spark["material"] == "cab-fx_62"
    assert set(fx["materials"]) == {"cab-fx_61", "cab-fx_62"}
    assert fx["textures"] == {"cab-fx_9": tex} and fx["meshes"] == {}
    assert ("material", 2502, 0) not in asked and not any(owner == 2602 for _, owner, _ in asked)
    # without a resolver nothing draws
    assert build_prefab().read("LobbyTest", SKELETONS, core_clips())["fx"]["systems"] == []


def test_lobby_info_with_and_without_prefab():
    clips = core_clips()
    info = lobby.lobby_info(SKELETONS, clips, build_prefab().read("LobbyTest", SKELETONS, clips))
    assert info["view"] == {"x": -1480.0, "y": -832.5, "w": 2960.0, "h": 1665.0}
    assert info["defaultMix"]["Test_home"] == 0.4 and "Pat_01_M" in info["clips"]["Test_home"]
    assert json.loads(json.dumps(info)) == info
    bare = lobby.lobby_info(["A_home", "A_bg", "A_home"], lobby.Clips([], []), None)
    assert bare["prefab"] is None and bare["drags"] == [] and bare["touches"] == []
    assert bare["fx"] == {"systems": [], "materials": {}, "textures": {}, "meshes": {}}
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
    # lobby data is derived from character bundles: kept in memory, and nothing but the prefab name index reaches the
    # disk cache (consent is on)
    assert sum(key.startswith(_SCHEMA + "lobby/") and not disk for key, disk in puts) == 3
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
