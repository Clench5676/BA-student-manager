# Development status

As of 2026-10-26. Verify the actual branch, working tree and `pyproject.toml` version before reporting progress.
[Backlog](backlog.md) holds the detailed requirements and owner findings.

## Branch state

| Branch | State |
| --- | --- |
| `main` | Local version `0.6.0-alpha.7`: the published 0.5.0 baseline, the upstream syncs after it, the 0.6.0-alpha.1 and alpha.2 review work, BL-020, BL-021, BL-040, BL-041, BL-043, BL-042, BL-044, BL-045, BL-046, BL-047, BL-048 and the alpha.5 and alpha.6 review fixes (BL-037, BL-044, BL-047, BL-049 through BL-053). Not pushed. |
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
| BL-037 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
| BL-040, BL-041, BL-043, BL-045 | Accepted by the owner on macOS (alpha.3); Windows not reviewed |
| BL-042 | Accepted by the owner on macOS (alpha.4) |
| BL-044 | Review 1 (runtime-sliced badges) accepted on macOS (alpha.6); review 2 closed as won't fix by the owner. |
| BL-047 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
| BL-049 | Accepted by the owner on macOS (alpha.7): page titles removed; Windows not reviewed |
| BL-050 | Accepted by the owner on macOS (alpha.6); Windows not reviewed |
| BL-051 | Accepted by the owner on macOS (alpha.6); Windows not reviewed |
| BL-052 | Accepted on macOS (alpha.7) except the fullscreen Back placement, which must match the memorial lobby's; fix not started |
| BL-053 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
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

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.7-macos-arm64.dmg`, MD5 `6403a0332094afa28708fc11704a0089`,
built from `26ccfa9e` (`chore(release): 0.6.0-alpha.7`).

On `main` before the build: 1,885 JavaScript tests passed; 3,076 Python tests passed, 26 skipped (with the official
development view). Native Windows behavior is not verified on the macOS host; BL-037's native behaviour needs owner
acceptance on both platforms.
