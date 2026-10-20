"""Repack painted Spine regions onto current official pages, without changing the rig."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageMath

from . import devmode
from .bundle import Bundle
from .models import ContNameTypeKey, Patch
from .spine import get_skel_version


def texture_key(name: str) -> str:
    return name.replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".png")


@dataclass(frozen=True)
class Region:
    name: str
    index: int
    page: str
    xy: tuple[int, int]
    size: tuple[int, int]
    original: tuple[int, int]
    offset: tuple[int, int]
    degrees: int = 0

    @property
    def key(self) -> tuple[str, int]:
        return self.name, self.index

    @property
    def label(self) -> str:
        return self.name if self.index == -1 else f"{self.name} [{self.index}]"


@dataclass
class Page:
    name: str
    size: tuple[int, int] = (0, 0)
    pma: bool = False
    format: str = "RGBA8888"


@dataclass
class Atlas:
    pages: dict[str, Page] = field(default_factory=dict)
    regions: dict[tuple[str, int], Region] = field(default_factory=dict)


def parse_atlas(text: str | bytes) -> Atlas:
    """Read legacy xy/size/orig/offset and modern bounds/offsets syntax."""
    if isinstance(text, bytes):
        text = text.decode("utf-8-sig")
    atlas = Atlas()
    page = None
    name = None
    props = {}
    page_start = True

    def numbers(key: str, default: tuple) -> tuple:
        return tuple(int(v.strip()) for v in props[key].split(",")) if key in props else default

    def flush() -> None:
        if name is None:
            return
        bounds = numbers("bounds", numbers("xy", (0, 0)) + numbers("size", (0, 0)))
        offsets = numbers("offsets", numbers("offset", (0, 0)) + numbers("orig", bounds[2:]))
        if len(bounds) != 4 or len(offsets) != 4:
            raise ValueError("Invalid atlas bounds or offsets")
        rotation = props.get("rotate", "false").lower()
        degrees = {"true": 90, "false": 0}.get(rotation)
        if degrees is None:
            degrees = int(rotation) % 360
        if degrees not in (0, 90, 180, 270):
            raise ValueError("Unsupported atlas rotation")
        region = Region(name, int(props.get("index", -1)), page.name, bounds[:2], bounds[2:],
                        offsets[2:], offsets[:2], degrees)
        if min(*region.size, *region.original) <= 0 or min(*region.xy, *region.offset) < 0:
            raise ValueError("Invalid atlas region dimensions")
        if any(o + s > original for o, s, original in zip(region.offset, region.size, region.original)):
            raise ValueError("Atlas trim exceeds original size")
        if region.key in atlas.regions:
            raise ValueError("Ambiguous atlas region index")
        atlas.regions[region.key] = region

    for raw in text.lstrip("\ufeff").splitlines():
        line = raw.strip()
        if not line:
            flush()
            name, props, page_start = None, {}, True
        elif page_start:
            if ":" in line:
                raise ValueError("Missing atlas page")
            if line in atlas.pages:
                raise ValueError("Duplicate atlas page")
            page = Page(line)
            atlas.pages[line] = page
            page_start = False
        elif ":" not in line:
            flush()
            name, props = line, {}
        else:
            key, value = (v.strip() for v in line.split(":", 1))
            if name is not None:
                props[key] = value
            elif key == "size":
                page.size = tuple(int(v.strip()) for v in value.split(","))
                if len(page.size) != 2 or min(page.size) <= 0:
                    raise ValueError("Invalid atlas page size")
            elif key == "pma":
                page.pma = value.lower() == "true"
            elif key == "format":
                page.format = value
    flush()
    if not atlas.pages:
        raise ValueError("Empty atlas")
    return atlas


def pair_atlases(old: dict, new: dict) -> dict[str, str]:
    """Pair by asset basename, with the preview's single remaining pair fallback."""
    result = {}
    remaining = set(old)
    for target in new:
        matches = [source for source in remaining if texture_key(source) == texture_key(target)]
        if len(matches) == 1:
            result[target] = matches[0]
            remaining.remove(matches[0])
    unmatched = set(new) - result.keys()
    if len(remaining) == len(unmatched) == 1:
        result[unmatched.pop()] = remaining.pop()
    return result


def layout_changes(old: dict[str, bytes], new: dict[str, bytes]) -> list[str]:
    pairs = pair_atlases(old, new)
    changes = list(set(old) - set(pairs.values())) + list(set(new) - pairs.keys())
    for name, data in new.items():
        if name not in pairs:
            continue
        left, right = parse_atlas(old[pairs[name]]), parse_atlas(data)
        if left != right:
            changes.append(name)
    return sorted(changes)


def _box(region: Region, page: Page, image: Image.Image) -> tuple[int, int, int, int]:
    width, height = region.size[::-1] if region.degrees % 180 else region.size
    declared = page.size if all(page.size) else image.size
    sx, sy = image.width / declared[0], image.height / declared[1]
    x, y = region.xy
    box = round(x * sx), round(y * sy), round((x + width) * sx), round((y + height) * sy)
    if box[0] < 0 or box[1] < 0 or box[2] > image.width or box[3] > image.height or box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError("Atlas region is outside its texture")
    return box


def _rotate(image: Image.Image, degrees: int) -> Image.Image:
    operation = {90: Image.Transpose.ROTATE_90, 180: Image.Transpose.ROTATE_180,
                 270: Image.Transpose.ROTATE_270}.get(degrees % 360)
    return image.transpose(operation) if operation else image


def _alpha(image: Image.Image, source_pma: bool, target_pma: bool) -> Image.Image:
    if source_pma == target_pma:
        return image
    if source_pma:
        return Image.frombytes("RGBa", image.size, image.tobytes()).convert("RGBA")
    return Image.frombytes("RGBA", image.size, image.convert("RGBa").tobytes())


def _resize(image: Image.Image, size: tuple[int, int], box: tuple, pma: bool) -> Image.Image:
    if all(value == round(value) for value in box) and (box[2] - box[0], box[3] - box[1]) == size:
        return image.crop(tuple(round(value) for value in box))
    if pma:
        return Image.frombytes("RGBA", size, Image.frombytes("RGBa", image.size, image.tobytes())
                               .resize(size, Image.Resampling.BICUBIC, box=box).tobytes())
    # Float bands avoid the 8-bit premultiply/unpremultiply loss in Pillow's RGBA resize.
    red, green, blue, alpha = (band.convert("F") for band in image.split())
    resized_alpha = alpha.resize(size, Image.Resampling.BICUBIC, box=box)
    channels = []
    for channel in (red, green, blue):
        weighted = ImageMath.lambda_eval(lambda v: v["c"] * v["a"], c=channel, a=alpha)
        weighted = weighted.resize(size, Image.Resampling.BICUBIC, box=box)
        straight = ImageMath.lambda_eval(lambda v: v["c"] / (v["a"] + (v["a"] == 0)) + 0.5,
                                        c=weighted, a=resized_alpha)
        channels.append(straight.convert("L"))
    return Image.merge("RGBA", (*channels, resized_alpha.convert("L")))


def remap_pages(old: Atlas, new: Atlas, mod_pages: dict[str, Image.Image],
                official_pages: dict[str, Image.Image]) -> tuple[dict[str, Image.Image], dict]:
    """Return new page pixels and names of moved, official-only and dropped regions."""
    output = {name: official_pages[texture_key(name)].convert("RGBA").copy() for name in new.pages}
    moved, added = [], []
    for key, target in new.regions.items():
        target_page = new.pages[target.page]
        destination = output[target.page]
        box = _box(target, target_page, destination)
        source = old.regions.get(key)
        if source is None:
            added.append(target.label)
            continue
        source_page = old.pages[source.page]
        image = mod_pages[texture_key(source.page)].convert("RGBA")
        cut = _rotate(image.crop(_box(source, source_page, image)), -source.degrees)
        # Work in the untrimmed coordinate space; offsets are measured from the bottom left.
        # Keep the source's physical resolution until the target crop is resampled.
        sx, sy = cut.width / source.size[0], cut.height / source.size[1]
        full = Image.new("RGBA", (round(source.original[0] * sx), round(source.original[1] * sy)))
        full.paste(cut, (round(source.offset[0] * sx),
                        round((source.original[1] - source.offset[1] - source.size[1]) * sy)))
        tx, ty = full.width / target.original[0], full.height / target.original[1]
        crop = (target.offset[0] * tx, (target.original[1] - target.offset[1] - target.size[1]) * ty,
                (target.offset[0] + target.size[0]) * tx, (target.original[1] - target.offset[1]) * ty)
        size = box[2] - box[0], box[3] - box[1]
        if target.degrees % 180:
            size = size[::-1]
        cut = _resize(full, size, crop, source_page.pma)
        cut = _alpha(cut, source_page.pma, target_page.pma)
        destination.paste(_rotate(cut, target.degrees), box[:2])
        moved.append(target.label)
    return output, {"moved": sorted(moved), "added": sorted(added),
                    "dropped": sorted(region.label for key, region in old.regions.items() if key not in new.regions)}


@dataclass
class Inputs:
    atlases: dict[str, bytes] = field(default_factory=dict)
    skeletons: dict[str, bytes] = field(default_factory=dict)
    textures: dict[str, Image.Image] = field(default_factory=dict)
    keys: dict[str, ContNameTypeKey] = field(default_factory=dict)


def read_inputs(paths: list[Path]) -> Inputs:
    result = Inputs()
    for path in paths:
        devmode.check_read(path)
        bundle = Bundle.load(path)
        if bundle is None:
            raise ValueError("Invalid bundle")
        for obj in bundle.env.objects:
            if obj.type.name not in ("TextAsset", "Texture2D"):
                continue
            data = obj.read()
            name = data.m_Name
            if obj.type.name == "Texture2D":
                key = texture_key(name)
                if key in result.textures:
                    raise ValueError("Ambiguous texture page")
                result.textures[key] = data.image.convert("RGBA")
                result.keys[key] = ContNameTypeKey(obj.container, name, "Texture2D")
            elif name.lower().endswith((".atlas", ".skel")):
                raw = data.m_Script
                raw = raw if isinstance(raw, bytes) else raw.encode("utf-8", "surrogateescape")
                collection = result.atlases if name.lower().endswith(".atlas") else result.skeletons
                if name in collection:
                    raise ValueError("Ambiguous Spine asset")
                collection[name] = raw
    return result


def skeleton_warnings(old: dict[str, bytes], new: dict[str, bytes]) -> list[dict]:
    warnings = []
    pairs = pair_atlases(old, new)
    for name, target in new.items():
        source = old.get(pairs.get(name, ""))
        if source is None:
            warnings.append({"key": "rig", "name": name})
            continue
        if get_skel_version(source) != get_skel_version(target):
            warnings.append({"key": "version", "name": name})
        if source == target:
            continue
        try:
            left, right = json.loads(source), json.loads(target)
            if not isinstance(left, dict) or not isinstance(right, dict):
                raise ValueError("Invalid skeleton object")
            for field in ("bones", "slots", "skins"):
                if left.get(field) != right.get(field):
                    warnings.append({"key": "rig", "name": name})
                    break
        except (ValueError, UnicodeError):
            # Binary geometry is inspected by the bundled web runtime. Opaque differences
            # must remain a partial result for engine callers as well.
            warnings.append({"key": "rig", "name": name})
    return warnings


def prepare_patch(mod: Inputs, official: Inputs) -> tuple[Patch, dict]:
    pairs = pair_atlases(mod.atlases, official.atlases)
    if not pairs:
        raise ValueError("No matching atlases in the mod")
    patch = {}
    report = {"moved": [], "added": [], "dropped": [], "warnings": skeleton_warnings(mod.skeletons, official.skeletons)}
    current_pages = dict(official.textures)
    for name, text in official.atlases.items():
        target = parse_atlas(text)
        if name not in pairs:
            report["added"].extend(r.label for r in target.regions.values())
            continue
        source = parse_atlas(mod.atlases[pairs[name]])
        pages, summary = remap_pages(source, target, mod.textures, current_pages)
        for page, image in pages.items():
            key = texture_key(page)
            current_pages[key] = image
            patch[official.keys[key]] = image
        for key in ("moved", "added", "dropped"):
            report[key].extend(f"{name}: {region}" for region in summary[key])
    for name in mod.atlases.keys() - set(pairs.values()):
        report["dropped"].extend(f"{name}: {r.label}" for r in parse_atlas(mod.atlases[name]).regions.values())
    report["partial"] = bool(report["warnings"])
    return patch, report
