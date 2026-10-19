"""webui.json shared by several app instances (webui/state.py UiState): a change is applied to the file as it is
then, so no instance erases another's keys."""

import json
import os
import subprocess
import sys
from pathlib import Path

import ba_modding_toolkit
from ba_modding_toolkit.webui.state import UiState


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
