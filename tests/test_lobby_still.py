"""Optional verified-asset check for the memorial lobby still camera."""
import os

import pytest


@pytest.mark.skipif(not os.environ.get("BAMT_TEST_GAME_DIR"),
                    reason="Optional verified-asset check: set BAMT_TEST_GAME_DIR to an isolated verified copy")
def test_verified_ui_lobby_camera_matches_still_coordinates(tmp_path):
    from pathlib import Path
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs

    root = Path(os.environ.get("BAMT_TEST_GAME_DIR", "/nonexistent/verified-view"))
    if not root.is_dir():
        pytest.skip("Verified game view not supplied")
    game = GameAssets(get_search_dirs(root), AssetCache(root=tmp_path / "cache"))
    info = game.lobby_info("ch0169_home")
    assert info["main"] == "CH0169_home"
    assert info["view"] == {"x": -1480, "y": -832.5, "w": 2960, "h": 1665}
    layer, = [layer for layer in info["layers"] if layer["name"] == info["main"]]
    assert {k: layer[k] for k in ("x", "y", "scale")} == {"x": 0, "y": -962, "scale": 1}
