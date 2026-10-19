"""The mod configuration (profiles.json), the Enable Mods switch, adoption, drift and built copies, with synthetic
header-only bundles in temporary game folders (never a real install, library or settings)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library.profiles import Profiles


def expect_error(code, action):
    with pytest.raises(ServiceError) as caught:
        action()
    assert caught.value.code == code, caught.value
    json.dumps(caught.value.to_json())
    return caught.value


# --- profiles.json ---

def test_profiles_round_trip_keeps_unknown_keys(tmp_path):
    profiles = Profiles(tmp_path)
    assert profiles.read() is None
    profiles.update(lambda data: data.update(enabled=False, future={"kept": 1}))
    profiles.update(lambda data: data["folders"].setdefault("/game", {"server": "global", "later": [1]}))
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False and data["future"] == {"kept": 1}
    assert data["folders"]["/game"]["later"] == [1]
    assert json.loads((tmp_path / "profiles.json").read_text())["future"] == {"kept": 1}


def test_two_profiles_on_one_file_keep_both_changes(tmp_path):
    first, second = Profiles(tmp_path), Profiles(tmp_path)
    first.read(), second.read()
    first.update(lambda data: data["folders"].setdefault("/a", {"server": "global"}))
    second.update(lambda data: data["folders"].setdefault("/b", {"server": "japan"}))
    assert set(first.read()["folders"]) == set(second.read()["folders"]) == {"/a", "/b"}


def test_a_missing_switch_means_on(tmp_path):
    from ba_modding_toolkit.library.profiles import enabled
    assert enabled(None) and enabled({"version": 1, "folders": {}})
    (tmp_path / "profiles.json").write_text('{"version": 1, "folders": {}}')
    assert enabled(Profiles(tmp_path).read())


def test_a_corrupt_file_reads_its_last_good_copy_and_keeps_the_bad_one(tmp_path):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    profiles.update(lambda data: data["folders"].setdefault("/game", {"server": "global"}))
    (tmp_path / "profiles.json").write_text("{broken")
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False  # mods stay off: nothing is lost
    Profiles(tmp_path).update(lambda data: data.update(note="next write"))
    assert (tmp_path / "profiles.json.bad").read_text() == "{broken"
    assert Profiles(tmp_path).read()["note"] == "next write"


def test_a_missing_file_with_its_prev_reads_the_prev(tmp_path):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    profiles.update(lambda data: data.update(toggled="t"))
    (tmp_path / "profiles.json").unlink()
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False and "toggled" not in data  # the last good file before the last write


def test_both_files_unreadable_is_an_error_and_writes_nothing(tmp_path):
    (tmp_path / "profiles.json").write_text("{broken")
    (tmp_path / "profiles.json.prev").write_text("[]")
    profiles = Profiles(tmp_path)
    expect_error("profiles_unreadable", profiles.read)
    expect_error("profiles_unreadable", lambda: profiles.update(lambda data: data.update(enabled=False)))
    assert (tmp_path / "profiles.json").read_text() == "{broken"
    assert not (tmp_path / "profiles.json.bad").exists()


def test_a_failed_write_keeps_the_file_as_it_was(tmp_path, monkeypatch):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    before = (tmp_path / "profiles.json").read_bytes()
    from ba_modding_toolkit import filelock
    real = filelock.os.replace

    def fail(source, target):
        if Path(target).name == "profiles.json":
            raise PermissionError(13, "Read-only", str(target))
        return real(source, target)

    monkeypatch.setattr(filelock.os, "replace", fail)
    with pytest.raises(PermissionError):
        profiles.update(lambda data: data.update(enabled=True))
    monkeypatch.setattr(filelock.os, "replace", real)
    assert (tmp_path / "profiles.json").read_bytes() == before
    assert Profiles(tmp_path).read()["enabled"] is False
    assert not list(tmp_path.glob(".profiles.json.*"))


def test_a_change_may_write_nothing(tmp_path):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: False)
    assert not (tmp_path / "profiles.json").exists()
