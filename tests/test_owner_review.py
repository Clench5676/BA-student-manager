"""Owner review regressions for prefab metadata and verified camera geometry."""
from types import SimpleNamespace

from ba_modding_toolkit.gameassets.layouts import _widget


def test_prefab_pin_gradient_is_exported_without_changing_its_white_tint():
    obj = SimpleNamespace(assets_file=SimpleNamespace(name="fixture", externals=[]))
    tree = {"m_Script": {}, "mAtlas": {}, "mSpriteName": "Common_Icon_Pin_Detail", "mType": 1,
            "mFlip": 0, "mApplyGradient": 1, "mGradientTop": {"r": 1., "g": .5, "b": 0., "a": 1.},
            "mGradientBottom": {"r": .8, "g": .3, "b": 0., "a": 1.},
            "mColor": {"r": 1., "g": 1., "b": 1., "a": 1.}, "mWidth": 38, "mHeight": 38}
    widget = _widget(obj, tree, {}, {})
    assert widget["gradient"] == ["#ff8000/1.00", "#cc4c00/1.00"]
    assert widget["color"] == "#ffffff/1.00"


def test_verified_ui_lobby_camera_matches_still_coordinates(tmp_path):
    import os
    from pathlib import Path
    import pytest
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


def test_verified_loading_letters_define_progress_line(tmp_path):
    import io
    import json
    import os
    import subprocess
    from pathlib import Path
    import pytest
    from PIL import Image
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs

    root = Path(os.environ.get("BAMT_TEST_GAME_DIR", "/nonexistent/verified-view"))
    if not root.is_dir():
        pytest.skip("Verified game view not supplied")
    game = GameAssets(get_search_dirs(root), AssetCache(root=tmp_path / "cache"))
    tree = game.layout("UIRepeater")
    ink, lines = {}, []

    def walk(node, y=0):
        y += node["pos"][1]
        for widget in node["widgets"]:
            name = widget.get("sprite", "")
            if name.startswith("Loading_") and name not in ("Loading_g", "Loading_dot", "Loading_Arona", "Loading_Halo", "Loading_Halo_2"):
                image = Image.open(io.BytesIO(game.sprite_png("Common", name)))
                bottom = image.getchannel("A").getbbox()[3]
                ink[name] = {"height": image.height, "bottom": bottom}
                # Bottom-pivot letters, after upgrade's screen-bottom shift.
                lines.append(1080 - (720 + y) * 1920 / 2960 - (1 - bottom / image.height) * widget["h_"] * 1920 / 2960)
        for child in node.get("children", []):
            walk(child, y)

    walk(tree)
    assert len(lines) == 9
    style = {"name": "ProgressStyle", "active": True, "pos": [0, 0], "scale": [1, 1], "widgets": [
        {"text": "", "fontSize": 32, "effect": 3, "effectColor": "#29415a/0.76", "effectDistance": [3, 3]}]}
    module = Path(__file__).resolve().parents[1] / "src/ba_modding_toolkit/web/js/ngui-label.js"
    script = '''import { loadingLabel, labelBaselineInset } from MODULE;
let input = ""; for await (const part of process.stdin) input += part;
const {tree, style, ink} = JSON.parse(input), s = 1920/2960;
const label = loadingLabel(tree, style, "Reading game files", s, ink), w = label.widgets[0];
console.log(label.inkLine);'''.replace("MODULE", json.dumps(module.as_uri()))
    run = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps({"tree": tree, "style": style, "ink": ink}),
                         capture_output=True, text=True, check=True)
    assert float(run.stdout) == pytest.approx(max(lines), abs=1e-7)
    assert 1013 < float(run.stdout) < 1014
