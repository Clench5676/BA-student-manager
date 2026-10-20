# Web UI

The new GUI: a pywebview window showing a local web front end that reproduces the in-game Blue Archive UI, built
from the approved prototype (`prototype/main-screen-v4`, git-ignored). Game art is read from the user's own install
at runtime and never shipped with the program.

## First milestone

- Screens: consent popup, student roster, student detail (Portrait, Memorial Lobby and 3D tabs), the
  switch popups (portrait, memorial lobby) and the variant picker. The lobby is framed and touched like the game (its prefab data,
  `lobby.json`), plays its intro timeline when it is entered (a tap skips it; the settings' L2D tab turns it off) and
  plays its dialogue with Kivo's voices and the lines in the UI language (Kivo's Chinese and
  Japanese, the Global server's official English and the others); the 3D tab shows the variant's chibi, exported
  from the install, and is disabled only for variants without one.
- Nav entries without a new screen yet open the classic Tk GUI on that tab (`bamt --tab <name>`).
- `bamt` (and the compiled app) starts the web UI; `bamt --classic` starts the classic Tk GUI.
- Released builds look for a newer GitHub release at start and can update themselves (`updater.py`).
- Out of scope for now: the other tool screens.

## Languages

- The UI languages are the localization roadmap's M1 (`i18n.UI_LANGUAGES`: zh-CN, zh-TW, en-US, ja-JP, ko-KR), all
  shipped since 0.1.0-alpha.3: `locales/<code>.json` has every en-US key of the web UI and the classic GUI
  (`tests/test_locales.py`). A language is offered (the settings popup, `settings.set language`) once its locale
  file exists (`i18n.offered_languages`), each named in itself and drawn in its own fonts. The classic GUI lists
  every locale file.
- Wording: game concepts take the official server's words (the Global client's Traditional Chinese and Korean, the JP
  server's Japanese, the Global English); Simplified Chinese follows Kivo's community wording. Words the game never
  uses follow each language's community and the UI text separators (Korean: half-width brackets and ", ").
- The Enable Mods switch, the scan consent, the mod prompts, the classic hand-off, the quit prompt, the tray menu and
  Settings' Mods tab take their strings from `webui.mods.*`, `switch.*`, `classic.*`, `quit.*`, `tray.*`,
  `settings.mods.*` and `error.*`, in every language. Install labels (`mods.installNamed`) keep the folder name as it
  is; `mods.helpFolders` joins them with the language's list separator (`、` in zh-CN, zh-TW and ja, `, ` in en and
  ko). Japanese and Korean name the mod library as `settings.library` does (MODライブラリ, 모드 라이브러리). Japanese
  errors that ask for an action keep the polite form (`error.game_running`, `error.classic_open`); other Japanese
  strings are fragments. Repair advice is text only: `error.original_unavailable` says that no official copy is
  left, and `mods.repairSteam` gives Steam's menu path in each Steam client's words (the settled repair); then
  `mods.repairGame` names the game's own Restore Resources in the game's words as another option, never promised
  ("may not replace mods": whether it replaces a CRC-fixed mod is not verified on either server), followed by
  `mods.repairThen`.
- The first start takes the system language (`i18n.match_language`): Traditional Chinese (zh-Hant, zh-TW, zh-HK,
  zh-MO) zh-TW, other Chinese zh-CN, Japanese ja-JP, Korean ko-KR, the rest en-US. Without the language's file (a
  build that leaves it out), Traditional Chinese gets the whole zh-CN screen, the others en-US. `BAMT_LANG`
  overrides it.
- A string a locale file lacks falls back key by key (`i18n.fallback_language`): Simplified Chinese to zh-CN, every
  other language, Traditional Chinese included, to en-US. A Simplified (and Kivo-worded) string in a Traditional
  screen reads as a wrong translation, an English one as an untranslated one, which also shows the translator what
  is missing; CLDR, too, gives zh-Hant the root locale as its parent, not zh.
- Names come with the data per language (`i18n.js` `NAME_LANG`: zh-CN, zh-TW, en, ja, ko); the catalog names every
  variant in all five (the game's own names where it has them, SchaleDB's, curated ones, or translated in the game's
  vocabulary); a missing name would fall back to en, Simplified Chinese ones to zh-CN first. The lobby's lines follow
  the UI language (`LINE_LANGS`: Kivo's zh-CN and ja, the Global client's zh-TW, en and ko).
- Text fitting (`ngui.fitText`) shrinks, then wraps at separators and between words (`Intl.Segmenter` in the text's
  language), keeping the CJK line-breaking rules: no closing bracket, comma, full stop, ellipsis, small kana or
  prolonged sound mark starts a line, no opening bracket ends one. `ngui.fitLabel` also widens the label to the
  width it was fitted to.
- Fonts: the page draws with Resource Han Rounded CN (`web/fonts`, OFL, shipped). It covers every Han and kana
  character of the zh-TW and ja names and of the games' UI strings, but in Simplified Chinese glyph forms and
  punctuation positions, and it has no Hangul. So the html `lang` (set from the UI language) picks a stack in
  `app.css`: zh-CN and en-US keep the font for everything; zh-TW, ja and ko keep it for Latin letters and digits
  only (`RHR Latin`, the same file with a `unicode-range`) and draw CJK with the system font of the language
  (PingFang TC / Microsoft JhengHei, Hiragino Sans / Yu Gothic UI, Apple SD Gothic Neo / Malgun Gothic, Noto Sans CJK
  on Linux), with the full font last for a glyph none of them has. No font is added. Text in another language than
  the page's carries its own `lang` (a label widget's `lang`, as each language's name in the settings) and draws with
  that language's stack, so a name never mixes two fonts. `ngui.textWidth` measures with the same stack as the text
  draws with, and Hangul counts as CJK for the label sizing. The classic GUI switches the font of its own text
  widgets (drop zones, inputs, status bar, tooltips) to the language's system font the same way
  (`Theme.use_language`); its ttk widgets keep the system's default font.
- The Global client's own fonts (in the install: Noto Sans TC Medium for zh-TW, GyeonggiTitle Medium as the Korean
  main font, Noto Sans and RSU for en and th) are not used yet.

## Process layout

```
pywebview window (main thread) ── HTTP ──> WebServer (threaded WSGI, 127.0.0.1, random port)
                                              /              static front end (ba_modding_toolkit/web)
                                              /api/rpc       calls, JSON in and out
                                              /api/events    Server-Sent Events
                                              /asset/...     game assets read from the install
                                              /api/classic/* the classic window's channel (its own token)
                                              /api/instance/raise  a second start (the raise token)
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
  catalog/       students (families) and their variants, names in zh-CN, zh-TW, en, ja and ko
  library/       the user's portrait and lobby mods: add, remove, apply, restore, update, extract, compare
  webui/         server, RPC, events, jobs, pywebview window, tray icon, entry point
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
  `%LOCALAPPDATA%\bluearchive-modding-patching-tool\cache` on Windows,
  `~/Library/Application Support/bluearchive-modding-patching-tool/cache` on macOS and
  `$XDG_CACHE_HOME/bluearchive-modding-patching-tool` (or `~/.cache/...`) elsewhere. It can be cleared from the UI.
  The old `BA-Modding-Toolkit` user folder is renamed automatically on first start; obsolete caches are rebuilt.
  Close older app windows first, then use the new version: an old build started afterward can recreate its old folder.
- **Resource version.** SHA-1 of `Catalog/Windows/catalog_Windows.hash` when present, else of the sorted
  `(name, size)` listing of the resource folders. The cache key; a game update starts a new cache folder.
  The UI atlas index additionally keys on the current atlas bundle inventory (resolved paths, sizes, modification
  and change times). It is rediscovered on each atlas or sprite request, so adding bundles to a partial install or
  sandbox invalidates the index and cropped sprites even with the same catalog hash. Empty indexes, unresolved
  atlas replacements or textures, failed reads and changes during a scan are logged and never cached. Old atlas
  entries use a different key. The atlas JSON uses `no-store` in both the request and response; consent still
  permits the validated index and sprite PNGs in the app's disk cache.
  NGUI rejects empty or malformed atlas metadata and retries on a later render; a requested sprite missing from
  an otherwise valid index also invalidates it. Failures keep the existing placeholder geometry and log the cause.
- **User data.** The mod library and UI state live in `utils.EXE_DIR` (the portable data directory the app already
  uses for `config.toml` and `output/`). Several instances may share it: a change to the UI state (`webui.json`) is
  applied to the file as it is at that moment, read again under a lock the instances share (`webui.json.lock`), so
  no instance erases another's keys, and reads follow the other instances' writes. Those reads take the same lock, as
  Windows cannot replace a file another process has open; a replace that meets another program's handle (a virus
  scanner, the search indexer) is tried again for up to a second there. The user's own aliases of the
  students are there too (`aliases`: `{family key: [alias]}`, one student's entry changed at a time), never in the
  program folder or the repository.

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
    def lobby_info(self, core: str) -> dict                    # a lobby's layers, touch boxes, clips, idle pools,
                                                               # sound events, post-processing (lobby.py), particle
                                                               # and mesh effects (particles.py, meshfx.py), page
                                                               # materials (spine_materials.py), pins (pins.py) and
                                                               # intro (intro.py)
    def lobby_fx_texture(self, core: str, tex_id: str) -> bytes # a texture lobby_info's "fx" lists, as PNG
    def lobby_sound(self, core: str, clip_id: str) -> bytes   # a clip lobby_info's "sounds" lists, decoded to WAV
    def model_cores(self) -> set[str]                          # dev names with a chibi (character-<dev>-_mxload-*)
    def model_glb(self, core: str) -> bytes                    # the chibi as one GLB (model.py)
```

The collection art is read where the game loads it: CostumeExcel's `CollectionBGTexturePath` and
`CollectionTexturePath` point into `UIs/01_Common/14_CharacterCollect` (Addressables keys
`uis/01_common/14_charactercollect/<name>`), the `uis-01_common-14_charactercollect-*` bundles. The index takes every
`BG_*` texture there (most are `BG_<place>_Collection`, a few are named after the scenario background they reuse:
`BG_NewYearFestival2` for the New Year variants, `BG_WaterFall`) and the `Student_Portrait_*_Collection` portraits;
it holds names and bundle locations only, in memory. `/asset/art/bg/` serves only names starting with `BG_`,
`/asset/art/portrait/` only `Student_Portrait_`.

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
colour space; the light is the formation screen's, below), and for props
DSFX/FX_SHADER_Matcap (a riot shield, soup), MX/E-Water (the surface colour: the game deepens it by the camera depth
behind it, which a lone chibi lacks) and the unlit and effect shaders, each with its own texture slot and colour. An empty
texture slot samples the shader's default texture, as in the game: MX/C-Halo/UnlitTextured without a texture (ch0109's,
EN0009's halos) draws white x its HDR `_Tint` plus the glow; only MX/C-Halo/Simple draws a flat colour. Terms the
game's vertex programs compute stay per vertex: the outline's colour (the texture sampled at the vertex), MX/C-Weapon's
N.V and N.H. The outline is 0.1 % of the stage width times the vertex colour alpha, as in the game. There is no ground
shadow: the formation screen draws none.

The camera opens at the formation screen's view of one character (`FORMATION_VIEW` in `model.js`). GameMain's camera
(vertical field of view 10, at the origin, level; `CameraFovScaler` only widens it on screens narrower than 4:3) draws
the NGUI root 11.43 ahead, 2 units high, so 2 / 1665 of a unit per NGUI unit at 16:9 (UIRoot: constrained, 2960 x 1440,
fit width and height). UIFormation parents each character to its slot (`TeamPosition.SetCharacter`: local position,
rotation and scale reset), UnitPositions/Position1-4: 630 NGUI units to the character's unit, 316.4 toward the camera,
222.6 below Position_Set, whose anchors (BottomMenus to EchelonTab + 720) put it 56.25 below the screen's centre at
16:9, turned 180 degrees to face the camera. In the character's units the camera stands 14.6 away and 0.44 above the
feet, looking level, and the screen's centre lies at that height: fullscreen shows exactly that (the chibi at the
game's scale, about 42 % of the screen's height), beside the panel the same view moved left and up so the feet stay
above the nameplate. A chibi whose box would leave the host is framed from further back (`frameDistance`). The camera
orbits freely around the point at the formation camera's height, which rises to the face as it closes in; the zoom
stays between the bust (`bustDistance`: the face on the framing's point, the halo's top at the host's top edge, about
0.3 of the distance) and a step back (1.3). Fullscreen and back keep the zoom's place between the two (`carryZoom`),
and a double click returns to the front view. The switch card's still is rendered from that front view at the
framing's distance (`stillCamera`), whatever the orbit, the zoom and the pan.

Input (`attachInput`) is read as in the fullscreen lobby (`lobby-touch.js` `wheelStep` / `wheelKind`); the orbit
controls only orbit (the left button, one finger):

- *Mouse wheel.* Zooms in steps of the zoom (each multiplies the distance; `zoomShare` is the place between the fit
  and the bust in those steps): five notches from the front view to the bust (`wheelZoom`). A notch counts at least
  100 px (a Chromium / WebView2 notch; Firefox's 3 lines are 120 px; a slow macOS notch, a tenth of a line, is only
  4 px), a faster spin's bigger steps zoom further, and one notch out is about the step back.
- *Pinch.* Zooms half as far again as the fingers spread (`pinchZoom`: the distance times scale^-1.5), so one pinch of
  about 2.2 x goes from the front view to the bust: ctrl + wheel in Chromium and WebView2 (the scale is
  exp(-deltaY / 100); ctrl + a mouse wheel zooms by notches), gesture events in WebKit (the macOS app's WKWebView; the
  ctrl + wheel events some versions send beside them are left to the gesture), two fingers on a touch screen.
- *Pan.* A two-finger trackpad swipe, a Magic Mouse scroll or a horizontal wheel, and a right- or middle-button drag,
  move the chibi as far as the fingers or the pointer moved, while zoomed in: the orbit target stays inside the
  chibi's box scaled by the zoom's place (`clampPan`: nothing at the fit, the whole box at the bust), so zooming out
  draws the pan back in and the front view has none. A double click also unpans.
- *Easing.* The distance and the pan ease to their goals (0.08 s, as the lobby's view); a notch or a pinch adds to
  the goal, which is clamped to the limits. A zoom or an orbit during a glide (a double click, fullscreen and back)
  takes that part over from it while the framing glides on.
- *Lift.* The target rises with the zoom's place so that the face comes to the framing's point evenly, notch by notch
  (`liftShare`: about 28 px per notch for Koharu beside the panel).

The OrbitControls zoom it replaces took 58 Chromium notches from the front view to the bust, about 1430 slow macOS
notches and 26 trackpad swipes of 220 px on a 2x screen (it divides by `devicePixelRatio | 0`, so below a ratio of 1
one event jumped to a limit), ignored `deltaMode` (Firefox: 0.06 % a notch), never saw WebKit's gesture events (no
pinch in the macOS app) and needed some 80 Chromium pinches of 2 x; a zoom during a glide was overwritten until the
glide ended, and the lift, eased by distance, did two thirds of its rise in the first fifth of the zoom, dropping the
chibi before it grew.

The light is the formation screen's, read from the game rather than fitted to renders:

- *Light colour.* The game's modified URP (`ForwardLights.SetupMainLightConstants`) derives `_MxCharLightTone`,
  `_MxCharShadowTone` and `_MxCharLightData` from the main directional light (or a `CharacterLightColor` override):
  hue and brightness apart, data.x = 0.85 max + 0.15 (`characterLight`). UIFormation's light is white, intensity 1:
  tone 1, data (1, 1).
- *Direction.* `_MxCharLightDir` comes from the topmost `CharacterLight`; on the formation screen that is GameMain's
  CharacterLightFallback, from above, 6 degrees toward the screen's right and away from the camera. Light directions
  are world space in the game (`_MxCharLightDir`, MX/C-Weapon's `_FakeLightDir`), and the formation screen turns every
  character 180 degrees to face the camera (its slot's rotation, an axis 0.4 degrees off the vertical): `slotSpace`
  takes them into the character's space, so the light falls from the side it does in the game (weapons are lit from
  the screen's right).
- *Ambient.* Layer4, Single, Hair, Face and Weapon add the ambient probe (`unity_SH*`), evaluated per vertex at the
  world normal, clamped at 0 and scaled to a channel sum of at most 0.3. Outside battle the active scene is EmptyScene
  (`Persistent.GameStart` loads it alone; only battles, minigames and Undercover set another scene active), Trilight
  ambient with the colours SceneLightingLoader also uses as its defaults. `trilightProbe` turns them into the probe as
  Unity 2021.3 does (UnityPlayer: a cube map of 2 x 2 texels a face, +Y sky, -Y ground, the sides equator, projected
  onto L2 SH, then the cosine lobe): about +0.1 in every channel, bluer on surfaces that face up.

Other screens differ: the cafe (Cafe3D) sets its own Trilight colours (a neutral +0.1), and each battle stage has its
own main light, ambient and baked light probes. Against the 30 EnemyInfo renders, the 21 newer ones (the `CH0xxx` and
`*_Original` names) match with the ambient (median game / tool ratio in linear light: lit hair and body 1.00, 1.10
without it; shadowed hair 1.02 and body 1.07, 1.18 and 1.25 without it), and the 8 older ones (`Aru_SR`,
`Hoshino_SG` and the like) match without it: they were rendered in a scene without ambient, about 10 % darker than
the formation screen.

Checked against four screenshots of the formation screen (Global client, 2000 x 1125 game area): 14 students rendered
at the formation camera and their slots line up with the screenshots to the pixel (silhouettes, feet at 757 of 1125),
the Formation_Idle time picked per student by the closest match. Per region, the median game / tool ratio in linear
light over the students: face 1.01, lit skin 1.01, shadowed skin 1.01, lit hair 1.01, shadowed hair 1.00, lit clothes
0.99, shadowed clothes 1.00, lit weapons 0.99, shadowed weapons 1.05 (1.15 with the light in world space), halos 1.05.
Taking the light into the slot's space lowers the mean difference on the same pixels for every student: hair 4.8 to
3.7 sRGB levels (median), bodies 6.7 to 5.6, weapons 10.0 to 7.9; the faces, lit by their own direction, are unchanged.
What remains: the screenshots are softer (a Gaussian of about 0.6 px brings the renders closest; compression or the
game's resampling), fine dark lines come out lighter in them (the outline's dip about 0.75 of the tool's at the
silhouette and 0.82 inside, lines painted in the textures 0.87: partly the screenshot's own loss of fine detail),
halo sparkles (the halos' particle effects, not exported) and the formation screen's occasional
Formation_Idle_Random (`CharacterEchelon` plays it instead of the idle at random where the prefab has one, as Mika's
swimsuit does in the screenshots; the tool plays Formation_Idle only).

`AssetNotFound` (a `KeyError`) when a name is unknown. Layout nodes use the schema of
`prototype/research-v4/tools/layout.py`: `{name, active, pos[x, y], scale[x, y], rotZ, widgets[], children?}` with
the widget fields documented there; atlas and texture references are resolved to names.

**Button states.** The game's buttons (`MXButton`) carry no NGUI button colours: no prefab has a `UIButton` or
`UIButtonColor`, so there is no `disabledColor`, `hover` or `pressed` to read. A disabled or locked button is a node of
its own that a controller shows instead of the normal one, and its look is in that node's widgets. The layout gives
these controllers a `states` object, each field's node as a path below the controller's node (what `subtree` and
`?path=` take; `""` is the node itself, `null` an unset field):

| Controller | Fields |
|---|---|
| `OpenConditionButtonController` | `Enable`, `Disable`, `Prohibited` |
| `UIButtonEnableSwitch` | `enableButton`, `disableButton` |
| `MXDualStateButton` | `NormalButton`, `DisabledButton` |
| `ButtonActivator` | `activeObject`, `inactiveObject`, `button`, `contentsLockObject` |

The lobby's bottom menu (`UILobby`, `Front/Bottom/Menu/BG/Grid/<entry>`, a prefab hint) holds the game's disabled look
for the greyed navigation. An entry with an open condition (Cafe, Academy, Craft, Shop, Gacha) shows `Able`, the icon
sprite untinted (`#ffffff`), or `Disable`, the same sprite at `#797979` with `Common_Icon_Lock` over it; Student,
Formation and Social have the same `Disable` node without a controller. The label is the entry's own child, outside
both, and the prefab gives it no disabled colour (`#2d4664` or `#2c4564` in both states). Checked on every prefab of
the 2026-10 resource version: 421 controllers and 1124 references, each inside its controller's node and unambiguous
by name.

Cached layouts carry the export's format in their key (`layout-v2/<root>`, `_LAYOUT` in `service.py`). A change to
the export raises it, so layouts cached before are exported again and no other cached asset is dropped.

## catalog

```python
@dataclass
class Variant:
    key: str                  # file_id lower-cased: "hoshino", "hoshino_swimsuit", "ch0241", "np0045"
    file_id: str              # as in the character map: "CH0241"
    family: str               # Family.key
    names: dict[str, dict]    # {lang: {"full": "星野（一年级）", "short": "一年级"}}, langs zh-CN zh-TW en ja ko
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
    aliases: list[str]        # the CN server's zh-CN names, e.g. "桃（武装）": the search matches them, the UI never
                              # shows them

@dataclass
class Family:
    key: str                  # the base variant's key, e.g. "hoshino"
    names: dict[str, str]     # base name per language
    school: str | None
    variants: list[Variant]
    aliases: list[str]        # the CN server's base names, e.g. "桃" for Momoi, "康娜" for Kanna

class Catalog:
    def __init__(self, game: GameAssets | None, character_map: Path | None, data: Path = <package data>,
                 server: str = "global"): ...           # "global" | "japan", Settings.server_region()
    def families(self) -> list[Family]
    def family(self, key: str) -> Family
    def variant(self, key: str) -> Variant
    def variant_for_core(self, core: str) -> Variant | None    # "ch0241_spr" or "ch0241_home" -> Variant
    def core_map(self, spr_cores, lobby_cores, special_cores=()) -> CoreMap  # any install's cores -> variant keys
    def reload(self) -> None                                    # parse the data again, rebuild the snapshot
```

`core_map` runs the roster's own core rules on another install's core names, so the library keys a core the same way
in every game folder: a portrait core's key is the core less `_spr`; a lobby core belongs to the installed variant
whose key or core alias plus `_home`, `_home_gl` or `_home_teen` names it, a direct file-id match first; a lobby core
whose variant has no portrait in that install takes the variant the data names for it the same way, else the core less
its suffix. `CoreMap` also gives each key's portrait core and primary lobby core there, and the shipped names of the
keys the data has (the cards of a core the current catalog does not map). The shipped data and the character map are
parsed once and kept; every build and every map works on a copy, so one install's unknown portrait keys never enter
another's, and `reload()` parses both again, keeping the old parse and snapshot when the data is invalid.

Special Spine slots use `special:<lower-case core>` keys and the lobby workflow. Discovery accepts named
`spinebackground` bundles and nonstandard cores in `spinelobbies` and `spinecharacters`; shared `_mxcommon` bundles
are excluded. The category is retained on the variant (`spineCategory` in RPC data), including backgrounds whose
cores happen to end in `_home` or `_spr`. They stay separate from student portraits and memorial lobbies. Import,
apply, restore, configuration, the global toggle and entry scans all classify these files by category as well as
core. Parts still match by prefix and resource type, so an older mod keeps its target category.

Repository naming evidence: `naming.py` already lists `assets-_mx-spinebackground-` among common mod prefixes;
the reported `arona_workpage_daytime` filename uses that category and the existing dated, numbered-part syntax.
The shipped catalog and character-map-derived metadata identify `arona` as Arona, `np0035` as Plana, and `np0032`
as Aoi (the Traditional Chinese name in the report refers to Aoi). Background prefixes `arona`, `plana` and `aoi`
join those families even when the install has no portrait for them. Character file IDs and aliases use the same
metadata. Other scenes share the Special family. Known role tokens (workpage, daytime, night, task, cafe) have
locale labels; unknown names retain their exact core. The repository ships student metadata, not a complete
game bundle-name inventory, so background discovery uses the category instead of a fixed scene-name allowlist.

Roster cards, chips, the picker, search results and arrow navigation include these lobby-only variants. Their
thumbnails and layered previews use the existing revisioned Spine routes. Container paths under
`SpineBackground/<core>/` identify the owning scene even when its skeleton layers have unrelated student or
background names; conflicting scene containers are refused. Texture-only or stripped parts can use the declared
installed slot. Missing skeletons, ambiguous atlases or unsupported scene layouts leave a plain card and the
apply/restore controls available. Student dialogue lookup is skipped for special slots. Actual scene framing,
animation and game rendering still require checking an isolated game install.

Sources: the character map CSV the app already downloads (`BA-Characters-Internal-ID.csv`, one row per file id, with
student id, names and skins in several languages), the curated data file shipped in the package (names,
backgrounds and portrait names, generated by `scripts/build_catalog_data.py`), and the game scan (which skeletons
exist, dates). Skeletons missing from the map become their own family, named by file id. Names follow the variant name
format: base name plus the variant in brackets, never `·` or `・`.

Languages: zh-CN follows Kivo (below); zh-TW, en and ko are the Global server's official names, ja the JP server's.
Playable students take SchaleDB's names per server (`students.{cn,tw,en,jp,kr}.json`); NPCs and story sprites the
character map's columns (`name_kr`, `skin_kr` for ko) and `catalog/data/naming.json`: its name table and glossary
give each language's word, from the Global client's ScenarioCharacterName (the scenario name of the sprite's own
`CharacterSpine_<file id>`; the JP server's for ja) where the game names it, else a translation, and say which
(`source`, `basis`). Korean writes names as the game does: half-width brackets without a space before them and the
Terror asterisk half width (호시노(수영복), 시로코*테러), parts joined by ", ", the base variant 기본; a ko skin of the
map that the game words otherwise yields to the glossary (the map's 임전, 정월, 캠프: the game's 무장, 새해, 캠핑).
`naming.json`'s `story_names` hold the story variants whose research names (prototype `names.json`, wiki names)
lack a language or use a community word (ko for the Hoshino and Kisaki story sprites; zh-TW's SchoolYear and Kiki
words).

Aliases: zh-CN shows Kivo's community wording, and the CN server's wording that it replaced stays findable. The
builder writes `aliases` (only when not empty) per student and per variant: a student's are the server's given names
(the map's `name_cn` and SchaleDB's cn `PersonalName` of the variants named by the base alone, so a Terror form stays
apart, and the name table's `cn` wording for NPC names such as 崔尼蒂学生A); a variant's are its zh-CN name with
those names, its own row's `name_cn` and the server's costume words (the map's `skin_kivo` / `skin_cn` pairs, e.g.
临战 / 武装, 兔女郎 / 邦妮, and the glossary's `cn` for words only Kivo's remarks use, e.g. 运动服 / 体操服), and
SchaleDB's cn name of a playable variant. zh-TW keeps the Global server's official names; these are the CN server's.
Rows the map adds after the shipped data get theirs from their own `name_cn` and `skin_cn`.

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
    def __init__(self, root: Path, catalog: Catalog, game: GameAssets | None, settings: Settings, *,
                 scan_allowed: Callable[[], bool] = lambda: False, data_id: str = "local",
                 write_check: Callable[[Pin], None] | None = None): ...   # write_check: the caller's own refusal
                                                   # right before game files are written (the web UI: classic_open)
    def mods(self) -> list[ModEntry]               # id, file, label, target (variant key), kind ("spr" | "lobby"),
                                                   # added, fresh, size, date, crc, core (lower case)
    def add(self, paths: list[Path]) -> list[ModEntry]   # copies into the library; target from the file name's core
                                                         # (portrait "_spr", lobby "_home", "_home_gl", "_home_teen")
    def remove(self, mod_id: str, confirm=False) -> None # refused while a game folder shows it (see below)
    def rename(self, mod_id: str, label: str) -> None
    def mark_seen(self, mod_id: str) -> None
    def favorites(self) -> set[str]; def set_favorite(self, variant_key: str, on: bool) -> None
    def state(self, variant_key: str, pin=None) -> VariantState   # game files, applied ("official" | "mod:<id>" |
                                                         # "variant:<key>" | "removed" | "unknown"), crc ("ok" |
                                                         # "fixed" | "needs_fix"), copy, restorable, official
    def configured(self, variant_key: str, pin=None) -> {"spr": source | None, "lobby": source | None}
    def modified(self, pin=None) -> dict[str, str]       # the roster's Replaced flags (portraits)
    def apply(self, variant_key, source, log, progress, kind="spr", pin=None) -> ApplyResult   # also deferred
    def restore(self, variant_key, log, kind="spr", pin=None) -> ApplyResult
    def would_write(self, variant_key, source, kind="spr", pin=None) -> bool   # for the classic window's rule
    def preview_bundles(self, mod_id: str, pin=None) -> list[Path]
    def official_bundles(self, core: str, pin=None) -> list[Path]  # verified originals, whole core or unavailable
    def prune(self) -> list[Path]                        # kept originals deleted (see below)
    def update(self, mod_id: str, log, progress) -> UpdateResult   # rebuild against the current game file
    def extract(self, target: str, out_dir: Path, log) -> Path     # target "variant:<key>" or "mod:<id>"
    def compare(self, mod_id: str) -> CompareResult                # per-asset differences vs the game file
    # the Enable Mods switch and mods already in use, over every known game folder
    def installs(self) -> list[Pin]; def current_pin(self) -> Pin | None
    def toggle(self, enabled, expect, pins=None, log, progress, cancel) -> ToggleResult   # also Retry
    def restore_drift(self, entries, pins=None, log, progress, cancel) -> ToggleResult    # Apply Mod Configuration
    def scan(self, pins=None, cancel=None, include_dismissed=False) -> ScanResult         # needs the scan consent
    def entries(self, pins=None, include_dismissed=False) -> list[EntryState]
    def adopt(self, entries, pins=None, log, progress, cancel) -> AdoptResult             # Add to Library
    def dismiss(self, kind: "drift" | "untracked", entries) -> None                        # Keep as Is, Don't Ask Again
    def forget(self, install: str) -> None                                                 # Remove from List
    def clear_built(self) -> int                                                           # Clear Mod Cache
    def judge_unfinished(self) -> int; def intent(self) -> dict; def status(self) -> dict
```

**Switching** is what the detail screen's switch cards do (Switch Portrait, Switch Memorial Lobby): `apply` writes
the chosen source into the variant's game files of that kind, so the game itself shows it. The sources: the official
files (`official`, the same as `restore`), a mod (`mod:<id>`; one made for another variant of the family is adapted
to this variant's files), or another variant's official files (`variant:<key>`, adapted). A mod replaces every part
of its kind as a unit: parts it has no file for go back to official. The portrait and the lobby are switched apart.
A mod is installed directly when its core is the target's core; a lobby mod belongs to one lobby core. The variant a
mod belongs to is the one the current catalog gives its core, else the target stored when it was added.

**Game folders.** Every call that reads or writes game files works on a `Pin` (an install key, its resource folders
and its server), taken from the settings at the call, or given by the caller (the web UI's jobs pin what they saw at
submit and are refused with `folder_changed` when the folders changed meanwhile). An install key is the install root
of the setting (a setting naming a resource folder maps to the folder above it). The known installs, the ones the
switch covers, are the Global and Japan folders the settings name, whatever the file source (ADB mode included),
then every install with a configuration record whose folder exists. Without a current install (ADB mode, the folder
missing) the switch still works over the others.

What a switch replaces is always kept:

- **An official file** is copied to `originals/<file name>` the first time it is replaced. The official copy is, in
  this order: the original already kept, the game file itself, its `.backup` beside it (the classic GUI's, judged by
  its name without `.backup`; the library never writes or deletes `.backup` files), or a file of its name in another
  game folder; at write time each is checked by the CRC32 of its whole content against the CRC in its name, so a
  modded file is never kept (`original_unavailable` then, and nothing is written). Restoring copies it back.
- **A mod** stays in the library (`mods/<id>/`). While mods are on, `remove` refuses one a game folder still shows
  (unchanged since the library put it there): `mod_in_use` in the current game folder, else `mod_in_use_elsewhere`
  with that folder; in a folder the switch does not cover, in any state. While mods are off removing is allowed: every
  configuration naming it is dropped, and when a game file still carries it with no official copy anywhere,
  `mod_last_copy` asks first (`confirm`); the records of those files are marked removed, so nothing adopts them again
  and the next Off reverts them.
- **Another variant's files** are only read, and can be adapted again.
- **A file changed outside the library** (another tool, the classic GUI, a manual copy), or the bytes of a source the
  library no longer has, is added to the library as a new mod of its core before it is overwritten; a part set
  already in the library is not stored twice. Each file a write reaches is judged in full here (its SHA-1 against the
  library's record, never its size and date, then its CRC32; the write hashes every target anyway, so this reads
  nothing more), so a mod another tool installed without the CRC fix, or with the file's date put back, is kept too.

Every write goes through `_commit`: resource path checks, the game not running and Steam not updating or verifying
the install, the files lockable, atomic replacement, and a rollback of every written part when one fails (the mods it
had just kept are dropped again once every part is back, and the originals it had just kept from the game files are
released). The records of `state.json` say for each file what was written there: the source, its SHA-1, size and
date, whether the bytes are official (`official`, compared with the official copy), the write time (`at`), the last 8
bytes when there are trailing bytes (`tail`) and the CRC state (`crc`). Older builds keep these keys in records they
do not rewrite.

**Kept originals and the prune.** After every switch, at the end of every bulk job, and once per library in the web
UI (a `library.prune` job), `prune` decides about every kept original from names, file stats and records only, over
every known install; it reads no game file's contents. An original stays:

- while a configured entry may write non-official bytes over its file (so turning mods off and on copies nothing);
- while any known install holds a file of its name that is not unchanged since the library wrote official bytes there.
  An official file the library did not write (verified in Steam or by the game, restored by another tool) keeps it
  until the library next writes or records official bytes there: a restore that finds the file official writes
  nothing, records it and releases the original. A file of its name the library never wrote keeps it too: it may be
  another tool's mod with this original as its only official copy;
- while a file of its name the library wrote to elsewhere may need it, judged by stat; a folder that cannot be seen
  (an unmounted drive) is judged by its record.

These rules cover the installs this data directory removed from its list too: in a library shared with a data
directory that still names such an install, both prune alike, so removing an install from the list never changes what
the prune keeps.

Once its name is gone from every known install, a game update superseded it when each of its records' folders holds
a later-dated file of the same part (prefix and resource type): it is deleted. An original no record places, or one
with only an older file of its part (a downgrade), stays. The records of superseded files are dropped once no
original of their name is kept, leaving the entry's `updated` marker when the library had written non-official bytes
there. When unsure, an original stays: the cost is disk space, counted in the switch's help ("Official copies for
Off").

**Configuration (`profiles.json`).** Older builds rewrite `state.json` with their own keys only, so the configuration
lives beside it in a file of its own: the Enable Mods switch (`enabled`, one intent for every known install; missing
means on), its last change (`toggled`), the entries not switched yet (`unfinished`, each `pending`, `left` or
`stuck`), and per install key its server, the data directories naming it or hiding it (`named_by`, `hidden`), the
configured source per core (`configured`), the `updated` markers, the built copies (`built`) and the dismissed prompts
(`dismissed`, files by name, size and date). The user's switch popup sets and drops configured sources; the switch
never changes them. Every change is applied to the file as it is, under `profiles.json.lock`, unknown keys kept, the
last good file kept as `profiles.json.prev` (read instead of an unreadable file, which is kept as
`profiles.json.bad`); with neither readable the switch is unavailable (`profiles_unreadable`) and nothing is written.
At each build the library finds each named install's record: its own, a moved install's (the one record of that
server whose folder is gone while its parent exists; its files' records follow by size and date, or with scan consent
by size and last bytes), else one migrated from what the library already wrote there, so existing users keep their
mods through the first Off.

**Entries.** One game core of a variant in one install (a portrait, or one memorial lobby core: `_home`, `_home_gl`
and `_home_teen` are entries of their own), keyed by the variant key `Catalog.core_map` gives the core in its own
install. What its files carry comes from their non-official parts only (`tests/data/source_rule_cases.json`, shared
with the detail screen). Its state, first match wins: `damaged` (a header that cannot be read), `missing` (configured,
no files), `untracked` / `changed` (files the library did not write, without / with a configuration), `source_missing`
(a configured source gone from the library: listed once, then dropped), a take-over (a newer library write than the
configuration, written by another instance: configured with it), `updated` / `reset` (mods on, a configured entry a
game update renamed or a Steam check or repair put back, in whole or in part), `ok`, else `pending`.

**The Enable Mods switch** (`toggle`). An Off adopts the mods it finds first (Add to Library: one mod per entry of its
non-official parts, every part recorded, the entry configured with it), keeps the built copies, then switches every
entry carrying a library source to official. An On switches every configured entry that does not carry its source
back to it. The intent and the entries to reach are saved first, so a crash leaves them listed (the red dot and
Retry, without a scan). Each entry is judged again when it is reached, with its configuration read again: a part the
library can show unchanged by size and date (or the last bytes of a CRC-fixed file) carries its record's source, and
every other part is read in full there. An outside change is adopted by an Off and never overwritten by an On. What
the full read finds is kept in the records, so the cheap judgement agrees from then on: a file whose bytes are the
record's under a new date (a backup tool, `touch`) has its date stamped again, and a file the cheap rule takes for
official (no trailing bytes, the official size) whose bytes were changed outside the library is remembered as such
by its size and date (`outside`, dropped by the next write there). Without that, the next scan would list the first
in the untracked prompt again, and the second in the drift prompt at every start for Apply Mod Configuration to skip.
Refusals before anything is written: `folder_changed`, `state_changed` (another place switched first), the game
running, Steam busy, and `not_enough_space` (what an Off copies, with 512 MiB to spare); a running game, Steam busy or
changed folders stop a job midway, the rest stays listed. Overwritten entries (no official copy anywhere) are left as
they are (`stuck`); the app never repairs game files, it names the repair to run.

**Built copies.** Before an Off reverts an entry that carries its configured source, the library keeps the exact
bytes it wrote there, whole: a file of the mod in `mods/<id>/` when one holds them (every adopted part, every direct
install without a CRC fix), else a copy in `library/built/<sha1>.bundle`. On, Retry and Apply Mod Configuration write
them back with one copy per part (no installer, no UnityPy), byte for byte, while they fit: built for that source,
every part's name and every file name the build read (an adapted mod's official parts, another variant's files) still
in the install. A game update, a changed or dropped configuration, a mod's update or removal, a Forget and Mod Cache cleanup
drop them; a built file goes once no install's key references it. Deletions, including Mod Cache cleanup,
run under `profiles.json.lock` against the configuration just saved. Bundle copies run outside that lock: after a
new key is saved and the lock released, any missing files are copied again from the still-modded game files. Later
deletions respect the saved key; recovery copies are checked again under the lock and deleted if no key references
them. Clear deletes `built/*.bundle` and `.library-` temporaries at least an hour old, counts both in the bytes freed,
leaves fresher temporaries alone, and keeps `built/` in place.
Built copies and kept originals hold game portraits and lobbies inside the library: restore copies of what the user's
own switch wrote, never read to draw the UI, and their disk use can grow large. Settings shows the Mod Cache size
and can clear it; kept originals remain available for Off. Sizes are measured on demand.

**What reads game files.** The scan consent (`scan_allowed`, asked at each use) covers every read the app makes on
its own of files the library did not write: the scan (the start and the end of each portrait and memorial lobby file;
headers and the last bytes of recorded files, never a whole file), an Off's own pass, the roster's Replaced mark for
mods outside the library, and a moved install's re-keying by last bytes. Without it `scan` refuses with `scan_off`, an
Off reverts what the library wrote or configured and adopts the changed files it meets on the way (other mods are not
checked), and the roster's Replaced mark shows only what the library wrote. Needing no consent: names and stats, the
library's own writes and folders, the files a switch or the user's own action reaches (read in full), and the
family the detail screen shows, judged cheaply (size, date, header; Needs Fix only from the record of the switch that
wrote the file, so it survives a restart). Nothing hashes a game file outside switching.

**Several instances and data directories.** Two instances sharing a library merge `state.json` on every save (each
one's records added, changed or removed, game file records written or dropped, favourites toggled) and read the
other's writes before judging. An alpha.3 instance still rewrites the whole file: its save replaces what an alpha.4
instance wrote since the alpha.3 one read it, and the records it writes itself lose the newer keys (they then count as
an older build's, which the library handles). It never opens `profiles.json`. A data directory removing an
install from its list (Remove from List, `forget`) drops its record only when no other data directory names it;
otherwise it only hides the install there, and a toggle there lists that install's entries as not switched for the
data directory that names it.

The 3D model has no switch: the library keeps no 3D mods. It would take a `model` kind (`character-<dev>-_mxload-*`
prefab bundles, whose meshes, textures and clips sit in other bundles found by CAB), its detection in `add`, game
files matched by bundle name rather than by core, a preview through `GameAssets.model_glb(overrides=...)`, and no
variant swap (chibis do not share meshes and bones).

## Game watch

### Checks before a write

`library/safety.py` holds the checks every game file write makes first (`writable_game_files`). None of them reads a
game file: the process list and Steam's manifests are not game files, so none needs the scan consent.

- **Game running.** `check_game_not_running()` refuses with `game_running`, or `game_status_unavailable` when the
  process list cannot be read. `game_processes()` lists the game's processes, never this process or its parent:
  - Windows: the exe names of a Toolhelp snapshot (ctypes, no subprocess). `tasklist` is the fallback, run with
    `CREATE_NO_WINDOW` so the windowed build never flashes a console window.
  - macOS and Linux: `ps -A -ww -o pid=,comm=`, matched when the executable's file name is `BlueArchive` or
    `Blue Archive` (`.exe` allowed), so a native build's `/Applications/Blue Archive.app/Contents/MacOS/Blue Archive`
    matches with its spaces. Only without such a match, `ps -A -ww -o pid=,args=` for Wine and CrossOver, where the
    process is the preloader and `BlueArchive.exe` or `Blue Archive.exe` is in its arguments as a path's last part.
    `BlueArchiveTool.exe` and this program's own names never match.
  - The JP server's launcher, which may update or repair files on its own, is not matched yet: its process name is
    still to be found.
- **Steam busy.** `check_steam_idle(game_folder)` refuses with `steam_busy` while the app manifest's `StateFlags` has
  any of the bits 256 (update running), 1024 (update started), 65536 (reconfiguring), 131072 (validating), 262144
  (adding files), 524288 (preallocating), 1048576 (downloading), 2097152 (staging), 4194304 (committing) or 8388608
  (update stopping). `game_paths.steam_app_manifest()` finds the manifest by walking up from the folder, the install
  root or a resource folder below it, to an ancestor `common` whose parent is `steamapps`, along the path as given and
  then resolved, and takes `appmanifest_3557620.acf` there. No manifest (a folder outside a Steam library, the JP
  server, a dev sandbox) means no check. The app running bit (64) is not used.
- **The call.** `writable_game_files(paths, resource_dirs, *, game_folder=None)`: with `game_folder` (the install the
  files belong to), Steam is checked for it after the game.

### The poller

`webui/gamewatch.py` greys the Enable Mods switch while a write would be refused. It polls every 3 s while
`active()` says a page is connected to `/api/events` or the tray icon is shown, else every 15 s, and at once on
`poke()` (the tray menu opening). Each poll checks the game once, Steam for every known install, and the classic
window `classic.json` names. The write-time checks stay the authority; the poll only greys controls.

```python
GameWatch(installs, find_classic, profiles_seen, on_change, publish, request_scan, *, active, own_classic,
          on_classic_closed, check_game, check_steam).start()   # a daemon thread; stop() ends it
watch.state  # WatchState(game, steam_busy, classic) with .reason: game_running, game_status_unavailable,
             # steam_busy (any known install), classic_open, or None, in that order
```

| Callable | Given by | What for |
|---|---|---|
| `installs()` | the services | the known installs' folders, read at each poll |
| `find_classic()` | the classic hand-off (`webui/classic.py`) | the classic window `classic.json` names, or `None`; it owns the file, the identity check and the removal of a stale file |
| `own_classic()` | the services | the pid of the classic window this instance started, which its own watcher thread reports, so the poll ignores it |
| `profiles_seen()` | the services | whether another data directory changed `profiles.json`'s shared intent since the last poll |
| `on_change(state)` | the services | the first poll, every change of the answer and every `profiles_seen()` yes: updates the `mods.state` snapshot and publishes `mods.state` |
| `publish(event, data)` | the event bus | `classic.closed {code: null}` when a watched classic window ends, after `on_change`; then `on_classic_closed()` |
| `request_scan()` | the scanner | the game stopping (from `game_running`), an install's Steam going idle, a watched classic window ending; the scanner runs it only with scan consent |

A failing callable is logged and never stops the thread: an unreadable process list is `game_status_unavailable`,
a failed Steam check is idle, and a failed classic lookup keeps the last answer.

## Jobs and events

`Services.submit(kind, fn, writes=None, library=None, **params) -> job_id` runs `fn(log=..., progress=..., **params)`
on one worker thread (`JobRunner`). A **writer job** (`writes="game"`: it writes the game folders and the library;
`writes="library"`: the library only) holds back the window's close button, `app.quit`, a library move and the
services rebuild after a game folder change; a read-only job (an extract, an update download) holds back nothing.
Every writer job ends on the worker with the library's judging of the `unfinished` list (`judge_unfinished`), a new
`mods.state` snapshot, `library.changed {cores, kinds}` and a scan (with the scan consent).

| Writes | Jobs |
|---|---|
| game | `apply`, `restore`, `mods.toggle`, `mods.restore` (Apply Mod Configuration) |
| library | `library.adopt`, `library.prune`, `library.clearBuilt`, `library.forget`, `library.judge`, `update` |
| none | `extract`, `update.download` |

Every game folder write a job makes is pinned at submit: the RPC captures the library and the pins (`installs()` for
the jobs over every known install, `current_pin()` for one entry) and passes them to the library, so a game folder
changed meanwhile (in Settings, or the classic GUI's `config.toml`) gives `folder_changed` instead of writing another
install. Shutdown drops the queued read-only jobs and waits only while a writer job is queued or running.

Besides the front end's jobs, the web UI submits its own: `library.prune` once per library it builds (see library),
whose last step judges the `unfinished` list, and `library.judge` when another data directory sharing the library
changed it (below).

Events on `/api/events`:

| Event | Data |
|---|---|
| `job.started` | `{id, kind}` |
| `job.log` | `{id, lines: [str]}` (batched) |
| `job.progress` | `{id, current, total, label}` (throttled) |
| `job.done` | `{id, result}` |
| `job.failed` | `{id, code, params}` |
| `drop` | `{paths: [str]}` |
| `mods.state` | as the `mods.state` method, on every change: a toggle's start, progress (at most every 0.25 s) and end, the end of every writer job, the game watch's answer, the classic window opened, busy and closed, the classic queue, the scan consent, the switch's settings, a game folder change, another data directory's change to `profiles.json` |
| `library.scanned` | `{counts: {install key: {state: n, configured: n}}}` after a scan (`stuck`: a `pending` entry with no official copy) |
| `library.changed` | `{cores, kinds}` after every writer job (empty lists for a job that switched nothing the page shows); without data (read everything again) after a failed writer job, a library move, a classic window closing, and the mod list's own changes |
| `classic.opened` / `classic.ready` / `classic.closed` | `{pid}` / `{pid, tab}` / `{code}` (see Classic window); `classic.closed {code: null}` for a window an earlier instance left |
| `classic.queueDone` | `{submitted: [{method, params, entries, job}], dropped: [{method, params, entries, error}]}` once the writes queued for the classic window ran |
| `tray.toggle` / `tray.open` | `{job, enabled, expect}` / `{view, ...}`: the tray submitted a toggle, or brought the window up on a view (see Tray) |
| `config.changed`, `app.busy` | `{}` |

## Mods state, scan and the classic queue

The services hold what the Enable Mods switch, the prompts and the classic hand-off read (`webui/services.py`):

- **The snapshot** (`ModsSnapshot`). `mods.state` answers from it, never through the library lock: the library's
  `status()` (the known installs, the current one, the shared intent and the configured count; names and
  `profiles.json` only, without walking storage folders), the last scan's entries and a running toggle's
  progress. The jobs, the scanner and the game watch update it; its lock is a leaf lock. Install labels are made in
  the UI language from `settings.server.*` and, for two installs of one server, `mods.installNamed` with the
  folder that tells them apart. `reason`, first match: `game_not_found` (no known install at all),
  `profiles_unreadable`, the game watch's answer (`game_running`, `game_status_unavailable`, `steam_busy`, a classic
  window an earlier instance left), this instance's classic window (`classic_open`). With the scan consent, `pending`
  and `stuck` count the last scan's entries; without it, they and `left` count the `unfinished` list by `why`.
- **The library** is built without a current install too (ADB mode, the selected folder missing), from the library
  folder, the catalog and the settings, with `scan_allowed` (the pref `scan_consent`, read at each use, so a change
  needs no rebuild), `data_id` and `write_check`, which refuses every game file write with `classic_open` while a
  classic window is open. That covers a restore while mods are off that the cheap judgement took for writing nothing
  but whose full judgement finds a file changed (the classic GUI writes in place): the write itself is refused.
- **The data directory's id.** `UiState.data_id(data_dir)` keeps `data_id` (12 hex digits) with `data_path` (the
  data directory, resolved, case-folded on Windows) in `webui.json`, made when the services first build the library.
  A recorded path that is another folder means a copy when that folder still exists with the same id (a new id), and
  a move otherwise (the id kept, the new path recorded).
- **The scanner** (`webui/scanner.py`) runs the scan on a daemon thread of its own, never on the job worker, and
  only with the scan consent: one scan at a time, requests made meanwhile served by one scan after it, `cancel()` on a
  game folder change or a library move (the result is dropped). A stale result (the library wrote while the files
  were read) is scanned again once while no writer job runs, else dropped: the scan after that job replaces it. The
  start scan waits for the `library.prune` job. Startup prune and scan begin after the first screen reveals,
  while Check for Configuration Drift and Untracked Mods at Start is On. Off withdraws consent, cancels outstanding
  scans, releases the classic queue and empties the entries. With consent, scans also run after a game folder change,
  after every writer job, when the game stops or Steam turns idle (the game watch), after a classic window closed,
  when consent is granted, on Settings' Check (`mods.scan {dismissed: true}`, which lists dismissed entries again)
  and whenever the page asks (`mods.scan`, the window back in front after 30 s).
- **Another data directory** sharing the library: at each poll the game watch asks `profiles_seen()`, which reads
  `profiles.json` again only when its size or date changed (under its file lock, never the library lock). When the
  shared intent or the `unfinished` counts changed, the snapshot follows, `mods.state` is published, an automatic
  scan is requested with scan consent and `library.judge` judges the `unfinished` list, so the red dot and Retry follow with or without scan
  consent.
- **The classic queue.** While a classic window is open, `actions.apply`, `actions.restore` (when it would write),
  `mods.toggle` and `mods.restoreDrift` are refused at submit with `classic_open`; the toggle and Apply Mod
  Configuration check again when their job starts, before anything is saved. The classic modal queues the refused
  call (`classic.queue`) with its pins and the size and date of its entries' files. Once the classic window closed (its
  watcher thread, or the game watch for one an earlier instance left), the page is told to read everything again,
  a scan runs (with scan consent), then `ClassicQueue.run` submits each call that still holds as its normal job and
  `classic.queueDone` lists the dropped ones. The queue waits for the scan it asked for by its number; when the
  consent is withdrawn meanwhile, that scan is dropped with the others and the queue runs at once.

## One instance per data directory

`main()` takes an OS lock on `<data dir>/instance.lock` for the process lifetime (`webui/instance.py`; `flock` or
`msvcrt.locking`, released by the system however the process ends) and names itself in `<data dir>/instance.json`
(`{pid, port, raise_token}`). A second start finds the lock held, posts `/api/instance/raise` with the raise token
(header `X-BAMT-Raise`, never the session token) and exits: the first instance shows and raises its window, or in
browser mode opens its page again. With `--serve` a second start refuses with a message. A classic window outlives
the instance that started it and is found again through `classic.json`.

**Quitting.** `app.quit` (the roster's quit prompt) is refused with `busy` while a writer job is queued or running,
the same rule as the window's close button; otherwise it closes the window, or in browser mode answers first and then
stops the server (the page shows Closed); with `--serve` it gives `native_unavailable`.

## RPC

`POST /api/rpc` with `{"method": "...", "params": {...}}`, answered with `{"result": ...}` or
`{"error": {"code", "params"}}`.

| Method | Result |
|---|---|
| `app.info` | version, language, platform, game found, resource version, consent (`null`, `true`, `false`), `uiCached` (consented light assets on disk for the current resource version), paths, `debug` (started with `--debug`) |
| `app.consent {granted}` | records the choice; `false` closes the app |
| `app.quit` | closes the window; `busy` while a writer job runs; in browser mode answers, then stops the server; `native_unavailable` with `--serve` |
| `app.openClassic {tab}` | `{started}`: starts the classic window on a tab (`settings`: its settings) and waits for it (30 s at most), or brings the open one to the front, with the tab unless a classic task runs; a window an earlier instance left is only raised; `classic_failed {exit_code}` when the child exits or stays silent first; `busy` instead of a new window while a job writing the game folder is queued or running |
| `app.classic` | `{open, ready, busy, pid, orphan, queued}` (`orphan`: found through `classic.json`) |
| `classic.front` | `{raised}`: the classic modal's Bring to Front (never starts a window) |
| `classic.queue {method, params}` | `{queued}`: keeps one of `actions.apply`, `actions.restore`, `mods.toggle`, `mods.restoreDrift` for when the classic window closes |
| `classic.clearQueue` | `{}` |
| `i18n.strings {lang}` | `{key: text}` for `webui.*` |
| `roster.list` | families with variants, mod counts, fresh flags, favourites, recent order, `added` (when the newest own mod was added), `aliases` per family and per variant (matched by the search, never shown), `custom` per family (the user's own aliases); without scan consent Replaced comes from the library's records only |
| `settings.get` / `settings.set {key, value}` | the settings popup's values; key `roster` keeps the student list's view (merge, segment filters, sort, order, filter groups; `webui/state.py roster_view`); `lobbyZoom` is `{mode, custom}` in `settings.get`, set by keys `lobbyZoom` (`game`, `art`, `unlocked`, `custom`) and `lobbyZoomCustom` (1.0 to 4.0 game views across, kept in 0.1 steps); `lobbyPost` and `lobbyIntro` (the lobby's post-processing and its intro, on by default); the booleans `modSwitchShown` (the switch on the main screens), `tray` (the tray or menu bar icon) and `classicPrompt` (the hand-off prompt); `settings.get` adds `traySupported` |
| `family.get {key}` | a family with its variants (and `aliases` and `custom`, as in `roster.list`), mods and each variant's state, judged cheaply (`copy`, `restorable` and `official` per file; Needs Fix only from the record of the switch that wrote the file); `configured {spr, lobby}` per variant (the sources of its primary cores); `modelFiles` per variant (the 3D model's prefab bundles, newest first, `fixed` or `ok` from the header) and `version` (the game's resource version, so a switched install reloads the screen); `modList` by the variant the current catalog gives each mod's core |
| `lobby.warm` | builds the memorial lobby prefab index and the index of every bundle's CABs (the particle effects' materials, textures and meshes) in the background (once per game); the detail screen calls it for a variant with a lobby |
| `lobby.lines {variant, talks, lang}` | `{clip: {lang: text, voice}}`: zh-CN from Kivo, ja from Kivo else the Global server, en, zh-TW, ko and th from the Global server (read only for a `lang` other than zh-CN, left out when its table is not in within 3 s); `talks` (`{animation: [clip ids]}` from the skeleton) places the Global rows on the clips; `lines_unavailable` when neither source can be read |
| `debug.trace {events}` | the fullscreen lobby's input events, logged (logger `ba_modding_toolkit.webui.trace`, and `input-trace.log` in the data directory) only when the app was started with `--debug`; ignored otherwise |
| `preview.failed {url, step, error}` | bounded browser preview diagnostics in the session log, including release builds |
| `favorites.set {variant, on}` | |
| `aliases.set {family, aliases}` | the user's own aliases of a student as kept (`webui/state.py`: NFC, no control or format characters, whitespace runs one space, empty and repeated ones, ignoring case and width, dropped); `alias_too_long` past 24 characters, `alias_too_many` past 8, and nothing is kept then; an empty list forgets them |
| `mods.add {paths, background = false}` / `mods.pick {background = false}` | `{added, duplicates, installed}`; with `background`, a library writer job id (`mods.pick` opens the native file dialog); identity is core plus SHA-1, independent of filenames |
| `mods.removalInfo {id}` | `{name, used}` for the deletion confirmation, including configured and applied entries in every install |
| `mods.remove {id, confirm = false}` | library writer job id; result `{done, failed, dropped, cores, kinds}`; deletes the source, stored files and references, then restores game entries to Official or their saved source; refused writes keep the new configuration and an unfinished entry |
| `mods.rename {id, label}` | |
| `mods.seen {id}` or `{ids}` | stores seen mod IDs in `webui.json`, without writing the library; roster and family fresh flags come from this state |
| `mods.state` | `{installs: [{id, key, server, folder, label, distinct, named}], current, enabled, shown, available, reason, reasonParams, scan, explained, configured, pending, stuck, left, unfinished: {pending, left, stuck}, drift, untracked, damaged, sourceMissing, queued, scanned, tray, traySupported, busy, progress}` from the snapshot (above); `id` is the first 12 hex digits of the install key's SHA-1 (used in URLs), `named` tells a folder the settings name from a recorded one; `busy` while a toggle is queued or running or writes are queued for the classic window; `progress` is `{done, total}` of a running toggle |
| `mods.sizes {kind}` | `{builtSize}` for `kind: "built"` or `{originalsSize}` for `kind: "originals"`, bytes measured on demand; Settings requests only the Mod Cache size; no size walks in `mods.state` |
| `mods.toggle {enabled, expect}` | job id (`mods.toggle`): the switch over every known install, also Retry; `busy` while another toggle is queued or running, `classic_open` at submit; the job's refusals `state_changed`, `folder_changed`, `game_running`, `game_status_unavailable`, `steam_busy`, `classic_open`, `not_enough_space` |
| `mods.consent {granted}` | `{}`; saves `scan_consent`; granting enables startup checks and requests a scan immediately; withdrawing stops the scans and empties the entries |
| `mods.explained` | `{}`; sets `mods_explained` (the first toggle's explanation was shown) |
| `mods.scan {dismissed = false}` | `{requested: bool}`; the result comes as `library.scanned`; `scan_off` without scan consent; `dismissed: true` is Settings' explicit Check |
| `mods.entries` | the last scan's entries (`{install, core, variant, names, kind, source, configured, state, overwritten, fixed, size, files, dismissed}`), updated by every writer job's result until the next scan; empty without scan consent |
| `mods.adopt {entries}` | job id (`library.adopt`): Add to Library for `[{install, core}]`, allowed while the game runs and while a classic window is open; `not_enough_space` |
| `mods.restoreDrift {entries}` | job id (`mods.restore`): Apply Mod Configuration; `classic_open` at submit |
| `mods.dismiss {kind, entries}` | `{}`; `kind` `drift` (Keep as Is) or `untracked` (Don't Ask Again) |
| `mods.clearBuilt` | job id (`library.clearBuilt`); its result `{freed}` |
| `mods.forget {install}` | job id (`library.forget`): Remove from List; `bad_params` for an install the settings name |
| `actions.apply {variant, source, kind}` / `actions.restore {variant, kind}` | job id; switches what the current install shows, `kind` `spr` (default) or `lobby` (see library); the result has `deferred` while mods are off (configured, not written); `classic_open` at submit only when a game file would be written, `folder_changed` when the current install changed before the job ran, `steam_busy` from the write, `game_not_found` without a current install |
| `actions.update {mod}` / `actions.extract {target}` | job id |
| `actions.compare {mod}` | per-asset differences |
| `actions.remap {mod}` | writer job; creates a new mod against current official bundles, preserving the source; result `{mod, report, compare}`; `report.upscaled` lists `{atlas, page, w, h}` for pages enlarged before remapping |
| `os.reveal {path}` | |
| `app.checkUpdate` | the newest release above this version, or `null`; `downloaded` and `file` (path or `null`) report a verified file still present for that version in this session |
| `app.update` / `app.installUpdate {file}` | job id (download and MD5 check, result `{file}`; reuses the verified file for the same version) / swap in the build and quit after Restart; `classic_open` while any classic window is open (never queued) |

HTTP endpoints outside `/api/rpc`, each with its own token, never the session token: `GET /api/classic/control` and
`POST /api/classic/report` (the classic child's one-time token, see Classic window) and `POST /api/instance/raise`
(the raise token of `instance.json`).

### Atlas remap

`atlas_remap.py` reconstructs current official atlas pages from matching mod regions. When either physical page
axis is smaller than its atlas declaration, the whole page is enlarged to at least the declared dimensions with
Pillow's LANCZOS filter before any region is cropped or placed. Larger pages retain their resolution; no dependency
is added. This also normalizes undersized official destination pages, so the result uses the official declared
size. Rotations, trim offsets and premultiplied alpha remain part of region placement. `mod-compatibility.js` adds
"Textures upscaled to {w} × {h}" to the result for each distinct enlarged size (`remap.upscaled` in all five locales).

## Asset routes

| Route | Class |
|---|---|
| `/asset/ui/atlases.json`, `/asset/ui/sprite/<atlas>/<name>.png` | light |
| `/asset/ui/textures.json`, `/asset/ui/texture/<name>.png` (also the PC pointer and the touch effect's textures, an index of their own outside the listing) | light |
| `/asset/ui/layout/<root>.json?path=<subpath>` | light |
| `/asset/art/bg/<name>`, `/asset/art/portrait/<name>.png` | heavy |
| `/asset/spine/spr/<core>/<file>`, `/asset/spine/lobby/<core>/<file>`, `/asset/spine/mod/<id>/<file>` (`skeleton.skel` and `skeleton.atlas` stand for the skeleton named like the core, a mod's own core for a mod, else the only one) | heavy |
| `/asset/spine/official-spr/<core>/<file>`, `/asset/spine/official-lobby/<core>/<file>`: verified official skeletons, atlases and pages, from kept originals when the game files are overwritten | heavy |
| `/asset/spine/<kind>/<key>/manifest.json`: the revision of the selected ordered bundle set; `/asset/spine/<kind>/<key>/<revision>/<file>` serves only that revision, including relative atlas page paths | heavy |
| `/asset/spine/spr/<core>@<id>/<file>`, `/asset/spine/lobby/<core>@<id>/<file>`: the core in another known install, `<id>` from `mods.state.installs` (in the path, so the skeleton's own relative files follow it), read through a GameAssets over that install's folders, made on first use and dropped with the services rebuild; an unknown id is `404` | heavy |
| `/asset/spine/lobby/<core>/lobby.json` (prefab layout, touch boxes, clips, idle pools, sound events, post-processing, particle and mesh effects and sprites, page materials, pinned bones, the intro timeline (`gameassets/intro.py`); no skeleton is extracted) | heavy |
| `/asset/spine/lobby/<core>/fx_<id>.png` (a particle, mesh, sprite or page shader texture the lobby's `fx.textures` lists) | heavy |
| `/asset/spine/lobby/<core>/sfx_<id>.wav` (a sound clip the lobby's `sounds` list, decoded in memory) | heavy |
| `/asset/model/<variant>.glb` (the variant's chibi, `model/gltf-binary`) | heavy |
| `/asset/voice/<variant>/<clip>` (a lobby voice relayed from Kivo) | heavy |

Thumbnails (faces, busts, expression cards, variant cards) are rendered in the page from the skeletons, in one
shared offscreen WebGL context, and kept as in-memory blob URLs. They are framed on the face (the expression and eye
slots, halos left out; without a part named like one, the face-sized parts the expression animations switch, as
many NPC portraits name their face slot `0`, `00` or `defalt`), sized by its width held between 170 and 400
skeleton units, never by the skeleton's bounds; the bounds stand in only where no face is found.

`detail.js` resolves the `official` card and `variant:<key>` cards through `official-spr` / `official-lobby` for the
candidate's core; `mod:<id>` uses `mod` and the mod's own core. `popup.js` receives these thumbnail promises and adds
no file selection. `ModLibrary.official_bundles` resolves every part through `_official_for`: verified kept original,
verified game file, verified `.backup`, or a verified copy elsewhere. Missing official data fails the whole preview
with 404 and `thumbs.js` returns null, leaving the existing plain card. Mod previews overlay the mod's parts on
verified missing official parts, matching parts by prefix and resource type; they never fall back to live mod data.

`spineAssetBase` resolves the manifest for every load, before the thumbnail cache lookup. The revision includes the
ordered resolved paths, sizes, nanosecond modification and change times, covering an atomic replacement that
preserves size and modification time. It sits in the directory shared by the skeleton, atlas and every texture page.
`Services.asset` checks the revision before and after extraction and rejects a source change during the request;
`GameAssets.spine_files_from` uses the same file versions and rejects changes during extraction. Thumbnails are
cached by resolved base, frame and expression, so correctness does not depend on change events or `forget`.

Files of a core merge by name, the last bundle winning. A mod preview lists the official parts first and the mod's
last; the game folder lists parts by file name, so an official part could come after an applied mod part and win a
texture both carry (the mod's atlas drawn over the official page). `ModLibrary.live_bundles(core)` gives the live
`spr` and `lobby` sources the preview's order, the parts that are not official last (cheap judgement); a core the
library does not know keeps the game's order. Official and preview parts are limited to the core's Spine category
(`spinecharacters`, `spinelobbies`, `spinebackground`).

`thumbs.js` rests a still in the pose its skeleton settles into: a portrait in `idleAnimation`, a memorial lobby
(`thumb(base, frame, expr, true)`) in `lobbyIdle` (`rest-pose.js`), which `lobby.js` `idleOf` uses too. The tracks are
cleared before the idle is set, as the player starts the skeleton's first animation (a lobby's intro) and a new one would
mix in from it. A load also takes the other frame of a card (`card` and `bust`), so the big picture of a card is not a
second load; the promise of a thumbnail has `bump()`, which `popup.js` calls for the cards in view (again on scroll),
and the roster asks for its rows in view first. Pictures stay in memory only, keyed by the resolved base (the revision
the files carry), frame and expression; `spineAssetBase` shares one answer between overlapping requests.

The main portrait resolves its current candidate in the same way. The main memorial lobby uses live `lobby` files,
or the configured `mod` art while mods are off. Its metadata and effect/audio requests keep the live lobby's
revision; its art layers and pages use the art source's revision. Player reuse and measured art limits require both
revisions to match. Pending manifest waits cancel on a newer request or leaving the view, and serialized player
loads keep their cancellation and timeout handling. Lobby effect/audio caches include their source bundle versions. The roster uses
collection art when present and live `spr` thumbnails otherwise; entry cards use live files of their named install.
These thumbnail paths also resolve a manifest before caching.

The main portrait retries once when a rejected load has a newer manifest revision, like thumbnails. A missing or
invalid manifest reports its URL and status or validation error in the console; the detail error also names the
logical portrait source. Asset-route failures log the request and cause at warning level. Live routes without a
revision use the same mod-last order as the manifest, and only an unknown library core falls back to discovery;
read failures and dev-mode refusals propagate. Clearing the asset cache evicts extracted Spine files, while a
reload resolves and extracts the same live composition without needing a mod preview or kept originals.
The portrait starts independently of the detail layout, using the game's default framing while the layout loads.
A cold layout export reads the atlas index too, so its failure must never prevent portrait requests from starting.
Manifest network and JSON failures retain the URL and original cause; JSON errors include the response status.

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
  names, the aliases (the variant's and the family's: the CN server's zh-CN names, never shown; see catalog), the
  user's own aliases of the family (the detail screen's alias editor) and the file id, ignoring case, width, kana and
  separators (with the marks inside names, as in Shiroko*Terror); every word must match. Its input opens focused at once, before the box is drawn round it, and stays in the page across
  rebuilds, so nothing typed meanwhile is lost. The detail screen's arrows follow the same search.
- Keyboard focus moves the list through its own scroll position (the clip never scrolls by itself, so the virtual
  rows and the scrollbar stay in step); the cards are in the page in the list's order, and the focused one shows a
  ring in the game's selection blue.
- A visit to a variant (`ui.visit`) is mirrored in the page's roster data, so "Recently Viewed" has it on the way
  back without a new `roster.list`.
- The detail screen's arrows step through the cards as the list showed them when it was left, in its order, wrapping
  round; a variant the list hides (another chip, a deep link) steps from its place in the whole list.
- Back from the detail screen, the list is built behind the loading cover. The visible rows finish their portraits,
  frames and panels before reveal; rows outside the viewport are queued after the visible ones. The first build
  waits the same way. Pictures are decoded too (`NGUI.decoded`, a 15 s failed-decode deadline; the URL and waiting logic is
  `image-decode.js`, tested in Node from `tests/test_image_decode.py`). WebKit lets go of the
  blob images a hidden screen draws (the sliced and tinted sprites `ngui.js` bakes): without the wait it painted the
  list's first frames (about 100 to 200 ms) with the portraits only, without the frame, the card frames and the
  dimming of the cards without mods. A rebuild inside the list (filters, sort, search) waits the same way for the
  pictures the list does not show yet.
- The left and right arrow keys step like the arrows, as in the PC client: its key mapping
  (`Assets/_MX/AddressableAsset/KeyMapping/PCKeyMappingSO.asset`) binds UICharacterDetail's `Arrow_L/Left` to
  `UI_KeyMapping_Common_ArrowLeft_isUsed` (LeftArrow) and `Arrow_R/Right` to `UI_KeyMapping_Common_ArrowRight_isUsed`
  (RightArrow), with no second key and no key icon on the arrows (`step-keys.js`, tested in Node from
  `tests/test_step_keys.py`). One step at a time: the next one waits until the screen shows the student the last one
  went to, so a held key steps at the pace the screen follows and starts no load it would drop; a press meanwhile
  waits (the latest one only), a held key's repeat only while the key is held. The keys do nothing with a modifier
  held, while a text field or an input method has them, under a popup (the screen's, the settings, the consent or
  update dialog), in a fullscreen view (the lobby, the 3D model, the portrait's visual mode), during a job or another
  change of the screen, or behind the loading screen. A focused control of the screen (an arrow stepped with Enter)
  keeps the focus in the new screen.

### Quit

The student list quits the app as the PC client's back key does in the lobby (`quit.js`, its rules tested in Node from
`tests/test_quit.py`).

- **Where.** The top bar's round back button (`Common_Circle_Back_Btn` with `Common_Icon_Back`, as on the detail
  screen) shows on the student list too, and Escape on the list does the same (decision 13). The detail screen's back
  button still goes to the list.
- **When Escape is left alone.** When another handler took the key (`defaultPrevented`: the search box, the display
  settings), while an input method composes (`isComposing`, `keyCode` 229), for a held key's repeat or with a
  modifier, while a popup host is open (`#consent`: the asset consent, scan consent and update popups; `#display`,
  `#settings`, `#dialog`, `#prompt`, and the detail screen's `#popup` and `#picker`), behind the loading screen, and
  on any screen but the list.
- **The prompt.** The game's quit popup: title Notice (`quit.title`), line Quit? (`quit.ask`), Cancel and Confirm, on
  the shared message popup. The PC client's own message popup (`UIPopup_System`) is not among the bundles the tool
  reads (the prefab index of the 2026-10 resource version has no common message, notice or quit popup), so the
  prompt is drawn on UIPopup_Sort's frame like the others. Escape, the backdrop and the close button cancel. Enter
  and Space confirm while the prompt holds the focus: the PC client's key mapping (`PCKeyMappingSO`, its JSON backup
  in the `keymapping` bundle) binds the confirm of `UIPopup_System` and `UIPopup_Sort` (`Btn_Ok`,
  `UI_KeyMapping_Common_BtnOK01`) to Return with Space as its second key; their cancel's Escape binding is unused.
  One prompt at a time.
- **Confirm** calls `app.quit`. While a writer job runs it is refused with `busy` (a toast), as the window's close
  button is. In the app's window the window closes. In browser mode (`--browser`) the server stops once it has
  answered, and the page shows Closed (`app.closed`) alone, without the top bar and the navigation. With `--serve`
  it is refused with `native_unavailable` (a toast).

### Bottom navigation

`nav-items.js` (tested in Node from `tests/test_nav_items.py`) lists the bottom bar's entries and decides what a
click does; `nav.js` draws them.

- **Greyed entries** (decisions 18 and 19). An entry is greyed exactly when it has a classic tab and no web screen
  (`classic` and no `route`): today the eight entries after Students. A later web screen is drawn normally once its
  entry gets a route. A greyed entry keeps the game's disabled tint and nothing else: no lock (these entries are not
  locked, they open elsewhere), no hover change, never the active look, and no tooltip. It stays a button:
  `aria-disabled="true"` (not `disabled`, which would swallow the click), focusable with the focus ring, and named
  "{label} - Classic UI" (`nav.classic`) for assistive technology.
- **The tint.** The game's buttons carry no NGUI button colours (see gameassets, "Button states"); a locked lobby entry
  (UILobby, `Front/Bottom/Menu/BG/Grid/<entry>/Disable`) shows the same icon sprite at `#797979` under a lock, and
  its label in its usual colour. The page reads that tint once (`/asset/ui/layout/UILobby.json?path=...`) and puts it
  on the icon as a brightness factor (0.4745; `data-tint="game"`; the icon at half until it is read). Without that
  prefab it takes NGUI's default disabled colour (`Color.grey`): the icon and the label at half brightness (`ngui`).
  Without a game folder the no-game screen shows the navigation too, with the icon in grey at half brightness and the
  label in the settings' disabled grey (`#9aa3ad`, `plain`).
- **The hand-off prompt** (decision 6). A click, Enter or Space on a greyed entry opens the prompt on the shared
  message popup: the entry's label as its title, "Not migrated yet, opens in the classic UI" (`classic.hint`), the
  checkbox Don't Ask Again (`mods.dontAsk`, unticked), Cancel and Open. It shows on every click. Open with the box
  ticked turns the pref `classicPrompt` off (`settings.set`) before the hand-off; Cancel, Escape, the backdrop and
  the close button save nothing. With the pref off a click hands over at once. Settings' General tab turns it back
  on: the row Confirm Before Opening Classic UI (On / Off) under More Settings (the General tab's rows scroll, so it has room).
  More Settings itself opens the classic UI without a prompt. Without a game folder the classic UI still works, and
  the prompt is drawn plain (Popups).
- **The hand-off.** `app.openClassic {tab}`, with the corner indicator labelled "Opening the classic UI" until the
  classic window is up (Loading screen); `classic_failed` and other refusals (`busy` while a job writes the game
  folder) show as a toast. One hand-off at a time: a click while one is under way does nothing.

### Portrait

The detail screen frames the portrait like the game (`portrait-view.js`): the skeleton's origin sits on
UICharacterDetail's `CharacterPos` (`Inventory_ListControl/CharacterPos`, scale 101; a skeleton unit is 1/100 of a
Unity unit in every SkeletonDataAsset), never on the skeleton's bounds, so a long weapon, wings or a prop beside the
character neither shrink nor shift her. The player covers the stage under every panel and keeps one scale across and
down (its viewport has the canvas's own aspect).

**Visual mode** (`visual-mode.js`, framing in `visual-view.js`). The nameplate's square button with the rotate-phone
icon (`Char_ZoomBtn`, UICharacterDetail's `ZoomButton`; its click is wired in code, the prefab's `onClick` is empty)
opens the game's UICharacterVisualMode, a UI of its own. The identifiers in `global-metadata.dat` name what its code
does (`OnPressScreen`, `OnMoveSpine`, `PlayZoomInOut`, `co_ReturnToDefaultPosition`, `CheckResetButtonState`,
`OnClickHide`, `OnClickShow`, `UpdateGyro`, `SetScreenAutoRotation`); its prefab has a mobile group, drawn turned by
90 degrees for a phone held upright (hence the icon), and a PC group, which the page draws:

- The detail screen's UI slides out as in the lobby's fullscreen, and the portrait's own player (its face, its blink)
  glides from the detail framing into the whole art: the body in the middle at `Character/CharacterPos`'s scale (50,
  half the detail screen's 101; the tallest portrait, 3277 skeleton units, still fits the screen). The game reads the
  body's centre and the default, least and largest scales of each character from its CharacterIllustCoordinate table
  (`CharacterBodyCenterX/Y`, `DefaultScale`, `MinScale`, `MaxScale`), which the install keeps in the encrypted
  `ExcelDB.db`: here the centre is the skeleton's origin across and the middle of its bounds down, and the zoom goes
  from the whole art to 4 times closer (about twice the detail screen's size).
- `BG`: the collection background, 4533 x 3400 units, under two light patterns (`UITex_BGPoliLight_1` and `_4`)
  whose TweenAlpha ping-pongs between 0.2 and 0.5 every 1.25 s in opposite phase; it fades in over the detail screen's.
- `TouchArea`: press and drag (any button, one finger) moves the art, the stage's centre staying on it; the mouse
  wheel zooms at the pointer, a trackpad pinches and swipes (as in the lobby), two fingers pinch.
- The buttons, their corners anchored to the screen's edges, slide in with `UIAni_CharacterVisualMode_PC` (its
  Hermite keys sampled at 60 fps): `Btn_Back` (top left) and Escape leave, `Btn_HideUI` (top right) slides them out
  and `Btn_ShowUI` fades in in its place to bring them back, `Btn_RefreshPos` (bottom right, `UI_BUTTON_RESET_POS`)
  glides back to the whole art and is greyed out (`Btn_RefreshPos_Disable`) while it is shown. The background and the
  buttons are rendered off screen first, so every part starts in the same frame.
- Leaving glides back to the detail screen's framing exactly. Not reproduced: the phone's gyroscope (mobile only) and
  the button sounds. Without the prefab the portrait still goes fullscreen, with the tool's exit button.
- While any fullscreen view is open (this one, the lobby's, the 3D model's), the slid-out UI, the top bar and the
  navigation are inert (`uiOut`): Tab reaches only the view's own buttons (the tool's exit button in the others), and no
  hidden control acts. Leaving (`uiBack`) gives the focus back to the control that had it and always closes the
  visual mode, whatever tab the screen shows by then.

### Popups

The detail screen's popups (switch portrait, switch memorial lobby, the variant picker, compare, details, aliases) are
drawn on the game's popup frame (UIPopup_Sort) and cover the whole stage with its dark backdrop, top bar and
navigation included, like the display settings and the settings; a click on the backdrop or Escape closes them
(PopupClose).

**The shared popup module** (`popup.js`, tested in Node from `tests/test_popup.py` on a stand-in DOM). Every screen
draws its popups with it, and it reads its own prefabs once (`ready()`): UIPopup_Sort (required), the student list's
tools (UICharacterCollection) and the gacha list's checkbox (UIPopup_GachaCharList.Btn_Checkbox), the last two
optional, so a popup still works without them.

- **Hosts.** The detail screen's own, `#popup` and `#picker`, inside the screen; and two on the stage, so a popup
  shows on any screen: `#prompt` (z-index 2550) for list prompts and `#dialog` (z-index 2600) for message popups, both
  over the settings (2500) and under the toast (3000). Each message popup is a layer of its own in `#dialog`, so one
  opened from another shows over it.
- **The stack.** Every open popup is on one stack (`opened(host, close)`), and Escape goes to the topmost one only.
  A popup that must be answered with a button (no close button) takes Escape and does nothing with it, so nothing
  under it acts. A popup leaves the stack by itself when its host is hidden or its layer is gone. Escape is left
  alone while an input method composes (`isComposing`, `keyCode` 229) or when a control took the key itself
  (`defaultPrevented`). `anyOpen()` tells whether any popup is up (the stack, or the consent, update, settings and
  display hosts), and `whenIdle(every, blocked)` resolves once none is and the optional work predicate is false.
- **Buttons.** Every button of a popup is an invisible button over the drawn one, named for assistive technology by
  the caption it covers (`aria-label`) and marked with what it does (`data-action`). When a sprite is missing from
  the atlases its button is placed from the prefab node, so the popup can still be answered.
- **`popupFrame(title, w, h, {ok, cancel, close})`**: the frame at a size, its title, the close button and Cancel / OK
  (a lone button in the middle).
- **`message({title, lines, ok, cancel, check, close})`** in `#dialog`: lines of text, centred; when a line carries a
  small button (`{text, button: {label, fn}}`, the consent popup's light blue Change button), every line is a row of
  the game's light stats box with its button at the right. An optional checkbox (the gacha list's) under the lines.
  `plain: true` uses left-aligned lines without a box or separators; line buttons stay at the right, and adding one
  preserves the text's font size and fitting rules.
  It resolves once it closes, however it closes, with `{button, checked}`: `button` is `ok`, `cancel`, or `null` for
  the close button, the backdrop and Escape; `checked` is the checkbox's state at that moment. `close: false` draws no
  close button, and the backdrop and Escape do nothing. The popup takes the keyboard focus while it is open (Enter
  presses nothing under it) and gives it back. `confirmKeys` (none by default; the quit prompt's Enter and Space)
  press OK while the popup is in front and holds the focus itself; a focused button takes its own key, and a held
  key's repeat, a modifier or an input method composing press nothing. Without the frame's prefab (no game folder)
  the same message is drawn plain: a light box on the dark backdrop with the title, the lines, the checkbox and the
  buttons, marked and answered the same way.
- **`listPopup({...})`**: the frame laid out like the game's quick formation edit, the selection's details on the
  left, the cards in a framed list on the right, the buttons under it. The student list's tools over the cards are
  optional (`tools`); without them a hint and a footer show in their place. One card chosen (`selected`), or several
  ticked (`multi`, with `selectable(items)` ticking all that can be, `toggled()` and `sizeOf()` for the ticked cards'
  total size). A card that cannot be ticked (`disabled`) can still be clicked; `dim` darkens it like the roster's
  not-owned cards with its picture in grey, and `badge` replaces In Use with the caller's word. Buttons right-aligned
  under the list (the main ones in OK's blue, three or more a little smaller), a checkbox at their left, and no close
  button when `onClose` is `null`. The cards' buttons are in the page in the list's order.

**Start sequence** (`main.js`, `Popup.sequence`). Once the first screen is revealed the start popups come one at a
time, in order, each only when it has something to show (`mod-switch.js startDue`): the asset consent, the scan
consent (while it is unanswered and a game folder is known; see Enable Mods switch). File checks require scan
consent: On checks at every start, Off withdraws consent and stops scans.
The Configuration Drift Check row's Check remains available while Off too: missing consent opens the scan consent
popup first, then Allow continues the manual check; declining cancels it. Check for Updates at Startup defaults to
on. In released builds it starts one background network check after the first screen is revealed, independently of
the popup sequence; turning it off skips that check. A slow
or failed check never holds startup, scan prompts or navigation. A newer release waits for the start popups to
finish, then for any open popup (including Settings), loading work, input hold, writer progress or queued mod toggle
to clear. Its offer can appear on any screen, including when the result arrives after startup. Manual Settings
update checks remain available and share an in-flight automatic check and its popup; their result callbacks still
run, so Settings closes for a newer release. `Update.check` resolves when its popup closes: `later` (Later or Escape), `page` (the download page
opened), `update` when a failed update is dismissed, `null` with no newer release, offline or if drawing fails.
Download progress and errors stay in the popup; its buttons and Escape are blocked during download. A verified
download shows Download Complete with Later / Restart. Later keeps it for this session; the next check for that
version opens ready to restart. Only Restart installs, and a refusal stays ready with an error and a retry. A
successful retry clears the failure, so Later / Escape then resolve as `later`. A step that fails is logged and the
next one comes. The prompts of mods back to official and of mods outside
the library come last, once the start scan is in (at most 10 s; one that comes later shows them once no other popup
is open), each when `startDue` says it is due: only with the scan consent, never while the game runs, Steam is busy
or the classic UI is open, no drift while mods are off, nothing dismissed (see Mods already in use).

- **Switch Portrait, Switch Memorial Lobby** (the switch card of the Portrait and Memorial Lobby tabs; the add button
  beside it adds mods of either kind): what the game can show for that kind (`switch-sources.js`, tested in Node):
  the variant's own files and its added portraits or lobbies; for the portrait also the other variants' own (those
  with one of their own), then the other variants' added ones. Other variants' lobbies and their added ones are not
  offered: another student's lobby under this variant's lobby prefab is untested in the game (the library itself
  still takes `variant:<key>` and other variants' mods for the lobby). Cards are framed on the face of each skeleton
  (a lobby's main skeleton, named like its core), "In Use" marks what the game shows now. Apply writes the choice
  into the game files (`actions.apply` with the tab's kind), then the portrait or the lobby is read again from them,
  under a still of the old one. A lobby popup offers only the lobby mods of its own core (a mod of an alternate core,
  `_home_gl`, is switched by the Enable Mods switch only). While mods are off nothing is written (decision 2): the
  popup starts on the configured source (the own files when none), that card carries "Set" (`switch.configured`),
  apart from In Use, its button reads Save, and saving only configures the choice ("Saved, applied when mods are on").
  On an overwritten kind (a file that is not official with no official copy anywhere, `restorable` false) every card
  but the one in use is greyed (the roster's not-owned dim, its picture in grey, "Overwritten" where In Use goes), and
  so is another variant's card whose files of that kind are overwritten: a greyed card is never chosen, and a click on
  it opens the entry's Add First or Overwritten message (see Mods already in use), as does `original_unavailable`
  from an apply or a restore. Delete, in a mod's details, always confirms with the mod's name. If configured or
  applied anywhere, it explains that those entries return to Official or their saved source. The library writer
  deletes stored files and references, retaining built files referenced by other keys, then restores affected game
  entries through the normal write checks. Refused restores leave the configuration changed and appear in Retry.
  The picker and file drops compare canonical destination keys with the selected variant when the add started.
  Plain additions there show an Added toast and refresh; additions elsewhere name their destination and offer Go to.
  Duplicates show Already in the Mod Library with the stored mod's name, with Go to only for another variant.
  Exact outside game content is adopted without reapplying it and shows Recognized as an installed Mod, including
  when it matches an existing library entry. A batch combines these messages in one popup, with navigation only
  for other variants; local results alone have a confirmation button. Choosing the source already in use shows
  Already in use without a job. Row 2's
  update and compare act on the mod the shown tab's files carry. The 3D tab's card has nothing to switch to yet
  (library): no chevron, and a click opens nothing.

- **New mod marks**: unseen mods mark their own variant chip, their kind's detail tab and the roster card (any
  variant when merged). A visit or a tab change keeps the marks. Opening a switch popup marks all mods it offers
  as seen, including other variants' portrait mods; opening a mod card also marks that mod. Other kinds keep their
  marks. Seen IDs live in `webui.json`, through `mods.seen`, independently of the library's legacy fresh flags.
  Mods without a seen ID start new; adding an existing duplicate keeps its seen state.

- **Aliases** (the pencil after the name on the nameplate, the game's name edit icon `Cafe_Icon_NameEdit`): the
  user's own aliases of the student, which the roster search matches (several, at most 8 of up to 24 characters;
  kept with `aliases.set` in `webui.json`). One row each, drawn like the game's input row (UIPopup_Input's
  Input_NickName: a grey box with a line round it, the text and placeholder colours), its cross removing it, then an
  empty row with the pencil to add one. Enter in the empty row adds what it holds, in another row goes to the next
  one; OK keeps the rows as edited, Cancel, the close button, the backdrop or Escape drop the changes. Nothing
  happens on Enter or Escape while an input method is composing (`isComposing`, or `keyCode` 229, which WebKit sends
  for the key that ends a conversion). The nameplate shows them after the name, small and dim, where the name leaves
  room; the pencil's accessible name includes them. They are text everywhere, never markup.

- **Details** (the Portrait, Memorial Lobby and 3D Model info bars' button): the shown tab's game files. The folder,
  what they carry and, for a mod, its file and the variant it was made for; then one row per bundle with its size,
  date, CRC state and what it carries. The frame fits its content and scrolls past the stage's height.

### Enable Mods switch

One kill switch for every game folder (`mod-switch.js`; the pure parts tested in Node from `tests/test_mod_switch.py`).
It never changes the configuration: Off puts every portrait and memorial lobby of every known install back to
official, On writes the configured sources again (see library). It is in the top bar of the student list and the
detail screen, and in Settings' Mods tab.

- **The top bar** (`#mod-switch`, after the title): the switch, its label and the square "?". All CSS on the game's
  sprites, like the rest of the top bar. The atlases have no two-state switch sprite (`toggle|switch|onoff` find
  none), so the switch is two of the student list filter's segments (UICharacterCollection `FilterBtn`:
  `Common_Filter_Tab_Type1` and its flipped twin, 9-sliced and inclined 10 degrees as NGUI draws them, at 40/104 of
  their size): ON pressed in the Support segment's blue (`#0664eb`), OFF pressed in the All segment's navy
  (`#153757`), on the pressed sprite `Common_Filter_Tab_Type1_Pressed`. The words are `settings.post.on` and `.off`
  (the game's On / Off). The "?" is the student list's own square info button (`Btn_Information`:
  `Common_Btn_Information` in `#2c4564` over a white square), its accessible name the game's "Guide". The label is
  fitted from 26 down to 20 stage px. It slides out with the top bar in fullscreen views, and is not on the no-game
  screen.
- **States** (`view(mods.state)`): on; off; busy while a toggle is queued or running or writes wait for the classic
  window (dimmed at the loading indicator's pace); unavailable, greyed with the reason as its accessible description (the game
  running or its state unknown, Steam busy, the classic window open, no game folder known, unreadable mod settings);
  the red dot (`Common_Icon_Reddot2`) while entries were not switched or were left as is. It is a `button` with
  `role="switch"` and `aria-checked`; Space and Enter toggle. Settings' Show on Main Screens Off hides it from the top
  bar (nothing replaces it), and so does having no current install (Settings keeps it).
- **A click** (`click(from)`, the same rules from the top bar and Settings): busy, a toast (`error.busy`), or the
  classic modal with its box ticked when writes wait for the classic window; unavailable, the reason as a toast; the
  first toggle ever, the explanation; the classic window open, the classic modal; otherwise `mods.toggle {enabled:
  !current, expect: current}` at once, with the corner indicator and "Working 12/40". The explanation (title and
  button Turn Off Mods or Turn On Mods, the help's opening text and "Not shown again", and Cancel) shows once: closing it in any way calls `mods.explained`, and only its button toggles. The end
  is a toast ("Mods off", "Mods on"), or, when entries were added to the library first, failed, were left as is or
  their adoption failed, a result popup: "Added to the library first: n", "Done: x, failed: y", "Left as is, no
  official copy: n", then each failed entry ("Airi, Portrait - ..."), the first six named and the rest counted.
  `state_changed` (switched elsewhere first) is a toast, and the switch redraws from `mods.state`.
- **The "?" help** (message popup, title Enable Mods): two opening lines (`mods.helpOn`, `mods.helpOff`): On applies
  configured mods to all portraits and memorial lobbies; Off restores official files where available and keeps mods
  in the library; close the game before toggling. Both opening lines use the smaller of their fitted font sizes,
  at least the popup's minimum (44 units), and wrap together at that size; the first toggle's explanation uses the
  same fitting. Both use plain, left-aligned lines with no box or separators, with or without scan consent or action
  rows. No storage explanation or size request appears in the help. "Game folders: ..." shows the install labels
  when more than one game folder is known; "Not switched: n" with Retry (the
  same toggle again) for pending and left entries; "Left as is, no official copy: n" with Details, the Overwritten
  message (the entries, known from the last scan with the scan consent, "No official copy left" and the repair lines
  of `repairs.js`, see Mods already in use; never a repair button); "Gone from the library: n". The counts are the
  services': the last scan's with the scan consent, the unfinished list's by why without it. Retry and Details stay
  at their line's right end. There is no scan-off row or Allow Check button; file-check consent stays in Settings.
- **The scan consent popup** (`consent.js scan`, built like the asset consent): Check Game Files; This app will:
  check whether each file applied in the game matches the configuration, find mods outside the mod library and
  files with no official backup; This app will not: read whole files or file contents, or send anything off this
  device (`mods.scan.will.{label,items}`, `mods.scan.willNot.{label,items}`); the note
  that declining keeps those checks off and Settings changes it; Don't Allow and Allow (`mods.consent`). It must be
  answered (Escape and the backdrop do nothing), declining does not quit, and opened from Settings it shows over it
  (`#consent.over`).
- **Settings' Mods tab** (second, after General; `UIPopup_Option_PC`'s tab column has five separators): Enable Mods
  (On / Off, the same switch with the same rules, its square "?" and red dot after the title; faded while busy or
  unavailable); Show on Main Screens (`modSwitchShown`); Mod Cache (mods rebuilt for the current game version and
  kept for instant re-enabling; size requested with `mods.sizes {kind: "built"}` when the row is drawn, loading text
  while waiting, Clear enabled for a nonzero size; `mods.clearBuilt`, then "Mod cache cleared" and the size measured
  again); Tray Icon or Menu Bar Icon (`tray`, only in the app window where the system has one); Check for Configuration
  Drift and Untracked Mods at Start (the standard two-option On / Off radio row), directly above Configuration Drift
  Check. On opens the consent popup before enabling checks, then scans immediately, at every start and on the automatic
  triggers described above; declining leaves Off selected. Off withdraws consent and stops scans. `scan_consent` is the
  sole stored preference. Legacy `startup_checks` is removed on load: At Startup stays On, Manual becomes Off because it
  did not authorize automatic checks, and unanswered consent stays unanswered. Configuration Drift Check shows what the
  last check found, "No drift found", or "File check off". Its Check button stays available with automatic checks Off:
  without consent it opens the scan consent popup first, then Allow continues the manual check (and enables automatic
  checks); declining cancels it. Check scans with the dismissed entries listed again; its square "?" gives one
  definition: configuration drift means the game files do not match the mod configuration. There is no Game Folders
  row in this tab. The tab follows `mods.state` while it is open. Ask Before Opening Unmigrated Features (`classicPrompt`)
  is a General row, under More Settings. The Folders tab's game folder, Mod Library and Classic Tools Output Folder rows use Change
  for their folder pickers.
- **The classic modal** (`classicModal`, decision 5): a write the open classic window refuses (`classic_open` from
  the switch, Retry, or the detail screen's apply and restore, at submit or from the job) opens "Classic UI Open",
  "Close the classic UI first", the box "Apply automatically once it closes" (unticked), Bring to Front and Confirm.
  Any way of closing follows the box: ticked, the call is queued (`classic.queue`, "Applies once the classic UI
  closes"); unticked, nothing. Opened on writes already queued (a click on the busy switch), the box starts ticked,
  and unticked the queue is emptied (`classic.clearQueue`). Bring to Front raises the classic window
  (`classic.front`). When the queue has run (`classic.queueDone`), one popup ("Not Applied") lists the dropped calls
  with their error strings, and a queued toggle shows its result as above.
- **What a writer job switched** (`library.changed {cores, kinds}`, `main.js`): the roster is read again (rebuilt at
  once when it shows, once no popup is open), the thumbnails under the live and official `spinePrefix(kind, core)`
  paths are forgotten (including the `<core>@<id>` bases of other installs; `thumbs.js forget` matches any case,
  the cores coming in lower case), and the detail screen
  reloads (`Detail.filesChanged`). It reads the family again and, when the shown variant's files of the shown kind
  changed, reloads the portrait or the lobby the way an applied one is (under a still of the old one). It waits
  while a popup or a fullscreen view is open, while the screen changes, and while its own job runs (whose reload
  comes first, so the same change is not read twice). Without cores (the classic window closed, a job stopped
  midway, the mod list changed) the screen compares what it shows with the family read again, and the roster forgets
  the portraits whose Replaced flag changed. A job that switched nothing (a prune) changes nothing on the page.
- **The window back in front** after 30 s or more asks for a scan (`mods.scan`, only with scan consent), so a
  Steam check or a repair made meanwhile is found.
- **While mods are off** an apply only saves the choice: the switch popup reads Save and starts on the configured
  source, and the toast says "Saved, applied when mods are on".
- **The tray's events** (see Tray): `tray.toggle` is followed like the page's own toggle, `tray.open` shows the first
  toggle's explanation (its button submits the tray's toggle), the tray's refusal as a toast (the tray never queues
  for the classic window) or the drift prompt. The page listens for them on the no-game screen too.

### Mods already in use

Item 1's prompts and messages (`prompts.js`; the pure parts tested in Node from `tests/test_mod_switch.py`). The
lists come from the last scan (`mods.entries`), so the prompts exist only with the scan consent; the messages of an
overwritten entry need none (the detail screen judges its files cheaply).

- **Mods Not in the Library** (`#prompt`): the `untracked` entries and the configured `changed` ones of every known
  install, every card ticked. A card: the entry's own install's picture (`spineBase(kind, core, id)`, so a card of
  another install never shows the current install's file of the same name), the variant's name, the kind chip (an
  alternate lobby core adds its suffix, "Memorial Lobby gl"), the install chip when more than one install is known,
  and "No Official Copy" on an overwritten entry; its details: File, Size, CRC state and Official Copy (Kept, Backup,
  Other Folder, No Official Copy). The footer counts the ticked cards and their size, the hint says they are lost to a
  game update or file check unless added. Add to Library (`mods.adopt`), with mods off also Add and Turn On Mods (then
  the toggle, with the first toggle's explanation), and Later (also the close button, the backdrop and Escape); Don't
  Ask Again dismisses the cards not added (`mods.dismiss untracked`). Damaged entries are listed apart, dim and never
  ticked, their Details giving the repair lines.
- **Mods Back to Official** (while mods are on): the `reset` and `updated` entries, every card ticked, with the install
  chip; entries still overwritten are listed apart ("Still overwritten: n", their Details the repair lines). Exactly
  two buttons (decision 16) and no way out but them (no close button; Escape and the backdrop do nothing): Apply Mod
  Configuration sends the ticked cards (`mods.restoreDrift`) and keeps the others as they are, Keep as Is keeps them
  all (`mods.dismiss drift`). Apply is greyed with the reason while the game runs or Steam is busy; while the classic
  UI is open it opens the classic modal. Its result is a toast, or a popup naming the failed entries and those skipped
  because their files changed since the scan ("Game files changed, check again").
- **When they show.** At the start (see Popups, "Start sequence"); after a later scan (the window back in front, the
  classic window closed, a game folder change) once no other popup is open, when the scan found entries the prompt
  has not shown in that state; after Settings' Check, with the dismissed entries again; and the drift prompt from the
  tray's Back to Official. Never while the game runs, Steam is busy or the classic UI is open.
- **Add First** (an overwritten entry whose mod is not in the library: no library source carries its non-official
  parts): Official File Overwritten, "No official copy left", "Add before any repair", Add to Library (adopts that
  entry) and Cancel. It names no repair: a repair would replace the only copy of the mod.
- **Overwritten** (once its mod is in the library): Official File Overwritten, "No official copy left" and the repair
  lines of its install (`repairs.js`): for an install in a Steam library Steam's verify (Properties - Installed Files -
  Verify integrity of game files), the settled repair; then, as another option and never promised, the game's own
  Restore Resources ("may not replace mods": whether it replaces a CRC-fixed mod is not verified); then "Then start
  this app again". The app never starts a repair (decision 9).

### Loading screen

`loading.js` draws the game's own loading screen: UILoading's black backdrop with nothing in the middle (the game
shows an illustration there; the tool does not) and UIRepeater in the bottom-right corner ("Now Loading", the
hopping dots and Arona turning round, animated in `app.css` from the keyframes of the clip `UIAni_Repeat 1`; its
UIAudioPlay is never played). Before asset consent and a ready UI cache, covers use neutral system text, a grey
background and no game layouts, sprites or fonts. The server selects the initial document's style from consent and
the current resource version's disk cache, so a cached launch is stylized before modules or RPC replies arrive.
`app.info.uiCached` reports the same cache state. A cold cache upgrades after consent and successful
UIRepeater decode; later covers always use the stylized indicator. While cached sprites decode, or if a later
sprite/decode fails, the bundled rounded font and blue/white palette preserve the breathing text and hopping dots. All web controls use accessible names and descriptions; none creates a hover tooltip.

- `scene(fn)` covers startup, roster/detail navigation, student steps and detail tabs: a fade to black (150 ms),
  then, while the work goes on, the indicator. It warns after 15 s and stays covered until preparation settles or
  navigation supersedes it; individual asset loaders have failure deadlines. The reveal fades out over 300 ms.
  `wait(promise)` shows the indicator alone over the screen after 300 ms (at least 500 ms) for other waits; its default
  cap is 15 s. One page overlay at a time: a newer call takes over the one on screen.
  `wait(promise, {label, cap})` names the wait for assistive technology (the classic UI's start: "Opening the classic
  UI") and stays up to `cap` instead (32 s for that start, which `app.openClassic` waits up to 30 s for).
- The detail screen resolves `show()` only when it is ready: the panels, the left side's first frame (the portrait,
  or the lobby with its still, or the 3D model with its shaders compiled), visible thumbnails and decoded UI images;
  the lobby's lines from Kivo get 1.5 s. A change inside the screen (a variant chip, the arrows, a tab, an
  applied portrait) renders every part off screen and swaps them in one frame. The left side loads laid out but
  transparent; old layers and stills are retired while covered, without a second fade during reveal.
- Writer tasks own a separate indicator and lifetime. Loading stays bottom-right in both styles; only the action
  label and x/n progress use the bottom-left corner.
- The start popups (the consent popup first) come after the first screen is revealed (Popups, "Start sequence").
- Startup phase durations are recorded in the session log and `app.timings`; see [the beta loading report](startup-loading.md).

### Pointer and touch effect

`cursor.js` gives the page the PC client's own pointer and the touch effect it shows on every press; `touch-fx.js`
simulates the effect (pure functions, tested in Node from `tests/test_touch_fx.py`). Both read their textures through
the light texture route (`gameassets` indexes the GLPC_Cursor, shared UI and EffectsFreezed texture bundles for them,
in `pointer-textures`); without a game the system cursor stays and there is no effect.

- **Pointer.** `ControllerMouse.SetPCCursorStyle` sets `PCIcon_MousePoint` (64 x 64; its MousePoint option chooses
  this or the system arrow) with `Cursor.SetCursor`, hotspot (0, 0) and `CursorMode.Auto`, which Windows shows at the
  system cursor size: here a 32 CSS px cursor with the texture as its 2x image (`image-set`, `-webkit-image-set` or a
  plain `url` by `CSS.supports`), set as `--cursor` and `--cursor-press` on the root. The game has no hover or pressed
  pointer, so buttons show it too; drag handles keep `grab` and `grabbing`, text fields the text cursor. `Cursor_1`
  (the halo crosshair, hotspot in its middle, a software cursor) is the controller's pointer and is not used.
- **Pointer in the window.** pywebview's `text_select=False` (its default) appends `body { user-select: none; cursor:
  default }` to the page after `app.css`, which left the game's pointer on the buttons only and the system arrow on
  everything else (the portrait, the lobby, the panels): the window is created with `text_select=True` and `app.css`
  turns off selection on `body` itself.
- **Window edges.** WebKit (WKWebView) drops a cursor image whose box would cross the window's right or bottom edge
  and shows the system arrow (`Style::Cursor::selectImageCursor`); Chromium (WebView2) takes any cursor up to 32 px.
  The image is cut to the texture's opaque part (23 x 31 CSS px), and smaller cuts follow in the list, 4 px apart:
  narrower for the right edge, shorter for the bottom, squares for the corner. WebKit shows the first that fits, so the
  pointer is cut at the edge, and only the last 3 px show the arrow. The images are object URLs, which keep the value
  short (every button resolves it).
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
  bright scene adds little, a soft veil over a dark one adds more. Each lobby player samples its atlas pages as sRGB
  and blends into an sRGB framebuffer (a lobby's skeletons all into the bottom player's, below), which is copied to
  the canvas, encoded again; slot colours reach each atlas page's shader (lobby.json layer `shaders`) as that shader
  takes them (`slot-colours.js`, read from the compiled vertex programs): spine-unity's `Spine/Skeleton` decodes them
  to linear with UnityCG's cubic fit of the sRGB curve (an additive slot at alpha 0.42 adds 0.15 of its texture), the
  game's own `Spine/Skeleton MX Standard`, on the pages of 97 lobbies, uses them as they are (0.42), and `Spine/Skeleton
  MX Portrait Noise` (CH0310's game screen) reads only their alpha.
  Without WebGL2 the player draws in plain sRGB values as before. Drawn in sRGB values, glows such as Kurumi's photo
  booth light or Niko's window washed the scene out to white.
- **Draw order** (`lobby-stage.js`, `skeleton-parts.js`). spine-unity gives each submesh of a skeleton the material
  of its atlas page, and Unity sorts every submesh and particle renderer by sorting order, render queue, then back to
  front, whichever renderer it belongs to. A skeleton whose pages sit in several queues (the scenery at 2900, the
  character at 3050) draws in one part per queue, and the parts of all of a lobby's skeletons and its effects draw in
  that one order: the other skeletons' players are made with the bottom player's WebGL context, which runs their
  frames and draws everything into its framebuffer. Three lobbies need it: their second skeleton, the intro's scene
  parked beside the lobby, has pages below and above the character's, and their effects sort between them (Wakamo's
  fire at 3000 under her at 3050, Yuuka (Track)'s dust at 2950 and Shigure's bokeh at 3002 under them). With one
  canvas per skeleton those effects drew over the character with the parked scene. Equal keys keep the prefab's
  stacking order (Unity breaks them by the distance from the camera to each renderer's bounds). A lobby whose bottom
  skeleton does not load draws each skeleton on its own canvas.
- **Post-processing.** The lobby is drawn by the PC client's main Camera (level1 `Persistent/Camera`: perspective,
  10-degree field of view, HDR), whose culling mask has the lobby's layer 12 and whose URP volume mask has layers 17
  and 30. Every lobby prefab carries global URP volumes on layer 30 (`PPV` at weight 1; `PPV_C`, a flash, and
  `PPV_D`, a depth of field, which talk timelines drive and which mostly sit at 0); four (Erika, Yoshimi, Shimiko,
  CH0356) keep them on the UI layer 5, which that camera never blends, so they have none. `lobby.py` follows the
  volumes that count to their profiles (in the core's bundles, a few in another core's) and blends them the way URP's
  VolumeManager does (`lobby.json` `post`). Of the 265 lobbies: chromatic aberration in 259, lift / gamma / gain in
  166, Panini projection in 190 (on the 10-degree view the middle is enlarged by 0.6 %) and, from a flash volume left
  a little on, colour adjustments in 17 (post exposure up to +0.53 EV for Aru, colour filter, contrast, hue). No
  lobby has bloom, vignette or tonemapping, and no depth of field or lens distortion is on at a weight above 0. The
  linear pass's copy to the canvas runs them as URP 12 does (Unity 2021.3; the URP asset grades in LDR with a
  32-step LUT; checked against PostProcessPass, UberPost, LutBuilderLdr and ColorUtils.PrepareLiftGammaGain): Panini,
  the three-sample chromatic aberration, then post exposure, the clamp to 0..1 and the LUT's steps (contrast in LogC,
  colour filter, lift / gamma / gain, hue, saturation), in linear light; the LUT's own 32-step interpolation is not
  modelled. A lobby's skeletons are post-processed together, once, as the camera's target is (7 lobbies have more
  than one).
  Panini and the aberration are placed in the game's screen (the camera's 16:9 view), not in the canvas: the left
  view and a zoomed or panned fullscreen view show them where the game draws them on the art, magnified with it.
  Placed in the canvas, Michiru's left view had a 7.7 px fringe at its left edge, near the middle of the game's
  screen, where the game has none, and a 2x zoom drew 7.7 px at its edge for the game's 1.9 px magnified. Past the
  game's view (zoomed out beyond it) the game shows nothing to match: both shifts keep the values of the nearest
  point of its edge instead of growing with the distance. Every lobby's Panini crops to fit, so neither reads past
  the game's view from inside it, as in the game.
- **PP setting.** The Settings L2D tab's `lobbyPost` (on by default) is the PC client's PP option
  (`AllowPostProcessing`, graphics options): off draws the lobby without its volumes, at once. Of the 19 in-game
  captures among the references, only Michiru's (CH0113) shows chromatic aberration, and it matches the lobby with
  PP on: at the survey's 400 px crop the colour edges are offset +1.0 / -1.0 / +0.8 / -1.1 px (top, bottom, left,
  right) in the game and +1.0 / -0.9 / +0.9 / -1.0 here, and her face is Y 157.7 in the game, 157.3 with PP, 145.0
  without. The other 18 show no offset at all, so they were taken with PP off, and they match the lobby with it off:
  mean |dY| 1.8 off, 3.6 on (CH0326 Y 198.4: 199.4 off, 205.8 on; CH0228 209.0: 209.0 and 213.2).
- **Particle effects** (`gameassets/particles.py`, `particles.js`, `particles-gl.js`). Nearly every lobby prefab
  carries Unity ParticleSystems: bokeh and dust over the scene, stars, petals, Michiru's sparkler. `lobby.json` lists
  them under `fx` with their modules, renderer, material and place, and the page simulates and draws them:
  - Place: a system under a SkeletonUtilityBone (Follow) moves with that bone of its skeleton, through the transforms
    below the bone; any other keeps its place in the prefab. Local simulation space moves the particles with it, world
    space leaves them behind. Unity world units are the UI root's (the 1665-unit view is 2 units high).
  - Simulated: duration, looping, prewarm (exactly one duration, in steps of 1/30 s), start delay, lifetime, speed,
    size and rotation (1D or 3D), colour, gravity, max particles, scaling mode, simulation speed, the ring buffer
    (pause until replaced holds a particle at the end of its life, loop until replaced plays its loop range again,
    both until max particles needs its place: ch0334's boosters, one particle a second, and the sea meshes of ch0188
    and ch0356, 35 systems in 8 lobbies, vanished after their lifetime without it); emission over time and bursts
    (cycles, intervals, probability; every loop fires its bursts, the first one right after a prewarm, also where
    frames of 1/60 s add up to a hair under the loop's end: missed before in 400 of the 1419 looping systems with
    bursts, Tsurugi's smoke and Izuna's flare empty for 5 and 7.5 s after opening); a frame in Unity's order: the
    particles whose life ends in it die first, then it emits into the places they freed, and a particle emitted within
    it moves only for the part after its emission time (the rate's at the times its count passes a whole number), so a
    particle lives its whole lifetime and a system at max particles replaces one in the frame it dies in, at any frame
    rate. A frame used to emit before its deaths and draw a new particle a frame old: hibiki_home's river surface and
    background glows (one particle each, 60 a second, living 1 and 5 s; ch0177 and ch0356 have the same river) went
    missing for a frame at every replacement, its bottom-left corner blinking dark once a second, and Utaha's star (one
    particle, two a second, living 1 s) was off a third of the time; 63 systems in 39 lobbies had such gaps (60 fps,
    4 x 120 s); emission over distance (particles per Unity world unit the system's origin moves: CH0292's
    headlights, 9 systems); the shapes sphere, hemisphere,
    cone, box (volume, shell, edge), circle, edge, rectangle and donut
    with arc, thickness and their own transform, the arc's and an edge's mode (an edge takes the radius's): loop and
    ping-pong over the system's time, snapped to the spread, and burst spread, the particles emitted together evenly
    (Hibiki's ten bokeh edges; CH0069's and CH0294's halos have a spread too, 0.12, and how burst spread takes it is
    neither in the game's data nor in its compiled code, so they are placed at random as before); velocity over
    lifetime (linear, orbital, radial, speed modifier),
    limit velocity (dampen), force, colour, size and rotation over lifetime, colour by speed (CH0318's dust), texture
    sheet animation (start frame and
    frame over time as fractions of the sheet), custom data, birth and death sub-emitters and trails in particle mode
    (CH0172's oil drops: a point every minimum vertex distance, living the lifetime's share of the particle's life, a
    particle that stays put until all of them have gone starting again where it is). Systems below GameObjects a
    SpineEventToggleObjects lists (CH0217's fish and bubbles, 13 systems) play while the skeleton's EnableObject and
    DisableObject events have them on, from their start as GameObject.SetActive starts them. Curves are evaluated as
    Unity's are, a segment with a Constant (infinite) tangent holding its left key's value: the water drops of
    misaki_home and ch0095_home keep still, then jump between speeds. Billboards (view or
    local alignment, max size a fraction of the game's view height), stretched billboards and meshes (the particle
    colour times the mesh's vertex colours: ch0188's sea meshes fade out at their ends by them; each particle draws
    one of its renderer's meshes, up to four, picked uniformly at random or by their weights: the four rain streaks
    of misaki_home and ch0095_home and the two confetti triangles of five *_multi lobbies, 17 renderers in 7 lobbies).
  - Drawn: the game's DSFX shaders ported from their compiled programs (Additive, AlphaBlend, AlphaBlend_Add, the
    Mask, Distort, Step, Step_MXChar and Step_Distort variants, AlphaBlend_Add_Distort_1a and
    AlphaBlend_Add_Double_Distort_1a, AlphaBlend_2_Roz, AlwaysView_Add, Matcap with the meshes' normals, General
    Unlit VertexColor) with each material's blend, in linear
    light: textures sampled as sRGB where the game imports them so, vertex colours as 8-bit sRGB decoded (as stored
    where the renderer's Apply Active Color Space is off: 116 systems in 30 lobbies, Nodoka's star and meteors,
    Michiru's fireworks), Color properties decoded (above 1 by a 2.2 power), Vector properties as stored. Particles
    sorted by distance or by depth (CH0069, CH0294, CH0172) draw the farthest first. Each system draws after the
    skeleton part it sorts after (sorting layer, its value: the game's one layer besides Default stores 2, 7 systems in
    5 lobbies over every skeleton; then sorting order, render queue and back to front with its sorting fudge; see Draw
    order), or before the first one; its trails are a second submesh with the renderer's second material, sorted by
    that one's queue (CH0172's dirt trails at 2950 under her page, the drops at 3100 over it). The textures come from
    the game files on request and stay in memory.
  - The two *_1a shaders (ch0188's and ch0356's water splashes, ch0334's boosters) are UV distortions like Distort:
    their one pass samples only their own main, mask and distortion textures (no grab pass, no camera opaque
    texture), so nothing behind them is read. They also port their vertex programs, which route the particle's
    custom data into each UV through the material's CustomData_* selector vectors (which components of custom data
    1 and 2 add to a UV's tiling and offset, and to the distortion power); the Double variant takes two distortions
    from the red and green channels of one texture, each with its own tiling, scroll and power, and its keywords
    (_Tex_Main_Distort, _Tex_Mask_Distort: Off, R, G, RG) say which shift the main and the mask UV.
  - Not reproduced: noise, collision, lights, inherit velocity, size and rotation by speed (no system a lobby draws
    uses them); limit velocity's drag (CH0318's dust, too slow for it to tell); Animators and scripts that move or
    switch systems during a talk (a system plays as the prefab leaves it; the mesh renderers' Animators, the Spine
    event toggles and the intro's timeline are played); mesh and sprite emitter
    shapes (emitted from the shape's origin); the materials' culling (most DSFX materials cull back faces: in Unity a
    locally aligned billboard or a mesh turned away from the camera is not drawn; here every face is, as the
    mirrored transforms of ch0058's splashes and ch0334's stretched sparks would need Unity's own handling first). The
    framebuffer holds 8 bits per channel, so light that adds up past white is clipped at once (the game clips the sum
    at the end; the same result for purely additive light).
  - Cost: about 0.2 ms of main-thread time a frame for a typical lobby, 0.6 ms for the busiest (about 300 particles);
    the *_1a systems add 0.1 to 0.3 ms (ch0188's eleven splashes, ch0334's eight booster meshes);
    the first frame compiles each shader once. Everything is freed with the lobby (`particles-gl.js` detach and
    dispose), and made again on the next frame once a lost WebGL context is restored (a restorable of each player's
    context, as linear.js has). Without WebGL2 nothing is drawn.
- **Mesh effects** (`gameassets/meshfx.py`, `mesh-fx.js`). Nine prefabs carry plain MeshRenderers with effect shaders:
  lens dirt and light quads (FX/FX_SHADER_Lobby_Order, One One: the texture times `_Color0` and the vertex colour,
  ported from its compiled program; DSFX/FX_SHADER_Additive_0) in Akane's, Eimi's, Karin's, Shiroko's, Sumire's and
  Shun's lobbies, Hanako's water surface, Maki's drifting dust and Utaha's window glow
  (DSFX/FX_SHADER_AlphaBlend_Add_Distort_0), 20 renderers. All but Hanako's mesh are Unity's built-in Quad (unity
  default resources, path id 10210; its vertices, UVs and triangles are built in), white where a mesh has no vertex
  colours and as stored where it has them (Unity converts no mesh colours to linear light, and the three programs pass
  COLOR0 on unchanged). They are placed like the particle systems (on the bone of a SkeletonUtilityBone in Follow mode,
  through the transforms below it, or on the bone itself for one on the bone's own GameObject; else from the prefab
  root), sorted with them and the skeletons' atlas pages (Akane's lens dirt at 2950 over her page at 2800, the light
  shafts at 3100), and drawn by `particles-gl.js` with the particle programs. Back faces are culled as the material
  says, front faces being clockwise on screen and a mirrored transform turning that round, as Unity does. Four lobbies
  loop them with an Animator: the controller's default state plays one clip (`fx.clips`, sampled at its own rate and
  looped), which scales, moves and turns the quads (Euler curves in their rotation order) and animates their materials'
  colours: a Color channel (`.r`, bit 30 of the binding's attribute set) is converted to linear light like the
  material's colours, a Vector channel (`.x`, as Shiroko's lens dirt animates its `_Color0`) is not.
- **Skeleton materials** (`gameassets/spine_materials.py`, `skeleton-materials.js`). spine-unity draws each submesh
  with its atlas page's material, so a page's shader decides how its slots draw, whatever their blend mode:
  - Aru's third page uses Spine/Blend Modes/Skeleton PMA Multiply (Blend DstColor OneMinusSrcAlpha): its Normal
    slots multiply. Hina's multiply light takes the same shader from her blend mode materials.
  - CH0319's, CH0326's and CH0355's water and river pages use Spine/Skeleton MX Standard - NoiseFlowAnimation: the
    page's UV shifts by (2 noise - 1) x `_PixelNoisePower` x 0.001 x the vertex alpha, the noise scrolling at
    `_PixelNoiseSpeed`, inside a square of a plane taken from the vertex position (less `_CenterX` / `Y` in Unity
    units, times 0.01, turned by `_Rotate`, skewed and bent toward a vanishing line by `_SlopeForward` and
    `_SlopeSide`), the vertex colour as stored (no conversion to linear light).
  - CH0310's game screen (its intro only) uses Spine/Skeleton MX Portrait Noise: two passes draw alternate horizontal
    bands of the game's screen (sin(v x 900 + time) at or above 0, at or below), each shifted by `_GlitchOffset`
    of the camera's clip space on the frames a hash of the time passes `_GlitchFreq` (about one in fifty), the page
    times 0.72 x a scrolling scan line texture plus `_PortraitNoiseTint`.
  - Slot blend modes reach the screen only through materials: with `requiresBlendModeMaterials` set,
    BlendModeMaterials gives Multiply and Screen slots (Additive ones with `applyAdditiveMaterial`) the replacement
    material listed for their page; without it (all but 4 of the lobbies' 288 skeleton data assets) they keep their page's material and
    draw as Normal. ch0163's light_01, Hiyori's R_eye_ligth_02 and airi0's FX_Light_01 (airi0_home's LobbyAiri
    prefab names airi_home's skeleton data, which has none) drew as Screen; spine-player's Screen on straight alpha
    textures also ignored their alpha (a hard-edged patch over Hiyori's iris). A page that a mode's list does not
    name gets no replacement material (the list is matched by page name), as an entry left empty does; both draw as
    spine-player draws. An Additive slot always adds (its premultiplied vertex colour has alpha 0).
  - The dark colour (two-colour tint) is never drawn: `tintBlack` is off in every lobby's SkeletonAnimation and no
    lobby page shader reads it (their vertex programs take position, UV and one colour). CH0205's wing and Neru's
    halo key one, black.
  The ported programs are taken from their D3D11 bytecode and run in spine-player's batch: a draw switches to the
  page's program and blend (flushing the batch), feeding it the game's vertex colour (premultiplied, alpha 0 for an
  additive slot) from linear.js's tinted one.
- **Pinned bones** (`gameassets/pins.py`, `skeleton-pins.js`). A SkeletonUtilityBone in Override mode sets its bone
  from its GameObject after the animation, every frame. The drag targets (lobby-touch.js) are such bones; two others
  nothing moves, so the bone stays where the prefab put it: Hihumi's Hip at (218.8, 650.9), 12.7 units below the
  skeleton's own (its driver, SpineCharacterGyro, is switched off and rests there too), and with it her whole scene;
  CH0242's cheek_02, whose PinchEnd_01_M keys only what the pin leaves alone. The zoom-out limits and the head-pat
  point are measured with the pins.
- **Intro scenes.** Three prefabs keep four skeletons of their intro timeline (a PlayableDirector with Spine Animation
  State tracks) parked beside the scene: Shigure's Shigure_00 and Shigure_01 at x -4500 and 4500, CH0184_00 and
  Wakamo_Scene_0. Their clip assets are on track -1 (only the timeline plays them). Shigure's timeline (an Animation
  track on `Shigure`) puts Shigure_00 at x 0 until 5 s, Shigure_01 until 9.17 s, then Shigure_home, each scene back
  at its place after, and spine-unity sets a Spine track empty when its clip ends (`dontEndWithClip` off), so the
  scenes rest in their setup pose, out of the game's view. The lobby never loops an intro (`idleOf`): a skeleton
  with intros only rests in its setup pose, one with a Dummy loops that. Looped, Shigure_00's Start_Idle_00 drew its
  train (`train Sample`) across the bottom of the view, over Shigure, every 6 s.
- **Clip endings** (SpineBase `PlayMasked`, `QueueTrackClose`, `EnqueueSpineClip`, `EnqueueMasked`). A clip that
  does not loop and has FinishMode 2 fades its track out: with UseDefaultOutroMix over the skeleton's default mix,
  ending with the clip; otherwise over its OutroMix, starting OutroStartOffset after the clip's end (`clips.*.outroAt`),
  so a talk's last frame holds while it fades (0.3 to 0.6 s for most). FinishMode 3 queues the next clip the same way
  (its intro mix ending with the clip, or starting at its end).
- **Idle clips** (`lobby-sync.js`; the rules read from GameAssembly.dll: SpineBase `PlayBaseClip`, `PlaySpineClip`,
  `CoPlayMaskedRandomTiming`, `ResetRandomizedDelayWithDuration`, `AddRandomCountLoop`, `EnqueueRandomTiming`,
  `ReturnToIdleWithSpineClips`, `PlaySyncClipsIfNotPlaying`, `StopAllMasks`; the enums' values from
  `global-metadata.dat`). A SpineCharacter starts every clip of its idle pool, each on its own track, and each with
  its sync clips (`lobby.json` `idles`, `clips.*.sync`). A clip's PlayMode says how: 0 the base track and 1 masked
  play at once, 3 is a random idle clip (played by the random idle schedule only), 2 masked at random times: it waits
  (RandomTimingIntroDelayMode 0: not at all, 1: RandomDelayMin to Max, 2: IntroDelayDuration plus that), plays once
  on its track, at full weight on an empty track and mixing in from its own last frame after that (its intro mix),
  plus AddRandomLoopMin to Max extra plays queued one duration apart; a looping one then waits again, from that start,
  its playing time plus RandomDelayMin to Max; between plays the track holds the last frame, nothing fades it out.
  The clock is the skeleton's own animation time. A dialogue keeps them: the game returns the character to its idle
  at the start and the end of one keeping the idle's clips, and starts again only the wait of a random-timing clip
  that has not played yet (its track still empty); a drag stops every other track (`StopAllMasks(false)`) but keeps
  them too. They are part of the clips the zoom-out limits are measured over (on their track over the idle, on every
  layer). 19 lobbies: Shigure's Train_00_R (track 3, 3 s plus 10 to 15 s, then 6.67 s plus 10 to 15 s; the
  `train` slot, draw index 141, passes behind the bridge and Shigure from the top right, and a light flashes over the
  right side), Hoshino's background (Start_WhaleMove_01_R at once, 30.6 s, then WhaleMove_01_R, 56.7 s, every 3 to 4 s
  after the last), Seia's butterflies (both lobbies, 5 to 10 s apart), Kayoko (New Year) snow, Serina (Christmas) and
  Saki (Swimsuit) backgrounds, Nagusa's petals and clouds, Takane's aurora and breath (2 s plus 8 to 10 s), Hare
  (Camp)'s three shooting stars (6 s plus 20 to 30, 8 to 15 and 15 to 22 s), Pina (Guide)'s petals, Sumire
  (Part-Timer)'s and Hasumi (Swimsuit)'s sweat (10 s plus 25 to 30 and 15 to 20 s), Michiru (Dress)'s petals, Reisa
  (Magical)'s leaves, Yuzu (Armed)'s background and clouds (0 to 3 s apart), Kisaki (Swimsuit)'s fog, Erika's and
  Juri's clouds; the others without a wait loop back to back. Not reproduced: a random-timing clip's next clip
  (FinishMode 3 on a one-shot, which no lobby has).
- **Clip sounds.** A clip's SoundKeys (`clips.*.sounds`: time, event) play when its track entry's animation time
  reaches them, every loop on a looping entry, and no more once the entry is interrupted, ends or completes
  (`EnqueueSoundKeys`, `CoPlaySoundKeys`); 40 clips have them, 37 talks of 15 lobbies (cloth, leather, swings),
  Shigure's train (`SFX_Spine_Subway` at 3.1 s) and Hoshino's whale. Every event is an AnimationAudioEvent of the
  lobbies' shared bundle (`lobby.json` `sounds`): one of its AudioClips at random, at its volume, and at its pitch
  when that is above 0 (as a playback rate, the pitch going with it; 8 of the 32 events have a negative one, which
  the game never sets on the source). The clip is decoded from the game's audio bundle in memory (UnityPy's FMOD, `sfx_<id>.wav`), fetched
  once a clip with sound keys starts and kept as a blob for the lobby. They follow the voice volume and mute (the
  game's SFX slider has no counterpart yet), and `--mute` silences them. Not reproduced: a lobby's ambient loop
  (SpineBase `ambientEvent`, AmbientAudioPlayer).
- **Zoom.** Fullscreen opens on the game's 16:9 view and zooms in to 2x. How far it zooms out is the Settings L2D
  tab's zoom-out row (`settings.set lobbyZoom` and `lobbyZoomCustom`; `lobby_zoom` and `lobby_zoom_custom` in
  `webui.json`, where the boolean `lobby_zoom_out` it replaces still reads as Full Art or Game View; Full Art when
  nothing is stored); panning stays inside the same limit, and no limit goes past 4 game views across:
  - *Game View*: the game's view, never wider.
  - *Full Art* (the default): the widest 16:9 view inside the painted art (one 16-unit cell inside the painted rect). The painted
    rect is found on idle poses; the poses of every clip the lobby plays (dialogues with their sync clips, the drag
    clips and their ends, random idle clips, every 0.1 s over the idle) are checked in the background, in 8 ms
    slices, within 24 cells of its sides, and the rect gives up what one uncovers: a dialogue that moves the scene
    never shows a blank edge. Over the 265 lobbies (headless SwiftShader) it takes 780 poses and 0.55 s of slices at
    the median (2.2 s at most); 34 lobbies give up cells, most one, Kurumi three (Talk_07_M scales her scene down),
    Serika's CH0189 up to six (the end of every dialogue) and CH0303 up to four (a random idle clip).
  - *Unlocked*: the box of the art the idle poses paint (the same opaque art) joined to the scene across gaps of at
    most two cells, widened by what the clips paint (the same pass) up to 24 cells past it; parts parked away from
    the scene are left out (Toki's close-up head to the right, Miku's second stage set to the left), and a dialogue
    that moves or scales the whole scene (CH0243, Airi's CH0251) does not open the limit to its whole path. Kurumi
    1.41 game views across (Full Art 1.23), Toki 1.58 (1.27), Miku 1.44 (1.17); over the 265 lobbies 1.20 at the
    median (Full Art 1.16), 1.59 at the 90th percentile and 2.41 at most (CH0356's waterfall), 63 within 0.02 of Full
    Art. The art is looked for within three game views around the game's view (14 lobbies reach that edge). The pass
    costs 10 to 30 % more with it (Kurumi 0.78 to 0.90 s, Toki 0.82 to 1.06 s).
  - *Custom*: 1.0 to 4.0 game views across (0.1 steps, a slider row under the option), around the game's view.

  Past the painted art (Unlocked, Custom) the lobby shows black: what the game's lobby camera clears to (level1
  `Persistent/Camera`, solid colour, black). With PP on, the grade runs over that black as over the art: the bottom
  layer is drawn over it before grading, so the art's alpha edges blend into it in linear light too. 7 lobbies lift
  it above black (ch0082 60/255 grey, ch0259 45, ch0058 40, ch0222 a dark blue). Without WebGL2 the page shows black
  there. Sparse art (a mod) keeps the blurred edge extension. The measurements are kept for the session.
- **Input.** Press and drag: head pat, eye follow and the other drag boxes. Mouse wheel (a notch zooms at least a
  line's worth) and pinch (ctrl + wheel in Chromium / WebView2, gesture events in WebKit) zoom at the pointer; a
  two-finger trackpad swipe pans in any direction. A wheel is told by its steps: whole lines, `wheelDeltaY` in steps
  of 120 (Chromium), or in WebKit, whose `wheelDeltaY` is 3 x `deltaY` for every device, tenths of a line kept in
  16.16 fixed point (4.000244 px) against a trackpad's whole pixels. One scroll keeps the kind of its first event; one
  taken for a wheel that then sends a trackpad step goes back to the view it started from and pans (a WebKit whole
  line, or a Chromium notch: a Windows touchpad's first step can be exactly 100 px, wheelDelta 120). A Magic Mouse
  scrolls like a trackpad (ctrl + scroll zooms). A right- or middle-button drag pans. Native drags and the Force
  Touch look-up are turned off on the lobby.
- **Input trace.** Started with `--debug`, the page sends the fullscreen lobby's pointer, wheel and gesture events
  (moves and scrolls at most every 50 ms) and every press anywhere in the document, with its target, through
  `debug.trace`, so a trackpad problem can be reproduced once and the log sent.

## Classic window

The bottom-bar entries without a web screen (greyed, through the hand-off prompt: Front end, "Bottom navigation"), and
Settings' More Settings, hand over to the classic Tk GUI (`webui/classic.py`, its child side in `gui/control.py`). It
runs in a process of its own on both systems: Tk (Aqua) and pywebview (Cocoa) both need the main thread on macOS, and a
crash in a classic tab never takes the web UI with it.

- **One window per data directory.** `ClassicWindow.open(tab, may_start)` (`app.openClassic`) starts the program again
  (`system.classic_command(tab, control=True)`: `--classic --control`, then `--tab <name>` or `--settings`) and waits
  up to 30 s for its `ready`; an exit or silence before that is `classic_failed {exit_code}` (`null` when it stayed
  silent; a late `ready` is still taken, and the window then shows itself). With a window open, a click sends the tab
  and a raise; while a classic task runs (`busy`), only the raise, so a running task's tab is never switched. A window
  left by an earlier instance (below) is only raised. No window starts while a job writing the game folder is queued
  or running (`busy`): that job would stop at its next write with `classic_open`, a toggle half done. The busy check
  (`may_start`) and child registration share `ClassicWindow.starting()` with each game writer's classic check and
  job submission: either the writer is pending first and the new window is refused with `busy`, or the child is
  registered first and the writer is checked against the open window before submission. The lock is released before
  waiting for `ready`; raising this instance's window or an orphan never runs `may_start`.
- **The channel** is the web UI's own HTTP server, not stdio (the Windows build is onefile without a console):
  `BAMT_CLASSIC_URL` (the server's origin) and `BAMT_CLASSIC_TOKEN` (one-time, random) go to the child, which takes
  them out of its environment at once. It long-polls `GET /api/classic/control` (25 s) for its lines (`place x y w h`,
  `raise`, `tab <name>`, `settings`; anything else is ignored) and posts `POST /api/classic/report`
  (`{"type": "ready", pid, hwnd, exe}`, `{"type": "shown", tab}`, `{"type": "busy", n}`). Both take the child's token
  in `X-BAMT-Classic` and never the session token, and the WSGI app routes `/api/classic/*` to `ClassicWindow.wsgi`
  after its Host check. A daemon thread polls; the Tk thread drains the lines with `root.after(100)`. When the web UI
  quits, the polls are refused, and the classic window stays open on its own.
- **Placement.** The child starts transparent (`-alpha 0`). After `ready` the parent places it, hands the foreground
  over, then sends `raise` (always in that order): centred on the BAMT window, inside the work area of the screen that
  holds BAMT's centre, and shrunk to fit (the classic window is a fixed 800 x 1000). On macOS the parent reads the
  `NSWindow` frame and the screens' visible frames on the main thread, flips them against the primary screen and sends
  `place` in Tk's coordinates (the title bar fits too); then `yieldActivationToApplication:` (macOS 14) or an
  activation ignoring other apps. On Windows it scales the logical size by the monitor's DPI and moves the child's
  window itself (`SetWindowPos` on the `hwnd` from `ready`; `AllowSetForegroundWindow(ASFW_ANY)` before the raise).
  The raise shows the window, keeps it on top for 300 ms and focuses it; the user can bring BAMT back over it. With
  no raise 5 s after `ready`, the child shows itself.
- **Busy.** `TabFrame.run_in_thread` and `StoppableDialog.set_task_running` count the running tasks
  (`gui/control.py busy`); each new count is reported.
- **Output.** The child's stdout and stderr go to `classic.log` in the data directory (rewritten at each start,
  unbuffered, UTF-8), never to an unread pipe.
- **Exit.** A watcher thread waits for the process and publishes `classic.closed {code}`. Should the Windows onefile
  launcher return before the window it unpacked, the pid the child reported is followed until it ends or stops
  polling for 60 s.
- **`classic.json`** (`<data dir>/classic.json`, `{pid, exe, hwnd, created}`) names the open window, so an instance
  started later still refuses game-folder writes and can raise it. It is written at `ready` and removed with
  `classic.closed`, and by the child at its exit. `created` is the creation time the system reports, as an integer:
  `GetProcessTimes` on Windows (FILETIME, 100 ns), `proc_pidinfo`'s `pbi_start_tvsec` on macOS (seconds), else
  `ps -o lstart=` under `LC_ALL=C TZ=UTC0`, parsed with a fixed English table, which gives the same number whatever
  the caller's locale and time zone; `/proc/<pid>/stat` on Linux. `find_classic()` takes the pid only while it is
  alive with that creation time (a reused pid has a later one), runs this program's classic GUI (the exe name on
  Windows, `--classic` in its arguments elsewhere) and is neither this process nor its parent; any other file is
  stale and removed, so it never blocks writes. `ClassicWindow.orphan()` is that reader for a window this instance
  did not start (GameWatch's `find_classic`).
- **Events.** `classic.opened {pid}` (process started), `classic.ready {pid, tab}` (window up, or a tab shown),
  `classic.closed {code}`. `ClassicWindow.status()` gives `{open, ready, busy, pid, orphan}`.
- **The queue** (`ClassicQueue`, decision 5). While a classic window is open the web UI does not write the game
  folder; the classic modal can queue the refused write for when it closes. In memory only: quitting drops it. At
  most one toggle (a later one replaces it, one back to the stored intent removes it) and one action per entry (the
  latest wins; a `mods.restoreDrift` over several entries is narrowed to the others). Each item keeps its call, the
  pins and the size and modification time of its entries' files. `run(host)`, after `classic.closed` and the scan
  that follows it, submits each item as its normal job, in order, and lists the dropped ones: a toggle whose `expect`
  is no longer the stored intent (`state_changed`) or whose pins are not the known installs (`folder_changed`); an
  entry whose own install changed, or is no longer the current one for `actions.apply` and `actions.restore`
  (`folder_changed`), or whose files changed (`entry_changed`); a refused submit with its own error; an item that
  cannot be checked (a toggle's stored intent under unreadable mod settings) with that error (`profiles_unreadable`).

## Tray

The tray icon (Windows) or menu bar icon (macOS) of the app window (`webui/tray.py`), shown while the preference
`tray` is on (Settings' Mods tab, `settings.set tray`; off by default). `settings.get` and `mods.state` say
`traySupported` only in the app window on those two systems. Closing the window quits the app, and the icon goes with
it (decision 7); browser and serve mode have none.

- **The menu**, rebuilt from the last `mods.state` each time it opens (`tray_menu(snapshot, strings)`, pure):
  - **Enable Mods**, one item for every known install, with no install name (decision 1), checked while mods are on.
    Greyed, it has a second, disabled line: the `reason` (`error.game_running`, `error.game_status_unavailable`,
    `error.steam_busy`, `error.classic_open`, `error.game_not_found`, `error.profiles_unreadable`), else, while a
    toggle runs or writes wait for the classic window, `tray.working` (Working 12/40) or `job.running`. The tray never
    queues for the classic window.
  - **Back to Official: n** (`tray.drift`) while the last scan found drift (with scan consent).
  - A separator, **Open** (`settings.classic.open`) and **Quit** (`tray.quit`).
- **Clicks.** macOS: either click opens the menu. Windows: a left click (or double click) opens the window, a right
  click the menu; Open is in bold.
- **Tooltip**: the app title, then Mods on or Mods off (`mods.onState`, `mods.offState`), or Working 12/40 while a
  toggle runs.
- **Enable Mods** submits `mods.toggle {enabled: !enabled, expect: enabled}` at once, an Off adopting first like every
  Off (decision 4). The window comes to the front instead on the first toggle ever (`explained` false: the
  explanation, whose button toggles), and afterwards on a refusal (`not_enough_space` included) or a result with
  failed, stuck or left entries. **Back to Official** opens the window on the drift prompt. **Quit** follows
  `app.quit`; while a writer job runs, the window comes to the front with the busy toast (`app.busy`).
- **What the page is told:**

  | Event | Data | The page |
  |---|---|---|
  | `tray.toggle` | `{job, enabled, expect}` | follows the job as its own toggle (`waitJob`): progress, end toast, result popup |
  | `tray.open` | `{view: "explain", enabled, expect}` | shows the first toggle's explanation; its button submits `mods.toggle {enabled, expect}` |
  | `tray.open` | `{view: "error", code, params}` | shows the refusal as for its own toggle |
  | `tray.open` | `{view: "drift"}` | opens the drift prompt |

- **Never blocking the UI thread.** The menu and the tooltip read only the last `mods.state` the tray kept: it
  observes the event bus (`EventBus.observe`, called on the publishing thread and not counted as a page, so the game
  watch's fast polling still follows pages and the shown icon only). Opening the menu pokes the game watch, whose
  answer the next opening shows. Every click runs on a thread of its own: submitting the toggle may build the library.
- **macOS** (`CocoaTray`). An `NSStatusItem` on pywebview's own `NSApplication` loop (PyObjC comes with pywebview),
  made, changed and removed on the main thread only (`AppHelper.callAfter`); `menuNeedsUpdate:` rebuilds the `NSMenu`.
  The image is `assets/tray/menubar.pdf`, a vector template image of 18 pt that the menu bar tints for light, dark and
  highlighted bars, with `menubar@2x.png` (36 px) as the fallback. It is removed on the main thread once
  `webview.start` returns. rumps and pystray are not used: each runs a loop of its own.
- **Windows** (`WinFormsTray`). A `NotifyIcon` and its `ContextMenuStrip` made on pywebview's WinForms thread
  (`window.native.Invoke`), else on an STA thread with its own `ApplicationContext`; the strip's `Opening` rebuilds
  the items. `tray.ico` is loaded at the small icon size (`SystemInformation.SmallIconSize`), so Windows takes the
  frame drawn for the display scale. The icon is hidden and disposed of when the form closes, so Windows keeps no dead
  icon. Windows 11 puts a new icon in the overflow until the user pins it.
- **The icons** (`assets/tray`, the project's own art from `assets/eligma.png`, never a game asset). `menubar.svg`
  (18 x 18 pt, black on transparent: the gem's hexagon as a 1.6 pt band and its four-point star 1.5 pt clear of it,
  nothing thinner than 1.5 pt) and `tray.svg` (the colour icon: the hexagon in the gem's pink and the white star, 2
  px clear of the edge at 16 px) are the sources. `scripts/tray_icons.py` builds `menubar.pdf`, `menubar@2x.png` and
  `tray.ico` (32-bit frames rendered for 16, 20, 24 and 32 px) with Pillow only; `--check` reports built files that
  no longer match their SVGs (also a test), and `--preview sheet.png` renders the menu bar icon at 16, 18 and 22 pt,
  1x and 2x, on a light and a dark menu bar (through AppKit on macOS) and the tray frames on a light and a dark
  taskbar. The build scripts need no change: `assets/` is already included.

## Tests

- `config`, `catalog` and `library` with fixtures and temporary folders (`library`: a fake game folder of
  header-only bundles; its end-to-end checks copy a few real bundles into a temporary folder, never writing into the
  install).
- `gameassets` and end-to-end checks against a real install; skipped unless one is found (`BAMT_TEST_GAME_DIR`, or
  `game_paths.find_game_dirs`).
- `webui` through its WSGI app, without a window; the tray's menu and controller with fake services, never with a
  status item or a `NotifyIcon`.
- The front end's pure parts in Node (`tests/js/*.test.mjs`, each run from its `tests/test_*.py`), the shared popups,
  the Enable Mods switch, item 1's prompts and the tray's events on a stand-in DOM with the en-US strings
  (`mod_switch.test.mjs`, `repairs.test.mjs`, `spine_base.test.mjs` among them).

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
