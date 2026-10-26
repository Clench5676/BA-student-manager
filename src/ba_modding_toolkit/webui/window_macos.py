"""M1: public AppKit standard buttons and native background dragging only."""

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
        self.overlay, self.monitor = None, None
        self.transition = False

    def _rect(self, button):
        view = self.window.contentView()
        frame = button.convertRect_toView_(button.bounds(), view)
        top = frame.origin.y if view.isFlipped() else view.bounds().size.height - frame.origin.y - frame.size.height
        return Rect(frame.origin.x, top, frame.origin.x + frame.size.width, top + frame.size.height)

    def install(self):
        api, window = self.api, self.window
        self.movable = window.isMovableByWindowBackground()
        for kind in (api.NSWindowCloseButton, api.NSWindowMiniaturizeButton, api.NSWindowZoomButton):
            button = window.standardWindowButton_(kind)
            if button is None:
                raise RuntimeError("AppKit standard window button missing")
            self.buttons.append(button)
            self.original.append((button.frame().origin, button.isHidden()))
            button.setHidden_(False)
        window.setMovableByWindowBackground_(True)
        owner = self.owner

        class ToolbarDragView(api.NSView):
            def isOpaque(self):
                return False

            def mouseDownCanMoveWindow(self):
                return True

            def hitTest_(self, point):
                # The view is never a responder for an App action, modal or native button.
                content = window.contentView()
                p = content.convertPoint_fromView_(point, self.superview())
                y = p.y if content.isFlipped() else content.bounds().size.height - p.y
                return self if any(r.contains(p.x, y) for r in owner.layout["drag"]) else None

        content = window.contentView()
        self.overlay = ToolbarDragView.alloc().initWithFrame_(content.bounds())
        self.overlay.setAutoresizingMask_(api.NSViewWidthSizable | api.NSViewHeightSizable)
        content.addSubview_(self.overlay)
        # NSView's standard mouseDown / NSWindow background handling owns dragging and
        # title-bar double-click. Do not read private preference keys or simulate zoom.
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
        if self.overlay is not None and self.overlay.superview() != content:
            self.overlay.removeFromSuperview()
            self.overlay.setFrame_(content.bounds())
            content.addSubview_(self.overlay)
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
        if self.overlay is not None:
            self.overlay.removeFromSuperview()
            self.overlay = None
        for button, (origin, hidden) in zip(self.buttons, self.original):
            button.setFrameOrigin_(origin)
            button.setHidden_(hidden)
        if hasattr(self, "movable"):
            self.window.setMovableByWindowBackground_(self.movable)
