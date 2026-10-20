"""The lobby's slot colours as each atlas page's shader takes them (web/js/slot-colours.js): its Node tests, and on an
official game folder (BAMT_TEST_GAME_DIR) the page shaders lobby.json names and the shaders' compiled vertex programs,
which say how each one takes the vertex colour."""

from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
ROOT = Path(__file__).parent
MODULE = ROOT.parent / "src" / "ba_modding_toolkit" / "web" / "js" / "slot-colours.js"
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
# the constants of the two gamma-to-linear conversions as float32 immediates in a D3D11 program: UnityCG's
# GammaToLinearSpace (a cubic, spine-unity's PMAGammaToTargetSpace) and the exact sRGB curve's linear part (1 / 12.92)
CUBIC = struct.pack("<f", 0.305306011)
SRGB = struct.pack("<f", 1 / 12.92)


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_slot_colours_in_node():
    result = subprocess.run([NODE, "--test", str(ROOT / "js" / "slot_colours.test.mjs")], capture_output=True, text=True,
                            timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def _table() -> dict[str, str]:
    """slot-colours.js's shaders and their curves (exact, cubic, asIs)."""
    block = re.search(r"BY_SHADER = Object\.freeze\(\{(.*?)\}\)", MODULE.read_text(encoding="utf-8"), re.S).group(1)
    return dict(re.findall(r'"([^"]+)":\s*(\w+)', block))


def _vertex_programs(shader) -> list[bytes]:
    """The D3D11 vertex programs of every variant of a shader's first pass (its colour pass), read in memory."""
    from UnityPy.helpers import CompressionHelper

    tt = shader.read_typetree()
    plat = list(tt["platforms"]).index(4)  # GfxDevice d3d11
    blob = bytes(tt["compressedBlob"])
    parts = zip(*(tt[k][plat] for k in ("offsets", "compressedLengths", "decompressedLengths")))
    segments = [CompressionHelper.decompress_lz4(blob[o:o + c], d) for o, c, d in parts]
    count = struct.unpack_from("<i", segments[0], 0)[0]
    blobs = []
    for i in range(count):
        off, length, seg = struct.unpack_from("<III", segments[0], 4 + 12 * i)
        blobs.append(segments[seg][off:off + length])
    prog = tt["m_ParsedForm"]["m_SubShaders"][0]["m_Passes"][0]["progVertex"]
    return [blobs[sp["m_BlobIndex"]] for row in prog["m_PlayerSubPrograms"] for sp in row]


@pytest.fixture(scope="module")
def lobby_shaders():
    """{shader name: its vertex programs} for the Spine shaders of the game's shader and spine-unity bundles."""
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    import UnityPy

    from ba_modding_toolkit.searching import get_search_dirs

    out: dict[str, list[bytes]] = {}
    for folder in get_search_dirs(GAME_DIR):
        for bundle in sorted(Path(folder).glob("*.bundle")):
            if "shader" not in bundle.name and "spine-runtime" not in bundle.name:
                continue
            for obj in UnityPy.load(str(bundle)).objects:
                if obj.type.name == "Shader":
                    name = obj.read_typetree()["m_ParsedForm"]["m_Name"]
                    if name.startswith("Spine/") and name not in out:
                        out[name] = _vertex_programs(obj)
    return out


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_vertex_programs_match_the_curves(lobby_shaders):
    def has(name: str, const: bytes) -> list[bool]:
        programs = lobby_shaders[name]
        assert programs, name
        return [const in p for p in programs]

    # spine-unity's own shaders decode the vertex colour with UnityCG's cubic, MX Portrait with the sRGB curve
    assert all(has("Spine/Skeleton", CUBIC)) and all(has("Spine/Blend Modes/Skeleton PMA Multiply", CUBIC))
    assert all(has("Spine/Skeleton MX Portrait", SRGB))
    # MX Standard (97 lobbies' pages) and its noise flow variant pass the colour on as it is: no curve at all
    as_is = {name for name, curve in _table().items() if curve == "asIs"}
    assert as_is == {"Spine/Skeleton MX Standard", "Spine/Skeleton MX Standard - NoiseFlowAnimation"}
    for name in as_is:
        assert not any(has(name, CUBIC)) and not any(has(name, SRGB)), name


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_lobby_page_shaders(tmp_path):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs

    game = GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=tmp_path / "cache", allowed=False))
    # Takane's pages are all on MX Standard (her aurora: additive slots faded by their alpha), Hoshino's on
    # spine-unity's Spine/Skeleton
    takane, = game.lobby_info("ch0229_home")["layers"]
    assert takane["shaders"] == {page: "Spine/Skeleton MX Standard" for page in ("CH0229_home", "CH0229_home_2", "CH0229_home_3")}
    hoshino = game.lobby_info("hoshino_home")["layers"]
    assert {shader for layer in hoshino for shader in layer["shaders"].values()} == {"Spine/Skeleton"}
    # every page with a queue has its shader, named as the atlas the web UI loads names it
    for layer in (takane, *hoshino):
        assert layer["shaders"] and set(layer["shaders"]) == set(layer["pages"])
