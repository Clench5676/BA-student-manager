"""Read-only proof of the import thumbnail clip against the actual item frame."""
import io
import json
import os
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.searching import get_search_dirs


def test_verified_item_frame_contains_sharp_thumbnail_without_an_inner_gap(tmp_path):
    root = Path(os.environ.get("BAMT_TEST_GAME_DIR", "/nonexistent/verified-view"))
    if not root.is_dir():
        pytest.skip("Verified game view not supplied")
    game = GameAssets(get_search_dirs(root), AssetCache(root=tmp_path / "cache"))
    item = game.layout("UINonEquipmentInventoryListItem")
    normal = next(n for n in item["children"][0]["children"] if n["name"] == "Normal")
    frame = next(n for n in normal["children"] if n["name"] == "Cover_Select")
    widget = next(w for w in frame["widgets"] if "sprite" in w)
    assert (widget["w_"], widget["h_"], widget["incline"]) == (240, 220, 10)
    meta = game.atlases()[widget["atlas"]][widget["sprite"]]
    image = Image.open(io.BytesIO(game.sprite_png(widget["atlas"], widget["sprite"]))).convert("RGBA")
    module = Path(__file__).resolve().parents[1] / "src/ba_modding_toolkit/web/js/row-thumbnail.js"
    script = '''import {frameOutline, innerFrame} from MODULE;
let s=""; for await (const part of process.stdin) s += part;
const {pixels,widget,meta}=JSON.parse(s), outline=frameOutline(pixels);
console.log(JSON.stringify({outline,window:innerFrame(widget,meta,outline,{scale:.68})}));'''.replace("MODULE", json.dumps(module.as_uri()))
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True,
                            input=json.dumps({"pixels": {"width": image.width, "height": image.height, "data": list(image.tobytes())},
                                              "widget": widget, "meta": meta}))
    proof = json.loads(result.stdout)
    assert proof["outline"]["insets"] == [14, 13, 13, 14]
    assert proof["window"]["radius"] == 0
    assert proof["window"]["clipPolygon"] == [[0, 0], [1, 0], [1, 1], [0, 1]]
    alpha = image.getchannel("A")
    left, top, right, bottom = 14, 13, image.width - 13, image.height - 14
    # Every horizontal strip, including the strips at the two extreme edges,
    # contains the sharp rectangle inside the frame's opaque outer silhouette.
    # The shared monotone nine-slice mapping and affine shear preserve the entire
    # containment, rather than checking only the four corners or a few samples.
    for y in range(top, bottom + 1):
        solid = [x for x in range(image.width) if alpha.getpixel((x, y)) == 255]
        assert solid[0] <= left and solid[-1] + 1 >= right
    for point in [(left, top), (right, top), (right, bottom), (left, bottom)]:
        assert alpha.getpixel(point) == 255, "The frame covers each sharp picture corner"
    # Independently measured straight inner edges: these are stroke boundaries,
    # not the 69/69/42/42 atlas slicing cuts or a guessed corner radius.
    horizontal = [x for x in range(image.width) if alpha.getpixel((x, image.height // 2)) == 255]
    assert max(x for x in horizontal if x < image.width // 2) + 1 == left
    assert min(x for x in horizontal if x >= image.width // 2) == right
    vertical = [y for y in range(image.height) if alpha.getpixel((50, y)) == 255]
    assert max(y for y in vertical if y < image.height // 2) + 1 == top
    assert min(y for y in vertical if y >= image.height // 2) == bottom
    # Reference the renderer's raster cuts independently of the JS helper.
    scale = .68
    canvas_w, canvas_h = round(240 * scale * 2), round(220 * scale * 2)
    side, cap = round(68 * scale * 2), round(42 * scale * 2)
    x0, x1 = left / 68 * side, canvas_w - (image.width - right) / 68 * side
    y0, y1 = top / 42 * cap, canvas_h - (image.height - bottom) / 42 * cap
    window = proof["window"]
    assert window["width"] == pytest.approx((x1 - x0) / canvas_w * 240)
    assert window["height"] == pytest.approx((y1 - y0) / canvas_h * 220)
