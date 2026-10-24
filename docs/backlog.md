# Backlog

The entries below describe the implementation included in 0.5.0, following the 0.4.1 baseline (`d936decd`).
It includes the revised Hall workflow, dialogue, office backgrounds, global portrait scaling, immersive Hall view
and touch-friendly queue reordering. The owner approved the stable release after the local alpha review builds.

The 0.5.0 release regression run passed 1,324 JavaScript tests and 2,801 Python tests, with 24 Python tests skipped.
The preceding alpha.2 baseline completed native-window checks; alpha.3 was handed to the owner for visual acceptance.
Current gesture coverage includes touch holds, swipe-to-scroll, cancellation, pointer ownership, viewport scaling
and stationary-edge scrolling. These tests do not replace acceptance on a physical touchscreen.
No development data or runtime-exported game resources are included in the distributable files.

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
