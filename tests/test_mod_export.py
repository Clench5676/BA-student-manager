"""Complete ZIP publication and target preparation using isolated library fixtures."""

import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from dataclasses import replace

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.searching import _asset_match
from ba_modding_toolkit.webui import batch_import
from ba_modding_toolkit.webui import export_service
from ba_modding_toolkit.webui.rpc import RpcRegistry

from test_library import game_bundle, make_mod, setup_library
from test_mod_origin import inspect_bundle, bundle_metadata, official_bundle, old_bundle


def services(env):
    return SimpleNamespace(settings=env.settings, library=env.library, state=SimpleNamespace(get=lambda *_: {}))


def run(env, scope="library", target=None):
    return export_service.export_zip(services(env), env.library, env.library.current_pin(), scope=scope,
        target=target, folder=env.tmp / "exports", server="global", platform="windows", kind=None,
        log=lambda *_: None, progress=lambda *_: None)


def contents(result):
    with zipfile.ZipFile(result["archive"]) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        return manifest, {name: archive.read(name) for name in archive.namelist()}


def test_library_export_prepares_existing_mods_without_mutating_library_or_game(setup_library):
    env = setup_library
    source = make_mod(env.original, env.tmp / "upload")
    mod, = env.library.add([source])
    state = (env.root / "state.json").read_bytes()
    game = env.original.read_bytes()
    result = run(env)
    manifest, files = contents(result)
    assert result["count"] == 1
    assert manifest["target"] == {"server": "global", "platform": "windows"}
    entry, = manifest["mods"]
    assert entry["source"] == f"mod:{mod.id}"
    assert files[f'{entry["directory"]}/{source.name}'] == source.read_bytes()
    assert (env.root / "state.json").read_bytes() == state
    assert env.original.read_bytes() == game
    assert sorted(path.suffix for path in (env.tmp / "exports").iterdir()) == [".zip"]


def test_applied_uses_desired_manifest_while_disabled(setup_library):
    env = setup_library
    source = make_mod(env.original, env.tmp / "upload")
    mod, = env.library.add([source])
    other = make_mod(env.original, env.tmp / "other", payload=b"other mod")
    env.library.add([other])
    env.library.profiles.update(lambda data: data.update(enabled=False))
    result = env.library.apply("test", f"mod:{mod.id}")
    assert result.deferred
    manifest, _ = contents(run(env, "applied"))
    assert [entry["source"] for entry in manifest["mods"]] == [f"mod:{mod.id}"]
    assert manifest["assignments"][0]["source"] == f"mod:{mod.id}"
    assert not env.library.profiles.read()["enabled"]


@pytest.mark.parametrize("stage", ["prepare", "write", "verify", "publish"])
def test_failed_export_never_publishes_partial_archive(setup_library, monkeypatch, stage):
    env = setup_library
    for i in range(2):
        env.library.add([make_mod(env.original, env.tmp / str(i), payload=f"mod {i}".encode())])
    before = env.tmp / "exports"
    before.mkdir()
    existing = before / "existing.zip"
    existing.write_bytes(b"previous complete archive")
    if stage == "prepare":
        original = export_service._prepare
        count = 0

        def fail_second(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("disk full")
            return original(*args, **kwargs)

        monkeypatch.setattr(export_service, "_prepare", fail_second)
    elif stage == "verify":
        monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda _: "damaged.bundle")
    else:
        def fail(*args, **kwargs):
            raise OSError("locked output")
        monkeypatch.setattr(zipfile.ZipFile if stage == "write" else export_service.os,
                            "write" if stage == "write" else "replace", fail)
    with pytest.raises((OSError, ServiceError)):
        run(env)
    assert list(before.iterdir()) == [existing]
    assert existing.read_bytes() == b"previous complete archive"


def test_empty_applied_export_has_no_zip(setup_library):
    env = setup_library
    with pytest.raises(ServiceError, match="export_empty"):
        run(env, "applied")
    assert not list((env.tmp / "exports").iterdir())


def test_export_paths_are_portable_collision_resistant_and_stable():
    values = ["../escape", "..\\escape", "CON", "a/b", "a\\b", "A", "a", "", "a" * 200]
    paths = [export_service._safe_name(value) for value in values]
    assert len({value.casefold() for value in paths}) == len(paths)
    assert paths == [export_service._safe_name(value) for value in values]
    assert all("/" not in value and "\\" not in value and not value.startswith(".") for value in paths)
    for value in ("bad\\name.bundle", "bad:name.bundle", "NUL.bundle", "name. "):
        with pytest.raises(ServiceError):
            export_service._member_name(Path(value))


def test_unavailable_platform_is_rejected_instead_of_relabelled(setup_library):
    env = setup_library
    with pytest.raises(ServiceError, match="export_target_unavailable"):
        export_service._target_pin(env.library, env.settings, "global", "android")


@pytest.mark.parametrize("backup", [False, True])
def test_single_original_variant_archive_uses_current_bundle_names(setup_library, backup):
    env = setup_library
    expected = env.original.read_bytes()
    if backup:
        env.original.with_name(env.original.name + ".backup").write_bytes(expected)
        env.original.write_bytes(make_mod(env.original, env.tmp / "external").read_bytes())
    manifest, files = contents(run(env, "single", "variant:test"))
    entry, = manifest["mods"]
    assert files[f'{entry["directory"]}/{env.original.name}'] == expected


@pytest.mark.parametrize("source_platform", [13, 9])
def test_foreign_platform_mod_is_rebuilt_with_real_unity_payload(setup_library, monkeypatch, source_platform):
    env = setup_library
    monkeypatch.setattr(integrity, "inspect", inspect_bundle)
    monkeypatch.setattr(integrity, "metadata", bundle_metadata)
    monkeypatch.setattr(batch_import, "_asset_match", _asset_match)
    official_bundle(env)
    source = old_bundle(env.tmp / "input" / env.original.name, source_platform, cab="CAB-source",
                        payload=b"modded", references=["com.nexon.bluearchive"])
    # A library may contain Mods imported for another previously selected installation.
    record = env.library._store({source.name: source}, "foreign", "test", "spr", user_added=True)
    original_bytes = env.original.read_bytes()
    source_bytes = source.read_bytes()
    manifest, files = contents(run(env, "single", f'mod:{record["id"]}'))
    entry, = manifest["mods"]
    output = env.tmp / "prepared.bundle"
    output.write_bytes(files[f'{entry["directory"]}/{env.original.name}'])
    bundle = Bundle.load(output)
    assert bundle.platform_info[0] == "StandaloneWindows64"
    assert bundle.env.objects[0].read().m_Script == "modded"
    assert env.original.read_bytes() == original_bytes
    assert source.read_bytes() == source_bytes


def test_cross_server_mod_is_prepared_against_selected_target(setup_library, monkeypatch):
    env = setup_library
    monkeypatch.setattr(integrity, "inspect", inspect_bundle)
    monkeypatch.setattr(integrity, "metadata", bundle_metadata)
    monkeypatch.setattr(batch_import, "_asset_match", _asset_match)
    official_bundle(env)
    source = old_bundle(env.tmp / "input" / env.original.name, 19, cab="CAB-global",
                        payload=b"global mod", references=["com.nexon.bluearchive"])
    record = env.library._store({source.name: source}, "global", "test", "spr", user_added=True)
    pin = replace(env.library.current_pin(), server="japan")
    result = export_service.export_zip(services(env), env.library, pin, scope="single", target=f'mod:{record["id"]}',
        folder=env.tmp / "exports", server="japan", platform="windows", kind=None,
        log=lambda *_: None, progress=lambda *_: None)
    manifest, files = contents(result)
    entry, = manifest["mods"]
    output = env.tmp / "japan.bundle"
    output.write_bytes(files[f'{entry["directory"]}/{env.original.name}'])
    bundle = Bundle.load(output)
    assert bundle.env.objects[0].read().m_Script == "global mod"
    inspection = integrity.Inspection()
    assert inspection.metadata(output).files == inspection.metadata(env.original).files
    assert output.read_bytes() != source.read_bytes()


def test_options_use_serialized_platform_and_real_default_directory(setup_library, monkeypatch):
    env = setup_library
    monkeypatch.setattr(integrity, "metadata", bundle_metadata)
    official_bundle(env, platform=13)
    env.settings.set("output_dir", str(env.tmp / "custom output"))
    registry = RpcRegistry()
    export_service.register_api(registry, services(env))
    answer = registry.call("export.options", {})["result"]
    assert answer["folder"] == str(env.tmp / "custom output")
    assert answer["platform"] == "android"
    assert answer["targets"] == [{"server": "global", "platform": "android"}]
    assert not (env.tmp / "custom output").exists()


def test_source_change_during_archive_write_cannot_publish(setup_library, monkeypatch):
    env = setup_library
    mod, = env.library.add([make_mod(env.original, env.tmp / "upload")])
    write = zipfile.ZipFile.write

    def changed(archive, path, *args, **kwargs):
        write(archive, path, *args, **kwargs)
        Path(path).write_bytes(Path(path).read_bytes() + b"changed")

    monkeypatch.setattr(zipfile.ZipFile, "write", changed)
    with pytest.raises(ServiceError, match="entry_changed"):
        run(env)
    assert not list((env.tmp / "exports").iterdir())
