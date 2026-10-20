"""Preflight over synthetic serialized-file metadata, never game assets or external tools."""

import base64
import json
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.library.integrity import inspect as inspect_bundle

from test_library import game_bundle, make_mod, setup_library

FIXTURES = Path(__file__).parent / "assets" / "integrity"


def fixture(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


@pytest.fixture
def serialized(setup_library, monkeypatch):
    env = setup_library
    contents = {}

    def register(path, spec=None):
        spec = spec or {}
        objects = []
        for name, text in {**spec.get("skeletons", {}), **spec.get("atlases", {})}.items():
            data = SimpleNamespace(m_Name=name, m_Script=text)
            objects.append(SimpleNamespace(type=SimpleNamespace(name="TextAsset"),
                peek_name=lambda name=name: name, read=lambda data=data: data))
        for name, size in spec.get("textures", {}).items():
            data = SimpleNamespace(m_Name=name, m_Width=size[0], m_Height=size[1],
                                   m_StreamData=SimpleNamespace(path=spec.get("stream", "")))
            objects.append(SimpleNamespace(type=SimpleNamespace(name="Texture2D"), read=lambda data=data: data))
        files = {f"{spec.get('cab', 'CAB-official')}-{i}" if i else spec.get("cab", "CAB-official"):
                 SimpleNamespace(target_platform=SimpleNamespace(name=platform),
                    externals=[SimpleNamespace(path=ref) for ref in spec.get("references", [])],
                    files={42: SimpleNamespace()})
                 for i, platform in enumerate(spec.get("platforms", ["StandaloneWindows64"]))}
        files.update({name: SimpleNamespace() for name in spec.get("resources", [])})
        contents[path.read_bytes()] = SimpleNamespace(env=SimpleNamespace(
            files={"bundle": SimpleNamespace(files=files)}, objects=objects))
        return path

    monkeypatch.setattr(integrity, "inspect", inspect_bundle)
    monkeypatch.setattr(Bundle, "load", lambda path, *args, **kwargs: contents.get(path.read_bytes()))
    register(env.original)
    return env, register


@pytest.mark.parametrize("platform", ["Android", "iOS", "StandaloneOSX", "StandaloneLinux64"])
def test_other_build_targets_refuse_the_whole_upload(serialized, platform):
    env, register = serialized
    valid = register(make_mod(env.original, env.tmp / "good"))
    lobby = game_bundle(env.tmp / "bad", "test_home_gl", payload=b"mobile lobby")
    spec = fixture("another_platform")
    spec["platforms"] = [platform]
    register(lobby, spec)
    before = env.original.read_bytes()
    with pytest.raises(ServiceError) as caught:
        env.library.add([valid, lobby])
    assert caught.value.code == "mod_platform_mismatch"
    assert caught.value.params == {"file": lobby.name, "platform": platform, "expected": "StandaloneWindows64"}
    assert env.library.mods() == [] and env.original.read_bytes() == before


def test_all_serialized_files_are_checked_and_unknown_targets_are_refused(serialized):
    env, register = serialized
    path = make_mod(env.original, env.tmp / "input")
    register(path, {"platforms": ["StandaloneWindows64", "Android"]})
    with pytest.raises(ServiceError, match="mod_platform_mismatch"):
        env.library.add([path])
    register(path, {"platforms": []})
    with pytest.raises(ServiceError, match="mod_platform_unknown"):
        env.library.add([path])
    register(path, {"platforms": ["UnknownPlatform"]})
    with pytest.raises(ServiceError, match="mod_platform_unknown"):
        env.library.add([path])


@pytest.mark.parametrize("platform,expected", [(19, "StandaloneWindows64"), (13, "Android"), (9, "iOS")])
def test_platform_is_read_from_real_unitypy_serialized_metadata(tmp_path, platform, expected):
    # A UnityFS containing one empty serialized file, generated entirely from metadata.
    metadata = b"2021.3.0f1\0" + struct.pack("<i?4I", platform, False, 0, 0, 0, 0) + b"\0"
    data = (struct.pack(">4I", len(metadata), 128, 17, 128) + bytes(4) + metadata).ljust(128, b"\0")
    info = bytes(16) + struct.pack(">iIIHiqqI", 1, len(data), len(data), 0, 1, 0, len(data), 0) + b"CAB-test\0"
    header = b"UnityFS\0" + struct.pack(">I", 7) + b"5.x.x\0" + b"2021.3.0f1\0"
    padding = bytes(-(len(header) + 20) % 16)
    header += struct.pack(">qIII", len(header) + 20 + len(padding) + len(info) + len(data), len(info), len(info), 64)
    header += padding
    path = tmp_path / "synthetic.bundle"
    path.write_bytes(header + info + data)
    contents = inspect_bundle(path)
    assert contents.platforms == {expected}
    assert "cab-test" in contents.files
    if platform != 19:
        with pytest.raises(ServiceError, match="mod_platform_mismatch"):
            integrity.check_platform(contents, path, {"StandaloneWindows64"})


def test_missing_lobby_part_is_named_and_siblings_are_never_imported(serialized):
    env, register = serialized
    skeleton = register(game_bundle(env.tmp / "input", "test_home_gl", part="textassets"), fixture("missing_part"))
    texture = register(game_bundle(skeleton.parent, "test_home_gl", part="textures", payload=b"texture"),
                       {"cab": "CAB-textures", "textures": {"page": [64, 64]}})
    with pytest.raises(ServiceError) as caught:
        env.library.add([skeleton])
    assert caught.value.code == "mod_parts_missing"
    assert caught.value.params["files"] == texture.name
    assert not env.library.mods()
    result = env.library.add([skeleton, texture])
    assert len(result) == 1 and len(list(result[0].file.parent.glob("*.bundle"))) == 2


def test_missing_texture_and_embedded_stream_are_named(serialized):
    env, register = serialized
    source = register(make_mod(env.original, env.tmp / "input"), {
        "atlases": {"test_spr.atlas": "absent.png\nsize: 32,32\n"},
        "textures": {"other": [32, 32]}, "stream": "archive:/CAB-data/missing.resS"})
    with pytest.raises(ServiceError) as caught:
        env.library.add([source])
    assert caught.value.params["files"] == "absent.png, missing.resS"


def test_partial_mod_can_use_current_official_dependencies(serialized):
    env, register = serialized
    texture = register(game_bundle(env.game_dir, part="textures", payload=b"official page"),
                       {"cab": "CAB-page", "textures": {"page": [64, 64]}})
    source = register(make_mod(env.original, env.tmp / "input"), {
        "references": ["CAB-page"], "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}})
    result = env.library.add([source])
    assert result[0].size == source.stat().st_size
    assert texture.read_bytes() != source.read_bytes()


def test_missing_pages_are_checked_in_omitted_official_atlases_too(serialized):
    env, register = serialized
    register(env.original, {"atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}})
    register(game_bundle(env.game_dir, part="textures", payload=b"official texture"),
             {"cab": "CAB-texture", "textures": {"page": [64, 64]}})
    source = register(game_bundle(env.tmp / "input", part="textures", payload=b"wrong texture"),
                      {"cab": "CAB-texture", "textures": {"wrong": [64, 64]}})
    with pytest.raises(ServiceError) as caught:
        env.library.add([source])
    assert caught.value.code == "mod_parts_missing" and caught.value.params["files"] == "page.png"


def test_shared_install_references_are_allowed_but_missing_skeleton_atlases_are_not(serialized):
    env, register = serialized
    register(env.original, {"references": ["archive:/CAB-shared/CAB-shared"]})
    source = register(make_mod(env.original, env.tmp / "input"), {"references": ["CAB-shared"]})
    assert env.library.add([source])
    register(source, {"skeletons": {"first.skel": "4.2.33", "second.skel": "4.2.33"},
                      "atlases": {"first.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    with pytest.raises(ServiceError) as caught:
        env.library.add([source])
    assert caught.value.params["files"] == "second.atlas"


def test_a_single_skeleton_atlas_pair_can_have_different_names(serialized):
    env, register = serialized
    source = register(make_mod(env.original, env.tmp / "input"), {
        "skeletons": {"test.skel": "4.2.33"}, "atlases": {"other.atlas": "page.png\nsize: 64,64\n"},
        "textures": {"page": [64, 64]}})
    assert env.library.add([source])


def test_expected_platform_comes_from_the_official_bundle(serialized):
    env, register = serialized
    register(env.original, {"platforms": ["StandaloneWindows"]})
    source = register(make_mod(env.original, env.tmp / "input"), {"platforms": ["StandaloneWindows"]})
    assert env.library.add([source])
    register(source, {"platforms": ["StandaloneWindows64"]})
    with pytest.raises(ServiceError) as caught:
        env.library.add([source])
    assert caught.value.params["expected"] == "StandaloneWindows"


def test_compatibility_reads_kept_official_skeleton_and_never_changes_sources(serialized):
    env, register = serialized
    data = fixture("mismatched_skeleton")
    register(env.original, {"skeletons": {"test_spr.skel": json.dumps(data["official"])}})
    source = register(make_mod(env.original, env.tmp / "input"), {
        "skeletons": {"test_spr.skel": json.dumps(data["mod"])},
        "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    # The official fixture must also supply the atlas for the effective bundle set.
    register(env.original, {"skeletons": {"test_spr.skel": json.dumps(data["official"])},
        "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    added = env.library.add([source])
    entry, = added
    before = entry.file.read_bytes()
    env.library.apply("test", f"mod:{entry.id}")
    report = env.library.compatibility(entry.id)
    assert report == added.compatibility[entry.id]
    assert json.loads(base64.b64decode(report["official"]["skeletons"]["test_spr.skel"]["data"])) == data["official"]
    assert json.loads(base64.b64decode(report["mod"]["skeletons"]["test_spr.skel"]["data"])) == data["mod"]
    assert entry.file.read_bytes() == before


def test_compatibility_uses_the_new_current_official_files_after_a_game_update(serialized):
    env, register = serialized
    data = fixture("mismatched_skeleton")
    source = register(make_mod(env.original, env.tmp / "input"), {
        "skeletons": {"test_spr.skel": json.dumps(data["mod"])},
        "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    entry, = env.library.add([source])
    env.library.apply("test", f"mod:{entry.id}")
    env.original.unlink()
    register(game_bundle(env.game_dir, date="2026-02-01", payload=b"updated official"), {
        "skeletons": {"test_spr.skel": json.dumps(data["official"])},
        "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    report = env.library.compatibility(entry.id)
    assert report["outdated"] and not report["unavailable"]
    assert json.loads(base64.b64decode(report["official"]["skeletons"]["test_spr.skel"]["data"])) == data["official"]


def test_missing_mod_atlas_uses_its_dated_official_copy_for_compatibility(serialized):
    env, register = serialized
    old_atlas = "page.png\nsize: 16,16\nIntro_A/Intro_A\n bounds: 2,2,4,4\n"
    current_atlas = old_atlas.replace("2,2,4,4", "8,8,4,4")
    register(env.original, {"atlases": {"test.atlas": current_atlas}, "textures": {"page": [16, 16]}})
    kept = register(game_bundle(env.library.root / "originals", date="2025-01-01", payload=b"old official"),
                    {"atlases": {"test.atlas": old_atlas}, "textures": {"page": [16, 16]}})
    source = register(make_mod(kept, env.tmp / "input"),
                      {"skeletons": {"test.skel": "4.2.33"}, "textures": {"page": [8, 8]}})
    before = {path: path.read_bytes() for path in (source, kept, env.original)}
    entry, = env.library.add([source])
    report = env.library.compatibility(entry.id)
    assert report["mod"]["atlases"] == {"test.atlas": old_atlas}
    assert report["atlasLayout"] == ["test.atlas"] and report["remappable"]
    assert all(path.read_bytes() == content for path, content in before.items())


def test_add_and_compatibility_never_convert_or_rewrite_a_skeleton(serialized, monkeypatch):
    env, register = serialized
    data = fixture("mismatched_skeleton")
    data["mod"]["skeleton"]["spine"] = "3.8.99"
    source = register(make_mod(env.original, env.tmp / "input"), {
        "skeletons": {"test_spr.skel": json.dumps(data["mod"])},
        "atlases": {"test_spr.atlas": "page.png\nsize: 64,64\n"}, "textures": {"page": [64, 64]}})
    before = source.read_bytes()
    monkeypatch.setattr("ba_modding_toolkit.spine.SkelConverter.ensure_version",
                        lambda *a, **kw: pytest.fail("the check must not convert skeletons"))
    entry, = env.library.add([source])
    report = env.library.compatibility(entry.id)
    assert report["mod"]["skeletons"]["test_spr.skel"]["version"] == "3.8.99"
    assert source.read_bytes() == entry.file.read_bytes() == before


@pytest.mark.parametrize("enabled", [True, False])
def test_add_uses_the_normal_switch_or_configures_while_disabled(setup_library, enabled):
    env = setup_library
    if not enabled:
        env.library.toggle(False, expect=True)
    original = env.original.read_bytes()
    source = make_mod(env.original, env.tmp / "input")
    report = env.library.add_and_apply([source])
    entry, = report
    assert env.library.configured("test")["spr"] == f"mod:{entry.id}"
    assert env.original.read_bytes() == (source.read_bytes() if enabled else original)
    assert (report.applied if enabled else report.configured) == [entry]
    assert not report.failed


def test_add_keeps_the_source_and_reports_a_refused_switch(setup_library, monkeypatch):
    env = setup_library
    def refuse(*args, **kwargs):
        raise ServiceError("game_running")
    monkeypatch.setattr(env.library, "apply", refuse)
    report = env.library.add_and_apply([make_mod(env.original, env.tmp / "input")])
    assert report.failed == [{"id": report[0].id, "code": "game_running", "params": {}}]
    assert env.library.configured("test")["spr"] is None
    assert not report.applied


def test_a_mod_recognized_in_another_install_still_switches_the_current_install(setup_library):
    env = setup_library
    other = game_bundle(env.tmp / "other-game")
    env.settings.set("game_resource_dir_japan", str(other.parent))
    source = make_mod(env.original, env.tmp / "input", fixed=True)
    other.write_bytes(source.read_bytes())
    report = env.library.add_and_apply([source])
    entry, = report
    assert report.installed == report.applied == [entry]
    assert env.original.read_bytes() == source.read_bytes()
    assert env.library.configured("test")["spr"] == f"mod:{entry.id}"


def test_comparison_without_an_official_copy_is_incomplete(serialized):
    env, register = serialized
    source = register(make_mod(env.original, env.tmp / "input"))
    env.original.write_bytes(source.read_bytes())
    entry, = env.library.add([source])
    assert env.library.compatibility(entry.id)["unavailable"]


def test_adding_without_an_install_keeps_the_mod_and_reports_the_refused_switch(setup_library):
    env = setup_library
    env.settings.set("game_resource_dir", "")
    report = env.library.add_and_apply([make_mod(env.original, env.tmp / "input")])
    assert len(report) == 1
    assert report.compatibility[report[0].id]["unavailable"]
    assert report.failed[0]["code"] == "game_not_found"


def test_atlas_positions_rotations_and_trim_changes_offer_remapping(serialized):
    env, register = serialized
    old = "page.png\nsize: 64,64\npart\n  rotate: false\n  xy: 0,0\n  size: 4,8\n  orig: 6,10\n  offset: 1,1\n  index: -1\n"
    new = "page.png\nsize: 64,64\npart\n  rotate: 90\n  bounds: 20,20,4,8\n  offsets: 1,1,6,10\n  index: -1\n"
    register(env.original, {"atlases": {"test.atlas": new}, "textures": {"page": [64, 64]}})
    source = register(make_mod(env.original, env.tmp / "input"),
        {"atlases": {"test.atlas": old}, "textures": {"page": [64, 64]}})
    entry, = env.library.add([source])
    report = env.library.compatibility(entry.id)
    assert report["atlasLayout"] == ["test.atlas"] and report["remappable"]
    register(source, {"atlases": {"test.atlas": new}, "textures": {"page": [64, 64]}})
    # Inspecting an equal atlas is insensitive to line indentation and syntax spelling.
    from ba_modding_toolkit.atlas_remap import layout_changes
    equivalent = old.replace("rotate: false", "rotate: 0")
    assert layout_changes({"test.atlas": old.encode()}, {"test.atlas": equivalent.encode()}) == []
