# Development status

As of 2026-10-26. Verify the actual branch, working tree and `pyproject.toml` version before reporting progress.
[Backlog](backlog.md) holds the detailed requirements and owner findings.

## Branch state

| Branch | State |
| --- | --- |
| `main` | Local version `0.6.0-alpha.2`: the published 0.5.0 baseline, the upstream syncs after it, the 0.6.0-alpha.1 review work and the BL-032 to BL-039 fixes. Not pushed. |
| `codex/v060-fixes` | The alpha.2 fixes, merged into `main`; kept until the owner accepts alpha.2. |

The 0.6.0 work is unreleased. Nothing has been tagged, pushed or published since 0.5.0.

## Feature state

| Items | State |
| --- | --- |
| BL-001 through BL-008 | Included in the published 0.5.0 baseline |
| BL-009 through BL-012 | Implemented; in the local alpha builds |
| BL-015 | Initial photography feature accepted by the owner; later requirements are separate entries |
| BL-022 through BL-029, BL-031 | Implemented for alpha.1; later owner findings are separate entries |
| BL-032 through BL-036, BL-038, BL-039 | Implemented for alpha.2; owner review in progress (macOS findings: BL-040 to BL-045; Windows not reviewed) |
| BL-037 | Design task, not started |
| BL-040 through BL-045 | Owner's macOS findings on alpha.2, planned |
| BL-013, BL-019 through BL-021, BL-030 | Planned, not implemented; BL-021 has a proposed flow only |
| BL-014 | Candidate, not scheduled |
| BL-016 through BL-018 | Deferred |

Implementation, automated checks, owner acceptance and release are separate states. Do not mark an item accepted
from passing tests or the presence of earlier code.

## Review artifact and validation

`dist/Blue-Archive-Modding-and-Patching-Tool-0.6.0-alpha.2-macos-arm64.dmg`, MD5 `c4983520dd08f486ba68e846f03b9dbe`,
built from `d4ce7094` (`chore(release): 0.6.0-alpha.2`). `main` adds only the upstream CLI sync on top of it.

On `main` after the merge: 1,441 JavaScript tests passed; 2,922 Python tests passed, 24 skipped. Native Windows
behavior is not verified on the macOS host.
