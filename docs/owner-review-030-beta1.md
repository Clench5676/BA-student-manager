# 0.3.0-beta.1 owner review

Based on `d36ae82`, with no application version change. The worktree index cannot
be locked in this sandbox. Commits were therefore made in an isolated Git directory
and delivered in `/tmp/v030g.bundle`, under `refs/heads/codex/v030g`.
All commits use the requested author and committer identity.

Validation: **920 JavaScript tests passed; 1995 Python tests passed, 126 skipped**.
The additional asset-check run passed all three tests, including two checks
against verified game assets. Skips cover
optional external tools/assets and integration prerequisites; they are not evidence
of on-screen correctness. The full suites retain three existing Python deprecation
warnings. Each numbered item's regression was separately run against `d36ae82` and
failed there. No localhost session or native application was launched. No owner
install, Mods, library or settings were changed.

1. **Loading progress alignment.** The actual `UIRepeater/Widget/Loading` contains
   individual letter sprites. The old helper searched for a UILabel, found none,
   and left the progress text at the CSS fallback position. The new helper measures
   each cropped letter PNG's alpha bounds at runtime, applies the prefab's widget
   pivot, size, transforms and screen-bottom shift, and uses the lowest visible
   non-descending letter edge. The `g`, dots and taller Arona widget do not define
   that line. The white outlined label comes from the game's detail experience
   label. Its baseline inset uses the same font sizing and lift as NGUI rendering.
   Batch, detail and settings jobs share this renderer.

   Files: [loading.js](../src/ba_modding_toolkit/web/js/loading.js),
   [ngui-label.js](../src/ba_modding_toolkit/web/js/ngui-label.js).
   Tests: `ngui_labels.test.mjs` checks sprite ink and baseline equality across
   scales/scripts; `loading.test.mjs` checks live progress and task lifetimes;
   `test_verified_loading_letters_define_progress_line` reads the real nine
   non-descending sprites and independently derives **y = 1013.4486486486486**
   on the 1920 by 1080 stage. Pixel appearance in the native renderer remains
   for the owner's screen review.

2. **Favorite state fidelity — the baked shading remains.** The source is
   `UICharacterDetail/.../Char_Target/Pin`. Off enables `Pin_Off`, whose background
   is `Common_Bg_Pin_Detail_02` (266 by 68); its icon is 38 by 38 with white tint,
   and its label color is `#828282`. On enables `Pin_On`, whose background is
   `Common_Bg_Pin_Detail_01` (262 by 73); its icon has an orange gradient and its
   label is `#725538`. The prefab has no separate pressed-shadow branch or
   serialized pressed tween for these widgets; its press callback lists are empty.
   The old adaptation recolored and resized both icons and replaced their local
   positions. Those substitutions are removed. Caption expansion preserves each
   state's original background, tint and child geometry. Gradient metadata is now
   exported and rendered, with a new layout-cache schema.

   **The off-state atlas sprite itself contains the inset shadow.** Removing that
   baked artwork would conflict with rendering this prefab's off state exactly.
   This item is therefore only partially resolved: state fidelity is fixed, but a
   flat unpressed appearance would require approval of a different game widget.
   Files: [detail.js](../src/ba_modding_toolkit/web/js/detail.js),
   [layouts.py](../src/ba_modding_toolkit/gameassets/layouts.py),
   [service.py](../src/ba_modding_toolkit/gameassets/service.py),
   [ngui.js](../src/ba_modding_toolkit/web/js/ngui.js).
   Tests: `favorite_pin.test.mjs` checks both branches and preserved sprite,
   color and geometry; `test_owner_review.py` checks exported gradient metadata.
   The game executable's internal button animation was not executed.

3. **Unknown source detection and wording.** A recognized Android/iOS build target
   did not identify the region. A repacked CAB, a filename such as `ch0156_home`
   without a region suffix, and missing package references could therefore produce
   `source_unknown`, although rendering and a manual conversion succeeded.
   Neutral `NoTarget` metadata in another serialized file also discarded an
   otherwise known target; neutral entries are now ignored for that calculation.

   Direct, complete markers still win. Incomplete detection tries all six choices
   through the manual selection's preflight. Agreement with partial platform and
   region markers sorts first, with one point per agreement. Equal scores use
   **Global before Japan; Android before iOS before PC**. The first passing choice
   wins. Conflicting markers and known unsupported targets remain errors. Validation
   requires target discovery, an official baseline, slot checks, compatible Spine
   inputs, and a nonempty intersection of comparable Unity assets with official
   targets, even for exact same-platform filenames. A preview or readable header
   alone cannot validate a choice. Probes do not write files. Execution rechecks
   the accepted choice.

   If every choice fails, the badge asks for manual source identification in all
   six locales, including the exact requested zh-CN wording. The selector remains
   visible and the badge gets a wider one-line column at the shared row font size.
   Files: [mod_origin.py](../src/ba_modding_toolkit/mod_origin.py),
   [batch_import.py](../src/ba_modding_toolkit/webui/batch_import.py),
   [batch-import.js](../src/ba_modding_toolkit/web/js/batch-import.js),
   [import-layout.js](../src/ba_modding_toolkit/web/js/import-layout.js), six locale
   JSON files. Tests: `test_mod_origin.py` exercises real generated UnityFS lobby
   bundles, Android/iOS/neutral targets, LZ4/LZMA, a misleading renamed filename,
   missing markers, ties, unmatched assets and successful conversion/apply;
   `batch_import.test.mjs` checks badge copy and geometry in six locales.
   [Decision rules](import-source-detection.md) document the policy separately.
   Iroha's unavailable file cannot prove which exact marker was absent; the
   generated bundles reproduce the identified code paths.

4. **Source popup labels.** The two title containers were static, so their
   absolutely positioned NGUI labels anchored to the same outer content area.
   Each title now has its own positioning context; both intended labels remain.
   File: `batch-import.js`. The independent `source popup title labels occupy
   distinct prefab rows` regression computes their flow offsets and asserts that
   their drawn rectangles are separated. The six-locale owner-review cases also
   check the two title containers.

5. **Descenders and effects.** CSS ellipsis clipped a label's short line box,
   including descenders and outline/shadow pixels. The ellipsis span now receives
   measured padding on all four sides and compensating margins, preserving its
   original baseline and hit geometry. The font's baseline metrics are kept
   separate from actual ink bounds so Thai combining marks cannot move the
   baseline and still clip themselves. All NGUI labels using this rendering path
   receive the fix; labels without ellipsis retain visible overflow.
   Files: `ngui.js`, `ngui-label.js`. Tests: `ngui_labels.test.mjs` covers Latin,
   CJK, Korean and Thai ink/effect extents; `no_tooltips.test.mjs` checks the
   actual renderer's padded span and baseline-preserving margins. Native font
   rasterization has not been visually inspected.

6. **Result paragraphs.** The old platform and note lines used centered pivots,
   different font sizes and y positions of -84/-138, placing the note below the
   card. Metadata, optional platform route and note now use top pivots, one
   shared font size and a 56-unit pitch from the line under the divider. Kind
   text/counts and the Go to control keep separate right-side space. Shared size
   calculation includes list/result states, routes and notes; result scaling is
   compensated so the displayed paragraph font matches the list's pixel size.
   Thumbnail shape was not changed.
   Files: `import-layout.js`, `batch-import.js`. Independent six-locale result
   tests cover both two- and three-line layouts, bottom clearance, uniform pitch,
   shared size, and text/action column separation. The owner-review tests compare
   list and result font sizes after their render scales are applied.

7. **Memorial lobby still framing.** The still renderer fitted painted skeleton
   bounds, which include off-camera scenes and props. It now asks for revisioned
   prefab framing for current, official, imported and library sources. Every
   ordinary memorial lobby still uses the game's camera transformed into the
   skeleton's coordinates. Narrow card windows crop inside that camera, never
   widen it to include exterior art. Explicit special-scene framing remains
   separate. The common still pipeline covers import previews, row thumbnails,
   switch cards and detail lobby cards.
   Files: [lobby-still.js](../src/ba_modding_toolkit/web/js/lobby-still.js),
   [thumbs.js](../src/ba_modding_toolkit/web/js/thumbs.js),
   [services.py](../src/ba_modding_toolkit/webui/services.py).
   Tests: `lobby_still.test.mjs`, `thumbs_runtime.test.mjs` and
   `test_import_preview.py` verify camera bounds, layer transforms, the revisioned
   endpoint and framing before encoding. The verified Ui check confirms
   `CH0169_home`, camera `(-1480, -832.5, 2960, 1665)`, layer `(0, -962, 1)`.
   Ui's actual rendered pixels were not reviewed on screen.

8. **Alias pencils.** A scene could close its overlay while another strict hold
   still captured input. Closing now hands the overlay back to outstanding holds.
   Separately, a cold student editor used popup geometry before loading its frame;
   the Mod editor waited for unrelated optional popup assets without progress.
   Both now visibly await only the required frame, with a 15-second bound, then
   build the editor. Load failures are reported through the normal action error
   path. Files: `loading.js`, `detail.js`, `popup.js`, `mod-alias.js`.
   Tests: `loading_hold.test.mjs` reproduces the invisible lock and verifies input
   restoration; `alias_readiness.test.mjs` reproduces both cold pencil paths;
   existing detail alias save/cancel tests still pass. The owner's intermittent
   click sequence was not observed directly.

9. **Scene transitions.** Ordinary routes and in-place preview changes use the
   shared inner shade with all interaction blocked. Boot retains its initial
   opaque cover. Roster-to-detail preparation keeps a measurable destination
   hidden, queues panels/cards/first-frame publication, then swaps it into view.
   Cancellation clears staging and cannot reveal a stale destination. Returning
   to roster/import releases detail page work but retains its complete rendered
   frame until the destination is ready. Entry thumbnails now finish together;
   at their shared 15-second asset deadline they cancel instead of filling after
   reveal. Individual preview/layout/RPC failures retain bounded error fallbacks;
   unavailable assets may therefore produce a stable placeholder/error state.
   Crossfades are disabled at the atomic commit.
   Files: `main.js`, `detail.js`, `loading.js`. Tests: `screen_loading.test.mjs`
   checks screen visibility and swap/cancellation order; `detail_render.test.mjs`
   checks hidden publication, pending previews/decodes, complete thumbnails and
   cancelled late writes; `loading_hold.test.mjs` checks strict transition input.
   Tests execute the vendored renderer's load/capture ordering with GPU stand-ins.
   Native GPU uploads and an on-screen frame-accurate swap remain unobserved.

10. **Several folders.** `native.pick_folder` now passes `allow_multiple=True` to
    pywebview and retains every returned path. The existing collector scans each
    folder with the selected recursion policy and deduplicates repeated paths.
    Settings' separate folder picker is unchanged.
    Files: [native.py](../src/ba_modding_toolkit/webui/native.py),
    [test_batch_import.py](../tests/test_batch_import.py).
    API and multi-folder scan tests pass for shallow and recursive scans, including
    duplicate folder selections. Installed pywebview 6.2.1 was checked: macOS uses
    NSOpenPanel multiple selection; Windows uses its Vista folder dialog with
    OpenFileDialog.Multiselect and returns all FileNames. Upstream implementations
    support the same paths: [macOS](https://github.com/r0x0r/pywebview/blob/master/webview/platforms/cocoa.py),
    [Windows](https://github.com/r0x0r/pywebview/blob/master/webview/platforms/winforms.py).
    Neither native dialog was exercised interactively here.
