"""The classic Tk GUI as a window of the web UI (see docs/web-ui.md, "Classic window").

- ``ClassicWindow`` starts the classic GUI (``--classic --control``) in its own process, talks to it over the web UI's
  own HTTP server (``GET /api/classic/control``, ``POST /api/classic/report``, with a one-time token), places it over
  the BAMT window, raises it and publishes ``classic.opened``, ``classic.ready`` and ``classic.closed``.
- ``classic.json`` in the data directory names a running classic window, so an instance started later still sees it
  (``find_classic``): the window outlives the instance that started it.

Standard library only, and nothing of Tk or pywebview at import: the classic child imports the control protocol from
here (``gui/control.py``).
"""

from __future__ import annotations

import calendar
import ctypes
import functools
import hmac
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Sequence

from ..errors import ServiceError
from .system import CREATE_NO_WINDOW, check_classic_tab, classic_command

logger = logging.getLogger(__name__)

# --- protocol ---

ENV_URL = "BAMT_CLASSIC_URL"  # the web UI's origin, http://127.0.0.1:<port>
ENV_TOKEN = "BAMT_CLASSIC_TOKEN"  # one-time, valid only for /api/classic/*
TOKEN_HEADER = "X-BAMT-Classic"
CONTROL_PATH = "/api/classic/control"
REPORT_PATH = "/api/classic/report"

CONTROL_POLL = 25.0  # seconds a control long-poll waits for a line
READY_TIMEOUT = 30.0  # a cold onefile start (unpacking, a virus scan) can take more than 15 s on Windows
SILENT_EXIT = 60.0  # a child whose launcher returned early: no poll for this long counts as its exit
SHOW_FALLBACK = 5.0  # the child shows itself when no raise came this long after ready
CLASSIC_SIZE = (800, 1000)  # gui/app.py setup_main_window, logical pixels
MAC_TITLE_BAR = 28  # points above the content of a titled NSWindow
MAX_REPORT = 64 * 1024

CLASSIC_JSON = "classic.json"
CLASSIC_LOG = "classic.log"

_TAB_NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")


def tab_line(tab: str) -> str:
    """The control line that shows a tab (``"settings"`` opens the classic settings)."""
    return "settings" if tab == "settings" else f"tab {tab}"


def place_line(rect: "Rect") -> str:
    r = rect.rounded()
    return f"place {int(r.x)} {int(r.y)} {int(r.w)} {int(r.h)}"


def parse_control(line: Any) -> tuple | None:
    """A control line as a command tuple: ``("tab", name)``, ``("settings",)``, ``("place", x, y, w, h)`` or
    ``("raise",)``; ``None`` for anything else, which the child ignores."""
    if not isinstance(line, str):
        return None
    parts = line.split()
    if parts == ["raise"]:
        return ("raise",)
    if parts == ["settings"]:
        return ("settings",)
    if len(parts) == 2 and parts[0] == "tab" and _TAB_NAME.fullmatch(parts[1]):
        return ("tab", parts[1])
    if len(parts) == 5 and parts[0] == "place":
        try:
            x, y, w, h = (int(p) for p in parts[1:])
        except ValueError:
            return None
        if w > 0 and h > 0:
            return ("place", x, y, w, h)
    return None


def iter_lines(lines: Iterable[Any]) -> Iterator[tuple]:
    """The commands of a batch of control lines, junk left out."""
    for line in lines:
        cmd = parse_control(line)
        if cmd is None:
            logger.debug("ignoring control line %r", line)
            continue
        yield cmd


# --- placement maths ---


@dataclass(frozen=True)
class Rect:
    """A rectangle with its origin at the top left (Tk's and Win32's coordinates), unless a caller says otherwise."""
    x: float
    y: float
    w: float
    h: float

    @property
    def centre(self) -> tuple[float, float]:
        return (self.x + self.w / 2, self.y + self.h / 2)

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px < self.x + self.w and self.y <= py < self.y + self.h

    def rounded(self) -> "Rect":
        return Rect(round(self.x), round(self.y), round(self.w), round(self.h))


def centre_rect(parent: Rect, work: Rect, size: tuple[float, float]) -> Rect:
    """A window of ``size`` centred on ``parent``, shrunk to fit ``work`` (the screen's work area) and moved inside it."""
    w, h = min(size[0], work.w), min(size[1], work.h)
    x = parent.x + (parent.w - w) / 2
    y = parent.y + (parent.h - h) / 2
    x = min(max(x, work.x), work.x + work.w - w)
    y = min(max(y, work.y), work.y + work.h - h)
    return Rect(x, y, w, h).rounded()


def screen_for(point: tuple[float, float], screens: Sequence[tuple[Rect, Rect]]) -> Rect:
    """The work area of the screen (``(frame, work area)`` pairs) that holds ``point``, else of the nearest one."""
    for frame, work in screens:
        if frame.contains(*point):
            return work

    def distance(frame: Rect) -> float:
        dx = max(frame.x - point[0], 0, point[0] - (frame.x + frame.w))
        dy = max(frame.y - point[1], 0, point[1] - (frame.y + frame.h))
        return dx * dx + dy * dy

    return min(screens, key=lambda s: distance(s[0]))[1]


def cocoa_to_tk(rect: Rect, primary_height: float) -> Rect:
    """A Cocoa rectangle (origin at the bottom left of the primary screen, y up) in Tk's coordinates (top left of the
    primary screen, y down). The primary screen is ``NSScreen.screens()[0]``, not the window's own screen."""
    return Rect(rect.x, primary_height - (rect.y + rect.h), rect.w, rect.h)


def mac_placement(window: Rect, screens: Sequence[tuple[Rect, Rect]], size: tuple[int, int] = CLASSIC_SIZE,
                  title_bar: int = MAC_TITLE_BAR) -> Rect:
    """Where the classic window goes on macOS, in Tk's coordinates: ``window`` is the BAMT window's frame and
    ``screens`` each screen's frame and visible frame, all in Cocoa coordinates, the primary screen first. The result's
    position is the frame's top left and its size the content's (``wm geometry``); the title bar fits on the screen."""
    primary = screens[0][0].h
    frame = cocoa_to_tk(window, primary)
    work = screen_for(frame.centre, [(cocoa_to_tk(f, primary), cocoa_to_tk(v, primary)) for f, v in screens])
    outer = centre_rect(frame, work, (size[0], size[1] + title_bar))
    return Rect(outer.x, outer.y, outer.w, outer.h - title_bar)


def win_placement(window: Rect, work: Rect, dpi: int, size: tuple[int, int] = CLASSIC_SIZE) -> Rect:
    """Where the classic window goes on Windows, in physical pixels: ``window`` is the BAMT window's bounds and
    ``work`` the work area of its monitor (``rcWork``), both physical, as pywebview makes the web UI DPI aware. The Tk
    child is not DPI aware, so its logical ``size`` is scaled by the monitor's DPI before it is fitted."""
    scale = (dpi or 96) / 96
    return centre_rect(window, work, (round(size[0] * scale), round(size[1] * scale)))


# --- processes and classic.json ---


@dataclass(frozen=True)
class ClassicProcess:
    """A classic window as ``classic.json`` names it. ``created`` is the creation time the system reports, as an
    integer (Windows: FILETIME in 100 ns units; macOS: whole seconds since the epoch; Linux: clock ticks since boot)."""
    pid: int
    exe: str
    hwnd: int
    created: int

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: Any) -> "ClassicProcess | None":
        if not isinstance(data, dict):
            return None
        pid, exe, hwnd, created = data.get("pid"), data.get("exe", ""), data.get("hwnd", 0), data.get("created")

        def is_int(v: Any) -> bool:
            return isinstance(v, int) and not isinstance(v, bool)

        if not (is_int(pid) and pid > 0 and is_int(created) and is_int(hwnd) and hwnd >= 0 and isinstance(exe, str)):
            return None
        return cls(pid=pid, exe=exe, hwnd=hwnd, created=created)


_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_MONTHS = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
                                        "Dec"), 1)}


def parse_lstart(text: str) -> int | None:
    """``ps -o lstart=`` under ``LC_ALL=C TZ=UTC0`` ("Mon Oct 19 10:23:45 2026") as seconds since the epoch. The names
    go through a fixed English table, never ``time.strptime``, which reads them in this process's ``LC_TIME``."""
    parts = text.split()
    if len(parts) != 5 or parts[0] not in _DAYS or parts[1] not in _MONTHS:
        return None
    try:
        day, year = int(parts[2]), int(parts[4])
        hour, minute, second = (int(p) for p in parts[3].split(":"))
    except ValueError:
        return None
    return calendar.timegm((year, _MONTHS[parts[1]], day, hour, minute, second, 0, 0, 0))


def ps_env() -> dict[str, str]:
    """The environment ``ps`` runs in: C locale and UTC, whatever this process's own, so every instance reads the same
    creation time (BSD ``ps`` prints ``lstart`` with ``%c`` in local time)."""
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env["TZ"] = "UTC0"
    return env


def _run_ps(args: list[str], run: Callable[..., Any]) -> str | None:
    try:
        out = run(["ps", *args], capture_output=True, text=True, env=ps_env(), timeout=5)
    except (OSError, subprocess.SubprocessError):
        logger.debug("ps %s failed", args, exc_info=True)
        return None
    return out.stdout if out.returncode == 0 else None


def ps_created(pid: int, *, run: Callable[..., Any] = subprocess.run) -> int | None:
    out = _run_ps(["-o", "lstart=", "-p", str(pid)], run)
    return parse_lstart(out) if out else None


class _BsdInfo(ctypes.Structure):
    """``struct proc_bsdinfo`` (``sys/proc_info.h``)."""
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32), ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32), ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32), ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32), ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32), ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32), ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32), ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


PROC_PIDTBSDINFO = 3


@functools.cache
def _libproc_pidinfo() -> Callable[..., int]:
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")  # part of libSystem; dlopen finds it in the shared cache
    fn = lib.proc_pidinfo
    fn.restype = ctypes.c_int
    fn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    return fn


def mac_created(pid: int, *, pidinfo: Callable[..., int] | None = None,
                run: Callable[..., Any] = subprocess.run) -> int | None:
    """A process's start in whole seconds since the epoch: ``proc_pidinfo``'s ``pbi_start_tvsec``, else ``ps`` in the C
    locale and UTC, which gives the same number."""
    try:
        fn = pidinfo or _libproc_pidinfo()
        info = _BsdInfo()
        size = ctypes.sizeof(info)
        if fn(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size) == size:
            return int(info.pbi_start_tvsec)
    except (OSError, AttributeError, TypeError, ValueError, ctypes.ArgumentError):
        logger.debug("proc_pidinfo is unavailable, reading ps", exc_info=True)
    return ps_created(pid, run=run)


# Win32
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
ERROR_ACCESS_DENIED = 5
TH32CS_SNAPPROCESS = 0x2
ASFW_ANY = -1
SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
SW_RESTORE = 9
MONITOR_DEFAULTTONEAREST = 2
MDT_EFFECTIVE_DPI = 0


def _kernel32() -> Any:
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    return k32


def win_alive(pid: int) -> bool:
    from ctypes import wintypes

    k32 = _kernel32()
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED  # type: ignore[attr-defined]
    try:
        code = wintypes.DWORD()
        return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(handle)


def win_created(pid: int) -> int | None:
    from ctypes import wintypes

    k32 = _kernel32()
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    finally:
        k32.CloseHandle(handle)


def win_exe_name(pid: int) -> str | None:
    """The executable's file name of a process, from a Toolhelp snapshot."""
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", wintypes.WCHAR * 260)]

    k32 = _kernel32()
    k32.Process32FirstW.argtypes = k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return None
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(ProcessEntry)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.th32ProcessID == pid:
                return entry.szExeFile
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
        return None
    finally:
        k32.CloseHandle(snap)


def _posix_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _linux_created(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return int(stat[stat.rindex(")") + 2:].split()[19])  # field 22, starttime
    except (OSError, ValueError, IndexError):
        return None


def _linux_args(pid: int) -> list[str] | None:
    try:
        return [a.decode("utf-8", "replace") for a in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if a]
    except OSError:
        return None


class Processes:
    """The process table as ``find_classic`` reads it; the tests give it a fake."""

    def own(self) -> set[int]:
        """This process and its parent (the onefile launcher of the Windows build, which runs the same exe)."""
        return {os.getpid(), os.getppid()}

    def alive(self, pid: int) -> bool:
        if pid <= 0:
            return False
        return win_alive(pid) if sys.platform == "win32" else _posix_alive(pid)

    def created(self, pid: int) -> int | None:
        if sys.platform == "win32":
            return win_created(pid)
        if sys.platform == "darwin":
            return mac_created(pid)
        return _linux_created(pid)

    def runs_classic(self, pid: int) -> bool:
        """Whether the process runs this program's classic GUI."""
        if sys.platform == "win32":
            # the web UI and the classic child run the same exe name (own() rules out this process and its parent)
            name = win_exe_name(pid)
            ours = {Path(sys.executable).name.lower(), Path(sys.argv[0]).name.lower()}
            return bool(name) and name.lower() in ours
        if sys.platform == "darwin":
            out = _run_ps(["-ww", "-o", "args=", "-p", str(pid)], subprocess.run)
            args = out.split() if out else None
        else:
            args = _linux_args(pid)
        return bool(args) and "--classic" in args


SYSTEM_PROCESSES = Processes()


def classic_json(data_dir: Path) -> Path:
    return Path(data_dir) / CLASSIC_JSON


def write_classic_json(data_dir: Path, proc: ClassicProcess) -> None:
    path = classic_json(data_dir)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(proc.to_json()), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        logger.warning("cannot write %s", path, exc_info=True)
        tmp.unlink(missing_ok=True)


def read_classic_json(data_dir: Path) -> tuple[str, ClassicProcess | None] | None:
    """The raw text of ``classic.json`` and what it names (``None`` when malformed); ``None`` without the file."""
    path = classic_json(data_dir)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        logger.warning("cannot read %s", path, exc_info=True)
        return None
    try:
        return raw, ClassicProcess.from_json(json.loads(raw))
    except ValueError:
        return raw, None


def remove_classic_json(data_dir: Path, pid: int | None = None) -> None:
    """Remove ``classic.json``; with ``pid``, only while it names that process."""
    path = classic_json(data_dir)
    if pid is not None:
        found = read_classic_json(data_dir)
        if found is None or found[1] is None or found[1].pid != pid:
            return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("cannot remove %s", path, exc_info=True)


def find_classic(data_dir: Path, processes: Processes | None = None) -> ClassicProcess | None:
    """The classic window ``classic.json`` names, while it runs. The pid counts only when it is alive with the creation
    time the file records (a pid the system reused has a later one), runs this program's classic GUI, and is neither
    this process nor its parent. Otherwise the file is stale and removed, so it never blocks writes."""
    procs = processes or SYSTEM_PROCESSES
    found = read_classic_json(data_dir)
    if found is None:
        return None
    raw, proc = found
    if proc is None:
        why = "malformed"
    elif proc.pid in procs.own():
        why = "this process"
    elif not procs.alive(proc.pid):
        why = "not running"
    elif procs.created(proc.pid) != proc.created:
        why = "a reused pid"
    elif not procs.runs_classic(proc.pid):
        why = "another program"
    else:
        return proc
    path = classic_json(data_dir)
    logger.info("removing stale %s (%s)", path, why)
    again = read_classic_json(data_dir)
    if again is not None and again[0] == raw:  # not rewritten meanwhile
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("cannot remove %s", path, exc_info=True)
    return None


# --- native window operations ---


class NativeOps:
    """What the web UI's window does for the hand-off; this base does nothing (no window: ``--browser``, ``--serve``)."""

    def place(self, pid: int | None, hwnd: int, size: tuple[int, int]) -> str | None:
        """Place the child's window over the BAMT window: a ``place`` line for the child to apply, or ``None`` when
        the window was placed natively or cannot be."""
        return None

    def before_raise(self, pid: int | None) -> None:
        """Hand the foreground over to the child, just before ``raise`` is sent."""

    def raise_process(self, proc: ClassicProcess) -> None:
        """Bring a classic window found through ``classic.json`` (no control channel) to the front."""


class CocoaOps(NativeOps):
    """macOS: pywebview's ``window.native`` is the ``NSWindow``. AppKit is called on the main thread only, and the
    answer is waited for only from another thread (the RPC's request thread), never on the main thread itself."""

    WAIT = 2.0

    def __init__(self, window: Any):
        self.window = window

    def _on_main(self, fn: Callable[[], Any], wait: float = WAIT) -> Any:
        if threading.current_thread() is threading.main_thread():
            return fn()
        from PyObjCTools import AppHelper

        box: dict[str, Any] = {}
        done = threading.Event()

        def run() -> None:
            try:
                box["value"] = fn()
            except Exception:
                logger.exception("main-thread call failed")
            finally:
                done.set()

        AppHelper.callAfter(run)
        if not done.wait(wait):
            logger.warning("the main thread did not answer in %.0f s", wait)
        return box.get("value")

    def place(self, pid: int | None, hwnd: int, size: tuple[int, int]) -> str | None:
        def read() -> tuple[Rect, list[tuple[Rect, Rect]]] | None:
            import AppKit

            native = getattr(self.window, "native", None)
            screens = list(AppKit.NSScreen.screens() or ())
            if native is None or not screens:
                return None

            def rect(r: Any) -> Rect:
                return Rect(r.origin.x, r.origin.y, r.size.width, r.size.height)

            return rect(native.frame()), [(rect(s.frame()), rect(s.visibleFrame())) for s in screens]

        got = self._on_main(read)
        return place_line(mac_placement(got[0], got[1], size)) if got else None

    @staticmethod
    def _hand_over(pid: int) -> None:
        """Make the process ``pid`` the active app (main thread). From macOS 14 an app activates another only by
        yielding its own activation to it first; earlier, by ignoring the other apps."""
        import AppKit

        target = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
        if target is None:
            return
        me = AppKit.NSApplication.sharedApplication()
        if me.respondsToSelector_("yieldActivationToApplication:"):
            me.yieldActivationToApplication_(target)  # the classic child also activates itself on raise
            target.activateWithOptions_(AppKit.NSApplicationActivateAllWindows)
        else:
            target.activateWithOptions_(AppKit.NSApplicationActivateAllWindows
                                        | AppKit.NSApplicationActivateIgnoringOtherApps)

    def before_raise(self, pid: int | None) -> None:
        if pid:
            self._on_main(lambda: self._hand_over(pid), wait=1.0)  # done before the child reads its raise

    def raise_process(self, proc: ClassicProcess) -> None:
        self._on_main(lambda: self._hand_over(proc.pid), wait=1.0)


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", _RECT), ("rcWork", _RECT), ("dwFlags", ctypes.c_ulong)]


class WinOps(NativeOps):
    """Windows: pywebview's ``window.native`` is the WinForms form. The web UI is DPI aware (pywebview calls
    ``SetProcessDPIAware``), so its bounds and the monitors' work areas are physical pixels; the parent places the
    child's window itself with ``SetWindowPos`` on the ``hwnd`` the child reported."""

    def __init__(self, window: Any):
        self.window = window

    @staticmethod
    def _user32() -> Any:
        from ctypes import wintypes

        u32 = ctypes.WinDLL("user32", use_last_error=True)  # type: ignore[attr-defined]
        u32.MonitorFromRect.restype = wintypes.HANDLE
        u32.MonitorFromRect.argtypes = [ctypes.POINTER(_RECT), wintypes.DWORD]
        u32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MONITORINFO)]
        u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
        u32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_int, wintypes.UINT]
        u32.SetForegroundWindow.argtypes = [wintypes.HWND]
        u32.IsIconic.argtypes = [wintypes.HWND]
        u32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        u32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
        return u32

    def _bounds(self, u32: Any) -> Rect | None:
        native = getattr(self.window, "native", None)
        if native is None:
            return None
        try:
            b = native.Bounds
            return Rect(b.X, b.Y, b.Width, b.Height)
        except Exception:
            logger.debug("no form bounds", exc_info=True)
        try:
            r = _RECT()
            if u32.GetWindowRect(int(native.Handle.ToInt64()), ctypes.byref(r)):
                return Rect(r.left, r.top, r.right - r.left, r.bottom - r.top)
        except Exception:
            logger.debug("no window rect", exc_info=True)
        return None

    @staticmethod
    def _dpi(monitor: Any) -> int:
        try:
            dpi_x, dpi_y = ctypes.c_uint(), ctypes.c_uint()
            shcore = ctypes.WinDLL("shcore")  # type: ignore[attr-defined]
            if shcore.GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, ctypes.byref(dpi_x), ctypes.byref(dpi_y)) == 0:
                return int(dpi_x.value) or 96
        except (OSError, AttributeError):
            logger.debug("GetDpiForMonitor is unavailable", exc_info=True)
        return 96

    def place(self, pid: int | None, hwnd: int, size: tuple[int, int]) -> str | None:
        if not hwnd:
            return None
        u32 = self._user32()
        bounds = self._bounds(u32)
        if bounds is None:
            return None
        cx, cy = (int(c) for c in bounds.centre)
        probe = _RECT(cx, cy, cx + 1, cy + 1)  # the monitor that holds the BAMT window's centre
        monitor = u32.MonitorFromRect(ctypes.byref(probe), MONITOR_DEFAULTTONEAREST)
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        if not monitor or not u32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return None
        w = info.rcWork
        rect = win_placement(bounds, Rect(w.left, w.top, w.right - w.left, w.bottom - w.top), self._dpi(monitor), size)
        u32.SetWindowPos(hwnd, None, int(rect.x), int(rect.y), int(rect.w), int(rect.h),
                         SWP_NOZORDER | SWP_NOACTIVATE)
        return None

    def before_raise(self, pid: int | None) -> None:
        # ASFW_ANY: the child's own pid would be the onefile launcher's, not the process that owns the Tk window
        self._user32().AllowSetForegroundWindow(ASFW_ANY & 0xFFFFFFFF)

    def raise_process(self, proc: ClassicProcess) -> None:
        u32 = self._user32()
        u32.AllowSetForegroundWindow(ASFW_ANY & 0xFFFFFFFF)
        if proc.hwnd:
            if u32.IsIconic(proc.hwnd):
                u32.ShowWindow(proc.hwnd, SW_RESTORE)
            u32.SetForegroundWindow(proc.hwnd)


def native_ops(window: Any) -> NativeOps:
    """The native operations for pywebview's window (``None``: no window)."""
    if window is None:
        return NativeOps()
    if sys.platform == "darwin":
        return CocoaOps(window)
    if sys.platform == "win32":
        return WinOps(window)
    return NativeOps()


# --- the classic window ---


@dataclass(eq=False)
class _Child:
    popen: Any  # None until Popen returned
    token: str
    tab: str | None  # the tab it shows, or should show once placed
    started_tab: str | None
    log: Any = None
    lines: list[str] = field(default_factory=list)
    pid: int | None = None  # reported at ready; on Windows the Popen pid is the onefile launcher's
    hwnd: int = 0
    exe: str = ""
    created: int | None = None
    busy: int = 0
    ready: bool = False
    placed: bool = False  # lines go out only once the window is placed: ready, place, yield, raise
    abandoned: bool = False  # the opener gave up waiting for ready
    exited: bool = False
    code: int | None = None
    polls: int = 0
    last_poll: float = field(default_factory=time.monotonic)


class ClassicWindow:
    """The one classic window of this data directory: started by this instance, or left by an earlier one and found
    through ``classic.json`` (an *orphan*, raised by pid but without a control channel).

    ``origin`` is the web UI server's origin (a string or a callable), ``publish`` the event bus's ``publish``,
    ``native`` the window operations (``native_ops(window)``). ``on_change`` runs after every change of ``status()``
    and ``on_closed(code)`` after ``classic.closed``, outside every lock of this class.
    """

    def __init__(self, data_dir: Path, *, origin: str | Callable[[], str],
                 publish: Callable[[str, Any], None] | None = None, native: NativeOps | None = None,
                 command: Callable[[str | None], list[str]] | None = None, popen: Callable[..., Any] = subprocess.Popen,
                 processes: Processes | None = None, on_change: Callable[[], None] | None = None,
                 on_closed: Callable[[int | None], None] | None = None, ready_timeout: float = READY_TIMEOUT,
                 poll_timeout: float = CONTROL_POLL, silent_exit: float = SILENT_EXIT, watch_interval: float = 1.0):
        self.data_dir = Path(data_dir)
        self._origin = origin if callable(origin) else (lambda: origin)
        self._publish = publish or (lambda event, data=None: None)
        self.native = native or NativeOps()
        self._command = command or (lambda tab: classic_command(tab, control=True))
        self._popen = popen
        self._procs = processes or SYSTEM_PROCESSES
        self._on_change = on_change
        self._on_closed = on_closed
        self._ready_timeout = ready_timeout
        self._poll_timeout = poll_timeout
        self._silent_exit = silent_exit
        self._watch_interval = watch_interval
        self._cond = threading.Condition()
        self._start_lock = threading.Lock()
        self._stop = threading.Event()
        self._child: _Child | None = None

    # --- state ---

    def _live(self) -> _Child | None:
        with self._cond:
            child = self._child
            return child if child is not None and not child.exited else None

    def orphan(self) -> ClassicProcess | None:
        """A classic window this instance did not start, found through ``classic.json`` (GameWatch's reader)."""
        if self._live() is not None:
            return None
        return find_classic(self.data_dir, self._procs)

    def is_open(self) -> bool:
        """Whether a classic window is open: game-folder writes are refused with ``classic_open`` meanwhile."""
        return self._live() is not None or self.orphan() is not None

    def status(self) -> dict[str, Any]:
        """``{open, ready, busy, pid, orphan}`` (``app.classic`` adds the queue's count)."""
        child = self._live()
        if child is not None:
            with self._cond:
                return {"open": True, "ready": child.ready, "busy": child.busy > 0,
                        "pid": child.pid or _popen_pid(child), "orphan": False}
        orphan = self.orphan()
        if orphan is not None:
            return {"open": True, "ready": True, "busy": False, "pid": orphan.pid, "orphan": True}
        return {"open": False, "ready": False, "busy": False, "pid": None, "orphan": False}

    def _changed(self) -> None:
        if self._on_change is not None:
            try:
                self._on_change()
            except Exception:
                logger.exception("classic change hook failed")

    # --- open ---

    def open(self, tab: str | None = None) -> dict[str, bool]:
        """``app.openClassic``: start the classic window on ``tab`` (``"settings"``: its settings), or bring the open
        one to the front, on that tab unless a classic task runs. Waits for the new window's ``ready`` (at most
        ``READY_TIMEOUT``); ``classic_failed {exit_code}`` when it exits or stays silent before."""
        check_classic_tab(tab)
        with self._start_lock:
            child = self._live()
            if child is None:
                orphan = find_classic(self.data_dir, self._procs)
                if orphan is not None:
                    self._native_call(self.native.raise_process, orphan)
                    return {"started": False}
                child = self._start(tab)
                started = True
            else:
                started = False
        if not started:
            self._show(child, tab)
            return {"started": False}
        self._await_ready(child)
        self._place_and_raise(child)
        return {"started": True}

    def bring_to_front(self) -> bool:
        """The classic modal's Bring to Front: raise the open classic window; ``False`` when none is open."""
        child = self._live()
        if child is not None:
            self._show(child, None)
            return True
        orphan = self.orphan()
        if orphan is not None:
            self._native_call(self.native.raise_process, orphan)
            return True
        return False

    def _start(self, tab: str | None) -> _Child:
        token = secrets.token_urlsafe(24)
        env = os.environ.copy()
        env[ENV_URL] = self._origin().rstrip("/")
        env[ENV_TOKEN] = token
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"  # classic.log keeps what it printed before a crash
        cmd = self._command(tab)
        log = None
        try:
            # never an unread pipe, which fills and blocks the child
            log = open(self.data_dir / CLASSIC_LOG, "wb")
        except OSError:
            logger.warning("cannot write %s", self.data_dir / CLASSIC_LOG, exc_info=True)
        # known before it starts, so that its first poll finds it
        child = _Child(popen=None, token=token, tab=tab, started_tab=tab, log=log)
        with self._cond:
            self._child = child
        try:
            popen = self._popen(cmd, stdin=subprocess.DEVNULL, stdout=log or subprocess.DEVNULL,
                                stderr=subprocess.STDOUT, env=env, creationflags=CREATE_NO_WINDOW)
        except OSError as e:
            with self._cond:
                child.exited = True
                if self._child is child:
                    self._child = None
            if log is not None:
                log.close()
            raise ServiceError("classic_failed", error=str(e)) from e
        with self._cond:
            child.popen = popen
        logger.info("classic GUI started (pid %s): %s", popen.pid, cmd)
        threading.Thread(target=self._watch, args=(child,), name="bamt-classic", daemon=True).start()
        self._publish("classic.opened", {"pid": popen.pid})
        self._changed()
        return child

    def _await_ready(self, child: _Child) -> None:
        deadline = time.monotonic() + self._ready_timeout
        with self._cond:
            while not child.ready and not child.exited:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            if child.ready:
                return
            child.abandoned = True
            code = child.code if child.exited else None
        logger.warning("the classic GUI %s before it was ready", "exited" if child.exited else "stayed silent")
        raise ServiceError("classic_failed", exit_code=code)

    def _place_and_raise(self, child: _Child) -> None:
        line = self._native_call(self.native.place, child.pid, child.hwnd, CLASSIC_SIZE)
        with self._cond:
            if line:
                child.lines.append(line)
            if child.tab and child.tab != child.started_tab and child.busy == 0:
                child.lines.append(tab_line(child.tab))  # asked for by a second click while it started
            child.placed = True
        self._raise(child)

    def _show(self, child: _Child, tab: str | None) -> None:
        with self._cond:
            if tab and child.busy == 0:  # a running classic task's tab is never switched underneath it
                child.tab = tab
                if child.placed:
                    child.lines = [x for x in child.lines if not (x == "settings" or x.startswith("tab "))]
                    child.lines.append(tab_line(tab))
            if not child.placed:
                return  # the opener places and raises it once it is ready
        self._raise(child)

    def _raise(self, child: _Child) -> None:
        self._native_call(self.native.before_raise, child.pid)
        with self._cond:
            if "raise" in child.lines:
                child.lines.remove("raise")
            child.lines.append("raise")
            self._cond.notify_all()

    def _native_call(self, fn: Callable[..., Any], *args: Any) -> Any:
        try:
            return fn(*args)
        except Exception:
            logger.exception("native window call %s failed", getattr(fn, "__name__", fn))
            return None

    # --- the child's channel ---

    def _match(self, token: str) -> _Child | None:
        child = self._child
        if child is None or child.exited or not token:
            return None
        if not hmac.compare_digest(token.encode("utf-8", "surrogateescape"), child.token.encode("utf-8")):
            return None
        return child

    def control(self, token: str, timeout: float | None = None) -> list[str] | None:
        """``GET /api/classic/control``: the lines waiting for the child, once there are some or after ``timeout``;
        ``None`` for an unknown token."""
        wait = self._poll_timeout if timeout is None else timeout
        with self._cond:
            child = self._match(token)
            if child is None or self._stop.is_set():
                return None  # refused: the child stops polling
            child.polls += 1
            try:
                deadline = time.monotonic() + wait
                while not (child.placed and child.lines) and not child.exited and not self._stop.is_set():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
                if self._stop.is_set():
                    return None
                if not child.placed:
                    return []
                lines, child.lines = child.lines, []
                return lines
            finally:
                child.polls -= 1
                child.last_poll = time.monotonic()

    def report(self, token: str, data: Any) -> bool | None:
        """``POST /api/classic/report``: ``ready {pid, hwnd, exe}``, ``shown {tab}`` or ``busy {n}`` as
        ``{"type": ..., ...}``. ``None`` for an unknown token, ``False`` for a malformed report."""
        child = self._match(token)
        if child is None:
            return None
        if not isinstance(data, dict):
            return False
        kind = data.get("type")
        if kind == "ready":
            self._ready(child, data)
        elif kind == "shown":
            tab = data.get("tab")
            if not (tab is None or (isinstance(tab, str) and (tab == "settings" or _TAB_NAME.fullmatch(tab)))):
                return False
            with self._cond:
                child.tab = tab
            self._publish("classic.ready", {"pid": child.pid, "tab": tab})
        elif kind == "busy":
            n = _int(data.get("n"))
            if n is None:
                return False
            with self._cond:
                changed, child.busy = child.busy != max(n, 0), max(n, 0)
            if changed:
                self._changed()
        else:
            return False
        return True

    def _ready(self, child: _Child, data: dict[str, Any]) -> None:
        pid = _int(data.get("pid")) or _popen_pid(child)
        hwnd = _int(data.get("hwnd")) or 0
        exe = data.get("exe") if isinstance(data.get("exe"), str) else ""
        with self._cond:
            if child.ready:
                return
        created = self._procs.created(pid) if pid and pid > 0 else None
        # written before ready counts, so the file names the window once app.openClassic answers
        if created is None:
            logger.warning("no creation time for the classic GUI (pid %s); classic.json not written", pid)
        else:
            write_classic_json(self.data_dir, ClassicProcess(pid=pid, exe=exe, hwnd=max(hwnd, 0), created=created))
        with self._cond:
            child.pid, child.hwnd, child.exe, child.created = pid, max(hwnd, 0), exe, created
            child.ready = True
            if child.abandoned:
                child.placed = True  # nobody places it: it shows itself, and later clicks raise it
            self._cond.notify_all()
            exited = child.exited
        if exited:  # it ended meanwhile, and _closed may have looked for the file before it was written
            remove_classic_json(self.data_dir, pid)
        logger.info("classic GUI ready (pid %s)", pid)
        self._publish("classic.ready", {"pid": pid, "tab": child.tab})
        self._changed()

    def wsgi(self, environ: dict, start_response: Callable) -> list[bytes]:
        """The ``/api/classic/*`` endpoints, for the web UI's WSGI app to route to after its Host check. They take the
        child's token (``X-BAMT-Classic``), never the session token."""
        path = environ.get("PATH_INFO", "")
        method = environ.get("REQUEST_METHOD", "GET")
        token = environ.get("HTTP_X_BAMT_CLASSIC", "")
        if path == CONTROL_PATH:
            if method != "GET":
                return _reply(start_response, "405 Method Not Allowed", {})
            lines = self.control(token)
            if lines is None:
                return _reply(start_response, "403 Forbidden", {})
            return _reply(start_response, "200 OK", {"lines": lines})
        if path == REPORT_PATH:
            if method != "POST":
                return _reply(start_response, "405 Method Not Allowed", {})
            try:
                length = int(environ.get("CONTENT_LENGTH") or 0)
            except ValueError:
                length = 0
            if self._match(token) is None:
                return _reply(start_response, "403 Forbidden", {})
            if length <= 0 or length > MAX_REPORT:
                return _reply(start_response, "400 Bad Request", {})
            try:
                data = json.loads(environ["wsgi.input"].read(length))
            except (ValueError, KeyError):
                return _reply(start_response, "400 Bad Request", {})
            ok = self.report(token, data)
            if ok is None:
                return _reply(start_response, "403 Forbidden", {})
            return _reply(start_response, "200 OK" if ok else "400 Bad Request", {})
        return _reply(start_response, "404 Not Found", {})

    # --- exit ---

    def _silent(self, child: _Child) -> bool:
        with self._cond:
            return child.polls == 0 and time.monotonic() - child.last_poll > self._silent_exit

    def _watch(self, child: _Child) -> None:
        code = child.popen.wait()
        # the Windows onefile launcher may return before the window it unpacked (user check U6): follow the pid the
        # child reported, until it ends or stops polling
        while not self._stop.is_set():
            with self._cond:
                pid, created = child.pid, child.created
            if not pid or pid == child.popen.pid or not self._procs.alive(pid):
                break
            if created is not None and self._procs.created(pid) != created:
                break
            if self._silent(child):
                break
            self._stop.wait(self._watch_interval)
        self._closed(child, code)

    def _closed(self, child: _Child, code: int | None) -> None:
        with self._cond:
            if child.exited:
                return
            child.exited, child.code = True, code
            if self._child is child:
                self._child = None
            self._cond.notify_all()
        if child.pid:
            remove_classic_json(self.data_dir, child.pid)
        if child.log is not None:
            try:
                child.log.close()
            except OSError:
                pass
        logger.info("classic GUI closed (code %s)", code)
        self._publish("classic.closed", {"code": code})
        self._changed()
        if self._on_closed is not None:
            try:
                self._on_closed(code)
            except Exception:
                logger.exception("classic close hook failed")

    def close(self) -> None:
        """The web UI quits: end the long-polls. The classic window stays open (its polls fail, it stops polling)."""
        self._stop.set()
        with self._cond:
            self._cond.notify_all()


def _popen_pid(child: _Child) -> int | None:
    return child.popen.pid if child.popen is not None else None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _reply(start_response: Callable, status: str, data: Any) -> list[bytes]:
    body = json.dumps(data, separators=(",", ":")).encode("utf-8")
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                            ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")])
    return [body]
