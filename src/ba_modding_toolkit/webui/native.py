"""pywebview-only features: the window, file dialogs and dropped file paths."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Iterable

logger = logging.getLogger(__name__)

WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"


def pick_files(window: Any, file_types: Iterable[str] = (), multiple: bool = True) -> list[Path]:
    """The native open-file dialog. ``file_types`` entries look like ``"Bundle (*.bundle;*.backup)"``."""
    import webview

    result = window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=multiple, file_types=tuple(file_types))
    return [Path(p) for p in result or ()]


def pick_folder(window: Any, multiple: bool = True) -> list[Path]:
    """The native folder dialog, with the same cancellation shape as pick_files."""
    import webview

    result = window.create_file_dialog(webview.FileDialog.FOLDER, allow_multiple=multiple)
    return [Path(p) for p in result or ()]


def watch_drops(window: Any, on_paths: Callable[[list[str]], None]) -> None:
    """Report the full paths of files dropped on the page. pywebview only adds the paths when the drop handler is
    registered from Python."""
    from webview.dom import DOMEventHandler

    def on_drop(event: dict) -> None:
        files = event.get("dataTransfer", {}).get("files", [])
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            on_paths(paths)

    def noop(_event: dict) -> None:
        pass

    doc = window.dom.document
    doc.events.dragenter += DOMEventHandler(noop, True, True)
    doc.events.dragstart += DOMEventHandler(noop, True, True)
    doc.events.dragover += DOMEventHandler(noop, True, True, debounce=500)
    doc.events.drop += DOMEventHandler(on_drop, True, True)


def renderer_supported(renderer: str) -> bool:
    """pywebview falls back to MSHTML (Internet Explorer) without WebView2; the front end cannot run there."""
    return renderer not in ("mshtml",)


# Supported runtime floor; includes structuredClone and inert for safe UI transitions.
MIN_WEBVIEW2_MAJOR = 105
WEBVIEW2_CLIENT = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def webview2_version(registry=None) -> str | None:
    """Check per-user and per-machine Evergreen runtimes in both registry views."""
    if registry is None:
        import winreg as registry
    versions = []
    for hive in (registry.HKEY_CURRENT_USER, registry.HKEY_LOCAL_MACHINE):
        for view in (registry.KEY_WOW64_32KEY, registry.KEY_WOW64_64KEY):
            try:
                with registry.OpenKey(hive, WEBVIEW2_CLIENT, 0, registry.KEY_READ | view) as key:
                    value = registry.QueryValueEx(key, "pv")[0]
                parts = tuple(int(p) for p in value.split("."))
                if len(parts) == 4 and any(parts):
                    versions.append((parts, value))
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    return max(versions)[1] if versions else None


def webview2_supported(version: str | None) -> bool:
    try:
        return int(version.split(".")[0]) >= MIN_WEBVIEW2_MAJOR
    except (AttributeError, ValueError):
        return False


def engine_info() -> dict:
    import sys
    if sys.platform == "win32":
        return {"engine": "WebView2", "version": webview2_version()}
    if sys.platform == "darwin":
        import plistlib
        try:
            with Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").open("rb") as stream:
                info = plistlib.load(stream)
            version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion")
        except (OSError, ValueError):
            version = None
        return {"engine": "WebKit", "version": version}
    return {"engine": "unknown", "version": None}


def report_folders() -> list[Path]:
    """Use OS folder locations, including redirected Windows Desktop/Downloads."""
    import sys
    if sys.platform == "win32":
        import winreg
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        result = []
        for key, fallback in (("Desktop", "Desktop"), ("{374DE290-123F-4565-9164-39C4925E467B}", "Downloads")):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as handle:
                    value = winreg.QueryValueEx(handle, key)[0]
                result.append(Path(winreg.ExpandEnvironmentStrings(value)))
            except OSError:
                result.append(Path.home() / fallback)
        return result
    return [Path.home() / "Desktop", Path.home() / "Downloads"]


def copy_text(text: str) -> None:
    import subprocess
    import sys
    if sys.platform == "darwin":
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True, timeout=5)
    elif sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
        kernel.GlobalAlloc.restype = wintypes.HGLOBAL
        kernel.GlobalLock.argtypes = [wintypes.HGLOBAL]
        kernel.GlobalLock.restype = ctypes.c_void_p
        kernel.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        kernel.GlobalFree.argtypes = [wintypes.HGLOBAL]
        user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
        user.SetClipboardData.restype = wintypes.HANDLE
        data = (text + "\0").encode("utf-16-le")
        handle = kernel.GlobalAlloc(0x0002, len(data))
        if not handle:
            raise OSError("Clipboard allocation failed")
        try:
            pointer = kernel.GlobalLock(handle)
            if not pointer:
                raise OSError("Clipboard lock failed")
            ctypes.memmove(pointer, data, len(data))
            kernel.GlobalUnlock(handle)
            if not user.OpenClipboard(None):
                raise OSError("Clipboard unavailable")
            try:
                user.EmptyClipboard()
                if not user.SetClipboardData(13, handle):
                    raise OSError("Clipboard write failed")
                handle = None  # Ownership passes to the OS.
            finally:
                user.CloseClipboard()
        finally:
            if handle:
                kernel.GlobalFree(handle)
    else:
        subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=True, timeout=5)


def message_box(title: str, message: str) -> None:
    """No dependency on pywebview, its renderer or the HTTP server."""
    import sys
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
    elif sys.platform == "darwin":
        import subprocess
        script = 'on run argv\ndisplay alert (item 1 of argv) message (item 2 of argv) as critical\nend run'
        subprocess.run(["osascript", "-e", script, title, message], check=True)
    else:
        from tkinter import Tk, messagebox
        root = Tk()
        root.withdraw()
        try:
            messagebox.showerror(title, message, parent=root)
        finally:
            root.destroy()


def startup_failure(reports, error: BaseException, *, runtime: bool = False) -> dict | None:
    from ..i18n import t
    result, report_path = None, None
    try:
        reports.frontend_event({"kind": "native", "message": str(error), "phase": "native.initialize"})
        result = reports.generate()
        if result and Path(result["path"]).is_file():
            report_path = result["path"]
    except Exception:
        logger.warning("Startup report unavailable", exc_info=True)
    text = t("webui.recovery.runtime" if runtime else "webui.recovery.native")
    if report_path:
        text += "\n\n" + report_path
    if runtime:
        text += "\n\n" + WEBVIEW2_URL
    message_box(t("webui.recovery.failed"), text)
    return result


def install_edit_menu() -> None:
    """Restore standard responder editing shortcuts without pywebview's default application menus."""
    import sys
    if sys.platform != 'darwin':
        return
    from AppKit import NSApplication, NSMenu, NSMenuItem
    from PyObjCTools import AppHelper
    from ..i18n import t

    def install():
        main = NSApplication.sharedApplication().mainMenu()
        if main is None:
            return
        for existing in main.itemArray():
            submenu = existing.submenu()
            if submenu and any(str(item.action()) == 'copy:' for item in submenu.itemArray()):
                return
        menu = NSMenu.alloc().initWithTitle_(t('webui.window.edit'))
        item = NSMenuItem.alloc().init()
        item.setSubmenu_(menu)
        for key, selector, shortcut in [('cut', 'cut:', 'x'), ('copy', 'copy:', 'c'),
                                        ('paste', 'paste:', 'v'), ('selectAll', 'selectAll:', 'a')]:
            menu.addItemWithTitle_action_keyEquivalent_(t('webui.window.' + key), selector, shortcut)
        main.addItem_(item)
    AppHelper.callAfter(install)


def install_window_commands(services, chrome):
    """Intercept Command-Q before WKWebView's direct app.stop_ path, including in inputs."""
    import AppKit
    from ..i18n import t
    from ..errors import ServiceError

    window = services.window.native

    def request_close():
        try:
            services.quit()
        except ServiceError as error:
            if error.code == "busy":
                services.events.publish("app.busy")
            else:
                logger.warning("Native close refused: %s", error.code)

    class WindowCommands(AppKit.NSObject):
        def closeWindow_(self, sender):
            request_close()

        def minimizeWindow_(self, sender):
            window.performMiniaturize_(sender)

        def zoomWindow_(self, sender):
            window.performZoom_(sender)

        def fullscreenWindow_(self, sender):
            window.toggleFullScreen_(sender)

    target = WindowCommands.alloc().init()

    def key(event):
        flags = event.modifierFlags()
        if event.window() != window or not flags & AppKit.NSEventModifierFlagCommand:
            return event
        if flags & (AppKit.NSEventModifierFlagOption | AppKit.NSEventModifierFlagShift):
            return event
        char = str(event.charactersIgnoringModifiers()).lower()
        if char in ("q", "w") and not flags & AppKit.NSEventModifierFlagControl:
            request_close()
            return None
        if char == "m" and not flags & AppKit.NSEventModifierFlagControl:
            window.performMiniaturize_(None)
            return None
        if char == "f" and flags & AppKit.NSEventModifierFlagControl:
            window.toggleFullScreen_(None)
            return None
        return event

    monitor = AppKit.NSEvent.addLocalMonitorForEventsMatchingMask_handler_(AppKit.NSEventMaskKeyDown, key)
    installed = []

    def refresh():
        main = AppKit.NSApplication.sharedApplication().mainMenu()
        if main is None:
            return
        for item in main.itemArray():
            submenu = item.submenu()
            for command in submenu.itemArray() if submenu else []:
                if str(command.action()) == "terminate:":
                    command.setTarget_(target)
                    command.setAction_("closeWindow:")
        if installed and installed[0] in main.itemArray():
            return
        menu = AppKit.NSMenu.alloc().initWithTitle_(t("webui.window.menu"))
        item = AppKit.NSMenuItem.alloc().init()
        item.setSubmenu_(menu)
        for label, selector, shortcut, flags in (
            ("webui.window.close", "closeWindow:", "w", AppKit.NSEventModifierFlagCommand),
            ("webui.window.minimize", "minimizeWindow:", "m", AppKit.NSEventModifierFlagCommand),
            ("webui.window.maximize", "zoomWindow:", "", AppKit.NSEventModifierFlagCommand),
            ("webui.lobby.fullscreen", "fullscreenWindow:", "f", AppKit.NSEventModifierFlagControl | AppKit.NSEventModifierFlagCommand),
        ):
            command = menu.addItemWithTitle_action_keyEquivalent_(t(label), selector, shortcut)
            command.setKeyEquivalentModifierMask_(flags)
            command.setTarget_(target)
        main.addItem_(item)
        installed[:] = [item]

    def dispose():
        AppKit.NSEvent.removeMonitor_(monitor)

    dispose.refresh = refresh
    return dispose
