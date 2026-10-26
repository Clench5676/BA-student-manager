# Development status

As of 2026-10-26. Verify the actual branch, working tree and `pyproject.toml` version before reporting progress.
[Backlog](backlog.md) holds the detailed requirements and owner findings.

## Branch state

| Branch | State |
| --- | --- |
| `main` | Local version `0.6.0-alpha.4`: the published 0.5.0 baseline, the upstream syncs after it, the 0.6.0-alpha.1 and alpha.2 review work, BL-020, BL-021, BL-040, BL-041, BL-043, BL-042, BL-044, BL-045, BL-046, BL-047 and BL-048. Not pushed. |
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
| BL-037 | Design task, not started |
| BL-040, BL-041, BL-043, BL-045 | Accepted by the owner on macOS (alpha.3); Windows not reviewed |
| BL-042 | Accepted by the owner on macOS (alpha.4) |
| BL-044 | Implemented for local review; owner UAT/visual acceptance pending. Single check, "Selected" label on the prefab badge, frame canvas premultiplied like the game's blend. |
| BL-047 | Reopened: button restored; new portrait/memorial-lobby switch function awaits the owner's confirmation |
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

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.4-macos-arm64.dmg`, MD5 `797021e16ca2f93a37e976610b0a6dff`,
built from the `chore(release): 0.6.0-alpha.4` commit.

On `main` before the build: 1,571 JavaScript tests passed; 2,984 Python tests passed, 26 skipped. Native Windows
behavior is not verified on the macOS host.
