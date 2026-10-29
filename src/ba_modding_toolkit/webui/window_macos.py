"""M1: public AppKit standard buttons and window-scoped native drag events."""

from __future__ import annotations

from .window_chrome import Rect, union, vertical_offsets


class CocoaHost:
    def __init__(self, window, owner, *, api=None, dispatch=None):
        if api is None:
            import AppKit as api
        if dispatch is None:
            from PyObjCTools import AppHelper
            dispatch = AppHelper.callAfter
        self.api, self.dispatch = api, dispatch
        self.window, self.owner = window.native, owner
        self.buttons, self.original, self.observers = [], [], []
        self.monitor = None
        self.transition = False

    def mouse_down(self, event):
        # A local monitor runs before WKWebView hit testing, including after Cocoa
        # replaces contentView. Rectangles arrive in viewport CSS pixels (AppKit points).
        if event.window() != self.window or not self.owner.active or not self.owner.valid or self.transition:
            return event
        content = self.window.contentView()
        point = content.convertPoint_fromView_(event.locationInWindow(), None)
        bounds = content.bounds()
        x = point.x - bounds.origin.x
        y = point.y - bounds.origin.y if content.isFlipped() else bounds.origin.y + bounds.size.height - point.y
        if not any(r.contains(x, y) for r in self.owner.layout["drag"]):
            return event
        if event.clickCount() == 2:
            action = self.api.NSUserDefaults.standardUserDefaults().stringForKey_("AppleActionOnDoubleClick")
            if action == "Minimize":
                self.window.performMiniaturize_(None)
            elif action not in ("None", "Do Nothing"):
                self.window.performZoom_(None)
        else:
            self.window.performWindowDragWithEvent_(event)
        return None

    def _rect(self, button):
        view = self.window.contentView()
        frame = button.convertRect_toView_(button.bounds(), view)
        top = frame.origin.y if view.isFlipped() else view.bounds().size.height - frame.origin.y - frame.size.height
        return Rect(frame.origin.x, top, frame.origin.x + frame.size.width, top + frame.size.height)

    def install(self):
        api, window = self.api, self.window
        # This content policy is independent of M1 button alignment/rollback.
        # AppKit applies it to interactive resizing, leaving fullscreen to the OS.
        window.setContentAspectRatio_((16, 9))
        for kind in (api.NSWindowCloseButton, api.NSWindowMiniaturizeButton, api.NSWindowZoomButton):
            button = window.standardWindowButton_(kind)
            if button is None:
                raise RuntimeError("AppKit standard window button missing")
            self.buttons.append(button)
            self.original.append((button.frame().origin, button.isHidden()))
            button.setHidden_(False)
        self.monitor = api.NSEvent.addLocalMonitorForEventsMatchingMask_handler_(api.NSEventMaskLeftMouseDown, self.mouse_down)
        centre = api.NSNotificationCenter.defaultCenter()
        for name in ("NSWindowDidResizeNotification", "NSWindowDidMoveNotification", "NSWindowDidBecomeKeyNotification",
                     "NSWindowDidResignKeyNotification", "NSWindowDidMiniaturizeNotification", "NSWindowDidDeminiaturizeNotification",
                     "NSWindowWillEnterFullScreenNotification", "NSWindowWillExitFullScreenNotification",
                     "NSWindowDidEnterFullScreenNotification", "NSWindowDidExitFullScreenNotification"):
            def changed(note, name=name):
                if "Will" in name:
                    self.transition = True
                elif "FullScreen" in name:
                    self.transition = False
                self.owner.refresh()
            self.observers.append(centre.addObserverForName_object_queue_usingBlock_(getattr(api, name), window, None, changed))

    def state(self):
        return {"maximized": bool(self.window.isZoomed()), "minimized": bool(self.window.isMiniaturized()),
                "fullscreen": bool(self.window.styleMask() & self.api.NSWindowStyleMaskFullScreen)}

    def measure(self, layout):
        content = self.window.contentView()
        if self.window.isMiniaturized() or self.transition:
            return None
        if not self.state()["fullscreen"]:
            before = [self._rect(button) for button in self.buttons]
            targets = vertical_offsets(before, layout["centre"])
            for button, source, target in zip(self.buttons, before, targets):
                frame, parent = button.frame(), button.superview()
                dy = target.top - source.top
                button.setFrameOrigin_((frame.origin.x, frame.origin.y + (dy if parent.isFlipped() else -dy)))
                frame, bounds = button.frame(), parent.bounds()
                if not self.api.NSContainsRect(bounds, frame):
                    raise RuntimeError("M1 button would be clipped by its AppKit container")
            after = [self._rect(button) for button in self.buttons]
            for source, target, actual in zip(before, targets, after):
                if abs(source.left - actual.left) > .5 or abs(target.top - actual.top) > .5:
                    raise RuntimeError("M1 AppKit relayout rejected vertical button alignment")
        # Fullscreen visibility/reveal belongs to AppKit; never force buttons visible there.
        visible = [self._rect(button) for button in self.buttons]
        return union(visible) if visible else None

    def command(self, action):
        selectors = {"minimize": self.window.performMiniaturize_, "maximize": self.window.performZoom_,
                     "fullscreen": self.window.toggleFullScreen_}
        selectors[action](None)

    def dispose(self):
        centre = self.api.NSNotificationCenter.defaultCenter()
        for observer in self.observers:
            centre.removeObserver_(observer)
        self.observers.clear()
        if self.monitor is not None:
            self.api.NSEvent.removeMonitor_(self.monitor)
            self.monitor = None
        for button, (origin, hidden) in zip(self.buttons, self.original):
            button.setFrameOrigin_(origin)
            button.setHidden_(hidden)
