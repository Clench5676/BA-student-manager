# Changelog

Developer-facing history for the **Blue Archive Modding and Patching Tool App's 0.x version line**.
Entries are grouped by behavior rather than listing every intermediate commit. Published releases are verified
against Git tags and GitHub Releases; dates use Europe/Berlin. Only published versions appear here; local work is tracked in the backlog. The inherited toolkit's v2.x history belongs to [upstream releases].

When publishing a stable release, add its final changes with the actual version/date and
release/compare links, and retain compatibility or migration notes. Release notes and feature tours are separate,
human-reviewed presentation materials.

## [0.5.0] - 2026-10-24

### Added

- Student Hall as the default App root, with portrait/memorial modes, office backgrounds, saved layouts, layering,
  mirroring, global portrait size and contextual dialogue/voice playback.
- Touch-friendly memorial playlist editing and reordering, with a top-right Home action and fullscreen controls.
- Student-detail ZIP export with target server/platform selection, directory confirmation and open-folder completion.
- Mod-library and applied-configuration ZIP export in Settings.
- Manual character assignment for unidentified Mods, reusing roster filtering/sorting controls.

### Changed

- Batch Import exposes Select for Preview and Apply to Game at the import action, plus Remove Imported.
- Back navigation preserves the entry context instead of always returning to the student roster.
- Update checks default on when unset and preserve an explicitly saved opt-out.

### Fixed

- Per-Mod library imports publish complete, verified groups with durable journals and recovery. Partial publication
  rolls back; existing completed Mods remain intact. Library import and optional game application remain separate stages.
- Preserve ready Hall resources and wait for complete visible-image preparation before revealing scene/modal changes.

## [0.4.1] - 2026-10-23

### Added

- Persistent, validated lossless preview exports and rendered-thumbnail caching, clearable from Settings.

### Fixed

- Long-running jobs survive sleep/reconnect without a client timeout incorrectly declaring failure; completed
  operations are recovered through job-state polling.
- Platform/version preparation rebuilds compatible Spine assets before rejecting an import.
- Artwork clips to native card/button surfaces.

### Performance

- Language changes refresh text without reloading scenes. Reuse prepared assets, import previews and thumbnails;
  remove redundant batch work and stabilize progress reporting.

### Build

- Windows GUI builds run only from a published stable release's exact tag. Push-time tests, CLI builds and other
  redundant workflows no longer run in GitHub Actions; prereleases do not trigger Windows packaging.

## [0.4.0] - 2026-10-22

### Added

- Local diagnostic reports and startup recovery for failed/unreadable state.

### Changed

- Separate preview choices from desired game-application configuration. Selecting a preview does not silently apply
  it, and choosing an application while Mods are off retains intent for the next enable.
- Integrate model previews with the source-switch workflows and preserve imported-model rendering.

### Fixed

- Remove redundant application-status banners from roster cards; restore native thumbnail/card clipping.
- Recognize legacy conversions by verified content and retain import results when no game installation is selected.

## [0.3.0] - 2026-10-22

### Added

- New-interface Batch Import: files/multiple folders, previews, source identity, compatibility checks and per-item results.
- Server/platform detection and preparation against available target originals.
- Library support for model Mods and generic bundles.
- Thai localization and explicit confirmation of the user's Spine licence before loading the runtime.

### Fixed

- Reject incomplete or mismatched imports while retaining useful failure context and recoverable staging.
- Reconcile native preview geometry, modal/loading readiness, progress labels and post-import navigation.

## [0.2.1] - 2026-10-21

### Added

- Student/Mod aliases, search by aliases and preserved naming in details.
- Mod validation/repair against the current atlas, with repair preview and separately retained repaired versions.
- Support for additional special Spine backgrounds such as Arona, Plana and Aoi.
- Mod deletion/deduplication, configured-source previews while Mods are off, a log viewer, and update progress with
  separate restart confirmation.

### Fixed

- Preserve authored alpha/halo behavior and handle legacy remapped Mods without repeatedly repairing them.
- Repair source-card framing, selection behavior and late-thumbnail readiness.

### Migration

- macOS App data moves from the legacy `BA-Modding-Toolkit` folder to `bluearchive-modding-patching-tool` through
  the application's migration flow. Preserve settings/library content; do not manually combine active instances.

## [0.1.0-beta] - 2026-10-20

### Added

- The Mod master switch, per-install desired configuration, retained originals and reconciliation prompts.
- Clear state for untracked, changed, overwritten and restored sources, plus classic-tool handoff/queue integration.

### Fixed

- Source selection while Mods are off, cross-install resource access, and recovery/retention of originals needed by
  another installation.

## [0.1.0-alpha.3] - 2026-10-19

### Added

- Traditional Chinese, Japanese and Korean UI localization alongside English and Simplified Chinese.

### Fixed

- Locale placeholder/font behavior, language naming and memorial idle/dialogue sequencing.

## [0.1.0-alpha.2] - 2026-10-19

### Added

- Portrait fullscreen visual mode, expanded memorial zoom limits, particle effects and more faithful 3D framing.
- Student aliases and roster alias search.

### Fixed

- Fullscreen input/focus, hidden-view behavior, particle rendering and post-processing placement.

## [0.1.0-alpha.1] - 2026-10-18

### Added

- In-game memorial source switching and student-detail keyboard navigation.

### Fixed

- Classic-window launching from packaged builds, symlinked macOS page assets, decoded roster-image readiness and
  several memorial/3D rendering details.

## [0.1.0-alpha] - 2026-10-18

- Initial published App prerelease with the game-style WebUI, roster/detail previews and packaged desktop entry.

## History boundaries

Intermediate version bumps and local review build numbers without a published tag/release are not retrospectively
listed as public releases. Unreleased work, including update-dialog Release Notes and the new-version feature tour framework,
is tracked in the backlog until publication. Consult the linked comparisons for detailed commits and upstream history
for the classic toolkit's earlier v2 releases.

| Version | Commit comparison |
| --- | --- |
| 0.5.0 | [0.4.1...0.5.0](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.4.1...0.5.0) |
| 0.4.1 | [0.4.0...0.4.1](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.4.0...0.4.1) |
| 0.4.0 | [0.3.0...0.4.0](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.3.0...0.4.0) |
| 0.3.0 | [0.2.1...0.3.0](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.2.1...0.3.0) |
| 0.2.1 | [0.1.0-beta...0.2.1](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.1.0-beta...0.2.1) |
| 0.1.0-beta | [alpha.3...beta](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.1.0-alpha.3...0.1.0-beta) |
| 0.1.0-alpha.3 | [alpha.2...alpha.3](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.1.0-alpha.2...0.1.0-alpha.3) |
| 0.1.0-alpha.2 | [alpha.1...alpha.2](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.1.0-alpha.1...0.1.0-alpha.2) |
| 0.1.0-alpha.1 | [alpha...alpha.1](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/compare/0.1.0-alpha...0.1.0-alpha.1) |

[0.5.0]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.5.0
[0.4.1]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.4.1
[0.4.0]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.4.0
[0.3.0]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.3.0
[0.2.1]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.2.1
[0.1.0-beta]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.1.0-beta
[0.1.0-alpha.3]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.1.0-alpha.1
[0.1.0-alpha]: https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases/tag/0.1.0-alpha
[upstream releases]: https://github.com/Agent-0808/BA-Modding-Toolkit/releases
[upstream PR #17]: https://github.com/Agent-0808/BA-Modding-Toolkit/pull/17
