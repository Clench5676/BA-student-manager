"""Compare official badge columns in memory; never persist or report game pixels."""

from io import BytesIO
import json
from pathlib import Path

import pytest
from PIL import Image

from ba_modding_toolkit.gameassets import AssetCache, GameAssets

SOURCE = Path(__file__).parents[1] / "src/ba_modding_toolkit/web/js/selected-frames.js"


@pytest.fixture
def official_badge_assets(request, tmp_path):
    if not request.config.pluginmanager.hasplugin("bamt_dev.testing"):
        pytest.skip("Requires the official development view (-p bamt_dev.testing)")
    official = request.getfixturevalue("official_game")
    official.require_ui()
    cache = AssetCache(root=tmp_path / "memory-only", allowed=False)
    yield official, GameAssets(official.resource_dirs, cache)
    assert not cache.root.exists(), "Badge validation must never persist game assets"


def _uniform_runs(image):
    """Return maximal identical RGBA column runs, with exclusive right endpoints."""
    columns = [image.crop((x, 0, x + 1, image.height)).tobytes() for x in range(image.width)]
    start = 0
    runs = []
    for end in range(1, image.width + 1):
        if end == image.width or columns[end] != columns[start]:
            if end - start > 1:
                runs.append((start, end))
            start = end
    return runs


@pytest.mark.parametrize("sprite", ["Common_Icon_Mulligan_1", "Common_Icon_Mulligan_2"])
def test_official_badge_horizontal_slices(official_badge_assets, sprite):
    _, game = official_badge_assets
    shipped = json.loads(SOURCE.read_text().split("export const SELECTION_BADGE_SLICES = ", 1)[1].split(";", 1)[0])[sprite]
    meta = game.atlases()["Common"][sprite]
    assert (meta["width"], meta["height"]) == (shipped["width"], shipped["height"]) == (64, 69)
    assert [meta.get("border" + side, 0) for side in ("Left", "Right", "Top", "Bottom")] == [0, 0, 0, 0]
    assert [meta.get("padding" + side, 0) for side in ("Left", "Right", "Top", "Bottom")] == [11, 0, 5, 0]
    assert shipped["borderTop"] == shipped["borderBottom"] == 0
    image = Image.open(BytesIO(game.sprite_png("Common", sprite))).convert("RGBA")
    runs = _uniform_runs(image)
    # Exact equality of all four channels, including transparent pixels: no tolerance and no pixel output.
    assert runs == [(14, 28)], f"{sprite}: identical column runs (start, exclusive end): {runs}"
    assert (shipped["borderLeft"], image.width - shipped["borderRight"]) == runs[0]
    assert 0 < runs[0][0] < runs[0][1] < image.width
    # Numeric bounds used by JS geometry assertions: the fill is fully opaque over these source rows.
    opaque = [y for y in range(image.height) if image.getpixel((14, y))[3] == 255]
    assert opaque == list(range(3, 61))


def test_official_badge_prefab_geometry(official_badge_assets):
    official, game = official_badge_assets
    official.require_layout("UIPopup_Mulligan")
    slot = game.layout("UIPopup_Mulligan", "Center/Popup/01/UIMulliganSlot")
    nodes = {node["name"]: node for node in slot["children"]}
    badge, label = nodes["Mulligan_IndexBg"], nodes["Mulligan_IndexLabel"]
    sprite = next(w for w in badge["widgets"] if "sprite" in w)
    text = next(w for w in label["widgets"] if "text" in w)
    assert badge["pos"] == [120, 213]
    assert label["pos"] == [120, 210]
    assert badge["scale"] == label["scale"] == [1, 1]
    assert [sprite[k] for k in ("sprite", "w_", "h_", "type", "pivot")] == ["Common_Icon_Mulligan_1", 76, 74, 1, 4]
    assert [text[k] for k in ("fontSize", "w_", "h_", "pivot")] == [42, 70, 52, 4]
