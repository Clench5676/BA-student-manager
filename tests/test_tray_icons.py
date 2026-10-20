"""The tray and menu bar icon files (assets/tray): there, readable, and built from their SVG sources."""

import importlib.util
import re
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "src" / "ba_modding_toolkit" / "assets" / "tray"


def test_the_icon_files_are_there():
    for name in ("menubar.svg", "menubar.pdf", "menubar@2x.png", "tray.svg", "tray.ico"):
        assert (ICON_DIR / name).is_file(), name


def test_the_menu_bar_pdf_parses_as_one_18_pt_page():
    data = (ICON_DIR / "menubar.pdf").read_bytes()
    assert data.startswith(b"%PDF-1.") and data.rstrip().endswith(b"%%EOF")
    assert re.search(rb"/MediaBox \[0 0 18 18\]", data)
    assert data.count(b"/Type /Page ") == 1
    startxref = int(re.search(rb"startxref\s+(\d+)", data).group(1))
    assert data[startxref:startxref + 4] == b"xref"
    entries = re.findall(rb"(\d{10}) 00000 n ", data[startxref:])
    assert entries
    for number, offset in enumerate(entries, 1):
        assert data[int(offset):].startswith(f"{number} 0 obj".encode())
    length = int(re.search(rb"/Length (\d+)", data).group(1))
    stream = data.index(b"stream\n") + len(b"stream\n")
    assert data[stream + length:].startswith(b"endstream")
    assert b"f*" in data[stream:stream + length]  # filled even-odd: the band and the star


def test_the_2x_png_is_a_36_px_black_template():
    with Image.open(ICON_DIR / "menubar@2x.png") as png:
        assert png.size == (36, 36) and png.mode == "RGBA"
        alpha = png.getchannel("A")
        assert alpha.getextrema() == (0, 255)
        rgb = png.convert("RGB").getextrema()
        assert all(high == 0 for _, high in rgb)  # black: the alpha carries the shape
        # clear of the edges: the gem's pointed top and bottom corners reach within 1 pt, its sides stay further
        left, top, right, bottom = alpha.getbbox()
        assert min(top, 36 - bottom) >= 1 and min(left, 36 - right) >= 2


def test_the_tray_ico_has_frames_drawn_for_16_to_32_px():
    with Image.open(ICON_DIR / "tray.ico") as ico:
        assert sorted(size[0] for size in ico.ico.sizes()) == [16, 20, 24, 32]
        for size in (16, 20, 24, 32):
            frame = ico.ico.getimage((size, size)).convert("RGBA")
            assert frame.size == (size, size)
            assert frame.getchannel("A").getextrema() == (0, 255)
    raw = (ICON_DIR / "tray.ico").read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", raw)
    assert (reserved, kind, count) == (0, 1, 4)
    for index in range(count):
        width, height, _, _, planes, bits, size, offset = struct.unpack_from("<BBBBHHII", raw, 6 + 16 * index)
        assert bits == 32 and planes == 1
        header = struct.unpack_from("<IiiHH", raw, offset)
        assert header == (40, width, height * 2, 1, 32)  # a DIB with its AND mask, as every Windows reads
        mask_stride = ((width + 31) // 32) * 4
        assert size == 40 + width * height * 4 + mask_stride * height


def test_the_built_icons_match_their_svg_sources():
    spec = importlib.util.spec_from_file_location("tray_icons", ROOT / "scripts" / "tray_icons.py")
    tray_icons = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = tray_icons  # its dataclasses look their module up
    try:
        spec.loader.exec_module(tray_icons)
    finally:
        sys.modules.pop(spec.name, None)
    assert tray_icons.check(ICON_DIR) == []
