"""Generated inputs and real UnityFS fixtures; optional read-only official-view checks."""

import os
from pathlib import Path

import pytest
from PIL import Image

from ba_modding_toolkit import atlas_remap as remap
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.refine_assembly import assemble_mod, assemble_page, misalignment

from test_atlas_remap import atlas_text, pattern, write_bundle


def atlas(degrees=0, pma=False):
    regions = [("body", -1, (4, 3), (6, 4), (9, 12), (1, 2), degrees),
               ("alias", -1, (4, 3), (6, 4), (6, 4), (0, 0), degrees),
               ("face", 0, (2, 12), (3, 2), (3, 2), (0, 0), 0)]
    return remap.parse_atlas(atlas_text([("page.png", (20, 18), regions)], pma=pma), "hero.atlas")


def page(pma=False):
    result = pattern((20, 18), 71)
    result.putalpha(Image.frombytes("L", result.size, bytes((i * 17) % 256 for i in range(360))))
    return remap._alpha(result, False, pma)


def assert_outside(actual, baseline, boxes):
    for y in range(actual.height):
        for x in range(actual.width):
            if not any(l <= x < r and t <= y < b for l, t, r, b in boxes):
                assert actual.getpixel((x, y)) == baseline.getpixel((x, y)), (x, y)


@pytest.mark.parametrize("pma", [False, True])
@pytest.mark.parametrize("scale", [1, 2])
def test_whole_page_preserves_alpha_and_every_unprocessed_pixel(pma, scale):
    official = page(pma)
    generated = Image.new("RGBA", (57, 61), (200, 100, 50, 7))
    source = atlas(pma=pma)
    output = assemble_page(source, "page.png", official, generated, scale=scale)
    baseline = official.resize(output.image.size, Image.Resampling.NEAREST)
    boxes = [remap._box(r, source.pages[r.page], baseline) for r in source.regions.values()]
    assert_outside(output.image, baseline, boxes)
    assert output.image.getchannel("A").tobytes() == baseline.getchannel("A").tobytes()
    pixel = output.image.getpixel((5 * scale, 4 * scale))
    expected = Image.new("RGBA", (1, 1), (200, 100, 50, pixel[3]))
    assert pixel == remap._alpha(expected, False, pma).getpixel((0, 0))
    assert output.report["changed_pixels"] > 0
    assert len(output.report["regions"]) == 3
    assert generated.getpixel((0, 0)) == (200, 100, 50, 7)
    assert official.tobytes() == page(pma).tobytes()


@pytest.mark.parametrize("pma", [False, True])
@pytest.mark.parametrize("degrees", [0, 90, 180, 270])
def test_identity_and_unrotated_region_identity_are_exact_even_for_partial_alpha(pma, degrees):
    source, official = atlas(degrees, pma), page(pma)
    whole = assemble_page(source, "page.png", official, official.copy())
    assert whole.image.tobytes() == official.tobytes()
    assert whole.report["changed_pixels"] == 0
    region = source.regions[("page.png", "body", -1)]
    crop = remap._rotate(official.crop(remap._box(region, source.pages[region.page], official)), -degrees)
    output = assemble_page(source, "page.png", official, crop, region=region.key, generated_pma=pma)
    assert output.image.tobytes() == official.tobytes()


@pytest.mark.parametrize("degrees", [0, 90, 180, 270])
@pytest.mark.parametrize("scale", [1, 2])
def test_region_crop_placement_rotation_and_extra_resolution(degrees, scale):
    source = atlas(degrees)
    official = Image.new("RGBA", (20, 18), (13, 17, 19, 128))
    # Exactly the target density, with distinct pixels that must survive without downsampling.
    crop = pattern((6 * scale, 4 * scale), 42)
    output = assemble_page(source, "page.png", official, crop, region=("body", -1), scale=scale)
    bounds = remap._box(source.regions[("page.png", "body", -1)], source.pages["page.png"], output.image)
    expected = remap._rotate(crop, degrees)
    expected.putalpha(128)
    assert output.image.crop(bounds).tobytes() == expected.tobytes()
    assert_outside(output.image, official.resize(output.image.size, Image.Resampling.NEAREST), [bounds])
    assert [m["region"] for m in output.report["regions"]] == ["body"]
    assert output.report["regions_changed"] == ["body", "alias"]


@pytest.mark.parametrize("scale", [1, 2])
def test_box_placement_is_in_page_coordinates_and_clips_padding_and_other_regions(scale):
    source, official = atlas(), page()
    generated = Image.new("RGBA", (31, 29), (201, 11, 61, 0))
    output = assemble_page(source, "page.png", official, generated, box=(3, 2, 8, 6), scale=scale)
    baseline = official.resize(output.image.size, Image.Resampling.NEAREST)
    assert_outside(output.image, baseline, [(4 * scale, 3 * scale, 8 * scale, 6 * scale)])
    assert output.image.getpixel((4 * scale, 3 * scale))[:3] == (201, 11, 61)
    assert output.image.getchannel("A").tobytes() == baseline.getchannel("A").tobytes()
    assert {m["region"] for m in output.report["regions"]} == {"body", "alias"}


def test_generated_pma_is_unpremultiplied_before_official_alpha_is_applied():
    official = Image.new("RGBA", (20, 18), (0, 0, 0, 255))
    generated = Image.new("RGBA", (6, 4), (100, 50, 25, 128))
    output = assemble_page(atlas(), "page.png", official, generated, region=("body", -1), generated_pma=True)
    assert output.image.getpixel((4, 3)) == (199, 99, 49, 255)


def test_rotated_crop_of_arbitrary_size_is_fitted_before_placement():
    source, official = atlas(90), page()
    generated = pattern((37, 29), 33)
    output = assemble_page(source, "page.png", official, generated, region=("body", -1))
    expected = generated.convert("RGB").transpose(Image.Transpose.ROTATE_90).resize((4, 6), Image.Resampling.LANCZOS)
    assert output.image.crop((4, 3, 8, 9)).convert("RGB").tobytes() == expected.tobytes()


def test_explicit_page_pma_override_uses_independent_metadata():
    official = Image.new("RGBA", (20, 18), (10, 20, 30, 128))
    output = assemble_page(atlas(), "page.png", official, Image.new("RGBA", (6, 4), (200, 100, 50, 255)),
                           region=("body", -1), page_pma=True)
    assert output.image.getpixel((4, 3)) == (100, 50, 25, 128)
    assert output.report["pma"] is True


def test_misalignment_reports_known_internal_line_shift_without_warping():
    left = Image.new("RGBA", (32, 24), "white")
    right = left.copy()
    left.paste("black", (8, 5, 10, 18))
    right.paste("black", (11, 7, 13, 20))
    report = misalignment(left, right)
    assert report["edge_centroid_dx_px"] == pytest.approx(3)
    assert report["edge_centroid_dy_px"] == pytest.approx(2)
    assert report["edge_centroid_distance_px"] == pytest.approx(13 ** 0.5)
    assert misalignment(Image.new("RGBA", (8, 8)), Image.new("RGBA", (8, 8)))["edge_centroid_dx_px"] is None


@pytest.mark.parametrize("kwargs", [{"scale": 1.5}, {"scale": 0}, {"scale": True},
    {"box": (-1, 0, 5, 5)}, {"box": (4, 3, 4, 5)}, {"box": (0, 0, 2, 2)},
    {"region": ("absent", -1)}, {"region": ("body", -1), "box": (4, 3, 6, 5)}])
def test_invalid_or_unidentified_targets_are_refused(kwargs):
    with pytest.raises(ValueError):
        assemble_page(atlas(), "page.png", page(), page(), **kwargs)


def test_invalid_page_aspect_or_bounds_are_refused():
    with pytest.raises(ValueError, match="aspect ratio"):
        assemble_page(atlas(), "page.png", Image.new("RGBA", (10, 18)), page())
    source = atlas()
    source.pages["page.png"].size = (10, 9)
    with pytest.raises(remap.RemapError, match="bounds"):
        assemble_page(source, "page.png", page(), page())


NAME = "assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_123456.bundle"


@pytest.mark.parametrize("texture_format", [4, 25])
@pytest.mark.parametrize("identity,scale", [(True, 1), (False, 1), (False, 2)])
def test_bundle_roundtrip_crc_lossless_pixels_unrelated_objects_and_official_metadata(tmp_path, texture_format, identity, scale):
    text = atlas_text([("page.png", (20, 18), [("body", -1, (4, 3), (6, 4), (6, 4), (0, 0), 0)])])
    source = write_bundle(tmp_path / "official" / NAME, {"hero.atlas": text},
                          {"page": page(), "other": pattern((8, 8), 31)}, texture_format=texture_format)
    # The fixture's skeleton name is test.skel, matching the App's unique-pair fallback.
    before = source.read_bytes()
    inputs = remap.read_inputs([source])
    generated = inputs.textures["page"] if identity else Image.new("RGBA", (35, 37), (200, 20, 30, 0))
    expected = assemble_page(remap.parse_atlas(text), "page.png", inputs.textures["page"], generated, scale=scale)
    report = assemble_mod([source], generated, tmp_path / "mod", atlas_name="hero.atlas", page_name="page.png", scale=scale)
    built = tmp_path / "mod" / NAME
    actual = remap.read_inputs([built])
    assert built.name == source.name and Bundle.check_crc_match(built)
    assert actual.textures["page"].tobytes() == expected.image.tobytes()
    assert actual.textures["other"].tobytes() == inputs.textures["other"].tobytes()
    assert actual.atlases == inputs.atlases and actual.skeletons == inputs.skeletons
    assert source.read_bytes() == before
    assert report["texture_format"] == (texture_format if identity else 4)
    assert list(built.parent.iterdir()) == [built]


def test_bundle_requires_identified_metadata_and_refuses_overwriting(tmp_path):
    source = write_bundle(tmp_path / NAME, {}, {"page": page()}, skeleton=None)
    with pytest.raises(ValueError, match="atlas and matching skeleton"):
        assemble_mod([source], page(), tmp_path / "mod", atlas_name="test.atlas", page_name="page.png")
    text = atlas_text([("page.png", (20, 18), [("body", -1, (4, 3), (6, 4), (6, 4), (0, 0), 0)])])
    write_bundle(source, {"test.atlas": text}, {"page": page()})
    with pytest.raises(ValueError, match="new file"):
        assemble_mod([source], page(), tmp_path, atlas_name="test.atlas", page_name="page.png")
    with pytest.raises(ValueError, match="exactly one official owner"):
        assemble_mod([source, source], page(), tmp_path / "mod", atlas_name="test.atlas", page_name="page.png")


@pytest.fixture
def cycling_official(tmp_path):
    value = os.environ.get("BAMT_TEST_GAME_DIR")
    if not value:
        pytest.skip("Set BAMT_TEST_GAME_DIR to an isolated verified official view")
    from ba_modding_toolkit.searching import get_search_dirs

    paths = sorted(path for folder in get_search_dirs(Path(value))
                   for path in folder.glob("assets-_mx-spinecharacters-shiroko_ridingsuit_spr-*.bundle"))
    if not paths:
        pytest.skip("The official view has no Shiroko (Cycling) portrait")
    inputs = remap.read_inputs(paths)
    assert "shiroko_ridingsuit_spr.atlas" in inputs.atlases
    assert "shiroko_ridingsuit_spr.skel" in inputs.skeletons
    return paths, inputs


def test_official_cycling_identity_roundtrip(cycling_official, tmp_path):
    paths, inputs = cycling_official
    image = inputs.textures["shiroko_ridingsuit_spr"]
    report = assemble_mod(paths, image, tmp_path / "identity", atlas_name="shiroko_ridingsuit_spr.atlas",
                          page_name="shiroko_ridingsuit_spr.png")
    actual = remap.read_inputs([tmp_path / "identity" / report["bundle"]])
    assert report["changed_pixels"] == 0
    assert actual.textures["shiroko_ridingsuit_spr"].tobytes() == image.tobytes()
    assert report["texture_format"] == 25


@pytest.mark.parametrize("scale", [1, 2])
def test_official_cycling_mod_is_accepted_and_identified_by_app_import(cycling_official, tmp_path, scale):
    from ba_modding_toolkit.catalog import Catalog
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.library import ModLibrary

    paths, inputs = cycling_official
    # Settings and library writes are isolated; official parts are only read.
    folders = sorted({path.parent for path in paths})
    game = GameAssets(folders, AssetCache(allowed=False))
    catalog = Catalog(game, None)
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(folders[0]))
    library = ModLibrary(tmp_path / "library", catalog, game, settings)
    generated = Image.new("RGBA", (1378, 1142), (171, 51, 91, 128))
    report = assemble_mod(paths, generated, tmp_path / "mod", atlas_name="shiroko_ridingsuit_spr.atlas",
                          page_name="shiroko_ridingsuit_spr.png", region=("shiroko_ridingsuit", -1), scale=scale)
    built = tmp_path / "mod" / report["bundle"]
    assert library.identify_import(built, built.name) == (built.name, "shiroko_ridingsuit", "spr")
    preflight = library.inspect_import({built.name: built}, conversion=True)
    assert not preflight.get("rebuild", False)
    assert preflight["direct"] == {next(path for path in paths if path.name == built.name): built}
    entry, = library.add([built])
    assert entry.target == "shiroko_ridingsuit" and entry.kind == "spr"
    assert entry.file.name == built.name
    actual = remap.read_inputs([built]).textures["shiroko_ridingsuit_spr"]
    expected = assemble_page(remap.parse_atlas(inputs.atlases["shiroko_ridingsuit_spr.atlas"]),
                             "shiroko_ridingsuit_spr.png", inputs.textures["shiroko_ridingsuit_spr"],
                             generated, region=("shiroko_ridingsuit", -1), scale=scale)
    assert actual.tobytes() == expected.image.tobytes()
    # The same extractor used by the App serves an intact atlas/skeleton with the new page.
    from io import BytesIO
    from ba_modding_toolkit.gameassets.spine import extract_spine

    files = extract_spine([built if path.name == built.name else path for path in paths])
    assert files["shiroko_ridingsuit_spr.atlas"] == inputs.atlases["shiroko_ridingsuit_spr.atlas"]
    assert files["shiroko_ridingsuit_spr.skel"] == inputs.skeletons["shiroko_ridingsuit_spr.skel"]
    with Image.open(BytesIO(files["shiroko_ridingsuit_spr.png"])) as image:
        assert image.size == expected.image.size and image.tobytes() == actual.tobytes()
