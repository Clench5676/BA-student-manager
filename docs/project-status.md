# Development status and checkout handoff

As of 2026-10-26. This is a dated handoff; verify the actual branch, working tree and project version before
reporting subsequent progress. [Backlog](backlog.md) holds the detailed requirements and owner findings.

## Why the two progress reports differed

Two development checkouts share Git history but retain independent working files and indexes:

| Checkout | Branch | State verified during reconciliation |
| --- | --- | --- |
| Primary checkout, legacy Hall work | `codex/hall-caption-scene-zoom` | HEAD `908aef78` (0.5.0); working version `0.5.1-alpha`; 16 uncommitted source/test/documentation/version files |
| Active `sync-upstream-20261024/BA-student-manager` worktree | `codex/hall-caption-scene-zoom-synced` | Working version `0.6.0-alpha.1`; integrated Hall, dependency-index and photography review work |

The report describing BL-010/BL-011 as unstarted was accurate for the legacy checkout's backlog. It did not
describe the active worktree. Uncommitted changes do not synchronize between checkouts when another branch is
merged, fetched or committed. The current branch also includes the upstream merges made after the 0.5.0 base.

Current source and tests are preserved by local commit **`62d44f7b2172cc33e37cc3ba5b20eeb50536b3d6`**
(`feat(gui): integrate student photography and review updates`). This checkpoint does not tag, push or publish
a release, and it does not assert owner acceptance of every included follow-up.

The legacy checkout has not been reset, switched or edited. Its 16-file development patch was independently
preserved in the active worktree's ignored `.cache/workspace-reconcile-20261026/` with a source-hash inventory.
Do not discard that checkout's changes or try to reapply its entire patch over the newer review implementation.

## Current feature state

| Items | State |
| --- | --- |
| BL-001 through BL-008 | Included in the published 0.5.0 App baseline |
| BL-009 | Hall captions and whole-scene viewing zoom implemented and included in the current local review build |
| BL-010 | Implemented: viewing zoom minimum is 100%, not the earlier 50% |
| BL-011 | Implemented: 2-pixel solid native `Common_Line_Dot` insertion marker, no vertical gradient |
| BL-012 | Dependency/CAB discovery and persistent index integration implemented |
| BL-015 | Initial photography feature accepted by the owner; later requirements remain separate |
| BL-022 through BL-029, BL-031 | Local alpha.1 implementation delivered; later owner findings remain open, not accepted as fully resolved |
| BL-013, BL-019 through BL-021, BL-030 | Planned, not implemented; BL-021 has a proposed flow only |
| BL-014 | Candidate, not scheduled |
| BL-016 through BL-018 | Deferred |
| BL-032 through BL-039 | Recorded follow-ups, not started; BL-037 includes the design work itself |

BL-009 through BL-012 were first integrated into an earlier local `0.5.1-alpha.1` review build and are retained
in `0.6.0-alpha.1`. Their earlier review-build labels are history, not the current application version.

The open owner findings include the overly wide occlusion control, a remaining frame-readiness modal,
incorrect gold-button scope, the Mod-switch seam, revised asset deletion, native toolbar conception,
Settings/Home reflow and missing-directory server-switch recovery. Do not mark these complete from the presence
of earlier code or passing technical tests.

## Review artifact and validation

Current local macOS artifact, relative to the active checkout:

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.1-macos-arm64.dmg`

MD5: `18029a98e4a90bf49c329b73d3abb730`. The earlier local `0.6.0-alpha` artifact is under
`build/review-history/`. A legacy checkout's `dist/0.5.1-alpha` package is not the active review artifact.

Existing validation for the delivered alpha.1 source: 2,887 Python cases passed (23 skipped), 1,369 JavaScript
cases passed across the full run and failed-item rechecks, and macOS signature/DMG integrity checks passed.
No functionality was changed, rebuilt or retested during this status reconciliation. Owner UAT remains separate;
native Windows behavior is not verified on the current macOS host.

The artifact was built before the local checkpoint commits. Its embedded Git revision may therefore reference
the preceding `d0e1b59e` base; use its App version and documented source state rather than treating that revision
as a complete list of development changes. This task has not published the 0.6.0 review work.

## Continuing work

1. Open the active worktree and verify `git branch --show-current`, `git status --short` and `pyproject.toml`.
2. Read this handoff and the relevant backlog entries together. Separate implementation, technical verification,
   owner acceptance and publication when reporting status.
3. Preserve other checkouts' uncommitted work. Do not silently switch, reset, clean or merge their working files.
4. BL-032 through BL-039 remain backlog-only until the owner authorizes implementation. Do not start those fixes
   merely because their earlier parent entries have some implementation.
5. Keep development isolated from the owner's production application, game, settings, library and caches.
