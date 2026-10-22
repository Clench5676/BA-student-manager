# Import source detection

Unity's serialized build target identifies Android, iOS or PC. Region evidence comes
from explicit package/region markers or CAB identities shared with a recoverable
official bundle. Full external reference and stream paths retain package and platform
hints in parent directories; dependency matching still uses basenames. References
are inspected as metadata, without following those external paths. Shared resource
suffixes, a repacker's new CAB, compression, Unity version strings and the outer
filename do not prove a platform or region.

When direct detection is incomplete, preflight tries only the unknown dimensions.
A reliable platform or region is a constraint, including a region established by a
shared official CAB. Conflicting markers and unsupported build targets remain errors.
The remaining choices use Global before Japan and Android before iOS before PC. The
first valid choice wins. These choices describe compatible conversion inputs;
indistinguishable bundles cannot prove their historical origin. Manual selections
also cannot contradict reliable evidence.

Target discovery, official baseline recovery, slot discovery and Spine compatibility
checks run once per Mod analysis. Inspected contents, loaded bundles and comparable
asset keys are cached per file for that analysis. Candidate checks reuse that snapshot;
they do not recursively re-inspect the source or official files. For a generated
one-source, one-target fixture, both a first-choice success and an exhausted fallback
load each bundle once. Content identity discovery for renamed inputs may require an
additional read. Texture decoding and mesh stream validation add necessary work, once
per input, regardless of the number of candidates. The snapshot is released after the
row is judged and execution uses a fresh inspection.

An inferred source must satisfy the target and cross-region slot rules, Spine version
checks and asset matching. Even an exact filename must have comparable assets. The
execution reader must be able to extract every comparable Mod asset present: textures,
text assets (including atlas and skeleton), meshes and animation clips. Every extracted
key must have a matching target across the selected official bundles. A readable
header, rendered preview or nonempty name intersection alone is insufficient. The
source choice selects the conversion route; it does not override Unity's serialized
metadata or change the asset decoder.

Execution fails when a requested Mod asset cannot be extracted or applied, or has no
matching target. All targets must pass application before any converted output is
saved. The failure note names the asset and file where available, in all six locales.
Manual and automatic source choices use the same strict updater; a partial conversion
cannot be added or applied as a completed Mod. Unchanged assets count as applied, and
assets split across several target bundles are checked together.

Source probes do not install or apply Mods. Converted entries remember the complete source
part hashes, target server and platform, official bundle identities, and stored output filenames and hashes.
Analysis recognizes those inputs as already in the library. An older library entry without
provenance is recognized when its recorded `source_hashes` contains the same source
part mapping, target and official release identity. Without those hashes, analysis converts into temporary
official copies and compares every named output part with eligible old entries. Compression and CRC tails
are normalized for this comparison; serialized content, references and streams must match. This check
never imports or applies the temporary result. Optional recognition failures leave the
normal compatibility verdict intact. Recognition results and file hashes are cached by revision.
Changed inputs, outputs, target releases and removed entries invalidate the association.
Library inspection may perform migration saves. Both analysis and source selection run as
library writer jobs, holding library moves and quitting until they finish. If no candidate
passes, the row retains `source_unknown`, its preview and the manual source selector.
Both individual and merged state labels ask for manual source identification. Other
failures retain their specific statuses.

Every analyzed row emits an INFO verdict with its kind, state, reason code, parameters,
redacted filenames, parts, platforms and conversion route. Reports from Settings and error
popups include the current import list, including selections and blocked reasons. Large
snapshots report their total and omitted row counts. The report uses the displayed UI
language; the startup log reads the same saved language preference before game detection.

Current-name and CRC-only replacements preserve whole bundle bytes. Admission requires
matching serialized CAB identities and object ID/type layouts, compatible Unity/platform
metadata and consistent region evidence. The effective set combines replacement parts with
retained official parts and validates external references and streams. Spine versions and
retained atlas dimensions are checked even when update filters exclude those assets.
Failure messages are sanitized before reaching either the session log or job log.
