"""The classic hand-off: the control channel, the window's placement, classic.json and the queue of writes for after
the classic window (webui/classic.py, gui/control.py)."""

from __future__ import annotations

import calendar
import io
import json
import locale
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gui import control as ctl
from ba_modding_toolkit.webui import classic as cl
from ba_modding_toolkit.webui import system

# --- helpers ---


def wait_for(cond, timeout=5.0, step=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(step)
    return cond()


class Response:
    def __init__(self, body: bytes):
        self.body = body

    def read(self) -> bytes:
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class WsgiOpener:
    """An opener that calls a WSGI app in this process: the HTTP channel without a socket."""

    def __init__(self, app):
        self.app = app

    def open(self, req, timeout=None):
        body = req.data or b""
        environ = {"REQUEST_METHOD": req.get_method(), "PATH_INFO": urlparse(req.full_url).path,
                   "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body)}
        for key, value in req.header_items():
            environ["HTTP_" + key.upper().replace("-", "_")] = value
        status = {}
        out = b"".join(self.app(environ, lambda s, headers: status.setdefault("s", s)))
        code = int(status["s"].split()[0])
        if code >= 400:
            raise urllib.error.HTTPError(req.full_url, code, status["s"], {}, io.BytesIO(out))
        return Response(out)


class FakeProcesses(cl.Processes):
    """A process table: pid -> (creation time, runs the classic GUI)."""

    def __init__(self, table=None, own=(1, 2)):
        self.table = dict(table or {})
        self._own = set(own)

    def own(self):
        return set(self._own)

    def alive(self, pid):
        return pid in self.table

    def created(self, pid):
        return self.table[pid][0] if pid in self.table else None

    def runs_classic(self, pid):
        return pid in self.table and self.table[pid][1]


class FakePopen:
    def __init__(self, cmd, pid=4242, **kw):
        self.cmd, self.kw, self.pid = cmd, kw, pid
        self.returncode = None
        self._done = threading.Event()

    def wait(self):
        self._done.wait()
        return self.returncode

    def poll(self):
        return self.returncode if self._done.is_set() else None

    def exit(self, code=0):
        self.returncode = code
        self._done.set()


class FakeNative(cl.NativeOps):
    def __init__(self, log, line="place 10 20 800 1000"):
        self.log, self.line = log, line

    def place(self, pid, hwnd, size):
        self.log.append(("place", pid, hwnd, size))
        return self.line

    def before_raise(self, pid):
        self.log.append(("before_raise", pid))

    def raise_process(self, proc):
        self.log.append(("raise_process", proc.pid))


class Harness:
    """A ClassicWindow with a fake Popen whose child talks over the real channel (ControlClient through WsgiOpener)."""

    def __init__(self, tmp_path, *, ready=True, child_pid=None, exit_code=None, processes=None, **kw):
        self.log: list = []
        self.events: list = []
        self.closed: list = []
        self.popens: list[FakePopen] = []
        self.clients: list[ctl.ControlClient] = []
        self.received: list[str] = []
        self.ready, self.child_pid, self.exit_code = ready, child_pid, exit_code
        self.processes = processes or FakeProcesses({4242: (5242, True), 5555: (6555, True)})
        self.window = cl.ClassicWindow(
            tmp_path, origin="http://127.0.0.1:9", publish=lambda e, d=None: self.events.append((e, d)),
            native=FakeNative(self.log), command=lambda tab: system.classic_command(tab, control=True),
            popen=self.popen, processes=self.processes, on_closed=self.closed.append,
            **{"ready_timeout": 5.0, "poll_timeout": 0.2, **kw})

    def popen(self, cmd, **kw):
        p = FakePopen(cmd, **kw)
        self.popens.append(p)
        if self.exit_code is not None:
            p.exit(self.exit_code)
            return p
        client = ctl.ControlClient(kw["env"][cl.ENV_URL], kw["env"][cl.ENV_TOKEN],
                                   opener=WsgiOpener(self.window.wsgi), poll_timeout=5)
        self.clients.append(client)
        client.start()
        if self.ready:
            client.report("ready", pid=self.child_pid or p.pid, hwnd=77, exe="/apps/tool")
        return p

    def lines_until(self, last, timeout=5.0):
        def got():
            self.received.extend(self.clients[-1].lines())
            return last in self.received
        assert wait_for(got, timeout), self.received
        out, self.received = list(self.received), []
        return out

    def stop(self):
        for c in self.clients:
            c.stop()
        for p in self.popens:
            if p.poll() is None:
                p.exit(0)
        self.window.close()


@pytest.fixture
def system_tabs(monkeypatch):
    monkeypatch.setattr(system, "program_command", lambda: ["tool"])


# --- control lines ---


def test_the_control_line_parser():
    assert cl.parse_control("tab crc_tool") == ("tab", "crc_tool")
    assert cl.parse_control("settings") == ("settings",)
    assert cl.parse_control("place -1600 24 800 976") == ("place", -1600, 24, 800, 976)
    assert cl.parse_control("  raise ") == ("raise",)
    for junk in ("", "tab", "tab ../x", "tab Crc", "tab a b", "place 1 2 3", "place 1 2 0 5", "place a b c d",
                 "place 1.5 2 3 4", "raise now", "quit", None, 12, ["raise"]):
        assert cl.parse_control(junk) is None, junk
    assert list(cl.iter_lines(["raise", "junk", "tab tools"])) == [("raise",), ("tab", "tools")]
    assert cl.tab_line("settings") == "settings" and cl.tab_line("tools") == "tab tools"


def test_the_classic_command_line(system_tabs):
    assert system.classic_command() == ["tool", "--classic"]
    assert system.classic_command("crc_tool", control=True) == ["tool", "--classic", "--control", "--tab", "crc_tool"]
    assert system.classic_command("settings", control=True) == ["tool", "--classic", "--control", "--settings"]
    with pytest.raises(ServiceError) as e:
        system.classic_command("nope")
    assert e.value.code == "bad_params"


def test_the_child_takes_the_channel_out_of_its_environment():
    env = {cl.ENV_URL: "http://127.0.0.1:5/", cl.ENV_TOKEN: "tok", "PATH": "/bin"}
    assert ctl.take_channel(env) == ("http://127.0.0.1:5", "tok")
    assert env == {"PATH": "/bin"}
    env = {cl.ENV_URL: "http://127.0.0.1:5"}
    assert ctl.take_channel(env) is None and env == {}


# --- the child's side on a fake root ---


class FakeRoot:
    def __init__(self, mapped=False):
        self.calls: list = []
        self.after_calls: list = []
        self.binds: dict = {}
        self.mapped = mapped

    def after(self, ms, fn):
        self.after_calls.append((ms, fn))

    def bind(self, event, fn, add=None):
        self.binds[event] = fn

    def winfo_ismapped(self):
        return self.mapped

    def wm_frame(self):
        return "0x1a2b"

    def attributes(self, *args):
        self.calls.append(("attributes",) + args)

    def run_after(self, ms):
        due = [c for c in self.after_calls if c[0] == ms]
        self.after_calls = [c for c in self.after_calls if c[0] != ms]
        for _, fn in due:
            fn()


class FakeClient:
    def __init__(self):
        self.reports: list = []
        self.pending: list[str] = []
        self.started = False

    def start(self):
        self.started = True

    def lines(self):
        out, self.pending = self.pending, []
        return out

    def report(self, kind, **data):
        self.reports.append((kind, data))


class FakeApp:
    def __init__(self):
        self.tabs = SimpleNamespace(crc_tool="CRC", tools="TOOLS")
        self.calls: list = []

    def show_tab(self, tab):
        self.calls.append(("show_tab", tab))

    def open_settings_dialog(self):
        self.calls.append(("settings",))

    def place_window(self, *rect):
        self.calls.append(("place",) + rect)

    def raise_window(self):
        self.calls.append(("raise",))


def test_the_control_thread_and_queue_on_a_fake_root(monkeypatch):
    root, app, client, counter = FakeRoot(), FakeApp(), FakeClient(), ctl.BusyCounter()
    monkeypatch.setattr(ctl.sys, "platform", "win32")
    bridge = ctl.ControlBridge(root, app, client, counter=counter).start()
    assert client.started and "<Map>" in root.binds
    # ready once the root itself is mapped, with this process's pid and (Windows) the frame's handle
    root.binds["<Map>"](SimpleNamespace(widget=object()))
    assert client.reports == []
    root.binds["<Map>"](SimpleNamespace(widget=root))
    root.binds["<Map>"](SimpleNamespace(widget=root))
    assert client.reports == [("ready", {"pid": os.getpid(), "hwnd": 0x1a2b, "exe": sys.executable})]
    # lines are applied on the Tk thread, by the pump, in order; junk is ignored
    client.pending = ["place 5 6 700 800", "junk", "tab crc_tool", "raise"]
    root.run_after(ctl.PUMP_MS)
    assert app.calls == [("place", 5, 6, 700, 800), ("show_tab", "CRC"), ("raise",)]
    assert client.reports[-1] == ("shown", {"tab": "crc_tool"})
    assert any(ms == ctl.PUMP_MS for ms, _ in root.after_calls)  # the pump goes on
    # while a task runs, a tab is not switched; the busy count is reported
    app.calls.clear()
    counter.add(1)
    assert client.reports[-1] == ("busy", {"n": 1})
    client.pending = ["tab tools", "settings", "tab nope", "raise"]
    root.run_after(ctl.PUMP_MS)
    assert app.calls == [("raise",)]
    counter.add(-1)
    client.pending = ["settings"]
    root.run_after(ctl.PUMP_MS)
    root.run_after(0)
    assert app.calls[-1] == ("settings",) and client.reports[-1] == ("shown", {"tab": "settings"})
    assert bridge.raised


def test_the_child_shows_itself_when_no_raise_comes():
    root, client = FakeRoot(mapped=True), FakeClient()
    ctl.ControlBridge(root, FakeApp(), client, counter=ctl.BusyCounter()).start()
    root.run_after(0)  # mapped before the bridge started: ready all the same
    assert client.reports[0][0] == "ready"
    root.run_after(int(cl.SHOW_FALLBACK * 1000))
    assert ("attributes", "-alpha", 1.0) in root.calls


def test_a_raise_keeps_the_window_hidden_until_then():
    root, client, app = FakeRoot(), FakeClient(), FakeApp()
    bridge = ctl.ControlBridge(root, app, client, counter=ctl.BusyCounter()).start()
    root.binds["<Map>"](SimpleNamespace(widget=root))
    client.pending = ["raise"]
    root.run_after(ctl.PUMP_MS)
    root.run_after(int(cl.SHOW_FALLBACK * 1000))
    assert bridge.raised and ("attributes", "-alpha", 1.0) not in root.calls


# --- the raise and place helpers of the classic App ---


def test_the_app_places_and_raises_its_window(monkeypatch):
    from ba_modding_toolkit.gui import app as app_module

    calls = []
    monkeypatch.setattr(app_module, "_activate_this_app", lambda: calls.append("activate"))

    class Master:
        def geometry(self, g):
            calls.append(("geometry", g))

        def deiconify(self):
            calls.append("deiconify")

        def attributes(self, *a):
            calls.append(a)

        def lift(self):
            calls.append("lift")

        def after(self, ms, fn):
            calls.append(("after", ms))
            fn()

        def focus_force(self):
            calls.append("focus")

    fake = SimpleNamespace(master=Master())
    app_module.App.place_window(fake, -1600, 24, 800, 976)
    assert calls == [("geometry", "800x976+-1600+24")]
    calls.clear()
    app_module.App.raise_window(fake)
    expected = ["deiconify", ("-alpha", 1.0), "lift", ("-topmost", True)]
    if sys.platform == "darwin":
        expected.append("activate")
    assert calls == expected + [("after", 300), ("-topmost", False), "focus"]


# --- the busy counter ---


def test_the_busy_counter_around_run_in_thread_and_set_task_running(monkeypatch):
    import ttkbootstrap as tb

    from ba_modding_toolkit.gui.tabs import base_tab
    from ba_modding_toolkit.gui.windows import base as windows_base

    counter, seen = ctl.BusyCounter(), []
    counter.listen(seen.append)
    monkeypatch.setattr(base_tab, "busy", counter)
    monkeypatch.setattr(windows_base, "busy", counter)
    release, started = threading.Event(), threading.Event()

    def task(arg):
        assert arg == "x"
        started.set()
        release.wait(5)

    base_tab.TabFrame.run_in_thread(object(), task, "x")
    assert counter.value == 1  # counted before the thread runs
    assert started.wait(5)
    dialog = SimpleNamespace(_task_running=False)
    windows_base.StoppableDialog.set_task_running(dialog, True)
    windows_base.StoppableDialog.set_task_running(dialog, True)
    assert counter.value == 2
    release.set()
    assert wait_for(lambda: counter.value == 1)
    windows_base.StoppableDialog.set_task_running(dialog, False)
    windows_base.StoppableDialog.set_task_running(dialog, False)
    assert counter.value == 0 and seen == [1, 2, 1, 0]
    # a failing task is still counted down
    monkeypatch.setattr(threading, "excepthook", lambda args: None)
    base_tab.TabFrame.run_in_thread(object(), lambda: 1 / 0)
    assert wait_for(lambda: counter.value == 0)
    # a dialog closed while its task runs drops its count with it
    monkeypatch.setattr(tb.Toplevel, "destroy", lambda self: None, raising=False)
    closing = object.__new__(windows_base.StoppableDialog)
    closing._task_running = False
    windows_base.StoppableDialog.set_task_running(closing, True)
    assert counter.value == 1
    windows_base.StoppableDialog.destroy(closing)
    windows_base.StoppableDialog.set_task_running(closing, False)
    assert counter.value == 0


# --- placement maths ---


def test_the_window_is_centred_on_the_bamt_window():
    work = cl.Rect(0, 25, 2560, 1415)
    assert cl.centre_rect(cl.Rect(400, 100, 1600, 1200), work, (800, 1000)) == cl.Rect(800, 200, 800, 1000)


def test_the_window_is_kept_inside_the_work_area():
    work = cl.Rect(0, 25, 1920, 1055)
    # BAMT near the right edge: the classic window moves left to fit
    assert cl.centre_rect(cl.Rect(1700, 100, 400, 300), work, (800, 1000)) == cl.Rect(1120, 25, 800, 1000)
    # and near the top left
    assert cl.centre_rect(cl.Rect(-300, -200, 400, 300), work, (800, 600)) == cl.Rect(0, 25, 800, 600)


def test_a_window_taller_than_the_work_area_is_shrunk():
    work = cl.Rect(0, 0, 1440, 875)
    got = cl.centre_rect(cl.Rect(0, 0, 1440, 875), work, (800, 1000))
    assert got == cl.Rect(320, 0, 800, 875)


def test_the_macos_flip_uses_the_primary_screen():
    primary = cl.Rect(0, 0, 1440, 900)
    primary_visible = cl.Rect(0, 0, 1440, 875)  # the menu bar takes 25 points at the top
    # a second screen above the primary one (Cocoa: y up, so its origin y is the primary's height)
    above = cl.Rect(-240, 900, 1920, 1080)
    above_visible = cl.Rect(-240, 900, 1920, 1055)
    screens = [(primary, primary_visible), (above, above_visible)]
    bamt = cl.Rect(0, 1000, 1600, 900)  # on the screen above
    got = cl.mac_placement(bamt, screens)
    # Tk: the screen above spans y -1080 to 0, its visible frame -1055 to 0 (menu bar on top), BAMT -800 to 100
    assert cl.cocoa_to_tk(bamt, 900) == cl.Rect(0, -1000, 1600, 900)
    assert got == cl.Rect(400, -1055, 800, 1000)  # moved down onto that screen, below its menu bar
    # a second screen beside the primary one, BAMT on it
    beside = cl.Rect(1440, -180, 2560, 1440)
    beside_visible = cl.Rect(1440, -180, 2560, 1415)
    bamt = cl.Rect(1800, 200, 1600, 900)
    got = cl.mac_placement(bamt, [(primary, primary_visible), (beside, beside_visible)])
    tk_bamt = cl.cocoa_to_tk(bamt, 900)
    assert tk_bamt == cl.Rect(1800, -200, 1600, 900)
    outer_h = 1000 + cl.MAC_TITLE_BAR
    assert got == cl.Rect(2200, round(-200 + (900 - outer_h) / 2), 800, 1000)
    # on the primary screen: below the menu bar, shrunk to its visible height
    got = cl.mac_placement(cl.Rect(0, 0, 1440, 875), [(primary, primary_visible)])
    assert got == cl.Rect(320, 25, 800, 875 - cl.MAC_TITLE_BAR)


@pytest.mark.parametrize("dpi, size", [(96, (800, 1000)), (144, (1200, 1500)), (192, (1600, 2000))])
def test_windows_scales_the_logical_size_by_the_monitor_dpi(dpi, size):
    work = cl.Rect(0, 0, 3840, 2100)  # rcWork in physical pixels
    bamt = cl.Rect(500, 100, 2400, 1350)
    got = cl.win_placement(bamt, work, dpi)
    w, h = min(size[0], work.w), min(size[1], work.h)
    assert (got.w, got.h) == (w, h)
    assert got.x == 500 + (2400 - w) // 2
    assert got.y == max(0, min(100 + (1350 - h) // 2, work.h - h))
    # a smaller monitor: clamped to its work area after scaling
    small = cl.win_placement(cl.Rect(0, 0, 1920, 1040), cl.Rect(0, 0, 1920, 1040), dpi)
    assert small.h == min(size[1], 1040) and small.y == (1040 - small.h) // 2


def test_the_screen_holding_the_centre_or_the_nearest():
    a = (cl.Rect(0, 0, 100, 100), cl.Rect(0, 10, 100, 90))
    b = (cl.Rect(100, 0, 100, 100), cl.Rect(100, 0, 100, 100))
    assert cl.screen_for((150, 50), [a, b]) == b[1]
    assert cl.screen_for((-50, 50), [a, b]) == a[1]
    assert cl.screen_for((500, 50), [a, b]) == b[1]


# --- classic.json and find_classic ---


def write(tmp_path, data):
    (tmp_path / cl.CLASSIC_JSON).write_text(json.dumps(data), encoding="utf-8")


def test_find_classic_takes_a_live_classic_window(tmp_path):
    write(tmp_path, {"pid": 700, "exe": "tool", "hwnd": 0, "created": 1760000000})
    procs = FakeProcesses({700: (1760000000, True)})
    assert cl.find_classic(tmp_path, procs) == cl.ClassicProcess(700, "tool", 0, 1760000000)
    assert (tmp_path / cl.CLASSIC_JSON).exists()


@pytest.mark.parametrize("data, table, own", [
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": 1}, {}, ()),  # dead
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": 1}, {700: (2, True)}, ()),  # a reused pid: a later start
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": 1}, {700: (1, False)}, ()),  # another program
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": 1}, {700: (1, True)}, (700,)),  # this process
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": 1}, {700: (1, True)}, (1, 700)),  # its parent
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": "1"}, {700: (1, True)}, ()),  # created as text
    ({"pid": 700, "exe": "t", "hwnd": 0, "created": True}, {700: (1, True)}, ()),
    ({"pid": 0, "exe": "t", "hwnd": 0, "created": 1}, {0: (1, True)}, ()),
    ("not json", {}, ()),
])
def test_a_stale_classic_json_is_removed_and_refuses_nothing(tmp_path, data, table, own):
    if isinstance(data, str):
        (tmp_path / cl.CLASSIC_JSON).write_text(data)
    else:
        write(tmp_path, data)
    procs = FakeProcesses(table, own=own or (1, 2))
    assert cl.find_classic(tmp_path, procs) is None
    assert not (tmp_path / cl.CLASSIC_JSON).exists()
    window = cl.ClassicWindow(tmp_path, origin="http://127.0.0.1:9", processes=procs)
    assert not window.is_open() and window.status()["open"] is False


def test_the_creation_time_is_compared_exactly_as_a_number(tmp_path):
    write(tmp_path, {"pid": 700, "exe": "t", "hwnd": 0, "created": 133000000000000001})
    assert cl.find_classic(tmp_path, FakeProcesses({700: (133000000000000001, True)})) is not None
    assert cl.find_classic(tmp_path, FakeProcesses({700: (133000000000000002, True)})) is None


def test_remove_classic_json_only_for_its_own_pid(tmp_path):
    write(tmp_path, {"pid": 700, "exe": "t", "hwnd": 0, "created": 1})
    cl.remove_classic_json(tmp_path, 701)
    assert (tmp_path / cl.CLASSIC_JSON).exists()
    cl.remove_classic_json(tmp_path, 700)
    assert not (tmp_path / cl.CLASSIC_JSON).exists()
    cl.remove_classic_json(tmp_path, 700)  # gone already: no error


# --- the macOS creation time ---


LSTART = "Mon Oct 19 10:23:45 2026\n"
STARTED = calendar.timegm((2026, 10, 19, 10, 23, 45, 0, 0, 0))


def test_the_macos_creation_time_from_proc_pidinfo():
    def pidinfo(pid, flavor, arg, ref, size):
        assert (pid, flavor, arg, size) == (321, cl.PROC_PIDTBSDINFO, 0, 136)
        ref._obj.pbi_start_tvsec = STARTED
        return size

    assert cl.mac_created(321, pidinfo=pidinfo, run=lambda *a, **k: pytest.fail("ps must not run")) == STARTED


def failing_pidinfo(*args):
    raise OSError("libproc cannot be loaded")


def ps_runner(seen):
    def run(cmd, **kw):
        seen.append((cmd, kw["env"]))
        return SimpleNamespace(returncode=0, stdout=LSTART)
    return run


def test_the_ps_fallback_runs_in_the_c_locale_and_utc(monkeypatch):
    monkeypatch.setenv("LANG", "ja_JP.UTF-8")
    monkeypatch.setenv("LC_ALL", "de_DE.UTF-8")
    monkeypatch.setenv("TZ", "Asia/Tokyo")
    seen = []
    assert cl.mac_created(77, pidinfo=failing_pidinfo, run=ps_runner(seen)) == STARTED
    (cmd, env), = seen
    assert cmd == ["ps", "-o", "lstart=", "-p", "77"]
    assert env["LC_ALL"] == "C" and env["TZ"] == "UTC0"
    assert os.environ["TZ"] == "Asia/Tokyo"  # the caller's own environment is left alone
    # a call that fails or prints nothing usable gives no time
    assert cl.mac_created(77, pidinfo=failing_pidinfo,
                          run=lambda *a, **k: SimpleNamespace(returncode=1, stdout="")) is None
    assert cl.mac_created(77, pidinfo=lambda *a: 0,
                          run=lambda *a, **k: SimpleNamespace(returncode=0, stdout="19 Okt 2026\n")) is None


def test_a_classic_json_written_under_one_locale_is_read_under_another(tmp_path, monkeypatch):
    def pidinfo(pid, flavor, arg, ref, size):
        ref._obj.pbi_start_tvsec = STARTED
        return size

    class MacProcesses(FakeProcesses):
        def __init__(self, created):
            super().__init__({900: (None, True)})
            self._created = created

        def created(self, pid):
            return self._created(pid)

    monkeypatch.setenv("LANG", "zh_CN.UTF-8")
    monkeypatch.setenv("TZ", "Asia/Shanghai")
    writer = MacProcesses(lambda pid: cl.mac_created(pid, pidinfo=pidinfo))
    created = writer.created(900)
    cl.write_classic_json(tmp_path, cl.ClassicProcess(900, "tool", 0, created))
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    reader = MacProcesses(lambda pid: cl.mac_created(pid, pidinfo=failing_pidinfo, run=ps_runner([])))
    assert cl.find_classic(tmp_path, reader) == cl.ClassicProcess(900, "tool", 0, STARTED)


def test_the_lstart_parse_never_reads_the_locale(monkeypatch):
    def no_strptime(*args):
        raise AssertionError("strptime reads LC_TIME")

    monkeypatch.setattr(time, "strptime", no_strptime)
    assert cl.parse_lstart(LSTART) == STARTED
    assert cl.parse_lstart("Mon Oct  5 01:02:03 2026") == calendar.timegm((2026, 10, 5, 1, 2, 3, 0, 0, 0))
    saved = locale.setlocale(locale.LC_TIME)
    try:
        for name in ("de_DE.UTF-8", "fr_FR.UTF-8", "ja_JP.UTF-8", "zh_CN.UTF-8"):
            try:
                locale.setlocale(locale.LC_TIME, name)
            except locale.Error:
                continue
            assert cl.parse_lstart(LSTART) == STARTED, name
    finally:
        locale.setlocale(locale.LC_TIME, saved)
    for junk in ("", "Lun Oct 19 10:23:45 2026", "Mon Okt 19 10:23:45 2026", "Mon Oct 19 10:23 2026",
                 "Mon Oct 19 10:23:45"):
        assert cl.parse_lstart(junk) is None, junk


def test_this_systems_process_table_reads_this_process():
    procs = cl.Processes()
    assert procs.alive(os.getpid()) and not procs.alive(0)
    assert os.getpid() in procs.own() and os.getppid() in procs.own()
    if sys.platform in ("darwin", "linux", "win32"):
        assert isinstance(procs.created(os.getpid()), int)


# --- the classic window, with a fake child on the channel ---


def test_ready_place_raise_and_classic_json(tmp_path, system_tabs):
    h = Harness(tmp_path)
    try:
        assert h.window.open("crc_tool") == {"started": True}
        popen = h.popens[0]
        assert popen.cmd == ["tool", "--classic", "--control", "--tab", "crc_tool"]
        env = popen.kw["env"]
        assert env[cl.ENV_URL] == "http://127.0.0.1:9" and env["PYTHONIOENCODING"] == "utf-8"
        assert len(env[cl.ENV_TOKEN]) >= 24 and cl.ENV_TOKEN not in os.environ
        assert popen.kw["stderr"] is subprocess.STDOUT and popen.kw["stdin"] is subprocess.DEVNULL
        # placed, then the foreground handed over, then raised
        assert h.log == [("place", 4242, 77, cl.CLASSIC_SIZE), ("before_raise", 4242)]
        assert h.lines_until("raise") == ["place 10 20 800 1000", "raise"]
        assert [e for e, _ in h.events][:2] == ["classic.opened", "classic.ready"]
        assert h.events[1][1] == {"pid": 4242, "tab": "crc_tool"}
        saved = json.loads((tmp_path / cl.CLASSIC_JSON).read_text())
        assert saved == {"pid": 4242, "exe": "/apps/tool", "hwnd": 77, "created": 5242}
        assert h.window.is_open() and h.window.orphan() is None  # its own child is no orphan
        assert h.window.status() == {"open": True, "ready": True, "busy": False, "pid": 4242, "orphan": False}
        # the child exits: classic.closed, classic.json removed, the close hook runs
        popen.exit(0)
        assert wait_for(lambda: h.closed == [0])
        assert ("classic.closed", {"code": 0}) in h.events
        assert not (tmp_path / cl.CLASSIC_JSON).exists()
        assert not h.window.is_open()
    finally:
        h.stop()


def test_a_second_open_sends_the_tab_and_a_raise(tmp_path, system_tabs):
    h = Harness(tmp_path)
    try:
        h.window.open("crc_tool")
        h.lines_until("raise")
        assert h.window.open("tools") == {"started": False}
        assert len(h.popens) == 1
        assert h.lines_until("raise") == ["tab tools", "raise"]
        assert h.window.open("settings") == {"started": False}
        assert h.lines_until("raise") == ["settings", "raise"]
        # the child shows the tab: classic.ready with it
        h.clients[0].report("shown", tab="tools")
        assert wait_for(lambda: ("classic.ready", {"pid": 4242, "tab": "tools"}) in h.events)
        # while a classic task runs, the tab is dropped and the window only raised
        h.clients[0].report("busy", n=1)
        assert wait_for(lambda: h.window.status()["busy"])
        assert h.window.open("mod_install") == {"started": False}
        assert h.lines_until("raise") == ["raise"]
        assert h.window.bring_to_front()
        assert h.lines_until("raise") == ["raise"]
    finally:
        h.stop()


def test_an_exit_before_ready_gives_classic_failed(tmp_path, system_tabs):
    h = Harness(tmp_path, exit_code=3)
    try:
        with pytest.raises(ServiceError) as e:
            h.window.open("tools")
        assert e.value.code == "classic_failed" and e.value.params == {"exit_code": 3}
        assert wait_for(lambda: h.closed == [3])
        assert not h.window.is_open()
    finally:
        h.stop()


def test_no_ready_in_time_gives_classic_failed(tmp_path, system_tabs):
    h = Harness(tmp_path, ready=False, ready_timeout=0.3)
    try:
        with pytest.raises(ServiceError) as e:
            h.window.open("tools")
        assert e.value.code == "classic_failed" and e.value.params == {"exit_code": None}
        # still open: a late ready is taken, and the window shows itself
        assert h.window.is_open()
        h.clients[0].report("ready", pid=4242, hwnd=0, exe="tool")
        assert wait_for(lambda: h.window.status()["ready"])
        h.window.open("crc_tool")
        assert h.lines_until("raise") == ["tab crc_tool", "raise"]
    finally:
        h.stop()


def test_a_start_that_fails_gives_classic_failed(tmp_path, system_tabs):
    def popen(cmd, **kw):
        raise OSError("no such file")

    window = cl.ClassicWindow(tmp_path, origin="http://127.0.0.1:9", popen=popen, processes=FakeProcesses())
    with pytest.raises(ServiceError) as e:
        window.open()
    assert e.value.code == "classic_failed"
    with pytest.raises(ServiceError) as e:
        window.open("../x")
    assert e.value.code == "bad_params"


def test_a_window_left_by_an_earlier_instance_is_raised_not_started(tmp_path, system_tabs):
    write(tmp_path, {"pid": 800, "exe": "tool", "hwnd": 99, "created": 1800})
    h = Harness(tmp_path, processes=FakeProcesses({800: (1800, True)}))
    try:
        assert h.window.is_open() and h.window.orphan() == cl.ClassicProcess(800, "tool", 99, 1800)
        assert h.window.status() == {"open": True, "ready": True, "busy": False, "pid": 800, "orphan": True}
        assert h.window.open("tools") == {"started": False}
        assert h.popens == [] and h.log == [("raise_process", 800)]
        assert h.window.bring_to_front() and h.log[-1] == ("raise_process", 800)
        # once it ends, the next open starts a window of this instance
        del h.processes.table[800]
        h.processes.table[4242] = (5242, True)
        assert not h.window.is_open() and not (tmp_path / cl.CLASSIC_JSON).exists()
        assert h.window.open("tools") == {"started": True}
    finally:
        h.stop()


def test_the_channel_takes_only_the_childs_token(tmp_path, system_tabs):
    h = Harness(tmp_path)
    try:
        h.window.open()
        status = {}

        def call(path, method="GET", token="wrong", body=b""):
            environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "HTTP_X_BAMT_CLASSIC": token,
                       "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body)}
            out = b"".join(h.window.wsgi(environ, lambda s, hd: status.update(s=s)))
            return status["s"], json.loads(out)

        token = h.popens[0].kw["env"][cl.ENV_TOKEN]
        assert call(cl.CONTROL_PATH)[0] == "403 Forbidden"
        assert call(cl.CONTROL_PATH, token="")[0] == "403 Forbidden"
        assert call(cl.REPORT_PATH, "POST", body=b'{"type":"busy","n":1}')[0] == "403 Forbidden"
        assert call(cl.CONTROL_PATH, "POST", token=token)[0] == "405 Method Not Allowed"
        assert call("/api/classic/other", token=token)[0] == "404 Not Found"
        assert call(cl.REPORT_PATH, "POST", token=token, body=b"{nope")[0] == "400 Bad Request"
        assert call(cl.REPORT_PATH, "POST", token=token, body=b'{"type":"quit"}')[0] == "400 Bad Request"
        assert call(cl.REPORT_PATH, "POST", token=token, body=b'{"type":"busy","n":"1"}')[0] == "400 Bad Request"
        assert call(cl.REPORT_PATH, "POST", token=token, body=b'{"type":"busy","n":2}') == ("200 OK", {})
        assert h.window.status()["busy"]
    finally:
        h.stop()


def test_a_launcher_that_returns_early_is_followed_by_the_reported_pid(tmp_path, system_tabs):
    h = Harness(tmp_path, child_pid=5555, watch_interval=0.02)
    try:
        h.window.open()
        h.lines_until("raise")
        assert json.loads((tmp_path / cl.CLASSIC_JSON).read_text())["pid"] == 5555
        h.popens[0].exit(0)  # the onefile launcher returns, the window it unpacked runs on
        time.sleep(0.2)
        assert h.closed == [] and h.window.is_open()
        del h.processes.table[5555]
        assert wait_for(lambda: h.closed == [0])
        assert not (tmp_path / cl.CLASSIC_JSON).exists()
    finally:
        h.stop()


def test_a_child_that_stops_polling_counts_as_closed(tmp_path, system_tabs):
    h = Harness(tmp_path, child_pid=5555, watch_interval=0.02, silent_exit=0.3)
    try:
        h.window.open()
        h.lines_until("raise")
        h.clients[0].stop()
        h.popens[0].exit(0)
        assert wait_for(lambda: h.closed == [0], timeout=3)
    finally:
        h.stop()


def test_closing_the_web_ui_ends_the_long_polls(tmp_path, system_tabs):
    h = Harness(tmp_path, poll_timeout=30)
    try:
        h.window.open()
        h.lines_until("raise")
        token = h.popens[0].kw["env"][cl.ENV_TOKEN]
        got = []
        t = threading.Thread(target=lambda: got.append(h.window.control(token)))
        t.start()
        time.sleep(0.1)
        h.window.close()
        t.join(2)
        assert not t.is_alive() and got == [None]  # refused, so the child stops polling
        assert h.window.control(token) is None
    finally:
        h.stop()


def free_loopback():
    try:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen()
        return True
    except OSError:
        return False


@pytest.mark.skipif(not free_loopback(), reason="no loopback server here")
def test_a_real_child_that_prints_during_import_keeps_the_channel(tmp_path, monkeypatch):
    """A real process on a real HTTP server: its prints (Chinese among them, as the classic GUI's) go to classic.log,
    the channel carries ready, place and raise, and classic.json names it for another instance."""
    from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server
    import socketserver

    class Server(socketserver.ThreadingMixIn, WSGIServer):
        daemon_threads = True

    class Quiet(WSGIRequestHandler):
        def log_message(self, *args):
            pass

    script = "\n".join([
        "import os, sys, time",
        "print('noise ' * 5000)",
        "print('\\u5df2\\u542f\\u52a8', flush=True)",
        "from ba_modding_toolkit.gui.control import ControlClient, take_channel",
        "url, token = take_channel()",
        "assert 'BAMT_CLASSIC_TOKEN' not in os.environ",
        "c = ControlClient(url, token).start()",
        "c.report('ready', pid=os.getpid(), hwnd=0, exe=sys.executable)",
        "got = []",
        "deadline = time.time() + 20",
        "while time.time() < deadline and 'tab tools' not in got:",
        "    got += c.lines()",
        "    time.sleep(0.02)",
        "print('lines', got, flush=True)",
        "sys.exit(0 if got[:3] == ['place 10 20 800 1000', 'raise', 'tab tools'] else 5)",
    ])
    events, closed = [], []
    holder = {}
    window = cl.ClassicWindow(
        tmp_path, origin=lambda: f"http://127.0.0.1:{holder['port']}", publish=lambda e, d=None: events.append(e),
        native=FakeNative([]), command=lambda tab: [sys.executable, "-c", script, "--classic"],
        on_closed=closed.append, poll_timeout=2)
    httpd = make_server("127.0.0.1", 0, window.wsgi, server_class=Server, handler_class=Quiet)
    holder["port"] = httpd.server_port
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        src = str(Path(cl.__file__).parents[2])
        monkeypatch.setenv("PYTHONPATH", os.pathsep.join(filter(None, [src, os.environ.get("PYTHONPATH")])))
        assert window.open() == {"started": True}
        pid = window.status()["pid"]
        # another instance of this data directory sees it (the real process table)
        assert cl.find_classic(tmp_path) is not None
        assert cl.find_classic(tmp_path).pid == pid
        assert window.open("tools") == {"started": False}
        assert wait_for(lambda: closed, timeout=20)
        assert closed == [0], (tmp_path / cl.CLASSIC_LOG).read_text("utf-8")
        log = (tmp_path / cl.CLASSIC_LOG).read_text("utf-8")
        assert "noise noise" in log and "\u5df2\u542f\u52a8" in log  # the classic GUI's own startup line
        assert events[:2] == ["classic.opened", "classic.ready"] and events[-1] == "classic.closed"
        assert not (tmp_path / cl.CLASSIC_JSON).exists()
    finally:
        httpd.shutdown()
        httpd.server_close()
        window.close()


def test_native_ops_without_a_window_do_nothing():
    ops = cl.native_ops(None)
    assert type(ops) is cl.NativeOps
    assert ops.place(1, 0, cl.CLASSIC_SIZE) is None
    ops.before_raise(1)
    ops.raise_process(cl.ClassicProcess(1, "", 0, 0))


# --- the queue ---


A, B = "/games/global", "/games/japan"
PINS = {A: ("pin", A, 1), B: ("pin", B, 1)}


class Host:
    def __init__(self, intent=True, pins=None, current=A):
        self._intent, self._pins, self._current = intent, dict(pins or PINS), current
        self.submitted: list = []

    def intent(self):
        return self._intent

    def pins(self):
        return self._pins

    def current(self):
        return self._current

    def submit(self, method, params):
        if params.get("fail"):
            raise ServiceError("busy")
        self.submitted.append((method, params))
        return f"j{len(self.submitted)}"


def toggle(enabled, expect, pins=PINS):
    return cl.QueuedCall("mods.toggle", {"enabled": enabled, "expect": expect}, pins=dict(pins))


def files_of(*paths):
    return cl.stat_files(str(p) for p in paths)


def apply_call(entry, path, source="mod:1"):
    return cl.QueuedCall("actions.apply", {"variant": entry[1], "source": source, "kind": "spr"}, entries=(entry,),
                         pins={entry[0]: PINS[entry[0]]}, files={entry: files_of(path)}, current=True)


def test_one_toggle_queued_at_most():
    q = cl.ClassicQueue()
    assert q.add(toggle(False, True), intent=True) == 1
    assert q.add(toggle(False, True), intent=True) == 1  # a later toggle replaces the queued one
    assert q.add(toggle(True, False), intent=True) == 0  # back to the stored intent: nothing left to do
    assert len(q) == 0
    with pytest.raises(ServiceError):
        q.add(cl.QueuedCall("app.installUpdate", {}))


def test_a_queued_toggle_runs_after_the_close_and_a_stale_one_is_dropped():
    q = cl.ClassicQueue()
    q.add(toggle(False, True), intent=True)
    host = Host(intent=True)
    run = q.run(host)
    assert host.submitted == [("mods.toggle", {"enabled": False, "expect": True})]
    assert run.to_json()["submitted"][0]["job"] == "j1" and len(q) == 0
    # switched elsewhere meanwhile: state_changed
    q.add(toggle(False, True), intent=True)
    run = q.run(Host(intent=False))
    assert [d.code for d in run.dropped] == ["state_changed"] and run.submitted == []
    # the known installs changed: folder_changed
    q.add(toggle(False, True), intent=True)
    run = q.run(Host(intent=True, pins={A: PINS[A]}))
    assert [d.code for d in run.dropped] == ["folder_changed"]
    assert run.to_json()["dropped"][0]["error"] == {"code": "folder_changed", "params": {}}


def test_an_empty_queue_does_nothing():
    host = Host()
    run = cl.ClassicQueue().run(host)
    assert host.submitted == [] and run.submitted == [] and run.dropped == []


def test_the_latest_action_for_an_entry_wins(tmp_path):
    f = tmp_path / "a.bundle"
    f.write_bytes(b"x")
    q = cl.ClassicQueue()
    entry = (A, "hoshino_spr")
    q.add(apply_call(entry, f, "mod:1"))
    q.add(toggle(False, True), intent=True)
    restore = cl.QueuedCall("actions.restore", {"variant": "hoshino", "kind": "spr"}, entries=(entry,),
                            pins={A: PINS[A]}, files={entry: files_of(f)}, current=True)
    assert q.add(restore) == 2
    assert [i.method for i in q.items()] == ["mods.toggle", "actions.restore"]  # in order
    host = Host()
    run = q.run(host)
    assert [m for m, _ in host.submitted] == ["mods.toggle", "actions.restore"] and not run.dropped


def test_a_drift_action_is_narrowed_by_a_later_action_on_one_of_its_entries(tmp_path):
    f1, f2 = tmp_path / "1.bundle", tmp_path / "2.bundle"
    f1.write_bytes(b"1")
    f2.write_bytes(b"2")
    e1, e2 = (A, "a_home"), (B, "b_home")
    drift = cl.QueuedCall("mods.restoreDrift", {"entries": [{"install": A, "core": "a_home"},
                                                            {"install": B, "core": "b_home"}]},
                          entries=(e1, e2), pins=dict(PINS), files={e1: files_of(f1), e2: files_of(f2)})
    q = cl.ClassicQueue()
    q.add(drift)
    q.add(apply_call(e1, f1))
    items = q.items()
    assert [i.method for i in items] == ["mods.restoreDrift", "actions.apply"]
    assert items[0].entries == (e2,) and items[0].params["entries"] == [{"install": B, "core": "b_home"}]
    assert list(items[0].pins) == [B]
    assert q.add(cl.QueuedCall("actions.restore", {"variant": "b", "kind": "lobby"}, entries=(e2,),
                               pins={B: PINS[B]}, files={e2: files_of(f2)})) == 2
    assert [i.method for i in q.items()] == ["actions.apply", "actions.restore"]


def test_an_entry_whose_files_changed_is_dropped(tmp_path):
    f1, f2 = tmp_path / "1.bundle", tmp_path / "2.bundle"
    f1.write_bytes(b"1")
    f2.write_bytes(b"2")
    e1, e2 = (A, "a_home"), (A, "c_home")
    drift = cl.QueuedCall("mods.restoreDrift", {"entries": ["e1", "e2"]}, entries=(e1, e2), pins={A: PINS[A]},
                          files={e1: files_of(f1), e2: files_of(f2)})
    q = cl.ClassicQueue()
    q.add(drift)
    f2.write_bytes(b"changed by the classic window")
    host = Host()
    run = q.run(host)
    assert host.submitted == [("mods.restoreDrift", {"entries": ["e1"]})]
    assert [(d.code, d.call.entries) for d in run.dropped] == [("entry_changed", (e2,))]
    # a removed file counts as changed too
    q.add(drift)
    f1.unlink()
    run = q.run(Host())
    assert sorted(d.code for d in run.dropped) == ["entry_changed", "entry_changed"]


def test_a_queued_apply_survives_a_change_to_the_other_install(tmp_path):
    f = tmp_path / "a.bundle"
    f.write_bytes(b"x")
    q = cl.ClassicQueue()
    q.add(apply_call((A, "hoshino_spr"), f))
    host = Host(pins={A: PINS[A], B: ("pin", B, 2)})  # the Japan folder changed
    run = q.run(host)
    assert [m for m, _ in host.submitted] == ["actions.apply"] and not run.dropped
    # its own install changed, or is no longer the current one: folder_changed
    for host in (Host(pins={A: ("pin", A, 2), B: PINS[B]}), Host(current=B), Host(pins={B: PINS[B]})):
        q.add(apply_call((A, "hoshino_spr"), f))
        run = q.run(host)
        assert [d.code for d in run.dropped] == ["folder_changed"] and host.submitted == []


def test_a_refused_submit_is_listed_and_quitting_drops_the_queue(tmp_path):
    f = tmp_path / "a.bundle"
    f.write_bytes(b"x")
    q = cl.ClassicQueue()
    call = apply_call((A, "hoshino_spr"), f)
    q.add(cl.QueuedCall(call.method, {**call.params, "fail": True}, call.entries, call.pins, call.files, True))
    run = q.run(Host())
    assert [(d.code, d.call.method) for d in run.dropped] == [("busy", "actions.apply")]
    q.add(toggle(False, True), intent=True)
    q.add(call)
    assert q.clear() == 2 and len(q) == 0
