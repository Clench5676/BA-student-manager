"""A memorial lobby drawn in the game's order (web/js/lobby-stage.js): every skeleton's atlas pages and the particle
effects of a lobby sorted by render queue in one context. The front-end tests run with Node's test runner, skipped
where Node is not installed; a read-only check against an official game folder confirms the layers and effects those
tests take from three lobbies whose two skeletons interleave."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "lobby_stage.test.mjs"
# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_lobby_stage_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.fixture(scope="module")
def real_game(tmp_path_factory):
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs
    root = tmp_path_factory.mktemp("stage") / "cache"
    return GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=root, allowed=True))


# what lobby_stage.test.mjs takes from the game: each lobby's active layers (name, sorting order, the queue of every
# atlas page) and its effects (name, sorting order, render queue, sorting fudge)
LOBBIES = {
    "wakamo_home": (
        [("Wakamo_home", 0, {"Wakamo_home": 3050, "Wakamo_home2": 2900}),
         ("Wakamo_Scene_0", 0, {"Wakamo_Scene_0": 3050, "Wakamo_Scene_02": 3150, "Wakamo_Scene_03": 2900,
                                "Wakamo_Scene_04": 2800})],
        {("particle_back", 0, 3000, 0.0), ("particle_center", 0, 3000, 0.0), ("fire1", 0, 3000, -34.5),
         ("fire2", 0, 3100, -34.5), ("particle_front", 0, 3000, 0.0), ("fire3", 0, 3100, -34.5)},
    ),
    "ch0184_home": (
        [("CH0184_home", 0, {"CH0184_home": 3050, "CH0184_home2": 2900, "CH0184_home3": 2850}),
         ("CH0184_00", 0, {"CH0184_00": 3050, "CH0184_002": 2900})],
        {("boke_3_F", 0, 3002, 0.0), ("boke_5_F_R", 1, 3002, 0.0), ("boke_6", 1, 3002, 0.0), ("B_boke_2", 0, 3002, 0.0),
         ("B_boke_1", 0, 3002, 0.0), ("dust_2", 0, 2950, 0.0), ("dust_3", 0, 2950, 0.0)},
    ),
    "shigure_home": (
        [("Shigure_home", 0, {"Shigure_home": 2900, "Shigure_home2": 3050}),
         ("Shigure_00", 0, {"Shigure_00": 2900}), ("Shigure_01", 0, {"Shigure_01": 2900})],
        {("boke_3", 0, 3002, 0.0), ("boke_4", 0, 3002, 0.0), ("boke_5", 0, 3002, 0.0), ("boke_6", 0, 3002, 0.0),
         ("Y_boke_9", 1, 3002, 0.0), ("F_boke_7", 1, 3002, 0.0), ("F_boke_8", 1, 3002, 0.0)},
    ),
}


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
@pytest.mark.parametrize("core", sorted(LOBBIES))
def test_real_lobbies_whose_skeletons_interleave(real_game, core):
    layers, systems = LOBBIES[core]
    info = real_game.lobby_info(core)
    active = [layer for layer in info["layers"] if layer["active"]]
    assert [(layer["name"], layer["order"], layer["pages"]) for layer in active] == layers
    assert {(s["name"], s["order"], s["queue"], s["fudge"]) for s in info["fx"]["systems"]} == systems
    # effects of order 0 sort between two pages of the bottom skeleton (the character's page above them) and above a
    # page of the second skeleton: one canvas per skeleton cannot draw that
    bottom, second = (list(layer["pages"].values()) for layer in active[:2])
    between = [s for s in info["fx"]["systems"] if s["order"] == 0 and min(bottom) < s["queue"] < max(bottom)]
    assert between and all(s["queue"] > min(second) for s in between)
