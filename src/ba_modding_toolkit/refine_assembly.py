"""Assemble generated colour into official Spine geometry; no UI or generation service.

Region crops are unrotated, trimmed attachments. Box crops use atlas page coordinates
(left, top, right, bottom). Whole pages retain the official layout at any resolution.
Generated alpha requires an explicit projected-page option and edited mesh mask.
PMA defaults to the atlas declaration,
as in atlas_remap; callers with independent page metadata can override it explicitly.
"""

from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from . import atlas_remap as remap, core, devmode
from .bundle import Bundle
from .models import SaveOptions


@dataclass
class Assembly:
    image: Image.Image
    report: dict


def _centroid(image: Image.Image, alpha: Image.Image) -> tuple[float, float] | None:
    edges = ImageOps.grayscale(image).filter(ImageFilter.FIND_EDGES)
    # FIND_EDGES retains the image border; it is not an internal line measurement.
    ImageDraw.Draw(edges).rectangle((0, 0, edges.width - 1, edges.height - 1), outline=0)
    edges = ImageChops.multiply(edges, alpha)
    mass = xsum = ysum = 0
    for i, value in enumerate(edges.tobytes()):
        mass += value
        xsum += (i % edges.width) * value
        ysum += (i // edges.width) * value
    return (xsum / mass, ysum / mass) if mass else None


def misalignment(official: Image.Image, generated: Image.Image, *, pma: bool = False,
                 generated_pma: bool = False, pixel_scale: int = 1) -> dict:
    """Signed displacement of alpha-weighted internal luminance-edge centroids.

This is a colour-sensitive line-position diagnostic, not a registration estimate or
an acceptance score. Null means one image has no measurable internal edges. Both
images use the official mask, before replacement; no geometry is corrected.
"""
    mask = official.getchannel("A")
    left = _centroid(remap._alpha(official, pma, False), mask)
    right = _centroid(remap._alpha(generated, generated_pma, False), mask)
    dx, dy = ((right[0] - left[0]) / pixel_scale, (right[1] - left[1]) / pixel_scale) if left and right else (None, None)
    return {"edge_centroid_dx_px": dx, "edge_centroid_dy_px": dy,
            "edge_centroid_distance_px": math.hypot(dx, dy) if dx is not None else None}


def assemble_page(atlas: remap.Atlas, page_name: str, official: Image.Image, generated: Image.Image, *,
                  region: tuple[str, int] | None = None, box: tuple[int, int, int, int] | None = None,
                  scale: int = 1, generated_pma: bool = False, page_pma: bool | None = None) -> Assembly:
    """Replace RGB inside selected atlas rectangles, retaining every official alpha byte.

At integer enlargement the baseline uses nearest-neighbour replication, so untouched
pixels retain their exact RGBA values in each scale-by-scale block. Box edits are
clipped to the union of atlas regions. Whole-page overlaps/aliases are pasted once.
Atlas coordinates, trim offsets, original sizes and skeleton bytes never change.
"""
    if type(scale) is not int or scale < 1:
        raise ValueError("Page scale must be a positive integer")
    if region is not None and box is not None:
        raise ValueError("Choose a region or a page box, not both")
    if page_name not in atlas.pages:
        raise ValueError(f"Unknown atlas page: {page_name}")
    page = atlas.pages[page_name]
    official, generated = official.convert("RGBA"), generated.convert("RGBA")
    if not all(page.size) or remap.page_size_mismatch(
            {atlas.file: _page_header(page)}, {remap.texture_key(page_name): official.size}):
        raise ValueError("Official texture and declared page must have the same aspect ratio and a page size")
    pma = page.pma if page_pma is None else page_pma
    baseline = official.resize((official.width * scale, official.height * scale), Image.Resampling.NEAREST)
    regions = [r for r in atlas.regions.values() if r.page == page_name]
    for item in regions:
        remap._box(item, page, baseline, atlas.file)
    selected = regions
    rotation = 0
    if region is not None:
        selected = [r for r in regions if r.key == region]
        if len(selected) != 1:
            raise ValueError(f"Region is not uniquely identified on {page_name}: {region}")
        placement = remap._box(selected[0], page, baseline, atlas.file)
        rotation = selected[0].degrees
    elif box is not None:
        if (len(box) != 4 or any(type(v) is not int for v in box) or
                not (0 <= box[0] < box[2] <= page.size[0] and 0 <= box[1] < box[3] <= page.size[1])):
            raise ValueError("Page box must be integer left, top, right, bottom coordinates within the page")
        # _box supplies the same density mapping and rounding as atlas_remap.
        rect = remap.Region("box", -1, page_name, box[:2], (box[2] - box[0], box[3] - box[1]),
                            (box[2] - box[0], box[3] - box[1]), (0, 0))
        placement = remap._box(rect, page, baseline, atlas.file)
    else:
        placement = (0, 0, baseline.width, baseline.height)
    mask = Image.new("L", baseline.size)
    draw = ImageDraw.Draw(mask)
    affected = []
    for item in selected:
        bounds = remap._box(item, page, baseline, atlas.file)
        clipped = (max(bounds[0], placement[0]), max(bounds[1], placement[1]),
                   min(bounds[2], placement[2]), min(bounds[3], placement[3]))
        if clipped[0] < clipped[2] and clipped[1] < clipped[3]:
            draw.rectangle((clipped[0], clipped[1], clipped[2] - 1, clipped[3] - 1), fill=255)
            affected.append((item, clipped))
    if not affected:
        raise ValueError("No atlas region intersects the selected input")

    packed = remap._rotate(generated, rotation)
    size = (placement[2] - placement[0], placement[3] - placement[1])
    reference = baseline.crop(placement)
    # Avoid a lossy PMA unpremultiply/premultiply cycle for exact identity inputs.
    identity = packed.size == reference.size and packed.tobytes() == reference.tobytes()
    if identity:
        colour = reference
        diagnostic_pma = pma
    else:
        straight = remap._alpha(packed, generated_pma, False)
        # Alpha is discarded before resizing; it must not attenuate colour a second time.
        rgb = straight.convert("RGB").resize(size, Image.Resampling.LANCZOS)
        colour = rgb.convert("RGBA")
        colour.putalpha(reference.getchannel("A"))
        diagnostic_pma = False
    diagnostic = baseline.copy()
    diagnostic.paste(colour, placement[:2])
    metrics = []
    for item, clipped in affected:
        metrics.append({"region": item.label, "index": item.index, "box": list(clipped),
                        **misalignment(baseline.crop(clipped), diagnostic.crop(clipped), pma=pma,
                                       generated_pma=diagnostic_pma, pixel_scale=scale)})
    if not identity:
        colour = remap._alpha(colour, False, pma)
    candidate = baseline.copy()
    candidate.paste(colour, placement[:2])
    output = Image.composite(candidate, baseline, mask)
    changed = sum(a != b for a, b in zip(output.getdata(), baseline.getdata()))
    difference = ImageChops.difference(output, baseline).convert("RGB")
    changed_regions = [item.label for item in regions
                       if difference.crop(remap._box(item, page, baseline, atlas.file)).getbbox()]
    return Assembly(output, {"page": page_name, "page_size": list(output.size), "scale": scale,
                             "pma": pma, "generated_pma": generated_pma,
                             "mode": "region" if region is not None else "box" if box is not None else "page",
                             "changed_pixels": changed, "regions": metrics, "regions_changed": changed_regions,
                             "misalignment_units": "official texture pixels; edge centroid, not registration"})


def _page_header(page: remap.Page) -> str:
    return f"{page.name}\nsize: {page.size[0]},{page.size[1]}\n"


def _object_bytes(bundle: Bundle) -> dict:
    return {(obj.assets_file.name, obj.path_id): obj.get_raw_data() for obj in bundle.env.objects}


def assemble_mod(official_bundles: list[Path], generated: Path | Image.Image, output_dir: Path, *,
                 atlas_name: str, page_name: str, region: tuple[str, int] | None = None,
                 box: tuple[int, int, int, int] | None = None, scale: int = 1,
                 generated_pma: bool = False, page_pma: bool | None = None,
                 projected: Assembly | None = None, allow_generated_alpha: bool = False,
                 edited_mesh_mask: Image.Image | None = None) -> dict:
    """Build one released-form texture mod, with its official name, LZ4 and fixed CRC.

Supply all official portrait parts, including atlas and skeleton. Only the bundle
containing the selected page is emitted. Edited textures are stored as RGBA32 to
avoid BC7/etc. re-encoding changes to untouched pixels and alpha. This uses the same
lossless format policy as library.portrait_edit, then the existing named-PNG packer.
The output directory must not already contain the target file.
"""
    if type(scale) is not int or scale < 1:
        raise ValueError("Page scale must be a positive integer")
    if allow_generated_alpha and projected is None:
        raise ValueError("Generated alpha requires a projected page")
    paths = [Path(path).resolve() for path in official_bundles]
    inputs = remap.read_inputs(paths)
    if atlas_name not in inputs.atlases or atlas_name not in remap.pair_atlases(inputs.skeletons, {atlas_name: b""}):
        raise ValueError("An identified official atlas and matching skeleton are required")
    atlas = remap.parse_atlas(inputs.atlases[atlas_name], atlas_name)
    if page_name not in atlas.pages:
        raise ValueError(f"Unknown atlas page: {page_name}")
    key = remap.texture_key(page_name)
    matches = []
    atlas_count = 0
    for path in paths:
        bundle = Bundle.load(path)
        if bundle is None:
            raise ValueError(f"Cannot load official bundle: {path.name}")
        for obj in bundle.env.objects:
            if obj.type.name == "TextAsset" and obj.peek_name() == atlas_name:
                atlas_count += 1
            if obj.type.name == "Texture2D" and remap.texture_key(obj.peek_name()) == key:
                matches.append((path, bundle, obj))
    if atlas_count != 1 or len(matches) != 1:
        raise ValueError("Atlas and page texture must each have exactly one official owner")
    source, bundle, obj = matches[0]
    texture = obj.read()
    official = texture.image.convert("RGBA")
    if isinstance(generated, Path):
        devmode.check_read(generated)
        with Image.open(generated) as image:
            image = image.convert("RGBA")
    else:
        image = generated
    if projected is None:
        assembly = assemble_page(atlas, page_name, official, image, region=region, box=box,
                                 scale=scale, generated_pma=generated_pma, page_pma=page_pma)
    else:
        # Composite projection already preserves colour/alpha. Validate the K4
        # invariants without another PMA conversion or resampling pass.
        baseline = official.resize((official.width * scale, official.height * scale), Image.Resampling.NEAREST)
        if projected.image.mode != "RGBA" or projected.image.size != baseline.size:
            raise ValueError("Projected page must be RGBA at the requested integer scale")
        alpha_diff = ImageChops.difference(projected.image.getchannel("A"), baseline.getchannel("A"))
        if allow_generated_alpha:
            mesh = edited_mesh_mask if edited_mesh_mask is not None else projected.report.get("edited_mesh_mask")
            if not isinstance(mesh, Image.Image) or mesh.mode != "L" or mesh.size != baseline.size:
                raise ValueError("Generated alpha requires an L mask of edited meshes at page size")
            if any(value not in (0, 255) for value in mesh.tobytes()):
                raise ValueError("Edited mesh mask must be binary")
            if ImageChops.multiply(alpha_diff, ImageChops.invert(mesh)).getbbox():
                raise ValueError("Projected alpha changed outside edited meshes")
        elif alpha_diff.getbbox():
            raise ValueError("Projected page changed official alpha")
        mask = Image.new("L", baseline.size)
        draw = ImageDraw.Draw(mask)
        for item in atlas.regions.values():
            if item.page == page_name:
                l, t, r, b = remap._box(item, atlas.pages[page_name], baseline)
                draw.rectangle((l, t, r - 1, b - 1), fill=255)
        outside = Image.composite(baseline, projected.image, mask)
        if outside.tobytes() != baseline.tobytes():
            raise ValueError("Projected page changed pixels outside official regions")
        assembly = projected
    output_dir = Path(output_dir).resolve()
    target = output_dir / source.name
    devmode.check_write(target)
    if target in paths or target.exists():
        raise ValueError("Assembly output must be a new file outside the official inputs")
    output_dir.mkdir(parents=True, exist_ok=True)
    name = texture.m_Name
    if Path(name).name != name or name in ("", ".", "..") or "\\" in name:
        raise ValueError("Texture name cannot be represented by a named PNG")
    before = _object_bytes(bundle)
    edited = assembly.image.size != official.size or assembly.image.tobytes() != official.tobytes()
    options = SaveOptions(perform_crc=True, extra_bytes=b"\x08\x08\x08\x08", compression="lz4")
    with tempfile.TemporaryDirectory(prefix="bamt-refine-") as temporary:
        scratch = Path(temporary)
        base = source
        if edited:
            # The PNG packer retains its target's format. Stage only this page as
            # RGBA32 first, so the packer's replacement itself remains lossless.
            texture.set_image(official, target_format=4, mipmap_count=max(1, texture.m_MipCount or 1))
            texture.save()
            base = scratch / source.name
            ok, message = bundle.save(base, SaveOptions(compression="lz4"))
            if not ok:
                raise ValueError(f"Cannot stage lossless page: {message}")
        png = scratch / f"{name}.png"
        assembly.image.save(png)
        ok, message, pairs = core.process_asset_packing([base], [png], output_dir, options,
                                                       skip_unchanged=False)
        if not ok or len(pairs) != 1 or Path(pairs[0].output) != target:
            target.unlink(missing_ok=True)
            raise ValueError(f"Cannot pack assembled page: {message}")
    try:
        checked = Bundle.load(target)
        if checked is None or not Bundle.check_crc_match(target):
            raise ValueError("Assembled bundle failed reload or CRC verification")
        after = _object_bytes(checked)
        changed_key = (obj.assets_file.name, obj.path_id)
        if before.keys() != after.keys() or any(before[k] != after[k] for k in before if k != changed_key):
            raise ValueError("Assembly changed an unrelated official object")
        result = next(item.read() for item in checked.env.objects
                      if (item.assets_file.name, item.path_id) == changed_key)
        decoded = result.image.convert("RGBA")
        if decoded.size != assembly.image.size or decoded.tobytes() != assembly.image.tobytes():
            raise ValueError("Packed texture pixels differ from assembled pixels")
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return {**assembly.report, "bundle": target.name, "texture_format": int(result.m_TextureFormat)}
