"""The tray and menu bar icon: its menu model and its controller with fake services. No tray backend (NSStatusItem,
NotifyIcon) is made here; tests/test_tray_icons.py checks the icon files."""

import importlib.util
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import i18n_manager
from ba_modding_toolkit.webui import tray as tray_module
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.jobs import JobRunner
from ba_modding_toolkit.webui.strings import ui_strings
from ba_modding_toolkit.webui.tray import MenuItem, Tray, needs_window, toggle_action, tray_menu, tray_tooltip

ROOT = Path(__file__).resolve().parent.parent
EN = ui_strings("en-US")


def snapshot(**fields):
    base = {"installs": [{"id": "a", "key": "g", "server": "global", "label": "Global (A)"},
                         {"id": "b", "key": "j", "server": "japan", "label": "Japan"}],
            "enabled": True, "available": True, "reason": None, "reasonParams": {}, "scan": True, "explained": True,
            "drift": 0, "untracked": 0, "busy": False, "progress": None, "tray": True}
    return {**base, **fields}


def labels(items):
    return [item.label for item in items]


# --- the menu ---

def test_the_menu_has_one_enable_mods_item_checked_when_on():
    items = tray_menu(snapshot(), EN)
    assert labels(items) == ["Enable Mods", "", "Open", "Quit"]
    toggle = items[0]
    assert toggle == MenuItem("toggle", "Enable Mods", enabled=True, checked=True)
    assert items[1].separator
    assert [item.action for item in items] == ["toggle", None, "open", "quit"]
    # one item for every known install: no install name on it (decision 1)
    assert not any("Global" in item.label or "Japan" in item.label for item in items)


def test_the_menu_is_unchecked_when_off():
    toggle = tray_menu(snapshot(enabled=False), EN)[0]
    assert toggle.enabled and not toggle.checked


@pytest.mark.parametrize("reason, params, line", [
    ("game_running", {}, "Close the game first"),
    ("game_status_unavailable", {}, "Could not tell whether the game is running"),
    ("steam_busy", {}, "Steam is updating or verifying the game"),
    ("classic_open", {}, "Close the classic UI first"),
    ("game_not_found", {}, "Game folder not found"),
    ("profiles_unreadable", {"file": "profiles.json"}, "Unreadable mod settings: profiles.json"),
])
def test_an_unavailable_switch_is_greyed_with_its_reason(reason, params, line):
    items = tray_menu(snapshot(reason=reason, reasonParams=params, available=False), EN)
    assert items[0].action == "toggle" and not items[0].enabled
    assert items[1] == MenuItem(None, line, enabled=False)
    assert labels(items)[2:] == ["", "Open", "Quit"]


def test_a_running_toggle_greys_the_switch_with_its_progress():
    items = tray_menu(snapshot(busy=True, progress={"done": 12, "total": 40}), EN)
    assert not items[0].enabled
    assert items[1] == MenuItem(None, "Working 12/40", enabled=False)
    queued = tray_menu(snapshot(busy=True, progress=None), EN)
    assert queued[1].label == "Working"


def test_before_the_first_snapshot_the_switch_is_greyed():
    items = tray_menu(None, EN)
    assert not items[0].enabled and not items[0].checked
    assert items[1].label == "Working"
    assert labels(items)[-2:] == ["Open", "Quit"]


def test_the_drift_item_shows_with_scan_consent():
    items = tray_menu(snapshot(drift=3), EN)
    assert items[1] == MenuItem("drift", "Back to Official: 3")
    assert "drift" not in [i.action for i in tray_menu(snapshot(drift=3, scan=None), EN)]
    assert "drift" not in [i.action for i in tray_menu(snapshot(drift=0), EN)]


def test_the_menu_follows_the_language():
    items = tray_menu(snapshot(reason="game_running", available=False), ui_strings("zh-CN"))
    zh = ui_strings("zh-CN")
    assert items[0].label == zh["webui.mods.switch"]
    assert items[1].label == zh["webui.error.game_running"]
    assert items[-1].label == zh["webui.tray.quit"]


def test_the_tooltip_names_the_app_and_the_state():
    assert tray_tooltip(snapshot(), EN, "App") == "App\nMods on"
    assert tray_tooltip(snapshot(enabled=False), EN, "App") == "App\nMods off"
    assert tray_tooltip(snapshot(busy=True, progress={"done": 12, "total": 40}), EN, "App") == "App\nWorking 12/40"
    assert tray_tooltip(None, EN, "App") == "App"


# --- clicks ---

def test_the_first_toggle_opens_the_window_on_the_explanation():
    assert toggle_action(snapshot(explained=False)) == ("explain", {"enabled": False, "expect": True})
    assert toggle_action(snapshot(explained=False, enabled=False)) == ("explain", {"enabled": True, "expect": False})


def test_later_toggles_submit_at_once_an_off_with_untracked_mods_included():
    assert toggle_action(snapshot()) == ("submit", {"enabled": False, "expect": True})
    assert toggle_action(snapshot(untracked=4, scan=True)) == ("submit", {"enabled": False, "expect": True})
    assert toggle_action(snapshot(enabled=False)) == ("submit", {"enabled": True, "expect": False})


def test_a_greyed_switch_does_nothing():
    assert toggle_action(None) is None
    assert toggle_action(snapshot(reason="game_running", available=False)) is None
    assert toggle_action(snapshot(busy=True)) is None


def test_a_refusal_or_a_result_with_failed_entries_opens_the_window():
    assert needs_window("failed", None)
    assert needs_window("done", {"failed": [{"core": "a"}], "stuck": [], "left": []})
    assert needs_window("done", {"failed": [], "stuck": [{"core": "a"}], "left": []})
    assert needs_window("done", {"failed": [], "stuck": [], "left": [{"core": "a"}]})
    assert not needs_window("done", {"failed": [], "stuck": [], "left": [], "adopted": [{"core": "a"}]})
    assert not needs_window("dropped", None)


# --- the controller, with fake services ---

class FakeWatch:
    def __init__(self):
        self.pokes = 0

    def poke(self):
        self.pokes += 1


class FakeServices:
    def __init__(self, state=None):
        self.events = EventBus()
        self.jobs = JobRunner(self.events)
        self.watch = FakeWatch()
        self.tray_shown = False
        self.state = state if state is not None else snapshot()
        self.raised = threading.Event()
        self.raises = 0
        self.refuse: str | None = None
        self.result = {"enabled": False, "failed": [], "stuck": [], "left": []}
        self.submitted = []
        self.busy = False
        self.quits = 0

    def mods_state(self):
        return dict(self.state)

    def raise_window(self):
        self.raises += 1
        self.raised.set()

    def submit_toggle(self, enabled, expect):
        if self.refuse:
            raise ServiceError(self.refuse)
        self.submitted.append((enabled, expect))
        return self.jobs.submit("mods.toggle", lambda log, progress: self.result, writes="game")

    def quit(self):
        if self.busy:
            raise ServiceError("busy")
        self.quits += 1


class FakeBackend:
    def __init__(self):
        self.synced = []
        self.started = False
        self.closed = False

    def start(self):
        self.started = True

    def call(self, fn):
        fn()

    def sync(self, shown, tooltip):
        self.synced.append((shown, tooltip))

    def close(self):
        self.closed = True


@pytest.fixture
def made(monkeypatch):
    monkeypatch.setattr(i18n_manager, "lang", "en-US")  # the tray's strings follow the UI language
    services = FakeServices()
    backend = FakeBackend()
    tray = Tray(services, backend=backend)
    tray.attach()
    events = services.events.subscribe()
    yield services, backend, tray, events
    tray.close()
    services.jobs.shutdown(wait=5)


def drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def test_the_icon_follows_the_preference_from_the_mods_state_events(made):
    services, backend, tray, _ = made
    tray.run(window=None)  # no snapshot yet: it is read once, off the UI thread
    assert backend.started
    assert backend.synced[-1][0] is True and "Mods on" in backend.synced[-1][1]
    assert services.tray_shown
    services.events.publish("mods.state", snapshot(tray=False))
    assert backend.synced[-1][0] is False and not services.tray_shown
    services.events.publish("mods.state", snapshot(tray=True, enabled=False))
    assert backend.synced[-1] == (True, f"{tray_module.t('ui.app_title')}\nMods off")
    # the observer is not a page: the game watch's fast polling counts pages only
    assert services.events.listeners() == 1
    tray.close()
    assert backend.closed and not services.tray_shown
    count = len(backend.synced)
    services.events.publish("mods.state", snapshot(tray=True))
    assert len(backend.synced) == count  # no longer observed


def test_the_icon_waits_for_the_window_and_never_comes_after_it_closed(made):
    from types import SimpleNamespace

    services, backend, tray, _ = made
    window = SimpleNamespace(events=SimpleNamespace(shown=threading.Event(), closed=threading.Event()))
    window.events.closed.set()  # closed before it showed
    tray.run(window)
    assert not backend.started
    window.events.shown.set()
    tray.close()
    tray.run(window)  # the loop ended first
    assert not backend.started


def test_opening_the_menu_reads_the_snapshot_and_pokes_the_game_watch(made):
    services, _, tray, _ = made
    services.events.publish("mods.state", snapshot(reason="steam_busy", available=False))
    items = tray.menu_items()
    assert items[1].label == "Steam is updating or verifying the game"
    assert services.watch.pokes == 1


def test_the_first_toggle_opens_the_window_without_submitting(made):
    services, _, tray, events = made
    services.events.publish("mods.state", snapshot(explained=False))
    tray._toggle()
    assert services.submitted == [] and services.raises == 1
    sent = [e for e in drain(events) if e[0] == "tray.open"]
    assert sent == [("tray.open", {"view": "explain", "enabled": False, "expect": True})]


def test_a_toggle_submits_and_the_page_follows_its_job(made):
    services, _, tray, events = made
    services.events.publish("mods.state", snapshot())
    tray._toggle()
    assert services.submitted == [(False, True)]
    follow = [e for e in drain(events) if e[0] == "tray.toggle"]
    assert follow and follow[0][1]["enabled"] is False and follow[0][1]["expect"] is True
    services.jobs.wait(follow[0][1]["job"], 5)
    assert not services.raised.wait(0.3)  # a clean result stays in the background


def test_a_result_with_failed_entries_brings_the_window_up(made):
    services, _, tray, _ = made
    services.result = {"enabled": False, "failed": [{"core": "a"}], "stuck": [], "left": []}
    services.events.publish("mods.state", snapshot())
    tray._toggle()
    assert services.raised.wait(5)


def test_a_refusal_opens_the_window_on_the_error(made):
    services, _, tray, events = made
    services.refuse = "classic_open"
    services.events.publish("mods.state", snapshot())
    tray._toggle()
    assert services.raises == 1
    sent = [e for e in drain(events) if e[0] == "tray.open"]
    assert sent == [("tray.open", {"view": "error", "code": "classic_open", "params": {}})]


def test_a_greyed_toggle_does_nothing(made):
    services, _, tray, events = made
    services.events.publish("mods.state", snapshot(reason="game_running", available=False))
    tray._toggle()
    assert services.submitted == [] and services.raises == 0
    assert not [e for e in drain(events) if e[0].startswith("tray.")]


def test_drift_opens_the_window_on_the_prompt(made):
    services, _, tray, events = made
    tray._drift()
    assert services.raises == 1
    assert ("tray.open", {"view": "drift"}) in drain(events)


def test_quit_follows_app_quit_and_shows_the_busy_toast(made):
    services, _, tray, events = made
    tray._quit()
    assert services.quits == 1 and services.raises == 0
    services.busy = True
    tray._quit()
    assert services.quits == 1 and services.raises == 1
    assert ("app.busy", {}) in drain(events)


def test_a_click_runs_off_the_ui_thread(made):
    services, _, tray, _ = made
    caller = threading.current_thread()
    seen = []
    services.raise_window = lambda: (seen.append(threading.current_thread()), services.raised.set())
    tray.on_action("open")
    assert services.raised.wait(5)
    assert seen and seen[0] is not caller
    tray.on_action("unknown")  # ignored


# --- the backends ---

def test_the_tray_module_makes_no_backend_on_import():
    code = ("import sys, ba_modding_toolkit.webui.tray as t; "
            "print(sorted(m for m in ('AppKit', 'Foundation', 'clr', 'PyObjCTools') if m in sys.modules))")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,
                         env={**os.environ, "PYTHONPATH": str(ROOT / "src")})
    assert out.stdout.strip() == "[]"


def test_no_tray_on_other_systems():
    assert not Tray.supported("linux")


@pytest.mark.skipif(sys.platform != "darwin" or importlib.util.find_spec("AppKit") is None,
                    reason="AppKit draws the menu bar")
def test_appkit_loads_the_pdf_as_a_vector_template_image():
    image = tray_module.menubar_image()
    assert image is not None and image.isTemplate()
    assert tuple(image.size()) == (18, 18)
    assert [rep.className() for rep in image.representations()] == ["NSPDFImageRep"]


# --- the app window's wiring ---

class Hook:
    def __iadd__(self, handler):
        return self


def run_window(monkeypatch, tmp_path, supported):
    from types import SimpleNamespace

    from ba_modding_toolkit.webui import main

    window = SimpleNamespace(events=SimpleNamespace(initialized=Hook(), loaded=Hook(), closing=Hook(), closed=Hook()))
    started, closed = {}, []
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(create_window=lambda *a, **k: window,
                                                                start=lambda **options: started.update(options)))
    monkeypatch.setattr(Tray, "supported", staticmethod(lambda platform=sys.platform: supported))
    monkeypatch.setattr(Tray, "close", lambda self: closed.append(self))
    services = FakeServices()
    services.window, services.data_dir, services.tray_supported = None, tmp_path, None
    try:
        main._run_window(services, SimpleNamespace(url="http://127.0.0.1:1/"), False)
    finally:
        services.jobs.shutdown(wait=5)
    return services, window, started, closed


def test_the_app_window_starts_the_tray_with_the_gui_loop_and_removes_it_after(monkeypatch, tmp_path):
    services, window, started, closed = run_window(monkeypatch, tmp_path, supported=True)
    assert services.tray_supported is True
    assert len(closed) == 1
    tray = closed[0]
    assert started["func"] == tray.start and started["args"] == (window,)
    # it follows mods.state from before the window opens
    services.events.publish("mods.state", snapshot(enabled=False))
    assert tray.snapshot()["enabled"] is False


def test_without_a_tray_the_window_starts_alone(monkeypatch, tmp_path):
    services, _, started, closed = run_window(monkeypatch, tmp_path, supported=False)
    assert services.tray_supported is False
    assert started["func"] is None and started["args"] is None and closed == []
