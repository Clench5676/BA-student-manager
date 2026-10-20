"""webui.json shared by several app instances (webui/state.py UiState): a change is applied to the file as it is
then, so no instance erases another's keys."""

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

import ba_modding_toolkit
from ba_modding_toolkit.webui.state import ALIAS_LENGTH, ALIAS_MAX, FLAGS, UiState, _replace, data_path


def test_instances_keep_each_others_keys(tmp_path):
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    a.set("roster", {"sort": "name"})
    b.set("voice_volume", 40)  # b never read a's roster: it must not write its own stale copy over it
    b.set_consent(True)
    a.set("lobby_zoom_out", True)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["prefs"] == {"roster": {"sort": "name"}, "voice_volume": 40, "lobby_zoom_out": True}
    assert data["consent"] is True
    fresh = UiState(path)
    assert fresh.get("roster") == {"sort": "name"} and fresh.get("voice_volume") == 40 and fresh.consent is True


def test_reads_follow_the_other_instances(tmp_path):
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    assert b.consent is None and b.get("roster") is None
    a.set_consent(False)
    a.set("roster", {"sort": "added"})
    assert b.consent is False
    assert b.get("roster") == {"sort": "added"}


def test_visits_of_both_instances_are_merged(tmp_path):
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    a.visit("hoshino")
    b.visit("shiroko")
    a.visit("ch0241")
    b.visit("hoshino")
    assert UiState(path).recent() == ["hoshino", "ch0241", "shiroko"]


def test_seen_mods_persist_and_merge_between_instances(tmp_path):
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    assert a.seen_mods() == set()
    a.mark_mods_seen(["portrait", "portrait"])
    b.mark_mods_seen(["lobby"])
    a.visit("student")
    assert a.seen_mods() == b.seen_mods() == UiState(path).seen_mods() == {"portrait", "lobby"}
    assert json.loads(path.read_text()) == {"seen_mods": ["lobby", "portrait"], "recent": ["student"]}
    snapshot = a.seen_mods()
    snapshot.clear()
    assert a.seen_mods() == {"portrait", "lobby"}


@pytest.mark.parametrize("stored", [None, {}, "mod", [None, 1, {}, "", "kept", "kept"]])
def test_seen_mods_ignore_malformed_state(tmp_path, stored):
    path = tmp_path / "webui.json"
    path.write_text(json.dumps({"seen_mods": stored, "prefs": {"voice_volume": 20}}))
    state = UiState(path)
    expected = {"kept"} if isinstance(stored, list) else set()
    assert state.seen_mods() == expected
    state.mark_mods_seen(["new"])
    assert UiState(path).seen_mods() == expected | {"new"}
    assert state.get("voice_volume") == 20


def test_an_unreadable_file_keeps_what_is_known(tmp_path):
    path = tmp_path / "webui.json"
    state = UiState(path)
    state.set_consent(True)
    path.write_text("{ not json", encoding="utf-8")
    assert state.consent is True  # the last known state, not nothing
    state.set("voice_volume", 10)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data == {"consent": True, "prefs": {"voice_volume": 10}}
    # a malformed prefs entry is replaced, not a crash
    path.write_text(json.dumps({"consent": True, "prefs": [1, 2]}), encoding="utf-8")
    assert state.get("voice_volume", 80) == 80
    state.set("voice_muted", True)
    assert UiState(path).get("voice_muted") is True
    assert not list(tmp_path.glob("*.tmp")), "no temporary file is left behind"


def test_a_write_waits_for_another_instance_reading(tmp_path, monkeypatch):
    """Windows cannot replace a file another process has open (Python opens files without FILE_SHARE_DELETE): an
    instance reads the file another one wrote under the lock the instances share, so a write waits for the read
    instead of failing. Windows' rule is played here: os.replace fails while a reader has the file open."""
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    a.set("voice_volume", 40)  # b reads the file again on its next look
    held, reading, release = [0], threading.Event(), threading.Event()
    real_read_text, real_replace = Path.read_text, os.replace

    def read_text(self, *args, **kwargs):
        if self != path or threading.current_thread().name != "reader":
            return real_read_text(self, *args, **kwargs)
        held[0] += 1
        try:
            reading.set()
            release.wait(10)
            return real_read_text(self, *args, **kwargs)
        finally:
            held[0] -= 1

    def replace(src, dst):
        if Path(dst) == path and held[0]:
            raise PermissionError(13, "The process cannot access the file because it is being used by another "
                                      "process", str(dst))
        real_replace(src, dst)

    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr(os, "replace", replace)
    seen, errors = [], []

    def write():
        try:
            a.set("voice_muted", True)
        except OSError as err:
            errors.append(err)

    reader = threading.Thread(target=lambda: seen.append(b.get("voice_volume")), name="reader")
    writer = threading.Thread(target=write, name="writer")
    reader.start()
    assert reading.wait(10)
    writer.start()
    writer.join(0.3)  # unlocked, the write would fail at once; locked, it waits for the read
    release.set()
    reader.join(10)
    writer.join(10)
    assert errors == []
    assert seen == [40]
    assert UiState(path).get("voice_muted") is True and UiState(path).get("voice_volume") == 40


def test_a_file_held_for_a_moment_is_replaced_once_let_go(tmp_path, monkeypatch):
    """Another program holding the file without delete sharing (on Windows a virus scanner or the search indexer
    looking at it) delays a write for a moment instead of failing it."""
    calls = []
    real_replace = os.replace

    def replace(src, dst):
        calls.append(dst)
        if len(calls) < 3:
            raise PermissionError(13, "Access is denied", str(dst))
        real_replace(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    src, dst = tmp_path / "new.tmp", tmp_path / "webui.json"
    src.write_text("{}", encoding="utf-8")
    _replace(str(src), dst, tries=5, wait=0)
    assert len(calls) == 3 and dst.read_text(encoding="utf-8") == "{}" and not src.exists()
    # held for longer: the error comes out once the tries are spent
    calls.clear()
    src.write_text("{}", encoding="utf-8")
    with pytest.raises(PermissionError):
        _replace(str(src), dst, tries=2, wait=0)
    assert len(calls) == 2


def test_own_aliases_are_kept_per_student_and_merged(tmp_path):
    path = tmp_path / "webui.json"
    a, b = UiState(path), UiState(path)
    assert a.aliases() == {}
    assert a.set_aliases("momoi", ["\u5c0f\u6843", "Momo"]) == ["\u5c0f\u6843", "Momo"]
    b.set_aliases("kanna", ["\u5eb7\u5a1c"])  # b never read a's entry: it must not write a stale copy over it
    b.set("voice_volume", 40)
    assert UiState(path).aliases() == {"momoi": ["\u5c0f\u6843", "Momo"], "kanna": ["\u5eb7\u5a1c"]}
    assert a.aliases()["kanna"] == ["\u5eb7\u5a1c"]  # reads follow the other instance
    # none left: the student's entry goes, the others stay
    assert a.set_aliases("momoi", ["", "  "]) == []
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["aliases"] == {"kanna": ["\u5eb7\u5a1c"]} and data["prefs"] == {"voice_volume": 40}


def test_own_aliases_are_cleaned(tmp_path):
    state = UiState(tmp_path / "webui.json")
    kept = state.set_aliases("momoi", [
        "  Momo \t chan ",        # whitespace runs become one space, trimmed
        "momo  chan",             # the same alias ignoring case: dropped
        "\uff2d\uff4f\uff4d\uff4f chan",  # full width: the same again
        "a\u0000b\u200bc\u202ed",  # control and format characters are dropped
        "x" * (ALIAS_LENGTH + 1),  # too long: dropped
        "<b>x</b>",               # markup is kept as text; the page never reads it as HTML
        7, None,                  # not text
    ])
    assert kept == ["Momo chan", "abcd", "<b>x</b>"]
    assert state.set_aliases("many", [f"a{i}" for i in range(ALIAS_MAX + 3)]) == [f"a{i}" for i in range(ALIAS_MAX)]
    # a hand-edited file is read the same way
    (tmp_path / "webui.json").write_text(json.dumps({"aliases": {"x": ["ok", 3, ""], "y": "no", "z": []}}),
                                         encoding="utf-8")
    assert UiState(tmp_path / "webui.json").aliases() == {"x": ["ok"]}
    (tmp_path / "webui.json").write_text(json.dumps({"aliases": ["x"]}), encoding="utf-8")
    state = UiState(tmp_path / "webui.json")
    assert state.aliases() == {}
    assert state.set_aliases("x", ["ok"]) == ["ok"]  # a malformed table is replaced, not a crash
    assert UiState(tmp_path / "webui.json").aliases() == {"x": ["ok"]}


WRITER = """
import sys
from ba_modding_toolkit.webui.state import UiState
path, prefix, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
state = UiState(path)
for i in range(count):
    state.set(f"{prefix}{i}", i)
    state.visit(f"{prefix}{i}")
"""


def test_processes_writing_at_once_lose_nothing(tmp_path):
    path = tmp_path / "webui.json"
    # the children import the package this test imported
    env = {**os.environ, "PYTHONPATH": str(Path(ba_modding_toolkit.__file__).resolve().parents[1])}
    writers = [subprocess.Popen([sys.executable, "-c", WRITER, str(path), p, "40"], env=env) for p in "abc"]
    assert [w.wait(timeout=120) for w in writers] == [0, 0, 0]
    state = UiState(path)
    assert all(state.get(f"{p}{i}") == i for p in "abc" for i in range(40))
    assert len(state.recent()) == 50  # RECENT_MAX of the 120 visits


def test_a_copied_data_directory_gets_its_own_id_and_a_moved_one_keeps_it(tmp_path):
    first = tmp_path / "first"
    original = UiState(first / "webui.json").data_id(first)
    assert UiState(first / "webui.json").data_id(first) == original
    copy = tmp_path / "copy"
    shutil.copytree(first, copy)
    copied = UiState(copy / "webui.json").data_id(copy)
    assert copied != original and UiState(copy / "webui.json").get("data_path") == data_path(copy)
    assert UiState(first / "webui.json").data_id(first) == original
    moved = tmp_path / "moved"
    first.rename(moved)
    assert UiState(moved / "webui.json").data_id(moved) == original
    assert UiState(moved / "webui.json").get("data_path") == data_path(moved)


def test_the_switch_flags_and_the_scan_consent_have_their_defaults(tmp_path):
    state = UiState(tmp_path / "webui.json")
    assert {key: state.flag(key) for key in FLAGS} == {"mod_switch_shown": True, "tray": False,
                                                        "classic_prompt": True, "mods_explained": False}
    assert state.scan_consent is None
    state.set("scan_consent", False)
    state.set("tray", "yes")  # not a boolean: the default
    assert state.scan_consent is False and state.flag("tray") is False
    # reading them writes nothing: the constructor and the getters never add preferences
    assert json.loads((tmp_path / "webui.json").read_text())["prefs"] == {"scan_consent": False, "tray": "yes"}
