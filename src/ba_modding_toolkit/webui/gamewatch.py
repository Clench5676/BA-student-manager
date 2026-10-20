"""Game watch: whether the game runs, Steam changes an install or a classic window left by an earlier instance is
open, polled so the page and the tray can grey the Enable Mods switch.

A pure poller. It reads the process list, Steam's app manifests and, through the reader it is given,
``classic.json``; never a game file, so it needs no scan consent. The check at write time stays the authority: the
poll only greys controls.

The services wire it (see docs/web-ui.md, "Game watch"):

- ``installs()``: the known installs' folders, from the settings at each call;
- ``find_classic()``: the classic window ``classic.json`` names, or ``None`` (the classic hand-off's reader, which
  owns the file's format, the identity check and the removal of a stale file);
- ``profiles_seen()``: whether another data directory changed the library's shared intent since the last call;
- ``on_change(state)``: called on the first poll, whenever the answer changes and whenever ``profiles_seen()`` says
  yes; it updates the ``mods.state`` snapshot and publishes ``mods.state``;
- ``publish(event, data)``: ``classic.closed {code: null}`` when a watched classic window ends;
- ``request_scan()``: on the game stopping, Steam going idle and a watched classic window ending; the scanner runs
  it only with scan consent, and coalesces requests.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol

from ..errors import ServiceError
from ..library import safety

logger = logging.getLogger(__name__)

# while a page is connected to /api/events or the tray icon is shown
FAST_SECONDS = 3.0
SLOW_SECONDS = 15.0


class ClassicProcess(Protocol):
    pid: int


@dataclass(frozen=True)
class WatchState:
    """One answer of the watch."""

    game: str | None = None  # None, "game_running" or "game_status_unavailable"
    steam_busy: tuple[str, ...] = ()  # the known installs Steam is changing, as installs() gave them
    classic: int | None = None  # the pid of an open classic window this instance did not start

    @property
    def reason(self) -> str | None:
        """Why the switch is unavailable, as far as the watch knows: one of ``mods.state``'s reasons, or ``None``."""
        if self.game:
            return self.game
        if self.steam_busy:
            return "steam_busy"
        if self.classic is not None:
            return "classic_open"
        return None


class GameWatch:
    def __init__(self, *,
                 installs: Callable[[], Iterable[Path | str]],
                 find_classic: Callable[[], ClassicProcess | None],
                 profiles_seen: Callable[[], bool],
                 on_change: Callable[[WatchState], Any],
                 publish: Callable[[str, Any], Any],
                 request_scan: Callable[[], Any],
                 active: Callable[[], bool] = lambda: False,
                 own_classic: Callable[[], int | None] = lambda: None,
                 on_classic_closed: Callable[[], Any] | None = None,
                 check_game: Callable[[], None] | None = None,
                 check_steam: Callable[[Path | str], None] | None = None,
                 fast: float = FAST_SECONDS, slow: float = SLOW_SECONDS):
        """``active()`` says whether to poll fast (a page connected, the tray icon shown); ``own_classic()`` gives the
        pid of the classic window this instance started, which its own watcher thread reports, so it is never
        watched here; ``on_classic_closed()`` runs after ``classic.closed`` is published, as for that thread's
        exit. ``check_game`` and ``check_steam`` default to the write-time checks of ``library.safety``."""
        self._installs = installs
        self._find_classic = find_classic
        self._profiles_seen = profiles_seen
        self._on_change = on_change
        self._publish = publish
        self._request_scan = request_scan
        self._active = active
        self._own_classic = own_classic
        self._on_classic_closed = on_classic_closed
        self._check_game = check_game
        self._check_steam = check_steam
        self._fast, self._slow = fast, slow
        self._state = WatchState()
        self._polled = False
        self._lock = threading.Lock()  # guards _state and _thread only
        self._poll_lock = threading.Lock()  # one poll at a time; taken before any lock the callbacks take
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    # --- the answer ---

    @property
    def state(self) -> WatchState:
        """The last poll's answer (all clear before the first poll)."""
        with self._lock:
            return self._state

    def poll(self) -> WatchState:
        """Check once and report what changed. Runs on the watch thread; call it directly only without one."""
        with self._poll_lock:
            previous, first = self._state, not self._polled
            state = WatchState(game=self._game(), steam_busy=self._steam(), classic=self._classic(previous.classic))
            seen = self._seen()
            with self._lock:
                self._state, self._polled = state, True
            if state.reason != previous.reason or first:
                logger.info("game watch: %s", state.reason or "clear")
            if first or seen or state != previous:
                self._call(self._on_change, state)
            # the state before the first poll is all clear, so the first poll reports no end and requests no scan
            closed = previous.classic is not None and state.classic != previous.classic
            if closed:
                self._call(self._publish, "classic.closed", {"code": None})
                if self._on_classic_closed is not None:
                    self._call(self._on_classic_closed)
            stopped = previous.game == "game_running" and state.game is None
            idle = set(previous.steam_busy) - set(state.steam_busy)
            if stopped or idle or closed:
                self._call(self._request_scan)
            return state

    def _game(self) -> str | None:
        try:
            (self._check_game or safety.check_game_not_running)()
        except ServiceError as error:
            return error.code if error.code in ("game_running", "game_status_unavailable") \
                else "game_status_unavailable"
        except Exception:
            logger.exception("game process check failed")
            return "game_status_unavailable"
        return None

    def _steam(self) -> tuple[str, ...]:
        try:
            folders = [str(folder) for folder in self._installs()]
        except Exception:
            logger.exception("known installs unavailable")
            return ()
        busy = []
        for folder in dict.fromkeys(folders):
            try:
                (self._check_steam or safety.check_steam_idle)(folder)
            except ServiceError as error:
                if error.code == "steam_busy":
                    busy.append(folder)
            except Exception:
                logger.debug("Steam check failed for %s", folder, exc_info=True)
        return tuple(busy)

    def _classic(self, previous: int | None) -> int | None:
        try:
            found = self._find_classic()
            own = self._own_classic()
        except Exception:
            logger.exception("classic window lookup failed")
            return previous  # no news is not an exit
        pid = getattr(found, "pid", None) if found is not None else None
        return None if pid is None or pid == own else int(pid)

    def _seen(self) -> bool:
        try:
            return bool(self._profiles_seen())
        except Exception:
            logger.exception("shared library intent unreadable")
            return False

    @staticmethod
    def _call(function: Callable[..., Any], *args: Any) -> None:
        try:
            function(*args)
        except Exception:
            logger.exception("game watch callback failed")

    # --- the thread ---

    def interval(self) -> float:
        """Seconds to the next poll."""
        try:
            active = bool(self._active())
        except Exception:
            active = True
        return self._fast if active else self._slow

    def start(self) -> None:
        """Poll on a daemon thread until ``stop()``; the first poll runs at once."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stopped.clear()
            self._thread = threading.Thread(target=self._run, name="bamt-gamewatch", daemon=True)
            self._thread.start()

    def poke(self) -> None:
        """Poll again now, on the watch thread (the tray menu opening, a page connecting)."""
        self._wake.set()

    def stop(self, timeout: float | None = 5.0) -> None:
        self._stopped.set()
        self._wake.set()
        with self._lock:
            thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)

    def _run(self) -> None:
        while not self._stopped.is_set():
            self.poll()
            self._wake.wait(self.interval())
            self._wake.clear()
