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


@pytest.fixture(scope="module")
def verified_frame(tmp_path_factory):
    root = Path(os.environ.get("BAMT_TEST_GAME_DIR", "/nonexistent/verified-view"))
    if not root.is_dir():
        pytest.skip("Verified game view not supplied")
    game = GameAssets(get_search_dirs(root), AssetCache(root=tmp_path_factory.mktemp("frame-cache")))
    item = game.layout("UINonEquipmentInventoryListItem")
    normal = next(n for n in item["children"][0]["children"] if n["name"] == "Normal")
    frame = next(n for n in normal["children"] if n["name"] == "Cover_Select")
    widget = next(w for w in frame["widgets"] if "sprite" in w)
    assert (widget["w_"], widget["h_"], widget["incline"]) == (240, 220, 10)
    meta = game.atlases()[widget["atlas"]][widget["sprite"]]
    image = Image.open(io.BytesIO(game.sprite_png(widget["atlas"], widget["sprite"]))).convert("RGBA")
    return widget, meta, image


@pytest.mark.parametrize("scale", [.34, .54, .68, .873, 1.25, 2, 4])
def test_verified_item_frame_contour_matches_rounded_thumbnail_within_one_pixel(verified_frame, scale):
    widget, meta, image = verified_frame
    module = Path(__file__).resolve().parents[1] / "src/ba_modding_toolkit/web/js/row-thumbnail.js"
    script = '''import {frameOutline, innerFrame} from MODULE;
let s=""; for await (const part of process.stdin) s += part;
const {pixels,widget,meta,scale}=JSON.parse(s), outline=frameOutline(pixels);
console.log(JSON.stringify({outline,window:innerFrame(widget,meta,outline,{scale})}));'''.replace("MODULE", json.dumps(module.as_uri()))
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True,
                            input=json.dumps({"pixels": {"width": image.width, "height": image.height, "data": list(image.tobytes())},
                                              "widget": widget, "meta": meta, "scale": scale}))
    proof = json.loads(result.stdout)
    assert proof["outline"]["insets"] == [14, 13, 13, 14]
    assert proof["window"]["radius"] == 0
    assert len(proof["window"]["clipPolygon"]) > 4
    assert [0, 0] not in proof["window"]["clipPolygon"]
    alpha = image.getchannel("A")
    left, top, right, bottom = 14, 13, image.width - 13, image.height - 14
    # Every horizontal strip, including the strips at the two extreme edges,
    # contains the sharp rectangle inside the frame's opaque outer silhouette.
    # The shared monotone nine-slice mapping and affine shear preserve the entire
    # containment, rather than checking only the four corners or a few samples.
    for y in range(top, bottom + 1):
        solid = [x for x in range(image.width) if alpha.getpixel((x, y)) >= 240]
        assert solid[0] <= left and solid[-1] + 1 >= right
    for point in [(left, top), (right, top), (right, bottom), (left, bottom)]:
        assert alpha.getpixel(point) == 255, "The frame covers each sharp picture corner"
    # Independently measured straight inner edges: these are stroke boundaries,
    # not the 69/69/42/42 atlas slicing cuts or a guessed corner radius.
    horizontal = [x for x in range(image.width) if alpha.getpixel((x, image.height // 2)) >= 240]
    assert max(x for x in horizontal if x < image.width // 2) + 1 == left
    assert min(x for x in horizontal if x >= image.width // 2) == right
    vertical = [y for y in range(image.height) if alpha.getpixel((50, y)) >= 240]
    assert max(y for y in vertical if y < image.height // 2) + 1 == top
    assert min(y for y in vertical if y >= image.height // 2) == bottom
    # Reference the renderer's raster cuts independently of the JS helper.
    canvas_w, canvas_h = round(240 * scale * 2), round(220 * scale * 2)
    side, cap = round(68 * scale * 2), round(42 * scale * 2)
    x0, x1 = left / 68 * side, canvas_w - (image.width - right) / 68 * side
    y0, y1 = top / 42 * cap, canvas_h - (image.height - bottom) / 42 * cap
    window = proof["window"]
    assert window["width"] == pytest.approx((x1 - x0) / canvas_w * 240)
    assert window["height"] == pytest.approx((y1 - y0) / canvas_h * 220)

    # The full contour is checked against each independent source scanline.
    # Source half-pixel centres preserve the stroke's small corner transitions.
    points = proof["outline"]["points"]
    for y in range(top, bottom):
        solid = [x for x in range(image.width) if alpha.getpixel((x, y)) >= 240]
        expected_left = max(left, max(x for x in solid if x < image.width // 2) + 1)
        expected_right = min(right, min(x for x in solid if x >= image.width // 2))
        row = [x for x, py in points if py == y + .5]
        assert min(row) == expected_left and max(row) == expected_right
    def mapped(value, source, cap_source, cap_pixels, extent):
        if value <= cap_source:
            return value / cap_source * cap_pixels
        if value >= source - cap_source:
            return extent - (source - value) / cap_source * cap_pixels
        return cap_pixels + (value - cap_source) / (source - 2 * cap_source) * (extent - 2 * cap_pixels)
    measured = [(mapped(p[0], image.width, 68, side, canvas_w) - x0,
                 mapped(p[1], image.height, 42, cap, canvas_h) - y0) for p in points]
    smooth = [(p[0] * (x1 - x0), p[1] * (y1 - y0)) for p in window["clipPolygon"]]

    def segment_distance(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = dx * dx + dy * dy
        u = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) if length else 0
        return ((p[0] - a[0] - u * dx) ** 2 + (p[1] - a[1] - u * dy) ** 2) ** .5

    # Bidirectional contour distance after raster scaling and the result row's
    # enlargement. Dense curve samples retain the small measured corner shape.
    for contour, reference in [(measured, smooth), (smooth, measured)]:
        segments = list(zip(reference, reference[1:] + reference[:1]))
        for point in contour:
            assert min(segment_distance(point, a, b) for a, b in segments) / 2 * .62 / .54 < 1
    for a, b in zip(smooth, smooth[1:] + smooth[:1]):
        if 1e-7 < a[0] < x1 - x0 - 1e-7 and 1e-7 < a[1] < y1 - y0 - 1e-7:
            assert abs(a[0] - b[0]) > 1e-9 and abs(a[1] - b[1]) > 1e-9, "No raster stairs in the corners"
