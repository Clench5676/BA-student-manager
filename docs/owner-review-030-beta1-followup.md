# Owner follow-up A–F

Based on `81b79a8` on `codex/v030g`. The Git index is blocked in this sandbox;
separate commits are delivered in `/tmp/v030g-3.bundle`. No application version,
owner labels, owner install, Mods, library or settings were changed. Assets used
for the additional checks came from the verified read-only development copy.

Validation: **935 JavaScript tests passed; 2002 Python tests passed, 127 skipped**.
The additional asset run passed four tests: three verified-asset checks and the
existing gradient-metadata unit check. The three existing Python deprecation
warnings remain. Regressions for A, C, E and F were also run against `81b79a8` and
failed there. No localhost or native application was launched.

## A. Loading text: measure the browser baseline

The earlier check verified a placement formula instead of the final browser
layout. That was insufficient. Stale layouts could also leave the text in its
26 px CSS fallback, because the expected label effect metadata was missing.

The progress label now renders in a hidden, connected container. A zero-height
inline-block probe measures the actual alphabetic baseline of its text span.
The measured difference from the derived sprite ink line is converted from
viewport coordinates to stage units and applied as a translation. Only then is
the label published. The sprite indicator waits for the latest progress-label
publication, so it cannot appear with a still-uncorrected progress label. Stale
render attempts cannot replace a newer text update. Closing an overlay also
discards an upgrade waiting on label measurement. Even the CSS fallback is
measured when no usable prefab label exists.

Text/locale updates build and measure a replacement. Resize, stage resize and
font-loading events remeasure the current label; translations do not accumulate
on repeated measurements. The target line is still derived from the non-descending
letter sprites, excluding the `g`, dots and Arona widget. Initial label placement
may use an estimate; the final position is determined by the DOM measurement.

For the supplied Range metrics:

- Measured alphabetic baseline: `998.5 + (37.5 - 30 - 7) / 2 + 30 = 1028.75`.
- Target `1013.45` gives **-15.30 stage units**; the unrounded sprite target gives
  approximately **-15.30135**.
- Tests cover stage scales 0.5, 1 and 1.75, repeat measurement, changed text metrics,
  and hidden preparation before first publication.

Files: `web/js/loading-baseline.js`, `loading.js`, `ngui-label.js`.
Tests: `tests/js/loading_baseline.test.mjs`, `loading.test.mjs`,
`ngui_labels.test.mjs`, and the verified loading-letter test in
`tests/test_owner_review.py`. Source paths here are relative to
`src/ba_modding_toolkit`; test paths are relative to the repository root.

The new baseline correction has not been observed in Chrome or the native WebView
here. The supplied measurements are regression inputs, not a new screen reading.

## B. Favorite: retain the approved game artwork

No Favorite artwork or state mapping was changed. The off sprite's baked inset
stays. The approved Pin_On gradient remains `#fa8c21` to `#e6780e`.
The cache fix below lets a fresh export deliver that metadata consistently.

## C. Export HTTP cache

Every consented light asset now uses **`Cache-Control: private, no-cache`** and a
strong ETag derived from the HTTP export schema plus the actual response bytes.
Matching validators receive 304; changed data or schema receives the new body.
This covers layouts, texture indexes, sprites and UI textures. Atlas indexes and
heavy/unconsented exports retain `no-store` where they already required it.

A bootstrap export epoch is also inserted into the HTML. UI export requests and
CSS asset URLs carry that epoch, so an existing one-day cache entry under an old,
unversioned URL cannot mask the first corrected response. Layout requests
explicitly use `cache: "no-cache"`; indexes keep `no-store`. Future resource or
export-content changes require validation even when a resource URL stays the
same. Identical bytes can safely reuse a matching validator.

Tests model a legacy fresh response without effect/gradient fields, verify that
the client forces validation, and check updated fields. Server tests cover all
light-export categories, matching and changed validators, schema changes, the
bootstrap/CSS epoch, and unchanged no-store rules.

Native configuration was checked in `webui/main.py`, `webui/server.py` and the
installed pywebview 6.2.1 backend code. The app passes `private_mode=True` and a
`data_dir/webview` storage path. EdgeChromium enables InPrivate mode. Cocoa's
private branch clears all website data asynchronously on its data store. The
server defaults to port 0, allowing the OS to choose the native origin; a supplied
fixed port and the dev browser can keep an origin stable. These settings are not
used as a cache correctness guarantee. Actual cache persistence across native
launches was not exercised.

Files: `webui/server.py`, `web/js/api.js`, `ngui.js`, `cursor.js`.
Tests: `tests/test_http_exports.py`, `tests/js/ui_exports.test.mjs`.

## D. Why the shared slice arithmetic exists

Item 11 needed to map a source-pixel inner edge to the exact rendered frame.
That requires the renderer's source-border clamping, destination-border shrinking,
two-times raster dimensions and rounding. Sharing `spriteBorders` and `sliceAxis`
prevents the frame renderer and thumbnail clip from using different arithmetic.
It serves the row-frame alignment in item 11 and E; it does not establish the
loading baseline, cache behavior or row text size.

The extraction into `sprite-slices.js` retains the previous drawing rectangles,
image smoothing and drawing order. A regression independently executes the old
arithmetic and compares every source/destination rectangle across **180 grids**,
including overlapping source borders, small widgets and fractional sizes/scales.
All match exactly. No additional visual change to other sliced sprites is
intended. Restored label outlines and Pin_On gradients result from fresh export
metadata. Native GPU pixel equivalence was not directly observed.

## E. Follow the frame's own inner corner contour

The previous four-point clip has been replaced by the full measured inner contour.
For each source scanline, `frameOutline` locates the painted stroke's inner left
and right edges. Half-pixel scanline centers retain the small corner transitions.
`innerFrame` maps every contour point through the same slice/raster mapping as
the frame, then applies its transforms and incline. The polygon supplies the
corner shape; no large CSS radius is inferred from atlas slice distances.
Selected, unselected, muted and result rows all use this helper. The image remains
upright, centered and covered; the selection frame stays above its edges.

The detail Faces/Dialogue thumbnails use a fixed CSS radius of 16 units; the
`clipped(...)` helper defaults to 20 when no explicit radius is supplied. The
selection frame's baked inner edge has its own small rounded/beveled transitions
and asymmetry. A circular radius of 16 or 20 would approximate a different shape,
so the measured frame contour takes precedence as requested.

The verified-asset test independently scans every inner-edge row of the actual
`Card_Select_Line` PNG and compares every mapped point at the rendered scale,
including result-row enlargement. The discrepancy is below one pixel. Tests also
check containment, complete opening coverage, nested transforms, selection-state
invariance, rendering of the full polygon and centered cover behavior.

Files: `web/js/row-thumbnail.js`, `import-layout.js`.
Tests: `tests/js/row_thumbnail.test.mjs`, `batch_import.test.mjs`,
`no_tooltips.test.mjs`, `tests/test_row_thumbnail.py`.
Native antialiasing and final on-screen appearance remain unobserved.

## F. Restore the beta type scale

Body text now stays at **42 NGUI units**, the beta.1 maximum/floor for these rows.
A long badge, route, note, hidden state, earlier task snapshot or another locale
cannot shrink other fields or rows. Sizing calls receive the currently displayed
row set; the fixed type floor replaces the shared minimum-fit calculation.

Widths are measured from the actual current-locale strings. Normal badges receive
more width when needed; kind text uses its measured room. The unknown-source
badge moves below the metadata/kind block. Metadata and routes wrap in full at the
same type size, preserving file count and size text. Only notes use a one-line
ellipsis, with their complete text retained as the accessible label. When more
lines are needed, the prefab background and row hit area extend downwards. The
name, thumbnail, divider, check control and right action retain their top anchors.
Result rows use their own beta type scale rather than inheriting a reduced list
size or invisible task-state constraints.

The following comparison executes `d36ae82`'s actual `rowTextSize` code with the
bundled RHR font's measured advances. Each case is a single en-US Memorial Lobby
row, metadata `ch0156_home - 1 file, 22.4 MB`; the failed result has a very long
path in its note. Stage scale is 1. The result row retains its existing 0.62 row
scale; the list retains 0.54. These are code/font calculations, not new browser
pixel measurements.

| Visible case | d36ae82 NGUI size | d36ae82 stage px | New NGUI size | New stage px |
| --- | ---: | ---: | ---: | ---: |
| One Ready row | 42.0 | 25.40 | 42.0 | 25.40 |
| One Pending Conversion row | 27.9 | 16.87 | 42.0 | 25.40 |
| One unknown-source row | 38.2 | 23.10 | 42.0 | 25.40 |
| Failed result with a long note | 42.0 | 29.16 | 42.0 | 29.16 |

The old unknown-source row used its old Cannot Import badge; the new, longer
instruction fits on its separate line. The single Pending Conversion reduction
also occurs in the beta.1 code: its 300-unit badge cell drives that shared size
down. The new layout removes that reduction. Earlier follow-up code additionally
allowed notes and invisible states to drive the shared minimum; those inputs are
removed. List names remain approximately 37.50 stage px in English.

Files: `web/js/import-layout.js`, `batch-import.js`.
Tests: the six-locale layout checks and the independent ready/conversion/unknown/
long-failure-note regression in `tests/js/batch_import.test.mjs`. They verify the
42-unit floor, intact metadata, wrapped-line bounds, nonoverlapping cells, growing
row geometry and note ellipsis. No new user-facing strings were introduced.
