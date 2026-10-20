"""The scan of the game folders (see docs/web-ui.md, "Scan"), on a thread of its own, never on the job worker.

- Only with the scan consent: ``allowed()`` is asked at each request and again before each scan, and a request
  without it is refused (``request`` returns ``None``). The library refuses on its own too (``scan_off``).
- One scan at a time. Requests coalesce: requests made while a scan runs are served by one scan after it, and a
  request for the dismissed entries too (Settings' Check) widens the next scan.
- ``cancel()`` cancels the running scan (a game folder change, a library move); its result is dropped, and the caller
  requests a new one.
- A stale result (the library wrote while the files were read) is scanned again once when no writer job runs; while
  one runs it is dropped, and the scan after that job replaces it.
- A daemon thread: it never holds up closing, quitting, a library move or a services rebuild.

``scan(cancel, dismissed)`` runs one scan (the library's ``scan`` with the pins of the known installs) and returns its
``ScanResult``; ``on_done(result, served)`` runs after every attempt, ``result`` being ``None`` when nothing was
kept, and ``served`` the number of the last request the attempt served (``request`` returns each request's number).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from ..errors import ServiceError

logger = logging.getLogger(__name__)


class Scanner:
    def __init__(self, scan: Callable[[Callable[[], bool], bool], Any], *, allowed: Callable[[], bool],
                 writer_busy: Callable[[], bool] = lambda: False,
                 on_done: Callable[[Any, int], Any] | None = None):
        self._scan = scan
        self._allowed = allowed
        self._writer_busy = writer_busy
        self._on_done = on_done
        self._cond = threading.Condition()
        self._requested = 0  # the number of the last request
        self._served = 0  # the number of the last request a finished attempt served
        self._dismissed = False  # a pending request wants the dismissed entries too
        self._cores: set[str] | None = None
        self._generation = 0  # bumped by cancel(): a scan of an older generation is dropped
        self._running = False
        self._invalidated = False
        self._stopped = False
        self._thread: threading.Thread | None = None

    # --- requests ---

    def request(self, dismissed: bool = False, *, cores: set[str] | None = None) -> int | None:
        """Ask for a scan; its number, or ``None`` without the scan consent (nothing is queued then)."""
        if not self._is_allowed():
            return None
        with self._cond:
            if self._stopped:
                return None
            if self._requested == self._served:
                self._cores = cores
            elif self._cores is not None:
                self._cores = None if cores is None else self._cores | cores
            self._requested += 1
            self._dismissed = self._dismissed or bool(dismissed)
            number = self._requested
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="bamt-scan", daemon=True)
                self._thread.start()
            self._cond.notify_all()
            return number

    def cancel(self) -> None:
        """Cancel the running scan; its result is dropped. Requests not served yet stay."""
        with self._cond:
            self._generation += 1
            self._cond.notify_all()

    def clear(self) -> None:
        """Drop the requests not served yet and cancel the running scan (the consent was withdrawn)."""
        with self._cond:
            self._served = self._requested
            self._dismissed = False
            self._generation += 1
            self._cond.notify_all()

    @property
    def running(self) -> bool:
        with self._cond:
            return self._running

    @property
    def invalidated(self) -> bool:
        """A stale scan still needs replacing, even if its attempt already finished."""
        with self._cond:
            return self._invalidated

    def served(self) -> int:
        """The number of the last request a finished attempt served."""
        with self._cond:
            return self._served

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Wait until no scan runs and no request waits; whether it got there in time."""
        with self._cond:
            return self._cond.wait_for(lambda: not self._running and self._served >= self._requested, timeout)

    def stop(self) -> None:
        with self._cond:
            self._stopped = True
            self._generation += 1
            self._cond.notify_all()

    def _is_allowed(self) -> bool:
        try:
            return bool(self._allowed())
        except Exception:
            logger.warning("cannot read the scan consent", exc_info=True)
            return False

    # --- the thread ---

    def _run(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._stopped or self._requested > self._served)
                if self._stopped:
                    return
                serving, dismissed, cores = self._requested, self._dismissed, self._cores
                if dismissed:
                    cores = None  # a scan for the dismissed entries covers everything
                self._dismissed = False
                self._cores = set()
                generation = self._generation
                self._running = True
            result = None
            try:
                result = self._attempt(generation, dismissed, cores)
            finally:
                with self._cond:
                    self._running = False
                    self._served = max(self._served, serving)
                    self._cond.notify_all()
                if self._on_done is not None:
                    try:
                        self._on_done(result, serving)
                    except Exception:
                        logger.exception("scan result handler failed")

    def _attempt(self, generation: int, dismissed: bool, cores: set[str] | None = None) -> Any:
        """One scan, again once when it is stale and no writer job runs; ``None`` when nothing is kept."""
        for attempt in (1, 2):
            if not self._is_allowed():
                return None

            def cancelled() -> bool:
                with self._cond:
                    return self._stopped or self._generation != generation

            try:
                result = self._scan(cancelled, dismissed) if cores is None else self._scan(cancelled, dismissed, cores)
            except ServiceError as error:
                if error.code != "scan_off":
                    logger.warning("scan failed: %s", error.code)
                return None
            except Exception:
                logger.exception("scan failed")
                return None
            if cancelled():
                logger.debug("scan cancelled")
                return None
            if result is None or not getattr(result, "stale", False):
                if result is not None:
                    with self._cond:
                        self._invalidated = False
                return result
            with self._cond:
                self._invalidated = True
            if attempt == 1 and not self._writer_busy():
                logger.debug("scan stale, scanning again")
                continue
            logger.debug("scan stale while the library writes: dropped")
            return None
        return None
