# Owner follow-up: thumbnail corners and failed conversion notes

Baseline: `a8bab58`, branch `codex/v030g`. The original Git index cannot create
`index.lock` in this sandbox. Separate commits are delivered in
`/tmp/v030g-4.bundle`, with `a8bab58` as their prerequisite.

## 1. Smooth the measured thumbnail corners

Cause: the clip connected source-pixel scanline boundaries directly, preserving
their staircase. Requiring alpha to equal exactly 255 also treated compressed
stroke blocks with alpha 253, 250 or 242 as holes. Those false holes produced
larger notches, especially at the bottom-left corner.

`frameOutline` now includes the near-opaque stroke (within 1/16 of peak alpha)
while excluding its translucent glow. The actual frame's insets remain
`[14, 13, 13, 14]`; widget size, placement, incline and slice mapping are retained.
`innerFrame` reconstructs each measured corner with least-squares cubic curves,
shared tangent directions and dense subpixel sampling. Straight middle sides
stay straight. This retains the frame's small curved/chamfered transitions
instead of assigning a generic CSS radius. The existing shared helper supplies
selected, unselected and result rows.

Files: `src/ba_modding_toolkit/web/js/row-thumbnail.js`,
`tests/js/row_thumbnail.test.mjs`, `tests/test_row_thumbnail.py`.

Proof: the new staircase regression fails on the baseline. Tests cover compressed
stroke alpha, a known circular corner radius, seven render scales, all pivots
and flips, plus representative inclines and nested scales. The verified game-frame check independently
measures its stroke at scales 0.34, 0.54, 0.68, 0.873, 1.25, 2 and 4. At each scale
the reconstructed contour has no short axis-aligned corner steps and stays less
than one rendered pixel from the measured contour in both directions, including
the result row's enlargement. Existing renderer and shared-row checks pass.

## 2. Preserve error parameters and stage conversions inside the library

### Error notes

Cause: the backend retained only `ServiceError.code` in an entry's result. The
frontend also passed only `reason` into its formatter. Either loss erased
`{path}`, even though the translated error string expected it.

Entries and results now carry optional JSON-safe `params`, using
`ServiceError.to_json()` for Paths and nested values. Rechecking, blocked/skipped
entries, preparation, adding and applying retain those parameters. Both row-note
formatting paths receive the full error record. Existing translations are used;
no user-facing strings were added.

Tests: backend failures at preparation/add/apply/recheck, blocked-entry results,
Path/list serialization, and frontend path/missing-file interpolation in all six
locales. The parameter regressions fail on the baseline.

### Rejected path

The old conversion workspace was a system temporary directory. After rebuilding,
`ModLibrary.add()` calls `devmode.check_read()` on its output; system temp is
outside the profile's dev read roots. The library staging prefix permits some
writes, but does not grant reads. This is an application staging-location issue.

For the supplied source, the entry ID is
`0df36eeb2940bdfacf63523dfdaf584d4f0875a01a7728e4fdc647b18ef3de19`.
A read-only `_asset_match` against the dev sandbox identified target part `003`.
The reconstructed rejected path is:

```text
/var/folders/k4/5w1b33fs3zj7yd2wxp_2rb680000gq/T/bamt-library-import-<random>/0df36eeb2940bdfacf63523dfdaf584d4f0875a01a7728e4fdc647b18ef3de19/output/assets-_mx-spinelobbies-ch0169_home-_mxdependency-2024-11-18_003_assets_all_3911601207.bundle
```

`/private/var/...` is the resolved equivalent. The failed job's random directory
suffix was removed with the temporary workspace and is not in its log, so it
cannot be recovered. The rejected file is the rebuilt PC output, not the Android
source or another profile's data.

Conversion target copies and output now live under the pinned library:

```text
/Users/A200237264/Library/Caches/BAMT-Dev/data/import03/library/staging/import-<random>/<entry ID>/{targets,output}/<bundle name>
```

Both read and write guards validate the staging directory before creation. The
temporary workspace is cleaned after the job. No guard was broadened and no dev
tool change is needed. Real synthetic Android bundles convert, enter the library
and apply with the dev guards active, both with and without an export folder.
A second test deliberately restores the former system-temp location and proves
that the guard refuses precisely its `output/<target name>` at the library read.

Files: `src/ba_modding_toolkit/webui/batch_import.py`,
`src/ba_modding_toolkit/web/js/batch-import.js`, `tests/test_batch_import.py`,
`tests/test_mod_origin.py`, `tests/js/batch_import.test.mjs`.

## Validation and limits

Only related suites were run: **112 JavaScript tests and 203 Python tests passed**.
JavaScript: `row_thumbnail.test.mjs`, `batch_import.test.mjs`,
`no_tooltips.test.mjs`. Python: `test_row_thumbnail.py`, `test_batch_import.py`,
`test_mod_origin.py`, `test_devmode.py`, with the verified read-only game view
enabled. The existing Python locale deprecation warning remains.

No localhost or native application was launched. Browser/WebView antialiasing
has not been observed here. The supplied Mod was inspected read-only for target
matching; its complete import/apply was not rerun in the owner's dev profile.
All conversion/import tests used isolated temporary data. No owner install,
Mods, library or settings were changed. No application version was changed.
