"""Native chrome lifecycle and CSS-pixel geometry, with injectable platform hosts."""

from __future__ import annotations

import logging
import math
import sys
from dataclasses import asdict, dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Rect:
    left: float
    top: float
    right: float
    bottom: float

    @property
    def valid(self):
        return all(math.isfinite(v) for v in asdict(self).values()) and self.right > self.left and self.bottom > self.top

    def contains(self, x, y):
        return self.left <= x < self.right and self.top <= y < self.bottom


def union(rects):
    if not rects or not all(rect.valid for rect in rects):
        raise ValueError("Native control bounds unavailable")
    return Rect(min(r.left for r in rects), min(r.top for r in rects),
                max(r.right for r in rects), max(r.bottom for r in rects))


def vertical_offsets(rects, centre):
    """Preserve each real button's x, size and spacing; translate the group vertically."""
    bounds = union(rects)
    delta = centre - (bounds.top + bounds.bottom) / 2
    return [Rect(r.left, r.top + delta, r.right, r.bottom + delta) for r in rects]


class WindowChrome:
    def __init__(self, window, events, *, platform=sys.platform, host=None):
        self.window, self.events, self.platform, self.host = window, events, platform, host
        self.active = False
        self.reason = "not-installed"
        self.bounds = None
        self.valid = False
        self.state = {"maximized": False, "fullscreen": False, "minimized": False}
        self.layout = {"centre": 22, "height": 48, "drag": []}
        self.sequence = 0

    def install(self):
        try:
            if self.host is None:
                if self.platform == "darwin":
                    from .window_macos import CocoaHost
                    self.host = CocoaHost(self.window, self)
                elif self.platform == "win32":
                    from .window_windows import WindowsHost
                    self.host = WindowsHost(self.window, self)
                else:
                    self.reason = "unsupported-host"
                    return
            self.host.install()
            self.active = True
            self.reason = ""
            self.refresh()
        except Exception as error:
            self.fail(error)

    def fail(self, error):
        logger.warning("Native window chrome inactive: %s", error, exc_info=True)
        if self.host:
            self.host.dispose()
        self.active, self.valid = False, False
        self.bounds = None
        self.reason = str(error)
        self.publish()

    def snapshot(self):
        return {"active": self.active, "platform": self.platform, "reason": self.reason,
                "mode": "standard" if self.platform == "win32" else "integrated",
                "bounds": asdict(self.bounds) if self.bounds else None, "valid": self.valid,
                "state": dict(self.state), "sequence": self.sequence}

    def publish(self):
        self.sequence += 1
        self.events.publish("window.chrome", self.snapshot())

    def refresh(self):
        if not self.active:
            return
        try:
            self.state = self.host.state()
            bounds = self.host.measure(self.layout)
            self.valid = self.platform == "win32" or (bounds is not None and bounds.valid)
            if self.valid:
                self.bounds = bounds
            self.publish()
        except Exception as error:
            self.fail(error)

    def update(self, centre, height, drag):
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                   for v in (centre, height)) or not 0 < centre < height <= 512:
            raise ValueError("Invalid toolbar geometry")
        if not isinstance(drag, list) or len(drag) > 64:
            raise ValueError("Invalid toolbar drag regions")
        regions = [Rect(**rect) for rect in drag]
        if any(not rect.valid or rect.top < 0 or rect.bottom > height or rect.left < 0 for rect in regions):
            raise ValueError("Invalid toolbar drag region")
        self.layout = {"centre": centre, "height": height, "drag": regions}
        if self.active:
            self.host.dispatch(self.refresh)

    def command(self, action):
        if self.active:
            self.host.dispatch(lambda: self.host.command(action))
        elif action == "minimize":
            self.window.minimize()
        elif action == "fullscreen":
            self.window.toggle_fullscreen()
        elif self.state["maximized"]:
            self.window.restore()
        else:
            self.window.maximize()

    def fallback_state(self, key, value):
        if self.active:
            self.host.dispatch(self.refresh)
        elif self.host is not None:
            def read_state():
                self.state = self.host.state()
                self.publish()
            self.host.dispatch(read_state)
        else:
            self.state[key] = value
            if key == "maximized":
                self.state["minimized"] = False
            self.publish()

    def close(self):
        # Cocoa destroy() skips its delegate. performClose: preserves that delegate.
        if self.platform == "darwin" and getattr(self.window, "native", None) is not None:
            from PyObjCTools import AppHelper
            AppHelper.callAfter(self.window.native.performClose_, None)
        else:
            self.window.destroy()

    def dispose(self):
        if self.host:
            self.host.dispose()
