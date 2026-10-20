# Beta startup and transition report

The two loading styles belong to one web cover. The plain indicator is the fallback while the game UI indexes,
UIRepeater layout and images are being prepared (`web/js/loading.js:169`). The game-styled indicator replaces it
inside that cover. Native window initialization and server startup happen before the page can display either.
The native window now uses the same black background as the cover.

No app launch or user data was used for this work. Real cold/warm startup durations and a speedup percentage remain
unmeasured. The phase timers below record them during the owner's isolated dev run, in the session log exposed by
Settings' Log and through `app.timings`. Durations use seconds; each snapshot entry includes a count and accumulated
elapsed time. Concurrent and nested phases overlap, so their durations must not be summed into a launch total.

| Work | Timing keys | Placement |
| --- | --- | --- |
| Settings and install detection | `settings.load-detect`, `settings.ui-state`, `game.detect`, `game.resource-version` | Before/while preparing the page; each region is detected at most once per settings load |
| HTTP server setup and start | `server.build`, `server.start` | Before opening the window |
| pywebview import, window creation, renderer and document | `native.import`, `native.create-window`, `native.initialize`, `native.document` | Before/through page loading; renderer/document durations start at the GUI loop |
| Library/catalog open | `library.open`, `catalog.open` | Required for roster/mod state |
| Library prune and file scan | `library.prune`, `scan.prune-wait`, `scan.files` | After first reveal; startup file checks can be disabled |
| Atlas/texture indexes and UI layouts | `ui.atlases`, `ui.textures`, `ui.layouts`, `page.ui-indexes` | Required assets during preparation; cached light assets require consent |
| Fonts and translated strings | `page.fonts`, `page.strings` | Before first reveal; font timing measures the browser's remaining readiness wait |
| Roster/detail data and first screen | `roster.data`, `detail.data`, `page.mod-state`, `page.first-screen` | Includes visible portrait readiness, image decoding and the route's reveal |
| Page RPCs and total boot | `page.settings`, `page.info`, `page.boot` | Settings/info overlap; UI indexes overlap strings/fonts |
| Plain and game-styled cover | `page.plain-loading`, `page.styled-loading` | From JS cover adoption to completed reveal; excludes native startup and initial module loading |

The deterministic loading harness verifies a 0.200 s plain portion and a 1.000 s styled portion, including reveal.
These are simulated clock intervals validating the instrumentation, not measured application performance.

Root causes and changes:

- `web/js/roster.js:320`: visible row rendering previously gave up after 250 ms, and decoding after 1 s. Portraits
  could arrive individually after reveal. Visible rows now retain readiness promises, finish before overscan is
  queued and wait for decoding. Returning to the list uses the same cover (`web/js/main.js:212`).
- `web/js/detail.js:114` and `web/js/detail.js:1370`: preview/thumbnail soft caps previously released the screen
  after 1.2 s. Panels, backgrounds and players could commit at different times. Routes and tab changes now stay
  covered until first frames, visible thumbnails and decoded backgrounds settle, then commit together. Old preview
  layers are removed under the cover; timed-out portraits are cancelled to prevent a late pop-in. Per-asset errors
  settle with the existing placeholders/errors; `web/js/loading.js:195` warns at 15 s without revealing unfinished
  work. New navigation still takes over, and the input hold and serialized Spine loader remain in use.
- `webui/services.py:941`: startup maintenance previously began alongside initial roster requests, competing for
  library locks and asset reads. It now waits for `app.ready`. Settings can disable startup file checks and update
  checks separately; manual checks remain available. Disabling file checks also skips startup scan prompts/waits.
- `web/js/main.js:279`, `web/js/detail.js:1690`, `config.py:158`: startup RPCs/index work now overlap, detection is
  reused within a settings load, and detail rendering reuses NGUI's texture index. Cursor assets, popup preparation
  and visual-mode layouts are deferred until after first reveal or first use. Existing in-memory image/layout and
  versioned consent-controlled light-asset caches are retained; portraits, lobbies and generated thumbnails remain
  memory-only, and heavy HTTP responses retain `no-store`.
- `web/css/app.css:343`: writer-progress CSS previously moved Loading to the left. Those overrides are removed;
  Loading stays bottom-right and action progress alone stays bottom-left.

Added locale keys, in all five locale files (shown with their RPC/UI keys):

| Key | en-US | zh-CN |
| --- | --- | --- |
| `settings.update.startup` | Check for Updates at Startup | 启动时检查更新 |
| `settings.mods.scan` | Check Game Files | 检查游戏文件 |

The file check control now combines scan consent and startup checks as Off / Manual / At Startup; see
`docs/web-ui.md`, Enable Mods switch.

Validation:

- `node --test tests/js/*.test.mjs`: 463 passed, 0 failed.
- Required Python suite: 1312 passed, 122 skipped, 0 failed; one existing locale deprecation warning.
- Added coverage for visible-row readiness/reuse, initial detail readiness/decoding, student navigation, Back during
  an unfinished request, tab covers, slow/cancelled scenes, loading placement, startup preferences/deferral and timers.

Owner verification still needed: real cold/warm phase durations with consent both off/on, native startup appearance,
WebKit hidden-image re-decoding, GPU/Spine first frames and the visual continuity of student and lobby transitions.
The skipped Python tests and rendered game assets were not exercised by an app launch here.
