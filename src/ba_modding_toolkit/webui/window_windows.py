"""W1 extended DWM frame. All native writes are reversible on a failed gate.

The WebView2 non-client API is optional: the existing SDK/runtime floor is retained.
Without it, leave the frameless host and its deliberate HTML fallback untouched.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

from .window_chrome import Rect

WM_NCCALCSIZE, WM_NCHITTEST, WM_NCMOUSELEAVE = 0x83, 0x84, 0x2A2
WS_NATIVE_CAPTION = 0x00C00000 | 0x00080000 | 0x00020000 | 0x00010000 | 0x00040000


def frame_hit(x, y, width, height, border, maximized=False):
    """Resize borders precede App drag regions; maximized windows have no resize edge."""
    if maximized:
        return None
    left, right, top, bottom = x < border, x >= width - border, y < border, y >= height - border
    if top:
        return 13 if left else 14 if right else 12
    if bottom:
        return 16 if left else 17 if right else 15
    return 10 if left else 11 if right else None


class WindowsHost:
    def __init__(self, window, owner):
        self.window, self.owner, self.form = window, owner, window.native
        self.hook = None
        self.old_style = None
        self.old_region = None
        self.settings = None

    def dispatch(self, fn):
        from System import Action
        if self.form.InvokeRequired:
            self.form.BeginInvoke(Action(fn))
        else:
            fn()

    def install(self):
        self.control = self.form.webview
        core = self.control.CoreWebView2
        if core is None or not hasattr(core.Settings, "IsNonClientRegionSupportEnabled"):
            raise RuntimeError("W1 unavailable: bundled WebView2 Settings lacks IsNonClientRegionSupportEnabled")
        self.settings = core.Settings
        self.old_nonclient = self.settings.IsNonClientRegionSupportEnabled
        self.settings.IsNonClientRegionSupportEnabled = True
        self.user, self.dwm = ctypes.windll.user32, ctypes.windll.dwmapi
        pointer = ctypes.c_ssize_t
        self.get_style = getattr(self.user, "GetWindowLongPtrW", self.user.GetWindowLongW)
        self.set_style = getattr(self.user, "SetWindowLongPtrW", self.user.SetWindowLongW)
        self.get_style.argtypes, self.get_style.restype = [wintypes.HWND, ctypes.c_int], pointer
        self.set_style.argtypes, self.set_style.restype = [wintypes.HWND, ctypes.c_int, pointer], pointer
        self.user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self.user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        self.dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        self.dwm.DwmDefWindowProc.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, pointer,
                                             ctypes.POINTER(pointer)]
        self.dwm.DwmExtendFrameIntoClientArea.argtypes = [wintypes.HWND, ctypes.c_void_p]
        self.handle = int(self.form.Handle.ToInt64())
        self.hook = WindowSubclass(self.handle, self.message, self._message_failed)
        self.old_style = self.get_style(self.handle, -16)
        self.old_region = self.control.Region.Clone() if self.control.Region is not None else None
        self.set_style(self.handle, -16, self.old_style | WS_NATIVE_CAPTION)
        self._frame_changed()
        self.on_resize = lambda *_: self.owner.refresh()
        self.form.Resize += self.on_resize
        if hasattr(self.form, "DpiChanged"):
            self.form.DpiChanged += self.on_resize
        self.form.HandleCreated += self.on_handle
        # The setting takes effect on the next document navigation. Reload before
        # publishing active geometry, so CSS drag/no-drag cannot be silently ignored.
        core.Reload()

    def _message_failed(self, error):
        from System import Action
        # Rollback after the callback returns, never while it is on the native stack.
        self.form.BeginInvoke(Action(lambda: self.owner.fail(error)))

    def on_handle(self, *_):
        self.owner.fail(RuntimeError("W1 form handle recreated; restored frameless fallback"))

    def _frame_changed(self):
        if not self.user.SetWindowPos(self.handle, None, 0, 0, 0, 0, 0x27):
            raise OSError("W1 frame refresh failed")

    def state(self):
        name = str(self.form.WindowState)
        return {"maximized": name == "Maximized", "minimized": name == "Minimized",
                "fullscreen": bool(self.form.is_fullscreen)}

    def message(self, code, wparam, lparam, default):
        # Preserve DWM's real caption hit regions, including HTMAXBUTTON/Snap hover.
        if code in (WM_NCHITTEST, WM_NCMOUSELEAVE):
            result = ctypes.c_ssize_t()
            if self.dwm.DwmDefWindowProc(self.handle, code, wparam, lparam, ctypes.byref(result)):
                return result.value
        if code == WM_NCCALCSIZE and wparam:
            # Keep DefWindowProc's side/bottom resize frame and work-area handling;
            # only extend the top client edge. DWM buttons keep their own y.
            pointer = lparam
            rect = wintypes.RECT.from_address(pointer)
            original_top = rect.top
            default()
            rect.top = original_top
            return 0
        if code == WM_NCHITTEST:
            packed = lparam
            x, y = ctypes.c_short(packed & 0xffff).value, ctypes.c_short((packed >> 16) & 0xffff).value
            bounds = wintypes.RECT()
            self.user.GetWindowRect(self.handle, ctypes.byref(bounds))
            dpi = self.dpi()
            metrics = getattr(self.user, "GetSystemMetricsForDpi", None)
            border = (metrics(32, dpi) + metrics(92, dpi)) if metrics else self.user.GetSystemMetrics(32) + self.user.GetSystemMetrics(92)
            hit = frame_hit(x - bounds.left, y - bounds.top, bounds.right - bounds.left,
                            bounds.bottom - bounds.top, border, self.state()["maximized"])
            if hit is not None:
                return hit
        return default()

    def dpi(self):
        get = getattr(self.user, "GetDpiForWindow", None)
        if get:
            get.argtypes, get.restype = [wintypes.HWND], wintypes.UINT
        return get(self.handle) if get else self.form.DeviceDpi

    def measure(self, layout):
        from System.Drawing import Rectangle, Region
        if self.state()["minimized"] or not self.form.Visible:
            return None
        native = wintypes.RECT()
        if self.dwm.DwmGetWindowAttribute(self.handle, 5, ctypes.byref(native), ctypes.sizeof(native)) != 0:
            return None
        frame = wintypes.RECT()
        self.user.GetWindowRect(self.handle, ctypes.byref(frame))
        origin = wintypes.POINT(frame.left, frame.top)
        self.user.ScreenToClient(self.handle, ctypes.byref(origin))
        ratio = self.dpi() / 96
        bounds = Rect((native.left + origin.x) / ratio, (native.top + origin.y) / ratio,
                      (native.right + origin.x) / ratio, (native.bottom + origin.y) / ratio)
        if not bounds.valid or bounds.left < self.form.ClientSize.Width / ratio / 2 or bounds.top < 0:
            return None
        # DockStyle.Fill otherwise covers the system caption with a child HWND.
        # Clip only that measured area out of the WebView control and its children.
        region = Region(Rectangle(0, 0, self.control.Width, self.control.Height))
        region.Exclude(Rectangle(max(0, int(bounds.left * ratio) - self.control.Left),
                                 max(0, int(bounds.top * ratio) - self.control.Top),
                                 int((bounds.right - bounds.left) * ratio + 1),
                                 int((bounds.bottom - bounds.top) * ratio + 1)))
        if not self.state()["maximized"]:
            metrics = getattr(self.user, "GetSystemMetricsForDpi", None)
            border = (metrics(33, self.dpi()) + metrics(92, self.dpi())) if metrics else self.user.GetSystemMetrics(33) + self.user.GetSystemMetrics(92)
            region.Exclude(Rectangle(0, 0, self.control.Width, border))
        previous = self.control.Region
        self.control.Region = region
        if previous is not None:
            previous.Dispose()
        margins = (ctypes.c_int * 4)(0, 0, int(bounds.bottom * ratio), 0)
        if self.dwm.DwmExtendFrameIntoClientArea(self.handle, ctypes.byref(margins)) != 0:
            raise OSError("W1 DWM frame extension failed")
        return bounds

    def command(self, action):
        from System.Windows.Forms import FormWindowState
        if action == "fullscreen":
            self.window.toggle_fullscreen()
        else:
            self.form.WindowState = (FormWindowState.Minimized if action == "minimize" else
                                     FormWindowState.Normal if self.state()["maximized"] else FormWindowState.Maximized)

    def dispose(self):
        if hasattr(self, "on_resize"):
            self.form.Resize -= self.on_resize
            if hasattr(self.form, "DpiChanged"):
                self.form.DpiChanged -= self.on_resize
            self.form.HandleCreated -= self.on_handle
            del self.on_resize
        if self.hook is not None:
            self.hook.dispose()
            self.hook = None
        if self.old_style is not None and not self.form.IsDisposed:
            self.handle = int(self.form.Handle.ToInt64())
            self.set_style(self.handle, -16, self.old_style)
            self.old_style = None
            margins = (ctypes.c_int * 4)(0, 0, 0, 0)
            self.dwm.DwmExtendFrameIntoClientArea(int(self.form.Handle.ToInt64()), ctypes.byref(margins))
            self._frame_changed()
            current = self.control.Region
            self.control.Region = self.old_region
            if current is not None:
                current.Dispose()
        if self.settings is not None:
            if not self.form.IsDisposed:
                self.settings.IsNonClientRegionSupportEnabled = self.old_nonclient
            self.settings = None


class WindowSubclass:
    """Public comctl32 subclass, on the form's GUI thread, with a retained callback.

    This avoids managed virtual-method overrides and never subclasses WebView2's
    foreign-process child HWNDs. The child uses its own optional non-client API.
    """

    def __init__(self, handle, message, failed, *, api=None, callback_type=None):
        self.api = api or ctypes.windll.comctl32
        callback_type = callback_type or ctypes.WINFUNCTYPE
        self.handle, self.identifier = handle, id(self)
        prototype = callback_type(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
                                  ctypes.c_size_t, ctypes.c_ssize_t, ctypes.c_size_t, ctypes.c_size_t)

        def callback(hwnd, code, wparam, lparam, identifier, data):
            def default():
                return self.api.DefSubclassProc(hwnd, code, wparam, lparam)
            try:
                return message(code, wparam, lparam, default)
            except Exception as error:
                failed(error)
                return default()

        self.callback = prototype(callback)
        self.api.SetWindowSubclass.argtypes = [wintypes.HWND, prototype, ctypes.c_size_t, ctypes.c_size_t]
        self.api.RemoveWindowSubclass.argtypes = [wintypes.HWND, prototype, ctypes.c_size_t]
        self.api.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
        self.api.DefSubclassProc.restype = ctypes.c_ssize_t
        if not self.api.SetWindowSubclass(handle, self.callback, self.identifier, 0):
            raise OSError("W1 native message subclass installation failed")

    def dispose(self):
        self.api.RemoveWindowSubclass(self.handle, self.callback, self.identifier)
