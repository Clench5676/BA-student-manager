"""Build the tray and menu bar icons from their SVG sources in src/ba_modding_toolkit/assets/tray.

    python scripts/tray_icons.py                     # menubar.pdf, menubar@2x.png and tray.ico from the SVGs
    python scripts/tray_icons.py --check             # exit 1 when the built files no longer match the SVGs
    python scripts/tray_icons.py --preview out.png   # a review sheet (see below)

- ``menubar.svg`` (18 x 18 pt, black on transparent) becomes ``menubar.pdf``, the vector template image the macOS
  menu bar draws at every scale, and ``menubar@2x.png`` (36 px), its fallback.
- ``tray.svg`` (16 x 16 units, in colour) becomes ``tray.ico`` with frames rendered for 16, 20, 24 and 32 px, so
  Windows never scales a large frame down.

The sources hold only ``<path>`` elements, each with one ``fill`` colour and ``d`` data of M, L, H, V, C and Z
commands (absolute or relative); the subpaths of one path combine even-odd. Only Pillow is needed.

The preview shows the menu bar icon at 16, 18 and 22 pt, at 1x and 2x, on a light and a dark menu bar, and the tray
frames on a light and a dark taskbar, each at its size and enlarged. On macOS it draws ``menubar.pdf`` through
AppKit, the way the menu bar does.
"""

from __future__ import annotations

import argparse
import io
import re
import struct
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ICON_DIR = Path(__file__).resolve().parent.parent / "src" / "ba_modding_toolkit" / "assets" / "tray"
MENUBAR_PT = 18  # the menu bar icon's size in points
TRAY_SIZES = (16, 20, 24, 32)  # Windows picks the frame of the small icon size: 100 %, 125 %, 150 % and 200 %
SUPERSAMPLE = 16  # samples per pixel along each axis when rendering
CURVE_STEPS = 32  # line segments per cubic curve when rendering

Point = tuple[float, float]


@dataclass
class Shape:
    """One ``<path>``: its fill colour and its subpaths, each a list of segments (``("L", p)`` or
    ``("C", c1, c2, p)``) after a start point."""

    fill: tuple[int, int, int]
    subpaths: list[tuple[Point, list[tuple]]]


@dataclass
class Drawing:
    width: float
    height: float
    paths: list[Shape]


# --- reading the SVG ---

_TOKEN = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def parse_path(d: str) -> list[tuple[Point, list[tuple]]]:
    tokens = _TOKEN.findall(d)
    subpaths: list[tuple[Point, list[tuple]]] = []
    i, cmd = 0, None
    cur: Point = (0.0, 0.0)
    start: Point = (0.0, 0.0)
    segments: list[tuple] | None = None

    def number() -> float:
        nonlocal i
        value = float(tokens[i])
        i += 1
        return value

    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd not in "MmLlHhVvCcZz":
                raise ValueError(f"unsupported path command {cmd}")
            if cmd in "Zz":
                if segments is not None and cur != start:
                    segments.append(("L", start))
                cur, segments = start, None
                continue
        if cmd is None:
            raise ValueError("path data must start with a command")
        rel = cmd.islower()
        op = cmd.upper()
        if op == "M":
            x, y = number(), number()
            cur = (cur[0] + x, cur[1] + y) if rel else (x, y)
            start, segments = cur, []
            subpaths.append((cur, segments))
            cmd = "l" if rel else "L"  # further pairs are line-tos
        elif segments is None:
            raise ValueError("a drawing command before M")
        elif op == "L":
            x, y = number(), number()
            cur = (cur[0] + x, cur[1] + y) if rel else (x, y)
            segments.append(("L", cur))
        elif op == "H":
            x = number()
            cur = (cur[0] + x if rel else x, cur[1])
            segments.append(("L", cur))
        elif op == "V":
            y = number()
            cur = (cur[0], cur[1] + y if rel else y)
            segments.append(("L", cur))
        elif op == "C":
            pts = [(number(), number()) for _ in range(3)]
            if rel:
                pts = [(cur[0] + x, cur[1] + y) for x, y in pts]
            segments.append(("C", pts[0], pts[1], pts[2]))
            cur = pts[2]
        else:
            raise ValueError(f"unsupported path command {cmd}")
    return subpaths


def _colour(value: str) -> tuple[int, int, int]:
    value = value.strip().lower()
    if value in ("black", "#000"):
        return (0, 0, 0)
    if value in ("white", "#fff"):
        return (255, 255, 255)
    if re.fullmatch(r"#[0-9a-f]{3}", value):
        return tuple(int(c * 2, 16) for c in value[1:])  # type: ignore[return-value]
    if re.fullmatch(r"#[0-9a-f]{6}", value):
        return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))  # type: ignore[return-value]
    raise ValueError(f"unsupported fill {value!r}")


def read_svg(path: Path) -> Drawing:
    root = ET.parse(path).getroot()
    box = [float(v) for v in root.get("viewBox", "").replace(",", " ").split()]
    if len(box) != 4 or box[0] or box[1]:
        raise ValueError(f"{path.name}: needs a viewBox starting at 0 0")
    paths = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "path":
            paths.append(Shape(_colour(el.get("fill", "#000")), parse_path(el.get("d", ""))))
        elif tag not in ("svg", "title", "desc", "g"):
            raise ValueError(f"{path.name}: unsupported element <{tag}>")
    return Drawing(box[2], box[3], paths)


# --- rendering ---

def _flatten(start: Point, segments: list[tuple]) -> list[Point]:
    points = [start]
    for seg in segments:
        if seg[0] == "L":
            points.append(seg[1])
            continue
        p0 = points[-1]
        _, c1, c2, p3 = seg
        for k in range(1, CURVE_STEPS + 1):
            t = k / CURVE_STEPS
            u = 1 - t
            points.append((u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
                           u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1]))
    return points


def coverage(path: Shape, scale: float, size: tuple[int, int]) -> Image.Image:
    """A path's coverage as an 8-bit mask: the subpaths filled even-odd at SUPERSAMPLE x SUPERSAMPLE samples per
    pixel, then averaged."""
    big = (size[0] * SUPERSAMPLE, size[1] * SUPERSAMPLE)
    mask = Image.new("1", big, 0)
    f = scale * SUPERSAMPLE
    for start, segments in path.subpaths:
        one = Image.new("1", big, 0)
        ImageDraw.Draw(one).polygon([(x * f, y * f) for x, y in _flatten(start, segments)], fill=1)
        mask = ImageChops.logical_xor(mask, one)
    return mask.convert("L").reduce(SUPERSAMPLE)


def render(drawing: Drawing, width: int, height: int | None = None) -> Image.Image:
    """The drawing at ``width`` pixels (``height`` keeps the aspect ratio), its paths painted in order."""
    height = height or round(width * drawing.height / drawing.width)
    scale = width / drawing.width
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for path in drawing.paths:
        layer = Image.new("RGBA", out.size, path.fill + (255,))
        layer.putalpha(coverage(path, scale, out.size))
        out = Image.alpha_composite(out, layer)
    return out


# --- writing ---

def _num(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text if text not in ("", "-0") else "0"


def pdf_bytes(drawing: Drawing) -> bytes:
    """A one-page PDF of the drawing in points (1 SVG unit = 1 pt), each path filled even-odd with its colour."""
    h = drawing.height
    ops: list[str] = []
    for path in drawing.paths:
        r, g, b = (c / 255 for c in path.fill)
        ops.append(f"{_num(r)} {_num(g)} {_num(b)} rg")
        for start, segments in path.subpaths:
            ops.append(f"{_num(start[0])} {_num(h - start[1])} m")
            for seg in segments:
                if seg[0] == "L":
                    ops.append(f"{_num(seg[1][0])} {_num(h - seg[1][1])} l")
                else:
                    ops.append(" ".join(f"{_num(x)} {_num(h - y)}" for x, y in seg[1:]) + " c")
            ops.append("h")
        ops.append("f*")
    content = ("\n".join(ops) + "\n").encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_num(drawing.width)} {_num(h)}] /Resources << >> "
        f"/Contents 4 0 R >>".encode("ascii"),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"endstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii") + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("ascii")
    return bytes(out)


def ico_bytes(frames: list[Image.Image]) -> bytes:
    """A Windows icon with one 32-bit frame per image (BGRA rows bottom-up and the AND mask, the format every
    Windows version reads)."""
    images = []
    for frame in frames:
        frame = frame.convert("RGBA")
        w, h = frame.size
        header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        r, g, b, a = frame.split()
        rows = Image.merge("RGBA", (b, g, r, a)).tobytes()
        stride = w * 4
        pixels = b"".join(rows[y * stride:(y + 1) * stride] for y in range(h - 1, -1, -1))
        mask_stride = ((w + 31) // 32) * 4
        alpha = a.load()
        mask = bytearray()
        for y in range(h - 1, -1, -1):
            row = bytearray(mask_stride)
            for x in range(w):
                if alpha[x, y] == 0:
                    row[x // 8] |= 0x80 >> (x % 8)
            mask += row
        images.append(header + pixels + bytes(mask))
    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for frame, data in zip(frames, images):
        w, h = frame.size
        out += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for data in images:
        out += data
    return bytes(out)


def png_bytes(image: Image.Image, dpi: int) -> bytes:
    buf = io.BytesIO()
    image.save(buf, "PNG", dpi=(dpi, dpi), optimize=True)
    return buf.getvalue()


def build(out_dir: Path, src_dir: Path = ICON_DIR) -> list[Path]:
    """Write menubar.pdf, menubar@2x.png and tray.ico into ``out_dir`` from the SVGs in ``src_dir``."""
    out_dir.mkdir(parents=True, exist_ok=True)
    menubar = read_svg(src_dir / "menubar.svg")
    tray = read_svg(src_dir / "tray.svg")
    written = {
        "menubar.pdf": pdf_bytes(menubar),
        "menubar@2x.png": png_bytes(render(menubar, MENUBAR_PT * 2), 144),  # 144 dpi: 18 pt at 2x
        "tray.ico": ico_bytes([render(tray, size) for size in TRAY_SIZES]),
    }
    paths = []
    for name, data in written.items():
        (out_dir / name).write_bytes(data)
        paths.append(out_dir / name)
    return paths


def same_pixels(a: Image.Image, b: Image.Image, tolerance: int = 2) -> bool:
    """Whether two renderings match, allowing for small differences between Pillow versions."""
    if a.size != b.size:
        return False
    diff = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA"))
    return max(high for _, high in diff.getextrema()) <= tolerance


def ico_frames(path: Path) -> dict[int, Image.Image]:
    with Image.open(path) as ico:
        return {size[0]: ico.ico.getimage(size).convert("RGBA") for size in ico.ico.sizes()}


def check(src_dir: Path = ICON_DIR) -> list[str]:
    """The built files that no longer match their SVG sources."""
    stale = []
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp)
        build(fresh, src_dir)
        if (fresh / "menubar.pdf").read_bytes() != (src_dir / "menubar.pdf").read_bytes():
            stale.append("menubar.pdf")
        with Image.open(fresh / "menubar@2x.png") as a, Image.open(src_dir / "menubar@2x.png") as b:
            if not same_pixels(a, b):
                stale.append("menubar@2x.png")
        new, old = ico_frames(fresh / "tray.ico"), ico_frames(src_dir / "tray.ico")
        if sorted(new) != sorted(old) or not all(same_pixels(new[s], old[s]) for s in new):
            stale.append("tray.ico")
    return stale


# --- the review sheet ---

LIGHT_BAR, DARK_BAR = (246, 246, 246), (38, 38, 38)  # menu bars without a wallpaper tint
LIGHT_INK, DARK_INK = (0, 0, 0, 217), (255, 255, 255, 217)  # template images at the label colour (85 %)
LIGHT_TASKBAR, DARK_TASKBAR = (243, 243, 243), (32, 32, 32)  # Windows 11


def _appkit_render(pdf: Path, points: int, scale: int) -> Image.Image | None:
    """The PDF drawn by AppKit into a bitmap, as the menu bar draws a template image (alpha only)."""
    try:
        from AppKit import (NSBitmapImageFileTypePNG, NSBitmapImageRep, NSCalibratedRGBColorSpace,
                            NSCompositingOperationSourceOver, NSGraphicsContext, NSImage, NSMakeRect, NSZeroRect)
    except ImportError:
        return None
    image = NSImage.alloc().initWithContentsOfFile_(str(pdf))
    if image is None:
        return None
    image.setSize_((points, points))
    px = points * scale
    rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(  # noqa: E501
        None, px, px, 8, 4, True, False, NSCalibratedRGBColorSpace, 0, 0)
    rep.setSize_((points, points))
    context = NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.setCurrentContext_(context)
    image.drawInRect_fromRect_operation_fraction_(NSMakeRect(0, 0, points, points), NSZeroRect,
                                                  NSCompositingOperationSourceOver, 1.0)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    data = rep.representationUsingType_properties_(NSBitmapImageFileTypePNG, {})
    return Image.open(io.BytesIO(bytes(data))).convert("RGBA")


def _tint(alpha: Image.Image, bg: tuple[int, int, int], ink: tuple[int, int, int, int]) -> Image.Image:
    a = alpha.point(lambda v: v * ink[3] // 255)
    ink_layer = Image.new("RGBA", alpha.size, ink[:3] + (255,))
    ink_layer.putalpha(a)
    return Image.alpha_composite(Image.new("RGBA", alpha.size, bg + (255,)), ink_layer).convert("RGB")


def preview(out: Path, src_dir: Path = ICON_DIR, zoom: int = 6) -> Path:
    menubar = read_svg(src_dir / "menubar.svg")
    tray = read_svg(src_dir / "tray.svg")
    pdf = src_dir / "menubar.pdf"
    rows: list[list[Image.Image]] = []
    for bg, ink in ((LIGHT_BAR, LIGHT_INK), (DARK_BAR, DARK_INK)):
        row = []
        for points in (16, 18, 22):
            for scale in (1, 2):
                drawn = _appkit_render(pdf, points, scale) if pdf.is_file() else None
                drawn = drawn or render(menubar, points * scale)
                tile = _tint(drawn.getchannel("A"), bg, ink)
                row += [tile, tile.resize((points * zoom, points * zoom), Image.NEAREST)]
        with Image.open(src_dir / "menubar@2x.png") as fallback:
            tile = _tint(fallback.convert("RGBA").getchannel("A"), bg, ink)
        row += [tile, tile.resize((MENUBAR_PT * zoom, MENUBAR_PT * zoom), Image.NEAREST)]
        rows.append(row)
    for bg in (LIGHT_TASKBAR, DARK_TASKBAR):
        row = []
        for size in TRAY_SIZES:
            frame = render(tray, size)
            tile = Image.alpha_composite(Image.new("RGBA", frame.size, bg + (255,)), frame).convert("RGB")
            row += [tile, tile.resize((16 * zoom, 16 * zoom), Image.NEAREST)]
        rows.append(row)
    pad = 8
    width = max(sum(t.width + pad for t in row) for row in rows) + pad
    height = sum(max(t.height for t in row) + pad for row in rows) + pad
    sheet = Image.new("RGB", (width, height), (128, 128, 128))
    y = pad
    for row in rows:
        x = pad
        for tile in row:
            sheet.paste(tile, (x, y))
            x += tile.width + pad
        y += max(t.height for t in row) + pad
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="only report built files that differ from the SVGs")
    parser.add_argument("--preview", type=Path, metavar="PNG", help="write a review sheet")
    args = parser.parse_args(argv)
    if args.check:
        stale = check()
        for name in stale:
            print(f"out of date: {name}")
        return 1 if stale else 0
    if args.preview:
        print(preview(args.preview))
        return 0
    for path in build(ICON_DIR):
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
