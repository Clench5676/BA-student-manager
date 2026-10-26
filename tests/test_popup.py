"""The shared popups (web/js/popup.js) and the update popup (web/js/update.js) are front-end code: their tests run with
Node's test runner on a stand-in DOM, skipped where Node is not installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "popup.test.mjs"


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_popup_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_photo_delete_confirmation_uses_official_popup_geometry(request, tmp_path):
    if not request.config.pluginmanager.hasplugin("bamt_dev.testing"):
        pytest.skip("Requires the official development view (-p bamt_dev.testing)")
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.gameassets.layouts import subtree

    official = request.getfixturevalue("official_game")
    official.require_layout("UIPopup_Sort")
    cache = AssetCache(root=tmp_path / "memory-only", allowed=False)
    tree = GameAssets(official.resource_dirs, cache).layout("UIPopup_Sort")
    background = subtree(tree, "Center/Popup/Base/BG")
    sprite = next(w for w in background["widgets"] if "sprite" in w)
    assert background["pos"] == [0, 8]
    assert [sprite[k] for k in ("sprite", "w_", "h_", "pivot")] == ["Common_Popup_Bg", 2458, 1355, 4]
    for name, x in [("Btn_Ok", 292), ("Btn_Cancel", -292)]:
        button = subtree(tree, f"Center/Popup/Btn/{name}")
        body = subtree(button, "BG (1)")
        sprite = next(w for w in body["widgets"] if "sprite" in w)
        assert button["pos"] == [x, 0] and body["pos"] == [0, -4]
        assert [sprite[k] for k in ("sprite", "w_", "h_", "pivot")] == ["Common_Btn_BG", 496, 177, 4]
    assert not cache.root.exists()
