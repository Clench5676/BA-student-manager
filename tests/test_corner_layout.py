"""Verify corner geometry against official prefab metadata when a development view is supplied."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from ba_modding_toolkit.gameassets.layouts import export_layout, subtree
from ba_modding_toolkit.gameassets.service import PREFAB_HINTS
from ba_modding_toolkit.gameassets.unity import open_bundle

NODE = shutil.which("node")
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(NODE is None or not GAME_DIR.is_dir(), reason="Node.js and an official development view are required")
@pytest.mark.parametrize("root", ["UICharacterDetail", "UILobby", "UICharacterCollection"])
def test_corner_prefab_geometry(root):
    fixture = (Path(__file__).parent / "js" / "corner_prefabs.mjs").as_uri()
    result = subprocess.run([NODE, "--input-type=module", "-e",
                             f"import {{cornerPrefabs}} from {json.dumps(fixture)}; console.log(JSON.stringify(cornerPrefabs));"],
                            check=True, capture_output=True, text=True, timeout=30)
    expected = json.loads(result.stdout)[root]
    bundle = next(GAME_DIR.rglob(PREFAB_HINTS[root]))
    with open_bundle(bundle) as env:
        layout = export_layout(env, root, {})
    for path, reference in expected.items():
        node = subtree(layout, path)
        assert node["pos"] == pytest.approx(reference["pos"]), path
        if "size" in reference:
            widget = next(w for w in node["widgets"] if w.get("sprite") == reference["sprite"])
            assert [widget["w_"], widget["h_"]] == reference["size"], path
            assert widget["pivot"] == reference["pivot"], path
            if "incline" in reference:
                assert widget["incline"] == reference["incline"], path
