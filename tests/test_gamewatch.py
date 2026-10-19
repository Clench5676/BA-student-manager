"""Game watch: the poll's answers, its events and scan requests, and its thread."""

from __future__ import annotations

import builtins
import io
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import game_paths
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import safety
from ba_modding_toolkit.webui.gamewatch import FAST_SECONDS, SLOW_SECONDS, GameWatch, WatchState


class World:
    """Fakes for everything the watch reads, and a record of what it reports."""

    def __init__(self):
        self.game: str | None = None
        self.busy: set[str] = set()
        self.folders = ["/games/global", "/games/japan"]
        self.classic: SimpleNamespace | None = None
        self.own: int | None = None
        self.seen = False
        self.active = False
        self.events: list[tuple] = []  # on_change, publish, request_scan and on_classic_closed, in order

    def check_game(self):
        if self.game:
            raise ServiceError(self.game)

    def check_steam(self, folder):
        if folder in self.busy:
            raise ServiceError("steam_busy")

    def watch(self, **overrides) -> GameWatch:
        options = dict(
            installs=lambda: self.folders,
            find_classic=lambda: self.classic,
            profiles_seen=lambda: self.seen,
            on_change=lambda state: self.events.append(("change", state)),
            publish=lambda event, data: self.events.append((event, data)),
            request_scan=lambda: self.events.append(("scan",)),
            active=lambda: self.active,
            own_classic=lambda: self.own,
            on_classic_closed=lambda: self.events.append(("classic closed",)),
            check_game=self.check_game,
            check_steam=self.check_steam,
        )
        options.update(overrides)
        return GameWatch(**options)

    def take(self) -> list[tuple]:
        events, self.events = self.events, []
        return events


@pytest.fixture
def world():
    return World()


def test_the_first_poll_reports_and_requests_no_scan(world):
    watch = world.watch()
    assert watch.state == WatchState() and watch.state.reason is None
    assert watch.poll() == WatchState()
    assert world.take() == [("change", WatchState())]
    watch.poll()
    assert world.take() == []  # nothing changed


def test_the_game_stopping_requests_a_scan(world):
    watch = world.watch()
    world.game = "game_running"
    watch.poll()
    assert world.take() == [("change", WatchState(game="game_running"))]
    assert watch.state.reason == "game_running"
    watch.poll()
    assert world.take() == []
    world.game = None
    watch.poll()
    assert world.take() == [("change", WatchState()), ("scan",)]


def test_an_unknown_game_state_is_reported_without_a_scan_when_it_clears(world):
    watch = world.watch()
    watch.poll()
    world.take()
    world.game = "game_status_unavailable"
    assert watch.poll().reason == "game_status_unavailable"
    world.game = None
    watch.poll()
    assert world.take() == [("change", WatchState(game="game_status_unavailable")), ("change", WatchState())]


def test_a_failing_process_check_counts_as_unknown(world):
    def broken():
        raise RuntimeError("no ps")
    assert world.watch(check_game=broken).poll().reason == "game_status_unavailable"


def test_one_busy_install_makes_the_switch_unavailable(world):
    watch = world.watch()
    watch.poll()
    world.take()
    world.busy = {"/games/japan"}
    state = watch.poll()
    assert state.steam_busy == ("/games/japan",) and state.reason == "steam_busy"
    world.busy = {"/games/japan", "/games/global"}
    assert watch.poll().steam_busy == ("/games/global", "/games/japan")
    world.take()
    world.busy = {"/games/global"}  # Japan idle again
    watch.poll()
    assert world.take() == [("change", WatchState(steam_busy=("/games/global",))), ("scan",)]
    world.busy = set()
    watch.poll()
    assert world.take() == [("change", WatchState()), ("scan",)]


def test_every_known_install_is_checked_once(world):
    checked = []
    world.folders = [Path("/games/global"), Path("/games/japan"), Path("/games/global")]
    world.watch(check_steam=checked.append).poll()
    assert checked == [str(Path("/games/global")), str(Path("/games/japan"))]


def test_the_installs_are_read_at_each_poll(world):
    watch = world.watch()
    world.busy = {"/games/other"}
    assert watch.poll().reason is None
    world.folders = ["/games/other"]
    assert watch.poll().reason == "steam_busy"


def test_a_failing_steam_check_or_install_list_is_not_busy(world):
    def broken(folder):
        raise OSError("manifest locked")

    def no_installs():
        raise RuntimeError("settings unreadable")

    assert world.watch(check_steam=broken).poll().steam_busy == ()
    assert world.watch(installs=no_installs).poll().steam_busy == ()


def test_a_watched_classic_window_ending_publishes_classic_closed(world):
    watch = world.watch()
    world.classic = SimpleNamespace(pid=4242)
    watch.poll()
    assert world.take() == [("change", WatchState(classic=4242))]
    assert watch.state.reason == "classic_open"
    watch.poll()
    assert world.take() == []
    world.classic = None  # find_classic found the pid dead and removed classic.json
    watch.poll()
    # the snapshot first, so whatever runs on classic.closed sees the switch available
    assert world.take() == [("change", WatchState()), ("classic.closed", {"code": None}), ("classic closed",),
                            ("scan",)]
    watch.poll()
    assert world.take() == []


def test_classic_closed_is_published_once_without_a_close_hook(world):
    watch = world.watch(on_classic_closed=None)
    world.classic = SimpleNamespace(pid=7)
    watch.poll()
    world.classic = None
    watch.poll()
    watch.poll()
    assert [event for event in world.take() if event[0] == "classic.closed"] == [("classic.closed", {"code": None})]


def test_a_classic_window_open_at_the_first_poll_is_watched(world):
    world.classic = SimpleNamespace(pid=99)
    watch = world.watch()
    assert watch.poll().classic == 99
    world.classic = None
    watch.poll()
    assert ("classic.closed", {"code": None}) in world.take()


def test_the_classic_window_this_instance_started_is_not_watched(world):
    watch = world.watch()
    world.own = 500
    world.classic = SimpleNamespace(pid=500)
    assert watch.poll().classic is None
    world.classic = None
    watch.poll()
    assert world.take() == [("change", WatchState())]  # its own watcher thread reports its exit


def test_a_failing_classic_lookup_keeps_the_last_answer(world):
    calls = []

    def lookup():
        calls.append(1)
        if len(calls) > 1:
            raise OSError("classic.json locked")
        return SimpleNamespace(pid=31)

    watch = world.watch(find_classic=lookup)
    watch.poll()
    assert watch.poll().classic == 31
    assert not [event for event in world.take() if event[0] == "classic.closed"]


def test_another_data_directorys_change_is_reported(world):
    watch = world.watch()
    watch.poll()
    world.take()
    world.seen = True
    watch.poll()
    assert world.take() == [("change", WatchState())]
    world.seen = False
    watch.poll()
    assert world.take() == []


def test_a_failing_callback_never_stops_the_watch(world):
    def broken(*args):
        raise RuntimeError("snapshot broken")

    def unreadable():
        raise OSError("profiles.json locked")

    watch = world.watch(on_change=broken, profiles_seen=unreadable)
    world.game = "game_running"
    watch.poll()
    world.game = None
    watch.poll()
    assert world.take() == [("scan",)]


def test_reasons_in_order():
    assert WatchState(game="game_running", steam_busy=("a",), classic=1).reason == "game_running"
    assert WatchState(steam_busy=("a",), classic=1).reason == "steam_busy"
    assert WatchState(classic=1).reason == "classic_open"
    assert WatchState().reason is None


def test_polls_fast_while_a_page_or_the_tray_is_there(world):
    watch = world.watch()
    assert watch.interval() == SLOW_SECONDS == 15.0
    world.active = True
    assert watch.interval() == FAST_SECONDS == 3.0


def test_the_thread_polls_at_once_and_when_poked(world):
    polls = threading.Semaphore(0)

    def check_game():
        polls.release()

    watch = world.watch(check_game=check_game, slow=60.0)
    watch.start()
    try:
        assert polls.acquire(timeout=5)  # the first poll, at once
        assert not polls.acquire(timeout=0.2)  # then waits
        watch.poke()
        assert polls.acquire(timeout=5)
        watch.start()  # already running: no second thread
        assert len([t for t in threading.enumerate() if t.name == "bamt-gamewatch"]) == 1
    finally:
        watch.stop()
    assert not [t for t in threading.enumerate() if t.name == "bamt-gamewatch"]


def test_the_defaults_are_the_write_time_checks_and_read_no_game_file(world, tmp_path, monkeypatch):
    steamapps = tmp_path / "steamapps"
    install = steamapps / "common" / "BlueArchive"
    install.mkdir(parents=True)
    (steamapps / f"appmanifest_{game_paths.STEAM_APP_ID}.acf").write_text(
        '"AppState"\n{\n\t"StateFlags"\t\t"1048580"\n}\n', encoding="utf-8")
    resource = install / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows"
    resource.mkdir(parents=True)
    (resource / "assets-_mx-spinecharacters-test_spr-_mxdependency-2024-01-01_assets_all_1.bundle").write_bytes(b"UnityFS")
    opened = []
    real_open = io.open

    def recording_open(file, *args, **kwargs):
        opened.append(Path(file).name)
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(io, "open", recording_open)
    monkeypatch.setattr(builtins, "open", recording_open)
    monkeypatch.setattr(safety, "game_processes", lambda: [])
    watch = world.watch(check_game=None, check_steam=None, installs=lambda: [install, resource])
    assert watch.poll() == WatchState(steam_busy=(str(install), str(resource)))
    assert set(opened) == {f"appmanifest_{game_paths.STEAM_APP_ID}.acf"}  # never a game file
    monkeypatch.setattr(safety, "game_processes", lambda: ["/Applications/Blue Archive.app/Contents/MacOS/Blue Archive"])
    assert watch.poll().reason == "game_running"
