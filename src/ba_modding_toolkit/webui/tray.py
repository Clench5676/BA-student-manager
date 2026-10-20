"""The tray icon (Windows) and the menu bar icon (macOS); see docs/web-ui.md, "Tray".

Its menu: one Enable Mods item for every known install (decision 1), Back to Official while a scan found drift, Open
and Quit. The icon is shown while the preference ``tray`` is on, only in the app window, and it goes with the app:
closing the window quits (decision 7).

- **The model** is pure: ``tray_menu(snapshot, strings)``, ``tray_tooltip``, ``toggle_action`` and ``needs_window``
  read only a ``mods.state`` snapshot. Opening the menu never calls ``ps``, never builds the library and never takes
  the library lock; it only asks the game watch for a fresh answer on the watch's own thread, which the next opening
  shows.
- **``Tray``** keeps the last ``mods.state`` (an observer of the event bus), shows or hides the icon with the
  preference, and runs every click on a thread of its own, never on the UI thread: submitting the toggle may build
  the library.
- **The backends** draw it: ``CocoaTray``, an ``NSStatusItem`` on pywebview's own run loop, made and changed on the
  main thread only; ``WinFormsTray``, a ``NotifyIcon`` on pywebview's WinForms thread, else on an STA thread of its
  own. Only the app window makes one; tests never do.

What the page is told (the window shows the outcome):

- ``tray.toggle {job, enabled, expect}``: the tray submitted ``mods.toggle``; the page follows the job as it follows
  its own toggle (progress, end toast, result popup). A refusal or a result with failed, stuck or left entries also
  brings the window to the front.
- ``tray.open {view, ...}``: the window was brought to the front on a view: ``explain`` (the first toggle's
  explanation, whose button submits ``mods.toggle {enabled, expect}``), ``error`` (``{code, params}``, a refusal at
  submit) or ``drift`` (the drift prompt).
"""

from __future__ import annotations

import importlib.util
import logging
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from ..errors import ServiceError
from ..i18n import i18n_manager, t
from .strings import fill, ui_strings

logger = logging.getLogger(__name__)

ICON_DIR = Path(__file__).resolve().parent.parent / "assets" / "tray"
MENUBAR_POINTS = 18.0  # the menu bar icon's size; its PDF is drawn at that size
WINDOW_WAIT = 30.0  # seconds the tray waits for the window to show before it makes the icon anyway
TOOLTIP_MAX = 63  # NotifyIcon.Text's limit on .NET Framework
CLOSE_WAIT_MS = 2000  # how long quitting waits for the tray icon's own thread to remove it
RESULT_KEYS = ("failed", "stuck", "left")  # a toggle's entries that bring the window to the front


# --- the model ---

@dataclass(frozen=True)
class MenuItem:
    """One line of the menu. ``action`` is what a click does: ``toggle``, ``drift``, ``open`` or ``quit``. A line
    without one is a disabled note (the reason under Enable Mods), or a separator when it has no label either."""

    action: str | None
    label: str = ""
    enabled: bool = True
    checked: bool = False

    @property
    def separator(self) -> bool:
        return self.action is None and not self.label


SEPARATOR = MenuItem(None)


def _text(strings: dict[str, str], key: str, **values: Any) -> str:
    text = strings.get(f"webui.{key}", key)
    return fill(text, **values) if values else text


def clickable(snapshot: dict[str, Any] | None) -> bool:
    """Whether Enable Mods can be clicked: a snapshot is there, nothing makes the switch unavailable and no toggle is
    queued or running (nor writes queued for the classic window)."""
    return bool(snapshot) and not snapshot.get("reason") and snapshot.get("available", True) is not False \
        and not snapshot.get("busy")


def _working(snapshot: dict[str, Any], strings: dict[str, str]) -> str:
    progress = snapshot.get("progress") or {}
    if progress.get("total"):
        return _text(strings, "tray.working", done=progress.get("done", 0), total=progress["total"])
    return _text(strings, "job.running")


def unavailable_line(snapshot: dict[str, Any] | None, strings: dict[str, str]) -> str | None:
    """The disabled line under a greyed Enable Mods: the reason, "Working n/m" while a toggle runs, "Working" while
    the first snapshot is read; ``None`` while it can be clicked."""
    if not snapshot:
        return _text(strings, "job.running")
    reason = snapshot.get("reason")
    if reason:
        params = {k: v for k, v in (snapshot.get("reasonParams") or {}).items() if v is not None}
        return _text(strings, f"error.{reason}", **params)
    if not clickable(snapshot):
        return _working(snapshot, strings)
    return None


def tray_menu(snapshot: dict[str, Any] | None, strings: dict[str, str]) -> list[MenuItem]:
    """The menu for a ``mods.state`` snapshot (``None`` before the first one), in the UI language's strings."""
    line = unavailable_line(snapshot, strings)
    on = bool(snapshot.get("enabled", True)) if snapshot else False
    items = [MenuItem("toggle", _text(strings, "mods.switch"), enabled=line is None, checked=on)]
    if line:
        items.append(MenuItem(None, line, enabled=False))
    drift = int((snapshot or {}).get("drift") or 0)
    if drift > 0 and (snapshot or {}).get("scan") is True:
        items.append(MenuItem("drift", _text(strings, "tray.drift", n=drift)))
    items += [SEPARATOR, MenuItem("open", _text(strings, "settings.classic.open")),
              MenuItem("quit", _text(strings, "tray.quit"))]
    return items


def tray_tooltip(snapshot: dict[str, Any] | None, strings: dict[str, str], title: str) -> str:
    """The app title and the state: "Mods on", "Mods off", or "Working 12/40" while a toggle runs."""
    if not snapshot:
        return title
    if (snapshot.get("progress") or {}).get("total") and snapshot.get("busy"):
        state = _working(snapshot, strings)
    else:
        state = _text(strings, "mods.onState" if snapshot.get("enabled", True) else "mods.offState")
    return f"{title}\n{state}"


def toggle_action(snapshot: dict[str, Any] | None) -> tuple[str, dict[str, bool]] | None:
    """What a click on Enable Mods does: ``("explain", params)`` opens the window on the first toggle's explanation
    (decision 3), ``("submit", params)`` submits ``mods.toggle`` at once, an Off with mods outside the library
    included (decision 4); ``None`` while the item is greyed. ``params`` is ``{enabled, expect}``, the snapshot's
    intent as ``expect``."""
    if not clickable(snapshot):
        return None
    current = bool(snapshot.get("enabled", True))
    params = {"enabled": not current, "expect": current}
    return ("submit" if snapshot.get("explained") else "explain"), params


def needs_window(state: str, result: Any) -> bool:
    """Whether a tray toggle's end brings the window to the front, where the page shows the error or the result
    popup: the job failed (a refusal, ``not_enough_space`` included), or entries failed, stuck or were left."""
    if state == "failed":
        return True
    return state == "done" and isinstance(result, dict) and any(result.get(key) for key in RESULT_KEYS)


# --- the controller ---

class Backend(Protocol):
    def start(self) -> None:
        """Make what the icon needs on its UI thread (asynchronously)."""

    def call(self, fn: Callable[[], Any]) -> None:
        """Run ``fn`` on the UI thread, without waiting."""

    def sync(self, shown: bool, tooltip: str) -> None:
        """UI thread: show or remove the icon, and set its tooltip."""

    def close(self) -> None:
        """Remove the icon; the GUI loop may have ended already."""


def _importable(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class Tray:
    """The tray or menu bar icon of the app window. ``attach()`` follows ``mods.state`` and the jobs from before the
    window opens; ``start(window)`` is ``webview.start``'s function, called once the GUI loop runs; ``close()`` after
    the loop ended."""

    def __init__(self, services: Any, backend: Backend | None = None):
        self.s = services
        self._backend = backend
        self._lock = threading.Lock()  # a leaf lock: the snapshot, the strings and the followed jobs
        self._snapshot: dict[str, Any] | None = None
        self._strings: tuple[str, dict[str, str]] | None = None
        self._jobs: set[str] = set()  # the toggles the tray submitted, until their end was handled
        self._unobserve: Callable[[], None] | None = None
        self._closed = False

    @staticmethod
    def supported(platform: str = sys.platform) -> bool:
        """Whether this system can show the icon: macOS through PyObjC, Windows through pythonnet (both come with
        pywebview there)."""
        if platform == "darwin":
            return _importable("AppKit") and _importable("PyObjCTools")
        if platform == "win32":
            return _importable("clr")
        return False

    def attach(self) -> None:
        self._unobserve = self.s.events.observe(self._on_event)
        self.s.jobs.listen(self._job_finished)

    def start(self, window: Any) -> None:
        """Hand over to a daemon thread, so a window that never shows never holds up the exit."""
        threading.Thread(target=self.run, args=(window,), name="bamt-tray", daemon=True).start()

    def run(self, window: Any) -> None:
        """Wait for the window to show, make the backend and show the icon if the preference is on."""
        events = getattr(window, "events", None)
        shown, closed = getattr(events, "shown", None), getattr(events, "closed", None)
        deadline = time.monotonic() + WINDOW_WAIT
        while shown is not None and not shown.wait(0.25):
            if self._closed or (closed is not None and closed.is_set()):
                return
            if time.monotonic() > deadline:
                logger.info("the window did not show in %.0f s; making the tray icon anyway", WINDOW_WAIT)
                break
        try:
            with self._lock:
                if self._closed:
                    return
                backend = self._backend = self._backend or make_backend(self, window)
            backend.start()
        except Exception:
            logger.exception("the tray icon is unavailable")
            return
        if self.snapshot() is None:
            # the first mods.state may still be on its way: read it here, off the UI thread
            try:
                self._on_event("mods.state", self.s.mods_state())
                return
            except Exception:
                logger.exception("mods state unavailable for the tray icon")
        self._sync()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            backend = self._backend
        if self._unobserve is not None:
            self._unobserve()
            self._unobserve = None
        self.s.tray_shown = False
        if backend is not None:
            try:
                backend.close()
            except Exception:
                logger.exception("the tray icon was not removed")

    # --- what the icon shows ---

    def snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            return self._snapshot

    def strings(self) -> dict[str, str]:
        """The UI language's strings, read again when the language changes."""
        lang = i18n_manager.lang
        with self._lock:
            cached = self._strings
        if cached is None or cached[0] != lang:
            cached = (lang, ui_strings(lang))
            with self._lock:
                self._strings = cached
        return cached[1]

    def menu_items(self) -> list[MenuItem]:
        """The menu as it opens, on the UI thread: from the last snapshot only. The game watch polls again on its
        own thread, and the next opening shows its answer."""
        watch = getattr(self.s, "watch", None)
        if watch is not None:
            watch.poke()
        items = tray_menu(self.snapshot(), self.strings())
        self._sync()  # the tooltip too, in a language changed since the last mods.state
        return items

    def tooltip(self) -> str:
        return tray_tooltip(self.snapshot(), self.strings(), t("ui.app_title"))

    def _on_event(self, event: str, data: Any) -> None:
        # the event bus's observer: on the publishing thread, so it only stores and hands over
        if event != "mods.state" or not isinstance(data, dict):
            return
        with self._lock:
            self._snapshot = data
        self._sync()

    def _sync(self) -> None:
        with self._lock:
            backend = None if self._closed else self._backend
        if backend is None:
            return
        snapshot = self.snapshot()
        shown = bool(snapshot and snapshot.get("tray"))
        tooltip = self.tooltip()
        self.s.tray_shown = shown  # the game watch polls fast while the icon is shown
        backend.call(lambda: backend.sync(shown, tooltip))

    # --- clicks ---

    def on_action(self, action: str) -> None:
        """A click, on the UI thread: its work runs on a thread of its own."""
        work = {"toggle": self._toggle, "drift": self._drift, "open": self._open, "quit": self._quit}.get(action)
        if work is not None:
            threading.Thread(target=self._guarded, args=(work,), name=f"bamt-tray-{action}", daemon=True).start()

    @staticmethod
    def _guarded(work: Callable[[], Any]) -> None:
        try:
            work()
        except Exception:
            logger.exception("tray action failed")

    def _open(self) -> None:
        self.s.raise_window()

    def _open_on(self, view: str, **data: Any) -> None:
        self.s.raise_window()
        self.s.events.publish("tray.open", {"view": view, **data})

    def _drift(self) -> None:
        self._open_on("drift")

    def _toggle(self) -> None:
        action = toggle_action(self.snapshot())
        if action is None:
            return
        kind, params = action
        if kind == "explain":
            self._open_on("explain", **params)
            return
        try:
            job_id = self.s.submit_toggle(**params)
        except ServiceError as error:
            self._open_on("error", **error.to_json())
            return
        with self._lock:
            self._jobs.add(job_id)
        self.s.events.publish("tray.toggle", {"job": job_id, **params})
        try:
            job = self.s.jobs.get(job_id)
        except ServiceError:
            return
        if job.state in ("done", "failed", "dropped"):
            self._ended(job)  # it ended before the tray followed it

    def _job_finished(self, job: Any) -> None:
        # the job runner's listener, on the worker thread
        self._ended(job)

    def _ended(self, job: Any) -> None:
        with self._lock:
            if job.id not in self._jobs:
                return
            self._jobs.discard(job.id)
        if needs_window(job.state, job.result):
            # never on the job worker: raising waits for the UI thread
            threading.Thread(target=self._guarded, args=(self.s.raise_window,), name="bamt-tray-raise",
                             daemon=True).start()

    def _quit(self) -> None:
        """``app.quit``'s rules; while a writer job runs, the window comes to the front with the busy toast."""
        try:
            self.s.quit()
        except ServiceError as error:
            if error.code != "busy":
                raise
            self.s.raise_window()
            self.s.events.publish("app.busy")


def make_backend(tray: Tray, window: Any) -> Backend:
    if sys.platform == "darwin":
        return CocoaTray(tray)
    if sys.platform == "win32":
        return WinFormsTray(tray, window)
    raise RuntimeError(f"no tray icon on {sys.platform}")


# --- macOS: NSStatusItem on pywebview's run loop ---

_COCOA_TARGET: Any = None


def _cocoa_target() -> Any:
    """The Objective-C class that receives the menu's clicks and its menuNeedsUpdate: (made once per process)."""
    global _COCOA_TARGET
    if _COCOA_TARGET is None:
        import objc
        from Foundation import NSObject

        class BAMTTrayTarget(NSObject, protocols=[objc.protocolNamed("NSMenuDelegate")]):
            def menuNeedsUpdate_(self, menu: Any) -> None:
                backend = getattr(self, "backend", None)
                if backend is not None:
                    backend.rebuild(menu)

            def clicked_(self, sender: Any) -> None:
                backend = getattr(self, "backend", None)
                if backend is not None:
                    backend.clicked(int(sender.tag()))

        _COCOA_TARGET = BAMTTrayTarget
    return _COCOA_TARGET


def menubar_image() -> Any:
    """The menu bar icon: the PDF as a vector template image, else the 2x PNG; ``None`` when neither loads."""
    from AppKit import NSImage

    for name in ("menubar.pdf", "menubar@2x.png"):
        image = NSImage.alloc().initWithContentsOfFile_(str(ICON_DIR / name))
        if image is not None and image.isValid():
            image.setSize_((MENUBAR_POINTS, MENUBAR_POINTS))
            image.setTemplate_(True)  # the menu bar tints it for light, dark and highlighted
            image.setAccessibilityDescription_(t("ui.app_title"))
            return image
        logger.warning("menu bar icon %s unreadable", name)
    return None


class CocoaTray:
    """An ``NSStatusItem``, made and changed on the main thread only (``AppHelper.callAfter``); either click opens
    the menu, which ``menuNeedsUpdate:`` rebuilds as it opens."""

    def __init__(self, tray: Tray):
        from PyObjCTools import AppHelper

        self._tray = tray
        self._after = AppHelper.callAfter
        self._item: Any = None
        self._menu: Any = None
        self._target: Any = None
        self._actions: list[str | None] = []

    def start(self) -> None:
        pass  # the status item is made when it is first shown

    def call(self, fn: Callable[[], Any]) -> None:
        self._after(self._safe, fn)

    @staticmethod
    def _safe(fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception:
            logger.exception("menu bar icon update failed")

    def sync(self, shown: bool, tooltip: str) -> None:
        if shown and self._item is None:
            self._create()
        elif not shown and self._item is not None:
            self._remove()
        if self._item is not None:
            self._item.button().setToolTip_(tooltip)

    def _create(self) -> None:
        from AppKit import NSMenu, NSStatusBar, NSVariableStatusItemLength

        image = menubar_image()
        if image is None:
            logger.error("no menu bar icon: its files in %s are unreadable", ICON_DIR)
            return
        target = _cocoa_target().alloc().init()
        target.backend = self
        menu = NSMenu.alloc().init()
        menu.setAutoenablesItems_(False)
        menu.setDelegate_(target)
        item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSVariableStatusItemLength)
        item.button().setImage_(image)
        item.setMenu_(menu)
        self._item, self._menu, self._target = item, menu, target
        logger.info("menu bar icon shown")
        self.rebuild(menu)

    def rebuild(self, menu: Any) -> None:
        """menuNeedsUpdate: the items from the last snapshot."""
        from AppKit import NSMenuItem

        items = self._tray.menu_items()
        menu.removeAllItems()
        for index, item in enumerate(items):
            if item.separator:
                menu.addItem_(NSMenuItem.separatorItem())
                continue
            entry = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                item.label, "clicked:" if item.action else None, "")
            if item.action:
                entry.setTarget_(self._target)
            entry.setTag_(index)
            entry.setEnabled_(bool(item.enabled and item.action))
            entry.setState_(1 if item.checked else 0)  # NSControlStateValueOn / Off
            menu.addItem_(entry)
        self._actions = [item.action for item in items]

    def clicked(self, index: int) -> None:
        if 0 <= index < len(self._actions) and self._actions[index]:
            self._tray.on_action(self._actions[index])

    def _remove(self) -> None:
        from AppKit import NSStatusBar

        item, self._item = self._item, None
        if self._menu is not None:
            self._menu.setDelegate_(None)
        if self._target is not None:
            self._target.backend = None
        self._menu = self._target = None
        if item is not None:
            NSStatusBar.systemStatusBar().removeStatusItem_(item)
            logger.info("menu bar icon removed")

    def close(self) -> None:
        from Foundation import NSThread

        if NSThread.isMainThread():
            self._remove()  # after webview.start returned: the run loop no longer runs queued calls
        else:
            self.call(self._remove)


# --- Windows: NotifyIcon on pywebview's WinForms thread ---

class WinFormsTray:
    """A ``NotifyIcon`` with a ``ContextMenuStrip``, made on the window's WinForms thread (``window.native.Invoke``),
    or, when that fails, on an STA thread of its own with its own message loop. A left click (or double click) opens
    the window, a right click the menu, which its ``Opening`` event rebuilds. The icon is hidden and disposed of when
    the window closes, so Windows keeps no dead icon."""

    def __init__(self, tray: Tray, window: Any):
        import clr

        for assembly in ("System.Windows.Forms", "System.Drawing"):
            try:
                clr.AddReference(assembly)
            except Exception:
                logger.debug("assembly %s not added (loaded with WinForms)", assembly, exc_info=True)
        self._tray = tray
        self._window = window
        self._icon: Any = None
        self._strip: Any = None
        self._marshal: Any = None  # a hidden control on the icon's thread, for BeginInvoke
        self._own_thread = False
        self._pending: Callable[[], Any] | None = None  # the last call made before the thread was ready
        self._lock = threading.Lock()

    def start(self) -> None:
        from System import Func, Type

        form = getattr(self._window, "native", None)
        if form is not None:
            try:
                form.Invoke(Func[Type](self._make_on_form))
                return
            except Exception:
                logger.warning("the window's thread is unavailable; the tray icon gets a thread of its own",
                               exc_info=True)
        self._start_thread()

    def _make_on_form(self) -> None:
        self._make()
        self._window.native.FormClosed += self._form_closed

    def _start_thread(self) -> None:
        import System.Windows.Forms as WinForms
        from System.Threading import ApartmentState, Thread, ThreadStart

        def run() -> None:
            try:
                self._make()
                WinForms.Application.Run(WinForms.ApplicationContext())
            except Exception:
                logger.exception("the tray icon's thread stopped")

        thread = Thread(ThreadStart(run))
        thread.SetApartmentState(ApartmentState.STA)
        thread.IsBackground = True
        self._own_thread = True
        thread.Start()

    def _make(self) -> None:
        import System.Windows.Forms as WinForms

        marshal = WinForms.Control()
        marshal.CreateControl()
        _ = marshal.Handle  # BeginInvoke needs the handle
        strip = WinForms.ContextMenuStrip()
        strip.Opening += self._opening
        with self._lock:
            self._marshal, self._strip = marshal, strip
            pending, self._pending = self._pending, None
        if pending is not None:
            self._safe(pending)

    def call(self, fn: Callable[[], Any]) -> None:
        from System import Action

        with self._lock:
            marshal = self._marshal
            if marshal is None:
                self._pending = fn  # only the latest state matters
                return
        try:
            marshal.BeginInvoke(Action(lambda: self._safe(fn)))
        except Exception:
            logger.debug("tray icon update dropped", exc_info=True)

    @staticmethod
    def _safe(fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception:
            logger.exception("tray icon update failed")

    def sync(self, shown: bool, tooltip: str) -> None:
        import System.Windows.Forms as WinForms

        if shown and self._icon is None:
            from System.Drawing import Icon

            icon = WinForms.NotifyIcon()
            icon.Icon = Icon(str(ICON_DIR / "tray.ico"), WinForms.SystemInformation.SmallIconSize)
            icon.ContextMenuStrip = self._strip
            icon.MouseClick += self._mouse_click
            icon.Text = _clip(tooltip)
            icon.Visible = True
            self._icon = icon
            logger.info("tray icon shown")
        elif not shown and self._icon is not None:
            self._dispose_icon()
        if self._icon is not None:
            self._icon.Text = _clip(tooltip)

    def _mouse_click(self, sender: Any, args: Any) -> None:
        import System.Windows.Forms as WinForms

        if args.Button == WinForms.MouseButtons.Left:
            self._tray.on_action("open")

    def _opening(self, sender: Any, args: Any) -> None:
        import System.Windows.Forms as WinForms
        from System.Drawing import Font, FontStyle

        strip = self._strip
        strip.Items.Clear()
        for item in self._tray.menu_items():
            if item.separator:
                strip.Items.Add(WinForms.ToolStripSeparator())
                continue
            entry = WinForms.ToolStripMenuItem(item.label)
            entry.Enabled = bool(item.enabled and item.action)
            entry.Checked = item.checked
            if item.action == "open":
                entry.Font = Font(entry.Font, FontStyle.Bold)  # a left click's action, as Windows marks it
            if item.action:
                entry.Click += self._handler(item.action)
            strip.Items.Add(entry)
        args.Cancel = False  # WinForms cancels the opening of a strip that had no items

    def _handler(self, action: str) -> Callable[[Any, Any], None]:
        return lambda sender, args: self._tray.on_action(action)

    def _dispose_icon(self) -> None:
        icon, self._icon = self._icon, None
        if icon is not None:
            icon.Visible = False
            icon.Dispose()
            logger.info("tray icon removed")

    def _form_closed(self, sender: Any, args: Any) -> None:
        self._dispose_icon()

    def close(self) -> None:
        """On the window's thread the icon went with the form (FormClosed), and that thread has ended; an own thread
        still runs its loop: it removes the icon and ends. Never waits more than CLOSE_WAIT_MS."""
        if not self._own_thread or self._marshal is None:
            return
        from System import Action

        try:
            done = self._marshal.BeginInvoke(Action(self._close_on_thread))
            if done.AsyncWaitHandle.WaitOne(CLOSE_WAIT_MS):
                return
        except Exception:
            logger.debug("the tray icon's thread is gone", exc_info=True)
        self._dispose_icon()

    def _close_on_thread(self) -> None:
        import System.Windows.Forms as WinForms

        self._dispose_icon()
        if self._own_thread:
            WinForms.Application.ExitThread()


def _clip(text: str) -> str:
    return text if len(text) <= TOOLTIP_MAX else text[:TOOLTIP_MAX - 1] + "…"
