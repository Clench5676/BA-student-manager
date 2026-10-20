"""Pixel-level repacking and UnityFS round trips, generated entirely in temporary folders."""

import json
import struct
from pathlib import Path

import pytest
from PIL import Image
from UnityPy.export import Texture2DConverter
from UnityPy.helpers import TypeTreeHelper
from UnityPy.helpers.Tpk import get_typetree_node
from UnityPy.streams import EndianBinaryWriter

from ba_modding_toolkit import atlas_remap as remap, core
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.i18n import I18n, t
from ba_modding_toolkit.models import ContNameTypeKey, SaveOptions
from ba_modding_toolkit.utils import CRCUtils

from test_library import setup_library


def atlas_text(pages, modern=False, pma=False):
    lines = []
    for name, size, regions in pages:
        lines.extend([name, f"size: {size[0]},{size[1]}", "format: RGBA8888", "filter: Linear,Linear",
                      f"pma: {str(pma).lower()}", "repeat: none"])
        for name, index, xy, size, original, offset, degrees in regions:
            lines.extend([name, f"  rotate: {'true' if degrees == 90 and not modern else degrees}"])
            if modern:
                lines.extend([f"  bounds: {xy[0]},{xy[1]},{size[0]},{size[1]}",
                              f"  offsets: {offset[0]},{offset[1]},{original[0]},{original[1]}"])
            else:
                lines.extend([f"  xy: {xy[0]},{xy[1]}", f"  size: {size[0]},{size[1]}",
                              f"  orig: {original[0]},{original[1]}", f"  offset: {offset[0]},{offset[1]}"])
            lines.append(f"  index: {index}")
        lines.append("")
    return "\n".join(lines) + "\n"


def pattern(size, seed):
    image = Image.new("RGBA", size)
    image.putdata([((x * 23 + seed) % 256, (y * 37 + seed) % 256, seed, 255)
                   for y in range(size[1]) for x in range(size[0])])
    return image


def pack(pages, art, scale=1):
    result = {}
    for name, size, regions in pages:
        image = Image.new("RGBA", (size[0] * scale, size[1] * scale))
        for name_, index, (x, y), (w, h), (ow, oh), (ox, oy), degrees in regions:
            cut = art[(name_, index)].crop((ox, oh - oy - h, ox + w, oh - oy))
            if degrees:
                cut = cut.rotate(degrees, expand=True)
            if scale != 1:
                cut = cut.resize((cut.width * scale, cut.height * scale), Image.Resampling.NEAREST)
            image.paste(cut, (x * scale, y * scale))
        result[remap.texture_key(name)] = image
    return result


@pytest.fixture
def repacked():
    old = [("old.png", (40, 32), [
        ("body", -1, (1, 1), (5, 3), (5, 3), (0, 0), 0),
        ("face", -1, (8, 1), (3, 5), (3, 5), (0, 0), 90),
        ("trim", -1, (1, 10), (3, 2), (7, 6), (2, 1), 0),
        ("frame", 0, (12, 10), (3, 2), (3, 2), (0, 0), 270),
        ("frame", 1, (18, 10), (3, 2), (3, 2), (0, 0), 180),
        ("removed", -1, (25, 10), (2, 2), (2, 2), (0, 0), 0)])]
    new = [("current.png", (32, 40), [
        ("body", -1, (20, 1), (5, 3), (5, 3), (0, 0), 90),
        ("face", -1, (1, 1), (3, 5), (3, 5), (0, 0), 0),
        ("trim", -1, (10, 10), (2, 2), (7, 6), (3, 1), 270),
        ("frame", 0, (2, 20), (3, 2), (3, 2), (0, 0), 180)]),
        ("extra.png", (16, 16), [
        ("frame", 1, (2, 2), (3, 2), (3, 2), (0, 0), 90),
        ("added", -1, (8, 8), (4, 3), (4, 3), (0, 0), 0)])]
    sizes = {(r[0], r[1]): r[4] for _, _, regions in old + new for r in regions}
    art = {key: pattern(size, i * 31 + 20) for i, (key, size) in enumerate(sizes.items())}
    # Transparent trimmed margins model the original source image, not the packing rectangle.
    trim = Image.new("RGBA", (7, 6))
    trim.paste(art[("trim", -1)].crop((2, 3, 5, 5)), (2, 3))
    art[("trim", -1)] = trim
    official_art = {key: Image.new("RGBA", size, (10, 20, 30, 255)) for key, size in sizes.items()}
    official_art[("added", -1)] = pattern((4, 3), 230)
    expected_art = {**art, ("added", -1): official_art[("added", -1)]}
    return old, new, art, official_art, expected_art


def assert_pages(actual, expected):
    assert set(actual) == {name + ".png" for name in expected}
    for name, image in expected.items():
        assert actual[name + ".png"].size == image.size
        assert actual[name + ".png"].tobytes() == image.tobytes(), name


def test_repack_positions_rotations_trims_indices_and_page_changes(repacked):
    old, new, art, official_art, expected_art = repacked
    output, report = remap.remap_pages(remap.parse_atlas(atlas_text(old)), remap.parse_atlas(atlas_text(new, True)),
                                      pack(old, art), pack(new, official_art))
    assert_pages(output, pack(new, expected_art))
    assert report == {"moved": ["body", "face", "frame [0]", "frame [1]", "trim"],
                      "added": ["added"], "dropped": ["removed"], "upscaled": []}


@pytest.mark.parametrize("degrees", [0, 90, 180, 270])
def test_page_density_and_original_size_scaling(degrees):
    old = [("old.png", (12, 12), [("part", -1, (1, 1), (2, 3), (2, 3), (0, 0), degrees)])]
    new = [("new.png", (24, 24), [("part", -1, (4, 4), (4, 6), (4, 6), (0, 0), (degrees + 90) % 360)])]
    # Solid colour makes the exact expected result independent of the resampling kernel.
    art = {("part", -1): Image.new("RGBA", (2, 3), (200, 80, 20, 128))}
    expected = {("part", -1): Image.new("RGBA", (4, 6), (200, 80, 20, 128))}
    output, _ = remap.remap_pages(remap.parse_atlas(atlas_text(old)), remap.parse_atlas(atlas_text(new, True)),
                                 pack(old, art, 2), pack(new, expected, 2))
    assert_pages(output, pack(new, expected, 2))


def test_half_size_fixture_path_names_duplicates_and_per_axis_page_scales():
    fixture = Path(__file__).parent / "fixtures" / "lobby" / "half-size-paths.atlas"
    old = remap.parse_atlas(fixture.read_bytes(), fixture.name)
    path = "Intro_Shoulder_L/Intro_Shoulder_L"
    assert len(old.pages) == 3 and len(old.regions) == 4
    assert len([r for r in old.regions.values() if r.name == path]) == 3
    mod = {"ch0261_home": Image.open(fixture.with_suffix(".png")).convert("RGBA"),
           "ch0261_home2": Image.new("RGBA", (10, 3)),
           "ch0261_home3": Image.new("RGBA", (4, 4))}
    mod["ch0261_home2"].paste("green", (1, 1, 3, 2))
    mod["ch0261_home3"].paste("magenta", (1, 1, 3, 3))
    new = [(f"current{i}.png", (16, 16), [(path, -1, (4, 4), (4, 4), (4, 4), (0, 0), 0)]) for i in range(3)]
    new[0][2].append(("Intro_R_leg_01", -1, (10, 10), (4, 4), (4, 4), (0, 0), 0))
    official = {f"current{i}": Image.new("RGBA", (16, 16), "blue") for i in range(3)}
    output, report = remap.remap_pages(old, remap.parse_atlas(atlas_text(new)), mod, official)
    for i, (page, box) in enumerate((("ch0261_home", (8, 8, 12, 12)),
                                    ("ch0261_home2", (2, 4, 6, 8)), ("ch0261_home3", (2, 2, 6, 6)))):
        scaled = mod[page].resize(old.pages[next(n for n in old.pages if remap.texture_key(n) == page)].size,
                                  Image.Resampling.LANCZOS)
        expected = scaled.crop(box)
        if i == 1:
            expected = expected.transpose(Image.Transpose.ROTATE_270)
        assert output[f"current{i}.png"].crop((4, 4, 8, 8)).tobytes() == expected.tobytes()
    assert output["current0.png"].crop((10, 10, 14, 14)).tobytes() == mod["ch0261_home"].resize(
        (16, 16), Image.Resampling.LANCZOS).crop((2, 2, 6, 6)).tobytes()
    assert report == {"moved": ["Intro_R_leg_01", path, path, path], "added": [], "dropped": [],
                      "upscaled": [{"page": name, "w": p.size[0], "h": p.size[1]} for name, p in old.pages.items()]}


@pytest.mark.parametrize("pma", [False, True])
def test_undersized_pages_are_resized_before_regions_are_placed(pma):
    source = [("mod.png", (16, 12), [("part", -1, (2, 2), (4, 6), (4, 6), (0, 0), 0)])]
    target = [("official.png", (20, 16), [("part", -1, (10, 4), (4, 6), (4, 6), (0, 0), 90)])]
    image = pattern((8, 6), 29)
    original = image.tobytes()
    official = pattern((10, 8), 13)
    output, report = remap.remap_pages(remap.parse_atlas(atlas_text(source, pma=pma)),
        remap.parse_atlas(atlas_text(target, pma=pma)), {"mod": image}, {"official": official})
    if pma:
        scaled = Image.frombytes("RGBA", (16, 12), Image.frombytes("RGBa", image.size, image.tobytes())
                                 .resize((16, 12), Image.Resampling.LANCZOS).tobytes())
        expected = Image.frombytes("RGBA", (20, 16), Image.frombytes("RGBa", official.size, official.tobytes())
                                   .resize((20, 16), Image.Resampling.LANCZOS).tobytes())
    else:
        scaled = image.resize((16, 12), Image.Resampling.LANCZOS)
        expected = official.resize((20, 16), Image.Resampling.LANCZOS)
    expected.paste(scaled.crop((2, 2, 6, 8)).transpose(Image.Transpose.ROTATE_90), (10, 4))
    assert output["official.png"].size == (20, 16)
    assert output["official.png"].tobytes() == expected.tobytes()
    assert image.size == (8, 6) and image.tobytes() == original
    assert report["upscaled"] == [{"page": "mod.png", "w": 16, "h": 12},
                                  {"page": "official.png", "w": 20, "h": 16}]


@pytest.mark.parametrize("change,code", [("rotation", "property"), ("duplicate", "region_ambiguous"),
                                        ("bounds", "bounds"), ("page", "page_missing")])
def test_remap_errors_identify_atlas_region_or_page(change, code):
    text = "page.png\nsize: 8,8\nIntro_A/Intro_A\n bounds: 2,2,4,4\n rotate: 0\n"
    if change == "rotation":
        text = text.replace("rotate: 0", "rotate: 45")
    elif change == "duplicate":
        text += "Intro_A/Intro_A\n bounds: 2,2,4,4\n"
    elif change == "bounds":
        text = text.replace("2,2,4,4", "7,7,4,4")
    with pytest.raises(remap.RemapError) as caught:
        atlas = remap.parse_atlas(text, "CH0261_home.atlas")
        remap.remap_pages(atlas, atlas, {} if change == "page" else {"page": Image.new("RGBA", (4, 4))},
                          {"page": Image.new("RGBA", (8, 8))})
    assert caught.value.code == "atlas_remap_" + code
    assert caught.value.params["file"] == "CH0261_home.atlas"
    assert "page.png" in str(caught.value.params)
    if change != "page":
        assert caught.value.params["region"] == "Intro_A/Intro_A"


def test_duplicate_names_without_a_unique_page_order_match_are_ambiguous():
    region = ("same/path", -1, (0, 0), (2, 2), (2, 2), (0, 0), 0)
    old = [(f"old{i}.png", (8, 8), [region]) for i in range(2)]
    new = [(f"new{i}.png", (8, 8), [] if i < 2 else [region]) for i in range(3)]
    with pytest.raises(remap.RemapError, match="atlas_remap_region_ambiguous") as caught:
        remap.remap_pages(remap.parse_atlas(atlas_text(old), "mod.atlas"), remap.parse_atlas(atlas_text(new)),
                          {f"old{i}": Image.new("RGBA", (8, 8)) for i in range(2)},
                          {f"new{i}": Image.new("RGBA", (8, 8)) for i in range(3)})
    assert caught.value.params == {"file": "mod.atlas", "region": "same/path", "pages": "old0.png, old1.png"}


@pytest.mark.parametrize("source_pma,target_pma,colour,expected", [
    (False, True, (200, 100, 50, 128), (100, 50, 25, 128)),
    (True, False, (100, 50, 25, 128), (199, 99, 49, 128)),
    (True, True, (100, 50, 25, 128), (100, 50, 25, 128)),
])
def test_premultiplied_alpha(source_pma, target_pma, colour, expected):
    pages = [("page.png", (8, 8), [("part", -1, (1, 1), (3, 2), (3, 2), (0, 0), 0)])]
    output, _ = remap.remap_pages(remap.parse_atlas(atlas_text(pages, pma=source_pma)),
        remap.parse_atlas(atlas_text(pages, pma=target_pma)),
        {"page": Image.new("RGBA", (8, 8), colour)}, {"page": Image.new("RGBA", (8, 8))})
    assert set(output["page.png"].crop((1, 1, 4, 3)).getdata()) == {expected}


def test_trim_expansion_restores_transparent_margins():
    old = [("page.png", (16, 16), [("part", -1, (1, 1), (2, 2), (6, 6), (2, 1), 0)])]
    new = [("page.png", (16, 16), [("part", -1, (8, 8), (6, 6), (6, 6), (0, 0), 0)])]
    full = Image.new("RGBA", (6, 6))
    full.paste((255, 100, 20, 255), (2, 3, 4, 5))
    output, _ = remap.remap_pages(remap.parse_atlas(atlas_text(old)), remap.parse_atlas(atlas_text(new)),
        pack(old, {("part", -1): full}), pack(new, {("part", -1): Image.new("RGBA", (6, 6), "blue")}))
    assert output["page.png"].crop((8, 8, 14, 14)).tobytes() == full.tobytes()


@pytest.mark.parametrize("change", ["rotation", "duplicate", "bounds", "trim"])
def test_ambiguous_or_invalid_regions_are_refused(change):
    region = ("part", -1, (1, 1), (2, 2), (2, 2), (0, 0), 0)
    text = atlas_text([("page.png", (8, 8), [region])])
    if change == "rotation":
        text = text.replace("rotate: 0", "rotate: 45")
    elif change == "duplicate":
        text = atlas_text([("page.png", (8, 8), [region, region])])
    elif change == "trim":
        text = text.replace("offset: 0,0", "offset: 2,2")
    else:
        text = text.replace("xy: 1,1", "xy: 7,7")
    with pytest.raises(ValueError):
        atlas = remap.parse_atlas(text)
        remap.remap_pages(atlas, atlas, {"page": Image.new("RGBA", (8, 8))}, {"page": Image.new("RGBA", (8, 8))})


def test_skeleton_rig_and_version_warnings():
    skeleton = {"skeleton": {"spine": "4.2.33"}, "bones": [{"name": "root"}],
                "skins": [{"name": "default", "attachments": {"slot": {"part": {"type": "mesh", "uvs": [0, 0], "vertexCount": 1}}}}]}
    raw = json.dumps(skeleton).encode()
    assert remap.skeleton_warnings({"test.skel": raw}, {"test.skel": raw}) == []
    for field in ("bones", "skins"):
        altered = {**skeleton, field: []}
        assert remap.skeleton_warnings({"test.skel": json.dumps(altered).encode()}, {"test.skel": raw}) == [{"key": "rig", "name": "test.skel"}]
    altered = {**skeleton, "skeleton": {"spine": "3.8.99"}}
    assert remap.skeleton_warnings({"test.skel": json.dumps(altered).encode()}, {"test.skel": raw}) == [{"key": "version", "name": "test.skel"}]
    assert remap.skeleton_warnings({"test.skel": b"4.2.33 changed"}, {"test.skel": b"4.2.33 original"}) == [{"key": "rig", "name": "test.skel"}]


def _tree_default(node):
    if node.m_Type == "string":
        return ""
    if node.m_Type == "TypelessData":
        return b""
    if node.m_Children and node.m_Children[0].m_Type == "Array":
        return []
    if node.m_Children:
        return {child.m_Name: _tree_default(child) for child in node.m_Children}
    return 0


def write_bundle(path, atlases, textures, skeleton=b'{"skeleton":{"spine":"4.2.33"},"bones":[{"name":"root"}]}', texture_format=4):
    """Build real UnityFS bytes with UnityPy's shipped Unity 2021 type information."""
    entries = []
    texts = {**atlases, **({"test.skel": skeleton} if skeleton is not None else {})}
    for name, data in texts.items():
        entries.append((49, {"m_Name": name, "m_Script": data.decode() if isinstance(data, bytes) else data}))
    for name, image in textures.items():
        pixels, encoded_format = Texture2DConverter.image_to_texture2d(image, texture_format)
        entries.append((28, {"m_Name": name, "m_Width": image.width, "m_Height": image.height,
            "m_TextureFormat": int(encoded_format), "m_MipCount": 1, "m_ImageCount": 1, "m_TextureDimension": 2,
            "m_CompleteImageSize": len(pixels), "image data": pixels}))
    blobs = []
    for class_id, values in entries:
        node = get_typetree_node(class_id, (2021, 3, 0, 0))
        tree = _tree_default(node)
        tree.update(values)
        writer = EndianBinaryWriter(endian="<")
        TypeTreeHelper.write_typetree(tree, node, writer)
        blobs.append(writer.bytes)
    metadata = EndianBinaryWriter(endian="<")
    metadata.write_string_to_null("2021.3.0f1")
    metadata.write_int(19)
    metadata.write_boolean(False)
    metadata.write_int(len(entries))
    for class_id, _ in entries:
        metadata.write_int(class_id)
        metadata.write_boolean(False)
        metadata.write_short(-1)
        metadata.write(bytes(16))
    metadata.write_int(len(entries))
    data = bytearray()
    for index, blob in enumerate(blobs):
        metadata.align_stream()
        metadata.write_long(index + 1)
        metadata.write_u_int(len(data))
        metadata.write_u_int(len(blob))
        metadata.write_int(index)
        data.extend(blob)
        data.extend(bytes(-len(data) % 8))
    metadata.write_int(0)
    metadata.write_int(0)
    metadata.write_string_to_null("")
    offset = (20 + len(metadata.bytes) + 15) // 16 * 16
    serialized = (struct.pack(">4I", len(metadata.bytes), offset + len(data), 17, offset) + bytes(4)
                  + metadata.bytes).ljust(offset, b"\0") + data
    info = bytes(16) + struct.pack(">iIIHiqqI", 1, len(serialized), len(serialized), 0, 1, 0, len(serialized), 0) + b"CAB-test\0"
    header = b"UnityFS\0" + struct.pack(">I", 7) + b"5.x.x\0" + b"2021.3.0f1\0"
    padding = bytes(-(len(header) + 20) % 16)
    header += struct.pack(">qIII", len(header) + 20 + len(padding) + len(info) + len(serialized), len(info), len(info), 64)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + padding + info + serialized)
    return path


@pytest.mark.parametrize("texture_format", [4, 3])
def test_unity_bundle_round_trip_uses_update_crc_and_official_rig(tmp_path, repacked, texture_format):
    old, new, art, official_art, expected_art = repacked
    name = "assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_123456.bundle"
    mod = write_bundle(tmp_path / "mod" / name, {"test.atlas": atlas_text(old)}, pack(old, art), b'3.8.99 modified rig')
    target_atlas = atlas_text(new, True)
    if texture_format == 3:
        target_atlas = target_atlas.replace("RGBA8888", "RGB888")
    official = write_bundle(tmp_path / "official" / name, {"test.atlas": target_atlas}, pack(new, official_art), texture_format=texture_format)
    before = mod.read_bytes(), official.read_bytes()
    patch, report = remap.prepare_patch(remap.read_inputs([mod]), remap.read_inputs([official]))
    output = tmp_path / "output"
    output.mkdir()
    result = core.process_mod_update([], [official], output, {"Texture2D"}, SaveOptions(perform_crc=True, compression="lz4"),
                                     match_strategy="cont_name_type", prepared_patch=patch)
    assert result.success, result.message
    built = result.file_pairs[0].output
    assert CRCUtils.compute_crc32(built.read_bytes()) == 123456
    actual = remap.read_inputs([built])
    expected = pack(new, expected_art)
    if texture_format == 3:
        expected = {name: image.convert("RGB").convert("RGBA") for name, image in expected.items()}
    assert_pages({name + ".png": image for name, image in actual.textures.items()}, expected)
    assert actual.atlases == remap.read_inputs([official]).atlases
    assert actual.skeletons == remap.read_inputs([official]).skeletons
    assert report["partial"] and {w["key"] for w in report["warnings"]} == {"version", "rig"}
    assert (mod.read_bytes(), official.read_bytes()) == before
    assert all(obj.read().m_TextureFormat == texture_format for obj in Bundle.load(built).env.objects if obj.type.name == "Texture2D")


def _official_name(path):
    crc = CRCUtils.compute_crc32(path.read_bytes())
    renamed = path.with_name(path.name.rsplit("_", 1)[0] + f"_{crc}.bundle")
    path.rename(renamed)
    return renamed


@pytest.mark.parametrize("official_source", ["kept", "backup"])
def test_library_remap_keeps_installed_official_copy_and_original_mod(setup_library, repacked, monkeypatch, official_source):
    env = setup_library
    old, new, art, official_art, expected_art = repacked
    env.original.unlink()
    current = _official_name(write_bundle(env.original, {"test.atlas": atlas_text(new, True)}, pack(new, official_art)))
    source = write_bundle(env.tmp / "upload" / current.name.replace("2026-01-01", "2025-01-01"),
                          {"test.atlas": atlas_text(old)}, pack(old, art))
    entry, = env.library.add([source])
    # Simulate the old mod being installed, with the verified current official copy kept by the library.
    kept = env.library._original_path(current) if official_source == "kept" else current.with_name(current.name + ".backup")
    kept.parent.mkdir(parents=True, exist_ok=True)
    kept.write_bytes(current.read_bytes())
    current.write_bytes(source.read_bytes())
    before = {path: path.read_bytes() for path in (current, kept, entry.file)}
    monkeypatch.setattr(env.settings, "crc_needed", lambda path: True)
    result = env.library.remap(entry.id)
    assert result.mod.id != entry.id
    assert result.mod.label == t("webui.remap.name", name=entry.label)
    assert env.library._records[result.mod.id]["repaired_from"] == entry.id
    env.library.rename(entry.id, "My painting")
    assert env.library._entry(env.library._records[result.mod.id]).label == t("webui.remap.name", name="My painting")
    env.library.rename(entry.id, "")
    assert len(env.library.mods()) == 2
    assert result.mod.date == "2026-01-01"
    assert not result.report["partial"]
    built = remap.read_inputs([result.mod.file])
    assert_pages({name + ".png": image for name, image in built.textures.items()}, pack(new, expected_art))
    assert built.atlases == remap.read_inputs([kept]).atlases
    assert built.skeletons == remap.read_inputs([kept]).skeletons
    assert CRCUtils.compute_crc32(result.mod.file.read_bytes()) == int(current.stem.rsplit("_", 1)[1])
    assert all(path.read_bytes() == content for path, content in before.items())
    assert result.compare.mod_id == result.mod.id
    assert any(asset.status == "changed" and asset.name == "test.atlas" for asset in result.compare.assets)
    assert result.to_json()["mod"]["id"] == result.mod.id


def test_library_remap_refuses_missing_dated_atlas_without_storing(setup_library, monkeypatch):
    env = setup_library
    env.original.unlink()
    pages = [("page.png", (8, 8), [("part", -1, (1, 1), (2, 2), (2, 2), (0, 0), 0)])]
    current = _official_name(write_bundle(env.original, {"test.atlas": atlas_text(pages)}, {"page": Image.new("RGBA", (8, 8))}))
    source = write_bundle(env.tmp / "upload" / current.name.replace("2026-01-01", "2025-01-01"), {},
                          {"page": Image.new("RGBA", (8, 8), "red")})
    entry, = env.library.add([source])
    from ba_modding_toolkit.errors import ServiceError
    with pytest.raises(ServiceError, match="atlas_remap_source_missing") as caught:
        env.library.remap(entry.id)
    assert caught.value.params == {"file": "test.atlas", "date": "2025-01-01"}
    assert [mod.id for mod in env.library.mods()] == [entry.id]
    assert not (entry.file.parent / "previous").exists()


def test_library_remap_missing_atlas_can_use_verified_current_copy_of_same_date(setup_library, monkeypatch):
    from ba_modding_toolkit.library import integrity

    env = setup_library
    env.original.unlink()
    pages = [("page.png", (8, 8), [("part/path", -1, (2, 2), (4, 4), (4, 4), (0, 0), 0)])]
    current = _official_name(write_bundle(env.original, {"test.atlas": atlas_text(pages)},
                                          {"page": Image.new("RGBA", (8, 8), "blue")}))
    source = write_bundle(env.tmp / "upload" / current.name, {}, {"page": Image.new("RGBA", (4, 4), "red")})
    entry, = env.library.add([source])
    monkeypatch.setattr(integrity, "inspect", lambda path: integrity.Contents(atlases=remap.read_inputs([path]).atlases))
    result = env.library.remap(entry.id)
    built = remap.read_inputs([result.mod.file])
    assert built.textures["page"].getpixel((2, 2)) == (255, 0, 0, 255)
    assert not result.report["partial"]
    assert current.read_bytes() != result.mod.file.read_bytes()


@pytest.mark.parametrize("date", ["2025-01-01", "2026-01-01"])
def test_library_remap_uses_only_kept_atlas_of_mod_date(setup_library, monkeypatch, date):
    from ba_modding_toolkit.library import integrity

    env = setup_library
    env.original.unlink()
    region = ("Intro_Shoulder_L/Intro_Shoulder_L", -1, (2, 2), (4, 4), (4, 4), (0, 0), 0)
    old = [("page.png", (16, 16), [region])]
    new = [("page.png", (16, 16), [(region[0], -1, (10, 10), *region[3:])])]
    current = _official_name(write_bundle(env.original, {"test.atlas": atlas_text(new)},
                                          {"page": Image.new("RGBA", (16, 16), "blue")}))
    dated_name = current.name.replace("2026-01-01", "2025-01-01")
    kept = _official_name(write_bundle(env.library.root / "originals" / dated_name,
                                       {"test.atlas": atlas_text(old)}, {"page": Image.new("RGBA", (16, 16))}))
    source = write_bundle(env.tmp / "upload" / dated_name, {}, {"page": Image.new("RGBA", (8, 8), "red")},
                          b'3.8.99 modified rig')
    entry, = env.library.add([source])
    if date != "2025-01-01":
        kept.rename(kept.with_name(kept.name.replace("2025-01-01", date)))
    monkeypatch.setattr(integrity, "inspect", lambda path: integrity.Contents(atlases=remap.read_inputs([path]).atlases))
    before = current.read_bytes(), entry.file.read_bytes()
    if date != "2025-01-01":
        from ba_modding_toolkit.errors import ServiceError
        with pytest.raises(ServiceError, match="atlas_remap_source_missing"):
            env.library.remap(entry.id)
        assert len(env.library.mods()) == 1
    else:
        result = env.library.remap(entry.id)
        built = remap.read_inputs([result.mod.file])
        assert built.textures["page"].getpixel((10, 10)) == (255, 0, 0, 255)
        assert built.textures["page"].getpixel((2, 2)) == (0, 0, 255, 255)
        assert result.report["partial"] and result.report["warnings"]
        assert built.atlases == {"test.atlas": atlas_text(new).encode()}
    assert before == (current.read_bytes(), entry.file.read_bytes())


def test_multiple_atlases_can_repaint_a_shared_page():
    first = [("page.png", (16, 16), [("first", -1, (1, 1), (2, 2), (2, 2), (0, 0), 0)])]
    second = [("page.png", (16, 16), [("second", -1, (8, 8), (2, 2), (2, 2), (0, 0), 0)])]
    old = Image.new("RGBA", (16, 16))
    old.paste((255, 0, 0, 255), (1, 1, 3, 3))
    old.paste((0, 255, 0, 255), (8, 8, 10, 10))
    mod = remap.Inputs(atlases={"first.atlas": atlas_text(first).encode(), "second.atlas": atlas_text(second).encode()},
                       textures={"page": old})
    official = remap.Inputs(atlases=dict(mod.atlases), textures={"page": Image.new("RGBA", (16, 16), "blue")},
                            keys={"page": "page"})
    patch, _ = remap.prepare_patch(mod, official)
    assert patch["page"].getpixel((1, 1)) == (255, 0, 0, 255)
    assert patch["page"].getpixel((8, 8)) == (0, 255, 0, 255)
    assert patch["page"].getpixel((4, 4)) == (0, 0, 255, 255)


def test_new_and_removed_whole_atlases_are_reported():
    text = atlas_text([("page.png", (8, 8), [("part", -1, (1, 1), (2, 2), (2, 2), (0, 0), 0)])]).encode()
    assert remap.layout_changes({"shared.atlas": text, "removed.atlas": text},
                               {"shared.atlas": text, "added.atlas": text, "extra.atlas": text}) == ["added.atlas", "extra.atlas", "removed.atlas"]


def test_library_remaps_split_bundles_and_keeps_official_text_part(setup_library, repacked):
    env = setup_library
    old, new, art, official_art, expected_art = repacked
    env.original.unlink()
    text_name = env.original.name.replace("2026-01-01_003", "textassets-2026-01-01")
    text_target = _official_name(write_bundle(env.original.with_name(text_name), {"test.atlas": atlas_text(new, True)}, {}))
    texture_target = _official_name(write_bundle(env.original, {}, pack(new, official_art), skeleton=None))
    sources = [write_bundle(env.tmp / "upload" / text_target.name.replace("2026-01-01", "2025-01-01"),
                            {"test.atlas": atlas_text(old)}, {}),
               write_bundle(env.tmp / "upload" / texture_target.name.replace("2026-01-01", "2025-01-01"),
                            {}, pack(old, art), skeleton=None)]
    entry, = env.library.add(sources)
    result = env.library.remap(entry.id)
    stored = sorted(result.mod.file.parent.glob("*.bundle"))
    assert {path.name for path in stored} == {text_target.name, texture_target.name}
    assert (result.mod.file.parent / text_target.name).read_bytes() == text_target.read_bytes()
    built = remap.read_inputs(stored)
    assert_pages({name + ".png": image for name, image in built.textures.items()}, pack(new, expected_art))
    assert built.atlases == {"test.atlas": atlas_text(new, True).encode()}
    assert len(env.library.mods()) == 2


@pytest.mark.parametrize("language", ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"])
def test_an_unapplied_prepared_page_refuses_the_build(tmp_path, monkeypatch, language):
    monkeypatch.setattr(core, "t", I18n(language).t)
    name = "assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_123.bundle"
    target = write_bundle(tmp_path / name, {}, {"page": Image.new("RGBA", (8, 8))})
    output = tmp_path / "out"
    output.mkdir()
    patch = {ContNameTypeKey(None, "page", "Texture2D"): Image.new("RGBA", (8, 8), "red"),
             ContNameTypeKey(None, "missing", "Texture2D"): Image.new("RGBA", (8, 8), "red")}
    result = core.process_mod_update([], [target], output, {"Texture2D"}, SaveOptions(perform_crc=False),
                                     match_strategy="cont_name_type", prepared_patch=patch)
    assert not result.success
    assert target.name in result.message
    assert "1/2" in result.message
    assert "{" not in result.message and "}" not in result.message
    assert not list(output.iterdir())


def test_unscaled_trim_crop_preserves_hidden_colour_channels():
    old = [("page.png", (16, 16), [("part", -1, (1, 1), (3, 3), (5, 5), (1, 1), 0)])]
    new = [("page.png", (16, 16), [("part", -1, (8, 8), (2, 2), (5, 5), (2, 1), 90)])]
    image = Image.new("RGBA", (5, 5), (123, 45, 67, 0))
    image.putpixel((2, 3), (200, 100, 50, 128))
    output, _ = remap.remap_pages(remap.parse_atlas(atlas_text(old)), remap.parse_atlas(atlas_text(new)),
                                 pack(old, {("part", -1): image}), {"page": Image.new("RGBA", (16, 16))})
    assert_pages(output, pack(new, {("part", -1): image}))
