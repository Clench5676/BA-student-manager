"""The web UI's wiring of the Enable Mods switch, the scan, the classic hand-off and quitting (webui/services.py,
api.py, main.py), with a real mod library over temporary game folders of header-only bundles (never a real install,
library or settings), driven through the WSGI app without a window or a socket."""

from __future__ import annotations

import json
import os
import shutil
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gui import control as ctl
from ba_modding_toolkit.library import safety
from ba_modding_toolkit.library.judge import install_key, install_root
from ba_modding_toolkit.library.profiles import Profiles
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils
from ba_modding_toolkit.webui import classic as cl
from ba_modding_toolkit.webui import main as webui_main
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.instance import InstanceLock, raise_running, read_info
from ba_modding_toolkit.webui.server import WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState, data_path

from test_classic_handoff import FakePopen, FakeProcesses, WsgiOpener, wait_for
from test_library import FakeCatalog, FakeVariant, game_bundle, header_bundle, make_mod
from test_webui import call, rpc

OFFICIAL = header_bundle(b"official")


class Env:
    """Game folders, settings, a data directory and the services over them, all in tmp_path."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.game = tmp / "game"
        self.spr = game_bundle(self.game)
        self.catalog = FakeCatalog(FakeVariant("test", "test_spr", "test_home"),
                                   FakeVariant("other", "other_spr", family="other"))
        self.settings = self.make_settings(tmp / "config.toml", self.game)
        self.data = tmp / "data"
        self.processes = FakeProcesses({})
        self.popens: list[FakePopen] = []
        self.clients: list[ctl.ControlClient] = []
        self.made: list[Services] = []
        self.s, self.app = self.services()
        self.events = self.s.events.subscribe()

    @staticmethod
    def make_settings(path: Path, game: Path | None = None, japan: Path | None = None) -> Settings:
        settings = Settings(path)
        settings.set("enable_crc_correction", "false")
        settings.set("compression_method", "none")
        settings.set("game_resource_dir", str(game) if game else "")
        settings.set("game_resource_dir_japan", str(japan) if japan else "")
        return settings

    def services(self, data: Path | None = None, settings: Settings | None = None, game=object()):
        data = data or self.data
        s = Services(settings or self.settings, data, state=UiState(data / "webui.json"), cache=object(), game=game,
                     catalog=self.catalog,
                     classic_options={"processes": self.processes, "popen": self.popen, "ready_timeout": 5.0,
                                      "poll_timeout": 0.2, "command": lambda tab: ["tool", "--classic", "--control"]})
        app = WebApp(build_api(s), s.events, assets=s.asset, token="tok", consent=lambda: s.state.consent,
                     classic=s.classic.wsgi, raise_window=s.raise_window)
        self.made.append(s)
        return s, app

    def popen(self, cmd, **kw):
        """A classic child on the real channel: it reports ready and polls through the web app."""
        p = FakePopen(cmd, pid=4242, **kw)
        self.popens.append(p)
        client = ctl.ControlClient(kw["env"][cl.ENV_URL], kw["env"][cl.ENV_TOKEN],
                                   opener=WsgiOpener(self.app), poll_timeout=5)
        self.clients.append(client)
        client.start()
        client.report("ready", pid=p.pid, hwnd=0, exe="/apps/tool")
        return p

    def key(self, game: Path | None = None) -> str:
        return install_key(install_root(game or self.game))

    def add(self, path: Path, payload: bytes = b"modded!!", fixed: bool = False):
        entry, = self.s.library.add([make_mod(path, self.tmp / "input", payload, fixed)])
        return entry

    def drain(self) -> list[tuple[str, dict]]:
        out = []
        while True:
            try:
                out.append(self.events.get_nowait())
            except Exception:
                return out

    def job(self, method: str, **params):
        """Run an RPC that submits a job; its job once it ran."""
        answer = rpc(self.app, method, **params)
        assert "result" in answer, answer
        assert self.s.jobs.wait(answer["result"], 10)
        return self.s.jobs.get(answer["result"])

    def orphan(self, pid: int = 5555, created: int = 77, runs: bool = True) -> None:
        """A classic window an earlier instance left open: classic.json naming a live classic process."""
        self.processes.table[pid] = (created, runs)
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / cl.CLASSIC_JSON).write_text(json.dumps({"pid": pid, "exe": "tool", "hwnd": 0,
                                                             "created": created}))

    def close(self):
        for c in self.clients:
            c.stop()
        for p in self.popens:
            if p.poll() is None:
                p.exit(0)
        for s in self.made:
            s.close(wait=5)


@pytest.fixture
def env(tmp_path, monkeypatch, header_only_bundles):
    from ba_modding_toolkit.i18n import i18n_manager

    monkeypatch.setattr(i18n_manager, "lang", "en-US")  # the install labels' language
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: False)
    e = Env(tmp_path)
    yield e
    e.close()


def queue(env, method, params):
    """classic.queue (its own parameter is called method)."""
    _, _, body = call(env.app, "/api/rpc", "POST", {"method": "classic.queue",
                                                     "params": {"method": method, "params": params}})
    return json.loads(body)


def events_named(events, name):
    return [data for event, data in events if event == name]


# --- mods.state ---

STATE_KEYS = {"installs", "current", "enabled", "shown", "available", "reason", "scan", "explained", "configured",
              "pending", "stuck", "left", "unfinished", "drift", "untracked", "damaged", "sourceMissing", "builtSize",
              "originalsSize", "queued", "scanned", "tray", "traySupported", "busy", "progress"}


def test_mods_state_has_its_shape_and_answers_while_the_library_lock_is_held(env):
    state = rpc(env.app, "mods.state")["result"]
    assert STATE_KEYS <= set(state)
    pin = env.s.library.installs()[0]
    assert state["installs"] == [{"id": pin.id, "key": env.key(), "server": "global", "folder": str(pin.root),
                                  "named": True, "label": "Global", "distinct": None}]
    assert (state["current"], state["enabled"], state["available"], state["reason"]) == (env.key(), True, True, None)
    assert (state["scan"], state["shown"], state["explained"], state["busy"], state["queued"]) == (
        None, True, False, False, 0)
    assert state["unfinished"] == {"pending": 0, "left": 0, "stuck": 0}
    # answered from the snapshot: another thread holding the library lock does not hold it up
    library, held, release = env.s.library, threading.Event(), threading.Event()

    def hold():
        with library._lock:
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold)
    holder.start()
    assert held.wait(5)
    answer: dict = {}
    asker = threading.Thread(target=lambda: answer.update(rpc(env.app, "mods.state")))
    asker.start()
    asker.join(3)
    release.set()
    holder.join(5)
    assert answer.get("result", {}).get("current") == env.key()


def test_the_reasons_of_an_unavailable_switch(env, monkeypatch):
    s = env.s
    assert rpc(env.app, "mods.state")["result"]["reason"] is None
    # the game watch's answers
    s.start_watch(run=False)
    monkeypatch.setattr(safety, "check_game_not_running", lambda: (_ for _ in ()).throw(ServiceError("game_running")))
    s.watch.poll()
    state = rpc(env.app, "mods.state")["result"]
    assert (state["reason"], state["available"]) == ("game_running", False)
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)

    def busy(folder):
        raise ServiceError("steam_busy")

    monkeypatch.setattr(safety, "check_steam_idle", busy)
    s.watch.poll()
    assert rpc(env.app, "mods.state")["result"]["reason"] == "steam_busy"
    monkeypatch.setattr(safety, "check_steam_idle", lambda folder: None)
    s.watch.poll()
    # a classic window an earlier instance left open
    env.orphan()
    assert rpc(env.app, "mods.state")["result"]["reason"] == "classic_open"
    (env.data / cl.CLASSIC_JSON).unlink()
    s.watch.poll()
    assert rpc(env.app, "mods.state")["result"]["reason"] is None
    # an unreadable configuration
    root = s.library_dir()
    root.mkdir(parents=True, exist_ok=True)
    (root / "profiles.json").write_text("{broken")
    (root / "profiles.json.prev").write_text("[]")
    s.refresh_status()
    state = rpc(env.app, "mods.state")["result"]
    assert state["reason"] == "profiles_unreadable" and state["reasonParams"]["file"].endswith("profiles.json")


def test_no_known_install_is_game_not_found(env):
    s, app = env.services(env.tmp / "empty", Env.make_settings(env.tmp / "empty.toml"), game=None)
    state = rpc(app, "mods.state")["result"]
    assert (state["installs"], state["current"], state["reason"]) == ([], None, "game_not_found")


# --- consent and preferences ---

def test_the_scan_consent_and_the_preferences(env):
    app, s = env.app, env.s
    assert rpc(app, "mods.scan")["error"]["code"] == "scan_off"
    assert rpc(app, "mods.entries")["result"] == []
    library = s.library
    assert library._scan_allowed() is False
    assert "error" not in rpc(app, "mods.consent", granted=True)
    # the library follows the consent at once, with no services rebuild
    assert s.library is library and library._scan_allowed() is True
    assert s.state.get("scan_consent") is True
    assert wait_for(lambda: events_named(env.drain(), "library.scanned"))  # granting requests a scan
    assert rpc(app, "mods.scan", dismissed=True)["result"] == {"requested": True}
    assert rpc(app, "mods.state")["result"]["scan"] is True
    assert "error" not in rpc(app, "mods.explained")
    assert rpc(app, "mods.state")["result"]["explained"] is True
    for key, pref in (("modSwitchShown", "mod_switch_shown"), ("tray", "tray"), ("classicPrompt", "classic_prompt")):
        before = rpc(app, "settings.get")["result"][key]
        after = rpc(app, "settings.set", key=key, value=not before)["result"][key]
        assert after is (not before) and s.state.get(pref) is (not before)
        assert rpc(app, "settings.set", key=key, value="yes")["error"]["code"] == "bad_params"
    assert rpc(app, "settings.get")["result"]["traySupported"] is False
    assert rpc(app, "mods.state")["result"]["shown"] is False
    assert "error" not in rpc(app, "mods.consent", granted=False)
    assert library._scan_allowed() is False and rpc(app, "mods.state")["result"]["scan"] is False
    assert rpc(app, "mods.consent", granted="yes")["error"]["code"] == "bad_params"


def test_the_start_scan_lists_a_mod_outside_the_library(env):
    env.s.state.set("scan_consent", True)
    env.spr.write_bytes(CRCUtils.apply_crc_fix(header_bundle(b"modded!!"), int(parse_filename(env.spr.name).crc)))
    assert env.s.library is not None  # built: its prune job, then the start scan
    assert wait_for(lambda: events_named(env.drain(), "library.scanned"))
    entries = rpc(env.app, "mods.entries")["result"]
    assert [(e["install"], e["core"], e["state"]) for e in entries] == [(env.key(), "test_spr", "untracked")]
    assert rpc(env.app, "mods.state")["result"]["untracked"] == 1


# --- installs ---

def test_two_installs_of_one_server_are_labelled_by_their_folders(env):
    steam = env.tmp / "Steam"
    blue = env.tmp / "BlueArchive"
    game_bundle(steam)
    game_bundle(blue)
    env.settings.set("game_resource_dir", str(steam))
    env.s.reload_game()
    mod = env.add(game_bundle(env.tmp / "src"))
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    env.settings.set("game_resource_dir", str(blue))
    env.s.reload_game()
    installs = {i["key"]: i for i in rpc(env.app, "mods.state")["result"]["installs"]}
    assert installs[env.key(blue)]["label"] == "Global (BlueArchive)" and installs[env.key(blue)]["named"] is True
    assert installs[env.key(steam)]["label"] == "Global (Steam)" and installs[env.key(steam)]["named"] is False
    # Remove from List: a recorded install the settings no longer name, never a named one
    assert rpc(env.app, "mods.forget", install=env.key(blue))["error"]["code"] == "bad_params"
    assert env.job("mods.forget", install=env.key(steam)).state == "done"
    assert [i["key"] for i in rpc(env.app, "mods.state")["result"]["installs"]] == [env.key(blue)]


def test_without_a_current_install_the_switch_toggles_the_known_ones(env):
    mod = env.add(env.spr)
    library = env.s.library
    library.apply("test", f"mod:{mod.id}")
    env.settings.set("file_source", "adb_global")  # ADB mode: no current install, the Global folder still known
    s, app = env.services(env.tmp / "adb", env.settings, game=None)
    s.state.set("library_dir", str(env.s.library_dir()))
    state = rpc(app, "mods.state")["result"]
    assert (state["current"], state["reason"], [i["key"] for i in state["installs"]]) == (None, None, [env.key()])
    job = rpc(app, "mods.toggle", enabled=False, expect=True)["result"]
    assert s.jobs.wait(job, 10) and s.jobs.get(job).state == "done", s.jobs.get(job).error
    assert env.spr.read_bytes() == OFFICIAL
    assert rpc(app, "actions.apply", variant="test", source=f"mod:{mod.id}")["error"]["code"] == "game_not_found"


def test_the_data_directory_id_and_a_shared_library(env):
    mod = env.add(env.spr)
    a = env.s
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    data_id = a.state.get("data_id")
    assert len(data_id) == 12 and a.library.data_id == data_id
    assert a.state.get("data_path") == data_path(env.data)
    # kept across restarts
    again, _ = env.services()
    assert again.library.data_id == data_id
    # another data directory sharing the library, its settings naming no folder: the install is recorded there
    b, b_app = env.services(env.tmp / "other", Env.make_settings(env.tmp / "other.toml"), game=None)
    b.state.set("library_dir", str(a.library_dir()))
    assert b.library.data_id != data_id
    assert [i["key"] for i in rpc(b_app, "mods.state")["result"]["installs"]] == [env.key()]
    job = rpc(b_app, "mods.forget", install=env.key())["result"]
    assert b.jobs.wait(job, 10) and b.jobs.get(job).state == "done"
    # the other data directory names it: only hidden here, its configuration stays
    assert rpc(b_app, "mods.state")["result"]["installs"] == []
    assert [i["key"] for i in rpc(env.app, "mods.state")["result"]["installs"]] == [env.key()]
    folder = json.loads((a.library_dir() / "profiles.json").read_text())["folders"][env.key()]
    assert folder["hidden"] == [b.library.data_id] and folder["configured"]


def test_another_data_directorys_toggle_shows_within_one_poll(env, monkeypatch):
    s = env.s
    s.state.set("scan_consent", True)
    rpc(env.app, "mods.state")
    assert s.jobs.wait(s._prune_job, 10)
    s.start_watch(run=False)
    s.watch.poll()
    env.drain()
    # another data directory sharing the library turns mods off
    other = Profiles(s.library_dir())
    other.update(lambda data: data.update(enabled=False, toggled="2026-10-20T10:00:00+00:00"))
    s.watch.poll()
    assert rpc(env.app, "mods.state")["result"]["enabled"] is False
    events = env.drain()
    assert events_named(events, "mods.state") and events_named(events, "mods.state")[-1]["enabled"] is False
    # with scan consent a scan follows, and the unfinished list is judged again on the job worker
    assert wait_for(lambda: events_named(env.drain(), "library.scanned"))
    assert wait_for(lambda: not s.jobs.active("library.judge"))
    # unchanged: profiles.json is not read again
    monkeypatch.setattr(s.library, "intent", lambda: pytest.fail("read again"))
    s.watch.poll()
    assert s.profiles_seen() is False


# --- jobs ---

def test_the_toggle_job_its_events_and_the_snapshot(env):
    mod = env.add(env.spr)
    applied = env.job("actions.apply", variant="test", source=f"mod:{mod.id}")
    assert applied.state == "done" and env.spr.read_bytes() == mod.file.read_bytes()
    assert events_named(env.drain(), "library.changed")[-1] == {"cores": ["test_spr"], "kinds": ["spr"]}
    job = env.job("mods.toggle", enabled=False, expect=True)
    assert job.state == "done", job.error
    assert [item["core"] for item in job.result["done"]] == ["test_spr"]
    assert env.spr.read_bytes() == OFFICIAL
    events = env.drain()
    assert {"cores": ["test_spr"], "kinds": ["spr"]} in events_named(events, "library.changed")
    states = events_named(events, "mods.state")
    assert states[0]["busy"] is True and states[-1]["enabled"] is False and states[-1]["busy"] is False
    assert any(state["progress"] == {"done": 1, "total": 1} for state in states)
    assert states[-1]["progress"] is None
    # a stale expect: state_changed from the job, the intent unchanged
    assert env.job("mods.toggle", enabled=False, expect=True).error["code"] == "state_changed"
    assert rpc(env.app, "mods.toggle", enabled="no", expect=False)["error"]["code"] == "bad_params"
    # apply while off is saved, not written
    deferred = env.job("actions.apply", variant="test", source=f"mod:{mod.id}")
    assert deferred.result["deferred"] is True and env.spr.read_bytes() == OFFICIAL


def test_a_second_toggle_while_one_is_queued_is_busy(env):
    gate = threading.Event()
    env.s.submit("slow", lambda log, progress: gate.wait(5), writes="game")
    first = rpc(env.app, "mods.toggle", enabled=False, expect=True)
    assert "result" in first
    assert rpc(env.app, "mods.toggle", enabled=False, expect=True)["error"]["code"] == "busy"
    assert rpc(env.app, "mods.state")["result"]["busy"] is True
    gate.set()
    assert env.s.jobs.wait(first["result"], 10)


def test_adding_mods_already_in_use_runs_while_the_game_runs(env, monkeypatch):
    env.s.state.set("scan_consent", True)
    env.spr.write_bytes(CRCUtils.apply_crc_fix(header_bundle(b"modded!!"), int(parse_filename(env.spr.name).crc)))
    env.s.library
    assert wait_for(lambda: events_named(env.drain(), "library.scanned"))
    entry, = rpc(env.app, "mods.entries")["result"]
    monkeypatch.setattr(safety, "check_game_not_running", lambda: (_ for _ in ()).throw(ServiceError("game_running")))
    job = env.job("mods.adopt", entries=[{"install": entry["install"], "core": entry["core"]}])
    assert job.state == "done", job.error
    assert len(job.result["added"]) == 1 and job.result["failed"] == []
    assert events_named(env.drain(), "library.changed")[-1] == {"cores": ["test_spr"], "kinds": ["spr"]}
    assert rpc(env.app, "mods.adopt", entries=[{"core": 1}])["error"]["code"] == "bad_params"


def test_every_writer_job_publishes_library_changed(env):
    mod = env.add(env.spr)
    for method, params in (("actions.apply", {"variant": "test", "source": f"mod:{mod.id}"}),
                           ("actions.restore", {"variant": "test"}),
                           ("mods.toggle", {"enabled": False, "expect": True}),
                           ("mods.clearBuilt", {})):
        env.drain()
        job = env.job(method, **params)
        assert job.state == "done", (method, job.error)
        changed = events_named(env.drain(), "library.changed")
        assert changed and set(changed[-1]) == {"cores", "kinds"}, method


def test_the_unfinished_list_is_judged_after_a_writer_job(env, monkeypatch):
    judged = []
    library = env.s.library
    monkeypatch.setattr(library, "judge_unfinished", lambda: judged.append(threading.current_thread().name) or 0)
    assert env.s.jobs.wait(env.s._prune_job, 10)
    assert env.job("mods.clearBuilt").state == "done"
    assert judged and set(judged) == {"bamt-jobs"}  # on the job worker, never the calling thread


def test_moving_the_library_takes_its_configuration_and_built_copies(env):
    source = env.tmp / "lib"
    source.mkdir()
    env.s.state.set("library_dir", str(source))
    for name in ("profiles.json", "profiles.json.prev", "profiles.json.bad"):
        (source / name).write_text('{"version": 1, "folders": {}}')
    (source / "built").mkdir()
    (source / "built" / "a.bundle").write_bytes(b"x")
    target = env.tmp / "moved"
    assert "error" not in rpc(env.app, "settings.set", key="libraryDir", value=str(target))
    for name in ("profiles.json", "profiles.json.prev", "profiles.json.bad", "built/a.bundle"):
        assert (target / name).exists() and not (source / name).exists(), name
    assert not (target / "state.json").exists()


# --- the classic window ---

def test_writes_are_refused_while_a_classic_window_is_open_and_can_be_queued(env):
    mod = env.add(env.spr)
    env.orphan()
    assert rpc(env.app, "actions.apply", variant="test", source=f"mod:{mod.id}")["error"]["code"] == "classic_open"
    assert rpc(env.app, "mods.toggle", enabled=False, expect=True)["error"]["code"] == "classic_open"
    assert rpc(env.app, "mods.restoreDrift", entries=[])["error"]["code"] == "classic_open"
    status = rpc(env.app, "app.classic")["result"]
    assert (status["open"], status["orphan"], status["pid"], status["queued"]) == (True, True, 5555, 0)
    queued = queue(env, "actions.apply", {"variant": "test", "source": f"mod:{mod.id}", "kind": "spr"})["result"]
    assert queued == {"queued": 1}
    state = rpc(env.app, "mods.state")["result"]
    assert (state["queued"], state["busy"], state["reason"]) == (1, True, "classic_open")
    assert queue(env, "os.reveal", {})["error"]["code"] == "bad_params"
    # the modal unticked: the queue empties
    assert "error" not in rpc(env.app, "classic.clearQueue")
    assert rpc(env.app, "mods.state")["result"]["queued"] == 0
    # reading, adding and settings stay allowed
    assert "error" not in rpc(env.app, "mods.state")


def test_installing_an_update_is_refused_while_a_classic_window_is_open(env, tmp_path):
    build = tmp_path / "BA-Modding-Toolkit-1.0.0-macos-arm64.dmg"
    build.write_bytes(b"dmg")
    env.s.window = SimpleNamespace(destroy=lambda: pytest.fail("quit"))
    env.s.update_file = (build, "md5", "1.0.0")
    env.s.update_info = SimpleNamespace(version="1.0.0")
    env.orphan()
    assert rpc(env.app, "app.installUpdate", file=str(build))["error"]["code"] == "classic_open"


@pytest.mark.parametrize("table", [{}, {5555: (78, True)}, {5555: (77, False)}], ids=["dead", "reused", "other"])
def test_a_stale_classic_json_after_a_restart_is_removed_and_refuses_nothing(env, table):
    mod = env.add(env.spr)
    env.orphan()
    env.processes.table = dict(table)
    assert "result" in rpc(env.app, "actions.apply", variant="test", source=f"mod:{mod.id}")
    assert not (env.data / cl.CLASSIC_JSON).exists()


def test_classic_json_naming_this_process_is_stale(env):
    env.orphan()
    env.processes._own.add(5555)
    assert rpc(env.app, "mods.state")["result"]["reason"] is None
    assert not (env.data / cl.CLASSIC_JSON).exists()


def test_a_queued_toggle_runs_once_the_watched_classic_window_closes(env):
    mod = env.add(env.spr)
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    s = env.s
    s.start_watch(run=False)
    env.orphan()
    s.watch.poll()
    assert queue(env, "mods.toggle", {"enabled": False, "expect": True})["result"] \
        == {"queued": 1}
    # a toggle back to the stored intent removes it, a later one replaces it
    assert queue(env, "mods.toggle", {"enabled": True, "expect": False})["result"] \
        == {"queued": 0}
    queue(env, "mods.toggle", {"enabled": False, "expect": True})
    env.drain()
    del env.processes.table[5555]  # the classic window ends
    s.watch.poll()
    events = env.drain()
    names = [event for event, _ in events]
    assert "classic.closed" in names and "library.changed" in names
    done = events_named(events, "classic.queueDone")
    assert done and len(done[0]["submitted"]) == 1 and done[0]["dropped"] == []
    assert wait_for(lambda: env.spr.read_bytes() == OFFICIAL)
    assert wait_for(lambda: not s.jobs.busy())
    assert rpc(env.app, "mods.state")["result"]["enabled"] is False


def test_the_queue_drops_what_no_longer_holds(env):
    mod = env.add(env.spr)
    s = env.s
    env.orphan()
    queue(env, "actions.apply", {"variant": "test", "source": f"mod:{mod.id}"})
    queue(env, "mods.toggle", {"enabled": False, "expect": True})
    # meanwhile the classic window changes the entry's file, and another place turns mods off
    env.spr.write_bytes(header_bundle(b"classic!"))
    s.library.profiles.update(lambda data: data.update(enabled=False))
    env.processes.table.clear()
    env.drain()
    s.after_classic()
    done = events_named(env.drain(), "classic.queueDone")[0]
    assert sorted(d["error"]["code"] for d in done["dropped"]) == ["entry_changed", "state_changed"]
    assert done["submitted"] == []
    # an empty queue does nothing
    env.drain()
    s.after_classic()
    assert events_named(env.drain(), "classic.queueDone") == []


def test_the_queue_reports_a_toggle_it_cannot_check_against_unreadable_mod_settings(env):
    mod = env.add(env.spr)
    s = env.s
    env.orphan()
    queue(env, "mods.toggle", {"enabled": False, "expect": True})
    queue(env, "actions.apply", {"variant": "test", "source": f"mod:{mod.id}"})
    root = s.library_dir()
    (root / "profiles.json").write_text("{broken")
    (root / "profiles.json.prev").write_text("[]")
    env.processes.table.clear()
    env.drain()
    s.after_classic()
    done = events_named(env.drain(), "classic.queueDone")[0]
    assert [(d["method"], d["error"]["code"]) for d in done["dropped"]] == [("mods.toggle", "profiles_unreadable")]
    assert [item["method"] for item in done["submitted"]] == ["actions.apply"]
    assert s.jobs.wait(done["submitted"][0]["job"], 10)
    assert rpc(env.app, "mods.state")["result"]["queued"] == 0


def test_the_queue_runs_when_the_scan_it_waits_for_is_dropped_with_the_consent(env):
    s = env.s
    s.set_scan_consent(True)
    assert s.scanner.wait_idle(5)
    env.orphan()
    queue(env, "mods.toggle", {"enabled": False, "expect": True})
    gate = threading.Event()
    real = s.scanner._scan

    def slow(cancel, dismissed):
        gate.wait(5)
        return real(cancel, dismissed)

    s.scanner._scan = slow
    try:
        s.scanner.request()  # a scan runs
        assert wait_for(lambda: s.scanner.running)
        env.processes.table.clear()  # the classic window closes
        env.drain()
        s.after_classic()  # the queue waits for the scan after the one running
        assert events_named(env.drain(), "classic.queueDone") == []
        # the consent withdrawn: the scans asked for are dropped, the one the queue waited for too; the queue runs
        assert rpc(env.app, "mods.consent", granted=False)["result"] == {}
        done = events_named(env.drain(), "classic.queueDone")
        assert done and len(done[0]["submitted"]) == 1 and done[0]["dropped"] == []
    finally:
        gate.set()
    assert s.scanner.wait_idle(5)
    assert wait_for(lambda: not s.jobs.busy())
    assert events_named(env.drain(), "classic.queueDone") == []  # it ran once
    assert rpc(env.app, "mods.state")["result"]["enabled"] is False


def test_a_queued_apply_survives_a_change_to_the_other_install(env):
    mod = env.add(env.spr)
    s = env.s
    env.orphan()
    queue(env, "actions.apply", {"variant": "test", "source": f"mod:{mod.id}"})
    japan = env.tmp / "japan"
    game_bundle(japan)
    env.settings.set("game_resource_dir_japan", str(japan))
    s.reload_game()
    env.processes.table.clear()
    env.drain()
    s.after_classic()
    done = events_named(env.drain(), "classic.queueDone")[0]
    assert done["dropped"] == [] and len(done["submitted"]) == 1
    assert s.jobs.wait(done["submitted"][0]["job"], 10)
    assert env.spr.read_bytes() == mod.file.read_bytes()


def test_a_restore_while_off_that_writes_nothing_runs_while_the_classic_window_is_open(env):
    mod = env.add(env.spr)
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    assert env.job("mods.toggle", enabled=False, expect=True).state == "done"
    env.orphan()
    # the files are official already: only the configuration is dropped
    job = env.job("actions.restore", variant="test")
    assert job.state == "done", job.error
    assert env.s.library.configured("test")["spr"] is None
    # one that would write official bytes (a mod still in the game) is refused and can be queued
    env.processes.table.clear()
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"  # configured again
    env.s.library.profiles.update(lambda data: data.update(enabled=True))
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"  # in the game
    env.s.library.profiles.update(lambda data: data.update(enabled=False))
    env.orphan()
    assert rpc(env.app, "actions.restore", variant="test")["error"]["code"] == "classic_open"
    assert queue(env, "actions.restore", {"variant": "test"})["result"] == \
        {"queued": 1}


def test_a_restore_that_turns_out_to_write_is_refused_at_write_time(env):
    """The cheap judgement takes an unfixed outside change of the official size for official, so the restore is
    allowed at submit; the write's full judgement finds it changed, and the write is refused."""
    mod = env.add(env.spr)
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    assert env.job("mods.toggle", enabled=False, expect=True).state == "done"
    outside = header_bundle(b"external")  # the official size, no trailing bytes
    env.spr.write_bytes(outside)
    env.orphan()
    job = env.job("actions.restore", variant="test")
    assert job.state == "failed" and job.error["code"] == "classic_open"
    assert env.spr.read_bytes() == outside


def test_open_classic_always_asks_for_the_classic_gui(env, monkeypatch):
    app = env.app
    assert rpc(app, "app.openClassic", tab="crc_tool")["result"] == {"started": True}
    assert len(env.popens) == 1 and env.popens[0].kw["env"][cl.ENV_URL] == env.s.origin
    client = env.clients[0]

    def lines_until(last):
        got = []
        assert wait_for(lambda: got.extend(client.lines()) or last in got), got
        return got

    assert lines_until("raise")[-1] == "raise"
    assert rpc(app, "app.openClassic", tab="tools")["result"] == {"started": False}
    assert lines_until("raise") == ["tab tools", "raise"]
    client.report("busy", n=1)
    assert wait_for(lambda: rpc(app, "app.classic")["result"]["busy"])
    assert rpc(app, "app.openClassic", tab="mod_install")["result"] == {"started": False}
    assert lines_until("raise") == ["raise"]  # a running classic task's tab is never switched
    assert rpc(app, "classic.front")["result"] == {"raised": True}
    assert rpc(app, "app.openClassic", tab="nope")["error"]["code"] == "bad_params"
    # writes wait while it is open
    assert rpc(app, "mods.toggle", enabled=False, expect=True)["error"]["code"] == "classic_open"
    env.drain()
    env.popens[0].exit(0)
    assert wait_for(lambda: not rpc(app, "app.classic")["result"]["open"])
    events = env.drain()
    names = [event for event, _ in events]
    assert "classic.closed" in names and "library.changed" in names
    assert rpc(app, "classic.front")["result"] == {"raised": False}


def test_the_classic_window_waits_for_a_job_writing_the_game_folder(env):
    """A classic window started under a toggle would stop it at its next write (classic_open), the switch half done:
    refused with busy while a game writer job is queued or running. A library writer never holds it back, and an open
    window is still raised."""
    app, s = env.app, env.s
    gate = threading.Event()
    s.submit("slow", lambda log, progress: gate.wait(5), writes="game")
    toggle = rpc(app, "mods.toggle", enabled=False, expect=True)["result"]  # queued behind it
    assert rpc(app, "app.openClassic", tab="crc_tool")["error"]["code"] == "busy"
    gate.set()
    assert s.jobs.wait(toggle, 10)
    assert s.jobs.get(toggle).state == "done", s.jobs.get(toggle).error
    assert env.popens == []
    hold = threading.Event()
    s.submit("slow", lambda log, progress: hold.wait(5), writes="library")
    assert rpc(app, "app.openClassic", tab="crc_tool")["result"] == {"started": True}
    s.submit("slow", lambda log, progress: hold.wait(5), writes="game")
    assert rpc(app, "app.openClassic", tab="tools")["result"] == {"started": False}
    assert len(env.popens) == 1
    hold.set()
    assert wait_for(lambda: not s.jobs.busy())
    env.popens[0].exit(0)
    assert wait_for(lambda: not rpc(app, "app.classic")["result"]["open"])
    env.orphan()
    hold.clear()
    job = s.submit("slow", lambda log, progress: hold.wait(5), writes="game")
    try:
        assert s.jobs.busy("game")
        assert rpc(app, "app.openClassic", tab="tools")["result"] == {"started": False}
        assert len(env.popens) == 1
    finally:
        hold.set()
    assert s.jobs.wait(job, 10)


def test_a_toggle_cannot_start_between_the_classic_busy_check_and_child_registration(env, monkeypatch):
    mod = env.add(env.spr)
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    s, app = env.s, env.app
    library = s.library
    before = library.profiles.path.read_bytes()
    checked, contended, opened = threading.Event(), threading.Event(), threading.Event()
    opening, toggling = {}, {}
    busy, start_lock, write_check = s.jobs.busy, s.classic._start_lock, library._write_check

    def busy_check(writes=None):
        result = busy(writes)
        if writes == "game" and threading.current_thread() is opener:
            assert result is False
            checked.set()
            assert contended.wait(5)
        return result

    class StartLock:
        def __enter__(self):
            if threading.current_thread() is submitter:
                contended.set()  # a guarded submit waits for the child to be registered
            return start_lock.__enter__()

        def __exit__(self, *exc):
            return start_lock.__exit__(*exc)

    def before_write(pin):
        contended.set()  # an unguarded submit reached the write after saving its intent
        assert opened.wait(5)
        write_check(pin)

    def open_classic():
        try:
            opening.update(rpc(app, "app.openClassic", tab="crc_tool"))
        finally:
            opened.set()

    opener = threading.Thread(target=open_classic)
    submitter = threading.Thread(target=lambda: toggling.update(rpc(app, "mods.toggle", enabled=False, expect=True)))
    monkeypatch.setattr(s.jobs, "busy", busy_check)
    monkeypatch.setattr(s.classic, "_start_lock", StartLock())
    monkeypatch.setattr(library, "_write_check", before_write)
    opener.start()
    try:
        assert checked.wait(5)
        submitter.start()
        opener.join(5)
        submitter.join(5)
        assert not opener.is_alive() and not submitter.is_alive()
    finally:
        contended.set()
        opened.set()
        opener.join(5)
        if submitter.ident is not None:
            submitter.join(5)

    if "error" in toggling:
        assert toggling["error"]["code"] == "classic_open"
        assert library.profiles.path.read_bytes() == before
        assert env.spr.read_bytes() == mod.file.read_bytes()
        assert opening["result"] == {"started": True}
    else:
        assert s.jobs.wait(toggling["result"], 10)
        job = s.jobs.get(toggling["result"])
        assert job.state == "done", job.error
        assert opening["error"]["code"] == "busy"
        assert env.popens == []


@pytest.mark.parametrize("method", ["mods.toggle", "mods.restoreDrift", "actions.apply", "actions.restore"])
def test_game_writers_answer_while_the_classic_window_waits_for_ready(env, monkeypatch, method):
    mod = env.add(env.spr)
    assert env.job("actions.apply", variant="test", source=f"mod:{mod.id}").state == "done"
    waiting, release, answered = threading.Event(), threading.Event(), threading.Event()
    opening, submitting = {}, {}
    await_ready = env.s.classic._await_ready

    def wait_for_ready(child):
        waiting.set()
        assert release.wait(10)
        await_ready(child)

    def submit():
        params = {"mods.toggle": {"enabled": False, "expect": True}, "mods.restoreDrift": {"entries": []},
                  "actions.apply": {"variant": "test", "source": f"mod:{mod.id}"},
                  "actions.restore": {"variant": "test"}}[method]
        submitting.update(rpc(env.app, method, **params))
        answered.set()

    monkeypatch.setattr(env.s.classic, "_await_ready", wait_for_ready)
    opener = threading.Thread(target=lambda: opening.update(rpc(env.app, "app.openClassic", tab="crc_tool")))
    submitter = threading.Thread(target=submit)
    opener.start()
    try:
        assert waiting.wait(5)
        submitter.start()
        assert answered.wait(5)
        assert submitting["error"]["code"] == "classic_open"
    finally:
        release.set()
        opener.join(5)
        if submitter.ident is not None:
            submitter.join(5)
    assert not opener.is_alive() and not submitter.is_alive()
    assert opening["result"] == {"started": True}


# --- quitting and the single instance ---

def test_app_quit(env):
    destroyed = []
    s, app = env.s, env.app
    assert rpc(app, "app.quit")["error"]["code"] == "native_unavailable"  # --serve
    gate = threading.Event()
    s.jobs.submit("extract", lambda log, progress: gate.wait(5))  # read-only: never holds up quitting
    s.window = SimpleNamespace(destroy=lambda: destroyed.append(True))
    assert "error" not in rpc(app, "app.quit") and destroyed == [True]
    s.submit("slow", lambda log, progress: gate.wait(5), writes="library")
    assert rpc(app, "app.quit")["error"]["code"] == "busy"
    gate.set()
    assert wait_for(lambda: not s.jobs.busy())
    # browser mode: the answer goes out first, then the server stops
    stopped = threading.Event()
    s.window, s.quit_handle = None, stopped.set
    assert "error" not in rpc(app, "app.quit") and not stopped.is_set()
    assert stopped.wait(5)


def test_one_instance_per_data_directory(tmp_path):
    first = InstanceLock(tmp_path)
    assert first.acquire()
    assert not InstanceLock(tmp_path).acquire()
    raised = []
    app = WebApp(None, None, raise_window=lambda: raised.append(True), raise_token="secret", token="tok")
    first.publish(4321, "secret")
    assert read_info(tmp_path)["port"] == 4321
    assert raise_running(tmp_path, opener=WsgiOpener(app)) and raised == [True]
    # a wrong token is refused
    InstanceLock(tmp_path).publish(4321, "wrong")
    assert not raise_running(tmp_path, opener=WsgiOpener(app))
    first.publish(4321, "secret")
    first.release()
    assert not (tmp_path / "instance.json").exists()
    assert InstanceLock(tmp_path).acquire()


def test_a_second_start_brings_the_first_window_to_the_front_and_exits(tmp_path, monkeypatch):
    held = InstanceLock(tmp_path)
    assert held.acquire()
    held.publish(4321, "secret")
    raised = []
    monkeypatch.setattr(webui_main, "EXE_DIR", tmp_path)
    monkeypatch.setattr(webui_main, "raise_running", lambda data_dir: raised.append(data_dir) or True)
    monkeypatch.setattr(webui_main, "build", lambda *a, **k: pytest.fail("started a second instance"))
    with pytest.raises(SystemExit) as exit_:
        webui_main.main([])
    assert exit_.value.code == 0 and raised == [tmp_path]
    with pytest.raises(SystemExit) as exit_:
        webui_main.main(["--serve"])  # a dev server refuses to start
    assert exit_.value.code == 1 and raised == [tmp_path]
    held.release()


def test_background_add_is_a_writer_with_durable_file_progress_and_no_game_rescan(env, monkeypatch):
    path = make_mod(env.spr, env.tmp / 'picker')
    env.s.library
    assert env.s.jobs.wait(env.s._prune_job, 5)
    assert env.s.scanner.wait_idle(5)
    monkeypatch.setattr(env.s.scanner, 'request', lambda **kw: pytest.fail('an import must not rescan game files'))
    job = env.job('mods.add', paths=[str(path)], background=True)
    assert job.state == 'done' and job.writes == 'library'
    assert [(m['target'], m['kind']) for m in job.result] == [('test', 'spr')]
    assert job.to_json()['progress'] == {'id': job.id, 'current': 1, 'total': 1, 'label': path.name}
    changed = events_named(env.drain(), 'library.changed')
    assert changed[-1] == {'cores': [], 'kinds': [], 'mods': True}


@pytest.mark.parametrize('scan_finishes_first', [True, False])
def test_background_add_replaces_a_scan_it_invalidates(env, monkeypatch, scan_finishes_first):
    from ba_modding_toolkit.library.service import _View

    env.s.set_scan_consent(True)
    assert env.s.scanner.wait_idle(5)
    entered, release, dropped = (threading.Event() for _ in range(3))
    entries = _View.entries
    scans = []

    def blocked(view, pins, cancel=None, cores=None):
        scans.append(cores)
        if len(scans) == 1:
            entered.set()
            assert release.wait(5)
        return entries(view, pins, cancel, cores)

    monkeypatch.setattr(_View, 'entries', blocked)
    scanned = env.s.scanner._on_done

    def completed(result, served):
        scanned(result, served)
        if result is None:
            dropped.set()

    monkeypatch.setattr(env.s.scanner, '_on_done', completed)
    add = env.s.library.add

    def overlapping(paths, progress=None):
        result = add(paths, progress)
        if scan_finishes_first:
            release.set()
            assert dropped.wait(5)  # the stale scan is already gone while add is still busy
        return result

    monkeypatch.setattr(env.s.library, 'add', overlapping)
    env.s.request_scan()
    assert entered.wait(5)
    try:
        path = make_mod(env.spr, env.tmp / 'picker')
        job = env.job('mods.add', paths=[str(path)], background=True)
        assert job.state == 'done'
    finally:
        release.set()
    assert env.s.scanner.wait_idle(5)
    assert len(scans) >= 2 and scans[-1] is None
    assert env.s.snapshot.scanned() and not env.s.scanner.invalidated


def test_apply_rescans_other_cores_changed_by_global_pruning(env, monkeypatch):
    other = game_bundle(env.game, 'other_spr')
    env.s.set_scan_consent(True)
    assert env.s.scanner.wait_idle(5)
    mod_b = env.add(other)
    assert env.job('actions.apply', variant='other', source=f'mod:{mod_b.id}').state == 'done'
    assert env.s.scanner.wait_idle(5)
    before = {e.core: e for e in env.s.snapshot.entries()}
    assert before['other_spr'].state == 'ok'
    other.unlink()
    game_bundle(env.game, 'other_spr', date='2026-02-01', payload=b'updated official')
    scopes = []
    scan = env.s.library.scan

    def measured(*args, **kwargs):
        scopes.append(kwargs.get('cores'))
        return scan(*args, **kwargs)

    monkeypatch.setattr(env.s.library, 'scan', measured)
    mod_a = env.add(env.spr)
    assert env.job('actions.apply', variant='test', source=f'mod:{mod_a.id}').state == 'done'
    assert env.s.scanner.wait_idle(5)
    assert scopes == [{'test_spr', 'other_spr'}]
    after = {e.core: e for e in env.s.snapshot.entries()}
    assert after['other_spr'].state == 'updated'
    assert after['test_spr'].configured == f'mod:{mod_a.id}'


def test_switch_rescans_only_changed_cores_and_preserves_other_snapshot_entries(env, monkeypatch):
    env.s.set_scan_consent(True)
    assert env.s.scanner.wait_idle(5)
    other = game_bundle(env.game, 'other_spr')
    keep = other.with_name(other.name + '.backup')
    keep.write_bytes(other.read_bytes())
    other.write_bytes(header_bundle(b'outside mod') + b'crc!')
    env.s.request_scan()
    assert env.s.scanner.wait_idle(5)
    before = {(e.install, e.core): e for e in env.s.snapshot.entries()}
    assert (env.key(), 'other_spr') in before
    scopes = []
    scan = env.s.library.scan

    def measured(*args, **kwargs):
        scopes.append(kwargs.get('cores'))
        return scan(*args, **kwargs)

    monkeypatch.setattr(env.s.library, 'scan', measured)
    mod = env.add(env.spr)
    job = env.job('actions.apply', variant='test', source=f'mod:{mod.id}')
    assert job.state == 'done'
    assert env.s.scanner.wait_idle(5)
    assert scopes == [{'test_spr'}]
    after = {(e.install, e.core): e for e in env.s.snapshot.entries()}
    assert after[(env.key(), 'other_spr')] == before[(env.key(), 'other_spr')]
    assert after[(env.key(), 'test_spr')].configured == f'mod:{mod.id}'


def test_unchanged_apply_rescans_only_the_variants_cores(env, monkeypatch):
    env.s.set_scan_consent(True)
    assert env.s.scanner.wait_idle(5)
    mod = env.add(env.spr)
    assert env.job('actions.apply', variant='test', source=f'mod:{mod.id}').state == 'done'
    assert env.s.scanner.wait_idle(5)
    scopes = []
    scan = env.s.library.scan

    def measured(*args, **kwargs):
        scopes.append(kwargs.get('cores'))
        return scan(*args, **kwargs)

    monkeypatch.setattr(env.s.library, 'scan', measured)
    job = env.job('actions.apply', variant='test', source=f'mod:{mod.id}')
    assert job.state == 'done' and job.result['unchanged']
    assert env.s.scanner.wait_idle(5)
    assert scopes == [{'test_spr'}]
