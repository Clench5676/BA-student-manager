# Web UI

The new GUI: a pywebview window showing a local web front end that reproduces the in-game Blue Archive UI, built
from the approved prototype (`prototype/main-screen-v4`, git-ignored). Game art is read from the user's own install
at runtime and never shipped with the program.

## First milestone

- Screens: consent popup, student roster, student detail (Portrait and Memorial Lobby tabs; the 3D tab is shown
  disabled), the switch-portrait popup and the variant picker.
- Nav entries without a new screen yet open the classic Tk GUI on that tab (`bamt --tab <name>`).
- `bamt` (and the compiled app) starts the web UI; `bamt --classic` starts the classic Tk GUI.
- Released builds look for a newer GitHub release at start and can update themselves (`updater.py`).
- Out of scope for now: voices and subtitles (no game source yet), 3D models, a settings screen, the other tool
  screens, zh-TW and ja UI strings.

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
  - *Heavy*: collection backgrounds and portraits, Spine skeletons, lobbies, anything from a character bundle. Memory
    only, never written to disk, served with `Cache-Control: no-store`.
- **Disk cache.** `user_cache_dir()/<resource_version>/...`, where `user_cache_dir()` is
  `%LOCALAPPDATA%\BA-Modding-Toolkit\cache` on Windows, `~/Library/Application Support/BA-Modding-Toolkit/cache` on
  macOS and `$XDG_CACHE_HOME/BA-Modding-Toolkit` (or `~/.cache/...`) elsewhere. It can be cleared from the UI.
- **Resource version.** SHA-1 of `Catalog/Windows/catalog_Windows.hash` when present, else of the sorted
  `(name, size)` listing of the resource folders. The cache key; a game update starts a new cache folder.
- **User data.** The mod library and UI state live in `utils.EXE_DIR` (the portable data directory the app already
  uses for `config.toml` and `output/`).

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
    def texture_png(self, name: str) -> bytes
    def layout(self, root: str, subpath: str = "") -> dict     # prefab subtree, schema below

    # heavy
    def collection_bg(self, name: str) -> tuple[bytes, str]    # (data, mime)
    def collection_portrait(self, name: str) -> bytes          # PNG
    def collection_names(self) -> dict[str, list[str]]         # {"bg": [...], "portrait": [...]}
    def spine_cores(self, kind: str) -> dict[str, list[Path]]  # kind "spr" | "lobby": core -> bundle parts
    def spine_files(self, kind: str, core: str) -> dict[str, bytes]        # file name -> bytes (.skel, .atlas, pages)
    def spine_files_from(self, bundles: list[Path]) -> dict[str, bytes]    # the same, for a mod's bundle files
```

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
    playable: bool            # recruitable: has a collection portrait in the game
    order: int                # release order inside the family
    spr: str | None           # Spine portrait core, e.g. "ch0241_spr", when the install has it
    lobby: str | None         # memorial lobby core, e.g. "ch0241_home", when the install has it
    bg: str | None            # collection background texture name
    portrait: str | None      # collection portrait texture name (None: the front end renders a bust)
    date: str | None          # date of the portrait bundle

@dataclass
class Family:
    key: str                  # the base variant's key, e.g. "hoshino"
    names: dict[str, str]     # base name per language
    school: str | None
    variants: list[Variant]

class Catalog:
    def __init__(self, game: GameAssets | None, character_map: Path | None, data: Path = <package data>): ...
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
| `app.info` | version, language, platform, game found, resource version, consent (`null`, `true`, `false`), paths |
| `app.consent {granted}` | records the choice; `false` closes the app |
| `app.openClassic {tab}` | starts the classic GUI on a tab |
| `i18n.strings {lang}` | `{key: text}` for `webui.*` |
| `roster.list` | families with variants, mod counts, fresh flags, favourites, recent order |
| `family.get {key}` | a family with its variants, mods and each variant's state |
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
| `/asset/ui/textures.json`, `/asset/ui/texture/<name>.png` | light |
| `/asset/ui/layout/<root>.json?path=<subpath>` | light |
| `/asset/art/bg/<name>`, `/asset/art/portrait/<name>.png` | heavy |
| `/asset/spine/spr/<core>/<file>`, `/asset/spine/lobby/<core>/<file>`, `/asset/spine/mod/<id>/<file>` | heavy |

Thumbnails (faces, busts, expression cards, variant cards) are rendered in the page from the skeletons, in one
shared offscreen WebGL context, and kept as in-memory blob URLs.

## Front end

A port of `prototype/main-screen-v4`: `ngui.js` (prefab renderer), the roster, the detail screen, the popups, the
consent popup and the lobby player, as ES modules under `web/js/`, one page with a hash router (`#/roster`,
`#/student/<family>/<variant>`). Its data comes from the RPC methods above instead of the generated `data.js`, its
art from `/asset/...`, and its strings from the locale files. Prototype-only URL parameters and render hacks are not
ported.

## Tests

- `config`, `catalog` and `library` with fixtures and temporary folders.
- `gameassets` and end-to-end checks against a real install; skipped unless one is found (`BAMT_TEST_GAME_DIR`, or
  `game_paths.find_game_dirs`).
- `webui` through its WSGI app, without a window.
