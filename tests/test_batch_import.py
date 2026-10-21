"""Batch RPCs with temporary bundles and the real library's preflight and switch flow."""

from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.models import FilePair, ModUpdateResult, PatchResult
from ba_modding_toolkit.webui import batch_import, native
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState

from test_library import FakeVariant, game_bundle, make_mod, setup_library
from test_library_model import model_bundle, model_env
from test_library_other import other_env


@pytest.fixture
def env(setup_library, monkeypatch):
    env = setup_library
    env.settings.set("output_dir", str(env.tmp / "exports"))
    env.services = Services(env.settings, env.tmp / "app", cache=object(), game=object(),
                            catalog=env.catalog, library=env.library)
    env.rpc = build_api(env.services)
    monkeypatch.setattr(batch_import, "_asset_match", lambda sources, targets, log: (targets, ""))
    yield env
    env.services.close()


@pytest.fixture
def batch_model_env(model_env, monkeypatch):
    env = model_env
    env.settings.set("output_dir", str(env.tmp / "exports"))
    env.services = Services(env.settings, env.tmp / "app", cache=object(), game=object(),
                            catalog=env.catalog, library=env.library)
    env.rpc = build_api(env.services)
    monkeypatch.setattr(batch_import, "_asset_match", lambda sources, targets, log: (targets, ""))
    yield env
    env.services.close()


def rpc(env, method, **params):
    answer = env.rpc.call(method, params)
    assert "error" not in answer, answer
    return answer["result"]


def finish(env, jid):
    assert isinstance(jid, str)
    assert env.services.jobs.wait(jid, 10)
    job = rpc(env, "jobs.get", id=jid)
    assert job["state"] == "done", job
    return job["result"]


def analyze(env, paths, recursive=False):
    return finish(env, rpc(env, "import.analyze", paths=list(map(str, paths)), recursive=recursive))


def run(env, entries, **options):
    options = {**rpc(env, "import.options"), "output": None, **options}
    return finish(env, rpc(env, "import.run", ids=[e["id"] for e in entries], options=options))["results"]


def test_entry_shapes_grouping_stable_ids_and_recursive_scan(env):
    texture = make_mod(env.original, env.tmp / "incoming")
    text_target = game_bundle(env.game_dir, part="textassets", payload=b"official text")
    text = make_mod(text_target, texture.parent, payload=b"mod text")
    lobby_target = game_bundle(env.game_dir, "test_home_gl")
    lobby = make_mod(lobby_target, texture.parent / "nested", payload=b"lobby mod")
    (texture.parent / "readme.txt").write_text("not a bundle")
    shallow = analyze(env, [texture.parent])
    entry, = shallow["entries"]
    assert shallow["skipped"] == 1
    assert set(entry) == {"id", "paths", "variant", "core", "kind", "files", "size", "state", "reason", "libraryId",
                          "preview"}
    assert entry["paths"] == sorted(map(str, [texture, text]))
    assert (entry["variant"], entry["core"], entry["kind"], entry["state"]) == ("test", "test_spr", "spr", "ready")
    assert entry["reason"] is None and entry["libraryId"] is None
    assert entry["size"] == texture.stat().st_size + text.stat().st_size
    assert all(set(f) == {"path", "size", "target"} for f in entry["files"])
    assert {f["target"] for f in entry["files"]} == {texture.name, text.name}
    again = analyze(env, [text, texture, texture])
    assert again["entries"][0]["id"] == entry["id"]
    assert again["skipped"] == 1
    deep = analyze(env, [texture.parent], recursive=True)
    assert len(deep["entries"]) == 2
    assert {e["kind"] for e in deep["entries"]} == {"spr", "lobby"}
    assert next(e for e in deep["entries"] if e["kind"] == "lobby")["paths"] == [str(lobby)]
    assert not env.library.mods()


def test_duplicate_uploads_skipped_by_complete_library_identity(env):
    source = make_mod(env.original, env.tmp / "first")
    duplicate = make_mod(env.original, env.tmp / "copy")
    alternatives = make_mod(env.original, env.tmp / "second", payload=b"different mod")
    result = analyze(env, [source, duplicate, alternatives])
    assert len(result["entries"]) == 2 and result["skipped"] == 1
    assert {e["state"] for e in result["entries"]} == {"ready"}


@pytest.mark.parametrize("same", [False, True])
def test_backup_and_bundle_of_the_same_part_conflict_or_deduplicate(env, same):
    source = make_mod(env.original, env.tmp / "input")
    backup = source.with_name(source.name + ".backup")
    backup.write_bytes(source.read_bytes() if same else source.read_bytes() + b"different")
    result = analyze(env, [source, backup])
    entry, = result["entries"]
    if same:
        assert entry["state"] == "ready" and entry["paths"] == [str(source)]
        assert result["skipped"] == 1
    else:
        assert (entry["state"], entry["reason"]) == ("blocked", "conflict")
        assert result["skipped"] == 0


def test_unknown_bundle_duplicates_are_also_silently_skipped(env):
    first = game_bundle(env.tmp / "a", "shared", category="materials")
    second = game_bundle(env.tmp / "b", "shared", category="materials")
    result = analyze(env, [first, second])
    assert result["skipped"] == 1 and len(result["entries"]) == 1
    assert result["entries"][0]["reason"] == "no_target"


def test_existing_library_and_untracked_installed_states_are_read_only(env):
    source = make_mod(env.original, env.tmp / "input")
    stored, = env.library.add([source])
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["libraryId"]) == ("library", stored.id)
    assert run(env, [entry])[0]["outcome"] == "unchanged"
    other = game_bundle(env.game_dir, "other_spr")
    untracked = make_mod(other, env.tmp / "untracked")
    other.write_bytes(untracked.read_bytes())
    before = sorted(env.root.rglob("*.bundle"))
    entry, = analyze(env, [untracked])["entries"]
    assert (entry["state"], entry["reason"], entry["libraryId"]) == ("installed", None, None)
    assert sorted(env.root.rglob("*.bundle")) == before
    assert len(env.library.mods()) == 1


def test_tracked_installed_with_different_source_bytes_is_ready(env):
    first = make_mod(env.original, env.tmp / "first")
    env.library.add_and_apply([first])
    second = make_mod(env.original, env.tmp / "second", payload=b"another mod")
    entry, = analyze(env, [second])["entries"]
    assert entry["state"] == "ready"
    assert env.original.read_bytes() == first.read_bytes()


def test_backup_upload_and_content_alias_use_library_normalization(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "input")
    source = source.rename(source.with_name(source.name + ".backup"))
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "ready" and entry["files"][0]["target"] == env.original.name
    assert run(env, [entry], enableAfterImport=False)[0]["outcome"] == "imported"
    target = game_bundle(env.game_dir, "test_home_gl")
    renamed = make_mod(env.original, env.tmp / "wrong-name", payload=b"lobby data")
    monkeypatch.setattr("ba_modding_toolkit.library.identity.content_cores", lambda path: {"test_home_gl"})
    entry, = analyze(env, [renamed])["entries"]
    assert (entry["kind"], entry["core"], entry["files"][0]["target"]) == ("lobby", "test_home_gl", target.name)


@pytest.mark.parametrize("problem,reason", [("unreadable", "unreadable"), ("missing", "no_target"),
    ("platform", "conflict"), ("ambiguous", "conflict"), ("other", "no_target")])
def test_blocked_reasons_are_codes_and_failures_do_not_hide_other_entries(env, monkeypatch, problem, reason):
    source = make_mod(env.original, env.tmp / "bad")
    expected_kind = "spr"
    if problem == "unreadable":
        source.write_bytes(b"broken")
    elif problem == "missing":
        source = game_bundle(env.tmp / "bad", "other_spr")
    elif problem == "platform":
        inspect = integrity.inspect
        monkeypatch.setattr(integrity, "inspect", lambda path: integrity.Contents(platforms={"Android"})
                            if path == source else inspect(path))
    elif problem == "ambiguous":
        monkeypatch.setattr("ba_modding_toolkit.library.identity.content_cores",
                            lambda path: {"test_spr", "other_spr"} if path == source else set())
    elif problem == "other":
        source = game_bundle(env.tmp / "bad", "shared", category="shaders")
        expected_kind = "other"
    good = make_mod(env.original, env.tmp / "good", payload=b"fine")
    result = analyze(env, [source, good])
    bad, valid = result["entries"]
    assert (bad["state"], bad["reason"], bad["kind"]) == ("blocked", reason, expected_kind)
    assert valid["state"] == "ready"
    results = run(env, result["entries"], enableAfterImport=False)
    assert results[0]["outcome"] == "skipped" and results[0]["reason"] == reason
    assert results[1]["outcome"] == "imported"


def test_library_capability_api_rejects_an_unsupported_kind(env, monkeypatch):
    seen = []
    monkeypatch.setattr(env.library, "supports_kind", lambda kind: seen.append(kind) or False, raising=False)
    source = game_bundle(env.tmp / "input", "ch0242", category="characters")
    entry, = analyze(env, [source])["entries"]
    assert (entry["kind"], entry["reason"]) == ("model", "unsupported")
    assert seen == ["model"]


@pytest.mark.parametrize("outdated", [False, True])
def test_model_prefab_and_dependencies_analyze_update_add_and_apply(batch_model_env, monkeypatch, outdated):
    env = batch_model_env
    if outdated:
        sources = [model_bundle(env.tmp / "input", prefab=True, part="000", date="2025-01-01", payload=b"mod prefab"),
                   model_bundle(env.tmp / "input", part="meshes", date="2025-01-01", payload=b"mod mesh")]
    else:
        sources = [make_mod(path, env.tmp / "input", payload=f"mod {i}".encode())
                   for i, path in enumerate(env.parts[:2])]
    entry, = analyze(env, sources)["entries"]
    assert (entry["kind"], entry["variant"], entry["core"], entry["state"], entry["reason"]) == (
        "model", "hoshino", "hoshino_original", "update" if outdated else "ready", None)
    assert entry["paths"] == sorted(map(str, sources))
    calls = []
    updater(monkeypatch, calls)
    result, = run(env, [entry], backup=False)
    assert result["outcome"] == ("updated" if outdated else "imported")
    assert result["applied"] and len(calls) == int(outdated)
    mod, = env.library.mods()
    assert (mod.kind, mod.target, result["libraryId"]) == ("model", "hoshino", mod.id)
    assert env.library.configured("hoshino")["model"] == f"mod:{mod.id}"
    assert all(path.read_bytes() != env.official[path] for path in env.parts[:2])
    if not outdated:
        assert env.parts[2].read_bytes() == env.official[env.parts[2]]
    env.library.restore("hoshino", kind="model")
    assert all(path.read_bytes() == original for path, original in env.official.items())


def test_spine_version_blocks_without_converter_and_requests_update_with_one(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "old-spine")

    def inspect(path):
        version = b"3.8.75" if path == source else b"4.2.33"
        return integrity.Contents(platforms={"StandaloneWindows64"}, skeletons={"test.skel": version},
                                  atlases={"test.atlas": b""})

    monkeypatch.setattr(integrity, "inspect", inspect)
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "spine_version")
    converter = env.tmp / "converter"
    converter.touch()
    env.settings.set("enable_spine_conversion", True)
    env.settings.set("spine_converter_path", str(converter))
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("update", None)


@pytest.mark.parametrize("version,state", [(b"3.8.75", "blocked"), (b"4.2.20", "ready")])
def test_multiple_official_spine_patch_versions_keep_the_major_minor_check(env, monkeypatch, version, state):
    source = make_mod(env.original, env.tmp / "input")

    def inspect(path):
        skeletons = {"first.skel": version, "second.skel": version, "third.skel": version} if path == source else {
            "first.skel": b"4.2.33", "second.skel": b"4.2.40", "third.skel": b"4.2.9"}
        return integrity.Contents(platforms={"StandaloneWindows64"}, skeletons=skeletons,
                                  atlases={"first.atlas": b"", "second.atlas": b"", "third.atlas": b""})

    monkeypatch.setattr(integrity, "inspect", inspect)
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == (state, "spine_version" if state == "blocked" else None)
    if state == "blocked":
        converter = env.tmp / "converter"
        converter.touch()
        env.settings.set("enable_spine_conversion", True)
        env.settings.set("spine_converter_path", str(converter))
        entry, = analyze(env, [source])["entries"]
        assert (entry["state"], entry["reason"]) == ("update", None)
        calls = []
        updater(monkeypatch, calls)
        assert run(env, [entry], enableAfterImport=False)[0]["outcome"] == "updated"
        assert calls[0][1]["spine_options"].target_version == "4.2.40"


def test_incompatible_mixed_official_spine_series_do_not_convert_to_a_default_version(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "input")

    def inspect(path):
        skeletons = {"first.skel": b"3.8.75", "second.skel": b"3.8.75"} if path == source else {
            "first.skel": b"4.1.24", "second.skel": b"4.2.40"}
        return integrity.Contents(platforms={"StandaloneWindows64"}, skeletons=skeletons,
                                  atlases={"first.atlas": b"", "second.atlas": b""})

    monkeypatch.setattr(integrity, "inspect", inspect)
    converter = env.tmp / "converter"
    converter.touch()
    env.settings.set("enable_spine_conversion", True)
    env.settings.set("spine_converter_path", str(converter))
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "spine_version")


def test_classic_asset_matching_finds_repacked_targets(env, monkeypatch):
    source = game_bundle(env.tmp / "old", date="2025-01-01", payload=b"old mod")
    monkeypatch.setattr(batch_import, "_asset_match", __import__(
        "ba_modding_toolkit.searching", fromlist=["_asset_match"])._asset_match)
    monkeypatch.setattr(Bundle, "load", lambda path, *args: SimpleNamespace(
        get_asset_keys=lambda *args: {"page"} if path in (source, env.original) else set()))
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "update"
    assert entry["files"][0]["target"] == env.original.name


def updater(monkeypatch, calls, payload=b"updated mod"):
    def update(**kwargs):
        calls.append(("update", kwargs))
        pairs = []
        for target in kwargs["target_paths"]:
            output = kwargs["output_dir"] / target.name
            from test_library import header_bundle
            output.write_bytes(header_bundle(payload))
            pairs.append(FilePair(output, target))
        return ModUpdateResult(True, "ok", pairs)

    monkeypatch.setattr(batch_import.core, "process_mod_update", update)


def test_update_then_add_then_apply_forwards_every_classic_option_and_reports_events(env, monkeypatch):
    source = game_bundle(env.tmp / "old", date="2025-01-01", payload=b"old mod")
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "update"
    calls = []
    updater(monkeypatch, calls)
    add, apply = env.library.add, env.library.apply_import

    def adding(*args, **kwargs):
        calls.append(("add", None))
        return add(*args, **kwargs)

    def applying(*args, **kwargs):
        calls.append(("apply", kwargs))
        return apply(*args, **kwargs)

    monkeypatch.setattr(env.library, "add", adding)
    monkeypatch.setattr(env.library, "apply_import", applying)
    events = env.services.events.subscribe()
    options = dict(strategy="name_type", types=["Texture2D", "Mesh"], skipUnchanged=False, crc="on",
                   compression="lz4", extraBytes="0xaabb", backup=True, workers=2,
                   output=str(env.tmp / "exports"))
    # Avoid a second CRC-only rebuild in the real apply flow; the option is checked on the update call below.
    monkeypatch.setattr(env.library, "_needs_crc_fix", lambda *args: False)
    before = env.original.read_bytes()
    result, = run(env, [entry], **options)
    assert [phase for phase, _ in calls] == ["update", "add", "apply"]
    args = calls[0][1]
    assert args["source_paths"] == [source]
    assert args["target_paths"][0].name == env.original.name
    assert args["asset_types_to_replace"] == {"Texture2D", "Mesh"}
    assert args["match_strategy"] == "name_type" and args["skip_unchanged"] is False
    assert args["save_options"].perform_crc is True
    assert args["save_options"].compression == "lz4" and args["save_options"].extra_bytes == b"\xaa\xbb"
    assert args["spine_options"] == env.settings.spine_options()
    assert args["anim_check"] == env.settings.anim_check_options()
    assert calls[2][1]["backup"] is True
    assert result == {"id": entry["id"], "outcome": "updated", "reason": None,
                      "libraryId": env.library.mods()[0].id, "applied": True}
    assert env.original.with_name(env.original.name + ".backup").read_bytes() == before
    assert env.library.settings is env.settings
    assert env.settings.get("compression_method") == "none"
    assert list((env.tmp / "exports" / "bundles" / entry["id"]).glob("*.bundle"))
    seen = []
    while not events.empty():
        seen.append(events.get_nowait())
    progress = [data for event, data in seen if event == "job.progress"]
    assert {p["phase"] for p in progress} == {"update", "add", "apply"}
    assert all(set(p) == {"id", "done", "total", "current", "phase"} for p in progress)
    assert progress[-1]["done"] == progress[-1]["total"] == 1
    changed = next(data for event, data in seen if event == "library.changed")
    assert changed == {"cores": ["test_spr"], "kinds": ["spr"], "mods": True}
    assert any(event == "mods.state" for event, _ in seen)


@pytest.mark.parametrize("switch,enable", [(False, True), (True, False), (True, True)])
def test_enable_after_import_respects_master_switch_and_backup_option(env, switch, enable):
    if not switch:
        env.library.toggle(False, True)
    source = make_mod(env.original, env.tmp / "input")
    before = env.original.read_bytes()
    entry, = analyze(env, [source])["entries"]
    result, = run(env, [entry], enableAfterImport=enable, backup=False)
    assert result["outcome"] == "imported" and result["applied"] is (switch and enable)
    assert env.original.read_bytes() == (source.read_bytes() if switch and enable else before)
    assert env.library.configured("test")["spr"] == (f"mod:{result['libraryId']}" if enable else None)
    assert not env.original.with_name(env.original.name + ".backup").exists()


def test_enable_after_import_applies_to_the_pinned_install_when_already_installed_elsewhere(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "input")
    other = env.tmp / "other-game" / env.original.name
    other.parent.mkdir()
    other.write_bytes(source.read_bytes())
    other.with_name(other.name + ".backup").write_bytes(env.original.read_bytes())
    env.settings.set("game_resource_dir_japan", str(other.parent))
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "ready"
    add = env.library.add_files
    recognized = []

    def adding(*args, **kwargs):
        added = add(*args, **kwargs)
        recognized.extend(added.installed)
        return added

    monkeypatch.setattr(env.library, "add_files", adding)
    result, = run(env, [entry], backup=False)
    assert recognized and recognized[0].id == result["libraryId"]
    assert result["outcome"] == "imported" and result["applied"]
    assert env.original.read_bytes() == source.read_bytes()
    assert other.read_bytes() == source.read_bytes()
    assert env.library.configured("test")["spr"] == f"mod:{result['libraryId']}"


@pytest.mark.parametrize("phase", ["update", "add", "apply"])
def test_per_entry_failures_keep_successful_imports_and_error_codes(env, monkeypatch, phase):
    other_target = game_bundle(env.game_dir, "other_spr")
    good = make_mod(other_target, env.tmp / "good", payload=b"good")
    bad = game_bundle(env.tmp / "bad", date="2025-01-01", payload=b"bad") if phase == "update" else make_mod(
        env.original, env.tmp / "bad", payload=b"bad")
    entries = analyze(env, [bad, good])["entries"]
    if phase == "update":
        monkeypatch.setattr(batch_import.core, "process_mod_update", lambda **kwargs: ModUpdateResult(False, "message", []))
        code = "mod_update_failed"
    elif phase == "add":
        add = env.library.add

        def fail(paths, *args, **kwargs):
            if paths == [bad]:
                raise ServiceError("library_io_error")
            return add(paths, *args, **kwargs)

        monkeypatch.setattr(env.library, "add", fail)
        code = "library_io_error"
    else:
        apply = env.library.apply_import

        def fail(variant, *args, **kwargs):
            if variant == "test":
                raise ServiceError("game_running")
            return apply(variant, *args, **kwargs)

        monkeypatch.setattr(env.library, "apply_import", fail)
        code = "game_running"
    failed, imported = run(env, entries, backup=False)
    assert failed["outcome"] == "failed" and failed["reason"] == code and not failed["applied"]
    assert bool(failed["libraryId"]) is (phase == "apply")
    assert imported["outcome"] == "imported" and imported["applied"]


def test_skip_unchanged_update_and_modified_source_are_safe(env, monkeypatch):
    old = game_bundle(env.tmp / "old", date="2025-01-01", payload=b"mod")
    entry, = analyze(env, [old])["entries"]
    monkeypatch.setattr(batch_import.core, "process_mod_update", lambda **kwargs:
                        ModUpdateResult(True, "all_targets_unchanged", []))
    result, = run(env, [entry])
    assert result["outcome"] == "unchanged" and not env.library.mods()
    old.write_bytes(old.read_bytes() + b"changed")
    result, = run(env, [entry])
    assert result["outcome"] == "failed" and result["reason"] == "entry_changed"


def test_new_analysis_invalidates_previous_ids_at_submission(env):
    first = make_mod(env.original, env.tmp / "first")
    old, = analyze(env, [first])["entries"]
    gate = threading.Event()
    wait = env.services.jobs.submit("wait", lambda log, progress: gate.wait(5))
    try:
        new = rpc(env, "import.analyze", paths=[])
        answer = env.rpc.call("import.run", {"ids": [old["id"]], "options": rpc(env, "import.options")})
        assert answer["error"]["code"] == "bad_params"
    finally:
        gate.set()
    finish(env, wait)
    assert finish(env, new) == {"entries": [], "skipped": 0}


def test_a_replaced_library_invalidates_analyzed_sources(env):
    from ba_modding_toolkit.library import ModLibrary

    source = make_mod(env.original, env.tmp / "input")
    entry, = analyze(env, [source])["entries"]
    env.services._library = ModLibrary(env.tmp / "another-library", env.catalog, object(), env.settings)
    answer = env.rpc.call("import.run", {"ids": [entry["id"]], "options": rpc(env, "import.options")})
    assert answer["error"]["code"] == "folder_changed"
    assert not env.library.mods() and not env.services.library.mods()


def test_rechecks_official_names_between_analyze_and_run(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "incoming")
    entry, = analyze(env, [source])["entries"]
    replacement = game_bundle(env.game_dir, date="2026-09-01", payload=b"new official")
    env.original.unlink()
    calls = []
    updater(monkeypatch, calls)
    result, = run(env, [entry], enableAfterImport=False)
    assert result["outcome"] == "updated"
    assert calls[0][1]["target_paths"][0].name == replacement.name


def test_update_reads_kept_official_bytes_instead_of_the_installed_mod(env, monkeypatch):
    official = env.original.read_bytes()
    current_mod = make_mod(env.original, env.tmp / "installed", payload=b"current mod")
    env.library.add_and_apply([current_mod])
    source = game_bundle(env.tmp / "older", date="2025-01-01", payload=b"old mod")
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "update"
    calls = []
    updater(monkeypatch, calls)
    update = batch_import.core.process_mod_update

    def checked(**kwargs):
        assert kwargs["target_paths"][0].read_bytes() == official
        return update(**kwargs)

    monkeypatch.setattr(batch_import.core, "process_mod_update", checked)
    assert run(env, [entry], enableAfterImport=False)[0]["outcome"] == "updated"
    assert env.original.read_bytes() == current_mod.read_bytes()


@pytest.mark.parametrize("failure", ["source", "target", "save"])
def test_classic_update_read_and_save_failures_cannot_be_reported_as_unchanged(env, monkeypatch, failure):
    source = game_bundle(env.tmp / "older", date="2025-01-01", payload=b"old mod")
    entry, = analyze(env, [source])["entries"]
    bundle = SimpleNamespace(extract_patch=lambda *args: ({1: b"patch"}, []),
        apply_patch=lambda *args: PatchResult(1, 0, [], [], [1]), save=lambda *args: (False, "cannot save"))

    def load(path, *args):
        if (failure == "source" and path == source) or (failure == "target" and path != source):
            return None
        return bundle

    monkeypatch.setattr(Bundle, "load", load)
    result, = run(env, [entry])
    assert (result["outcome"], result["reason"]) == ("failed", "mod_update_failed")
    assert not env.library.mods()


def test_workers_parallelize_updates_while_library_adds_remain_serial(env, monkeypatch):
    game_bundle(env.game_dir, "other_spr")
    first = game_bundle(env.tmp / "older", date="2025-01-01", payload=b"old mod")
    second = game_bundle(env.tmp / "older", "other_spr", date="2025-01-01", payload=b"other mod")
    entries = analyze(env, [first, second])["entries"]
    assert {e["state"] for e in entries} == {"update"}
    calls, threads = [], set()
    updater(monkeypatch, calls)
    update = batch_import.core.process_mod_update
    barrier = threading.Barrier(2)

    def parallel(**kwargs):
        threads.add(threading.current_thread().ident)
        barrier.wait(timeout=5)
        return update(**kwargs)

    monkeypatch.setattr(batch_import.core, "process_mod_update", parallel)
    results = run(env, entries, workers=2, enableAfterImport=False)
    assert [r["outcome"] for r in results] == ["updated", "updated"]
    assert len(threads) == 2 and len(env.library.mods()) == 2


def test_unavailable_official_baseline_is_blocked_even_with_live_targets(env):
    outside_mod = make_mod(env.original, env.tmp / "outside", payload=b"outside mod")
    env.original.write_bytes(outside_mod.read_bytes())
    incoming = make_mod(env.original, env.tmp / "incoming", payload=b"incoming mod")
    entry, = analyze(env, [incoming])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "no_target")


def test_import_backup_preserves_an_official_baseline_from_a_classic_backup(env):
    official = env.original.read_bytes()
    backup = env.original.with_name(env.original.name + ".backup")
    backup.write_bytes(official)
    outside = make_mod(env.original, env.tmp / "outside", payload=b"outside mod")
    env.original.write_bytes(outside.read_bytes())
    incoming = make_mod(env.original, env.tmp / "incoming", payload=b"new mod")
    entry, = analyze(env, [incoming])["entries"]
    assert entry["state"] == "ready"
    result, = run(env, [entry], backup=True)
    assert result["outcome"] == "imported" and result["applied"]
    assert env.original.read_bytes() == incoming.read_bytes()
    assert backup.read_bytes() == outside.read_bytes()
    assert env.library.official_bundles("test_spr")[0].read_bytes() == official
    env.library.restore("test")
    assert env.original.read_bytes() == official


def test_options_persist_in_app_prefs_and_default_to_classic_settings(env):
    defaults = rpc(env, "import.options")
    assert set(defaults) == {"strategy", "types", "skipUnchanged", "crc", "compression", "extraBytes", "backup",
                             "workers", "output", "enableAfterImport"}
    assert defaults["compression"] == "none" and defaults["crc"] == "off"
    assert defaults["workers"] == env.settings.get("max_workers")
    assert set(defaults["types"]) == env.settings.asset_types()
    changed = {**defaults, "strategy": "path_id", "types": ["ALL"], "enableAfterImport": False,
               "workers": 3, "output": None}
    assert rpc(env, "import.setOptions", **changed) == changed
    state = UiState(env.services.state.path)
    assert state.get(batch_import.PREF) == changed
    env.services.state = state
    assert rpc(env, "import.options") == changed
    assert not env.settings.path.exists()
    assert "prefs" in json.loads(state.path.read_text())


@pytest.mark.parametrize("field,value", [("strategy", "guess"), ("types", []), ("types", ["unknown"]),
    ("skipUnchanged", 1), ("crc", True), ("crc", "true"), ("compression", "zip"), ("extraBytes", "0x0"),
    ("backup", "yes"), ("workers", True), ("workers", 0), ("workers", 65), ("output", ""),
    ("enableAfterImport", None)])
def test_invalid_options_are_rejected_without_persisting(env, field, value):
    options = {**rpc(env, "import.options"), field: value}
    result = env.rpc.call("import.setOptions", options)
    assert result["error"]["code"] == "bad_params"
    assert env.services.state.get(batch_import.PREF) is None


def test_native_pickers_cancel_and_unavailable_shapes(env, monkeypatch):
    assert env.rpc.call("import.pick", {"folder": True, "recursive": True})["error"]["code"] == "native_unavailable"
    env.services.window = object()
    monkeypatch.setattr(native, "pick_folder", lambda window: [env.tmp])
    monkeypatch.setattr(native, "pick_files", lambda window, types: [])
    assert rpc(env, "import.pick", folder=True, recursive=True) == {"paths": [str(env.tmp)]}
    assert rpc(env, "import.pick", folder=False, recursive=False) == {"paths": []}


def test_native_folder_uses_webview_dialog(monkeypatch, tmp_path):
    import sys

    marker = object()
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(FileDialog=SimpleNamespace(FOLDER=marker)))
    calls = []
    window = SimpleNamespace(create_file_dialog=lambda *args, **kwargs: calls.append((args, kwargs)) or (str(tmp_path),))
    assert native.pick_folder(window) == [tmp_path]
    assert calls == [((marker,), {"allow_multiple": False})]


GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="Blue Archive install unavailable")
def test_integration_official_bundle_preflight_uses_only_copies(tmp_path, monkeypatch):
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.library import ModLibrary
    from ba_modding_toolkit.naming import parse_filename
    from ba_modding_toolkit.searching import get_search_dirs
    from test_library import FakeCatalog

    resources = get_search_dirs(GAME_DIR)
    candidates = [p for directory in resources for p in directory.glob("assets-_mx-spinecharacters-*.bundle")
                  if parse_filename(p.name).core.endswith("_spr")]
    if not candidates:
        pytest.skip("No portrait bundles available")
    chosen = min(candidates, key=lambda p: p.stat().st_size)
    core_name = parse_filename(chosen.name).core
    siblings = [p for directory in resources for p in directory.glob("*.bundle")
                if parse_filename(p.name).core == core_name]
    game = tmp_path / "game"
    game.mkdir()
    for path in siblings:
        shutil.copy2(path, game / path.name)
    source = tmp_path / chosen.name
    shutil.copy2(chosen, source)
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(game))
    catalog = FakeCatalog(FakeVariant("test", core_name))
    library = ModLibrary(tmp_path / "library", catalog, object(), settings)
    services = Services(settings, tmp_path / "app", cache=object(), game=object(), catalog=catalog, library=library)
    try:
        jid = services.batch_import.analyze([str(source)])
        assert services.jobs.wait(jid, 30)
        job = services.jobs.get(jid)
        assert job.state == "done"
        assert job.result["entries"][0]["state"] == "ready"
        assert not library.mods()
    finally:
        services.close()


@pytest.fixture
def batch_other_env(other_env, monkeypatch):
    env = other_env
    env.settings.set('output_dir', str(env.tmp / 'exports'))
    env.services = Services(env.settings, env.tmp / 'app', cache=object(), game=object(),
                            catalog=env.catalog, library=env.library)
    env.rpc = build_api(env.services)
    yield env
    env.services.close()


def test_generic_batch_multi_target_import_apply_library_and_settings_rpc(batch_other_env):
    env = batch_other_env
    sources = [make_mod(p, env.tmp / 'incoming', payload=f'mod {i}'.encode()) for i, p in enumerate(env.parts)]
    entry, = analyze(env, [sources[0].parent])['entries']
    assert entry['kind'] == 'other' and entry['variant'] is None
    assert entry['state'] == 'ready' and entry['reason'] is None
    assert {f['target'] for f in entry['files']} == {p.name for p in env.parts}
    result, = run(env, [entry], backup=True)
    assert result['outcome'] == 'imported' and result['applied']
    mod, = env.library.mods()
    assert mod.id == result['libraryId']
    assert all(p.read_bytes() == (mod.file.parent / p.name).read_bytes() for p in env.parts)
    row, = rpc(env, 'mods.other')
    assert row['id'] == mod.id and row['selected'] and row['state'] == 'active'
    duplicate, = analyze(env, sources)['entries']
    assert duplicate['state'] == 'library' and duplicate['libraryId'] == mod.id
    finish(env, rpc(env, 'actions.restore', variant=mod.target, kind='other'))
    assert rpc(env, 'mods.other')[0]['state'] == 'official'
    assert all(p.read_bytes() == data for p, data in env.official.items())
    finish(env, rpc(env, 'actions.apply', variant=mod.target, source=f'mod:{mod.id}', kind='other'))
    finish(env, rpc(env, 'mods.remove', id=mod.id, confirm=True))
    assert rpc(env, 'mods.other') == []
    assert all(p.read_bytes() == data for p, data in env.official.items())


def test_generic_old_batch_uses_classic_update_then_add_and_deferred_apply(batch_other_env, monkeypatch):
    env = batch_other_env
    old = game_bundle(env.tmp / 'old', 'common', category='ui', part='textures', date='2025-01-01', payload=b'old mod')
    key = ('Assets/UI/title', 'title', 'Texture2D')
    monkeypatch.setattr(Bundle, 'load', lambda path, *args: SimpleNamespace(get_asset_keys=lambda strategy: {key}))
    entry, = analyze(env, [old])['entries']
    assert entry['state'] == 'update' and entry['files'][0]['target'] == env.parts[0].name
    calls = []
    updater(monkeypatch, calls)
    assert not env.library.toggle(False, True).failed
    result, = run(env, [entry], strategy='cont_name_type')
    assert result['outcome'] == 'updated' and not result['applied']
    assert calls[0][1]['source_paths'] == [old]
    assert [p.name for p in calls[0][1]['target_paths']] == [env.parts[0].name]
    assert rpc(env, 'mods.other')[0]['state'] == 'set'
    assert not env.library.toggle(True, False).failed
    assert env.parts[0].read_bytes() == env.library.mods()[0].file.read_bytes()


def test_generic_installed_untracked_multi_file_batch_is_recognized(batch_other_env):
    env = batch_other_env
    uploads = [make_mod(p, env.tmp / 'incoming') for p in env.parts]
    for target, source in zip(env.parts, uploads):
        Path(str(target) + '.backup').write_bytes(env.official[target])
        target.write_bytes(source.read_bytes())
    entry, = analyze(env, uploads)['entries']
    assert entry['state'] == 'installed'
    assert not env.library.mods()
    result = env.library.add_files('other', uploads)
    assert result.installed == result.added
    assert env.library.other_mods()[0]['selected']


def test_generic_multi_prefix_updates_keep_each_patch_with_its_official_targets(batch_other_env, monkeypatch):
    env = batch_other_env
    sources = [game_bundle(env.tmp / 'old', 'common', category=category, part=part, date='2025-01-01', payload=b'old')
               for category, part in [('ui', 'textures'), ('music', 'audio')]]
    monkeypatch.setattr(Bundle, 'load', lambda path, *args: SimpleNamespace(get_asset_keys=lambda strategy: {'shared-name'}))
    entry, = analyze(env, sources)['entries']
    assert entry['state'] == 'update'
    calls = []
    updater(monkeypatch, calls)
    result, = run(env, [entry], enableAfterImport=False, types=['ALL'])
    assert result['outcome'] == 'updated'
    assert len(calls) == 2
    for _, call in calls:
        assert len(call['source_paths']) == len(call['target_paths']) == 1
        assert call['asset_types_to_replace'] == {'ALL'}
        source, target = call['source_paths'][0], call['target_paths'][0]
        from ba_modding_toolkit.naming import parse_filename
        assert parse_filename(source.name).prefix == parse_filename(target.name).prefix


def test_generic_old_bundle_can_split_into_multiple_current_official_files(batch_other_env, monkeypatch):
    env = batch_other_env
    split = game_bundle(env.game_dir, 'common', category='ui', part='materials')
    old = game_bundle(env.tmp / 'old', 'common', category='ui', part='003', date='2025-01-01', payload=b'old')
    monkeypatch.setattr(Bundle, 'load', lambda path, *args: SimpleNamespace(get_asset_keys=lambda strategy: {'shared-name'}))
    entry, = analyze(env, [old])['entries']
    assert entry['state'] == 'update'
    calls = []
    updater(monkeypatch, calls)
    result, = run(env, [entry])
    assert result['outcome'] == 'updated' and result['applied']
    mod, = env.library.mods()
    assert len(list(mod.file.parent.glob('*.bundle'))) == 2
    assert set(rpc(env, 'mods.other')[0]['files']) == {env.parts[0].name, split.name}
    assert not env.library.toggle(False, True).failed
    assert not env.library.toggle(True, False).failed
    assert env.parts[0].read_bytes() == (mod.file.parent / env.parts[0].name).read_bytes()
    assert split.read_bytes() == (mod.file.parent / split.name).read_bytes()


def test_generic_classic_queue_pins_every_target_slot(batch_other_env):
    from ba_modding_toolkit.library.judge import core_of

    env = batch_other_env
    mod, = env.library.add_files('other', [make_mod(p, env.tmp / 'incoming') for p in env.parts])
    count = env.services.queue_call('actions.apply', {'variant': mod.target, 'kind': 'other', 'source': f'mod:{mod.id}'})
    assert count == 1
    call, = env.services.queue.items()
    assert {core for _, core in call.entries} == {core_of(p.name) for p in env.parts}
    assert len(call.files) == len(env.parts)
