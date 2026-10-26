# BL-037: Native window controls in the top toolbar

Status: Implemented for local review; owner UAT/visual acceptance pending.

## Owner-approved experiment (2026-10-26)

The experiment follows M1/W1 and the owner decisions in BL-037. The design research below is retained as historical
rationale; its second-row proposal, open approval questions and statements that implementation is unstarted are
superseded by these decisions. No native app, preview, screenshot or package build was run for this implementation.

- `webui/window_chrome.py` owns injectable hosts, native state snapshots, valid/last-valid measurements and rollback.
  `window_macos.py` reveals `standardWindowButton:` results, changes only their y coordinates, checks the resulting
  frames/container clipping and refreshes after native resize/fullscreen notifications. A window-scoped `NSEvent`
  local left-mouse-down monitor tests the reported drag rectangles before WKWebView hit testing and calls
  `performWindowDragWithEvent:`. It converts against the current content view, including flipped coordinates;
  the former `ToolbarDragView` overlay is removed. Double-click reads only the owner-approved
  `AppleActionOnDoubleClick` key: `Minimize` miniaturizes, `None`/`Do Nothing` consumes without action, and all
  other values (including unset) zoom. These values and the actual event routing still require native acceptance.
  No private view class, substitute drawing or reparenting of standard buttons is used. Cocoa attaches WKWebView
  at the end of navigation in pywebview 6.2.1; installation therefore follows document load. Native close/keyboard
  guards are installed before the first page.
- `window_windows.py` attempts W1 only if the host's existing WebView2 Settings exposes
  `IsNonClientRegionSupportEnabled`. It restores native caption/system-menu/resize styles, extends only the top
  client edge, delegates caption hit testing and mouse-leave to DWM first, and clips the measured caption area
  out of the docked WebView2 child. Resize edges remain native. A retained public comctl32 subclass forwards all
  other messages. The optional WebView2 API supplies native gestures for measured CSS drag regions after one
  initial reload. Button y coordinates are never rewritten. Missing capability or adapter exceptions restore the
  existing frameless host and HTML controls; they do not select W2 or raise the SDK/runtime floor.
- `web/js/window-layout.js` and `window-chrome.js` anchor the existing prefab bar to the window for active adapters.
  Geometry uses viewport CSS pixels, measured native bounds and an 8-pixel gap. The row is at least 44 CSS pixels,
  retaining BL-043's fill centre. BL-049 replaces the 66-unit title with the Enable Mods caption's rendered size;
  natural DOM text measurement includes shaping and trailing spacing. A measured collision hides only the Mods caption; the switch,
  help badge and accessible label remain. The caption returns with 16 spare CSS pixels. The title can ellipsize
  while retaining its accessible name. There is no second row. BL-038 retains Settings in Home's safe outer slot.
  BL-050 removes Hall's Back and moves the title from the 160-pixel slot into its 38-pixel slot with native clearance.
  Browser mode has no HTML window buttons; unsupported/failed desktop hosts retain one fallback group. The legacy
  selector drag is excluded from active native rows and handles the fallback immersive strip. Portrait/L2D fullscreen,
  their two cameras (`photo-active`) and Hall fullscreen hide the entire bar, including its background, shadow and
  Back. Only native controls and a 64 × 12 CSS-pixel strip beside them remain, with an 8-pixel horizontal gap;
  W1's strip starts below its retained 8-pixel resize edge. Scene action/focus bounds and popups exclude dragging.
  Immersion restores the unshifted full-stage geometry; exit restores the bar. The bar's `Common_Top_Menu_Bg` and
  the scrollbar's texture use NGUI's contiguous raster instead of independently composited CSS border-image slices.
- `webui/window_close.py` preflights the existing `StudentHall.canLeave()` for native, menu, keyboard, App, tray,
  consent, safe restart and update exits. The first native attempt is vetoed synchronously. Repeated requests
  coalesce; writers refuse immediately. After Save/Discard, page input freezes, writer admission is reserved and
  the draft revision is checked again. Stay, save failure, stale approval, an unanswered page or refused close
  releases only the coordinator's own reservation and restores page input/focus. Updates retain their existing
  classic-window interlock, reservation ownership, three-second native-close wait and helper-on-closed handling;
  interactive preflight precedes that wait. A never-loaded page cannot contain a Hall editor and can close without
  waiting for assets. A loaded page gets 120 seconds to answer before cancellation, never implicit permission.
  Cocoa uses `performClose:`; its Command-Q handler is intercepted before pywebview's direct `app.stop_` path.
- The only added menu is Window, with existing Close, Minimize, Maximize/Restore and Fullscreen labels. Command-W/Q,
  Command-M and Control-Command-F remain reachable even in text inputs. Editing commands remain. Only the Window
  menu title adds text, in all six locales; existing labels are unchanged. Menu titles are set explicitly.
  A retained 250-ms main-loop timer repairs Window/Edit commands after a missing, replaced or cleared main menu;
  Window installation logs once at INFO in English. Cocoa 6.2.1 calls `_recreate_menus`/`setMainMenu_` at startup
  and conditionally on key-window changes, whereas the old repair ran only on document load. This establishes a
  lifecycle gap, not the exact cause of the owner's observed missing menu, which could not be established without
  a native run. Dependencies, version and platform minimums are unchanged.

### Experiment evidence and feasibility limits

The installed development interpreter reports pywebview **6.2.1**. Read-only extraction from the official development
view `steam-3557621-7791673520712697115-1955d55449` found exactly one
`Assets/_MX/AddressableAsset/UI/UICharacterCollection.prefab` in
`ui-_mxload-prefabs-2025-07-02_assets_all_2244454933.bundle`. Its `SeletControl/Top/BG_W/Bg` is
`Common_Top_Menu_Bg`, 2996 × 166; `Label_Title` is 66; right Option/Lobby/Line positions and sizes match the geometry
below. Follow-up extraction confirms its Common atlas crop is 343 × 105 with 310/20 horizontal cuts (drawn caps
172/11 stage pixels), and `CharacterCollection_ScrollBarBg` is 126 × 24. The unchanged corner sources are
`UICharacterVisualMode/Inventory_ListControl_PC/{LeftTop/Btn_Back,RightTop/Btn_HideUI}` and
`UILobby/Front/Right/ScreenshotMode/ModeInformation/Btn_Screen_Off/BG`. No owner's game installation or runtime data was inspected.

Fake-host tests demonstrate rollback for AppKit clipping/relayout rejection and a missing optional WebView2 API;
they also assert DWM-first message routing, preserved non-client side/bottom geometry, negative monitor origins,
96/120/144/192/288 DPI conversion, invalid measurements, native state, callback lifetime and close refusal. Node
geometry tests feed the real six-locale strings at minimum/default/wide/tall sizes, densities 1/2/3 and enlarged
text. Font advances in those tests are deterministic fixtures, not native font-raster evidence.

The alpha.5 toolbar follow-up passes **1,709 JavaScript tests** and **2,846 Python tests**, with **155 Python
skips** in this isolated worktree (no test game view configured). Focused coverage comprises 61 native fake-host
Python tests, 11 immersion/controller tests, 38 shared title/row/navigation tests and 89 bar/switch/scrollbar raster
tests. The full JavaScript run initially exposed incomplete stage-geometry fakes in popup/fidelity tests; those
fixtures now supply the DOM measurement contract and both full suites pass. `git diff main --
src/ba_modding_toolkit/locales` is empty. The native event monitor, preference values and menu timer are verified
with fakes; no real native event routing, preference UI mapping, menu replacement or WebKit painting is claimed.

No real platform feasibility pass or failure is established by those tests. On a failing packaged host, the exact
reason is logged as `Native window chrome inactive: ...` and exposed by `window.chrome` (`reason`, `active`,
`valid`, `bounds`, `state`). M1 specifically fails closed on a clipped button or a rejected y/frame write; W1
specifically refuses installation without the optional SDK property and rolls back subclass/frame/clip failures.
Invalid bounds while minimized/invisible keep the last safe area and suspend adjacent actions until refreshed.
The owner must record any actual painting, event-routing or asynchronous AppKit relayout failure. Do not treat a
successful frame write or a passing fake as visual acceptance, or switch to M2/W2 to hide a failure.

### Owner native acceptance checklist

| Platform | Checks still required |
| --- | --- |
| macOS | Confirm real accessible AppKit controls at the left with unchanged horizontal positions/sizes, centred on the prefab fill after repeated resize, zoom, minimize/restore and native fullscreen entry/exit; no clipping, delayed relayout drift or forced visibility during fullscreen transitions. Check Retina/non-Retina, inactive/hover states and green-button options. Check background/title dragging and double-click under every supported system preference, across monitors/Spaces; every App button/switch/help target must click. Verify Command-W/Q/M and Control-Command-F in the scene and text fields, menu Quit and application termination. Record `window.chrome` reason if M1 falls back. |
| Windows 11 (primary) | Confirm system-drawn caption buttons above WebView2 with no blank/black painting holes. Measure their bounds and centre offset from the game's fill. Check maximize-hover Snap Layouts, Win+Z, Alt-Space, Alt-F4, standard snap/maximize/restore keys, caption right-click/double-click, drag-to-restore, all resize edges/corners and taskbar/work-area limits. Check 100/125/150/200% DPI, mixed-DPI/negative-origin monitors, theme/high contrast/Narrator and no child-HWND input holes. Record the optional API availability and any rollback reason. The retained 960-pixel minimum can exclude snap zones. |
| Windows 10 | Check startup, genuine caption buttons if the existing host passes the capability gate, or the single restored fallback if it does not; ordinary drag/resize/maximize/restore, Alt-F4 and guarded close. No dedicated Windows 10 optimisation is claimed. |
| Both | Exercise every route and all six languages at minimum/default/wide/tall sizes: native clearance, BL-038 Hall enter/leave, BL-043 ink alignment, caption hiding/restoration without oscillation or a second row, title readability and switch/help accessibility. Check no-game/pre-consent/recovery startup, loading and popups. Hall/detail immersion must retain native controls/drag background, remove hidden actions from focus, and restore focus on exit; combine with native fullscreen. For every exit origin check clean close, Stay, Discard, Save, failed Save, repeated requests, dirty/unresponsive page cancellation, writers queued during prompting, safe-restart refusal and update/classic refusal/retry/helper-once. Windows visual acceptance has not been performed. |

## Original design research

Design baseline: `codex/window-controls-design`, `main` commit `6bd15c6e`, version `0.6.0-alpha.4`.
Research date: 2026-10-26. Scope: design only; no application changes, build, native run, screenshots or previews.

Recommend **M1 on macOS: genuine AppKit traffic lights at the left of a window-anchored game toolbar**, and
**W1 on Windows: system-drawn DWM caption buttons at the right of an extended frame**. Both reserve measured native
space and retain the game's toolbar art, action order and BL-043 text treatment. M1 requires proof that the native
buttons can remain vertically aligned through window-state changes. W1 preserves the system's vertical button
position even when it differs from the game bar's fill centre. These are proposed choices, not demonstrated host
implementations. M2/W2 below are alternatives for owner review if those constraints are unacceptable.

## Evidence and limits

The labels below distinguish evidence from intent:

| Label | Meaning |
| --- | --- |
| R | Verified in this repository at the baseline, including checked-in tests; not proof of native behaviour. |
| U | Verified in the upstream **pywebview 6.2.1** source, the declared dependency floor; not proof of the packaged dependency version. |
| D | Behaviour documented by Apple, Microsoft or pywebview. |
| P | Proposed design or implementation direction. |
| ? | Unverified integration detail or missing information; requires investigation or native acceptance. |

The repository declares `pywebview>=6.2.1`, not an exact version ([pyproject.toml](../../pyproject.toml)). The current
shell interpreter has no installed pywebview metadata. Neither the dependency resolved into the owner's packages
nor the supported macOS/Windows release matrix was established. Upstream statements therefore name 6.2.1 explicitly.
No game installation, user data or primary-checkout runtime data was inspected. Prefab geometry below comes from
application code and checked-in fixture expectations, not a fresh extraction of the owner's game. Differences in
another game revision must be measured during a separately authorized implementation/acceptance step.

Related decisions: [BL-024](../backlog.md#bl-024-frameless-desktop-shell-and-macos-menus),
[BL-037](../backlog.md#bl-037-design-native-window-controls-integrated-into-the-top-toolbar),
[BL-038](../backlog.md#bl-038-reflow-settings-when-home-is-hidden-in-student-hall),
[BL-043](../backlog.md#bl-043-top-bar-vertical-centring-and-title-size), and the
[original desktop-chrome request](../feedback-2026-10-26.md#bl-024-detail-native-desktop-chrome).
The present authorization advances BL-037 to a proposed design; it does not authorize its implementation.

## Current shell and its problems

| Area | Current behaviour and evidence |
| --- | --- |
| Host creation (R) | [`webui/main.py::_run_window`](../../src/ba_modding_toolkit/webui/main.py) creates a 1600 × 900 window, minimum 960 × 540, with `frameless=True`, `easy_drag=False`, `text_select=True`, black background and default resizability. It sets `SHOW_DEFAULT_MENUS=False`, `DRAG_REGION_SELECTOR=".topbar"`, `DRAG_REGION_DIRECT_TARGET_ONLY=True`. Windows explicitly selects `gui="edgechromium"`; macOS leaves GUI selection to pywebview. `confirm_close` is not enabled. |
| macOS host (U) | Cocoa 6.2.1 retains titled/closable/miniaturizable/resizable window styles, adds full-size content for frameless mode, makes the title bar transparent, hides its title and hides all three standard buttons. Thus native buttons exist but are hidden; the App has no code restoring them. See [`cocoa.py`, constructor](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/cocoa.py#L516-L644). |
| Windows host (U) | WinForms 6.2.1 uses `FormBorderStyle.None` for frameless windows. WebView2 is a child control docked to fill the form. The current integration does not preserve a system caption-button area. See [`winforms.py`](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/winforms.py#L246-L257) and [`edgechromium.py`](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/edgechromium.py#L83-L95). |
| Visible control group (R) | [`web/js/main.js::setupWindowControls`](../../src/ba_modding_toolkit/web/js/main.js) appends `#native-controls` to `document.body` when `pywebview` exists. It creates HTML buttons `−`, `□`, `×`, with localized accessible names. Despite its ID, this is a custom web group on **both** platforms, ordered minimize/maximize/close at the **top right**. |
| Control styling (R) | [`web/css/app.css`](../../src/ba_modding_toolkit/web/css/app.css) fixes that group to viewport `(right:0, top:0)`, above the UI at z-index 10000; each button is 36 × 24 CSS pixels. The 108 × 24 group is invisible until hover or focus. It is outside the scaled stage and remains when the stage toolbar slides away. |
| Commands (R) | [`webui/api.py::window_control`](../../src/ba_modding_toolkit/webui/api.py) calls `minimize()`, `destroy()` or `maximize()/restore()`. The maximize toggle writes a Python `window.maximized` flag; the App does not synchronize that flag with native maximize, snap or restore events. This is not a reliable native-state model. |
| Dragging (R/U) | Only a direct `.topbar` target starts pywebview's selector drag. Descendants, including the title, do not qualify; blank bar areas do. The 6.2.1 injected script tracks mouse movement and requests window movement, rather than declaring an OS caption hit area. It supplies no title-bar double-click handler. See [`customize.js`](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/js/customize.js#L36-L86). |
| Menus (R) | [`webui/native.py::install_edit_menu`](../../src/ba_modding_toolkit/webui/native.py) adds Cut/Copy/Paste/Select All on macOS after page load. The App does not add a Window menu or explicit minimize/zoom/fullscreen shortcuts. The exact packaged menu and responder behaviour has not been accepted for this design. |
| Toolbar (R) | [`web/index.html`](../../src/ba_modding_toolkit/web/index.html) places Back, page title, Enable Mods, divider, Settings and Home in `.topbar` inside the 1920 × 1080 stage. [`nav.js`](../../src/ba_modding_toolkit/web/js/nav.js) skins Back and the right actions from `UICharacterCollection`; [`top-bar.js`](../../src/ba_modding_toolkit/web/js/top-bar.js) aligns text/sprite ink to the background fill. |
| Clearance and Hall (R) | [`top-action-layout.js`](../../src/ba_modding_toolkit/web/js/top-action-layout.js) measures overlap with the custom group and adds an 8 CSS-pixel right gap. It shifts the right actions only. In Hall it centres Settings in Home's former box and hides Home and the divider; leaving restores the original sibling boxes (BL-038). |

The web group has the wrong side and presentation for macOS, lacks native traffic-light behaviour, and is hard to
discover while invisible. On Windows, a web maximize click is not evidence of Snap Layouts support. The small web
buttons do not supply native caption hit testing, resize borders or system-menu semantics. Title-bar double-click,
native resize and drag-to-restore behaviour remain unverified. Right-side clearance solves a local collision; it
does not budget Back/title/Mods against controls or reserve a macOS left area.

There is also a coordinate mismatch: [`util.js::fitStage`](../../src/ba_modding_toolkit/web/js/util.js) scales and
centres a 16:9 stage inside the viewport. At other aspect ratios, its toolbar can be below or inset from the native
window corner while the custom controls stay at the corner. Keeping the toolbar solely stage-anchored cannot
guarantee a shared native-control row.

### Existing close and fullscreen paths

**R:** [`main.py`](../../src/ba_modding_toolkit/webui/main.py) connects pywebview `closing` to
[`Services.on_closing`](../../src/ba_modding_toolkit/webui/services.py). That method refuses queued/running writers,
publishes `app.busy`, and handles update-related classic-window refusal. `Services.quit` also checks writers.
[`jobs.py`](../../src/ba_modding_toolkit/webui/jobs.py) provides atomic `reserve_quit`/`cancel_quit`, currently used for
update/restart coordination. `on_closed` launches an already prepared update helper only after the window closes.

**R:** [`StudentHall.canLeave`](../../src/ba_modding_toolkit/web/js/student-hall.js) waits for saving and offers Keep
Editing / Discard / Save and Leave for a dirty Hall draft. Navigation, Back/Home and classic handoff use this
permission path. The native closing callback and `window.control:close` do **not** consult it. The roster's
[`quit.js`](../../src/ba_modding_toolkit/web/js/quit.js) adds a separate Quit? confirmation for Back/Escape; it is not
a general native-close interception layer. No general `beforeunload` close guard was found in the main wiring.

**U/D:** Cocoa 6.2.1's `destroy()` schedules `NSWindow.close`, while user close uses its delegate. Apple documents
that `close` skips `windowShouldClose:`. Consequently the existing custom close can bypass the writer callback on
that backend; this is a source-based risk, not a reproduced packaged failure. See
[`cocoa.py` close paths](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/cocoa.py#L682-L698) and
[Apple's `close` documentation](https://developer.apple.com/documentation/appkit/nswindow/close()?language=objc).
The design must preserve the intended guards and close these gaps, rather than assert that every current exit is safe.

**U/?:** the inspected Cocoa WebKit key handler also contains a Command-Q path that directly stops the application
loop. Whether the App's menu consumes the shortcut first in each responder context is unverified; audit both.
See [`cocoa.py` keyboard handling](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/cocoa.py#L460-L490).

**R:** Hall's [`student-hall-fullscreen.js`](../../src/ba_modding_toolkit/web/js/student-hall-fullscreen.js) implements
an immersive **page mode**: it hides/inerts the stage toolbar and navigation, focuses an exit button and restores
focus on leaving. Detail uses the stage's separate `.fullscreen` styling. These modes do not themselves request
native OS fullscreen. Neither is a substitute for the macOS green button or a Windows host fullscreen command.

## Platform conventions and stack feasibility

| Topic | Verified source/documented behaviour | Unverified or proposed integration |
| --- | --- | --- |
| macOS controls | **D:** standard window buttons are close/minimize/zoom at the left; preserve the actual AppKit buttons and their system actions. `standardWindowButton:` returns the window's button. [Apple title-bar API](https://developer.apple.com/documentation/appkit/nswindow/titlebarappearstransparent?language=objc). | **P:** restore the hidden buttons and suppress the HTML group on macOS. **?:** their frames, title-bar container clipping, hover menus, accessibility exposure and fullscreen relayout in the packaged host. Do not assume fixed 12-point circles or fixed spacing. |
| Full-size Cocoa content | **D:** `fullSizeContentView` works with a titled window; transparent title-bar appearance lets underlying content show. [Style mask](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/fullsizecontentview?language=objc), [transparency](https://developer.apple.com/documentation/appkit/nswindow/titlebarappearstransparent?language=objc). | **U:** 6.2.1 already establishes this combination. **P:** keep its delegate, WKWebView and style masks; use the native object rather than replace the window. **?:** sustained alignment after revealing/repositioning buttons. |
| Native access/lifecycle | **D:** pywebview exposes `window.native` at `before_show` as NSWindow on macOS or a WinForms form on Windows; `closing` can cancel. [pywebview API](https://pywebview.flowrl.com/api/#window-native). | **P:** configure native chrome on the GUI thread at `before_show`, then publish measurements when layout is valid. **?:** version-specific event ordering, frame availability and teardown. Recheck the packaged version before implementation. |
| macOS drag and double-click | **D:** `performWindowDragWithEvent:` uses the original native mouse-down event and delegates dragging to the window server. [Apple drag API](https://developer.apple.com/documentation/appkit/nswindow/performdrag(with:)?language=objc). Double-click follows a user preference; current guidance includes Fill, Zoom, Minimize and No Action. [Desktop & Dock settings](https://support.apple.com/guide/mac-help/change-desktop-dock-settings-mchlp1119/mac). | **P:** native hit regions over noninteractive toolbar space, with original-event delivery and system title-bar double-click semantics. **?:** forwarding the event through this WKWebView host and respecting preferences on each supported OS. A delayed HTTP RPC has no original NSEvent; unconditional `maximize()` would not implement the preference. |
| macOS zoom/fullscreen | **D:** native fullscreen is distinct from window zoom; the green control and Control-Command-F provide fullscreen behaviour in supported apps. [Mac fullscreen guide](https://support.apple.com/guide/mac-help/use-apps-in-full-screen-mchl9c21d2be/mac). **U:** 6.2.1 `maximize()` resizes to screen dimensions, `restore()` deminiaturizes, and `toggle_fullscreen()` calls AppKit fullscreen. | **P:** use native zoom/fullscreen actions, not the current web maximize/restore pair, on macOS. **?:** shortcuts/menu wiring and system green-button options on the supported versions. The generic `maximized` event is not sufficient to distinguish zoom from fullscreen. |
| Windows native caption | **D:** DWM custom frames can retain system caption buttons while extending client content into the frame. [Custom frame guide](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe). | **P:** W1 restores caption/system-menu/minimize/maximize/resizable styles and handles frame calculation around the WinForms host. **?:** system drawing above this docked WebView2 child, handle subclassing lifetime, theme behaviour and packaged Python/.NET interop. No one-argument pywebview option was verified to provide this integration. |
| Windows hit testing | **D:** custom frames with standard buttons should pass non-client hit testing to `DwmDefWindowProc` first and also forward `WM_NCMOUSELEAVE`. [DWM procedure](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmdefwindowproc). | **P:** keep system caption hit rectangles unobstructed, map only blank toolbar regions to `HTCAPTION`, keep App controls `HTCLIENT`, and preserve edge/corner resize hit tests. **?:** child-HWND event routing; a parent-only handler must not be assumed sufficient. |
| Windows 11 Snap Layouts | **D:** hovering an available native maximize button exposes Snap Layouts; custom Win32 maximize regions require `WM_NCHITTEST` returning `HTMAXBUTTON`. Win+Z is another entry point. Microsoft warns that large minimum sizes can prevent snapping and recommends at most 500 effective pixels for common layouts. [Snap guide](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu). | **R:** the App minimum is 960 wide. **P:** retain that floor pending owner scope approval; offer native maximize hover but make no promise that every snap zone fits. **?:** actual menu, zone eligibility and snap/restore at DPI settings. Windows 10 has no Windows 11 Snap Layouts flyout; normal maximize/snap still needs acceptance. |
| WebView2 drag support | **D:** newer `IsNonClientRegionSupportEnabled` enables CSS `app-region: drag/no-drag`, including drag, title-bar right-click and double-click maximize/restore; it defaults false and takes effect after navigation. [.NET API](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.isnonclientregionsupportenabled). | **R/U:** this App does not enable it; the inspected pywebview backend does not configure it. **?:** bundled SDK and the App's runtime floor (major 105) supporting it. **P:** capability-check before navigation if selected; otherwise native region routing. CSS alone or a Chromium browser flag is not a verified solution. This API does not itself add caption buttons. |
| Windows fullscreen | **U:** 6.2.1 has a separate host `toggle_fullscreen` path that changes form presentation; maximize uses WinForms window state. [`winforms.py`](https://github.com/r0x0r/pywebview/blob/6.2.1/webview/platforms/winforms.py). | **P:** retain separate native fullscreen, maximized, snapped and page-immersive states. **?:** exact frame restoration after adding W1, taskbar/work-area bounds and multi-monitor transitions. No new Windows fullscreen shortcut is assumed. |

System-drawn controls are preferred to imitating traffic lights or adding `HTMAXBUTTON` to the existing three web
glyphs. The latter could supply some Windows semantics but still leaves drawing, accessibility, themes and state
management to the App; it does not satisfy the request for genuine native controls. WinUI/AppWindow title-bar
examples are not drop-in pywebview/WinForms APIs; adopting another window framework would be a separate decision.

## Geometry to preserve and coordinate contract

**R:** the donor is `UICharacterCollection/SeletControl/Top/BG_W/Bg`, with `Common_Top_Menu_Bg` and `Label_Title`;
the right group is `UICharacterCollection/NUITop_Scenes/Top/Right`. The `SeletControl` spelling is intentional.
The renderer exports widget sizes/positions through [`gameassets/layouts.py`](../../src/ba_modding_toolkit/gameassets/layouts.py).
The following values are recorded in [`top-bar-layout.js`](../../src/ba_modding_toolkit/web/js/top-bar-layout.js),
[`nav.js`](../../src/ba_modding_toolkit/web/js/nav.js), [`top_bar_layout.test.mjs`](../../tests/js/top_bar_layout.test.mjs)
and [`nav_geometry.test.mjs`](../../tests/js/nav_geometry.test.mjs). Fixture assertions describe the checked-in
contract, not independently verified current game assets.

| Element | Prefab units (U) / recorded position | Current stage geometry (before outer viewport scale) |
| --- | --- | --- |
| Conversion | `S = 1920/2960 = 24/37` stage pixels/U | `k = min(viewportWidth/1920, viewportHeight/1080)` CSS pixels/stage pixel; one U = `S*k` CSS pixels. |
| Background | Sliced widget recorded as 2996 × 166 U; source sprite 105 rows high | App renders the bar 64 stage pixels high = 98.667 U. It does **not** render the widget at `166*S` high. Source fill rows `[0,97)` exclude the dark lip/shadow. |
| Fill centre | Derived 45.5746 U below the rendered bar top | `64*97/210 = 29.5619` stage pixels; bottom padding 4.8762 stage pixels, not centre 32. Preserve BL-043's fill/ink rule. |
| Title | `Label_Title` size 66 U | `66*S = 42.8108` stage pixels; Latin uses the existing 1.12 drawing factor (47.9481); other scripts use their existing treatment. The App intentionally keeps the larger Latin title. Title starts approximately x=160 stage pixels (246.667 U) in the current border/flex layout. |
| Back | `Bg/Btn`, rendered box 164 × 172 U | Approximately x=38, y=9, width=106.3784, height=111.5676 stage pixels. Its round art intentionally hangs below the 64-pixel bar. Do not force its whole box onto the fill centre or turn the hanging area into a caption drag region. |
| Home (`Lobby`) | Position `(-98.8,-51.8)`; 62 × 59 U | Right inset 44 stage pixels (67.8333 U); width 40.2162, height 38.2703. After BL-043 ink alignment its top is about 10.4268. |
| Settings (`Option`) | Position `(-272.8,-52.4)`; 60 × 62 U | Right inset 157.5135 stage pixels (242.8333 U); width 38.9189, height 40.2162; aligned top about 9.4538. |
| Divider (`Line (1)`) | Position `(-186.3,-54.2)`; 4 × 49 U | Right inset 119.5676 stage pixels (184.3333 U); width 2.5946, height 31.7838; aligned top about 13.6700. |
| Right sibling spacing | Settings-to-Home centres differ by 174 U; divider-to-Home by 87.5 U | 112.8649 and 56.7568 stage pixels respectively. Preserve as a group outside Hall. The initial CSS fallback boxes are approximate, not a second prefab specification. |
| Mods group | App-composed from game filter segments/information art, not an original window-control prefab | Existing title-to-group gap 32 stage pixels = 49.3333 U; internal flex gap 12 stage pixels = 18.5 U. Measure its localized width, including switch, label and help. |

**P — shared contract for M1/W1:** anchor a single toolbar host to the **window's top edge and full client width**,
outside the aspect-fitted stage transform. Continue drawing the game sprites/text at `S*k`, and stretch the
existing nine-slice horizontally. Its logical width becomes `viewportWidth/k` stage pixels; do not pretend it is
always 1920. Keep the content stage's fit and capture inputs separate. Audit overlays and focus code that currently
find `.topbar` below `#stage`; moving the header is not just a CSS offset.

Use one set of measured rectangles in top-left client CSS coordinates for layout and native hit testing. Convert
AppKit points/view origins or Windows physical pixels/window-relative origins explicitly; do not multiply native
button dimensions by `S` or by stage scale. Publish coordinate origin, DPI, native state and a layout generation
with each update. Discard stale generations after resizing, route changes, font loads or resource changes.

Native measurements are authoritative. Windows can query `DWMWA_CAPTION_BUTTON_BOUNDS`, whose rectangle is
window-relative and undefined while minimized/invisible; validate it before use.
[Microsoft's bounds definition](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).
Per-DPI metrics are available, but do not replace the actual caption bounds with a guessed `3*46` width.
[GetSystemMetricsForDpi](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetricsfordpi).
On macOS, convert each real button's frame into window/client coordinates and reserve the group's union. If
measurements are temporarily invalid, retain the last valid safe area and suspend adjacent actions until refreshed;
on first layout, keep App controls out of the native corner until valid measurements arrive.

**P — dimensions, not platform facts:** use an 8 CSS-pixel gap from native bounds and a minimum 32 × 32 CSS-pixel
hit area for App actions without enlarging their sprite ink. At `k=.5`, these equal 24.667 U and 98.667 U respectively;
at `k=1`, 12.333 U and 49.333 U. A 44 CSS-pixel minimum App row is proposed to keep enlarged hits inside the row.
That makes row height `H=max(64*k,44,nativeBottom+4)` where `nativeBottom` is measured from its top. For a stretched
bar, the fill line is `C=H*97/210`; retain the same ink-alignment method, rather than centre on `H/2`. At 960 × 540,
this is deliberately taller than today's 32 CSS-pixel bar and needs owner approval.

Reserve full hit areas, not only visible ink. Translate the left Back/title/Mods composition right as needed so
Back's left hit edge clears a left native group by 8 CSS pixels. Translate the right group left only as far as
needed to clear a right native group plus the gap; **do not add the native width on top of an already sufficient
44-stage-pixel margin**. Retain the original relative offsets. Native exclusion rectangles also exclude focus rings,
popups and transparent DOM overlays. The rightmost safe slot is the Home slot outside Hall and the Settings slot
in Hall.

## Layout options

The interaction, overflow and close requirements following this table apply to **all four** options.

| Option | Layout and alignment | Space, Hall and principal tradeoff |
| --- | --- | --- |
| **M1 — integrated native left group (recommended)** | Window-anchored game row; native close/minimize/green group at top left, then translated Back, title, Enable Mods; Settings/divider/Home stay at the right. Keep native horizontal spacing and button size. Aim to move the group **vertically only** so its measured centre matches fill line `C`. Blank row space drags; every button and the switch clicks. | Left reservation follows the native union, including its hit areas, plus 8 CSS pixels. Hall removes Home/divider and moves Settings to the safe outer slot. This spends width beside Back instead of height above the toolbar. **?:** a standard view's frame can be repositioned, but AppKit may relayout/clip title-bar buttons; no guarantee that a simple frame write works here. Retain system controls/actions; do not reparent into WKWebView or rely on private title-bar view classes. |
| **M2 — native upper lane, prefab lower lane** | Keep traffic lights in AppKit's own location. Reserve an upper lane at least as deep as their measured bottom plus 8 CSS pixels; draw the game's fill across it. Put the full prefab toolbar below that lane, keeping Back/title/Mods at the left and Settings/Home at the right. Each lane has its own centre; do not claim all controls share a line. | Avoids moving native buttons and gives the lower row the full width. Hall remains a one-action right group with no empty Home slot. Blank upper/lower background can drag; native and App hit areas cannot. Costs vertical space and weakens the single-row appearance; prefer it if M1 cannot remain stable or the owner prioritizes default traffic-light placement. |
| **W1 — extended frame, native right group (recommended)** | Native minimize/maximize-or-restore/close remain top right. Back/title/Mods remain left; Settings/divider/Home shift left of the measured caption area. Extend the game's background under the caption area without covering its native surface. Keep App ink on `C`; preserve the **system's** button y-position and report the difference between its centre and `C`. | Right reservation uses actual native bounds, never the old 108 × 24 web box. In Hall, Settings alone takes the nearest safe outer slot; no Home-sized hole or divider. OS caption size/top-edge behaviour takes precedence over pixel-perfect shared centring. **?:** DWM painting, WebView2 occlusion and hit routing must be proven in this host. Do not vertically relocate system buttons with invented hit rectangles. |
| **W2 — stock native caption lane plus prefab row** | Use the normal resizable WinForms frame, with its three native buttons in the upper right and the existing game toolbar immediately below. App controls retain their accepted fill-centre alignment within the lower row; the native lane has a separate centre. Native caption space drags, and lower-row blank space can also drag once routed correctly. | The lower row needs no caption-width deduction; Hall still reflows Settings normally. Lowest frame-integration risk and familiar system behaviour, but adds a visible title/caption lane and height. It is an explicit owner-approved exception to BL-024's title-bar removal, not an automatic fallback to ship. Keep a meaningful native window title for accessibility. |

Apple documents [`NSView.setFrameOrigin:`](https://developer.apple.com/documentation/appkit/nsview/setframeorigin(_:)?language=objc)
as moving a view within its superview. It does **not** promise that modifying a standard window button's frame
survives AppKit's toolbar/fullscreen layout. M1 therefore has a native feasibility gate. If it fails, take M2 back
to the owner; do not replace the system buttons with painted circles. Similarly, W1's centre-line difference is
an explicit design compromise requiring review, not evidence that Windows allows arbitrary native-button placement.

### Narrow windows and action priority

**P:** use measured collision thresholds rather than a language-specific fixed breakpoint. Keep Back and the
right-side Settings/Home hit boxes fixed after safe-area placement. Keep the title at the BL-043 drawing size and
truncate with an ellipsis only when necessary; keep its complete accessible name. Reserve at least 64 CSS pixels
of continuous blank drag space between the left composition and the right actions. This equals 197.333 U at the
current minimum-window scale, or 98.667 U at `k=1`.

If the measured Back + title + complete Mods group + drag space + right actions + native exclusions do not fit,
move the **whole Enable Mods group**, including label, state and help, to a second App row immediately below the
main row. Keep its current switch semantics and shared state with Settings. Do not shrink the title's font,
silently remove the switch, split its label from it, or shrink native controls. The second row uses the same
44 CSS-pixel minimum and a 16 CSS-pixel left inset; in M2/W2 it follows the prefab row, not the native lane.
Return the group when it fits with 16 CSS pixels of spare width to prevent resize oscillation.

Reserve additional header height instead of covering roster controls or Hall content. Keep header scale `k`
based on the full viewport, independently of content fitting, so moving Mods cannot recursively change its own
overflow threshold. Let `T` be the total header height, including any native lane/extra App rows; reserve
`E=max(0,T-64*k)` beyond the existing bar. Fit/centre the content stage inside `(0,E,viewportWidth,viewportHeight-E)`
with its own scale `kc=min(viewportWidth/1920,(viewportHeight-E)/1080)`. The baseline one-row height has `E=0`;
the taller minimum row and every added lane reserve their extra height. Keep Back's hanging-art behaviour, and
recompute action/drag bounds with the header's scale, not `kc`. The exact page-dependent content shift and enlarged
minimum row's visual effect are unverified and need acceptance. Under extreme text enlargement, prefer another
row/scrollable App overflow to overlapping native controls. Do not lower the existing 960 × 540 minimum as part of
BL-037 without owner authorization for a wider responsive-layout task.

On no-game, recovery and pre-consent screens, retain usable native controls and Settings. The top Mods group and
Home follow their existing availability rules. Native chrome and safe spacing must not wait for game-asset loads.

### Drag, click, keyboard and accessibility

**P:** derive draggable rectangles from the visible header background minus all native/App hit boxes, expanded
for focus rings. The page title and decorative background may drag and accept title-bar double-click; the title
is not an action. Back, Settings, Home, every Mods segment/label/help target, popups, inputs and the hanging Back
box stay clickable. Dragging a Hall scene or camera must never move the window. Popup coverage temporarily removes
covered drag regions. Decorative DOM wrappers must not turn new parts of an action into drag targets.

M1/M2 should use native event handling/transparent native hit views only over known blank/title rectangles, passing
the original NSEvent to AppKit dragging. Double-click must follow the supported OS's title-bar preference; its
implementation route in this pywebview host is unresolved. Do not use private preference keys without verifying
the supported versions. W1/W2 should use native caption routing or capability-checked WebView2 non-client regions,
with explicit `no-drag` exclusions. Native caption double-click should maximize/restore; system-menu right-click
and drag-to-restore must work. Disable the old pywebview selector drag on any area handled natively, so one gesture
cannot trigger two movement systems. CSS `-webkit-app-region` alone is not a cross-platform solution.

Keep native accessibility roles, names, enabled state, system hover/pressed/inactive presentation and native sizing.
Do not create duplicate invisible HTML window buttons. Preserve localized App action names and visible focus rings;
the Mods control keeps `role="switch"`, `aria-checked`, its label and unavailable/busy description. Decorative
divider/background/drag spacers are not focusable. App tab order is Back, Mods switch/help, Settings, Home, following
visual order; omit hidden Home and move Mods' DOM/focus order with its row. Native controls follow OS navigation,
not an invented HTML tab sequence. Preserve focus after moving a row or cancelling a close.

Provide reachable native menu/keyboard actions for close, minimize, zoom/maximize/restore and fullscreen where the
platform supports them; preserve macOS editing shortcuts. Acceptance must cover Command-W, Command-Q, Command-M,
Control-Command-F, Windows Alt-F4, Alt-Space, Win+Z and standard maximize/restore keys. These are target behaviours,
not claims that the current menus wire all of them. Escape keeps existing modal/IME/roster-quit precedence.
Verify VoiceOver, Narrator, keyboard-only operation, focus visibility at fractional DPI, reduced motion and high
contrast. Native controls remain discoverable without hover or colour discrimination.

### Maximize, zoom, OS fullscreen and page immersion

**P:** derive state from the actual native window and notifications, not the manually toggled `window.maximized`
flag. On resize, zoom, maximize, snap, restore, DPI/monitor change or native fullscreen transition, recompute the
toolbar's origin, native safe rectangles and overflow as one layout update. On Windows preserve work-area/taskbar
limits, resize borders and restored bounds; on macOS preserve zoom/green-button semantics and fullscreen Spaces.
While minimized, ignore invalid caption bounds and refresh on restore. Support unfocused/disabled native states.

OS fullscreen and page immersion remain independent. In macOS OS fullscreen, let AppKit control native-button
visibility/reveal and use its actual fullscreen layout/safe area; never force traffic lights permanently visible
through a transition. The game row can remain until the user enters page immersion. For any future Windows host
fullscreen entry, hide the caption through the host's fullscreen policy and restore exact styles/bounds on exit;
do not treat a maximized window as fullscreen.

For existing Hall/detail page immersion in an ordinary window, hide/inert the App action rows while retaining
native window controls and a minimal native drag background. The window-owned header background remains; page
immersion is not a request to hide the OS controls. Keep Hall's existing exit button, popup precedence and focus
restoration, updating its selectors after moving the header. In simultaneous OS fullscreen + page immersion,
native reveal follows the OS while the page exit restores App actions only. Resizing or leaving either mode must
not expose stale clickable or draggable rectangles. This changes the current stage-selector implementation and
requires explicit regression checks for Hall and detail.

### Close safety shared by both recommendations

**P:** introduce one close coordinator covering native close, native menus/keyboard, custom fallback if retained,
tray Quit, `app.quit`, safe restart and update restart. Keep the existing roster Quit? behaviour on Back/Escape;
do not add that generic prompt to every clean native close. Every close must still check dirty Hall edits and
active writers. Preserve the same Keep Editing / Discard / Save and Leave outcomes and existing busy feedback.

The coordinator should:

1. Refuse immediately while a writer is queued/running, preserve `app.busy`, and coalesce repeated close requests.
2. Veto the first native close synchronously and request `StudentHall.canLeave()` asynchronously when needed.
   Never block the GUI thread waiting for an HTTP response or JavaScript promise. Stay/cancel/save failure keeps
   the window and draft, restores focus and releases pending-close state.
3. After the draft is saved/discarded, recheck writers and atomically reserve writer admission before authorizing
   destruction. Do not reserve before Save and Leave, because saving may need writer admission. Permit only one
   final close; revoke the permit/reservation if the host refuses or fails to close. A new dirty revision
   invalidates an old approval. Use the existing classic-start coordination where required.
4. Use native close routes that consult the guard (`performClose:` on Cocoa), and make any unavoidable low-level
   destroy path explicitly consume the same approval. Do not assume `destroy()` emits cancellable `closing`.
   Application termination needs its own guard, as Apple distinguishes window close from application quit.
   [Apple `performClose:`](https://developer.apple.com/documentation/appkit/nswindow/performclose(_:)?language=objc),
   [delegate semantics](https://developer.apple.com/documentation/appkit/nswindowdelegate/windowshouldclose(_:)?language=objc).
5. Keep `on_closed` as the point that releases a prepared update helper. Complete interactive draft preflight
   **before** the existing update path starts its three-second native-close wait. Retain verified-download retry,
   classic-window refusal, helper-once and safe-restart admission behaviour. Do not confuse deferred UI permission
   with a failed updater close, or release another operation's quit reservation.

If the page cannot answer and draft state is unknown/dirty, cancel the close rather than infer permission from a
timeout. The startup/recovery case with no editor must still allow a guarded native close without waiting for
game assets. The exact dirty-state handshake and owner policy for an unresponsive dirty editor remain open.
OS force quit/process termination is outside this cancellable-close contract.

## Recommendation, risks and future implementation outline

**M1** best fits the requested three native top-left buttons while retaining a single game toolbar row and the
accepted right-side Hall arrangement. Cocoa's existing full-size titled window makes revealing the actual controls
a plausible small native-host change. Risks are button-container clipping/relayout, native event forwarding,
fullscreen transitions and pywebview close/keyboard paths. Source inspection is evidence of an entry point, not
proof that re-centred traffic lights work. A native acceptance failure must return the M2 choice to the owner.

**W1** best preserves the requested native top-right controls and Windows 11 maximize-hover semantics within one
toolbar. It avoids recreating system button drawing and accessibility. It is the higher-risk host change: styles,
non-client calculation, child-HWND input/painting, DPI and restored geometry must cooperate. Preserve OS button
geometry even if its centre differs from the BL-043 fill line. The amount is unknown until measured; acceptance
must record it. If the owner requires exact shared centring or native integration fails, review W2's added lane.
Do not silently ship the existing web group as the finished BL-037 design.

No files in this outline are to change in the present design task.

| Future files | Proposed responsibility |
| --- | --- |
| `webui/main.py`, `webui/native.py`; possibly new `webui/window_chrome.py` with platform modules | Install native adapters at the correct lifecycle phase, reveal Cocoa controls, preserve/extend Windows frame styles (`WS_CAPTION`, `WS_SYSMENU`, `WS_MINIMIZEBOX`, `WS_MAXIMIZEBOX`, `WS_THICKFRAME`), coordinate `WM_NCCALCSIZE`/frame refresh with child bounds, marshal to GUI threads, subscribe/unsubscribe state/DPI notifications, expose capability/geometry snapshots. Keep pywebview delegates, tray and renderer validation intact. A maintained upstream hook may be needed if exposed native handles are insufficient; framework replacement is not assumed. |
| `webui/api.py`, `webui/services.py`, `webui/jobs.py`, `webui/tray.py` | Replace ad hoc maximize state with native state; route close/quit through the coordinator and preserve writer/update/classic interlocks. Reuse existing job reservation primitives unless tests show a needed change. Native close must function without a loaded game. |
| `web/index.html`, `web/css/app.css`, `web/js/main.js`, `nav.js`, `top-action-layout.js`, `top-bar-layout.js`, `top-bar.js`, `util.js` | Create a window-anchored header, remove the HTML group on supported native adapters, publish App hit/drag regions, reserve left/right native space, handle overflow/content fitting and keep prefab/ink/font rules. Preserve a deliberate unsupported-platform/browser-mode policy rather than showing duplicate controls. |
| `web/js/student-hall.js`, `student-hall-fullscreen.js`, `detail.js`, `lobby.js`, `quit.js`, `mod-switch.js` as needed | Connect unsaved permission, relocate header focus/immersive selectors, preserve camera/capture boundaries and switch state during row movement. Check all `.topbar` consumers before moving it. |
| `webui/native.py`, `webui/strings.py` and locale files only if a new command label is necessary | Provide reachable native commands while retaining the minimal macOS menu decision and localized action names. Prefer existing labels; do not add unrelated menu entries. Any future locale edits require implementation authorization. |
| `pyproject.toml` / platform packaging inputs, only if required by feasibility findings | Confirm exact pywebview, WebView2 SDK/runtime and PyObjC/.NET capability requirements. A new dependency or higher runtime/OS floor requires owner review; no such bump is assumed by this design. |

### Tests to add during implementation

| Verification | Meaningful additions/regressions |
| --- | --- |
| Pure layout / Node | Extend `tests/js/top_bar_layout.test.mjs` and `nav_geometry.test.mjs`: left and right native bounds, no overlap of expanded hits/focus rings, fill-centre alignment, retained 66-U title size and 174-U sibling spacing, Hall enter/leave without residual slots, letterboxed origins, fractional scale/DPI, overflow thresholds/hysteresis and stable content fitting. Test all six shipped languages, minimum 960 × 540, normal 1600 × 900, wide/tall windows, no assets and text enlargement. |
| Close coordinator / Python and Node | Add focused tests beside `tests/test_webui.py`, `test_jobs.py`, `test_tray.py`, `tests/js/quit.test.mjs` and Hall navigation tests: every close origin, dirty Save/Discard/Stay, save failure, repeated close, stale approval, writer queued during prompting, atomic admission, no `closing` callback on destroy, deferred native refusal, unresponsive page and recovery startup. Retain update timeout/refusal/helper-once and reservation-ownership coverage. |
| Host adapter unit tests | Fake native APIs to assert correct styles, thread dispatch, coordinate conversion, DWM-first hit-test order, resize-edge priority, valid/invalid bounds handling and cleanup. Verify that replacing selector drag does not leave two active drag systems. These tests prove requests made to APIs, not OS outcomes. |
| Immersive/focus regressions | Extend `tests/js/student_hall_fullscreen.test.mjs` and detail/lobby tests for a header outside the stage, hidden actions absent from tab/drag targets, nested modal precedence, combined OS/page states, focus restoration and camera/capture isolation. |

### What only native acceptance can prove

Use packaged hosts on the agreed macOS and Windows versions; a development browser cannot prove these items.
Acceptance is future work, not performed or authorized here. Text results/geometry measurements suffice for this
design's follow-up; no screenshot or preview is part of the present task.

| Platform | Required native observations |
| --- | --- |
| macOS | Three actual left AppKit buttons with system actions/hover/inactive state and VoiceOver names; group centre/clearance after resize and language changes; no clipping on Retina/non-Retina displays; native drag across monitors/Spaces; title-bar double-click under every supported preference; zoom versus green-button fullscreen; native reveal and exit; minimize/restore; all close/quit keyboard/menu routes with dirty Hall and writers. Test keyboard focus in text inputs as well as the scene. |
| Windows | Three system-drawn right caption buttons visible above WebView2; maximize-hover Snap Layouts and Win+Z on Windows 11; fit/refusal of snap zones with the retained minimum size; maximize/restore and drag-to-restore; native title-bar double-click/right-click; resize edges/corners and taskbar clearance; 100/125/150/200% DPI and cross-monitor changes, including negative screen coordinates; theme/high contrast/Narrator; no child-HWND input holes. Measure the native-to-fill centre offset. Test Windows 10 separately if supported. |
| Both | Back/title/Mods/Settings/Home do not overlap native controls on every route; Hall has one outer Settings action and no divider; narrow/expanded-text overflow remains usable; native controls work before assets load and behind App modals; native OS fullscreen and Hall/detail immersion do not trap focus; every close origin preserves drafts or explicitly discards them and refuses active writers; a refused close leaves update/classic admission and the window usable. |

## Open questions for the owner

1. **Layout choice:** approve M1/W1's single-row direction? For macOS, is moving native buttons vertically acceptable
   if stable, or should their default location take priority (M2)? For Windows, may system caption centres differ
   from the game's fill line, or is the extra native lane in W2 preferable? Neither fallback ships automatically.
2. **Narrow windows:** approve the proposed 44 CSS-pixel minimum App row, 32-pixel App hits and whole Mods group
   moving to a second row when necessary, while preserving the 66-U title drawing size? This can change content
   height at the current minimum size.
3. **Snap scope and platform floor:** retain 960 × 540 and accept limited snap-zone eligibility for BL-037, or
   commission a separate responsive-layout task toward widths of 500 effective pixels or less? Which macOS and
   Windows versions, displays and packaged dependency versions define acceptance (including Windows 10 support)?
4. **Close policy:** approve using the existing Hall unsaved prompt for every native/app quit origin, with clean
   native close remaining prompt-free, and cancelling when an unknown/dirty page cannot answer? Should a separate
   recovery action be offered for a persistently unresponsive editor? Native close must retain writer refusal.
5. **Immersion and commands:** approve retaining native chrome/a minimal drag background during page immersion,
   with native OS fullscreen reveal controlled by the OS? Approve adding only the native Window/fullscreen
   commands needed for keyboard access while keeping BL-024's removal of framework-specific menu entries?

Owner review of this document is the next decision. Feasibility experiments, prototype code, native acceptance
and implementation remain separate, unstarted work.
