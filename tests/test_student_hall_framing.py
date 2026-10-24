"""The ordinary lobby portrait baseline is read from the game's authored transforms, never image bounds."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.gameassets.layouts import export_layout, subtree
from ba_modding_toolkit.gameassets.office import BACKGROUNDS
from ba_modding_toolkit.gameassets.unity import open_bundle
from ba_modding_toolkit.searching import get_search_dirs

GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No verified game view")
def test_ordinary_day_and_night_share_the_authored_portrait_transform(tmp_path):
    game = GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=tmp_path / "cache", allowed=False))
    for root, _, _, bundle in BACKGROUNDS.values():
        with open_bundle(game._bundle_path(bundle)) as env:
            tree = export_layout(env, root, {})
        assert tree["pos"] == [0, 0]
        assert tree["scale"] == [1, 1]
        parent = subtree(tree, "TweenController")
        assert parent["pos"] == [0, 0]
        assert parent["scale"] == [1, 1]
        character = subtree(tree, "TweenController/CharPos")
        assert character["pos"] == [-112, -886]
        assert character["scale"] == [111, 111]


def test_hall_projection_geometry_in_node():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is not installed")
    test = Path(__file__).parent / "js" / "student_hall_framing.test.mjs"
    result = subprocess.run([node, "--test", str(test)], text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
