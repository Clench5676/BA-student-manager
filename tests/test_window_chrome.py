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
from ba_modding_toolkit.webui.window_windows import WindowsHost, frame_hit, WM_NCCALCSIZE, WM_NCHITTEST, WM_NCMOUSELEAVE


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
        self.value.origin = NS(x=point[0], y=point[1])

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


@pytest.mark.parametrize('code', [WM_NCHITTEST, WM_NCMOUSELEAVE])
def test_windows_passes_caption_hit_testing_to_dwm_first(monkeypatch, code):
    calls = []
    host = WindowsHost(NS(native=NS()), NS())
    host.handle = 123
    def dwm(*args):
        calls.append('dwm')
        args[-1]._obj.value = 9  # HTMAXBUTTON belongs to DWM; never paint/replace it.
        return True
    host.dwm = NS(DwmDefWindowProc=dwm)
    assert host.message(code, 0, 0, lambda: calls.append('default')) == 9
    assert calls == ['dwm']


def test_windows_extends_only_top_and_preserves_side_bottom_work_area(monkeypatch):
    from ctypes import wintypes
    host = WindowsHost(NS(native=NS()), NS())
    value = wintypes.RECT(0, 0, 1600, 900)
    def default():
        value.left += 8; value.right -= 8; value.top += 31; value.bottom -= 8
    assert host.message(WM_NCCALCSIZE, 1, ctypes.addressof(value), default) == 0
    assert (value.left, value.top, value.right, value.bottom) == (8, 0, 1592, 892)


@pytest.mark.parametrize('dpi', [96, 120, 144, 192, 288])
def test_windows_measures_caption_in_css_pixels_and_clips_the_webview_child(monkeypatch, dpi):
    class Region:
        def __init__(self, box): self.box, self.exclusions = box, []
        def Exclude(self, box): self.exclusions.append(box)
        def Dispose(self): pass
    monkeypatch.setitem(sys.modules, 'System.Drawing', NS(Rectangle=lambda *args: args, Region=Region))
    ratio = dpi / 96
    form = NS(Visible=True, ClientSize=NS(Width=1600 * ratio))
    host = WindowsHost(NS(native=form), NS())
    host.handle, host.dpi = 123, lambda: dpi
    host.state = lambda: dict(minimized=False, maximized=False)
    host.control = NS(Region=None, Width=1600 * ratio, Height=900 * ratio, Left=0, Top=0)
    def measured(handle, key, output, size):
        output._obj.left, output._obj.top = int(1452 * ratio), 0
        output._obj.right, output._obj.bottom = int(1600 * ratio), int(32 * ratio)
        return 0
    def window_rect(handle, output):
        output._obj.left, output._obj.top = -1920, -200
    def client(handle, point):
        point._obj.x, point._obj.y = 0, 0
    host.user = NS(GetWindowRect=window_rect, ScreenToClient=client, GetSystemMetricsForDpi=lambda metric, dpi: 4)
    host.dwm = NS(DwmGetWindowAttribute=measured, DwmExtendFrameIntoClientArea=lambda *args: 0)
    one = host.measure({'centre': 29.56})
    two = host.measure({'centre': 60})
    assert one == two == Rect(1452, 0, 1600, 32)
    assert host.control.Region.exclusions[0] == (int(1452 * ratio), 0, int(148 * ratio + 1), int(32 * ratio + 1))
    assert host.control.Region.exclusions[1] == (0, 0, 1600 * ratio, 8)
    form.Visible = False
    assert host.measure({}) is None


def test_windows_missing_optional_sdk_api_does_not_mutate_host():
    host = WindowsHost(NS(native=NS(webview=NS(CoreWebView2=NS(Settings=NS())))), NS())
    # Import is a pywebview dependency on Windows; fake it without loading .NET.
    previous = sys.modules.get('System.Windows.Forms')
    sys.modules['System.Windows.Forms'] = NS(NativeWindow=object)
    try:
        with pytest.raises(RuntimeError, match='lacks IsNonClientRegionSupportEnabled'):
            host.install()
        assert host.old_style is None and host.settings is None and host.hook is None
    finally:
        if previous is None: sys.modules.pop('System.Windows.Forms')
        else: sys.modules['System.Windows.Forms'] = previous


@pytest.mark.parametrize('point, expected', [((0, 0), 13), ((1599, 0), 14), ((0, 899), 16),
    ((1599, 899), 17), ((800, 0), 12), ((800, 899), 15), ((0, 400), 10), ((1599, 400), 11), ((800, 400), None)])
def test_windows_resize_edges_and_corners(point, expected):
    assert frame_hit(*point, 1600, 900, 8) == expected
    assert frame_hit(*point, 1600, 900, 8, maximized=True) is None


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
        return default()
    hook = WindowSubclass(123, message, errors.append, api=api, callback_type=lambda *signature: lambda fn: fn)
    assert hook.callback(123, 1, 2, 3, hook.identifier, 0) == 42
    assert hook.callback(123, 7, 2, 3, hook.identifier, 0) == 42
    hook.dispose()
    assert [item[0] for item in calls] == ['install','default','default','remove']
    assert len(errors) == 1
    assert calls[0][1][1] is calls[-1][1][1] is hook.callback


def test_macos_keyboard_and_minimal_menu_commands_route_close_before_webkit(monkeypatch, caplog):
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
        def setKeyEquivalentModifierMask_(self, flags): self.flags = flags
    class Menu(Object):
        def __init__(self): self.items = []
        def initWithTitle_(self, title): self.title = title; return self
        def itemArray(self): return self.items
        def addItem_(self, item): self.items.append(item)
        def addItemWithTitle_action_keyEquivalent_(self, title, selector, key):
            item = Item(); item.title, item.selector, item.key = title, selector, key
            self.items.append(item); return item
    main, app_menu = Menu(), Menu()
    app_item = Item(); app_item.setSubmenu_(app_menu); main.addItem_(app_item)
    quit_item = app_menu.addItemWithTitle_action_keyEquivalent_('Quit', 'terminate:', 'q')
    monitors, removed, calls, timers = [], [], [], []
    current = {"main": None}
    def timer(interval, repeats, fn):
        assert interval == .25 and repeats
        result = NS(fire=lambda: fn(result), invalidate=lambda: calls.append("timer-disposed"))
        timers.append(result)
        return result
    api = NS(NSObject=Object, NSMenu=Menu, NSMenuItem=Item,
             NSApplication=NS(sharedApplication=lambda: NS(mainMenu=lambda: current["main"])),
             NSTimer=NS(scheduledTimerWithTimeInterval_repeats_block_=timer),
             NSEvent=NS(addLocalMonitorForEventsMatchingMask_handler_=lambda mask, fn: monitors.append(fn) or fn,
                        removeMonitor_=removed.append), NSEventMaskKeyDown=1,
             NSEventModifierFlagCommand=1, NSEventModifierFlagShift=2,
             NSEventModifierFlagOption=4, NSEventModifierFlagControl=8)
    monkeypatch.setitem(sys.modules, 'AppKit', api)
    window = NS(performMiniaturize_=lambda sender: calls.append('minimize'),
                performZoom_=lambda sender: calls.append('zoom'), toggleFullScreen_=lambda sender: calls.append('fullscreen'))
    services = NS(window=NS(native=window), quit=lambda: calls.append('guarded-close'))
    caplog.set_level("INFO")
    cleanup = install_window_commands(services, None)
    assert len(main.items) == 1, "installation can precede the application main menu"
    current["main"] = main
    timers[0].fire(); cleanup.refresh()
    assert len(main.items) == 3
    assert main.items[1].title and main.items[2].title
    commands = main.items[2].submenu().items
    assert len(commands) == 4
    assert [item.key for item in commands] == ['w','m','','f']
    assert quit_item.selector == 'closeWindow:'
    quit_item.target.closeWindow_(None)
    for char, flags in [('q',1),('w',1),('m',1),('f',9)]:
        event = NS(window=lambda: window, modifierFlags=lambda: flags, charactersIgnoringModifiers=lambda: char)
        assert monitors[0](event) is None
    ordinary = NS(window=lambda: window, modifierFlags=lambda: 1, charactersIgnoringModifiers=lambda: 'c')
    assert monitors[0](ordinary) is ordinary
    assert calls == ['guarded-close','guarded-close','guarded-close','minimize','fullscreen']
    def busy():
        raise ServiceError('busy')
    services.quit = busy
    services.events = NS(publish=lambda event: calls.append(event))
    event = NS(window=lambda: window, modifierFlags=lambda: 1, charactersIgnoringModifiers=lambda: 'q')
    assert monitors[0](event) is None
    assert calls[-1] == 'app.busy'
    # first_show / windowDidBecomeKey can replace the menu after document load.
    replacement = Menu(); current["main"] = replacement
    timers[0].fire(); timers[0].fire()
    assert len(replacement.items) == 2
    assert replacement.items[1].title == main.items[2].title
    assert replacement.items[1].submenu().items[0].target is commands[0].target
    replacement.items.clear()  # also repair in-place clearing
    timers[0].fire()
    assert len(replacement.items) == 2
    assert sum(record.message == "Native Window menu installed" for record in caplog.records) == 1
    cleanup(); assert removed == monitors and calls[-1] == "timer-disposed"


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
