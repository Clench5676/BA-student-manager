"""Library failures redact private files before creating log records."""

import errno
import logging
from pathlib import Path

import pytest

from ba_modding_toolkit import filelock
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import ModLibrary, profiles, service, staging

from test_library import setup_library


def assert_private_logs(caplog, *private_values):
    assert caplog.records
    for record in caplog.records:
        assert record.exc_info is None
        assert record.exc_text is None
        assert all(value not in record.getMessage() for value in private_values)
        assert all(value not in str(record.args) for value in private_values)


@pytest.mark.parametrize("filename", [
    "/Volumes/Private Client/library/state.json",
    "/Volumes/Private Client/library/state.json.lock",
    "/Volumes/Private Client/library/state.json.random.tmp",
    "/Volumes/Private Client/library/",
    "state.json",
    "state.json.lock",
    "Private Directory",
    "/Volumes/Client's Library/state.json",
    r"D:\Private Client\library\state.json.lock",
    r"\\Private Server\Private Client\library\state.json",
])
def test_file_failure_redacts_every_path_and_keeps_errno(caplog, filename):
    error = PermissionError(errno.EACCES, "Permission denied", filename)
    with pytest.raises(ServiceError) as caught, service._errors("save"):
        raise error
    assert caught.value.code == "library_io_error"
    assert caught.value.params["file"] == filename
    assert caught.value.__cause__ is error
    record, = caplog.records
    assert record.getMessage() == (
        "Library file operation failed: PermissionError (code=library_io_error, errno=13): "
        "[Errno 13] Permission denied: [path]"
    )
    assert_private_logs(caplog, filename, "Private Client", "state.json", "Client's Library")


def test_failed_rename_redacts_source_and_destination(caplog):
    source = "/Volumes/Private Client/library/state.json.temporary"
    target = "/Volumes/Second Client/library/state.json"
    with pytest.raises(ServiceError), service._errors("save"):
        raise PermissionError(errno.EACCES, "Permission denied", source, None, target)
    assert caplog.records[0].getMessage().endswith("Permission denied: [path] -> [path]")
    assert_private_logs(caplog, source, target, "Private Client", "Second Client", "state.json")


@pytest.mark.parametrize("message", [
    "Cannot save /Volumes/Private Client/library/state.json",
    "Cannot save /Volumes/Private Client/library/state.json.lock",
    "Cannot save /Volumes/Private Client/library/temporary-state",
    "Cannot read /Volumes/Private Client/library/",
    "Cannot read /Volumes/Private Client's Library",
    "Cannot read Private Client/library/state.json",
    r"Cannot lock D:\Private Client\library\state.json.lock",
    r"Cannot read \\Private Server\Private Client\library",
    "Cannot write state.json.lock",
    "Cannot read 'Private Directory'",
    "Cannot read %2FVolumes%2FPrivate%20Client%2Flibrary%2Fstate.json",
    "Cannot read &#47;Volumes&#47;Private Client&#47;library",
    "Cannot read /Volumes/Private Client/library/\nprivate temporary name",
])
def test_unstructured_failure_messages_do_not_leak_paths(caplog, message):
    with pytest.raises(ServiceError, match="library_operation_failed"), service._errors("save"):
        raise RuntimeError(message)
    record, = caplog.records
    assert "RuntimeError (code=library_operation_failed, errno=None)" in record.getMessage()
    assert "[path]" in record.getMessage()
    assert_private_logs(caplog, "Private", "Client", "state.json", "temporary", "Volumes")


def test_failure_keeps_safe_message(caplog):
    with pytest.raises(ServiceError), service._errors("save"):
        raise ValueError("Invalid library schema")
    assert caplog.records[0].getMessage().endswith(
        "ValueError (code=library_operation_failed, errno=None): Invalid library schema"
    )


@pytest.mark.parametrize("fail_lock", [False, True])
def test_saving_state_redacts_state_and_lock_failures(setup_library, monkeypatch, caplog, fail_lock):
    env = setup_library
    library = ModLibrary(env.tmp / "Private Client" / "library", env.catalog, settings=env.settings)
    state_file = library.root / "state.json"
    lock_file = library.root / "state.json.lock"

    def fail_save(path, data):
        assert path == state_file
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    def fail_open(path, *args, **kwargs):
        assert path == lock_file
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(service, "atomic_json", fail_save)
    if fail_lock:
        monkeypatch.setattr(filelock, "open", fail_open, raising=False)
    caplog.clear()
    with pytest.raises(ServiceError, match="library_io_error"):
        library.set_favorite("test", True)
    assert library.favorites() == set()
    assert len(caplog.records) == (2 if fail_lock else 1)
    for record in caplog.records:
        assert "PermissionError" in record.getMessage()
        assert "errno=13" in record.getMessage()
        assert "Permission denied: [path]" in record.getMessage()
    assert_private_logs(caplog, str(env.tmp), "Private Client", "state.json", str(lock_file))


@pytest.mark.parametrize("operation", ["load", "rollback", "prune", "consent"])
def test_recoverable_library_failures_also_redact_paths(setup_library, monkeypatch, caplog, operation):
    library = setup_library.library
    private = "/Volumes/Private Client/library/state.json.lock"

    def fail(*args, **kwargs):
        raise PermissionError(errno.EACCES, "Permission denied", private)

    caplog.clear()
    if operation == "load":
        monkeypatch.setattr(Path, "read_text", fail)
        library._load()
    elif operation == "rollback":
        monkeypatch.setattr(library, "_save", fail)
        library._drop_mods(["missing"])
    elif operation == "prune":
        monkeypatch.setattr(library, "_prune", fail)
        library._prune_quietly()
    else:
        monkeypatch.setattr(library, "_scan_allowed_input", fail)
        assert not library._scan_allowed()
    record, = caplog.records
    assert "PermissionError" in record.getMessage() and "errno=13" in record.getMessage()
    assert_private_logs(caplog, private, "Private Client", "state.json")


def test_profiles_fallback_failures_redact_paths(tmp_path, monkeypatch, caplog):
    root = tmp_path / "Private Client" / "library"
    root.mkdir(parents=True)
    config = profiles.Profiles(root)
    config.path.touch()
    config.prev.touch()

    def fail(path):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(profiles, "_parse", fail)
    with pytest.raises(ServiceError, match="profiles_unreadable"):
        config.read()
    assert len(caplog.records) == 2
    assert all("PermissionError" in record.getMessage() and "errno=13" in record.getMessage()
               for record in caplog.records)
    assert_private_logs(caplog, str(tmp_path), "Private Client", "profiles.json")


@pytest.mark.parametrize("fail_cleanup", [False, True])
def test_staging_failure_redacts_directories_and_lock_files(tmp_path, monkeypatch, caplog, fail_cleanup):
    root = tmp_path / "Private Client" / "library"
    temporary = root / "staging" / "import-private"
    temporary.mkdir(parents=True)

    def fail(path, **kwargs):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    if fail_cleanup:
        monkeypatch.setattr(staging, "file_lock", fail)
    else:
        monkeypatch.setattr(staging, "_stale", lambda *args: True)
        monkeypatch.setattr(staging.shutil, "rmtree", fail)
    staging.cleanup(root)
    assert temporary.exists()
    record, = caplog.records
    assert "PermissionError" in record.getMessage() and "errno=13" in record.getMessage()
    assert_private_logs(caplog, str(tmp_path), "Private Client", "import-private", ".lock")


def test_service_failure_retains_code_without_private_parameters(setup_library, monkeypatch, caplog):
    error = ServiceError("library_io_error", file="/Volumes/Private Client/library/state.json")

    def fail():
        raise error

    monkeypatch.setattr(setup_library.library, "_prune", fail)
    with caplog.at_level(logging.WARNING):
        setup_library.library._prune_quietly()
    assert "ServiceError (code=library_io_error, errno=None): library_io_error" in caplog.text
    assert_private_logs(caplog, "Private Client", "state.json")
