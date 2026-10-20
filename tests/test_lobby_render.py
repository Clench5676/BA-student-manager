"""The memorial lobbies' plain mesh renderers and their Animators (meshfx.py), from plain typetrees; their front end in
Node; and, on an official game folder, what the lobbies carry."""

from __future__ import annotations

import os
import shutil
import subprocess
import zlib
from pathlib import Path

import pytest

from ba_modding_toolkit.gameassets import meshfx, particles
from ba_modding_toolkit.gameassets.model import DecodedClip

GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_front_end_in_node():
    tests = Path(__file__).parent / "js" / "lobby_render.test.mjs"
    result = subprocess.run([NODE, "--test", str(tests)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


# --- prefab nodes as lobby.read_prefab walks them -------------------------------------------------------------------

def node(go: int, name: str, parent: int = 0, pos=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), active=True, **comps) -> dict:
    t = {"m_LocalPosition": dict(zip("xyz", pos)), "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
         "m_LocalScale": dict(zip("xyz", scale))}
    pids = {cls: go * 10 + i for i, cls in enumerate(comps)}
    return {"go": go, "name": name, "parent": parent, "active": active, "t": t, "local3": particles.trs(t),
            "first": dict(comps), "pids": pids, "path": name}


def walk(nodes: list[dict]) -> list[dict]:
    by = {n["go"]: n for n in nodes}
    for n in nodes:
        parent = by.get(n["parent"])
        n["m3"] = particles.mul(parent["m3"], n["local3"]) if parent else n["local3"]
        n["path"] = f"{parent['path']}/{n['name']}" if parent else n["name"]
    return nodes


def lens_prefab() -> list[dict]:
    """A skeleton at (0, -962) x 100 with a bone GameObject (Follow), a lens-dirt quad below it under an Animator, and
    a light quad off the prefab root."""
    return walk([
        node(1, "LobbyTest"),
        node(2, "Test_home", 1, pos=(0.0, -962.0, 0.0), scale=(100.0, 100.0, 100.0), SkeletonAnimation={}),
        node(3, "All_Layer", 2, SkeletonUtilityBone={"boneName": "All_Layer", "mode": 0}),
        node(4, "LensDirt", 3, Animator={"m_Enabled": 1, "m_Controller": {"m_FileID": 1, "m_PathID": 77}}),
        node(5, "LensDirt_01", 4, pos=(10.0, 14.0, 0.0), scale=(14.0, 13.5, 13.5),
             MeshRenderer={"m_Enabled": 1, "m_SortingOrder": 0, "m_Materials": [{"m_FileID": 1, "m_PathID": 50}]},
             MeshFilter={"m_Mesh": {"m_FileID": 3, "m_PathID": 10210}}),
        node(6, "Quad_1", 1, pos=(-1404.0, -121.0, 0.0), scale=(1827.0, 3160.0, 30.0),
             MeshRenderer={"m_Enabled": 1, "m_Materials": [{"m_FileID": 1, "m_PathID": 51}]},
             MeshFilter={"m_Mesh": {"m_FileID": 3, "m_PathID": 10210}}),
        node(7, "Off", 1, active=False, MeshRenderer={"m_Enabled": 1, "m_Materials": [{"m_FileID": 1, "m_PathID": 51}]},
             MeshFilter={"m_Mesh": {"m_FileID": 3, "m_PathID": 10210}}),
    ])


def lens_material(colors: dict) -> dict:
    return {"shader": "FX/FX_SHADER_Lobby_Order", "program": particles.program("FX/FX_SHADER_Lobby_Order"), "src": 1, "dst": 1,
            "queue": 2950, "cull": 2, "floats": {}, "colors": colors,
            "tex": {"_TextureSample0": {"id": "cab-t_1", "name": "Lensdirt", "w": 4, "h": 4, "st": [1.0, 1.0, 0.0, 0.0]}}}


def binding(path: str, type_id: int, attribute: int, custom: int = 0) -> dict:
    return {"path": zlib.crc32(path.encode()) & 0xFFFFFFFF, "typeID": type_id, "attribute": attribute, "customType": custom,
            "isPPtrCurve": 0}


def material_attribute(prop: str, channel: int, rgba: bool) -> int:
    return (zlib.crc32(prop.encode()) & 0x0FFFFFFF) | (channel << 28) | (int(rgba) << 30)


def test_mesh_renderers_and_their_animator():
    nodes = lens_prefab()
    decoded = DecodedClip(2.0, [0.0, 1.0, 2.0], {0: [14.0, 28.0, 14.0], 1: [13.5, 27.0, 13.5], 2: [13.5], 3: [0.5, 1.0, 0.5],
                                                 4: [0.25], 5: [0.0], 6: [1.0]})
    bindings = [binding("LensDirt_01", 4, 3),  # scale: 3 curves
                binding("LensDirt_01", 23, material_attribute("_Color0", 0, True), 22),  # material _Color0.r
                binding("LensDirt_01", 23, material_attribute("_Color0", 1, False), 22),  # material _Color0.y
                binding("Missing", 4, 1, 0),  # a path below the Animator that is not there: 3 curves left out
                ]
    materials = {50: ("cab-m_50", lens_material({"_Color0": [1.0, 1.0, 1.0, 0.0]})), 51: ("cab-m_51", lens_material({}))}

    def resolve(kind: str, owner: int, pointer: dict):
        if kind == "material":
            return materials.get(pointer["m_PathID"])
        if kind == "mesh":
            return ("quad", None) if pointer["m_PathID"] == 10210 else None
        if kind == "animator":
            return ("cab-c_77", {"decoded": decoded, "bindings": bindings, "loop": True})
        return None

    out = meshfx.build(nodes, lambda go: "Test_home" if go == 2 else None, lambda skel: 0.01, resolve)
    lens, light = out["renderers"]
    assert lens["mesh"] == "quad" and lens["material"] == "cab-m_50" and lens["queue"] == 2950
    # under the bone GameObject: anchored on the bone, placed by the transforms below it
    assert lens["anchor"] == {"skeleton": "Test_home", "bone": "All_Layer", "go": particles.rounded(nodes[1]["m3"]), "ds": 0.01}
    assert [c["node"] for c in lens["chain"]] == [3, 4] and lens["chain"][1]["s"] == [14.0, 13.5, 13.5]
    # off the root: no anchor, the chain from the root; the inactive quad is left out
    assert light["anchor"] is None and [c["node"] for c in light["chain"]] == [0, 5]
    assert set(out["materials"]) == {"cab-m_50", "cab-m_51"} and out["textures"] == {"cab-t_1": {"id": "cab-t_1", "name": "Lensdirt", "w": 4, "h": 4}}
    assert out["meshes"] == {}  # the built-in Quad is built by the front end
    (clip,) = out["clips"]
    assert (clip["duration"], clip["rate"], clip["loop"]) == (2.0, 1.0, 1)
    scale, red, y = clip["tracks"]
    assert scale == {"node": 4, "attr": "s", "v": [[14.0, 13.5, 13.5], [28.0, 27.0, 13.5], [14.0, 13.5, 13.5]]}
    assert red == {"renderer": 0, "prop": "_Color0", "ch": 0, "rgba": 1, "v": [0.5, 1.0, 0.5]}
    assert y == {"renderer": 0, "prop": "_Color0", "ch": 1, "rgba": 0, "v": [0.25]}
    assert meshfx.material_property(material_attribute("_Color0", 3, True), ["_Color", "_Color0"]) == ("_Color0", 3, 1)
    assert meshfx.material_property(1234, ["_Color"]) is None
    # nothing to resolve with: nothing drawn
    assert meshfx.build(nodes, lambda go: None, lambda skel: 0.01, None)["renderers"] == []


# --- the official game folder -----------------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def real_game(tmp_path_factory):
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs
    root = tmp_path_factory.mktemp("lobby-render") / "cache"
    return GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=root, allowed=False))


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_mesh_renderers(real_game):
    counts = {"akane_home": 4, "eimi_home": 2, "karin_home": 2, "shiroko_home": 2, "sumire_home": 2, "shun_home": 4,
              "hanako_home": 1, "maki_home": 2, "utaha_home": 1}
    for core, n in counts.items():
        fx = real_game.lobby_info(core)["fx"]
        assert len(fx["renderers"]) == n, core
        for r in fx["renderers"]:
            mat = fx["materials"][r["material"]]
            assert mat["program"] in {"lobbyOrder", "additive", "distort"} and (r["mesh"] == "quad" or r["mesh"] in fx["meshes"])
    akane = real_game.lobby_info("akane_home")["fx"]
    # the lens dirt and its light between her page (2800) and the light shafts over everything (3100)
    assert sorted((r["path"].rsplit("/", 2)[-2], r["name"], r["queue"]) for r in akane["renderers"]) == [
        ("LensDirt", "LensDirt_02", 2950), ("LensDirt", "Quad_2", 2950), ("Quad_f", "Quad_1", 3100), ("Quad_f", "Quad_2", 3100)]
    tracks = [t for c in akane["clips"] for t in c["tracks"]]
    assert {t.get("attr") or t["prop"] for t in tracks} == {"s", "_Color0"} and all(len(c["tracks"][0]["v"]) == 201 for c in akane["clips"])
    hanako = real_game.lobby_info("hanako_home")["fx"]["renderers"][0]
    assert hanako["name"] == "water" and hanako["anchor"]["bone"] == "All_Layer"
