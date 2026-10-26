"""The portrait's visual mode (web/js/visual-view.js, visual-mode.js): its framing runs with Node's test runner,
skipped where Node is not installed; the prefab it draws is checked against a real install when one is found."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.gameassets import service
from ba_modding_toolkit.gameassets.discovery import is_prefab
from ba_modding_toolkit.gameassets.layouts import export_layout, subtree
from ba_modding_toolkit.gameassets.unity import open_bundle
from ba_modding_toolkit.searching import get_search_dirs

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "visual_view.test.mjs"
MODE_TESTS = Path(__file__).parent / "js" / "visual_mode.test.mjs"
# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_visual_view_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_visual_mode_leaving_in_node():
    """The detail screen's UI is out of the keyboard's reach while a fullscreen view is open, and leaving fullscreen
    always closes the visual mode (visual-mode.js uiOut, uiBack)."""
    result = subprocess.run([NODE, "--test", str(MODE_TESTS)], capture_output=True, text=True, timeout=120)
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


@pytest.mark.skipif(NODE is None or not GAME_DIR.is_dir(), reason="Node.js and an official game view are required")
def test_real_fullscreen_control_geometry(tmp_path):
    game = GameAssets(get_search_dirs(GAME_DIR), AssetCache(root=tmp_path / "cache", allowed=True))
    fixture_module = (TESTS.parent / "visual_prefabs.mjs").as_uri()
    result = subprocess.run(
        [NODE, "--input-type=module", "-e",
         f"import {{visualPrefab}} from {json.dumps(fixture_module)}; console.log(JSON.stringify(visualPrefab()));"],
        capture_output=True, text=True, check=True, timeout=30,
    )
    fixture = subtree(json.loads(result.stdout), "Inventory_ListControl_PC")
    with open_bundle(game._prefab_bundle("UICharacterVisualMode")) as env:
        pc = subtree(export_layout(env, "UICharacterVisualMode", {}), "Inventory_ListControl_PC")
        for corner, names in (("LeftTop", ("Btn_Back",)), ("RightTop", ("Btn_HideUI", "Btn_ShowUI")),
                              ("RightBottom", ("Btn_RefreshPos", "Btn_RefreshPos_Disable"))):
            actual_corner, expected_corner = subtree(pc, corner), subtree(fixture, corner)
            assert actual_corner["pos"] == expected_corner["pos"]
            actual_widget = next(w for w in actual_corner["widgets"] if w.get("anchors"))
            assert {k: actual_widget[k] for k in expected_corner["widgets"][0]} == expected_corner["widgets"][0]
            for name in names:
                for suffix in ("", "/Icon"):
                    path = f"{corner}/{name}{suffix}"
                    actual, expected = subtree(pc, path), subtree(fixture, path)
                    assert actual["pos"] == expected["pos"], path
                    assert actual["scale"] == expected["scale"], path
                    aw = next(w for w in actual["widgets"] if "sprite" in w)
                    ew = next(w for w in expected["widgets"] if "sprite" in w)
                    for key in ("sprite", "w_", "h_", "pivot"):
                        assert aw[key] == ew[key], (path, key)
        names = {obj.path_id: obj.read().m_Name for obj in env.objects if obj.type.name == "GameObject"}
        colliders = {}
        for obj in env.objects:
            if obj.type.name != "BoxCollider":
                continue
            tree = obj.read_typetree()
            name = names.get(tree["m_GameObject"]["m_PathID"])
            if name in ("Btn_Back", "Btn_HideUI", "Btn_ShowUI", "Btn_RefreshPos"):
                expected = (228.83, 195.2, 32) if name == "Btn_RefreshPos" else (228.83, 165, 0)
                assert (tree["m_Size"]["x"], tree["m_Size"]["y"], tree["m_Center"]["y"]) == pytest.approx(expected)
                colliders[name] = True
        assert set(colliders) == {"Btn_Back", "Btn_HideUI", "Btn_ShowUI", "Btn_RefreshPos"}
