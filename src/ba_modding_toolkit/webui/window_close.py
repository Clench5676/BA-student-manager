"""One asynchronous draft preflight for all cancellable desktop exit routes."""

from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import Future

from ..errors import ServiceError

logger = logging.getLogger(__name__)


class CloseCoordinator:
    """Never wait for JavaScript on the GUI thread; reserve writers only after Save and Leave.

    The page freezes input after approval until closed or cancelled. A unique request token
    prevents a late promise from authorizing a newer close. Updates own their reservation.
    """

    def __init__(self, services, close, *, prompt_wait=120, close_wait=3, page_loaded=True):
        self.services, self.close = services, close
        self.prompt_wait, self.close_wait = prompt_wait, close_wait
        self._lock = threading.RLock()
        self._pending = None
        self._closed = threading.Event()
        self.permitted = False
        self.page_loaded = page_loaded

    def request(self, final=None, *, reserve=True, cancelled=lambda: None):
        with self._lock:
            if self._pending is not None:
                return self._pending
            if self.services.jobs.busy():
                self.services.events.publish("app.busy")
                future = Future()
                future.set_exception(ServiceError("busy"))
                return future
            future = self._pending = Future()
        threading.Thread(target=self._run, args=(future, final or self.close, reserve, cancelled),
                         name="window-close", daemon=True).start()
        return future

    def _page_call(self, expression):
        answered = threading.Event()
        result = []

        def answer(value):
            result.append(value)
            answered.set()

        def evaluate():
            try:
                # Before the module loads there is no Hall editor. Always return a Promise:
                # pywebview invokes the callback only for a promise, not an immediate value.
                self.services.window.evaluate_js("Promise.resolve(" + expression + ")", answer)
            except Exception:
                logger.warning("Window close preflight unavailable", exc_info=True)
                answered.set()

        threading.Thread(target=evaluate, name="window-close-page", daemon=True).start()
        return answered.wait(self.prompt_wait) and result == [True]

    def _run(self, future, final, reserve, cancelled):
        token, owned, success, failure = uuid.uuid4().hex, False, False, None
        try:
            needs_page = self.page_loaded
            if needs_page and not self._page_call(f"globalThis.bamtPrepareClose ? globalThis.bamtPrepareClose('{token}') : true"):
                return
            if reserve:
                with self.services.classic.starting():
                    self.services.jobs.reserve_quit()
                    owned = True
            elif self.services.jobs.busy():
                raise ServiceError("busy")
            if needs_page and not self._page_call(f"globalThis.bamtValidateClose ? globalThis.bamtValidateClose('{token}') : true"):
                return
            with self._lock:
                self.permitted = True
            final()
            success = self._closed.wait(self.close_wait)
        except Exception as error:
            if isinstance(error, ServiceError) and error.code == "busy":
                self.services.events.publish("app.busy")
            failure = error
        finally:
            if not success:
                with self._lock:
                    self.permitted = False
                if owned:
                    self.services.jobs.cancel_quit()
                cancelled()
                # A blocked renderer cannot block releasing writer admission or a new request.
                def thaw():
                    try:
                        self.services.window.evaluate_js(f"globalThis.bamtCancelClose?.('{token}')")
                    except Exception:
                        logger.debug("Window close cancellation unavailable", exc_info=True)
                threading.Thread(target=thaw, name="window-close-cancel", daemon=True).start()
            with self._lock:
                self._pending = None
            if not future.done():
                if failure is not None:
                    future.set_exception(failure)
                else:
                    future.set_result(success)

    def native_closing(self):
        with self._lock:
            if self.permitted:
                return True
        self.request()
        return False

    def closed(self):
        self._closed.set()
