"""Fault injection at each boundary of a multi-file library import transaction."""

from __future__ import annotations

import errno
import json
from pathlib import Path

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import service, storage

from test_library import game_bundle, make_mod, reload_library, setup_library


def upload(env, folder="incoming"):
    directory = env.tmp / folder
    return [game_bundle(directory, part=part, payload=f"uploaded {folder} {part}".encode())
            for part in ("textures", "textassets")]


def journals(env):
    return sorted((env.root / "import-transactions").glob("*/journal.json"))


def baseline(env):
    path = make_mod(env.original, env.tmp / "previous", payload=b"previous independent mod")
    old, = env.library.add_files("spr", [path])
    return old, (env.root / "state.json").read_bytes(), {
        item.relative_to(env.root): item.read_bytes() for item in (env.root / "mods").rglob("*.bundle")}


def assert_previous(env, old, metadata, files):
    assert [mod.id for mod in env.library.mods()] == [old.id]
    assert (env.root / "state.json").read_bytes() == metadata
    assert {item.relative_to(env.root): item.read_bytes()
            for item in (env.root / "mods").rglob("*.bundle")} == files
    assert not journals(env)


@pytest.mark.parametrize("fail_at", [1, 2])
def test_file_copy_failure_preserves_previously_completed_mod(setup_library, monkeypatch, fail_at):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    copy = service.atomic_copy
    attempts = []
    def fail_second(source, target):
        if "import-transactions" in target.parts:
            attempts.append(target)
            if len(attempts) == fail_at:
                raise OSError(errno.ENOSPC, "Synthetic disk full", str(target))
        return copy(source, target)
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_copy", fail_second)
        with pytest.raises(ServiceError, match="library_io_error"):
            env.library.add_files("spr", paths)
    assert len(attempts) == fail_at
    assert_previous(env, old, metadata, files)


@pytest.mark.parametrize("corrupt_at", [1, 2])
def test_each_staged_file_is_verified_before_group_publication(setup_library, monkeypatch, corrupt_at):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    copy = service.atomic_copy
    count = 0
    def corrupt_copy(source, target):
        nonlocal count
        result = copy(source, target)
        if "import-transactions" in target.parts:
            count += 1
            if count == corrupt_at:
                target.write_bytes(b"Synthetic silently corrupted transfer")
        return result
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_copy", corrupt_copy)
        with pytest.raises((OSError, ServiceError)):
            env.library.add_files("spr", paths)
    assert count == corrupt_at
    assert_previous(env, old, metadata, files)


@pytest.mark.parametrize("published", [False, True])
def test_metadata_failure_before_or_after_publication_rolls_back_exact_prior_state(setup_library, monkeypatch, published):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    write = service.atomic_json
    failed = False
    def fail_metadata(path, data):
        nonlocal failed
        if path == env.root / "state.json" and not failed:
            failed = True
            if published:
                write(path, data)
            raise OSError(errno.EIO, "Synthetic metadata failure", str(path))
        return write(path, data)
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", fail_metadata)
        with pytest.raises(ServiceError, match="library_io_error"):
            env.library.add_files("spr", paths)
    assert failed
    assert_previous(env, old, metadata, files)


@pytest.mark.parametrize("boundary", ["copy", "directory", "metadata"])
def test_restart_recovers_interrupted_multi_file_import_at_commit_boundaries(setup_library, monkeypatch, boundary):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    copy, replace, write = service.atomic_copy, service.os.replace, service.atomic_json
    count = 0
    def copying(source, target):
        nonlocal count
        if "import-transactions" in target.parts:
            count += 1
            if boundary == "copy" and count == 2:
                raise SystemExit("Synthetic termination during copy")
        return copy(source, target)
    def replacing(source, target):
        result = replace(source, target)
        if boundary == "directory" and Path(source).name == "files" and Path(target).parent == env.root / "mods":
            raise SystemExit("Synthetic termination after directory publication")
        return result
    def writing(path, data):
        result = write(path, data)
        if boundary == "metadata" and path == env.root / "state.json":
            raise SystemExit("Synthetic termination after metadata publication")
        return result
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_copy", copying)
        patch.setattr(service.os, "replace", replacing)
        patch.setattr(service, "atomic_json", writing)
        with pytest.raises(SystemExit):
            env.library.add_files("spr", paths)
    journal, = journals(env)
    transaction = json.loads(journal.read_text())
    new_id = transaction["id"]
    assert journal.exists()
    env.library = reload_library(env)
    if boundary == "metadata":
        assert {mod.id for mod in env.library.mods()} == {old.id, new_id}
        assert {path.name: path.read_bytes() for path in (env.root / "mods" / new_id).iterdir()} == {
            path.name: path.read_bytes() for path in paths}
        assert not journals(env)
    else:
        assert_previous(env, old, metadata, files)
        assert not (env.root / "mods" / new_id).exists()


def test_rollback_failure_retains_journal_and_retries_after_lock_is_released(setup_library, monkeypatch):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    write, remove = service.atomic_json, service.shutil.rmtree
    failed = False
    def fail_metadata(path, data):
        nonlocal failed
        if path == env.root / "state.json" and not failed:
            failed = True
            raise OSError(errno.ENOSPC, "Synthetic disk full", str(path))
        return write(path, data)
    def locked_directory(path, *args, **kwargs):
        if Path(path).parent == env.root / "mods" and Path(path).name != old.id:
            raise PermissionError(errno.EACCES, "Synthetic locked directory", str(path))
        return remove(path, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", fail_metadata)
        patch.setattr(service.shutil, "rmtree", locked_directory)
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            env.library.add_files("spr", paths)
        journal, = journals(env)
        assert json.loads(journal.read_text())["phase"] == "rollback"
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            env.library.mods()
    env.library = reload_library(env)
    assert_previous(env, old, metadata, files)


def test_recovery_does_not_finalize_committed_group_with_changed_bytes(setup_library, monkeypatch):
    env = setup_library
    baseline(env)
    paths = upload(env)
    write = service.atomic_json
    def committed_crash(path, data):
        write(path, data)
        if path == env.root / "state.json":
            raise SystemExit("Synthetic termination after metadata publication")
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", committed_crash)
        with pytest.raises(SystemExit):
            env.library.add_files("spr", paths)
    journal, = journals(env)
    data = json.loads(journal.read_text())
    target = env.root / "mods" / data["id"] / paths[0].name
    target.write_bytes(b"Synthetic post-commit corruption")
    recovered = reload_library(env)
    with pytest.raises(ServiceError, match="library_recovery_pending"):
        recovered.mods()
    assert journal.exists()
    assert target.read_bytes() == b"Synthetic post-commit corruption"


def test_failed_repair_restores_existing_repaired_id(setup_library, monkeypatch):
    env = setup_library
    old, _, _ = baseline(env)
    previous_id = "e" * 32
    env.library._records[old.id]["repaired_id"] = previous_id
    env.library._save()
    metadata = (env.root / "state.json").read_bytes()
    paths = upload(env)
    write = service.atomic_json
    failed = False
    def fail_metadata(path, data):
        nonlocal failed
        result = write(path, data)
        if path == env.root / "state.json" and not failed:
            failed = True
            raise OSError(errno.EIO, "Synthetic failure after repair publication", str(path))
        return result
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", fail_metadata)
        with env.library._transaction_lock():
            with pytest.raises(OSError):
                env.library._store({path.name: path for path in paths}, "repair", "test", "spr", repaired_from=old.id)
    assert env.library._records[old.id]["repaired_id"] == previous_id
    assert (env.root / "state.json").read_bytes() == metadata
    assert not journals(env)


@pytest.mark.parametrize("damage", ["id", "file", "parent_symlink"])
def test_invalid_import_journal_never_deletes_outside_owned_uuid(setup_library, damage):
    env = setup_library
    outside = env.tmp / "outside"
    outside.mkdir()
    sentinel = outside / "keep.bundle"
    sentinel.write_bytes(b"unrelated user content")
    mod_id = "a" * 32
    root = env.root / "import-transactions"
    transaction = root / mod_id
    root.mkdir(parents=True, exist_ok=True)
    if damage == "parent_symlink":
        transaction.symlink_to(outside, target_is_directory=True)
    else:
        transaction.mkdir()
    filename = "../outside/keep.bundle" if damage == "file" else "keep.bundle"
    identifier = "../../outside" if damage == "id" else mod_id
    data = {"version": 1, "id": identifier, "phase": "preparing", "record": {"id": identifier, "files": [filename]},
            "hashes": {filename: "b" * 40}, "repaired_from": "", "old_repaired_id": None}
    journal = transaction / "journal.json"
    journal.write_text(json.dumps(data))
    with pytest.raises(ServiceError, match="library_recovery_pending"):
        env.library._recover_pending()
    assert sentinel.read_bytes() == b"unrelated user content"
    assert journal.exists()


def test_import_recovery_rejects_symlinked_mods_parent_before_outside_io(setup_library, monkeypatch):
    env = setup_library
    mod_id = "a" * 32
    outside = env.tmp / "unrelated"
    victim = outside / mod_id
    victim.mkdir(parents=True)
    sentinel = victim / "keep.bundle"
    sentinel.write_bytes(b"unrelated complete files")
    env.root.mkdir(parents=True, exist_ok=True)
    (env.root / "mods").symlink_to(outside, target_is_directory=True)
    transaction = env.root / "import-transactions" / mod_id
    transaction.mkdir(parents=True)
    journal = transaction / "journal.json"
    journal.write_text(json.dumps({"version": 1, "id": mod_id, "phase": "rollback",
        "record": {"id": mod_id, "files": [sentinel.name]}, "hashes": {sentinel.name: "b" * 40},
        "repaired_from": "", "old_repaired_id": None}))
    verify, remove = service.verify_file, service.shutil.rmtree
    outside_attempts = []

    def guarded_verify(path, *args, **kwargs):
        if Path(path).resolve().is_relative_to(outside):
            outside_attempts.append(("read", Path(path)))
        assert not Path(path).resolve().is_relative_to(outside), "Recovery read outside the library"
        return verify(path, *args, **kwargs)

    def guarded_remove(path, *args, **kwargs):
        if Path(path).resolve().is_relative_to(outside):
            outside_attempts.append(("delete", Path(path)))
        assert not Path(path).resolve().is_relative_to(outside), "Recovery deleted outside the library"
        return remove(path, *args, **kwargs)

    monkeypatch.setattr(service, "verify_file", guarded_verify)
    monkeypatch.setattr(service.shutil, "rmtree", guarded_remove)
    with pytest.raises(ServiceError, match="library_recovery_pending"):
        env.library._recover_pending()
    assert sentinel.read_bytes() == b"unrelated complete files"
    assert journal.exists()
    assert outside_attempts == []


def test_rollback_retry_syncs_already_removed_metadata_before_deleting_files(setup_library, monkeypatch):
    env = setup_library
    old, metadata, files = baseline(env)
    paths = upload(env)
    write, sync = service.atomic_json, storage.sync_directory
    metadata_started = False
    root_syncs = []

    def writing(path, data):
        nonlocal metadata_started
        if path == env.root / "state.json":
            metadata_started = True
        return write(path, data)

    def failed_state_sync(path):
        if metadata_started and Path(path) == env.root:
            root_syncs.append(Path(path))
            raise OSError(errno.EIO, "Synthetic state parent sync failure", str(path))
        return sync(path)

    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", writing)
        patch.setattr(storage, "sync_directory", failed_state_sync)
        patch.setattr(service, "sync_directory", failed_state_sync)
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            env.library.add_files("spr", paths)
        journal, = journals(env)
        data = json.loads(journal.read_text())
        directory = env.root / "mods" / data["id"]
        assert data["phase"] == "rollback"
        assert (env.root / "state.json").read_bytes() == metadata
        assert directory.is_dir()
        # Metadata already excludes the failed import. Recovery must still fence that removal.
        before = len(root_syncs)
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            env.library._recover_pending()
        assert len(root_syncs) > before
        assert journal.exists() and directory.is_dir()
        assert {path.name: path.read_bytes() for path in directory.iterdir()} == {
            path.name: path.read_bytes() for path in paths}
    env.library = reload_library(env)
    assert_previous(env, old, metadata, files)


def test_committed_recovery_retains_journal_until_metadata_sync_succeeds(setup_library, monkeypatch):
    env = setup_library
    old, _, _ = baseline(env)
    paths = upload(env)
    write, sync = service.atomic_json, storage.sync_directory
    metadata_started = False

    def writing(path, data):
        nonlocal metadata_started
        if Path(path).name == "journal.json" and data.get("phase") == "rollback":
            raise OSError(errno.EIO, "Synthetic rollback journal failure", str(path))
        if path == env.root / "state.json":
            metadata_started = True
        return write(path, data)

    def failed_state_sync(path):
        if metadata_started and Path(path) == env.root:
            raise OSError(errno.EIO, "Synthetic state parent sync failure", str(path))
        return sync(path)

    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", writing)
        patch.setattr(storage, "sync_directory", failed_state_sync)
        patch.setattr(service, "sync_directory", failed_state_sync)
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            env.library.add_files("spr", paths)
    journal, = journals(env)
    data = json.loads(journal.read_text())
    new_id = data["id"]
    assert data["phase"] == "publishing"
    assert new_id in {record["id"] for record in json.loads((env.root / "state.json").read_text())["mods"]}
    with monkeypatch.context() as patch:
        patch.setattr(service, "sync_directory", failed_state_sync)
        patch.setattr(storage, "sync_directory", failed_state_sync)
        recovered = reload_library(env)
        with pytest.raises(ServiceError, match="library_recovery_pending"):
            recovered.mods()
        assert journal.exists()
        assert {path.name: path.read_bytes() for path in (env.root / "mods" / new_id).iterdir()} == {
            path.name: path.read_bytes() for path in paths}
    recovered = reload_library(env)
    assert {mod.id for mod in recovered.mods()} == {old.id, new_id}
    assert not journals(env)
