"""Atlas/material alpha decisions and lossless PNG export at transparent edges."""

from contextlib import contextmanager
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.gameassets.spine import atlas_alpha, extract_spine, material_pma


@pytest.mark.parametrize("tree,expected", [
    ({}, None),
    ({"m_ShaderKeywords": "_STRAIGHT_ALPHA_INPUT OTHER"}, False),
    ({"m_ValidKeywords": ["_STRAIGHT_ALPHA_INPUT"]}, False),
    ({"m_SavedProperties": {"m_Floats": [["_StraightAlphaInput", 0]]}}, True),
    ({"m_SavedProperties": {"m_Floats": [["_StraightAlphaInput", 1]]}}, True),
    ({"m_ValidKeywords": ["_STRAIGHT_ALPHA_INPUT"],
      "m_SavedProperties": {"m_Floats": [["_StraightAlphaInput", 0]]}}, False),
])
def test_material_pma_uses_the_shader_keyword(tree, expected):
    assert material_pma(tree) is expected


@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_atlas_alpha_is_per_page_and_preserves_explicit_flags(ending):
    source = ending.join([
        "", "Pages/Aoi.PNG", "size: 2,1", "filter: Linear,Linear", "ear.png", "  xy: 0,0", "",
        "Arona.png", "pma: false", "size: 2,1", "hair", "  xy: 0,0", "",
        "Plana.png", "pma: true", "size: 2,1", "",
        "Portrait.png", "size: 2,1", "",
        "Lobby.png", "size: 2,1", "",
    ]).encode()
    output = atlas_alpha(source, {"aoi": True, "arona": True, "plana": False, "portrait": False})
    assert output == source.replace(f"filter: Linear,Linear{ending}".encode(),
                                    f"filter: Linear,Linear{ending}pma: true{ending}".encode()).replace(
        f"Portrait.png{ending}size: 2,1{ending}".encode(),
        f"Portrait.png{ending}size: 2,1{ending}pma: false{ending}".encode())
    assert atlas_alpha(output, {"aoi": False, "arona": True}) == output
    assert atlas_alpha(source, {}) == source


@pytest.mark.parametrize("core", ["aoi_workpage", "arona_workpage_daytime", "plana_workpage", "cafe",
                                  "hero_spr", "hero_home"])
@pytest.mark.parametrize("pma", [False, True])
def test_export_preserves_semitransparent_and_transparent_texels(tmp_path, monkeypatch, core, pma):
    image = Image.new("RGBA", (3, 1))
    pixels = [(100, 50, 25, 128), (0, 0, 0, 0), (220, 180, 140, 255)] if pma else [
        (200, 100, 50, 128), (17, 91, 211, 0), (220, 180, 140, 255)]
    image.putdata(pixels)
    atlas = f"Pages/{core}.PNG\nsize: 3,1\nfilter: Linear,Linear\nedge\n  xy: 0,0\n"
    cab = SimpleNamespace(name="CAB", externals=[])

    def obj(kind, pid, data=None, tree=None):
        return SimpleNamespace(type=SimpleNamespace(name=kind), path_id=pid, assets_file=cab,
                               read=lambda: data, read_typetree=lambda: tree)

    mat = {"m_ValidKeywords": [] if pma else ["_STRAIGHT_ALPHA_INPUT"], "m_SavedProperties": {
        "m_Floats": [["_StraightAlphaInput", int(not pma)]],
        "m_TexEnvs": [["_MainTex", {"m_Texture": {"m_FileID": 0, "m_PathID": 1}}]]}}
    parts = {
        "material.bundle": [obj("Material", 2, tree=mat)],
        "texture.bundle": [obj("Texture2D", 1, SimpleNamespace(m_Name=core, image=image))],
        "atlas.bundle": [obj("TextAsset", 3, SimpleNamespace(m_Name=f"{core}.atlas", m_Script=atlas))],
    }

    @contextmanager
    def open_fake(path):
        yield SimpleNamespace(objects=parts[path.name])

    monkeypatch.setattr("ba_modding_toolkit.gameassets.spine.open_bundle", open_fake)
    files = extract_spine([tmp_path / name for name in parts])
    assert f"pma: {str(pma).lower()}\n".encode() in files[f"{core}.atlas"]
    assert files[f"Pages/{core}.PNG"] == files[f"{core}.png"]
    with Image.open(BytesIO(files[f"{core}.png"])) as exported:
        assert list(exported.getdata()) == pixels
    assert list(image.getdata()) == pixels
