"""Pin the 0.2.0 atlas and PNG export, independent of material alpha declarations."""

from contextlib import contextmanager
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.gameassets.spine import extract_spine


@pytest.mark.parametrize("core", ["np0032_npc", "arona_workpage_daytime", "plana_workpage", "cafe",
                                  "hero_spr", "hero_home"])
@pytest.mark.parametrize("atlas_pma", [None, False, True])
@pytest.mark.parametrize("material_pma", [False, True])
def test_export_matches_020_at_transparent_edges(tmp_path, monkeypatch, core, atlas_pma, material_pma):
    # Bright hidden RGB and alpha 1 catch unpremultiplication, premultiplication and transparent-pixel bleed.
    pixels = bytes([200, 100, 50, 128, 17, 91, 211, 0, 93, 171, 237, 1, 220, 180, 140, 255])
    image = Image.frombytes("RGBA", (4, 1), pixels)
    flag = "" if atlas_pma is None else f"pma: {str(atlas_pma).lower()}\n"
    atlas = f"Pages/{core}.PNG\nsize: 4,1\nfilter: Linear,Linear\n{flag}edge\n  xy: 0,0\n"
    cab = SimpleNamespace(name="CAB", externals=[])

    def obj(kind, pid, data=None, tree=None):
        return SimpleNamespace(type=SimpleNamespace(name=kind), path_id=pid, assets_file=cab,
                               read=lambda: data, read_typetree=lambda: tree)

    mat = {"m_ValidKeywords": [] if material_pma else ["_STRAIGHT_ALPHA_INPUT"], "m_SavedProperties": {
        "m_Floats": [["_StraightAlphaInput", int(not material_pma)]],
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
    assert files[f"{core}.atlas"] == atlas.encode()
    assert files[f"Pages/{core}.PNG"] == files[f"{core}.png"]
    legacy_png = BytesIO()
    image.save(legacy_png, format="PNG", compress_level=1)
    assert files[f"{core}.png"] == legacy_png.getvalue()
    with Image.open(BytesIO(files[f"{core}.png"])) as exported:
        assert exported.tobytes() == pixels
    assert image.tobytes() == pixels
