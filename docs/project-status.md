# Development status

As of 2026-10-26. Verify the actual branch, working tree and `pyproject.toml` version before reporting progress.
[Backlog](backlog.md) holds the detailed requirements and owner findings.

## Branch state

| Branch | State |
| --- | --- |
| `main` | Local version `0.6.0-alpha.5`: the published 0.5.0 baseline, the upstream syncs after it, the 0.6.0-alpha.1 and alpha.2 review work, BL-020, BL-021, BL-040, BL-041, BL-043, BL-042, BL-044, BL-045, BL-046, BL-047 and BL-048. Not pushed. |
| `codex/whats-new` | BL-020 and BL-021, merged into `main`; owner review deferred until after the 0.6.0 release. |

The 0.6.0 work is unreleased. Nothing has been tagged, pushed or published since 0.5.0.

## Feature state

| Items | State |
| --- | --- |
| BL-001 through BL-008 | Included in the published 0.5.0 baseline |
| BL-009 through BL-012 | Implemented; in the local alpha builds |
| BL-015 | Initial photography feature accepted by the owner; later requirements are separate entries |
| BL-022 through BL-029, BL-031 | Implemented for alpha.1; later owner findings are separate entries |
| BL-033 through BL-036, BL-038, BL-039 | Accepted by the owner on macOS (alpha.2); Windows not reviewed |
| BL-032 | Implemented for alpha.2; the English label overflow continues as BL-040 |
| BL-037 | Implemented for local review; owner UAT/visual acceptance pending. Native gestures/menu repair and all five immersive states have fake-host/controller coverage; Windows not reviewed. |
| BL-040, BL-041, BL-043, BL-045 | Accepted by the owner on macOS (alpha.3); Windows not reviewed |
| BL-042 | Accepted by the owner on macOS (alpha.4) |
| BL-044 | Implemented for local review; owner UAT/visual acceptance pending. Review 1 badges widen leftward with official-view-verified L14/R36 runtime slices; review 2 art covers the prefab frame opening. |
| BL-047 | Implemented for local review; owner UAT/visual acceptance pending. Direct fullscreen handoffs retain preview selection and skip detail framing restoration. |
| BL-049 | Implemented for local review; owner UAT/visual acceptance pending. Caption-sized titles use DOM measurement in native and fallback rows. |
| BL-050 | Implemented for local review; owner UAT/visual acceptance pending. Hall removes Back and reclaims its title slot with native clearance. |
| BL-051 | Implemented for local review; owner UAT/visual acceptance pending. Bar/scrollbar slices share the NGUI raster; scale/DPR geometry verified. |
| BL-052 | Implemented for local review; owner UAT/visual acceptance pending. Shared prefab corner margin covers Hall, detail/fullscreen and both cameras with native-row clearance. |
| BL-053 | Implemented for local review; owner UAT/visual acceptance pending. Backend/gallery Applied is scoped to the shown Collection target; separate detail-page thumbnail picker not identified (stop rule). |
| BL-046 | Closed by the owner without UAT (CLI-only) |
| BL-048 | Accepted: CLI no longer built, installed or released |
| BL-020 | Implemented for local review; owner UAT/visual acceptance pending. Exact-release notes and empty-body link fallback. |
| BL-021 | Implemented for local review; owner UAT/visual acceptance pending. Tour framework and Settings replay; published registry empty, 0.6.0 draft awaiting owner review. |
| BL-013, BL-019, BL-030 | Planned, not implemented |
| BL-014 | Candidate, not scheduled |
| BL-016 through BL-018 | Deferred |

Implementation, automated checks, owner acceptance and release are separate states. Do not mark an item accepted
from passing tests or the presence of earlier code.

## Review artifact and validation

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.5-macos-arm64.dmg`, MD5 `3c57389f4e2b66b5a15632c82a7637e0`,
built from `95999888` (`chore(release): 0.6.0-alpha.5`).

On `main` before the build: 1,646 JavaScript tests passed; 3,028 Python tests passed, 26 skipped. Native Windows
behavior is not verified on the macOS host; BL-037's native behaviour needs owner acceptance on both platforms.
