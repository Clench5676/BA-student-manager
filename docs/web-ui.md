# Web UI

The new GUI: a pywebview window showing a local web front end that reproduces the in-game Blue Archive UI, built
from the approved prototype (`prototype/main-screen-v4`, git-ignored). Game art is read from the user's own install
at runtime and never shipped with the program.

## First milestone

- Screens: consent popup, student roster, student detail (Portrait, Memorial Lobby and 3D tabs), the
  switch-portrait popup and the variant picker. The lobby is framed and touched like the game (its prefab data,
  `lobby.json`) and plays its dialogue with Kivo's voices and the lines in the UI language (Kivo's Chinese and
  Japanese, the Global server's official English and the others); the 3D tab shows the variant's chibi, exported
  from the install, and is disabled only for variants without one.
- Nav entries without a new screen yet open the classic Tk GUI on that tab (`bamt --tab <name>`).
- `bamt` (and the compiled app) starts the web UI; `bamt --classic` starts the classic Tk GUI.
- Released builds look for a newer GitHub release at start and can update themselves (`updater.py`).
- Out of scope for now: a settings screen, the other tool screens, zh-TW and ja UI strings.

## Process layout

```
pywebview window (main thread) ── HTTP ──> WebServer (threaded WSGI, 127.0.0.1, random port)
                                              /              static front end (ba_modding_toolkit/web)
                                              /api/rpc       calls, JSON in and out
                                              /api/events    Server-Sent Events
                                              /asset/...     game assets read from the install
```

The front end only speaks HTTP and SSE, never the pywebview `js_api`. So it runs in any browser during development
(`bamt --browser`, or `--serve` for tools), and tests drive the WSGI app without a window. Native features (file dialogs, drag-and-drop
paths, reveal in the file manager) run in Python; dropped paths reach the page as an event.

Every request must carry the session token (cookie `bamt`, set when the page is first opened with `/?t=<token>`, or
header `X-BAMT-Token`), and the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`.

## Packages

```
src/ba_modding_toolkit/
  config.py      Tk-free settings: same config.toml groups and keys as gui/configs.py
  gameassets/    UI atlases, UI textures, prefab layouts, collection art and Spine skeletons from the install
  catalog/       students (families) and their variants, names in zh-CN, zh-TW, en and ja
  library/       the user's portrait and lobby mods: add, remove, apply, restore, update, extract, compare
  webui/         server, RPC, events, jobs, pywebview window, entry point
  web/           static front end, no build step, plain ES modules
```

Imports only go one way: `webui` → `library` → `catalog` → `gameassets` → the existing core modules (`bundle`,
`searching`, `naming`, `utils`, `core`, `mod_install`). `gameassets`, `catalog` and `library` never import `webui`,
`gui`, `tkinter` or `webview`.

## Rules for every service

- **Threads.** Services are thread-safe: HTTP handlers run on many threads at once. UnityPy work on one bundle is
  serialised with a per-bundle lock. Long operations run on the single job worker (see Jobs).
- **No prose in results.** Services return data, not sentences. Errors are `ServiceError(code, **params)`
  (`ba_modding_toolkit/errors.py`); the front end shows the locale string `webui.error.<code>`. Diagnostics go to
  `logging.getLogger(__name__)`, never `print`.
- **JSON-ready results.** Dataclasses with `to_json()` returning plain dicts; paths as absolute strings, dates as ISO
  strings.
- **Game assets.** Two classes:
  - *Light*: atlas sprites, atlas metadata, UI textures, prefab layouts and the bundle indexes. Kept in memory; written
    to the disk cache only after the user agreed (`consent = true`).
  - *Heavy*: collection backgrounds and portraits, Spine skeletons, lobbies and their data, 3D models, voices,
    anything from a character bundle. Memory only, never written to disk, served with `Cache-Control: no-store`.
- **Disk cache.** `user_cache_dir()/<resource_version>/...`, where `user_cache_dir()` is
  `%LOCALAPPDATA%\BA-Modding-Toolkit\cache` on Windows, `~/Library/Application Support/BA-Modding-Toolkit/cache` on
  macOS and `$XDG_CACHE_HOME/BA-Modding-Toolkit` (or `~/.cache/...`) elsewhere. It can be cleared from the UI.
- **Resource version.** SHA-1 of `Catalog/Windows/catalog_Windows.hash` when present, else of the sorted
  `(name, size)` listing of the resource folders. The cache key; a game update starts a new cache folder.
- **User data.** The mod library and UI state live in `utils.EXE_DIR` (the portable data directory the app already
  uses for `config.toml` and `output/`). Several instances may share it: a change to the UI state (`webui.json`) is
  applied to the file as it is at that moment, read again under a lock the instances share (`webui.json.lock`), so
  no instance erases another's keys, and reads follow the other instances' writes.

## gameassets

```python
class GameAssets:
    def __init__(self, resource_dirs: list[Path], cache: AssetCache): ...
    resource_version: str

    # light
    def atlases(self) -> dict[str, dict[str, dict]]           # {atlas: {sprite: {x, y, width, height,
                                                               #   borderLeft, borderRight, borderTop, borderBottom,
                                                               #   paddingLeft, paddingRight, paddingTop, paddingBottom}}}
    def sprite_png(self, atlas: str, sprite: str) -> bytes
    def textures(self) -> list[str]                            # UITexture names
    def texture_png(self, name: str) -> bytes                  # also the pointer and touch effect textures
    def layout(self, root: str, subpath: str = "") -> dict     # prefab subtree, schema below

    # heavy
    def collection_bg(self, name: str) -> tuple[bytes, str]    # (data, mime)
    def collection_portrait(self, name: str) -> bytes          # PNG
    def collection_names(self) -> dict[str, list[str]]         # {"bg": [...], "portrait": [...]}
    def spine_cores(self, kind: str) -> dict[str, list[Path]]  # kind "spr" | "lobby": core -> bundle parts
    def spine_files(self, kind: str, core: str) -> dict[str, bytes]        # file name -> bytes (.skel, .atlas, pages)
    def spine_files_from(self, bundles: list[Path]) -> dict[str, bytes]    # the same, for a mod's bundle files
    def lobby_info(self, core: str) -> dict                    # a lobby's layers, touch boxes and clips (lobby.py)
    def model_cores(self) -> set[str]                          # dev names with a chibi (character-<dev>-_mxload-*)
    def model_glb(self, core: str) -> bytes                    # the chibi as one GLB (model.py)
```

`model_glb` reads the prefab bundles, then only the bundles its objects point into (a CAB name index built from the
bundle headers). The GLB is never written to disk; the memory entry is reused while every bundle the export read is
unchanged.

The GLB carries what the game's shaders need: per material its shader, shading kind, constants (`colors` as stored,
`vectors` naming the Vector properties and `hdr` the HDR Color properties the game passes unconverted; it converts
every other Color property from sRGB), `keywords`, whether it draws an outline (its
shader's Outline pass, unless the material turns that pass off) and its colour pass `state` (cull, depth write, blend, queue, resolved against the material); per texture its sampler (filter,
wrap, mipmaps as in the game: the characters' textures have none) and `extras.linear` for masks; per clip the renderer
switches it animates (`toggles`: alternative faces), so a renderer the prefab disables is exported when a clip turns
it on. Euler rotation curves are turned into quaternions in the rotation order their binding carries (`customType`:
Unity's own ZXY for curves made in Unity, XYZ where an FBX kept Euler curves, as NP0186's battle idle). Renderers
only an EX skill shows are kept aside the same way, though the prefab enables them: the alternative expression faces
(of the face renderers, the ones without eyes beside one with them; the gag face lies in front of the eyes, and the
skill's timeline, not the Animator, switches the faces) and a cut-in copy of the body.
`web/js/chibi-materials.js` ports the MX/C-* shaders from their compiled D3D11 programs (the game is in linear
colour space; the character light is the standard one, white and from straight above, without ambient), and for props
DSFX/FX_SHADER_Matcap (a riot shield, soup), MX/E-Water (the surface colour: the game deepens it by the camera depth
behind it, which a lone chibi lacks) and the unlit and effect shaders, each with its own texture slot and colour. The outline is
0.1 % of the stage width times the vertex colour alpha, as in the game. The camera orbits freely; the zoom stays between
the bust and a step back, and a double click returns to the front view.

`AssetNotFound` (a `KeyError`) when a name is unknown. Layout nodes use the schema of
`prototype/research-v4/tools/layout.py`: `{name, active, pos[x, y], scale[x, y], rotZ, widgets[], children?}` with
the widget fields documented there; atlas and texture references are resolved to names.

## catalog

```python
@dataclass
class Variant:
    key: str                  # file_id lower-cased: "hoshino", "hoshino_swimsuit", "ch0241", "np0045"
    file_id: str              # as in the character map: "CH0241"
    family: str               # Family.key
    names: dict[str, dict]    # {lang: {"full": "星野（一年级）", "short": "一年级"}}, langs zh-CN zh-TW en ja
    playable: bool            # a playable student (on some server)
    order: int                # release order inside the family
    spr: str | None           # Spine portrait core, e.g. "ch0241_spr", when the install has it
    lobby: str | None         # memorial lobby core, e.g. "ch0241_home", when the install has it
    bg: str | None            # collection background texture name
    portrait: str | None      # collection portrait texture name (None: the front end renders a bust)
    date: str | None          # date of the portrait bundle
    page_id: str | None       # the student page on Kivo, for lobby lines
    recruitable: bool         # on the selected server: its collection portrait is installed, else the shipped flag
    model: str | None         # 3D chibi dev name, e.g. "hoshino_original", "ch0242", when the install has it
    schale_id: int | None     # the game's character id (SchaleDB's), for the Global server's lobby lines

@dataclass
class Family:
    key: str                  # the base variant's key, e.g. "hoshino"
    names: dict[str, str]     # base name per language
    school: str | None
    variants: list[Variant]

class Catalog:
    def __init__(self, game: GameAssets | None, character_map: Path | None, data: Path = <package data>,
                 server: str = "global"): ...           # "global" | "japan", Settings.server_region()
    def families(self) -> list[Family]
    def family(self, key: str) -> Family
    def variant(self, key: str) -> Variant
    def variant_for_core(self, core: str) -> Variant | None    # "ch0241_spr" or "ch0241_home" -> Variant
```

Sources: the character map CSV the app already downloads (`BA-Characters-Internal-ID.csv`, one row per file id, with
student id, names and skins in several languages), the curated data file shipped in the package (names,
backgrounds and portrait names, generated by `scripts/build_catalog_data.py`), and the game scan (which skeletons
exist, dates). Skeletons missing from the map become their own family, named by file id. Names follow the variant name
format: base name plus the variant in brackets, never `·` or `・`.

Recruitable follows the server of the selected game folder. An install ships story portraits of students its server
has not released yet (Global had Tsumugi's before her banner), but each server builds its collection bundles with
the students it has released, so a playable variant is recruitable when its collection portrait is installed. Without
one, the data file's `released` flags (`{"japan": bool, "global": bool}`, from SchaleDB `IsReleased`) decide: true
covers a portrait-name gap, false a student not on this server yet. With no flag either, the variant is recruitable
only when the install has no collection portraits at all. Nothing new is read or cached: the portrait index is the
memory-only one the catalog already uses. A portrait that arrives in a patch before the banner opens shows the student
as recruitable a few days early. Not-recruitable playables stay in the roster and sort after the recruitable variants
of their family.

## library

```python
class ModLibrary:
    def __init__(self, root: Path, catalog: Catalog, game: GameAssets, settings: Settings): ...
    def mods(self) -> list[ModEntry]               # id, file, label, target (variant key), kind ("spr" | "lobby"),
                                                   # added, fresh, size, date, crc
    def add(self, paths: list[Path]) -> list[ModEntry]   # copies into the library; target from the file name's core
    def remove(self, mod_id: str) -> None
    def rename(self, mod_id: str, label: str) -> None
    def mark_seen(self, mod_id: str) -> None
    def favorites(self) -> set[str]; def set_favorite(self, variant_key: str, on: bool) -> None
    def state(self, variant_key: str) -> VariantState    # game files, applied ("official" | "mod:<id>" |
                                                         # "variant:<key>" | "unknown"), crc ("ok" | "fixed" |
                                                         # "needs_fix"), backup available
    def apply(self, variant_key: str, source: str, log, progress) -> ApplyResult    # source as in state.applied
    def restore(self, variant_key: str, log) -> ApplyResult
    def update(self, mod_id: str, log, progress) -> UpdateResult   # rebuild against the current game file
    def extract(self, target: str, out_dir: Path, log) -> Path     # target "variant:<key>" or "mod:<id>"
    def compare(self, mod_id: str) -> CompareResult                # per-asset differences vs the game file
```

Applying writes into the game folder. The first time a game file is replaced, its official copy is kept in the
library (`originals/`), so restoring works even after several mods were applied (the classic GUI's single `.backup`
is overwritten by the second install).

## Jobs and events

`JobRunner.submit(kind, fn, **params) -> job_id` runs `fn(log=..., progress=..., **params)` on one worker thread.
Events on `/api/events`:

| Event | Data |
|---|---|
| `job.started` | `{id, kind}` |
| `job.log` | `{id, lines: [str]}` (batched) |
| `job.progress` | `{id, current, total, label}` (throttled) |
| `job.done` | `{id, result}` |
| `job.failed` | `{id, code, params}` |
| `drop` | `{paths: [str]}` |
| `library.changed`, `config.changed` | `{}` |

## RPC

`POST /api/rpc` with `{"method": "...", "params": {...}}`, answered with `{"result": ...}` or
`{"error": {"code", "params"}}`.

| Method | Result |
|---|---|
| `app.info` | version, language, platform, game found, resource version, consent (`null`, `true`, `false`), paths, `debug` (started with `--debug`) |
| `app.consent {granted}` | records the choice; `false` closes the app |
| `app.openClassic {tab}` | starts the classic GUI on a tab |
| `i18n.strings {lang}` | `{key: text}` for `webui.*` |
| `roster.list` | families with variants, mod counts, fresh flags, favourites, recent order, `added` (when the newest own mod was added) |
| `settings.get` / `settings.set {key, value}` | the settings popup's values; key `roster` keeps the student list's view (merge, segment filters, sort, order, filter groups; `webui/state.py roster_view`) |
| `family.get {key}` | a family with its variants, mods and each variant's state; `modelFiles` per variant (the 3D model's prefab bundles, newest first) and `version` (the game's resource version, so a switched install reloads the screen) |
| `lobby.warm` | builds the memorial lobby prefab index in the background (once per game); the detail screen calls it for a variant with a lobby |
| `lobby.lines {variant, talks, lang}` | `{clip: {lang: text, voice}}`: zh-CN from Kivo, ja from Kivo else the Global server, en, zh-TW, ko and th from the Global server (read only for a `lang` other than zh-CN, left out when its table is not in within 3 s); `talks` (`{animation: [clip ids]}` from the skeleton) places the Global rows on the clips; `lines_unavailable` when neither source can be read |
| `debug.trace {events}` | the fullscreen lobby's input events, logged (logger `ba_modding_toolkit.webui.trace`, and `input-trace.log` in the data directory) only when the app was started with `--debug`; ignored otherwise |
| `favorites.set {variant, on}` | |
| `mods.add {paths}` / `mods.pick` | added entries (`mods.pick` opens the native file dialog) |
| `mods.remove {id}`, `mods.rename {id, label}`, `mods.seen {id}` | |
| `actions.apply {variant, source}` / `actions.restore {variant}` | job id |
| `actions.update {mod}` / `actions.extract {target}` | job id |
| `actions.compare {mod}` | per-asset differences |
| `os.reveal {path}` | |
| `app.checkUpdate` | the newest release above this version, or `null` |
| `app.update` / `app.installUpdate {file}` | job id (download and MD5 check) / swap in the build and quit |

## Asset routes

| Route | Class |
|---|---|
| `/asset/ui/atlases.json`, `/asset/ui/sprite/<atlas>/<name>.png` | light |
| `/asset/ui/textures.json`, `/asset/ui/texture/<name>.png` (also the PC pointer and the touch effect's textures, an index of their own outside the listing) | light |
| `/asset/ui/layout/<root>.json?path=<subpath>` | light |
| `/asset/art/bg/<name>`, `/asset/art/portrait/<name>.png` | heavy |
| `/asset/spine/spr/<core>/<file>`, `/asset/spine/lobby/<core>/<file>`, `/asset/spine/mod/<id>/<file>` | heavy |
| `/asset/spine/lobby/<core>/lobby.json` (prefab layout, touch boxes, clips; no skeleton is extracted) | heavy |
| `/asset/model/<variant>.glb` (the variant's chibi, `model/gltf-binary`) | heavy |
| `/asset/voice/<variant>/<clip>` (a lobby voice relayed from Kivo) | heavy |

Thumbnails (faces, busts, expression cards, variant cards) are rendered in the page from the skeletons, in one
shared offscreen WebGL context, and kept as in-memory blob URLs. They are framed on the face (the expression and eye
slots, halos left out; without a part named like one, the face-sized parts the expression animations switch, as
many NPC portraits name their face slot `0`, `00` or `defalt`), sized by its width held between 170 and 400
skeleton units, never by the skeleton's bounds; the bounds stand in only where no face is found.

## Front end

A port of `prototype/main-screen-v4`: `ngui.js` (prefab renderer), the roster, the detail screen, the popups, the
consent popup and the lobby player, as ES modules under `web/js/`, one page with a hash router (`#/roster`,
`#/student/<family>/<variant>`). Its data comes from the RPC methods above instead of the generated `data.js`, its
art from `/asset/...`, and its strings from the locale files. Prototype-only URL parameters and render hacks are not
ported.

### Student list

`roster-order.js` decides which cards the list shows and in what order (pure functions, tested in Node from
`tests/test_roster_order.py`); `roster.js` draws them and `display.js` is the game's display settings popup
(UIPopup_FilterSort) behind the sort button.

- One card per variant, or per family with "Group Variants" (its attributes are any of its variants'; the card shows
  the first variant, or the first one the search found). Cards with mods first, the rest after the "No Mod" bar;
  favourites lead each group whatever the sort.
- Segment filters (mods, recruitment), the display settings' filter groups (favourite, portrait original or replaced,
  memorial lobby, 3D model, student or NPC; options in a group add up, groups narrow) and the sort (recently viewed,
  recently added, name with the UI language's collation, mod count, default); the order button flips the sort. The
  funnel on the sort button turns blue while a filter group narrows the list. All of it is saved (`settings.set
  roster`); the search lasts the session.
- The search (the game's CharacterSearch box over the top of the list) matches every name language, the family's base
  names and the file id, ignoring case, width, kana and separators (with the marks inside names, as in
  Shiroko*Terror); every word must match. Its input opens focused at once, before the box is drawn round it, and
  stays in the page across rebuilds, so nothing typed meanwhile is lost.
- Keyboard focus moves the list through its own scroll position (the clip never scrolls by itself, so the virtual
  rows and the scrollbar stay in step); the cards are in the page in the list's order, and the focused one shows a
  ring in the game's selection blue.
- A visit to a variant (`ui.visit`) is mirrored in the page's roster data, so "Recently Viewed" has it on the way
  back without a new `roster.list`.
- The detail screen's arrows step through the cards as the list showed them when it was left, in its order, wrapping
  round; a variant the list hides (another chip, a deep link) steps from its place in the whole list.

### Portrait

The detail screen frames the portrait like the game (`portrait-view.js`): the skeleton's origin sits on
UICharacterDetail's `CharacterPos` (`Inventory_ListControl/CharacterPos`, scale 101; a skeleton unit is 1/100 of a
Unity unit in every SkeletonDataAsset), never on the skeleton's bounds, so a long weapon, wings or a prop beside the
character neither shrink nor shift her. The player covers the stage under every panel and keeps one scale across and
down (its viewport has the canvas's own aspect).

### Popups

The detail screen's popups (switch portrait, the variant picker, compare, details) are drawn on the game's popup
frame (UIPopup_Sort) and cover the whole stage with its dark backdrop, top bar and navigation included, like the
display settings and the settings; a click on the backdrop or Escape closes them (PopupClose).

- **Details** (the Portrait, Memorial Lobby and 3D Model info bars' button): the shown tab's game files. The folder,
  what they carry and, for a mod, its file and the variant it was made for; then one row per bundle with its size,
  date, CRC state and what it carries. The frame fits its content and scrolls past the stage's height.

### Loading screen

`loading.js` draws the game's own loading screen: UILoading's black backdrop with nothing in the middle (the game
shows an illustration there; the tool does not) and UIRepeater in the bottom-right corner ("Now Loading", the
hopping dots and Arona turning round, animated in `app.css` from the keyframes of the clip `UIAni_Repeat 1`; its
UIAudioPlay is never played). Before the atlases are in, or without a game, a plain stand-in in the page font shows
instead.

- `scene(fn)` covers the start, a detail screen opened from another screen or a deep link, and the roster's first
  build: a fade to black (150 ms), then, while the work goes on, the indicator; work done within the fade only fades back. `wait(promise)` shows the indicator alone over the
  screen after 300 ms (at least 500 ms), for changes inside it. Both give up after 15 s, reveal what there is and say
  so. One overlay at a time: a newer call takes over the one on screen.
- The detail screen resolves `show()` only when it is ready: the panels, the left side's first frame (the portrait,
  or the lobby with its still, or the 3D model with its shaders compiled) and, within 1.2 s, the visible thumbnails;
  the lobby's lines from Kivo get 1.5 s. A change inside the screen (a variant chip, the arrows, a tab, an
  applied portrait) renders every part off screen and swaps them in one frame. The left side loads laid out but
  transparent; when a lobby or a model replaces another one, a still of the old one holds its place meanwhile.
- The consent popup comes after the first screen is revealed.

### Pointer and touch effect

`cursor.js` gives the page the PC client's own pointer and the touch effect it shows on every press; `touch-fx.js`
simulates the effect (pure functions, tested in Node from `tests/test_touch_fx.py`). Both read their textures through
the light texture route (`gameassets` indexes the GLPC_Cursor, shared UI and EffectsFreezed texture bundles for them,
in `pointer-textures`); without a game the system cursor stays and there is no effect.

- **Pointer.** `ControllerMouse.SetPCCursorStyle` sets `PCIcon_MousePoint` (64 x 64; its MousePoint option chooses
  this or the system arrow) with `Cursor.SetCursor`, hotspot (0, 0) and `CursorMode.Auto`, which Windows shows at the
  system cursor size: here a 32 CSS px cursor with the texture as its 2x image (`image-set`, `-webkit-image-set` or a
  plain `url` by `CSS.supports`), set as `--cursor` and `--cursor-press` on the root. The game has no hover or pressed pointer, so buttons show it too; drag handles keep `grab` and
  `grabbing`, text fields the text cursor. `Cursor_1` (the halo crosshair, hotspot in its middle, a software cursor)
  is the controller's pointer and is not used.
- **Touch effect.** `Resources/UI/FX_Touch`, spawned by TouchEffectCreater at the pointer through the UI camera
  (orthographic size 1: the stage is 2 units high), dragged while the button is held and stopped 60 frames after the
  release. Its parts and numbers come from the prefab's ParticleSystem and TrailRenderer typetrees and its materials'
  compiled shaders: two spinning rings cut by a dissolve threshold over `FX_TEX_Grad_Ring3`, a flash disc
  (`FX_TEX_Circle_01`, its colour added, its alpha hiding what is behind), twinkling triangles
  (`FX_TEX_Triangle_02_1`) leaving the press and 5 per unit of drag, and a 0.3 s trail 0.005 units wide
  (`FX_TEX_Trail_03`). Colours are worked out in linear light as in the game and saturate where it does.
- **Drawing.** Two canvases over the whole window (`pointer-events: none`, device pixel ratio aware, hidden with no
  frame loop and no bitmap while nothing animates): the light on one screened over the page, what the flash hides on a
  multiplied one under it. The page blends in sRGB values, so the flash's blend is fitted to be exact over black and
  over white.
- **Reduced motion** (`prefers-reduced-motion: reduce`): a press keeps its burst, a drag leaves no trail and no
  triangles.

### Memorial lobby

`lobby.js` frames and plays the lobby, `lobby-touch.js` adds the game's touch interaction in fullscreen.

- **Linear light** (`linear.js`). The game renders in Unity's linear colour space (PlayerSettings
  `m_ActiveColorSpace` 1) with sRGB atlas textures, so its blending happens in linear light: an additive glow over a
  bright scene adds little, a soft veil over a dark one adds more. Each lobby player samples its atlas pages as sRGB,
  blends into an sRGB framebuffer and copies the result to its canvas, encoded again; slot colours are converted the
  way spine-unity's shader converts its vertex colours (an additive slot at alpha 0.42 adds 0.15 of its texture).
  Without WebGL2 the player draws in plain sRGB values as before. Drawn in sRGB values, glows such as Kurumi's photo
  booth light or Niko's window washed the scene out to white.
- **Zoom.** Fullscreen opens on the game's 16:9 view and zooms in to 2x. The Settings L2D tab (`lobbyZoomOut`, off by
  default) lets it zoom out further, to the widest 16:9 view inside the painted art (one 16-unit cell inside the
  painted rect).
- **Input.** Press and drag: head pat, eye follow and the other drag boxes. Mouse wheel (a notch zooms at least a
  line's worth) and pinch (ctrl + wheel in Chromium / WebView2, gesture events in WebKit) zoom at the pointer; a
  two-finger trackpad swipe pans in any direction. A wheel is told by its steps: whole lines, `wheelDeltaY` in steps
  of 120 (Chromium), or in WebKit, whose `wheelDeltaY` is 3 x `deltaY` for every device, tenths of a line kept in
  16.16 fixed point (4.000244 px) against a trackpad's whole pixels. One scroll keeps the kind of its first event; one
  taken for a wheel that then sends a trackpad step goes back to the view it started from and pans. A Magic Mouse
  scrolls like a trackpad (ctrl + scroll zooms). A right- or middle-button drag pans. Native drags and the Force
  Touch look-up are turned off on the lobby.
- **Input trace.** Started with `--debug`, the page sends the fullscreen lobby's pointer, wheel and gesture events
  (moves and scrolls at most every 50 ms) and every press anywhere in the document, with its target, through
  `debug.trace`, so a trackpad problem can be reproduced once and the log sent.

## Tests

- `config`, `catalog` and `library` with fixtures and temporary folders.
- `gameassets` and end-to-end checks against a real install; skipped unless one is found (`BAMT_TEST_GAME_DIR`, or
  `game_paths.find_game_dirs`).
- `webui` through its WSGI app, without a window.

## Lobby lines

Online data, fetched on demand and kept in memory only (never written to disk):

- Kivo (`kivo.py`): one student page per variant (zh-CN, ja and the voices, by voice clip name).
- The Global server's CharacterDialog table (`globallines.py`), as ba-data publishes it
  (github.com/electricgoat/ba-data, `global` branch, a jsDelivr mirror second): one download per session (about
  2.4 MB compressed; 60 s and 64 MB received or unpacked at most), only when the UI language is not zh-CN; after a
  failure it is asked for again after 5 minutes. `lobby.lines` waits up to 3 s for it, then answers with Kivo's lines
  alone (the download goes on for the next lobby).
  SchaleDB's voice data has no memorial lobby lines. A dialogue's rows (`UILobbySpecial`, by `GroupId`, played by the
  talk animation the first row names) go on that animation's voice clips in order; with fewer rows than clips the last
  clips get none (the row before stays on screen), with more rows the rest join the last clip's line.

The page shows only the UI language's lines: a dialogue card without one shows a grey, slanted "Dialogue N", and the
subtitle shows nothing for it.
