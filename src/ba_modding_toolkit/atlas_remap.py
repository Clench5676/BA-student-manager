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


class RemapError(ValueError):
    """A remap failure with locale parameters, including the offending asset."""

    def __init__(self, code: str, **params):
        super().__init__(f"{code}: {params}")
        self.code, self.params = code, params


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
    regions: dict[tuple[str, str, int], Region] = field(default_factory=dict)
    file: str = field(default="—", compare=False)


def parse_atlas(text: str | bytes, file: str = "—") -> Atlas:
    """Read legacy xy/size/orig/offset and modern bounds/offsets syntax."""
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8-sig")
        except UnicodeError as error:
            raise RemapError("atlas_remap_property", file=file, page="—", region="—",
                             field="UTF-8", value="—") from error
    atlas = Atlas(file=file)
    page = None
    name = None
    props = {}
    page_start = True

    def invalid(key: str, value: str) -> RemapError:
        return RemapError("atlas_remap_property", file=file, page=page.name if page else "—",
                          region=name or "—", field=key, value=value)

    def numbers(key: str, default: tuple) -> tuple:
        if key not in props:
            return default
        try:
            values = tuple(int(v.strip()) for v in props[key].split(","))
        except ValueError as error:
            raise invalid(key, props[key]) from error
        if len(values) != len(default):
            raise invalid(key, props[key])
        return values

    def flush() -> None:
        if name is None:
            return
        bounds = numbers("bounds", numbers("xy", (0, 0)) + numbers("size", (0, 0)))
        offsets = numbers("offsets", numbers("offset", (0, 0)) + numbers("orig", bounds[2:]))
        rotation = props.get("rotate", "false").lower()
        degrees = {"true": 90, "false": 0}.get(rotation)
        if degrees is None:
            try:
                degrees = int(rotation) % 360
            except ValueError as error:
                raise invalid("rotate", rotation) from error
        if degrees not in (0, 90, 180, 270):
            raise invalid("rotate", rotation)
        index, = numbers("index", (-1,))
        region = Region(name, index, page.name, bounds[:2], bounds[2:],
                        offsets[2:], offsets[:2], degrees)
        if min(*region.size, *region.original) <= 0 or min(*region.xy, *region.offset) < 0:
            raise invalid("bounds/offsets", f"{bounds}/{offsets}")
        if any(o + s > original for o, s, original in zip(region.offset, region.size, region.original)):
            raise invalid("offsets/orig", f"{offsets}/{region.size}")
        key = (region.page, *region.key)
        if key in atlas.regions:
            raise RemapError("atlas_remap_region_ambiguous", file=file, region=region.label, pages=region.page)
        atlas.regions[key] = region

    for line_number, raw in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        line = raw.strip()
        if not line:
            flush()
            name, props, page_start = None, {}, True
        elif page_start:
            if ":" in line:
                raise RemapError("atlas_remap_structure", file=file, line=line_number, value=line)
            if line in atlas.pages:
                raise RemapError("atlas_remap_page_ambiguous", file=file, page=line)
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
                try:
                    page.size = tuple(int(v.strip()) for v in value.split(","))
                except ValueError as error:
                    raise invalid(key, value) from error
                if len(page.size) != 2 or min(page.size) <= 0:
                    raise invalid(key, value)
            elif key == "pma":
                page.pma = value.lower() == "true"
            elif key == "format":
                page.format = value
    flush()
    if not atlas.pages:
        raise RemapError("atlas_remap_structure", file=file, line=1, value="—")
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
        left, right = parse_atlas(old[pairs[name]], pairs[name]), parse_atlas(data, name)
        if left != right:
            changes.append(name)
    return sorted(changes)


def _box(region: Region, page: Page, image: Image.Image, file: str = "—") -> tuple[int, int, int, int]:
    width, height = region.size[::-1] if region.degrees % 180 else region.size
    declared = page.size if all(page.size) else image.size
    sx, sy = image.width / declared[0], image.height / declared[1]
    x, y = region.xy
    box = round(x * sx), round(y * sy), round((x + width) * sx), round((y + height) * sy)
    if box[0] < 0 or box[1] < 0 or box[2] > image.width or box[3] > image.height:
        raise RemapError("atlas_remap_bounds", file=file, region=region.label, page=page.name,
                         width=image.width, height=image.height)
    if box[0] >= box[2] or box[1] >= box[3]:
        raise RemapError("atlas_remap_property", file=file, page=page.name, region=region.label,
                         field="bounds", value=str(box))
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


def _pair_regions(old: Atlas, new: Atlas) -> dict[tuple[str, str, int], Region]:
    """Unique names can move pages; repeated names are identified by page order."""
    result = {}
    old_order = {page: i for i, page in enumerate(old.pages)}
    new_order = {page: i for i, page in enumerate(new.pages)}
    sources, targets = {}, {}
    for region in old.regions.values():
        sources.setdefault(region.key, []).append(region)
    for key, region in new.regions.items():
        targets.setdefault(region.key, []).append((key, region))
    for identity in targets:
        left, right = list(sources.get(identity, [])), list(targets[identity])
        if len(left) == len(right) == 1:
            result[right[0][0]] = left[0]
            continue
        for key, target in right[:]:
            source = next((r for r in left if old_order[r.page] == new_order[target.page]), None)
            if source is not None:
                result[key] = source
                left.remove(source)
                right.remove((key, target))
        if left and right:
            if len(left) == len(right) == 1:
                result[right[0][0]] = left[0]
            else:
                raise RemapError("atlas_remap_region_ambiguous", file=old.file, region=left[0].label,
                                 pages=", ".join(r.page for r in left))
    return result


def _page_image(atlas: Atlas, page: str, images: dict[str, Image.Image]) -> Image.Image:
    image = images.get(texture_key(page))
    if image is None:
        raise RemapError("atlas_remap_page_missing", file=atlas.file, page=page)
    return image if image.mode == "RGBA" else image.convert("RGBA")


def remap_pages(old: Atlas, new: Atlas, mod_pages: dict[str, Image.Image],
                official_pages: dict[str, Image.Image]) -> tuple[dict[str, Image.Image], dict]:
    """Return new page pixels and names of moved, official-only and dropped regions."""
    for atlas, images in ((old, mod_pages), (new, official_pages)):
        keys = set()
        for page in atlas.pages:
            key = texture_key(page)
            if key in keys:
                raise RemapError("atlas_remap_page_ambiguous", file=atlas.file, page=page)
            keys.add(key)
            image = _page_image(atlas, page, images)
            for region in atlas.regions.values():
                if region.page == page:
                    _box(region, atlas.pages[page], image, atlas.file)
    pairs = _pair_regions(old, new)
    output = {name: _page_image(new, name, official_pages).copy() for name in new.pages}
    moved, added = [], []
    for key, target in new.regions.items():
        target_page = new.pages[target.page]
        destination = output[target.page]
        box = _box(target, target_page, destination, new.file)
        source = pairs.get(key)
        if source is None:
            added.append(target.label)
            continue
        source_page = old.pages[source.page]
        image = _page_image(old, source.page, mod_pages)
        cut = _rotate(image.crop(_box(source, source_page, image, old.file)), -source.degrees)
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
    matched = {(region.page, *region.key) for region in pairs.values()}
    return output, {"moved": sorted(moved), "added": sorted(added),
                    "dropped": sorted(region.label for key, region in old.regions.items() if key not in matched)}


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
            raise RemapError("bundle_invalid", file=path.name)
        for obj in bundle.env.objects:
            if obj.type.name not in ("TextAsset", "Texture2D"):
                continue
            data = obj.read()
            name = data.m_Name
            if obj.type.name == "Texture2D":
                key = texture_key(name)
                if key in result.textures:
                    raise RemapError("atlas_remap_page_ambiguous", file=path.name, page=name)
                try:
                    result.textures[key] = data.image.convert("RGBA")
                except (ValueError, EOFError, OSError) as error:
                    raise RemapError("atlas_remap_invalid", file=f"{path.name} - {name}",
                                     reason=str(error)) from error
                result.keys[key] = ContNameTypeKey(obj.container, name, "Texture2D")
            elif name.lower().endswith((".atlas", ".skel")):
                raw = data.m_Script
                raw = raw if isinstance(raw, bytes) else raw.encode("utf-8", "surrogateescape")
                collection = result.atlases if name.lower().endswith(".atlas") else result.skeletons
                if name in collection:
                    raise RemapError("atlas_remap_asset_ambiguous", file=path.name, name=name)
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
        raise RemapError("atlas_remap_atlas_missing", file=", ".join(official.atlases) or "*.atlas")
    patch = {}
    report = {"moved": [], "added": [], "dropped": [], "warnings": skeleton_warnings(mod.skeletons, official.skeletons)}
    current_pages = dict(official.textures)
    for name, text in official.atlases.items():
        target = parse_atlas(text, name)
        if name not in pairs:
            report["added"].extend(r.label for r in target.regions.values())
            continue
        source = parse_atlas(mod.atlases[pairs[name]], pairs[name])
        pages, summary = remap_pages(source, target, mod.textures, current_pages)
        for page, image in pages.items():
            key = texture_key(page)
            current_pages[key] = image
            if key not in official.keys:
                raise RemapError("atlas_remap_page_missing", file=name, page=page)
            patch[official.keys[key]] = image
        for key in ("moved", "added", "dropped"):
            report[key].extend(f"{name} - {region}" for region in summary[key])
    for name in mod.atlases.keys() - set(pairs.values()):
        report["dropped"].extend(f"{name} - {r.label}" for r in parse_atlas(mod.atlases[name], name).regions.values())
    report["partial"] = bool(report["warnings"])
    return patch, report
