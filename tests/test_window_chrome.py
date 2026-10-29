"""Native requests and coordinate contracts, without creating a window or loading a GUI backend."""

import ctypes
import sys
import threading
from contextlib import nullcontext
from types import SimpleNamespace as NS

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.jobs import JobRunner
from ba_modding_toolkit.webui.window_chrome import Rect, WindowChrome, union, vertical_offsets
from ba_modding_toolkit.webui.window_close import CloseCoordinator
from ba_modding_toolkit.webui.window_macos import CocoaHost
from ba_modding_toolkit.webui.window_windows import WindowsHost, aspect_rect, WM_SIZING, WM_DPICHANGED


class Host:
    def __init__(self):
        self.bounds = Rect(12, 16, 80, 30)
        self.current = dict(maximized=False, fullscreen=False, minimized=False)
        self.calls = []

    def install(self):
        self.calls.append('install')

    def dispatch(self, fn):
        self.calls.append('dispatch')
        fn()

    def measure(self, layout):
        self.calls.append(('measure', layout))
        if isinstance(self.bounds, Exception):
            raise self.bounds
        return self.bounds

    def state(self):
        return self.current.copy()

    def command(self, action):
        self.calls.append(action)

    def dispose(self):
        self.calls.append('dispose')


def test_vertical_translation_preserves_horizontal_frames_and_group_centre():
    rects = [Rect(12, 8, 26, 22), Rect(32, 9, 46, 21), Rect(52, 8, 66, 22)]
    for centre in [20.32, 24.635, 29.5619, 44.3428]:
        moved = vertical_offsets(rects, centre)
        bounds = union(moved)
        assert (bounds.top + bounds.bottom) / 2 == pytest.approx(centre)
        for old, new in zip(rects, moved):
            assert (new.left, new.right, new.bottom - new.top) == (old.left, old.right, old.bottom - old.top)
    with pytest.raises(ValueError):
        union([Rect(0, 0, float('nan'), 1)])


def test_adapter_keeps_last_valid_safe_area_and_fails_back_after_relayout_failure():
    host = Host()
    chrome = WindowChrome(NS(), EventBus(), platform='darwin', host=host)
    chrome.install()
    previous = chrome.bounds
    host.bounds = None
    chrome.refresh()
    assert chrome.active and not chrome.valid and chrome.bounds == previous
    host.bounds = RuntimeError('AppKit relayout rejected vertical alignment')
    chrome.refresh()
    assert not chrome.active and chrome.bounds is None
    assert 'relayout' in chrome.reason and host.calls[-1] == 'dispose'


def test_native_events_are_authoritative_for_zoom_fullscreen_and_commands():
    host = Host()
    chrome = WindowChrome(NS(), EventBus(), host=host)
    chrome.install()
    for current in [dict(maximized=True, fullscreen=False, minimized=False),
                    dict(maximized=False, fullscreen=True, minimized=False)]:
        host.current = current
        chrome.fallback_state('maximized', False)
        assert chrome.snapshot()['state'] == current
    chrome.command('maximize')
    assert host.calls[-2:] == ['dispatch', 'maximize']
    chrome.update(24.6, 53.3, [dict(left=90, top=0, right=150, bottom=50)])
    assert chrome.layout['drag'] == [Rect(90, 0, 150, 50)]
    for bad in [float('nan'), -1, 900, True]:
        with pytest.raises(ValueError):
            chrome.update(bad, 44, [])


def test_unsupported_host_is_deliberate_and_fallback_maximize_uses_events():
    calls = []
    window = NS(maximize=lambda: calls.append('maximize'), restore=lambda: calls.append('restore'))
    chrome = WindowChrome(window, EventBus(), platform='unsupported')
    chrome.install()
    assert not chrome.active and chrome.reason == 'unsupported-host'
    chrome.fallback_state('maximized', True)
    chrome.command('maximize')
    chrome.fallback_state('maximized', False)
    chrome.command('maximize')
    assert calls == ['restore', 'maximize'] and not hasattr(window, 'maximized')


def rect(x, y, w, h):
    return NS(origin=NS(x=x, y=y), size=NS(width=w, height=h))


class Button:
    def __init__(self, x, y, flipped, container_height=200):
        self.value, self.hidden = rect(x, y, 14, 14), False
        self.parent = NS(isFlipped=lambda: flipped, bounds=lambda: rect(0, 0, 200, container_height))

    def frame(self):
        return self.value

    def bounds(self):
        return rect(0, 0, 14, 14)

    def superview(self):
        return self.parent

    def convertRect_toView_(self, bounds, view):
        return self.value

    def setFrameOrigin_(self, point):
        self.value.origin = point if hasattr(point, "x") else NS(x=point[0], y=point[1])

    def isHidden(self):
        return self.hidden


@pytest.mark.parametrize('flipped', [True, False])
def test_cocoa_moves_only_y_and_leaves_fullscreen_reveal_to_appkit(flipped):
    host = CocoaHost.__new__(CocoaHost)
    host.api = NS(NSContainsRect=lambda outer, inner: inner.origin.y >= 0 and inner.origin.y + inner.size.height <= outer.size.height,
                  NSWindowStyleMaskFullScreen=1 << 14)
    state = {'fullscreen': False, 'mini': False}
    content = NS(isFlipped=lambda: flipped, bounds=lambda: rect(0, 0, 200, 200))
    host.window = NS(contentView=lambda: content, isMiniaturized=lambda: state['mini'], isZoomed=lambda: False,
                     styleMask=lambda: 1 << 14 if state['fullscreen'] else 0)
    host.transition = False
    host.buttons = [Button(x, 8 if flipped else 178, flipped) for x in [12, 32, 52]]
    bounds = host.measure({'centre': 29.5619})
    assert (bounds.top + bounds.bottom) / 2 == pytest.approx(29.5619)
    assert [b.frame().origin.x for b in host.buttons] == [12, 32, 52]
    state['fullscreen'] = True
    host.buttons[0].hidden = True
    before = [b.frame().origin.y for b in host.buttons]
    host.measure({'centre': 80})
    assert [b.frame().origin.y for b in host.buttons] == before
    host.transition = True
    assert host.measure({'centre': 30}) is None
    host.transition = False
    state.update(fullscreen=False, mini=True)
    assert host.measure({'centre': 30}) is None
    state['mini'] = False
    host.buttons[0].parent.bounds = lambda: rect(0, 0, 200, 22)
    with pytest.raises(RuntimeError, match='clipped'):
        host.measure({'centre': 40})


class Hook:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self

    def __isub__(self, fn):
        self.handlers.remove(fn)
        return self


def test_windows_standard_caption_does_not_access_or_clip_webview_or_extend_frame(windows_host):
    # No WebView2, DWM or style setter is supplied. Installation precedes navigation.
    host = windows_host.host
    form = host.form
    chrome = WindowChrome(host.window, EventBus(), platform='win32', host=host)
    host.owner = chrome
    chrome.install()
    assert chrome.active and chrome.valid
    assert chrome.snapshot()['mode'] == 'standard' and chrome.bounds is None
    assert len(form.Resize.handlers) == len(form.DpiChanged.handlers) == 1
    form.WindowState = 'Maximized'
    form.Resize.handlers[0]()
    assert chrome.state['maximized']
    chrome.dispose()
    assert not form.Resize.handlers and not form.DpiChanged.handlers


def test_windows_standard_caption_survives_adapter_failure_without_html_fallback():
    host = Host()
    host.bounds = RuntimeError('native adapter failed')
    chrome = WindowChrome(NS(), EventBus(), platform='win32', host=host)
    chrome.install()
    assert not chrome.active and chrome.snapshot()['mode'] == 'standard'


@pytest.fixture
def closer():
    bus = EventBus()
    services = NS(jobs=JobRunner(bus), events=bus, classic=NS(starting=nullcontext))
    callbacks, calls = [], []
    def evaluate(script, callback=None):
        if callback and 'bamtValidateClose' in script:
            callback(True)
        elif callback:
            callbacks.append(callback)
            requested.set()
        else:
            calls.append('thaw')
            thawed.set()
    requested, thawed = threading.Event(), threading.Event()
    services.window = NS(evaluate_js=evaluate)
    coordinator = CloseCoordinator(services, lambda: (calls.append('close'), coordinator.closed()), prompt_wait=.1, close_wait=.01)
    yield NS(s=services, api=coordinator, callbacks=callbacks, calls=calls, requested=requested, thawed=thawed)
    services.jobs.shutdown(wait=1)


def test_native_requests_coalesce_and_reserve_only_after_draft_preflight(closer):
    c = closer
    assert c.api.native_closing() is False
    future = c.api.request()
    assert c.requested.wait(1)
    assert c.api.request() is future
    # Save and Leave may still submit its library writer while the prompt is open.
    writer = c.s.jobs.submit('save', lambda log, progress: None, writes='library')
    assert c.s.jobs.wait(writer, 1)
    c.callbacks[0](True)
    assert future.result(1) is True
    assert c.calls == ['close'] and c.api.native_closing() is True
    with pytest.raises(ServiceError, match='busy'):
        c.s.jobs.submit('late', lambda log, progress: None, writes='game')


@pytest.mark.parametrize('answer', [False, {'message': 'save failed'}, None])
def test_stay_save_failure_and_unresponsive_page_cancel_and_release(closer, answer):
    c = closer
    future = c.api.request()
    assert c.requested.wait(1)
    if answer is not None: c.callbacks[0](answer)
    assert future.result(1) is False
    assert c.thawed.wait(1)
    assert c.calls == ['thaw'] and not c.api.permitted
    c.s.jobs.reserve_quit(); c.s.jobs.cancel_quit()
    # An old permission arriving after timeout cannot destroy the window.
    c.callbacks[0](True)
    assert 'close' not in c.calls


def test_writer_arriving_during_prompt_refuses_final_close(closer):
    c = closer
    future = c.api.request()
    assert c.requested.wait(1)
    gate = threading.Event()
    writer = c.s.jobs.submit('writer', lambda log, progress: gate.wait(1), writes='game')
    try:
        c.callbacks[0](True)
        with pytest.raises(ServiceError, match='busy'): future.result(1)
        assert 'close' not in c.calls
    finally:
        gate.set(); assert c.s.jobs.wait(writer, 1)
    c.s.jobs.reserve_quit(); c.s.jobs.cancel_quit()


@pytest.mark.parametrize('refusal', ['silent', 'exception'])
def test_native_refusal_revokes_permit_and_owned_reservation(closer, refusal):
    c = closer
    def close():
        if refusal == 'exception': raise RuntimeError('host refused')
    future = c.api.request(close)
    assert c.requested.wait(1)
    c.callbacks[0](True)
    if refusal == 'exception':
        with pytest.raises(RuntimeError): future.result(1)
    else: assert future.result(1) is False
    assert not c.api.permitted
    c.s.jobs.reserve_quit(); c.s.jobs.cancel_quit()


def test_foreign_update_reservation_is_never_released_by_close_coordinator(closer):
    c = closer
    future = c.api.request(lambda: None, reserve=False)
    assert c.requested.wait(1)
    c.s.jobs.reserve_quit()
    c.callbacks[0](True)
    assert future.result(1) is False
    with pytest.raises(ServiceError, match='busy'): c.s.jobs.reserve_quit()
    c.s.jobs.cancel_quit()


def test_startup_without_a_loaded_editor_closes_without_waiting_for_assets(closer):
    c = closer
    c.api.page_loaded = False
    assert c.api.request().result(1) is True
    assert not c.requested.is_set() and c.calls == ['close']


def test_new_draft_revision_invalidates_permission_and_releases_reservation(closer):
    c = closer
    original = c.s.window.evaluate_js
    def evaluate(script, callback=None):
        if callback and 'bamtValidateClose' in script:
            callback(False)
        else: original(script, callback)
    c.s.window.evaluate_js = evaluate
    future = c.api.request()
    assert c.requested.wait(1)
    c.callbacks[0](True)
    assert future.result(1) is False
    assert not c.api.permitted and 'close' not in c.calls
    c.s.jobs.reserve_quit(); c.s.jobs.cancel_quit()


def test_windows_subclass_retains_callback_forwards_and_cleans_up():
    from ba_modding_toolkit.webui.window_windows import WindowSubclass
    class Function:
        def __init__(self, fn): self.fn = fn
        def __call__(self, *args): return self.fn(*args)
    calls = []
    api = NS(SetWindowSubclass=Function(lambda *args: calls.append(('install', args)) or True),
             RemoveWindowSubclass=Function(lambda *args: calls.append(('remove', args))),
             DefSubclassProc=Function(lambda *args: calls.append(('default', args)) or 42))
    errors = []
    def message(code, wparam, lparam, default):
        if code == 7: raise RuntimeError('message failed')
        if code == 8:
            default()
            raise RuntimeError('post-default policy failed')
        return default()
    hook = WindowSubclass(123, message, errors.append, api=api, callback_type=lambda *signature: lambda fn: fn)
    assert hook.callback(123, 1, 2, 3, hook.identifier, 0) == 42
    assert hook.callback(123, 7, 2, 3, hook.identifier, 0) == 42
    assert hook.callback(123, 8, 2, 3, hook.identifier, 0) == 42
    hook.dispose()
    assert [item[0] for item in calls] == ['install','default','default','default','remove']
    assert len(errors) == 2
    assert calls[0][1][1] is calls[-1][1][1] is hook.callback


def test_macos_keyboard_and_edit_menu_restore_after_rebuild_without_timer(monkeypatch):
    from ba_modding_toolkit.webui.native import install_window_commands
    class Object:
        @classmethod
        def alloc(cls): return cls()
        def init(self): return self
    class Item(Object):
        def __init__(self): self.menu = None
        def setSubmenu_(self, menu): self.menu = menu
        def setTitle_(self, title): self.title = title
        def submenu(self): return self.menu
        def action(self): return self.selector
        def setAction_(self, selector): self.selector = selector
        def setTarget_(self, target): self.target = target
    class Menu(Object):
        def __init__(self): self.items = []
        def initWithTitle_(self, title): self.title = title; return self
        def itemArray(self): return self.items
        def addItem_(self, item): self.items.append(item)
        def addItemWithTitle_action_keyEquivalent_(self, title, selector, key):
            item = Item(); item.title, item.selector, item.key = title, selector, key
            self.items.append(item); return item
    def app_menu():
        main, app = Menu(), Menu()
        item = Item(); item.setSubmenu_(app); main.addItem_(item)
        quit_item = app.addItemWithTitle_action_keyEquivalent_('Quit', 'terminate:', 'q')
        return main, quit_item
    monitors, removed, calls, observers, deferred = [], [], [], [], []
    current = {"main": None}
    def observe(name, obj, queue, fn):
        assert name == 'became-key' and obj is window and queue is None
        observers.append(fn)
        return fn
    centre = NS(addObserverForName_object_queue_usingBlock_=observe, removeObserver_=removed.append)
    # No NSTimer is provided: using one fails this test immediately.
    api = NS(NSObject=Object, NSMenu=Menu, NSMenuItem=Item,
             NSApplication=NS(sharedApplication=lambda: NS(mainMenu=lambda: current["main"])),
             NSNotificationCenter=NS(defaultCenter=lambda: centre), NSWindowDidBecomeKeyNotification='became-key',
             NSEvent=NS(addLocalMonitorForEventsMatchingMask_handler_=lambda mask, fn: monitors.append(fn) or fn,
                        removeMonitor_=removed.append), NSEventMaskKeyDown=1,
             NSEventModifierFlagCommand=1, NSEventModifierFlagShift=2,
             NSEventModifierFlagOption=4, NSEventModifierFlagControl=8)
    monkeypatch.setitem(sys.modules, 'AppKit', api)
    monkeypatch.setitem(sys.modules, 'PyObjCTools', NS(AppHelper=NS(callAfter=deferred.append)))
    window = NS(performMiniaturize_=lambda sender: calls.append('minimize'),
                toggleFullScreen_=lambda sender: calls.append('fullscreen'))
    services = NS(window=NS(native=window), quit=lambda: calls.append('guarded-close'))
    cleanup = install_window_commands(services, None)
    assert len(deferred) == 1, 'first_show repair runs after pywebview creates its menu'
    main, quit_item = app_menu(); current["main"] = main
    deferred.pop(0)(); cleanup.refresh()
    def assert_menu(main, quit_item):
        assert len(main.items) == 2, 'only App and Edit; no Window menu or duplicates'
        assert [item.selector for item in main.items[1].submenu().items] == ['cut:', 'copy:', 'paste:', 'selectAll:']
        assert [item.key for item in main.items[1].submenu().items] == ['x', 'c', 'v', 'a']
        assert quit_item.selector == 'closeWindow:'
    assert_menu(main, quit_item)
    target = quit_item.target
    target.closeWindow_(None)
    for char, flags in [('q',1),('w',1),('m',1),('f',9)]:
        event = NS(window=lambda: window, modifierFlags=lambda: flags, charactersIgnoringModifiers=lambda: char)
        assert monitors[0](event) is None
    for char, flags, event_window in [('c',1,window),('q',3,window),('w',5,window),('q',9,window),('m',9,window),('q',1,object())]:
        event = NS(window=lambda: event_window, modifierFlags=lambda: flags, charactersIgnoringModifiers=lambda: char)
        assert monitors[0](event) is event
    assert calls == ['guarded-close','guarded-close','guarded-close','minimize','fullscreen']
    def busy():
        raise ServiceError('busy')
    services.quit = busy
    services.events = NS(publish=lambda event: calls.append(event))
    event = NS(window=lambda: window, modifierFlags=lambda: 1, charactersIgnoringModifiers=lambda: 'q')
    assert monitors[0](event) is None
    assert calls[-1] == 'app.busy'
    # Observer delivery may precede the pywebview delegate's menu rebuild.
    # Neither replacing the whole menu nor clearing it in place may lose Edit/Quit.
    for replace in [True, False]:
        observers[0](None)
        rebuilt, quit_item = app_menu()
        if replace:
            current["main"] = rebuilt
        else:
            current["main"].items[:] = rebuilt.items
        assert quit_item.selector == 'terminate:', 'repair must be deferred beyond the delegate'
        deferred.pop(0)()
        assert_menu(current["main"], quit_item)
        assert quit_item.target is target
        observers[0](None); deferred.pop(0)()
        assert_menu(current["main"], quit_item)
    observers[0](None)
    cleanup()
    assert removed == observers + monitors
    current["main"], quit_item = app_menu()
    deferred.pop(0)()
    assert quit_item.selector == 'terminate:', 'queued callbacks become inert after disposal'


@pytest.fixture
def cocoa_drag():
    calls, keys = [], []
    host = CocoaHost.__new__(CocoaHost)
    host.owner = NS(active=True, valid=True, layout={"drag": [Rect(90, 0, 150, 44)]})
    host.transition = False
    state = {"flipped": False, "action": None}
    # A nonzero bounds origin and a changed content view exercise the conversion,
    # rather than assuming locationInWindow already uses web coordinates.
    def content():
        return NS(bounds=lambda: rect(10, 20, 960, 540), isFlipped=lambda: state["flipped"],
                  convertPoint_fromView_=lambda point, source: NS(x=point.x + 10, y=point.y + 20))
    host.window = NS(contentView=content, performWindowDragWithEvent_=lambda event: calls.append("drag"),
                     performMiniaturize_=lambda sender: calls.append("minimize"),
                     performZoom_=lambda sender: calls.append("zoom"))
    def preference(key):
        keys.append(key)
        return state["action"]
    host.api = NS(NSUserDefaults=NS(standardUserDefaults=lambda: NS(stringForKey_=preference)))
    def event(x=100, y=10, count=1, window=None):
        return NS(window=lambda: window or host.window, clickCount=lambda: count,
                  locationInWindow=lambda: NS(x=x, y=y if state["flipped"] else 540-y))
    return NS(host=host, event=event, calls=calls, state=state, keys=keys)


@pytest.mark.parametrize("flipped", [True, False])
@pytest.mark.parametrize("point,hit", [((90, 0), True), ((149.9, 43.9), True), ((150, 10), False),
                                       ((100, 44), False), ((89, 10), False), ((100, -1), False)])
def test_cocoa_drag_hit_test_converts_to_content_top_left(cocoa_drag, flipped, point, hit):
    f = cocoa_drag; f.state["flipped"] = flipped
    event = f.event(*point)
    assert f.host.mouse_down(event) is (None if hit else event)
    assert f.calls == (["drag"] if hit else [])
    assert not f.keys, "a single press does not read preferences"


@pytest.mark.parametrize("action,expected", [("Minimize", "minimize"), ("None", None), ("Do Nothing", None),
                                            ("Maximize", "zoom"), ("Zoom", "zoom"), (None, "zoom"), ("unknown", "zoom")])
def test_cocoa_double_click_respects_system_title_bar_action(cocoa_drag, action, expected):
    f = cocoa_drag; f.state["action"] = action
    assert f.host.mouse_down(f.event(count=2)) is None
    assert f.calls == ([expected] if expected else [])
    assert f.keys == ["AppleActionOnDoubleClick"]


@pytest.mark.parametrize("blocked", ["popup", "invalid", "inactive", "transition", "other-window"])
def test_cocoa_drag_passes_unhandled_events_through(cocoa_drag, blocked):
    f = cocoa_drag
    if blocked == "popup": f.host.owner.layout["drag"] = []
    if blocked == "invalid": f.host.owner.valid = False
    if blocked == "inactive": f.host.owner.active = False
    if blocked == "transition": f.host.transition = True
    event = f.event(window=object() if blocked == "other-window" else None)
    assert f.host.mouse_down(event) is event
    assert not f.calls and not f.keys


def test_cocoa_installs_and_removes_a_window_scoped_mouse_monitor(cocoa_drag):
    f = cocoa_drag
    buttons = [Button(x, 8, True) for x in (12, 32, 52)]
    for button in buttons:
        button.hidden = True
        button.setHidden_ = lambda hidden, button=button: setattr(button, 'hidden', hidden)
    aspect = []
    f.host.window.setContentAspectRatio_ = aspect.append
    f.host.window.standardWindowButton_ = lambda kind: buttons[kind]
    monitors, removed, observers = [], [], []
    centre = NS(addObserverForName_object_queue_usingBlock_=lambda *args: observers.append(args) or args,
                removeObserver_=removed.append)
    api = NS(NSWindowCloseButton=0, NSWindowMiniaturizeButton=1, NSWindowZoomButton=2,
             NSUserDefaults=f.host.api.NSUserDefaults,
             NSEventMaskLeftMouseDown=2,
             NSEvent=NS(addLocalMonitorForEventsMatchingMask_handler_=lambda mask, fn: monitors.append((mask, fn)) or fn,
                        removeMonitor_=removed.append), NSNotificationCenter=NS(defaultCenter=lambda: centre))
    names = ('DidResize', 'DidMove', 'DidBecomeKey', 'DidResignKey', 'DidMiniaturize', 'DidDeminiaturize',
             'WillEnterFullScreen', 'WillExitFullScreen', 'DidEnterFullScreen', 'DidExitFullScreen')
    for name in names:
        setattr(api, 'NSWindow' + name + 'Notification', name)
    host = CocoaHost(NS(native=f.host.window), f.host.owner, api=api, dispatch=lambda fn: fn())
    host.install()
    assert aspect == [(16, 9)]
    assert monitors[0][0] == api.NSEventMaskLeftMouseDown
    assert monitors[0][1](f.event()) is None
    assert f.calls == ['drag'] and not any(button.hidden for button in buttons)
    host.dispose()
    assert all(button.hidden for button in buttons)
    assert removed == observers + [monitors[0][1]]
    assert host.monitor is None and not hasattr(host, 'overlay')


class NativeFunction:
    def __init__(self, fn):
        self.fn = fn

    def __call__(self, *args):
        return self.fn(*args)


@pytest.fixture
def windows_host(monkeypatch):
    # Screen coordinates deliberately include a negative monitor origin.
    current = [-1800, -100, -184, 839]
    calls, hooks = [], []
    state = {'dpi': 96}
    form = NS(Resize=Hook(), DpiChanged=Hook(), HandleCreated=Hook(), WindowState='Normal',
              is_fullscreen=False, Handle=NS(ToInt64=lambda: 123), DeviceDpi=96,
              MinimumSize=(960, 540), IsDisposed=False)
    monkeypatch.setitem(sys.modules, 'System.Drawing', NS(Size=lambda w, h: (w, h)))
    def frame(output, style, menu, extended, dpi):
        calls.append(('frame', style, menu, extended, dpi))
        fw, fh = round(16 * dpi / 96), round(39 * dpi / 96)
        output._obj.left, output._obj.top = -fw // 2, -(fh - fw // 2)
        output._obj.right, output._obj.bottom = fw // 2, fw // 2
        return True
    def get_rect(handle, output):
        output._obj.left, output._obj.top, output._obj.right, output._obj.bottom = current
        return True
    def set_rect(handle, other, x, y, w, h, flags):
        calls.append(('size', x, y, w, h, flags))
        current[:] = [x, y, x + w, y + h]
        return True
    api = NS(GetWindowLongPtrW=NativeFunction(lambda handle, index: 0xCF0000 if index == -16 else 0x100),
             GetMenu=NativeFunction(lambda handle: 0), GetWindowRect=NativeFunction(get_rect),
             AdjustWindowRectExForDpi=NativeFunction(frame), SetWindowPos=NativeFunction(set_rect),
             GetDpiForWindow=NativeFunction(lambda handle: state['dpi']))
    def subclass(handle, message, failed):
        hook = NS(handle=handle, message=message, disposed=False)
        hook.dispose = lambda: setattr(hook, 'disposed', True)
        hooks.append(hook)
        return hook
    window = NS(native=form, min_size=(960, 540), initial_width=1600, initial_height=900)
    host = WindowsHost(window, NS(refresh=lambda: calls.append('refresh')), api=api, subclass_factory=subclass)
    return NS(host=host, calls=calls, hooks=hooks, current=current, state=state)


@pytest.mark.parametrize('dpi', [96, 120, 144, 192, 288])
@pytest.mark.parametrize('edge', range(1, 9))
@pytest.mark.parametrize('size', [(1317, 827), (300, 200), (2573, 1001)])
def test_windows_aspect_correction_for_every_edge_minimum_and_dpi(dpi, edge, size):
    import math
    fw, fh = round(16 * dpi / 96), round(39 * dpi / 96)
    original = Rect(-1920, -200, -1920 + size[0] + fw, -200 + size[1] + fh)
    corrected = aspect_rect(original, edge, (fw, fh), dpi=dpi)
    width, height = corrected.right - corrected.left - fw, corrected.bottom - corrected.top - fh
    assert width >= math.ceil(960 * dpi / 96) and height >= math.ceil(540 * dpi / 96)
    if edge in (1, 2):
        assert abs(height - width * 9 / 16) <= .5
    else:
        assert abs(width - height * 16 / 9) <= .5
    assert (corrected.right if edge in (1, 4, 7) else corrected.left) == (original.right if edge in (1, 4, 7) else original.left)
    assert (corrected.bottom if edge in (3, 4, 5) else corrected.top) == (original.bottom if edge in (3, 4, 5) else original.top)
    assert all(isinstance(value, int) for value in (corrected.left, corrected.top, corrected.right, corrected.bottom))


@pytest.mark.parametrize('dpi', [96, 120, 144, 192])
@pytest.mark.parametrize('edge', range(1, 9))
def test_windows_sizing_message_corrects_the_physical_client_rect(windows_host, dpi, edge):
    from ctypes import wintypes
    f = windows_host
    f.state['dpi'] = dpi
    f.host.install()
    value = wintypes.RECT(-1300, -200, 400, 800)
    expected = aspect_rect(Rect(-1300, -200, 400, 800), edge, f.host.frame_size(), dpi=dpi)
    assert f.host.message(WM_SIZING, edge, ctypes.addressof(value), lambda: pytest.fail('WM_SIZING should be handled')) == 1
    assert (value.left, value.top, value.right, value.bottom) == (expected.left, expected.top, expected.right, expected.bottom)


@pytest.mark.parametrize('dpi', [96, 120, 144, 192])
def test_windows_startup_uses_client_dimensions_and_dpi_adjusted_frame(windows_host, dpi):
    f = windows_host
    f.state['dpi'] = dpi
    f.host.install()
    fw, fh = f.host.frame_size()
    assert f.current[2] - f.current[0] - fw == round(1600 * dpi / 96)
    assert f.current[3] - f.current[1] - fh == round(900 * dpi / 96)
    assert f.host.form.MinimumSize == (round(960 * dpi / 96) + fw, round(540 * dpi / 96) + fh)
    assert f.current[:2] == [-1800, -100]
    assert ('frame', 0xCF0000, False, 0x100, dpi) in f.calls
    f.host.dispose()
    assert f.hooks[0].disposed and f.host.form.MinimumSize == (960, 540)


@pytest.mark.parametrize('mode', ['Maximized', 'Minimized', 'Fullscreen'])
def test_windows_maximize_and_fullscreen_retain_os_geometry_and_default_messages(windows_host, mode):
    f = windows_host
    f.host.form.WindowState = mode if mode != 'Fullscreen' else 'Normal'
    f.host.form.is_fullscreen = mode == 'Fullscreen'
    f.host.install()
    assert not any(call[0] == 'size' for call in f.calls)
    assert f.host.message(WM_SIZING, 2, 0, lambda: 42) == 42
    assert f.host.message(0x83, 1, 0, lambda: 43) == 43
    assert f.host.message(0x84, 0, 0, lambda: 9) == 9
    assert f.host.message(0x2A2, 0, 0, lambda: 0) == 0


def test_windows_dpi_changes_run_default_first_and_rehook_recreated_handles(windows_host):
    f = windows_host
    f.host.install()
    f.calls.clear()
    def default():
        f.calls.append('default')
        f.state['dpi'] = 144
        return 42
    assert f.host.message(WM_DPICHANGED, 0, 0, default) == 42
    assert f.calls[0] == 'default'
    fw, fh = f.host.frame_size()
    assert f.host.form.MinimumSize == (1440 + fw, 810 + fh)
    f.host.form.Handle = NS(ToInt64=lambda: 456)
    f.host.form.HandleCreated.handlers[0]()
    assert f.hooks[0].disposed and f.hooks[1].handle == 456
    f.host.dispose()
    assert f.hooks[1].disposed and not f.host.form.HandleCreated.handlers


def test_cocoa_content_aspect_policy_survives_m1_alignment_failure():
    calls = []
    window = NS(setContentAspectRatio_=calls.append, standardWindowButton_=lambda kind: None)
    api = NS(NSWindowCloseButton=0, NSWindowMiniaturizeButton=1, NSWindowZoomButton=2)
    host = CocoaHost(NS(native=window), NS(), api=api, dispatch=lambda fn: fn())
    with pytest.raises(RuntimeError, match='button missing'):
        host.install()
    assert calls == [(16, 9)]


def test_windows_failed_aspect_install_keeps_standard_caption_and_cleans_subclass(windows_host):
    f = windows_host
    f.host.user.AdjustWindowRectExForDpi = NativeFunction(lambda *args: False)
    chrome = WindowChrome(f.host.window, EventBus(), platform='win32', host=f.host)
    f.host.owner = chrome
    chrome.install()
    assert not chrome.active and chrome.snapshot()['mode'] == 'standard'
    assert f.hooks[0].disposed
    assert not f.host.form.Resize.handlers and not f.host.form.HandleCreated.handlers
    assert f.host.form.MinimumSize == (960, 540)
    assert 'frame' in chrome.reason


def test_windows_installs_aspect_policy_before_show_without_waiting_for_webview(monkeypatch, tmp_path):
    from ba_modding_toolkit.webui import main, native, window_chrome
    from ba_modding_toolkit.webui.timing import Timings
    from ba_modding_toolkit.webui.tray import Tray
    calls = []
    handlers = {}
    class Event(Hook):
        def __init__(self, name):
            super().__init__()
            handlers[name] = self.handlers
    class Chrome:
        active = False
        def __init__(self, *args, **kwargs): pass
        def install(self): calls.append('install')
        def close(self): pass
        def dispose(self): calls.append('dispose')
    def create(title, url, **kwargs):
        assert kwargs['frameless'] is False
        return NS(events=NS(**{name: Event(name) for name in ('initialized', 'loaded', 'closing', 'closed',
                                                              'before_show', 'shown', 'maximized', 'minimized', 'restored')}))
    def start(**kwargs):
        calls.append('before-show')
        handlers['before_show'][0]()
        assert calls == ['before-show', 'install']
        assert not services.close_coordinator.page_loaded
        calls.append('shown')
        handlers['shown'][0]()
    monkeypatch.setattr(main.sys, 'platform', 'win32')
    monkeypatch.setattr(native, 'webview2_version', lambda: '120.0.0.0')
    monkeypatch.setattr(Tray, 'supported', staticmethod(lambda: False))
    monkeypatch.setattr(window_chrome, 'WindowChrome', Chrome)
    monkeypatch.setitem(sys.modules, 'webview', NS(settings={}, create_window=create, start=start))
    services = NS(window=None, data_dir=tmp_path, timings=Timings(), events=EventBus())
    main._run_window(services, NS(url='http://127.0.0.1:1/'), False)
    assert calls == ['before-show', 'install', 'shown', 'dispose']
