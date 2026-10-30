# Development status

As of 2026-10-29. Verify the actual branch, working tree and `pyproject.toml` version before reporting progress.
[Backlog](backlog.md) holds the detailed requirements and owner findings.

## Branch state

| Branch | State |
| --- | --- |
| `main` | Local version `0.6.0-alpha.14`: the published 0.5.0 baseline, the upstream syncs after it, the 0.6.0-alpha.1 and alpha.2 review work, BL-020, BL-021, BL-040, BL-041, BL-043, BL-042, BL-044, BL-045, BL-046, BL-047, BL-048 the alpha.5 to alpha.8 review fixes and the prerelease-only BL-020/BL-021 previews (BL-037, BL-044, BL-047, BL-049 through BL-053), BL-055, BL-057 and BL-058. Not pushed. |

The 0.6.0 work is unreleased. Nothing has been tagged, pushed or published since 0.5.0.

## Feature state

| Items | State |
| --- | --- |
| BL-001 through BL-008 | Included in the published 0.5.0 baseline |
| BL-009 through BL-011 | Accepted by the owner (2026-10-27); Windows not reviewed |
| BL-012 | Accepted by the owner on the lead's evidence (2026-10-27) |
| BL-015 | Initial photography feature accepted by the owner; later requirements are separate entries |
| BL-022 through BL-024, BL-028, BL-029 | Accepted by the owner (2026-10-27); Windows not reviewed |
| BL-026 | Accepted by the owner on Windows (alpha.12) |
| BL-025, BL-027 | Implemented; Windows-only. BL-025 needs a real in-app update; BL-027 see BL-062 |
| BL-031 | Accepted by the owner (2026-10-27) |
| BL-033 through BL-036, BL-038, BL-039 | Accepted by the owner on macOS (alpha.2); Windows not reviewed |
| BL-032 | Closed: superseded by BL-040 |
| BL-037 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
| BL-040, BL-041, BL-043, BL-045 | Accepted by the owner on macOS (alpha.3); Windows not reviewed |
| BL-042 | Accepted by the owner on macOS (alpha.4) |
| BL-044 | Review 1 (runtime-sliced badges) accepted on macOS (alpha.6); review 2 closed as won't fix by the owner. |
| BL-047 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
| BL-049 | Accepted by the owner on macOS (alpha.7): page titles removed; Windows not reviewed |
| BL-050 | Accepted by the owner on macOS (alpha.6); Windows not reviewed |
| BL-051 | Accepted by the owner on macOS (alpha.6); Windows not reviewed |
| BL-052 | Accepted by the owner on macOS (alpha.8); Windows not reviewed |
| BL-053 | Accepted by the owner on macOS (alpha.7); Windows not reviewed |
| BL-046 | Closed by the owner without UAT (CLI-only) |
| BL-048 | Accepted: CLI no longer built, installed or released |
| BL-020 | Accepted by the owner on macOS (alpha.9, simulated prompt); Windows not reviewed |
| BL-021 | Accepted by the owner on macOS (alpha.12); Windows not reviewed |
| BL-013, BL-019, BL-030 | Planned, not implemented |
| BL-054 | Deferred by the owner for research; design proposal on file |
| BL-056 | Funnel: AI-assisted portrait refinement, being refined |
| BL-059 through BL-062 | Implemented for local review (alpha.14, Windows bundle); owner acceptance on Windows pending |
| BL-063 | Pointer failures now retried and logged (alpha.14); cause open, next report needed |
| BL-057, BL-058 | Accepted by the owner on macOS (alpha.12); Windows not reviewed |
| BL-055 | Implemented for local review; owner UAT/visual acceptance pending. Loaded drop work cannot hold shutdown; early loop-exit trigger remains logged and unresolved. |
| BL-014 | Candidate, not scheduled |
| BL-016 through BL-018 | Deferred |

Implementation, automated checks, owner acceptance and release are separate states. Do not mark an item accepted
from passing tests or the presence of earlier code.

## Review artifact and validation

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.12-macos-arm64.dmg`, MD5 `8cf157b7e4fd475be8fa25afce5dceaf`,
built from `00ef7aba` (`chore(release): 0.6.0-alpha.12`). For review: BL-057 (English "alt") and BL-058 (Import screen).

On `main` before the build: 1,919 JavaScript tests passed; 3,408 Python tests passed, 26 skipped (with the official
development view). Native Windows behavior is not verified on the macOS host.
