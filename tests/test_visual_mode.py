"""The portrait's visual mode (web/js/visual-view.js, visual-mode.js): its framing runs with Node's test runner,
skipped where Node is not installed; the prefab it draws is checked against a real install when one is found."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.gameassets import service
from ba_modding_toolkit.gameassets.discovery import is_prefab
from ba_modding_toolkit.gameassets.layouts import subtree
from ba_modding_toolkit.searching import get_search_dirs

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "visual_view.test.mjs"
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR", str(
    Path.home() / "Library/Application Support/Blue Archive/Game")))


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_visual_view_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_visual_mode_prefab_hint():
    assert is_prefab(Path(service.PREFAB_HINTS["UICharacterVisualMode"]))


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")
def test_real_visual_mode_layout(tmp_path):
    game = GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=tmp_path / "cache", allowed=True))
    pc = game.layout("UICharacterVisualMode", "Inventory_ListControl_PC")
    # the background and its two breathing light patterns
    bg = subtree(pc, "BG")
    assert any(w.get("cls") == "UITexture" for w in bg["widgets"])
    for name in ("Bg_Pt_1", "Bg_Pt_2"):
        assert any(str(w.get("texture", "")).startswith("UITex_BGPoliLight") for w in subtree(bg, name)["widgets"])
    # the corners the buttons hang on are anchored to the screen's edges
    for corner, buttons in (("LeftTop", ["Btn_Back"]), ("RightTop", ["Btn_HideUI", "Btn_ShowUI"]),
                            ("RightBottom", ["Btn_RefreshPos", "Btn_RefreshPos_Disable"])):
        node = subtree(pc, corner)
        anchors = next(w["anchors"] for w in node["widgets"] if w.get("anchors"))
        assert set(anchors) == {"leftAnchor", "rightAnchor", "bottomAnchor", "topAnchor"}
        for button in buttons:
            subtree(node, button)
    # the reset button's label and the shown art's scale (half the detail screen's)
    label = subtree(pc, "RightBottom/Btn_RefreshPos/Label_Locale_Reset")
    assert any("text" in w for w in label["widgets"])
    assert subtree(pc, "Character/CharacterPos")["scale"] == [50.0, 50.0]
