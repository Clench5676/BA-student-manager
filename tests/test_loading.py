"""Optional verified-asset check for the loading progress baseline."""
import os

import pytest


@pytest.mark.skipif(not os.environ.get("BAMT_TEST_GAME_DIR"),
                    reason="Optional verified-asset check: set BAMT_TEST_GAME_DIR to an isolated verified copy")
def test_verified_loading_letters_define_progress_line(tmp_path):
    import io
    import json
    import subprocess
    from pathlib import Path
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
