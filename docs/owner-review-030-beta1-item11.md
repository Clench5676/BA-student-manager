# Owner item 11: sharp import-row thumbnails

Based on `8df5cef` on `codex/v030g`, in one separate commit. No application version
or user-facing labels changed. No owner install, Mods, library or settings were
read or changed; the asset check used the verified read-only development copy.

The previous helper copied the selection frame's outer widget rectangle into the
picture slot and treated the atlas's nine-slice cut distances as a corner radius.
That both let pictures reach outside the painted border and produced heavily
rounded result thumbnails.

Both list and result rows now use the same `selectionWindow` / `innerFrame`
helper. The frame remains the game's
`UINonEquipmentInventoryListItem/UINonEquipmentCard/Normal/Cover_Select`, with
`Card_Select_Line`, a 240 by 220 widget inclined 10 degrees in the verified assets.
The source PNG's fully painted stroke determines its inner opening; translucent
glow is excluded. Its measured source-pixel insets are **left 14, top 13, right 13,
bottom 14**, distinct from the atlas's 69/69/42/42 nine-slice cuts. These values are
measured at runtime, not hardcoded in the UI.

The helper maps those edges through the same nine-slice cuts, border shrinking and
raster rounding used to draw the frame. It retains nested transforms and pivots,
including the small center offset caused by asymmetric stroke widths. The clip
has four vertices and zero radius. Applying the prefab's shear gives the sharp
parallelogram; the picture counter-shears to remain upright and uses a centered
cover fit. The existing selection frame is above the image, hiding the sharp
picture corners beneath its opaque border. Unselected and muted list rows keep
identical geometry when the yellow frame is hidden. Result rows use the same
geometry at their existing row scale.

Files:

- `web/js/row-thumbnail.js`: measure the painted inner edge and derive the sharp
  content window, rejecting missing or incompatible frame geometry.
- `web/js/sprite-slices.js`: shared source cuts and raster-coordinate mapping.
- `web/js/import-layout.js`: prepare the frame outline and bind the shared inner
  window to both kinds of row.
- `web/js/ngui.js`: expose memory-only sprite pixels, use the shared slice mapping,
  and render the explicit four-point clip. The frame artwork itself is unchanged.
- `tests/js/row_thumbnail.test.mjs`, `tests/js/batch_import.test.mjs`,
  `tests/js/import_prefabs.mjs`, `tests/js/no_tooltips.test.mjs`,
  `tests/test_row_thumbnail.py`: geometry, page integration, renderer and real-asset
  regressions. Paths above are relative to `src/ba_modding_toolkit` for source
  files, and to the repository root for tests.

Validation:

- The row-shape regression failed on the old implementation: the thumbnail radius
  was 34 units instead of zero. It passes with the new helper.
- Pure geometry checks cover **2,160** combinations of scale, pivot, inclination,
  flip and nested scale. They assert four sharp corners, matching side incline,
  exact mapped inner extents, outer containment, and full centered cover coverage.
  Every source raster strip is checked; monotone slice maps and affine shear
  preserve containment for all points, including between sampled edge positions.
- Page tests check selected, unselected and muted list rows, selection changes,
  result rows, nested widget positioning, frame-over-image order, cover and center
  preservation, and existing text margins.
- The actual NGUI DOM renderer is checked for its four-point clip, zero radius,
  prefab shear and upright cover image.
- The verified-asset Python check passed. It reads the actual prefab, atlas and
  sprite in memory, independently checks every outer-outline strip, confirms all
  four sharp corners lie under fully opaque frame pixels, checks the straight
  inner stroke boundaries, and compares the dimensions to an independent
  nine-slice raster calculation.
- Full suites: **926 JavaScript tests passed; 1995 Python tests passed, 127 skipped**.
  The real-asset test was additionally run with the verified game view and passed.
  The three existing Python deprecation warnings remain.

Native browser/GPU antialiasing and the final on-screen appearance were not
visually checked because localhost is unavailable. No game images or other game
assets are included in the commit or bundle.
