"""Builds and holds the services behind the web UI, and answers /asset/... requests."""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .. import devmode
from ..config import APP_DIR_NAME, Settings, user_cache_dir
from ..globallines import GlobalLines
from ..kivo import Kivo
from ..errors import ServiceError
from ..i18n import i18n_manager
from ..naming import parse_filename
from ..utils import EXE_DIR
from .classic import QUEUE_METHODS, ClassicQueue, ClassicWindow, NativeOps, QueuedCall, native_ops, stat_files
from .events import EventBus
from .jobs import JobRunner
from .scanner import Scanner
from .server import MIME, AssetResponse
from .state import UiState
from .strings import install_label, ui_strings

logger = logging.getLogger(__name__)

PRUNE_WAIT = 120.0  # seconds the start scan waits for the library.prune job submitted with the library
PROGRESS_PUBLISH = 0.25  # seconds between two mods.state events while a toggle reports its progress
# the library's files and folders a library move takes along; the lock files are made again where needed
LIBRARY_ITEMS = ("mods", "originals", "built", "state.json", "profiles.json", "profiles.json.prev",
                 "profiles.json.bad")


class ModsSnapshot:
    """What ``mods.state`` answers from, never through the library lock: the library's status (the known installs,
    the shared intent, the disk use; ``ModLibrary.status``), the last scan's entries and a running toggle's progress.
    GameWatch, the scanner and the jobs update it. Its lock is a leaf lock."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: dict[str, Any] | None = None
        self._entries: list[Any] = []
        self._scanned: str | None = None
        self._progress: dict[str, int] | None = None

    def status(self) -> dict[str, Any] | None:
        with self._lock:
            return self._status

    def set_status(self, status: dict[str, Any] | None) -> None:
        with self._lock:
            self._status = status

    def entries(self) -> list[Any]:
        with self._lock:
            return list(self._entries)

    def scanned(self) -> str | None:
        with self._lock:
            return self._scanned

    def set_entries(self, entries: list[Any], scanned: str | None) -> None:
        with self._lock:
            self._entries, self._scanned = list(entries), scanned

    def clear_entries(self) -> None:
        with self._lock:
            self._entries, self._scanned = [], None

    def drop_entries(self, keys: set[tuple[str, str]], cores: set[str] = frozenset()) -> None:
        """Leave out the entries a job switched or adopted, until the scan after it: ``keys`` (install, core), and
        ``cores`` in any install."""
        if not keys and not cores:
            return
        with self._lock:
            self._entries = [e for e in self._entries if (e.install, e.core) not in keys and e.core not in cores]

    def mark_dismissed(self, keys: set[tuple[str, str]]) -> None:
        from dataclasses import replace

        with self._lock:
            self._entries = [replace(e, dismissed=True) if (e.install, e.core) in keys else e for e in self._entries]

    def progress(self) -> dict[str, int] | None:
        with self._lock:
            return self._progress

    def set_progress(self, progress: dict[str, int] | None) -> None:
        with self._lock:
            self._progress = progress


class _WindowOps(NativeOps):
    """The classic window's native operations on the window the services hold at the call (pywebview makes it after
    the services are built; none in browser and serve mode)."""

    def __init__(self, services: Services):
        self._services = services

    def _ops(self) -> NativeOps:
        return native_ops(self._services.window)

    def place(self, pid: int | None, hwnd: int, size: tuple[int, int]) -> str | None:
        return self._ops().place(pid, hwnd, size)

    def before_raise(self, pid: int | None) -> None:
        self._ops().before_raise(pid)

    def raise_process(self, proc: Any) -> None:
        self._ops().raise_process(proc)


class _QueueHost:
    """What the classic queue asks of the web UI when the classic window closed."""

    def __init__(self, services: Services):
        self._s = services

    def intent(self) -> bool | None:
        return self._s.library.intent()["enabled"]

    def pins(self) -> dict[str, Any]:
        return {pin.key: pin for pin in self._s.library.installs()}

    def current(self) -> str | None:
        pin = self._s.library.current_pin()
        return pin.key if pin else None

    def submit(self, method: str, params: dict[str, Any]) -> Any:
        return self._s.submit_call(method, params)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _changed_of(result: Any) -> dict[str, list[str]]:
    """``library.changed``'s data for a job's result: the cores and kinds it switched or added."""
    cores, kinds = getattr(result, "cores", None), getattr(result, "kinds", None)
    if cores is not None and kinds is not None:
        return {"cores": sorted(cores), "kinds": sorted(kinds)}
    files = getattr(result, "files", None)
    if isinstance(files, list):
        names = [parse_filename(Path(f).name).core.lower() for f in files if isinstance(f, (str, Path))]
        cores = sorted({c for c in names if c})
        kinds = sorted({"spr" if c.endswith("_spr") else "lobby" for c in cores})
        return {"cores": cores, "kinds": kinds}
    mod = getattr(result, "mod", None)
    if mod is not None and getattr(mod, "core", None):
        return {"cores": [mod.core], "kinds": [mod.kind]}
    return {"cores": [], "kinds": []}


def _touched(result: Any) -> tuple[set[tuple[str, str]], set[str]]:
    """The entries a job's result names as switched, adopted or dropped (install, core), and the cores of the mods an
    adoption added."""
    keys: set[tuple[str, str]] = set()
    for name in ("done", "adopted", "dropped"):
        for item in getattr(result, name, None) or []:
            if isinstance(item, dict) and isinstance(item.get("install"), str) and isinstance(item.get("core"), str):
                keys.add((item["install"], item["core"]))
    cores = {m.core for m in getattr(result, "added", None) or [] if getattr(m, "core", "")}
    return keys, cores


def _intent_key(status: dict[str, Any] | None) -> tuple:
    if not status:
        return ()
    unfinished = status.get("unfinished") or {}
    return (status.get("enabled"), status.get("toggled"), tuple(sorted(unfinished.items())), status.get("reason"))


class Services:
    """The web UI's service container. Game-backed services are built on first use and rebuilt after a game
    folder change; tests pass fakes for any of them.

    In dev mode (devmode) the data directory, the library and the cache must lie inside the dev roots, and moving
    the library or the cache out of them is refused.

    Besides the services, it holds what the Enable Mods switch and the classic hand-off need: the ``mods.state``
    snapshot, the scanner (only with the scan consent), the game watch (started by ``start()``), the classic window
    and the queue of the writes waiting for it to close.
    """

    def __init__(self, settings: Settings | None = None, data_dir: Path = EXE_DIR, *,
                 events: EventBus | None = None, jobs: JobRunner | None = None, state: UiState | None = None,
                 cache: Any = None, game: Any = None, catalog: Any = None, library: Any = None,
                 classic_options: dict[str, Any] | None = None):
        devmode.check_read(data_dir)
        self.settings = settings or Settings()
        self.data_dir = Path(data_dir)
        self.events = events or EventBus()
        self.jobs = jobs or JobRunner(self.events)
        self.state = state or UiState(self.data_dir / "webui.json")
        self.window: Any = None  # the pywebview window, when there is one (see native.py)
        self.update_info: Any = None  # the last update check's result
        self.kivo = Kivo()
        self.global_lines = GlobalLines()
        self.mute = False  # development: never play voices
        self.debug = False  # started with --debug: the front end may send its input trace (debug.trace)
        self.origin = "http://127.0.0.1:0"  # the server's origin, for the classic window's channel (main.build)
        self.quit_handle: Callable[[], None] | None = None  # browser mode: stops the server (main)
        self.browser_url: str | None = None  # browser mode: the page's address, opened again by a second start
        self.tray_supported = False  # a tray or menu bar icon can be shown (the tray sets it)
        self.tray_shown = False  # the tray or menu bar icon is shown (the game watch then polls fast)
        self._lock = threading.RLock()
        self._cache, self._game, self._catalog, self._library = cache, game, catalog, library
        self._injected = {k for k, v in (("game", game), ("catalog", catalog), ("library", library)) if v is not None}
        self._other_games: dict[str, Any] = {}  # other installs' GameAssets by install key, for <core>@<id> URLs
        self._prune_job: str | None = None
        self._profiles_signature: Any = None
        self._intent_seen: tuple = ()
        self._queue_ticket: int | None = None  # the scan after a classic window closed: the queue runs after it
        self._progress_at = 0.0
        self._strings_cache: tuple[str, dict[str, str]] | None = None
        self.snapshot = ModsSnapshot()
        self.queue = ClassicQueue()
        self.classic = ClassicWindow(self.data_dir, origin=lambda: self.origin, publish=self.events.publish,
                                     **{"native": _WindowOps(self), **(classic_options or {}),
                                        "on_change": self._classic_changed, "on_closed": self._classic_closed})
        self.scanner = Scanner(self._scan, allowed=self.scan_allowed, writer_busy=self.jobs.busy,
                               on_done=self._scanned)
        self.jobs.listen(self._job_finished)
        self.watch: Any = None  # the GameWatch, once start() runs
        self.settings.on_change(self._on_settings_changed)

    # --- lazily built services ---

    @property
    def cache(self) -> Any:
        with self._lock:
            if self._cache is None:
                from ..gameassets import AssetCache

                self._cache = AssetCache(allowed=self.state.consent is True, root=self.cache_dir())
            return self._cache

    @property
    def game(self) -> Any:
        self._refresh_if_idle()
        with self._lock:
            if self._game is None:
                dirs = self.settings.resource_dirs()
                if not dirs:
                    raise ServiceError("game_not_found")
                self._game = self._make_game(dirs)
            return self._game

    def _make_game(self, dirs: list[Path]) -> Any:
        from ..gameassets import GameAssets

        return GameAssets(dirs, self.cache)

    def game_found(self) -> bool:
        try:
            self.game
            return True
        except ServiceError:
            return False

    @property
    def catalog(self) -> Any:
        self._refresh_if_idle()
        with self._lock:
            if self._catalog is None:
                from ..catalog import Catalog

                csv = Path(self.settings.get("bacii_map_path"))
                # recruitable follows the server of the selected game folder
                self._catalog = Catalog(self.game if self.game_found() else None, csv if csv.exists() else None,
                                        server=self.settings.server_region())
            return self._catalog

    @property
    def library(self) -> Any:
        """The mod library. Built without a current install too (ADB mode, the selected folder missing): the switch
        then works over the other known installs. A new library gets its ``library.prune`` job and the start scan."""
        self._refresh_if_idle()
        built = None
        with self._lock:
            if self._library is None:
                from ..library import ModLibrary

                devmode.check_read(self.library_dir())
                game = self.game if self.game_found() else None
                built = self._library = ModLibrary(
                    self.library_dir(), self.catalog, game, self.settings, scan_allowed=self.scan_allowed,
                    data_id=self.state.data_id(self.data_dir), write_check=self._write_check)
                # kept originals the game no longer needs (verified in the launcher, replaced by a game update) are
                # deleted once per library, on the job worker so no apply runs meanwhile; the judging of the
                # unfinished list follows it
                self._prune_job = self.submit("library.prune",
                                              lambda log, progress: [str(p) for p in built.prune()],
                                              writes="library", library=built)
            library = self._library
        if built is not None:
            self.scanner.request()  # the start scan (with scan consent), after the prune job
        return library

    def cache_dir(self) -> Path:
        """Where light game UI assets are cached: a BA-Modding-Toolkit/cache folder inside the folder the user chose,
        else the default user cache folder. Always a folder of its own, so clearing it never touches anything else."""
        chosen = self.state.get("cache_parent")
        return Path(chosen) / APP_DIR_NAME / "cache" if chosen else user_cache_dir()

    def set_cache_parent(self, parent: Path) -> Path:
        """Cache in another folder; the old cache is removed (it is rebuilt from the game files on demand)."""
        parent = Path(parent).expanduser().resolve()
        devmode.check_read(parent)
        if not parent.is_dir():
            raise ServiceError("path_not_found", path=str(parent))
        with self._lock:
            old = self.cache_dir()
            self.state.set("cache_parent", str(parent))
            new = self.cache_dir()
            if new != old:
                if self._cache is not None:
                    self._cache.clear()  # removes the old cache folder only
                    self._cache.root = new
                elif old.is_dir() and old.name == "cache" and old.parent.name == APP_DIR_NAME:
                    shutil.rmtree(old, ignore_errors=True)
        return new

    def library_dir(self) -> Path:
        """Where the mod library lives: the user's choice, else the data directory's library folder."""
        chosen = self.state.get("library_dir")
        return Path(chosen) if chosen else self.data_dir / "library"

    def move_library(self, target: Path) -> Path:
        """Use another folder for the mod library. The current library moves there when the target holds none: its
        mods, kept originals, built copies, state.json and profiles.json (with its .prev and .bad)."""
        target = Path(target).expanduser().resolve()
        devmode.check_read(target)
        current = self.library_dir().resolve()
        if target == current:
            return target
        if target.exists() and not target.is_dir():
            raise ServiceError("path_not_found", path=str(target))
        if self.jobs.busy():
            raise ServiceError("busy")  # a running job still writes through the current library

        def has_library(folder: Path) -> bool:
            return (folder / "state.json").exists() or (folder / "profiles.json").exists()

        self.scanner.cancel()  # a running scan reads the current library
        self.scanner.wait_idle(5.0)
        with self._lock:
            if has_library(current) and not has_library(target):
                clashes = [item for item in LIBRARY_ITEMS if (target / item).exists()]
                if clashes:
                    raise ServiceError("library_target_not_empty", path=str(target / clashes[0]))
                target.mkdir(parents=True, exist_ok=True)
                moved = []
                try:
                    for item in LIBRARY_ITEMS:
                        if (current / item).exists():
                            shutil.move(str(current / item), str(target / item))
                            moved.append(item)
                except OSError as e:
                    for item in reversed(moved):  # put back what already moved
                        try:
                            shutil.move(str(target / item), str(current / item))
                        except OSError:
                            logger.exception("could not move %s back to %s", item, current)
                    raise ServiceError("library_io_error", file=str(target)) from e
            self.state.set("library_dir", str(target))
            if "library" not in self._injected:
                self._library = None
                self._profiles_signature = None
        self.snapshot.clear_entries()
        self.events.publish("library.changed")
        self.refresh_status()
        self.publish_state()
        return target

    def reload_game(self) -> None:
        """Rebuild the game-backed services after the game folder or file source changed."""
        self._on_settings_changed()

    def _on_settings_changed(self) -> None:
        # a new game folder means new game-backed services; while a writer job runs they are swapped once it is done,
        # so the job never shares the library with a second instance
        with self._lock:
            self._stale = True
        self._refresh_if_idle()
        self.events.publish("config.changed")
        # the known installs may be others now: a running scan is of the old ones
        self.scanner.cancel()
        self.refresh_status()
        self.scanner.request()
        self.publish_state()

    def _refresh_if_idle(self) -> None:
        with self._lock:
            if not getattr(self, "_stale", False) or self.jobs.busy():
                return
            self._stale = False
            for name in ("game", "catalog", "library"):
                if name not in self._injected:
                    setattr(self, f"_{name}", None)
            self._other_games = {}
            self._profiles_signature = None

    def set_consent(self, granted: bool) -> None:
        self.state.set_consent(granted)
        if self._cache is not None:
            self._cache.allowed = granted

    # --- the scan consent and the scan ---

    def scan_allowed(self) -> bool:
        """Whether the user gave the scan consent; the library asks it at each use."""
        return self.state.scan_consent is True

    def set_scan_consent(self, granted: bool) -> None:
        """The scan consent popup's answer, or Settings' File Check: granted, a scan runs; withdrawn, scans stop and
        the entries empty."""
        self.state.set("scan_consent", bool(granted))
        if granted:
            self.scanner.request()
        else:
            self.scanner.clear()
            self.snapshot.clear_entries()
            # the scan the classic queue waits for is dropped with the other requests: the queue runs now
            self._release_queue()
        self.publish_state()

    def request_scan(self, dismissed: bool = False) -> int | None:
        return self.scanner.request(dismissed)

    def _scan(self, cancel: Callable[[], bool], dismissed: bool) -> Any:
        """One scan over every known install, on the scanner's thread. The start scan waits for the prune job."""
        if self._prune_job is not None:
            self.jobs.wait(self._prune_job, PRUNE_WAIT)
        library = self.library
        return library.scan(library.installs(), cancel, include_dismissed=dismissed)

    def _scanned(self, result: Any, served: int) -> None:
        if result is not None:
            self.snapshot.set_entries(list(result.entries), _now())
            self.events.publish("library.scanned", {"counts": result.counts})
            self.publish_state()
        self._release_queue(served)

    def _release_queue(self, served: int | None = None) -> None:
        """Run the classic queue once the scan it waits for is done (``served``, the last request a scan attempt
        served), or at once (``None``: that scan will not run, the scan consent was withdrawn). Only one caller takes
        the ticket."""
        with self._lock:
            ticket = self._queue_ticket
            if ticket is None or (served is not None and served < ticket):
                return
            self._queue_ticket = None
        self.run_queue()

    # --- jobs ---

    def submit(self, kind: str, fn: Callable[..., Any], *, writes: str | None = None, library: Any = None,
               **params: Any) -> str:
        """Submit a job. A writer job (``writes``: "game" or "library") ends on the worker with the library's
        judging of the unfinished list, a new ``mods.state`` snapshot, ``library.changed {cores, kinds}`` and a scan
        (with scan consent); ``library`` is the library it works through, captured at submit."""
        if writes is None:
            return self.jobs.submit(kind, fn, **params)

        def run(log: Any, progress: Any, **p: Any) -> Any:
            result, failed = None, True
            try:
                result = fn(log=log, progress=progress, **p)
                failed = False
                return result
            finally:
                self._after_writer(library, kind, result, failed)

        return self.jobs.submit(kind, run, writes=writes, **params)

    def _after_writer(self, library: Any, kind: str, result: Any, failed: bool) -> None:
        library = library if library is not None else self._library
        if library is not None and kind != "library.judge":
            try:
                library.judge_unfinished()
            except ServiceError as error:
                logger.info("unfinished entries not judged: %s", error.code)
            except Exception:
                logger.exception("unfinished entries not judged")
        if not failed:
            keys, cores = _touched(result)
            self.snapshot.drop_entries(keys, cores)
        self.snapshot.set_progress(None)
        self.refresh_status(library)
        # a failed job may have switched some entries (a toggle stopped midway): everything is read again
        self.events.publish("library.changed", None if failed else _changed_of(result))
        if kind not in ("library.prune", "library.judge"):  # a scan follows those already (the start, a poll)
            self.scanner.request()

    def _job_finished(self, job: Any) -> None:
        # the end of a writer job: mods.state again, with the job no longer busy (a toggle's end)
        if job.writes:
            self.publish_state()

    def _progress(self, progress: Callable[..., Any]) -> Callable[..., Any]:
        """A toggle's progress callback that also feeds ``mods.state.progress`` ("Working 12/40")."""
        def report(current: int, total: int, label: str = "") -> None:
            progress(current, total, label)
            self.snapshot.set_progress({"done": int(current), "total": int(total)})
            now = time.monotonic()
            if current >= total or now - self._progress_at >= PROGRESS_PUBLISH:
                self._progress_at = now
                self.publish_state()

        return report

    def _check_pin(self, library: Any, pin: Any) -> None:
        """``folder_changed`` when the current install is not the one a single-entry job was submitted with."""
        now = library.current_pin()
        if now is None or now.key != pin.key or tuple(now.dirs) != tuple(pin.dirs):
            raise ServiceError("folder_changed")

    def _current_pin(self, library: Any) -> Any:
        pin = library.current_pin()
        if pin is None:
            raise ServiceError("game_not_found")
        return pin

    def submit_toggle(self, enabled: bool, expect: bool) -> str:
        """``mods.toggle``: the Enable Mods switch over every known install, pinned at submit. ``busy`` while another
        toggle is queued or running, ``classic_open`` while a classic window is open (checked again when the job
        starts, before the intent is saved)."""
        if not isinstance(enabled, bool) or not isinstance(expect, bool):
            raise ServiceError("bad_params", key="enabled")
        if self.jobs.active("mods.toggle"):
            raise ServiceError("busy")
        self.check_classic()
        library = self.library
        pins = library.installs()

        def run(log: Any, progress: Any) -> Any:
            self.check_classic()
            return library.toggle(enabled, expect, pins, log=log, progress=self._progress(progress))

        job = self.submit("mods.toggle", run, writes="game", library=library)
        self.publish_state()
        return job

    def submit_restore_drift(self, entries: list[dict]) -> str:
        """``mods.restoreDrift``: Apply Mod Configuration of the given entries, pinned at submit."""
        if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
            raise ServiceError("bad_params", key="entries")
        self.check_classic()
        library = self.library
        pins = library.installs()

        def run(log: Any, progress: Any) -> Any:
            self.check_classic()
            return library.restore_drift(entries, pins, log=log, progress=self._progress(progress))

        return self.submit("mods.restore", run, writes="game", library=library)

    def submit_apply(self, variant: str, source: str, kind: str = "spr") -> str:
        """``actions.apply``: one entry of the current install, pinned at submit. ``classic_open`` only when it would
        write a game file (an apply while mods are off only changes the configuration)."""
        if kind not in ("spr", "lobby"):
            raise ServiceError("bad_params", kind=kind)
        library = self.library
        pin = self._current_pin(library)
        if self.classic_open() and library.would_write(variant, source, kind, pin=pin):
            raise ServiceError("classic_open")

        def run(log: Any, progress: Any) -> Any:
            self._check_pin(library, pin)
            return library.apply(variant, source, log=log, progress=progress, kind=kind, pin=pin)

        return self.submit("apply", run, writes="game", library=library)

    def submit_restore(self, variant: str, kind: str = "spr") -> str:
        """``actions.restore``: back to official, pinned at submit. A restore that writes nothing (the files are
        official already) is allowed while a classic window is open; if it turns out to write after all (the full
        judgement finds a file changed), the write itself is refused with ``classic_open``."""
        if kind not in ("spr", "lobby"):
            raise ServiceError("bad_params", kind=kind)
        library = self.library
        pin = self._current_pin(library)
        if self.classic_open() and library.would_write(variant, "official", kind, pin=pin):
            raise ServiceError("classic_open")

        def run(log: Any, progress: Any) -> Any:
            self._check_pin(library, pin)
            return library.restore(variant, log=log, kind=kind, pin=pin)

        return self.submit("restore", run, writes="game", library=library)

    def submit_call(self, method: str, params: dict[str, Any]) -> str:
        """Submit one of the calls the classic queue holds, as its normal job."""
        params = dict(params or {})
        if method == "mods.toggle":
            return self.submit_toggle(params.get("enabled"), params.get("expect"))
        if method == "mods.restoreDrift":
            return self.submit_restore_drift(params.get("entries"))
        if method == "actions.apply":
            return self.submit_apply(params.get("variant"), params.get("source"), params.get("kind", "spr"))
        if method == "actions.restore":
            return self.submit_restore(params.get("variant"), params.get("kind", "spr"))
        raise ServiceError("bad_params", method=method)

    def submit_judge(self) -> str | None:
        """Judge the unfinished list again as a library writer job (another data directory changed the intent)."""
        library = self._library
        if library is None or self.jobs.active("library.judge"):
            return None
        return self.submit("library.judge", lambda log, progress: {"dropped": library.judge_unfinished()},
                           writes="library", library=library)

    # --- the classic window ---

    def classic_open(self) -> bool:
        """Whether a classic window is open: this instance's, or one found through classic.json."""
        return self.classic.is_open()

    def check_classic(self) -> None:
        if self.classic_open():
            raise ServiceError("classic_open")

    def _write_check(self, pin: Any) -> None:
        # the library's own check right before game files are written: never while the classic UI is open
        self.check_classic()

    def _classic_changed(self) -> None:
        self.publish_state()

    def _classic_closed(self, code: int | None = None) -> None:
        """This instance's classic window closed (its watcher thread)."""
        self.after_classic()

    def _orphan_closed(self) -> None:
        """A classic window an earlier instance left closed (the game watch)."""
        self.after_classic()

    def after_classic(self) -> None:
        """The classic tabs may have changed game files: the page reads them again, a scan runs (with scan consent),
        then the queued writes."""
        self.events.publish("library.changed")
        ticket = self.scanner.request()
        if ticket is None:
            self.run_queue()
        else:
            with self._lock:
                self._queue_ticket = ticket
            if self.scanner.served() >= ticket:  # served (or dropped) before the ticket was kept
                self._release_queue(self.scanner.served())
        self.publish_state()

    def run_queue(self) -> Any:
        """Submit the writes queued while the classic window was open, those that still hold; the dropped ones are
        published (``classic.queueDone``) for one result popup."""
        if not len(self.queue):
            return None
        run = self.queue.run(_QueueHost(self))
        self.events.publish("classic.queueDone", run.to_json())
        self.publish_state()
        return run

    def queue_call(self, method: str, params: dict[str, Any]) -> int:
        """``classic.queue``: keep a refused write for when the classic window closes, with its pins and the sizes
        and dates of its entries' files. Returns how many items are queued."""
        if method not in QUEUE_METHODS or not isinstance(params, dict):
            raise ServiceError("bad_params", method=method)
        library = self.library
        if method == "mods.toggle":
            enabled, expect = params.get("enabled"), params.get("expect")
            if not isinstance(enabled, bool) or not isinstance(expect, bool):
                raise ServiceError("bad_params", key="enabled")
            call = QueuedCall(method, {"enabled": enabled, "expect": expect},
                              pins={pin.key: pin for pin in library.installs()})
            count = self.queue.add(call, intent=library.intent()["enabled"])
        elif method in ("actions.apply", "actions.restore"):
            variant, kind = params.get("variant"), params.get("kind", "spr")
            if not isinstance(variant, str) or kind not in ("spr", "lobby"):
                raise ServiceError("bad_params", key="variant")
            clean: dict[str, Any] = {"variant": variant, "kind": kind}
            if method == "actions.apply":
                if not isinstance(params.get("source"), str):
                    raise ServiceError("bad_params", key="source")
                clean["source"] = params["source"]
            pin = self._current_pin(library)
            try:
                found = self.catalog.variant(variant)
            except KeyError as error:
                raise ServiceError("variant_not_found", variant=variant) from error
            core = (found.spr if kind == "spr" else found.lobby) or ""
            files = [str(f.file) for f in library.state(variant, pin=pin).files if f.kind == kind]
            entry = (pin.key, core.lower())
            call = QueuedCall(method, clean, entries=(entry,), pins={pin.key: pin}, files={entry: stat_files(files)},
                              current=True)
            count = self.queue.add(call)
        else:  # mods.restoreDrift
            listed = params.get("entries")
            if not isinstance(listed, list):
                raise ServiceError("bad_params", key="entries")
            pins = {pin.key: pin for pin in library.installs()}
            known = {(e.install, e.core): e for e in self.snapshot.entries()}
            items, keys, files = [], [], {}
            for item in listed:
                if not (isinstance(item, dict) and item.get("install") in pins and isinstance(item.get("core"), str)):
                    continue
                key = (item["install"], item["core"].lower())
                if key in keys:
                    continue
                entry = known.get(key)
                keys.append(key)
                items.append(item)
                files[key] = stat_files([str(f.file) for f in entry.files] if entry is not None else [])
            if not keys:
                raise ServiceError("bad_params", key="entries")
            call = QueuedCall(method, {"entries": items}, entries=tuple(keys),
                              pins={key[0]: pins[key[0]] for key in keys}, files=files)
            count = self.queue.add(call)
        self.publish_state()
        return count

    def clear_queue(self) -> int:
        dropped = self.queue.clear()
        self.publish_state()
        return dropped

    def _own_classic(self) -> int | None:
        status = self.classic.status()
        return status["pid"] if status["open"] and not status["orphan"] else None

    # --- the mods.state snapshot ---

    def refresh_status(self, library: Any = None) -> dict[str, Any] | None:
        """Read the library's status into the snapshot (names, stats and profiles.json only, never the library
        lock)."""
        try:
            library = library if library is not None else self.library
            status = library.status()
        except ServiceError as error:
            logger.info("mods status unavailable: %s", error.code)
            return self.snapshot.status()
        except Exception:
            logger.exception("mods status unavailable")
            return self.snapshot.status()
        self.snapshot.set_status(status)
        self._intent_seen = _intent_key(status)
        return status

    def profiles_seen(self) -> bool:
        """The game watch's question at each poll: did another data directory sharing the library change its shared
        intent (``enabled``, ``toggled``, ``unfinished``)? profiles.json is read again only when its size or date
        changed, under its file lock, never under the library lock. A change also requests a scan and the judging of
        the unfinished list, so the red dot follows with or without scan consent."""
        library = self._library
        profiles = getattr(library, "profiles", None)
        if profiles is None:
            return False
        try:
            signature = profiles.signature()
        except Exception:
            return False
        if signature == self._profiles_signature:
            return False
        self._profiles_signature = signature
        try:
            intent = {**library.intent(), "reason": None}
        except ServiceError as error:
            intent = {"reason": error.code}
        status = dict(self.snapshot.status() or {})
        status.update({key: value for key, value in intent.items()
                       if key in ("enabled", "toggled", "unfinished", "reason")})
        if _intent_key(status) == self._intent_seen:
            return False
        self.refresh_status(library)
        self.scanner.request()
        self.submit_judge()
        return True

    def mods_state(self) -> dict[str, Any]:
        """``mods.state``: from the snapshot, the preferences, the game watch, the classic window and the jobs."""
        status = self.snapshot.status()
        if status is None:
            status = self.refresh_status() or {}
        consent = self.state.scan_consent
        entries = self.snapshot.entries() if consent is True else []
        unfinished = {"pending": 0, "left": 0, "stuck": 0, **(status.get("unfinished") or {})}
        count = lambda test: sum(1 for e in entries if test(e))  # noqa: E731
        if consent is True:
            pending = count(lambda e: e.state == "pending" and not e.overwritten)
            stuck = count(lambda e: e.state == "pending" and e.overwritten)
            left = unfinished["left"]  # an adopt that failed: only the toggle that made it knows
        else:
            pending, stuck, left = unfinished["pending"], unfinished["stuck"], unfinished["left"]
        reason, params = self._reason(status)
        strings = self._strings()
        installs = [{**{k: v for k, v in item.items() if k != "distinct"},
                     "label": install_label(strings, item.get("server", "global"), item.get("distinct")),
                     "distinct": item.get("distinct")} for item in status.get("installs") or []]
        return {
            "installs": installs,
            "current": status.get("current"),
            "enabled": status.get("enabled", True),
            "shown": self.state.flag("mod_switch_shown"),
            "available": reason is None,
            "reason": reason,
            "reasonParams": params,
            "scan": consent,
            "explained": self.state.flag("mods_explained"),
            "configured": status.get("configured", 0),
            "pending": pending,
            "stuck": stuck,
            "left": left,
            "unfinished": {"pending": unfinished["pending"], "left": unfinished["left"],
                           "stuck": unfinished["stuck"]},
            "drift": count(lambda e: e.state in ("reset", "updated") and not e.dismissed),
            "untracked": count(lambda e: e.state in ("untracked", "changed") and not e.dismissed),
            "damaged": count(lambda e: e.state == "damaged"),
            "sourceMissing": count(lambda e: e.state == "source_missing"),
            "builtSize": status.get("builtSize", 0),
            "originalsSize": status.get("originalsSize", 0),
            "queued": len(self.queue),
            "scanned": self.snapshot.scanned() if consent is True else None,
            "tray": self.state.flag("tray"),
            "traySupported": self.tray_supported,
            "busy": self.jobs.active("mods.toggle") or len(self.queue) > 0,
            "progress": self.snapshot.progress(),
        }

    def _reason(self, status: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
        """Why the switch is unavailable: no known install at all, an unreadable configuration, the game watch's
        answer (the game running or its state unknown, Steam busy, a classic window left by an earlier instance), or
        this instance's classic window."""
        if not status.get("installs"):
            return "game_not_found", {}
        if status.get("reason"):
            return status["reason"], {"file": status.get("file")} if status.get("file") else {}
        watch = getattr(getattr(self.watch, "state", None), "reason", None)
        if watch:
            return watch, {}
        if self.classic_open():
            return "classic_open", {}
        return None, {}

    def _strings(self) -> dict[str, str]:
        """The UI language's strings, for the install labels (the locale files do not change while the app runs)."""
        lang = i18n_manager.lang
        cached = self._strings_cache
        if cached is None or cached[0] != lang:
            cached = self._strings_cache = (lang, ui_strings(lang))
        return cached[1]

    def publish_state(self) -> None:
        try:
            self.events.publish("mods.state", self.mods_state())
        except Exception:
            logger.exception("mods.state not published")

    # --- the game watch, the window and quitting ---

    def start(self) -> None:
        """What the running app adds to the services: the game watch, and the library built in the background so
        the start sequence (prune, judging, scan) runs at once."""
        self.start_watch()
        threading.Thread(target=self._warm, name="bamt-library", daemon=True).start()

    def _warm(self) -> None:
        if self.refresh_status() is not None:
            self.publish_state()

    def start_watch(self, run: bool = True) -> None:
        """Make the game watch and (``run``) start its thread; without, ``watch.poll()`` checks once."""
        from .gamewatch import GameWatch

        if self.watch is not None:
            return
        self.watch = GameWatch(
            installs=lambda: [item["folder"] for item in (self.snapshot.status() or {}).get("installs") or []],
            find_classic=self.classic.orphan, profiles_seen=self.profiles_seen,
            on_change=lambda state: self.publish_state(), publish=self.events.publish,
            request_scan=self.scanner.request, active=lambda: self.events.listeners() > 0 or self.tray_shown,
            own_classic=self._own_classic, on_classic_closed=self._orphan_closed)
        if run:
            self.watch.start()

    def raise_window(self) -> None:
        """A second start of the program on this data directory: show and raise the window (browser mode: open the
        page again)."""
        window = self.window
        if window is not None:
            for name in ("show", "restore"):
                try:
                    getattr(window, name)()
                except Exception:
                    logger.debug("window.%s failed", name, exc_info=True)
            return
        if self.browser_url:
            webbrowser.open(self.browser_url)

    def quit(self) -> None:
        """``app.quit``: ``busy`` while a writer job is queued or running; closes the window, or in browser mode
        stops the server once the answer went out; ``native_unavailable`` with ``--serve``."""
        if self.jobs.busy():
            raise ServiceError("busy")
        if self.window is not None:
            self.window.destroy()
            return
        if self.quit_handle is not None:
            threading.Timer(0.3, self.quit_handle).start()
            return
        raise ServiceError("native_unavailable")

    # --- /asset/... ---

    def asset(self, path: str, query: dict[str, str]) -> AssetResponse:
        parts = path.split("/")
        kind = parts[0]
        if kind == "ui":
            return self._ui_asset(parts[1:], query)
        if kind == "art" and len(parts) == 3:
            if parts[1] == "bg":
                data, mime = self.game.collection_bg(_stem(parts[2]))
                return AssetResponse(data, mime, light=False)
            if parts[1] == "portrait":
                return AssetResponse(self.game.collection_portrait(_stem(parts[2])), "image/png", light=False)
        if kind == "spine" and len(parts) == 4:
            return self._spine_asset(parts[1], parts[2], parts[3])
        if kind == "model" and len(parts) == 2 and parts[1].endswith(".glb"):
            # a variant's 3D chibi, exported from the game files in memory and never cached
            core = self.catalog.variant(_stem(parts[1])).model
            if not core:
                raise KeyError(path)
            return AssetResponse(self.game.model_glb(core), MIME[".glb"], light=False)
        if kind == "voice" and len(parts) == 3:
            # a memorial lobby voice clip from Kivo, relayed so it is never cached
            variant = self.catalog.variant(parts[1])
            return AssetResponse(self.kivo.audio(variant.page_id or "", _stem(parts[2])), "audio/ogg", light=False)
        raise KeyError(path)

    def _ui_asset(self, parts: list[str], query: dict[str, str]) -> AssetResponse:
        game = self.game
        if parts == ["atlases.json"]:
            return _json(game.atlases(), light=True)
        if parts == ["textures.json"]:
            return _json({name: f"/asset/ui/texture/{name}.png" for name in game.textures()}, light=True)
        if len(parts) == 3 and parts[0] == "sprite":
            return AssetResponse(game.sprite_png(parts[1], _stem(parts[2])), "image/png", light=True)
        if len(parts) == 2 and parts[0] == "texture":
            return AssetResponse(game.texture_png(_stem(parts[1])), "image/png", light=True)
        if len(parts) == 2 and parts[0] == "layout":
            return _json(game.layout(_stem(parts[1]), query.get("path", "")), light=True)
        raise KeyError("/".join(parts))

    def _install_game(self, install_id: str) -> Any:
        """The game files of another known install, by its id in ``mods.state.installs`` (an entry card of that
        install draws its own files): a GameAssets over that install's pinned resource folders, built on first use
        and dropped with the services rebuild. KeyError (404) for an unknown id."""
        library = self.library
        pin = next((p for p in library.installs() if p.id == install_id), None)
        if pin is None:
            raise KeyError(install_id)
        current = library.current_pin()
        if current is not None and current.key == pin.key:
            return self.game
        with self._lock:
            game = self._other_games.get(pin.key)
            if game is None:
                game = self._other_games[pin.key] = self._make_game(list(pin.dirs))
            return game

    def _spine_asset(self, kind: str, key: str, name: str) -> AssetResponse:
        game, core = self.game, key
        if kind in ("spr", "lobby") and "@" in key:
            # <core>@<id>: the core in another known install (its id in mods.state.installs)
            core, _, install_id = key.rpartition("@")
            game = self._install_game(install_id)
        if kind == "lobby" and name == "lobby.json":
            # the lobby's layout and interaction from its prefab and clip assets; no skeleton file has this name, and
            # it is answered without extracting (and PNG-encoding) the lobby's textures
            return _json(game.lobby_info(core), light=False)
        if kind == "lobby" and name.startswith("fx_") and name.endswith(".png"):
            # a texture of the lobby's particle effects (lobby.json fx.textures), read from the game files; any other
            # name is one of the skeletons' own files
            from ..gameassets import AssetNotFound

            try:
                return AssetResponse(game.lobby_fx_texture(core, name[3:-4]), "image/png", light=False)
            except AssetNotFound:
                pass
        if kind == "lobby" and name.startswith("sfx_") and name.endswith(".wav"):
            # a sound the lobby's clips play (lobby.json sounds), decoded from the game files in memory; any other
            # name is one of the skeletons' own files
            from ..gameassets import AssetNotFound

            try:
                return AssetResponse(game.lobby_sound(core, name[4:-4]), "audio/wav", light=False)
            except AssetNotFound:
                pass
        if kind in ("spr", "lobby"):
            files = game.spine_files(kind, core)
        elif kind == "mod":
            bundles = self.library.preview_bundles(key)
            files = game.spine_files_from(bundles)
            # the mod's own core names its skeleton (a lobby has more than one: the character and its background)
            core = parse_filename(bundles[-1].name).core
        else:
            raise KeyError(kind)
        if name == "files.json":
            return _json(sorted(files), light=False)
        data = files.get(name)
        if data is None:
            # "skeleton.skel" / "skeleton.atlas" stand for the one skeleton in the files
            suffix = Path(name).suffix
            if Path(name).stem == "skeleton":
                matches = [k for k in files if k.endswith(suffix)]
                named = [k for k in matches if Path(k).stem.lower() == core.lower()]
                pick = named or (matches if len(matches) == 1 else [])
                data = files[pick[0]] if pick else None
        if data is None:
            raise KeyError(name)
        return AssetResponse(data, MIME.get(Path(name).suffix, "application/octet-stream"), light=False)

    def close(self, wait: float | None = 600.0) -> None:
        if self.watch is not None:
            self.watch.stop()
        self.scanner.stop()
        self.classic.close()
        self.jobs.shutdown(wait=wait)
        self.events.close()


def _stem(name: str) -> str:
    for suffix in (".png", ".jpg", ".json", ".ogg", ".glb"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _json(data: Any, light: bool) -> AssetResponse:
    return AssetResponse(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                         "application/json", light)

