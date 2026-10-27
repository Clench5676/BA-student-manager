"""Headless shutdown regressions for BL-055; no native GUI is started."""

import logging
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.webui import main, native
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.instance import InstanceLock, read_info
from ba_modding_toolkit.webui.jobs import JobRunner
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.timing import Timings
from ba_modding_toolkit.webui.tray import Tray


DROP_EVENTS = ("dragenter", "dragstart", "dragover", "drop")


def make_desktop(monkeypatch, tmp_path, platform):
    class Hook:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, handler):
            self.handlers.append(handler)
            return self

        def fire(self, *args):
            return [handler(*args) for handler in self.handlers]

    class DOMEventHandler:
        def __init__(self, callback, prevent_default, stop_propagation, debounce=0):
            self.callback = callback
            self.options = (prevent_default, stop_propagation, debounce)

    class DOMEvent:
        def __init__(self, name):
            self.name, self.handler = name, None

        def __iadd__(self, handler):
            # Like Element.on, registration waits for evaluate_js before retaining the handler.
            evaluate(self.name)
            self.handler = handler
            if self.name == "drop":
                state.complete.set()
            return self

    state = SimpleNamespace(block=None, entered=threading.Event(), resume=threading.Event(),
                            complete=threading.Event(), workers=[], deferred=[],
                            registered=[], callbacks=[], run=lambda: None, platform=platform)

    def evaluate(event):
        if threading.current_thread() not in state.workers:
            state.workers.append(threading.current_thread())
        if event == state.block:
            state.entered.set()
            state.resume.wait()
        state.registered.append(event)

    hooks = SimpleNamespace(**{name: Hook() for name in (
        "before_show", "shown", "initialized", "loaded", "closing", "closed", "maximized", "minimized", "restored")})
    dom_events = SimpleNamespace(**{name: DOMEvent(name) for name in DROP_EVENTS})
    window = SimpleNamespace(events=hooks, native=None, dom=SimpleNamespace(document=SimpleNamespace(events=dom_events)))
    if platform == "win32":
        window.native = SimpleNamespace(BeginInvoke=state.deferred.append)
    state.window = window
    state.services = SimpleNamespace(data_dir=tmp_path, events=EventBus(), timings=Timings(),
                                    on_closing=lambda: state.callbacks.append("closing") or False,
                                    on_closed=lambda: state.callbacks.append("closed"))

    def commands(*args):
        def dispose():
            state.callbacks.append("commands disposed")
        dispose.refresh = lambda: None
        return dispose

    def start(**options):
        assert hooks.initialized.fire("edgechromium" if platform == "win32" else "wkwebview") == [True]
        hooks.before_show.fire()
        hooks.shown.fire()
        return state.run()

    monkeypatch.setattr(main.sys, "platform", platform)
    monkeypatch.setattr(native, "webview2_version", lambda: "130.0.0.0")
    monkeypatch.setattr(native, "install_window_commands", commands)
    monkeypatch.setattr(Tray, "supported", staticmethod(lambda: False))
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(settings={}, create_window=lambda *a, **kw: window,
                                                                start=start))
    monkeypatch.setitem(sys.modules, "webview.dom", SimpleNamespace(DOMEventHandler=DOMEventHandler))
    monkeypatch.setitem(sys.modules, "System", SimpleNamespace(Action=lambda fn: fn))
    monkeypatch.setitem(sys.modules, "PyObjCTools", SimpleNamespace(AppHelper=SimpleNamespace(callAfter=state.deferred.append)))
    return state


@pytest.fixture(params=("darwin", "win32"))
def desktop(monkeypatch, tmp_path, request):
    state = make_desktop(monkeypatch, tmp_path, request.param)
    yield state
    state.resume.set()
    for worker in state.workers:
        worker.join(3)
        assert not worker.is_alive()


def run_window(desktop):
    main._run_window(desktop.services, SimpleNamespace(url="http://127.0.0.1:1/"), False)


def wait_loaded(desktop):
    assert desktop.complete.wait(3)
    for worker in desktop.workers:
        worker.join(3)
        assert not worker.is_alive()


@pytest.mark.parametrize("blocked_event", DROP_EVENTS)
def test_loop_return_with_pending_registration_does_not_hold_up_shutdown(desktop, caplog, blocked_event):
    desktop.block = blocked_event
    loaded = threading.Thread(target=desktop.window.events.loaded.fire, daemon=False)
    def leave_loop():
        loaded.start()
        assert desktop.entered.wait(3)

    desktop.run = leave_loop
    with caplog.at_level(logging.INFO):
        try:
            run_window(desktop)
            # CPython joins pywebview's non-daemon event thread, but not the App's GUI worker.
            loaded.join(1)
            assert not loaded.is_alive() and not loaded.daemon
            assert len(desktop.workers) == 1
            worker = desktop.workers[0]
            assert worker.is_alive() and worker.daemon
            assert "Native lifecycle: loop returned" in caplog.text
            assert "cleanup begin shown=True loaded=True closing=False closed=False drops=running" in caplog.text
            assert f"Native drop registration: begin event={blocked_event}" in caplog.text
            assert "Native lifecycle: loaded complete" not in caplog.text
            assert "Native drop registration: complete" not in caplog.text
            assert desktop.callbacks == (["commands disposed"] if desktop.platform == "darwin" else [])
        finally:
            # Release only for test cleanup, after proving shutdown no longer needs the GUI result.
            desktop.resume.set()
            loaded.join(3)
            for worker in desktop.workers:
                worker.join(3)
        assert not loaded.is_alive() and not worker.is_alive()
        assert desktop.registered == list(DROP_EVENTS[:DROP_EVENTS.index(blocked_event) + 1])
        assert "Native lifecycle: loaded complete drops=abandoned" in caplog.text


@pytest.mark.parametrize("platform", ("darwin", "win32"))
@pytest.mark.parametrize("blocked_event", DROP_EVENTS)
def test_interpreter_exits_without_a_gui_result(tmp_path, platform, blocked_event):
    # A real interpreter shutdown is the regression: never release the fake GUI semaphore.
    script = """
import runpy, sys, threading
from pathlib import Path
import pytest
scope = runpy.run_path(sys.argv[1])
desktop = scope['make_desktop'](pytest.MonkeyPatch(), Path(sys.argv[2]), sys.argv[3])
desktop.block = sys.argv[4]
loaded = threading.Thread(target=desktop.window.events.loaded.fire, daemon=False)
def leave_loop():
    loaded.start()
    assert desktop.entered.wait(3)
desktop.run = leave_loop
scope['run_window'](desktop)
"""
    result = subprocess.run([sys.executable, "-c", script, str(Path(__file__).resolve()), str(tmp_path),
                             platform, blocked_event], capture_output=True, text=True, timeout=5,
                            cwd=Path(__file__).resolve().parents[1])
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("error_type", [RuntimeError, SystemExit])
def test_loop_exception_is_identified_and_propagated_without_logging_its_contents(desktop, caplog, error_type):
    error = error_type("private diagnostic payload")

    def fail():
        raise error

    desktop.run = fail
    with caplog.at_level(logging.INFO), pytest.raises(error_type) as caught:
        run_window(desktop)
    assert caught.value is error
    assert f"Native lifecycle: loop raised type={error_type.__name__}" in caplog.text
    assert "Native lifecycle: loop returned" not in caplog.text
    assert "cleanup begin shown=True loaded=False closing=False closed=False drops=not-started" in caplog.text
    assert "Native lifecycle: cleanup complete" in caplog.text
    assert "private diagnostic payload" not in caplog.text
    assert desktop.callbacks == (["commands disposed"] if desktop.platform == "darwin" else [])


def test_completed_load_preserves_drop_options_paths_and_close_results(desktop, caplog):
    drops = []
    desktop.services.events.observe(lambda event, data: drops.append(data) if event == "drop" else None)

    def close():
        desktop.window.events.loaded.fire()
        wait_loaded(desktop)
        assert desktop.services.close_coordinator.page_loaded is True
        assert desktop.registered == list(DROP_EVENTS)
        handlers = desktop.window.dom.document.events
        for name in DROP_EVENTS:
            assert getattr(handlers, name).handler.options == (True, True, 500 if name == "dragover" else 0)
        handlers.drop.handler.callback({"dataTransfer": {"files": [
            {"pywebviewFullPath": "/fake/private/dropped.bundle"}, {"name": "no-native-path"}]}})
        assert desktop.window.events.closing.fire() == [False]
        desktop.window.events.closed.fire()

    desktop.run = close
    with caplog.at_level(logging.INFO):
        run_window(desktop)
        desktop.window.dom.document.events.drop.handler.callback({"dataTransfer": {"files": [
            {"pywebviewFullPath": "/fake/private/late.bundle"}]}})
    assert drops == [{"paths": ["/fake/private/dropped.bundle"]}]
    assert "/fake/private" not in caplog.text
    assert desktop.callbacks == ["closing", "closed"] + (["commands disposed"] if desktop.platform == "darwin" else [])
    assert "Native lifecycle: closing complete allowed=False" in caplog.text
    assert "cleanup begin shown=True loaded=True closing=True closed=True drops=complete" in caplog.text


def test_vetoed_close_and_reload_still_register_all_drop_events(desktop):
    def load():
        assert desktop.window.events.closing.fire() == [False]
        for _ in range(2):
            desktop.complete.clear()
            desktop.window.events.loaded.fire()
            wait_loaded(desktop)

    desktop.run = load
    run_window(desktop)
    assert desktop.registered == list(DROP_EVENTS) * 2


@pytest.mark.parametrize("stop_route", ("approved", "closed", "loop-return"))
def test_late_loaded_work_is_skipped_after_stop(desktop, caplog, stop_route):
    def close():
        if stop_route == "approved":
            desktop.services.on_closing = lambda: True
            assert desktop.window.events.closing.fire() == [True]
        elif stop_route == "closed":
            desktop.window.events.closed.fire()
        if stop_route != "loop-return":
            desktop.window.events.loaded.fire()

    desktop.run = close
    # Observe completion of a skipped daemon worker without waiting for any DOM event.
    skipped = threading.Event()
    class Capture(logging.Handler):
        def emit(self, record):
            if record.getMessage() == "Native lifecycle: loaded skipped stopped=True":
                skipped.set()

    logger = logging.getLogger(main.__name__)
    capture = Capture()
    logger.addHandler(capture)
    try:
        with caplog.at_level(logging.INFO):
            run_window(desktop)
            if stop_route == "loop-return":
                desktop.window.events.loaded.fire()
            assert skipped.wait(3)
    finally:
        logger.removeHandler(capture)
    assert desktop.registered == []
    assert desktop.deferred == []


def test_loaded_chrome_install_stays_on_gui_dispatch_and_skips_after_cleanup(desktop, monkeypatch):
    desktop.window.native = SimpleNamespace(BeginInvoke=desktop.deferred.append)
    installed = []

    def load():
        monkeypatch.setattr(desktop.services.chrome, "install", lambda: installed.append(threading.current_thread()))
        desktop.window.events.loaded.fire()
        wait_loaded(desktop)
        assert len(desktop.deferred) == (2 if desktop.platform == "darwin" else 1)
        desktop.deferred[0]()
        assert installed == [threading.current_thread()]

    desktop.run = load
    run_window(desktop)
    desktop.deferred[0]()
    assert len(installed) == 1


def test_other_async_window_handlers_only_enqueue_gui_work(desktop):
    def state_changes():
        desktop.services.chrome.active = True
        desktop.services.chrome.host = SimpleNamespace(dispatch=desktop.deferred.append, dispose=lambda: None)
        for name in ("shown", "maximized", "minimized", "restored"):
            handler = threading.Thread(target=getattr(desktop.window.events, name).fire, daemon=False)
            handler.start()
            handler.join(1)
            assert not handler.is_alive()
        assert len(desktop.deferred) == 4

    desktop.run = state_changes
    run_window(desktop)


def test_loop_return_still_drains_writer_and_releases_instance(desktop, monkeypatch, caplog):
    desktop.block = "dragstart"
    loaded = threading.Thread(target=desktop.window.events.loaded.fire, daemon=False)
    writer_started, release_writer = threading.Event(), threading.Event()
    cleanup_started, cleanup_finished = threading.Event(), threading.Event()
    observations = []
    s = desktop.services
    s.jobs = JobRunner(s.events)
    s.watch = None
    s.scanner = SimpleNamespace(stop=lambda: None)
    s.classic = SimpleNamespace(close=lambda: None)
    s.log_secrets = set()
    s.restart_requested = False
    instance = InstanceLock(s.data_dir)

    def write(log, progress):
        writer_started.set()
        if release_writer.wait(5):
            (s.data_dir / "writer-finished").write_text("done", encoding="utf-8")

    def close_services():
        cleanup_started.set()
        Services.close(s)
        cleanup_finished.set()

    def finish_writer():
        try:
            observations.append(cleanup_started.wait(3))
            observations.append(not cleanup_finished.wait(0.02))
            probe = InstanceLock(s.data_dir)
            observations.append(not probe.acquire())
            probe.release()
        finally:
            release_writer.set()

    def leave_loop():
        assert writer_started.wait(3)
        loaded.start()
        assert desktop.entered.wait(3)

    s.start = lambda: s.jobs.submit("test.writer", write, writes="library")
    s.close = close_services
    desktop.run = leave_loop
    server = SimpleNamespace(port=1, url="http://127.0.0.1:1/", app=SimpleNamespace(raise_token="fake"),
                             start=lambda: None, stop=lambda: None)
    monkeypatch.setattr(main, "EXE_DIR", s.data_dir)
    monkeypatch.setattr(main, "InstanceLock", lambda data_dir: instance)
    monkeypatch.setattr(main, "build", lambda *args, **kwargs: (s, server))
    finisher = threading.Thread(target=finish_writer, daemon=True)
    finisher.start()
    with caplog.at_level(logging.INFO):
        try:
            main.main(["--mute"])
        finally:
            release_writer.set()
            finisher.join(3)
            if loaded.ident is not None:
                loaded.join(3)
    assert observations == [True, True, True]
    assert cleanup_finished.is_set() and not s.jobs.busy()
    assert (s.data_dir / "writer-finished").read_text(encoding="utf-8") == "done"
    assert not instance.held and read_info(s.data_dir) is None
    probe = InstanceLock(s.data_dir)
    try:
        assert probe.acquire()
    finally:
        probe.release()
    assert not loaded.is_alive()
    assert desktop.workers[0].is_alive() and desktop.workers[0].daemon
    assert "Application lifecycle: services cleanup complete" in caplog.text
    assert "Application lifecycle: run finished" in caplog.text


def test_run_completion_is_written_before_the_session_log_closes(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "EXE_DIR", tmp_path)
    monkeypatch.setattr(main, "_serve", lambda *args: False)
    args = SimpleNamespace(safe_mode=False, token=None, serve=False)
    logger = logging.getLogger(main.__name__)
    previous = logger.level
    logger.setLevel(logging.INFO)
    try:
        assert main._run(args, SimpleNamespace()) is False
    finally:
        logger.setLevel(previous)
    assert "Application lifecycle: run finished" in (tmp_path / "webui.log").read_text(encoding="utf-8")
