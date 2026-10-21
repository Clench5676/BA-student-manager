# Import source detection

Unity's serialized build target identifies Android, iOS or PC. Region evidence comes
from explicit package/region markers or CAB identities shared with a recoverable
official bundle. Shared resource suffixes and a repacker's new CAB identify no region.
Compression, Unity version strings and the outer filename are not platform evidence.
Thus a mobile bundle with a new CAB and no package marker used to stop as unknown,
although preview extraction and the manually selected conversion could read it.

When direct detection is incomplete, batch preflight tries all six source choices
through the same `_judge` path as manual selection. Conflicting markers and known
unsupported build targets are still errors. Candidates agreeing with partial region
or platform markers go first (one point for each); equal scores retain Global before
Japan, and Android before iOS before PC. The first passing candidate wins. These
choices describe compatible conversion inputs; indistinguishable bundles cannot
prove their historical origin.

A candidate must pass target discovery, official baseline recovery, slot checks,
Spine compatibility/version checks and the manual conversion's asset matching.
Additionally, even an exact same-platform filename must have a nonempty intersection
of comparable Unity assets with its official targets. A readable header, rendered
preview or matching filename is insufficient. No writes occur during these probes.
The accepted inferred source is retained for execution and revalidated there.

If every candidate fails, the row retains `source_unknown`, its preview and the
manual source selector. Its badge asks for manual source identification. Other
failures retain their specific statuses.
