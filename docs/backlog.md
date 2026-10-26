# Backlog

Current version handoff: [Development status](project-status.md). Verify it against the actual branch, working tree
and `pyproject.toml` version before reporting progress.

BL-001 through BL-008 describe the implementation included in 0.5.0, following the 0.4.1 baseline (`d936decd`).
Later entries track unreleased local review work and planned or deferred requirements.
It includes the revised Hall workflow, dialogue, office backgrounds, global portrait scaling, immersive Hall view
and touch-friendly queue reordering. The owner approved the stable release after the local alpha review builds.

The 0.5.0 release regression run passed 1,324 JavaScript tests and 2,801 Python tests, with 24 Python tests skipped.
The preceding alpha.2 baseline completed native-window checks; alpha.3 was handed to the owner for visual acceptance.
Current gesture coverage includes touch holds, swipe-to-scroll, cancellation, pointer ownership, viewport scaling
and stationary-edge scrolling. These tests do not replace acceptance on a physical touchscreen.
No development data or runtime-exported game resources are included in the distributable files.

The owner's 2026-10-26 feedback is recorded as **BL-022 through BL-031**. See the
[complete requirement/evidence map](feedback-2026-10-26.md) for every sub-item, supplied screenshot/report,
acceptance boundary and proposed execution order. BL-022 through BL-029 and BL-031 were implemented for local 0.6.0-alpha.1 review. BL-030 remains planned. The preceding
Chinese README/CHANGELOG drafts and fork synchronization are complete; the initial BL-015 implementation has owner acceptance.

BL-032 through BL-039 (except the BL-037 design task) were implemented for local 0.6.0-alpha.2 review. The owner's
macOS review of alpha.2 on 2026-10-26 accepted BL-033 to BL-036, BL-038 and BL-039; its findings are recorded as
**BL-040 through BL-045**. Windows has not been reviewed yet.

## BL-001: Per-Mod atomic library import and game installation

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.
- Requirement: A partial file set for one Mod must not be reported as a successful library import or game install.

Library import now journals the full group under `import-transactions/<id>/`, copies and verifies every staged
bundle, publishes the complete Mod directory, then publishes its metadata. Metadata publication is the commit point.
Caught failures restore the prior metadata and remove the incomplete group. Recovery checks journal paths, file
hashes and directory boundaries; a blocked rollback retains its journal and reports `library_recovery_pending`.
Recovery also requires directory synchronization before deleting a journal, including retries whose metadata
already has the desired contents. Previously completed, independent Mods remain intact.

Game installation retains its existing journaled multi-file write, verification and rollback flow. Replacement
happens file by file; interrupted operations recover on the next operation or restart. A locked file or failed
recovery can remain pending rather than being reported as complete.

Atomicity is **per Mod within each stage**. Library storage and optional application remain separate stages: a
complete library Mod can remain after an application failure, together with a configured choice awaiting repair
or retry. This does not introduce a combined import-and-apply transaction. While Mods are off, application retains
the existing desired-state behavior and defers game-file writes.

Validation: `tests/test_library_import_atomic.py` covers each file transfer and verification, metadata publication,
interruption at commit boundaries, failed rollback, repair links, symlink confinement and failed directory-sync
retries. Existing library and game-install tests remain part of integration validation.

## BL-002: Student-detail export flow and ZIP output

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.

The primary Export action now uses the shared ZIP flow:

1. Show the actual configured default output directory, with Confirm on the right and Choose Directory on the left.
2. Show target server and platform choices from the available configured installations; default to the current
   install, preferring serialized platform metadata.
3. Choosing a directory returns to the confirmation dialog with its updated path. Cancelling the picker retains
   the previous path. Only Confirm starts an export.
4. Prepare bundles against the selected target's actual original resources, validate them, then write and verify
   a complete ZIP before publishing it by atomic replacement.
5. On success, offer to open the actual destination used for that export.

Conversion reuses import preparation and its compatibility checks; changing metadata labels is not conversion.
Missing or incompatible target originals prevent export. A ZIP contains one stable, portable subfolder per source
and a `manifest.json` with target, source identity, filenames, sizes and SHA-256 digests. Partial preparation,
archive writing or verification does not publish a new ZIP. The secondary asset-extraction actions remain available.

Validation: generated UnityFS fixtures cover Android/iOS-to-PC and cross-server preparation, desired-state selection,
source changes and publication failures in `tests/test_mod_export.py`. Frontend journey tests cover picker return,
cancellation and the successful destination; the shared confirmation layout has been inspected in a running UI.

Workflow clarification (2026-10-25): routine old-Mod upgrading and generation for distribution should reuse
Import -> Update/Repair when needed and offered -> Student Detail Export. Application to game files is optional;
repair is not a mandatory step for an already compatible Mod. Export prepares against the configured target's
available official resources. Arbitrary, unconfigured target Bundles remain an advanced classic-interface use
case rather than a separate near-term screen duplicating this journey.

## BL-003: Batch-import preview/apply checkboxes and removal of imported rows

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.

Select for Preview and Apply to Game are separate checkboxes immediately above Import. Apply After Import is no
longer in the options dialog. Their saved preferences remain independent: preview selection defaults off;
application retains its existing default on and any explicitly saved choice.

Successful imports can save a preview source without changing the game configuration. Application uses the existing
desired-state semantics, including deferred writes while Mods are off. Failed imports never select a preview.
A library-only manual assignment can be stored and selected for preview even when application has no local target.

Remove Imported removes rows classified as completed, already in the library or already installed from the import
list. It does not delete library Mods or uninstall game files. Pending, conflicted and failed rows remain available.
Returning to the page in the same session retains the list and its current view state.

Validation: batch-import Python and frontend tests cover independent preferences, preview/application outcomes,
completed-row removal and unchanged or failed entries.

## BL-004: Mod settings export section

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.

Settings > Mods contains an Export section with Export Mod Library and Export Applied. Both use the complete
BL-002 journey and ZIP format. Export Applied selects distinct Mod sources from the desired-state manifests across
the library's recorded installations and includes their assignments in the manifest. It does not infer selection
from the current on/off switch or from the bytes presently installed in the game.

Every selected Mod must prepare successfully for the chosen target before the archive is published; a failure in
one member leaves no partial bulk ZIP. Verification includes the master-switch-off case and the shared frontend flow.

## BL-005: Enable update checking by default

- Status: Existing default and regression coverage verified for 0.5.0.
- Requested: 2026-10-23.

Automatic startup update checking was already enabled for an unset preference. That default remains enabled;
an explicitly saved `startupUpdate: false` remains off. No preference migration resets an opt-out. The automatic
network check retains the existing released-build gate and starts after the first screen, without blocking navigation.

Validation covers missing, enabled and disabled preferences and the build gate.

## BL-006: Manual character assignment for unidentified Mods

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.

The import workflow offers a character selector for unidentified, self-contained Mods. It uses the shipped offline
student metadata and character map, including students and variants without resources in the selected installation.
Its roster-based search, filtering, sorting and grouping controls identify the owner, which is confirmed and stored
with the Mod. Confirmed ownership survives re-analysis and does not depend on a local original bundle.

Ownership and installation compatibility remain separate. Without a compatible local target, the Mod can be stored
and its own source selected for preview, but Apply is disabled and the detail page shows No Matching Game File.
`storedKinds` describes library preview availability; `localKinds` and the actual resource handles describe the
installation. No missing handle is invented, no sibling source is substituted, and declining automatic preview
selection does not silently choose a Mod. Later target availability still requires the normal compatibility checks.

Validation: manual-identity/catalog fixtures, import-preview tests and detail/roster rendering tests cover saved
ownership, missing resources, preview opt-out and the disabled application path. The actual supplied Mod is subject
to the same readability and dependency validation; assignment alone does not make an incomplete Mod usable.

## BL-007: Preserve navigation history across menus

- Status: Implemented in 0.5.0.
- Requested: 2026-10-23.

Back follows committed page entries within the current session. Batch Import -> student detail -> Back returns to
Batch Import, retaining its import list, selection and view controls. Student steps and tab changes replace the
current detail entry rather than adding every pose to history. Cancelling unfinished navigation returns to the last
committed page; failed navigation does not become a successful history entry.

Student Hall is the root fallback, including for a direct student link. History is not persisted across app restarts.
Navigation and rendering tests exercise page transitions, cancellation, source-page return and the detail Back callback.

## BL-008: Student Hall

- Status: Implemented in 0.5.0; local alpha review builds approved for release.
- Requested: 2026-10-23.

Student Hall is the startup/root page and has portrait-composition and memorial-lobby modes. The top-right Home
control returns to it; the bottom navigation contains no Hall entry. Home, Settings and their divider retain the
native top-bar prefab geometry. Local Hall actions sit immediately to the left of the mode switch.
Layout uses the selected Pencil icon, Background uses Photo, and portrait/playlist selection uses the native duty
student icon. All top-right action icons are aligned by their visible artwork and reduced to 75% of their previous size.
Save/Cancel have equal widths on the next row, aligned with the icon group. The mode switch retains the
enabled loop graphic without its separate count label. The far-right Fullscreen control uses UILobby's native
`Btn_Screen_On`; its owned exit uses `Btn_Screen_Off`. Both share the toolbar's visible icon size and centering.
Immersive view hides navigation and editing controls without rebuilding the scene; the exit control and Escape
restore them, preserving drafts and playback. Navigation cleanup restores focus and inert state independently of
the detail screen's visual mode.

Portrait entries have independent IDs. Different portrait sources for the same student may coexist, but the same
source cannot be added twice. Portraits share one rendering canvas and keep independent animation state, position,
scale and draw order. The editor adds, removes and positions entries. Hovering an actor in the editor exposes the
selected native trash icon; layouts with at least three actors also expose layer order and horizontal flip actions.
There is no selection frame or individual scaling interaction. The portrait picker admits only library portrait sources, groups rows by student with optional
skin merging, and gives each row an independent horizontal card strip. Search, filters and sorting follow the
roster. Cards remain still previews; clicks do not open another window or change the background scene. Explicit Add
buttons align with their inclined name strips; an existing source has a disabled Added action. Older duplicate
portrait entries are canonicalized when read without writing a migration or changing the saved revision.

The portrait projection uses the ordinary lobby's authored CharPos and skeleton scale as its baseline. A same-variant
comparison with the supplied Cycling Shiroko screenshot supports this corrected default composition. Layout editing
adds a compact global size slider at the upper right (25–150%, default 100%), spanning the icon group
inside the native inclined button body, without a caption, percentage input or Reset button. It multiplies each entry's
relative scale without moving its anchor or resizing the background. Changes update existing skeletons and hit bounds
without reloading assets or rebuilding the canvas; the percentage participates in the same Save/Cancel draft.
Entering the editor, saving and canceling retain the existing players and animation state. New sources load behind
a same-resolution snapshot and loading indicator, then all actors commit and draw together. Current and saved
entries retain their resources for cancellation; unused actors, source players and backgrounds are pruned.
The compact portrait modal uses native white inclined row plates with equal outer-edge margins; its scrollbar's
painted right edge aligns with the toolbar. Lazy thumbnails show failure text only after a real failure.

Layout and playlist editors use drafts with Save/Cancel. Their modal hosts block the underlying page; nested
selection/filter popups belong to the editor lifecycle. Leaving a dirty Hall prompts Save, Discard or Keep Editing.
Canceled navigation preserves the current scene and return stack, and obsolete async navigation cannot commit.

Memorial mode maintains an ordered playlist of unique official or Mod lobby sources. Different sources for the same
student remain allowed; read-only legacy deduplication preserves the active source without advancing the revision. Previous/Next
selects the active entry; the existing lobby renderer supplies its scene and interaction. The adjustment modal puts
six-column native formation cards on the left and landscape candidates on the right, with a draggable playlist
underneath. Selected students retain the native green outline without a check or sequence number. Both selectors
share the roster toolbar without its screen-title icon/caption. Playlist cards have no extra name strip or heading;
their Remove buttons align with the image. The queue has a native pale rounded background and compact gaps.
Pointer-based reordering keeps the source thumbnail at 50% opacity, carries its image with the cursor and marks
the insertion gap with a native blue gradient rather than highlighting another card. The entire area above each
Remove button is a grab target. Mouse/pen drag directly; a touch swipe pans the queue, while a 260 ms touch hold
starts reordering with a slightly lifted thumbnail. Card gestures claim the pointer stream so the surrounding
horizontal scroll handler cannot pan simultaneously. Holding a dragged card at an edge scrolls continuously;
release, cancellation, a second touch, loss of focus and disposal retire the gesture and its timers.
Unselected candidates default to recently viewed order. Mod availability, counts and sorting are scoped separately
to portrait and memorial sources; release filters describe students in the selected installation. The final playlist entry cannot be removed; the backend enforces that transition too.
Hall choices do not apply Mods to game files or change the detail page's saved preview. Mode, selected background,
portrait arrangement, playlist order and active memorial entry persist; revision checks reject conflicting saves.

Scene switches keep the previous complete frame until all target resources and the first frame are ready. Portrait
and current memorial sessions are retained separately, with inactive clocks/audio paused. Playlist edits that retain
the current source do not replay it. A bounded hidden memorial staging slot loads replacements without destroying
the active scene. Modal redraws wait for visible thumbnails and decoding while offscreen entries stay lazy.

Portrait clicks use the actual `LobbyCommon/DialogPanel/ChatDialog/Talk` balloon (`Lobby_balloon`) beside the clicked
instance. Text preserves the native font, wraps without truncation and centers in the visible bubble body excluding
the tail and shadow; edge placement can flip the tail. A Hall-wide turn lock ignores other portrait clicks during
preparation and vocal playback. Preparation is bounded to 25 seconds; text-only or failed-audio fallback remains
for five seconds. The preparation timeout is removed once audio starts and never cuts off a playing vocal.
Ordinary lobby voice lookup prefers a matching local AudioClip and otherwise uses the existing Kivo transport.
Localized Idle dialogue shares the existing Global table download. Voices stay in bounded memory caches, concurrent
loads coalesce, and each click has cancellation ownership. A pending first lookup retries within a bounded budget;
available text remains visible while the same clip's voice becomes ready. Missing audio does not erase readable text.
Missing dialogue is silent. Authored expression clips and timed continuation rows drive vocal expressions, including
Simplified Chinese; delayed metadata resumes from the active vocal time and the previous pose returns afterward.

The office-background sources have been identified as the layered NGUI prefabs `LobbyCommon` and `LobbyCommonNight`
(`UILobbyBackground_Day` and `UILobbyBackground_Night`). Integration reads their native texture layers losslessly at
original resolution and places them using the prefab geometry. With no saved background choice, the daytime office
is the default when its resources are available. A saved available choice takes precedence. Partial installations
without the office resources can use the available collection backgrounds; the inspected inventory contains 54,
which is an observed count rather than a fixed limit.

Environmental cloud and light motion driven by the office's Animation/Tween components remains static in this
implementation. Portrait animation and memorial-lobby animation retain their existing behavior. The native
additive light pass, daytime/nighttime scenes, picker previews and cancellation have been checked in a running UI;
the final integrated build passed the corresponding runtime checks.

Validation covers state validation and revision conflicts, portrait/memorial uniqueness, kind-scoped filters, shared rendering and
lifecycle behavior, navigation and runtime UI checks. The local validation run passed 2,801 Python tests (24 skipped)
and 1,313 JavaScript tests. Native checks include foreground activation after loading in the background, mode
round-trips, forward/reverse queue dragging and the final icon/control layout. Game assets, rendered previews and voice files are not included
in the program's distributable files.

## BL-009: Chinese Hall captions and non-editing scene zoom

- Status: Implemented and included in current local 0.6.0-alpha.1 review. Not released.
- History: First integrated into local 0.5.1-alpha.1; retained in the current review build.
- Requested: 2026-10-24.

A Chinese Hall request gives its preferred caption source the existing bounded preparation budget instead of
assuming that an earlier Global response means Chinese text is absent. A late caption updates the current balloon
without replaying its voice or consuming another turn. Chinese interfaces use the other Chinese script as their
caption fallback, never Japanese or English. Language switches immediately reevaluate existing captions, and stale
requests or render completions cannot overwrite a newer language. Uncaptioned old recordings do not duplicate a
captioned current recording of the same numbered line. Flat ordinary voice numbers follow voiced rows rather than
dialogue-group IDs, including groups with two separate voices and missing recordings.

Outside layout editing, mouse wheels and touchpad pinches zoom the entire portrait scene, from 100% to 300%.
BL-010 raises the original 50% viewing minimum to the default view.
Touchpad swipes pan the magnified scene. The shared Spine camera redraws portraits at native rendering quality;
the office layers use the same transform, and hit areas and speech balloons follow. UI controls stay at their
normal size. Viewing zoom does not write layout positions, per-portrait scales or the saved overall size. Entering
layout editing restores the original editing view. Mode round-trips retain the temporary portrait viewing camera.

Validation includes translation readiness and stale-language races, source filtering and dialogue-group mapping,
shared-renderer identity, pointer-centered projection, WebKit pinch deduplication, scaled hit areas and input
blocking during editing or modals. A live-source check of eight implemented students returned Chinese captions
for all 42 ordinary lines. Local package visual acceptance remains with the owner.

## BL-010: Default-size minimum for Hall scene zoom

- Status: Implemented and included in current local 0.6.0-alpha.1 review. Not released.
- History: First integrated into local 0.5.1-alpha.1; retained in the current review build.
- Requested: 2026-10-24.

The Student Hall's non-editing scene zoom must stop at its default viewing size (100%, camera scale 1.0).
Mouse-wheel and touchpad zoom-out gestures must not shrink the scene below that size. This supersedes the
50% viewing minimum originally implemented in BL-009.

## BL-011: Thin solid memorial-queue insertion line

- Status: Implemented and included in current local 0.6.0-alpha.1 review. Not released.
- History: First integrated into local 0.5.1-alpha.1; retained in the current review build.
- Requested: 2026-10-24.

Use approved option A: a solid line from the native Common/Common_Line_Dot sprite, tinted with the game's
formation-selection blue. Reduce its visible width to about one fifth of the current line (10 to 2 stage pixels).
The insertion indicator remains in the target gap and uses no vertical opacity gradient or target-card outline.
The existing native line widget and formation-selection palette supply its artwork and color.

## BL-012: Integrate upstream CAB discovery improvements

- Status: Implemented and included in current local 0.6.0-alpha.1 review. Not released.
- History: First integrated into local 0.5.1-alpha.1; retained in the current review build.
- Requested: 2026-10-25.

Consolidate the App and upstream low-level CAB parsing where their behavior is compatible. Adopt demand-driven
dependency discovery: search bundles in the referring bundle's group first, then common/prolog resources, and
expand to the remaining resources only when necessary. Stop after all requested CABs are resolved. Do not inherit
a file-size cutoff that can silently exclude a required dependency.

Persist the reusable CAB-to-bundle index in the managed user cache, with bounded storage, schema and resource-version
keys, source-directory confinement and the App's existing stronger file-revision validation. Update or discard
stale mappings after game updates, Mod replacement, file removal or a cache-clear request. Publish cache files
atomically; corrupt or unavailable cache data must fall back to normal discovery.

Use the declared UnityFS bundle length when block info is stored at the end, so appended CRC-correction bytes do
not shift the index. Preserve supported compression, alignment and engine-version flag handling, including the
UnityFS LZMA correction made during the upstream sync.

Retain the App's bundle locks, explicit resource cleanup, Mod overrides, missing-dependency tracking and incomplete
export safeguards. Do not replace its renderer/export graph wholesale with the CLI-only graph. Measure cold and
warm dependency lookup with isolated official fixtures and verify invalidation and concurrent readers before
claiming improvements to any preview or loading workflow.

Validation covers same-group/common fallback, bundles larger than 64 MiB, persisted mappings, mtime-preserving
replacement, deletion, new dependencies, cache clearing during reads, source changes during parsing, corrupt-cache
confinement, symlink escape, concurrent readers, graph hints and cleanup. Repeated scan prefixes reuse batch metadata;
returned mappings still revalidate their files. Two real model exports and two memorial scene descriptions retained
identical output hashes before and after integration. Persistent metadata has a first-build cost; warm restart
measurements must be reported separately rather than presented as universal cold-start improvements.
The integrated alpha.1 regression passed 2,855 Python tests (24 skipped) and 1,340 JavaScript tests. The local macOS
package passed version/resource and compiled-server startup checks; owner visual acceptance remains pending.

## BL-013: Drag-and-drop asset packing screen

- Status: Planned. Not started; owner confirmed backlog-only scope.
- Requested: 2026-10-25.
- Priority: Near-term backlog.

Provide a new-interface packing workflow based on the batch-import screen. Accept dropped raw assets such as PNG,
SKEL and ATLAS files, group related resources, show validation and target-bundle matches, and generate packed Bundle
files. A target Bundle supplies the existing Unity asset structure; packaging is not merely creating a ZIP of the
input files. Permit target selection when automatic matching is ambiguous and explain missing companions before
starting work. Preserve the existing packing options where relevant.

Generation must finish and validate the complete output group before reporting success. Keep generation separate
from optional library import or game application, and reuse the existing protected write paths for those actions.
Follow the batch-import screen's native prefab layout, readiness and progress conventions. Do not introduce a new
rendering-quality reduction or write to game files just because files were dropped.

## BL-014: In-context bundle inspection and reference tracing

- Status: Candidate. Not scheduled.
- Requested: 2026-10-25.

Consider exposing the upstream read-only inspection and cross-bundle reference tracing through contextual actions
in import errors, compatibility details and the existing diagnostic-report flow. Show the source platform, Unity
version, asset identity, missing external CAB and its resolution evidence when useful to explain a failure.

Prefer enriching the current workflows over adding a mandatory standalone diagnostics screen. Avoid expensive
full scans during normal thumbnail rendering or list refreshes; cancellation, bounded work and on-demand detail
loading must preserve UI responsiveness. Keep user paths redacted in shareable reports and distinguish dependency
or format failures from guessed platform incompatibility.

## BL-015: Student thumbnail photography and per-character library

- Status: Implemented; owner UAT and visual acceptance approved on 2026-10-26. Not released.
- Requested: 2026-10-25.
- Follow-up: BL-022 and BL-023 record the owner's 2026-10-26 revisions. Shared galleries across skins, separate
  official/generated defaults, variant-scoped numbering, export and occlusion guides are included in alpha.1 for owner review.

Open photography from the A1 framed-camera icon beside Reset in the student's native fullscreen view. Reuse the
real full-quality portrait and memorial renderers. Both modes preload before interaction, switch in place with
one ready-frame publication, retain their players and pause hidden rendering/audio. Back uses the standard App
button, leaves fullscreen and restores the prepared detail page. Route changes cancel stale camera work and
release retained resources.

The centered guide matches the roster's 404:456 texture aspect. Its rule-of-thirds grid can be hidden while
framing corners remain. Pan at minimum zoom; zoom out until the complete authored portrait or memorial height
fits the guide. Outside-art regions use a clean matte without blurred edge extension. Capture reads native scene
pixels and excludes controls, guides, dialogue balloons, custom pointers, click effects and capture feedback.
Preserve the character's authored halo, scene effects, expression and playback state.

The A1 smile (`Common_Icon_Emoji`) opens the titleless expression strip, with cached face previews and the same
native difference cards as student details. B1 chat (`School_Icon_Chat`) opens a titleless dialogue/action strip;
the detail page's existing playback button sits beside it. Strips fit actual rows and scroll overflow. The mode
switch reuses the Hall's icon-only control. Shutter captures save directly without a review dialog or automatic
gallery opening. A transient shutter effect follows the snapshot; only a confirmed save animates the actual photo
into the bottom-left album. Animation failures cannot block persistence or leave playback frozen.

Captures are immutable, lossless PNGs in the shared Mod library's `photographs/`, outside disposable preview caches.
The manifest is serialized across instances, validates IDs/ownership/digests, and publishes images and metadata
atomically. Each character has an independent App selection. Save in the compact gallery changes the student
roster's image source; Apply is a distinct, actual game operation. Default always remains visible and protected;
Restore Default resets both selections without deleting captures. App/desired-game photographs are protected
from deletion. Apply and Delete share a short row, with Save centered beneath the pair.

The target is the student roster's Collection portrait:
`UICharacterCollectionPopulatorUnit/Grid/UICollectCard/Char_Portrait` (404 by 456 prefab units), resolved through the
character's `Student_Portrait_<variant>_Collection` mapping. Shiroko (Cycling)'s verified target is
`Student_Portrait_Shiroko_ridingsuit_Collection`. Formation and Tactical Challenge selection icons are separate
resources and remain untouched. Default images read verified originals, including kept backups, with install and
resource-revision-specific asset URLs.

Game application composes the chosen texture into its shared Collection bundle, validates every unrelated object's
raw bytes and every resource stream, retains native dimensions/mipmaps and uses lossless RGBA32/LZ4 output. Exact
original GPU-encoded pixels restore one default while other characters' choices remain. Removing the final custom
choice restores the entire original bundle byte-for-byte. Managed composite Mods reuse journaled atomic writes,
backups, rollback, protection against target changes during preparation, desired-state manifests and the master
switch. With Mods off, Apply changes configuration only; On installs the composed sources. Obsolete compiled
composites can be pruned while saved PNGs persist.

Dated Collection batches coexist and have separate slots. Legacy configuration keys migrate without game writes.
When a photo-only batch is replaced by a game update, its choices rebuild from the new originals before enabling;
unrelated objects from an old batch are never copied over new originals. Missing originals or mixed external Mods
remain explicit errors instead of successful application. Error states allow retry without a false Applied badge.

Automated coverage includes persistent storage, cross-instance saves, invalid inputs/digests, selected-photo
protection, failed metadata publication, camera geometry/native-density cropping, rendered expression reuse,
shutter/save ordering, resource retention, intro playback controls, Back navigation, shared-bundle preservation,
individual defaults, master-switch defer/reapply, updated batches, concurrent target changes and full rollback.
Game assets and development data are excluded from packages. UAT and visual review belong to the owner.

## BL-016: Advanced extraction and ADB interface migration

- Status: Deferred. Not started.
- Requested: 2026-10-25.
- Priority: Someday (backlog of the backlog).

Migrate arbitrary-Bundle asset extraction and its advanced options, including Atlas frame unpacking and scaling,
to the new interface only when higher-priority work is complete. The existing per-character extraction path does
not require this migration. Keep the classic extraction tool available meanwhile.

ADB file pushing and device-directory browsing are likewise deferred; preserve their classic-interface entry
points. This entry does not authorize development access to the owner's device or production game installation.

## BL-017: Directory-scan backups and bulk preview export interface migration

- Status: Deferred. Not started.
- Requested: 2026-10-25.
- Priority: Someday (backlog of the backlog).

Defer new-interface migration of scanning game directories to back up detected Mods and of bulk rendering previews
to output image files. Existing library/applied ZIP export and automatic thumbnail generation remain separate
workflows; retain the classic tools until migration becomes a priority.

## BL-018: Standalone manual CRC tool interface migration

- Status: Deferred. Not started.
- Requested: 2026-10-25.
- Priority: Someday (backlog of the backlog).

Keep manual CRC calculation, two-file comparison and explicit target-CRC correction available in the classic
interface for Mod authors and troubleshooting. Normal import/application should continue to handle required
CRC correction automatically. Defer a standalone new-interface page or advanced-tool migration until higher
priorities are complete; do not add this as a routine step in the normal import workflow.

## BL-019: Integrate file CRC checks and Mod inventory reports

- Status: Planned. Not started.
- Requested: 2026-10-25.

Extend Settings > Mods > Check Game Files and its current scan-result workflow instead of adding another mandatory
top-level tool. Reuse the installation snapshot and existing background scan infrastructure to provide explicit
CRC inspection results and export a Mod inventory. Share the resulting snapshot with the existing diagnostic
report when relevant; an inventory of detected Mods and a fault/log report remain distinct outputs.

The inventory should identify the installation, character/core, resource kind, filenames, managed or untracked
state and available checksum evidence. Keep long reads off the UI thread, support cancellation, report monotonic
progress and invalidate stale results when the install or source files change. Do not repeat a full checksum scan
on language changes, list redraws or report generation when a valid snapshot is already available.

CRC mismatch is evidence, not proof of corruption, and matching CRC is not proof that a bundle is official.
Check readability, completeness and target identity before offering correction; do not make an unknown or damaged
bundle appear valid merely by matching the filename's CRC. A read-only check or inventory export must never alter
game files. Explicit corrections must use the existing protected writer, backup/rollback and verification paths,
respect the master-switch and installation state, and report incomplete or failed work accurately.

Validate using generated and isolated official fixtures: matching, corrected, unknown, corrupt, missing and
externally changed files; stale snapshots and cancellation; export-only runs; and failed writes with rollback.

## BL-020: Release notes in update detection

- Status: Implemented for local review; owner UAT/visual acceptance pending. Owner review deferred until after the 0.6.0 release (2026-10-26).
- Note: The detected tag's GitHub body opens in a scrollable notice popup, with a release-page fallback for empty notes.
- Requested: 2026-10-25.

Add a localized Release Notes action to the update-detection dialog. Display the notes approved for that exact
detected release, with a link to its release page when notes are unavailable. Reading notes must never start a
download or installation. For future stable releases, the agent drafts release notes from final changes and
validation, and the owner reviews their wording before publication. Record this release requirement in the
repository's agent guidance; do not publish an empty stable-release description.

## BL-021: First-launch new-version feature tour

- Status: Implemented for local review; owner UAT/visual acceptance pending. Owner review deferred until after the 0.6.0 release (2026-10-26).
- Owner review of the 0.6.0 draft (2026-10-26): merge the photography and shared-gallery pages into one student
  thumbnail page (`学生详情全屏后增加大头照拍摄功能`), drop the release-notes page; publication awaits the owner's OK
  on the revised copy.
- Note: Profile-local upgrade history and Settings replay support text-only tours; the published registry is empty and the six-locale 0.6.0 draft awaits approval.
- Requested: 2026-10-25.
- Flow: [New-version feature tour](feature-tour-flow.md).

On the first normal launch after an upgrade, present a short, dismissible tour of newly introduced features.
Each page covers one feature with concise text and an optional approved App UI illustration or text-only layout. Previous/Next, page count and Close
remain available; the last page finishes into the current App screen. Settings provides permanent access to
published tours, including earlier versions. Dismissal must not affect existing preferences or ongoing work.

The agent drafts the copy and optional App UI illustrations outside packaged sources; a human reviews them before shipping. Never package screenshots or images made from game files.
Wait for the first screen, required consents and higher-priority recovery/update dialogs to settle before showing
the tour. Do not introduce new startup scans, rendering work or network dependencies for this presentation.
Remember presentation per user-data profile/version, avoid duplicate prompts on restarts/reinstalls/downgrades,
and handle missing images or absent tour content without blocking launch. Release notes and CHANGELOG remain
separate, complementary views of the same actual release history.

## BL-022: Shared student galleries, generated defaults and photo export

- Status: Implemented for local 0.6.0-alpha.1 review; owner UAT/visual acceptance pending.
- Requested: 2026-10-26.
- Details: [Gallery semantics and acceptance](feedback-2026-10-26.md#bl-022-detail-shared-gallery-and-default-sources).
- Later requirement: BL-036 supersedes the original blanket deletion protection for App-selected and generated
  photographs. Only official entries are inherently undeletable; applied custom entries require confirmation.

Share a student's photographs across skins while retaining source-variant identity, independent variant selections
and safe migration. Provide protected official and roster-generated defaults; the generated image is the fallback
unless an official/custom choice is explicit. Keep counters independent per originating skin and reuse existing
localized variant naming when displaying other skins' photos. Add lower-left gallery Export to the configured
output directory and open that directory after verified success.

The current game-photo writer already obeys the Mod master switch; App-roster selection is independent. Preserve
that distinction, deferred application, shared-bundle integrity and rollback for both default types and shared
photos. No automatic game write follows merely from browsing the gallery or resolving an App fallback.

## BL-023: Faithful photography occlusion guide and save readiness

- Status: Implemented for local 0.6.0-alpha.1 review; owner UAT/visual acceptance pending.
- Requested: 2026-10-26.
- Details: [Camera requirements](feedback-2026-10-26.md#bl-023-detail-camera-guides-placement-and-save-readiness).
- Owner review: the occlusion button is too wide and the frame-not-ready modal still occurs. Follow-ups BL-032
  and BL-033 are planned; this part has not passed acceptance.

Add an Occlusion Guide toggle to the left of the grid control, matching the roster gray banner and Exclusive Weapon
indicator area from actual Collection prefabs at 1:1 relative geometry. Exclude the guide from saved photographs.
Remove portrait fullscreen Reset's text and move the memorial camera entry to the portrait Reset position.
Recover transient frame-not-ready capture/save races in the background without the reported modal; wait for valid
pixels and durable publication, prevent duplicate/stale work, and retain meaningful handling of permanent failures.

## BL-024: Frameless desktop shell and macOS menus

- Status: Implemented for local 0.6.0-alpha.1 review; owner UAT/visual acceptance pending.
- Requested: 2026-10-26.
- Details: [Desktop chrome](feedback-2026-10-26.md#bl-024-detail-native-desktop-chrome).
- Follow-up: BL-037 requests a design for integrating genuine platform window controls into the top toolbar.
  The design itself is backlog work and has not started.

Remove Windows/macOS title bars and WebUI-related macOS menu entries. Preserve standard window drag, resize,
close/minimize/fullscreen and keyboard/accessibility behavior, plus the App's own navigation and camera controls.
Validate actual packaged host behavior rather than relying only on a browser development server.

## BL-025: Windows update location, shortcuts and companion files

- Status: Targeted changes implemented for local 0.6.0-alpha.1 review; packaged Windows acceptance pending.
- Requested: 2026-10-26.
- Details: [Update continuity](feedback-2026-10-26.md#bl-025-detail-windows-update-continuity).

Trace the versioned-EXE download/restart flow and define a stable launch/update arrangement that preserves existing
desktop shortcuts. Inventory same-directory program dependencies versus user data and temporary files. Retain
settings/library/output, required companion files, verified replacement and failure recovery. Do not assume a
shortcut follows a newly named EXE or delete unrecognized neighboring files.

## BL-026: Desktop rendering seams, shadow corners and source-toolbar overflow

- Status: Rendering/layout corrections implemented for local 0.6.0-alpha.1 review; packaged Windows visual acceptance pending.
- Requested: 2026-10-26.
- Evidence: Screenshots 3 through 7 in the [feedback record](feedback-2026-10-26.md#supplied-evidence-index).
- Details: [Cross-platform checks](feedback-2026-10-26.md#bl-026-detail-cross-platform-ui-defects).
- Owner review: a fine seam remains visible in the Mod switch's On segment. Residual defect tracked by BL-035.

Investigate Windows side bands, diagonal cuts in the inner shadow, thin heading/button/frame seams and overflowing
portrait/L2D source-action labels. Reuse correct prefab geometry and preserve artwork/font quality. Verify packaged
Windows WebView2 at representative display scaling and macOS Retina/non-Retina-equivalent sizes, with localized
labels and normal/fullscreen views. Record actual platform coverage; owner UAT/visual review remains required.

## BL-027: First Windows startup failure after a 0.3-to-0.5 upgrade

- Status: Targeted changes implemented for local 0.6.0-alpha.1 review; packaged Windows acceptance pending.
- Requested: 2026-10-26.
- Evidence: `BAMT-report-0.5.0-20261025-1309.zip`; reviewed read-only; cold first-screen layout delay recorded in the report.
- Details: [Failure and migration investigation](feedback-2026-10-26.md#bl-027-detail-one-time-windows-upgrade-startup-failure).

Identify why the first post-upgrade launch failed while later launches succeeded. Preserve the report, diagnose the
earliest failure, reproduce with isolated old-profile fixtures and add a regression for the confirmed cause.
Make migration/recovery idempotent; a successful retry alone is not evidence that the defect has been fixed.

The report has no backend exception: two layout exports took 38.817 and 40.530 seconds before a 45-second
first-screen watchdog expired. Add the missing Formation prefab lookup hint and reset the boot idle watchdog on
completed layout work, with a bounded total grace period. This addresses a concrete cold-layout path; the report
does not establish a damaged migration, and exact Windows reproduction/acceptance remains pending.

## BL-028: Official Hall portraits, toolbar counts and Shiroko first-run defaults

- Status: Implemented for local 0.6.0-alpha.1 review; owner UAT/visual acceptance pending.
- Requested: 2026-10-26.
- Details: [Hall behavior](feedback-2026-10-26.md#bl-028-detail-student-hall-sources-and-initial-state).
- Follow-up: BL-038 closes the Hall-only layout gap left by hiding Home: move Settings right and remove its divider.

Include original portraits alongside Mod sources. Hide Home while already at the Hall root, retaining it elsewhere.
Prevent removal of the final portrait and hide its trash control. Show all applicable layer/mirror/removal actions
with two portraits, including the reported incomplete-toolbar case. Preserve toolbar hover ownership and alignment.
Initialize an unconfigured first-time profile with Shiroko's official portrait and memorial lobby, prepare before
reveal and handle unavailable resources gracefully without replacing an existing user's layout or writing game files.

## BL-029: Native gold affirmative-action buttons

- Status: Official gold prefab identified and affirmative styling implemented for local review; owner visual acceptance pending.
- Requested: 2026-10-26.
- Details: [Prefab inventory and semantics](feedback-2026-10-26.md#bl-029-detail-gold-affirmative-actions).
- Owner review: source-picker Save is missing gold styling, while Update and Settings' Export Mod Library are
  incorrectly gold. Correct the explicit action mapping under BL-034; current coverage is not accepted.

Find the official gold affirmative prefab, inventory Confirm/Save/Apply and equivalent affirmative actions across
shared dialogs and feature screens, then apply it consistently with native states, sizes and visual centering.
Preserve cancel/secondary meaning, loading/disabled states and localized text fit. Navigation/mode toggles are not
affirmative confirmations merely because they are currently blue.

Source: `UIMailBox/Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn`, with gold `Common_Btn_BG`,
`Common_Btn_Normal_Y_S_Pt` decoration and native ink. Only derived widget values ship; sprite pixels still come
from the user's game. Shared rendering preserves asynchronous thumbnail sources and secondary/disabled states.

## BL-030: ADB and Japanese-server validation with accurate support disclosures

- Status: Audit planned. Device/server validation and Settings changes not started; owner requested backlog only.
- Requested: 2026-10-26.
- Details: [Evidence matrix and requested notice](feedback-2026-10-26.md#bl-030-detail-adb-and-japanese-server-support-evidence).

Separate implemented paths, synthetic tests, isolated real-resource checks, actual device/server flows and owner
acceptance. Audit relevant detection, conversion, import/application/restore, export and ADB transfer/recovery.
Do not claim end-to-end support from code presence alone. Add the requested boxed experimental-information notice
for the Japanese-server setting if it remains unverified/unusable, and update README descriptions from evidence.
The Chinese draft now states the unverified boundary; testing details await the audit. Other languages still wait
for review. This is independent of the deferred ADB UI migration (BL-016) and does not authorize production access.

## BL-031: Light and dark Chinese README logo variants

- Status: Light/dark compositions added to the Chinese README; owner visual acceptance pending.
- Requested: 2026-10-26.
- Evidence: Screenshots 1 and 2 in the [feedback record](feedback-2026-10-26.md#supplied-evidence-index).

Place the supplied Chinese wordmark in the marked lower-right area under the BMPT logo. Prepare matching light-
and dark-background versions with legible colors and consistent alignment/proportions. Change Chinese README
branding only; keep other-language assets untouched and hand candidates to the owner for visual acceptance.

## BL-032: Compact photography occlusion control

- Status: Implemented for local review; owner macOS review found the English label overflowing (BL-040).
- Requested: 2026-10-26, following local alpha.1 review.
- Parent: BL-023.

Reduce the excessive width of the Occlusion Guide button. Keep its position to the left of the grid toggle,
visual centering, localized readability and usable pointer/touch target. Do not enlarge or displace surrounding
controls to accommodate it. Final visual acceptance belongs to the owner.

The native button is compacted with a fixed right edge and measured localized label fit; neighbouring controls retain their geometry.

## BL-033: Remaining frame-not-ready photography modal

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26, following local alpha.1 review.
- Parent: BL-023.

The owner still sees the frame-not-ready modal, so the previous targeted handling did not cover every affected
path. Trace the actual failing capture/save/apply path and error propagation rather than treating the existing
retry or message suppression as proof of a fix. Recover transient readiness in the background while preserving
framing, pose, playback and session ownership; finish with a valid, durably saved image. Prevent duplicate or stale
publication. Keep genuine storage/format/permanent failures distinguishable and never display a false success.

Redraw readiness was outside the retry boundary, transparent frames passed the canvas check, and uncoded failures used the readiness caption. Capture now retries preparation and pixel readiness with session ownership, reports permanent failures separately, and preserves image/manifest consistency on publication failure.

## BL-034: Correct gold-button scope and applied-Mod export label

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26, following local alpha.1 review.
- Parent: BL-029; export wording also relates to BL-004.

Use explicit action semantics to correct these owner-observed cases:

| Location/action | Required treatment |
| --- | --- |
| Portrait source selection > Save | Official gold affirmative prefab |
| Memorial source selection > Save | Official gold affirmative prefab |
| Portrait/memorial source selection > Update | Normal non-gold style |
| Settings > Mods > Export Mod Library | Normal non-gold style |
| Photo gallery > Export | Normal non-gold style; explicitly confirmed by the owner |
| Settings > Mods > Export Applied | Rename the Simplified Chinese label to `导出已应用的Mod` |

The requested Simplified Chinese Save label is `保存`; Export Mod Library is `导出Mod仓库`, and the previous
applied-export label is `导出已应用`. This wording change alone does not request a new color for applied export.
Keep secondary, disabled and loading states intact. A broad name-based rule must not color Update or the library
export merely because other affirmative actions use gold. Owner review remains the visual acceptance criterion.

Owner clarification confirmed that the photo gallery's Export must use the normal non-gold style. This is a
confirmed backlog requirement; it does not authorize implementation in this documentation-only update.

Source-picker primary Save now carries an explicit affirmative semantic. Update and both export entry points retain normal styling; the applied export label is localized in all six languages. Styling no longer infers meaning from names or captions.

## BL-035: Fine seam in the Mod switch's On segment

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26, following local alpha.1 review.
- Parent: BL-026.

A fine line is still visible on close inspection of the top-left Enable Mods > On button. The earlier general
rendering corrections did not resolve this specific artifact. Inspect this control's actual rendering path,
including its scaled segment edges and active-state paint, before choosing a correction. Preserve the native
shape, colors, text and click geometry; do not hide the defect by reducing image quality. Owner visual acceptance
and accurately reported platform/DPI coverage are required when implementation is authorized.

The switch bypassed NGUI's contiguous raster slicing: its active CSS mask and inactive border image sampled fractional tile edges independently. Both states now use the shared high-quality NGUI raster path, retaining the sprite, inclination, colors and hit box. Geometry checks cover stage scales 0.5–2 and device pixel ratios 1–3 with a raster of at least 2× that increases to the effective display density; native WebView visual acceptance remains pending.

## BL-036: Consistent asset deletion for official, previewed and applied sources

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26, following local alpha.1 review.
- Related: BL-015/BL-022 photograph protection, BL-001 atomic operations and existing library-source deletion.

Apply the owner's deletion rule consistently across user-managed assets, including photographs and portrait,
memorial and model sources. Official asset entries are the only inherently undeletable class: omit their Delete
control entirely rather than showing a disabled button. Determine official provenance from the actual source,
not its display label, matching CRC or whether the asset is selected.

| Asset state | Required behavior |
| --- | --- |
| Official | No Delete control; reject direct deletion requests as well |
| Non-official, selected only for App preview | Allow deletion; preview selection is not a lock |
| Non-official, applied/configured for game use | Keep Delete available; ask for confirmation before deletion |
| Other non-official managed assets | Allow normal deletion without an in-use restriction |

Required Simplified Chinese applied-asset confirmation: `该资产正在被应用中，是否删除？` Cancelling retains the
asset and all choices. Confirming removes it through the existing protected writer/rollback flow and reconciles
the affected game/configuration state. Include configured application deferred by the Mod master switch; with
Mods off, reconcile desired configuration without performing game writes. Preserve other choices in shared
Collection bundles and unrelated assets. Failed cleanup/write/metadata publication must not report a successful
deletion or leave dangling references.

Deleting an App-preview selection must clear or replace its stale reference with a valid available fallback.
Sharing photographs across skins means checking every affected preview/game reference, not only the open skin.
Generated/custom assets must not be silently reclassified as official merely to retain the previous lock. This
requirement supersedes the earlier default/App-selected/custom-applied blanket protections; only genuine official
assets keep permanent deletion protection. Runtime resources outside user-managed asset/library choices are not
targets for a bulk filesystem-delete operation.

Official provenance controls Delete visibility and direct-request rejection. Managed previews can be deleted with fallback across skins; applied/deferred choices require confirmation. Source, shared Collection recipes, protected game writes and metadata cleanup share a recoverable undo transaction; Mods-off deletion changes configuration without game writes.

## BL-037: Design native window controls integrated into the top toolbar

- Status: Native experiment in progress (owner-approved direction, 2026-10-26).
- Requested: 2026-10-26.
- Parent: BL-024.

Develop a more native integration of macOS's three top-left window buttons and Windows's three top-right window
buttons into the application's existing top toolbar. Keep the platform-appropriate placement and native window
behavior. The task includes conceiving the layout and interactions before implementation; do not treat the
current custom control group as the accepted final design.

The future design should account for native control space, alignment with App actions, draggable versus clickable
areas, resizing, maximize/fullscreen, keyboard/accessibility behavior and narrow-window layouts. Preserve the
existing unsaved-change and active-writer close handling. Avoid overlapping native controls with Back, Settings,
Home or the Mod switch. The owner's latest clarification explicitly defers the design itself into the backlog;
no mockup or platform feasibility investigation is part of this documentation-only update.

Owner decisions on `docs/design/window-controls.md` (2026-10-26): try M1 (real macOS traffic lights in the
toolbar row, moved vertically to the bar's centre line) and W1 (system caption buttons top right; their vertical
position follows the system). The owner gives feedback after the experiment. Narrow windows: keep one row and drop
the "Enable Mods" caption text, keeping the switch and its help badge. Windows 11 is the primary target; Windows 10
keeps working without dedicated optimisation. Close: every quit origin uses the existing unsaved-change prompt,
a clean close needs no prompt, active writers still refuse. Immersion: native controls stay with a small drag
background; add only the window/fullscreen keyboard commands needed.

## BL-038: Reflow Settings when Home is hidden in Student Hall

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Parent: BL-028; coordinate native-control safe space with BL-037.

When already in Student Hall, Home remains hidden, Settings moves right into the space Home previously occupied,
and the separator between those actions is removed. Keep the appropriate outer margin/native-control clearance,
visual centering and hit target. Other pages retain their Settings/Home arrangement and separator. Returning to
or leaving the Hall must update the layout consistently without an empty Home-sized slot or a stray divider.

The Hall centers the native Settings sprite in Home’s former box and hides the divider in the same layout update. Other pages restore the prefab sibling geometry; overlapping native controls retain clearance.

## BL-039: Missing Japanese directory causes server-switch error and blank Hall

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.2, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Related: BL-030 support audit, but this is a separately reported settings/navigation failure.
- Evidence: `codex-clipboard-dd0d548d-05d4-46af-a634-31af2a05b43c.png`, supplied by the owner.

Observed sequence: in Settings, switch from the Global server to the Japanese server when no local Japanese game
directory is available. The App shows this internal error:

```text
AttributeError: 'types.SimpleNamespace' object has no attribute 'names'
```

The Student Hall then becomes blank. Restarting restores the display. This does not establish a root cause,
whether the server preference was retained, or whether any saved Hall configuration changed.

When implementation is authorized, reproduce with isolated configuration/resources, trace missing-directory
handling and the failed refresh, and identify the actual incomplete record reaching name display. Missing game
resources must produce an actionable missing-directory state rather than an AttributeError. A failed or cancelled
switch must preserve a usable screen and saved layout/selection, and recovery must work without restarting.
Avoid committing stale cross-server refresh results, silently clearing Hall data or writing game files as a side
effect of changing this setting. Owner UAT remains the acceptance step.

Stored model fallback records lacked display metadata when the selected catalog had no installed entry. Offline metadata and complete fallback records now cover name display. Server changes validate the directory before saving; missing resources show a folder-selection message, retain the current server and Hall data, and recover in-session. Refresh ownership rejects stale server results.

## BL-040: Wrap the English Occlusion Guide label

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.3, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Parent: BL-032.
- Evidence: owner screenshot of the English photography toolbar.
- Note: Occlusion Guide and the grid toggle share one caption size fitted to the prefab body on up to two lines;
  English wraps as two lines inside the button.

The compact Occlusion Guide button from BL-032 overflows in English. Wrap the label inside the native button instead
of letting it spill out; keep BL-032's compact width, fixed right edge and the neighbouring controls' geometry. The
Chinese label already fits. Check every shipped language, not only English.

## BL-041: Text fit and one font size for source action buttons

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.3, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Related: BL-034 and BL-036 (source-picker actions).
- Evidence: owner screenshot of the English L2D source picker (Apply, Show in Finder, Check Compatibility, Update,
  Delete).
- Note: one caption size per same-kind group (shared group fitting), wrapping on up to two lines; applied to the
  source pickers and the other button rows, tabs and segments. Long English, Thai and Korean rows give the widest
  caption a wider body. The owner accepted the wider body for the longest caption.

In the L2D source picker, Check Compatibility overflows its button, and the buttons in the same row use different
font sizes (Update is smaller than Delete). Long labels wrap inside the button; buttons in one row share one font
size that fits all of them. Chinese shows no problem; audit every other language on every source picker (portrait,
memorial, L2D, model, thumbnail) and the other action rows. The owner asked for this to become a standing UI design
and review rule, kept in a UI guideline file rather than in the general agent rules.

## BL-042: Restore Default on thumbnails creates an orphan generated default

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.4, 2026-10-26); Windows not reviewed.
- Note: Restore reuses the variant’s stored generated default; gallery identity and applied usage now match deletion checks.
- Requested: 2026-10-26.
- Related: BL-022 (generated defaults) and BL-036 (deletion rules).

Observed: in the thumbnail picker, with a user-made thumbnail selected, Restore Default adds another generated
default thumbnail. The new entry shows no Applied marker, yet Delete answers that the asset is in use
(`该资产正在被应用中，是否删除？`). Restore Default must reuse the existing generated default and create one only
when none exists. The Applied/preview markers and the deletion check must read the same state, so the in-use
confirmation appears only for assets that are actually applied.

## BL-043: Top bar vertical centring and title size

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.3, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Related: BL-038 and BL-037.
- Evidence: owner screenshot of the Students top bar with a red line through the bar's centre.
- Note: content centred on the fill of `Common_Top_Menu_Bg` by ink (text by its script's reference glyph, bitmaps
  by their drawn rows); the title uses the prefab's `Label_Title` size 66 in the App's per-script drawing size. The
  owner kept the larger Latin title and the fill centre (not the whole bar including its dark edge).

The top bar's content is not centred on its background: the right-hand actions (Settings, Home) sit a few pixels
high and the left-hand items low. The current page title (e.g. 学生) is larger than the bar's other text and not
consistent. Measure against the game's top bar prefab and name it; align each element's visual centre with the
bar's centre and use the prefab's title size on every page. Check all pages and languages at several window sizes
and display densities.

## BL-044: Applied and preview frames from the game's selected skill cards

- Status: Implemented for local review; owner UAT/visual acceptance pending.
- Note: Shared source cards use UIPopup_Mulligan’s yellow/blue frames, particle mesh motion and top-right badge; the badge's number label reads the game's "Selected" (`webui.status.selected`, the Global client's wording; Simplified Chinese as the owner worded it).
- Requested: 2026-10-26.
- Related: BL-015, BL-022 and BL-036.
- Evidence: owner screenshots of the game's Formation Edit > starting skills > selected skill cards (animated yellow
  and blue frames, numbered top-right badges with a check).

The portrait, L2D and thumbnail pickers (and the other source pickers) tell the applied choice from the one being
previewed. Show both with the game's animated selected-card frames, built from the game's prefab (identify and name
it), not CSS. Move the Applied marker from the top-left corner to the top-right, in the numbered check-badge style.
Proposed mapping for owner review: applied = yellow frame with the check badge, previewed = blue frame.

Owner review of 0.6.0-alpha.4 (2026-10-26), two screenshots:

1. Every badge shows its check twice. In the yellow (applied) badge the content must be the text "已选择" (the game's
   own wording for a selected card in each language), not a grey check icon.
2. The animated frames, yellow and blue alike, show extra dark areas at the card's corners, outside the rounded frame.
   Lead's diagnosis to confirm: the game's `FX_SHADER_AlphaBlend_Add_Mask_0` (blend One / OneMinusSrcAlpha, linear
   colour space) mostly adds light; the App draws the effect into its own WebGL canvas with non-premultiplied alpha
   and lets the browser blend it in display (gamma) space over the card. Where the scrolling mask is dark but its alpha
   is not zero, which includes the mesh's corners outside the rounded frame, the effect dims the card behind instead of
   adding light.

Addressed, awaiting review: the badge sprite (`Common_Icon_Mulligan_1`) already draws a check, so the grey check cloned
from `SelectLine/Sprite` is gone and the prefab's number label (`Mulligan_IndexLabel`) reads "Selected" instead. The
ring mesh has no corner fill: it is a 9 px outline whose alpha is only the mask, while its HDR light saturates at mask
0.15 (yellow) and 0.03 (blue). The straight-alpha canvas weighted that light by the mask, up to 0.85 (yellow) and 0.97
(blue) darker than the game's One / OneMinusSrcAlpha result, and dimmed the card by (1 - alpha) in sRGB values, up to
0.29 over white. The canvas is now a premultiplied layer that is never darker than the game's blend; which of these
showed at the corners is for the owner to judge.

Owner decisions (2026-10-26): keep the new glow compositing for review. Badge text by state: the yellow (applied)
badge reads the existing "Applied" label (`webui.status.applied`, zh-CN `已应用`); the blue (previewed) frame gets the
prefab's blue badge (`Common_Icon_Mulligan_2`) reading "Selected" (`webui.status.selected`, zh-CN `已选择`).

## BL-045: Separate Global and Japanese game directories

- Status: Accepted by the owner (macOS review of 0.6.0-alpha.3, 2026-10-26); Windows not reviewed.
- Requested: 2026-10-26.
- Related: BL-039 and BL-030.
- Evidence: owner screenshot of the dialog shown when switching to the Japanese server (title `失败`, message
  `请在设置中选择此服务器的游戏目录。`, buttons Generate Error Report and Confirm).

Settings has no place to choose a Japanese game directory, so that message cannot be acted on. Add separate Global
and Japanese game directory settings, using each language's official server names, and assign the existing single
directory to the server it belongs to. When the selected server's directory is not set, show a plain notice instead
of a failure: no `失败` title and no error-report button, a message such as `未设置日服游戏目录`, and Confirm only.
Keep BL-039's behaviour: the current server, Hall and saved choices stay as they are.

Settings exposes both server folders, migrates detected legacy Japanese installs and shows a Confirm-only notice for missing folders; refused switches retain the current server, and resource caches remain isolated by installation.


## BL-046: Managed CLI CAB cache and upstream introspection tests

- Status: Closed by the owner without UAT (2026-10-26): CLI-only; the App engine is unaffected apart from batched CAB index saves and preview-cache clear detection, covered by tests.
- Requested: 2026-10-26.
- Related: BL-012 and BL-014.
- Note: CLI discovery shares managed scoped/versioned CAB metadata, publishes interrupted scans before output,
  and tests local and external PPtrs separately.

The CLI `inspect`/`trace` cache still defaults to `Addons/cab_cache.json` beside the program: unbounded, not keyed by
the game's resource version, not cleared from Settings, and since the latest upstream sync rewritten in full on every
CAB hit. Move it onto the App's managed CAB index/preview cache (bounded, versioned, cleared in Settings) and retire
the file. The upstream test `tests/test_core/test_introspect.py` expects every non-null PPtr to resolve in local-only
mode without separating local (`m_FileID == 0`) from external references, which official bundles with external
references contradict; test the two cases separately and add tests for `--local-only`, cache isolation and
interrupted runs. Upstream's CLI options and the shared UnityFS reader are already in `main`.

## BL-047: Fullscreen button left on a rotated fullscreen portrait

- Status: In progress (function confirmed by the owner, 2026-10-26).
- Requested: 2026-10-26.
- Related: the portrait view's rotate and fullscreen controls.

In the portrait view, after rotating the screen and entering fullscreen, the fullscreen button is still shown in the
top-right corner. It must not be shown once the view is fullscreen; leaving fullscreen restores it.

Owner correction (2026-10-26): the top-right button stays; its function should be switching the fullscreen view
between the portrait and the memorial lobby. The removal of the button is reverted; the new function awaits the
owner's confirmation of the exact behaviour.

Owner confirmation (2026-10-26): in the fullscreen view the top-right button (double-arrow icon kept) switches
between this skin's portrait and its memorial lobby; the Hide UI function is dropped.

## BL-048: Remove the CLI as a built and installed command

- Status: Accepted by the owner (2026-10-26).
- Requested: 2026-10-26.
- Related: BL-046.

The App does not need a dedicated command-line entry; scripts that can call the functions are enough. The classic
GUI stays for users who still use it. The `bamt-cli` command, the Windows CLI executable and CLI release uploads are
removed; `python -m ba_modding_toolkit.cli` keeps working from a source checkout, and the App and the classic GUI are
unchanged.

