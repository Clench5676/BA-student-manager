# BL-056 portrait refinement experiment

Date: 2026-10-27. Third run; experiment report ready for owner review.

## Outcome

The built-in image service worked. This continuation reused D1 from the second run, generated two further
restoration variants (D2 full atlas and D3 unrotated attachment), and generated one style-repair variant (S1).
All four outputs and their evaluated copies are local. The original Shiroko (Cycling) detail asset is one
1024 × 1024 Spine atlas, not a large static portrait. Its identity, original measurements, material properties
and region layout below are retained from the first run; the saved input was revalidated through `GameAssets`.

The output can look more polished, particularly the isolated attachment, but these samples do not establish
faithful recovery of lost original detail. Whole-atlas prompting did not keep alpha or exact region geometry.
D2's page silhouette IoU was 0.946; S1's was 0.521 after restoring the source canvas size. S1 simplified shading
as requested but also changed shapes and lettering. D3 retained the intentionally blank face and had 0.952 IoU
within its edited attachment, while still redrawing details. These are measured fidelity limits, not owner UAT.

A conservative local reassembly preserved the original page size, atlas/skeleton bytes, all alpha bytes,
partial-alpha RGB, pixels outside the regions, and two-pixel region borders. That proves pixel/layout controls
are possible, not that the resulting character renders correctly. The guard retains most original pixels and
can blend misaligned internal features; S1 shows this problem. No sample is approved as game-ready.

A real `codex exec` probe was attempted with ChatGPT login and `--image`. It failed before a turn or image event
with `failed to initialize in-process app-server client: Operation not permitted (os error 1)`. Non-interactive
image generation therefore remains unverified in this environment. The separate built-in calls succeeded.
The existing headless composition path requires SpineViewerCLI; tests' tool discovery found neither viewer nor
converter, so no character render, game repack, GUI, browser preview or screenshot was performed.

Scope: experiment only. No App UI, locale, shipped code path, package, version, branch switch, push, or game
installation changes. Only this report and one BL-056 status line are included in the new documentation commit.
BL-056 remains a funnel item. The owner's game install was never accessed. Official input uploads used only the
explicitly authorized built-in service; no API-key fallback, third-party service or model substitution was used.

The previous cache-directory write blocker is resolved by the owner's new `/private/tmp/bl056/` destination and
permission for the tool's automatic local copies under `~/.codex/generated_images/`. All evaluated generated
outputs were copied into the experiment folder. No image is embedded in this report, committed, shipped or
published. See the complete image inventory in section 6.

Worktree: `/Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment`.
Branch: `codex/portrait-refine-experiment`. Continuation starting HEAD:
`8df3ee87894e0c8d2070be747410a9ac227f7abb`; main: `962cc999b4ebd973d5ad877f797dbd2a981ad464`.

## 1. Target, provenance, and original atlas

Verified by running the worktree's `GameAssets`, `AssetCache(allowed=False)`, `get_search_dirs`, `spine_cores('spr')`,
and `spine_files('spr', 'shiroko_ridingsuit_spr')`. No preview disk cache was supplied. The sole asset source was:

`/Users/A200237264/Library/Caches/BAMT-Dev/views/steam-3557621-7791673520712697115-1955d55449`.

The shipped catalogue maps English **Shiroko (Cycling)** to `shiroko_ridingsuit`, aliases `ch0065` and
`shiroko_cycling`. Discovery finds exactly `shiroko_ridingsuit_spr` for its portrait core. The separate static
collection image is `Student_Portrait_Shiroko_ridingsuit_Collection`; it was not mistaken for the detail Spine
portrait or used as the baseline. The detail screen uses `v.spr` in `web/js/detail.js`; its framing node is
`UICharacterDetail/Inventory_ListControl/CharacterPos`, also covered by `test_real_detail_layout_places_the_portrait`.
No prefab was changed or constructed for this experiment.

The four official bundle filenames, byte sizes, and SHA-256 hashes are:

| Filename | Bytes | SHA-256 |
| --- | ---: | --- |
| `assets-_mx-spinecharacters-shiroko_ridingsuit_spr-_mxdependency-2024-11-18_000_assets_all_158254298.bundle` | 4381 | `a05210d317081d7c8cb8eed6442c0a8a28621654171961bd5430c3f6f6922156` |
| `assets-_mx-spinecharacters-shiroko_ridingsuit_spr-_mxdependency-2024-11-18_001_assets_all_3531359419.bundle` | 2590 | `2c01412e3369841cd340ce95b3b06f3b0a404189f29bea1aea0a6c7415efd32c` |
| `assets-_mx-spinecharacters-shiroko_ridingsuit_spr-_mxdependency-2024-11-18_002_assets_all_1566018280.bundle` | 8722 | `50b5f790c813508855ce0e1b2cb28bf5cd3db78bbf15694245335b73fc923ed0` |
| `assets-_mx-spinecharacters-shiroko_ridingsuit_spr-_mxdependency-2024-11-18_003_assets_all_782832622.bundle` | 424685 | `8075325c8982d3509c5f5a7bf81c4fe287bc56074bec6f8d6bfdbaf3eb76d21e` |

Original extraction metadata, reused and verified against the saved third-run inputs:

| File | Property | SHA-256 |
| --- | --- | --- |
| `shiroko_ridingsuit_spr.skel` | Spine 4.2.33; 10656 bytes | `d2b7a81001644fbb8439269dd97562da782e9a4ffe609d7cf78f9f6b60b49bba` |
| `shiroko_ridingsuit_spr.atlas` | One page; 13 regions | `67f05b0ac3c031e2cfdcc4535d453bcebc1132ac335efa43a52f225ae387c0d4` |
| `shiroko_ridingsuit_spr.png` | 1024 × 1024 RGBA; App-export PNG 1143102 bytes | `506ccb08675931568ba34df66cb2bbf55d40f3b0e7be4d7f994916baeefa526d` |

The Unity texture is **BC7** (`TextureFormat` 25), one mip level, 1048576 compressed-image bytes reported by
`m_CompleteImageSize`, and clamp wrapping (`m_WrapU = m_WrapV = 1`). The atlas declares `RGBA8888`, linear min/mag
filtering and no repeat. Atlas page format describes the atlas/export; it does not mean the Unity texture is
uncompressed RGBA8888.

Region positions use atlas top-left page coordinates. Size is the atlas's unrotated trimmed size; rotation swaps
the stored rectangle's width and height. Original size and offset describe the untrimmed attachment space.

| Region | x, y | Trimmed w × h | Rotated | Original w × h | Offset x, y |
| --- | --- | --- | --- | --- | --- |
| `01_normal` | 2, 164 | 90 × 69 | no | 90 × 69 | 0, 0 |
| `00_default` | 2, 164 | 90 × 69 | no | 90 × 69 | 0, 0 |
| `02_respond` | 2, 235 | 90 × 71 | no | 90 × 71 | 0, 0 |
| `03_smile` | 2, 96 | 89 × 66 | no | 89 × 66 | 0, 0 |
| `04_embarrassed` | 2, 308 | 89 × 73 | no | 89 × 73 | 0, 0 |
| `05_serious` | 2, 28 | 89 × 65 | no | 89 × 65 | 0, 0 |
| `06_depressed` | 93, 318 | 91 × 63 | no | 91 × 63 | 0, 0 |
| `eyeclose` | 93, 94 | 80 × 69 | no | 80 × 69 | 0, 0 |
| `fronthair` | 2, 383 | 99 × 72 | no | 99 × 72 | 0, 0 |
| `halo1` | 2, 903 | 204 × 120 | no | 204 × 121 | 0, 1 |
| `halo2` | 2, 828 | 98 × 75 | no | 98 × 75 | 0, 0 |
| `shiroko_ridingsuit` | 419, 3 | 602 × 499 | yes | 753 × 972 | 0, 473 |
| `shiroko_ridingsuit1` | 2, 457 | 753 × 566 | no | 753 × 972 | 0, 0 |

All 13 stored rectangles are within the page. The minimum rectangle-to-page margin is 1 pixel. The minimum
nonnegative rectangle gap is 0; four rectangle pairs overlap, including the two expression aliases at exactly the
same coordinates. These measurements do **not** establish a uniform padding/extrusion width: the atlas has no
explicit padding field, overlapping bounding boxes do not establish overlapping visible attachment pixels, and
the silhouette/mesh was not rendered. Some adjacent expression boxes have 2-pixel gaps. Do not infer a safe
universal padding width or independently overwrite every rectangular bounding box after different edits.

Alpha observations:

- Zero alpha: 711526 pixels; partial alpha (1–254): 137925; full alpha (255): 199125. Total: 1048576.
- Material `shiroko_ridingsuit_spr_Material` has `_StraightAlphaInput = 0.0` and no valid keywords: its setting
  indicates premultiplied input. The atlas omits `pma`.
- 27147 partial-alpha pixels have at least one RGB channel greater than alpha + 4. Thus decoded pixels do not
  universally satisfy the simple RGB ≤ alpha test for strict PMA. The material declaration alone is insufficient
  to justify blindly converting the exported page. The cause of this discrepancy is unverified.
- `gameassets/spine.py:extract_spine` converts to RGBA and encodes the decoded pixels without premultiplication or
  unpremultiplication. `tests/test_spine_alpha.py` explicitly pins that behavior regardless of material/atlas PMA.
  The existing browser player sets `premultipliedAlpha: false` in `detail.js` and `thumbs.js`. No renderer behavior
  was changed or visually validated here.

## 2. Blur baseline and detail-restoration trial

First-run baseline environment: Python 3.12.11, Pillow 12.0.0, UnityPy 1.23.0. Measurement/extraction took 0.497 seconds in the recorded
run; this is **not generation latency**. Unity decoding emitted nonfatal sandbox-denied CPU `sysctl` warnings.

Method, verified by running:

1. Decode the App-export PNG in memory to RGBA. Use the stored RGB values, without alpha conversion or color-space
   linearization. Pillow `convert('L')` supplies 8-bit luminance for the Laplacian.
2. Mask alpha ≥ 250, erode with a 3 × 3 minimum filter, and exclude each packed rectangle's inner 2-pixel outline.
   Exclude the page's outermost row/column. This leaves 254722 samples, including alpha 250–254.
3. Compute `L = left + right + up + down - 4 * center`, then population variance `mean(L²) - mean(L)²` on that mask.
   Result for the sole page: **5311.423176**, in squared 8-bit luminance units.
4. As an effective-resolution proxy, bicubic-downsample RGB and bicubic-reconstruct to 1024 × 1024. Compute RGB RMSE
   over the same mask with Pillow `ImageChops.difference` and `ImageStat.Stat(..., mask).rms`, combining channels as
   `sqrt((R_rms² + G_rms² + B_rms²) / 3)`. Choose the smallest tested size with RMSE ≤ 2/255 of the channel range.

| Candidate intermediate resolution | Scale | Reconstruction RGB RMSE, 0–255 units |
| --- | ---: | ---: |
| 128 × 128 | 0.125 | 35.110002 |
| 256 × 256 | 0.250 | 26.760716 |
| 384 × 384 | 0.375 | 21.732555 |
| 512 × 512 | 0.500 | 17.988074 |
| 640 × 640 | 0.625 | 14.902063 |
| 768 × 768 | 0.750 | 12.265361 |
| 896 × 896 | 0.875 | 9.698131 |
| 1024 × 1024 | 1.000 | 0.000000 |

The proxy therefore selects **1024 × 1024**. This is a downsampling-reconstruction threshold, not an estimate of
the artist's original canvas or recoverable true detail. Sharp outlines, compressed pixels, texture, and noise
can raise both metrics. It does not confirm the owner's perceptual blur observation or the lead's enlargement
diagnosis. This particular detail source is only 1024 square; the general claim that portraits are mostly large
and blurry remains untested across the collection. No sharpening result should be called restored original
detail solely because Laplacian variance rises.

### Executed restoration variants

D1 is the second-run conservative restoration reused at the owner's request. Its automatic file and experiment
copy were verified byte-identical (SHA-256 listed below). Retained `d1-prompt.txt` and
`d1-generation-metadata.json` record its exact prompt and **84.835 s** timing. These are prior-run evidence rather
than a newly timed generation. D2 and D3 are distinct newly executed variants, with tool calls observed in this
run. The prior partial report is preserved locally as `prior-report.md`.

D2 used the full original atlas. D3 cropped the known `shiroko_ridingsuit` packed rectangle `(419, 3, 499, 602)`
and unrotated it with Pillow `ROTATE_270` to 602 × 499. This is identified atlas data, not a guessed portrait crop.
It includes an unrelated-looking bicycle fragment from an overlapping packed rectangle; the prompt explicitly
preserved it. The intentionally blank face was also preserved for expression overlays. A reverse-rotation
control recovered the original crop byte-for-byte. D3's returned patch was Lanczos-resized to 602 × 499,
rotated back with `ROTATE_90`, and copied without an alpha paste mask at `(419, 3)` into an original-page copy.
The resulting `d3-upper-body-page.png` is the pre-guard D3 page used for page comparisons.

All new calls used `referenced_image_paths` and `transparent_background: true`. No quality, seed, input-fidelity,
size or model argument is exposed by this session's built-in tool. Requested dimensions were prompt text;
returned PNG dimensions are measured artifacts, not independently observed backend generation resolutions.

| Trial | Returned image | Tool-call time | Evaluated page |
| --- | --- | ---: | --- |
| D1, prior conservative | 1254 × 1254 | 84.835 s, recovered prior-run metadata | Lanczos to 1024 × 1024 |
| D2, line-focused | 1254 × 1254 | 70.993 s, measured | Lanczos to 1024 × 1024 |
| D3, attachment | 1378 × 1142 | 56.305 s, measured | Patch resized/repacked into original 1024 × 1024 |

D1 recovered exact prompt (its original storage wording predates the owner's automatic-copy exception):

```text
Use case: identity-preserve. Edit target image 1, the official Shiroko (Cycling) packed Spine atlas, conservatively restoring only existing fine detail obscured by blur. Return one 1024 by 1024 RGBA image with genuine transparency. This is a texture sheet, not a scene: preserve every packed part at exactly the original pixel coordinates, size, rotation and crop; preserve all disconnected expressions, both body sections, bicycle, halo fragments, text, palette and original drawing style. No rearrangement or assembly of the character. Preserve pose, anatomy, costume, silhouettes, line locations and widths, shading, transparent gaps and attachment boundaries. If detail is ambiguous retain it rather than inventing anything. No new features, redesign, sharpening halos, new texture, background, watermark, caption or checkerboard. Keep alpha and edge colors as close as possible. Requested output file: /private/tmp/bl056/d1-conservative.png. All experiment image files must be saved only inside /private/tmp/bl056/.
```

D2 exact prompt:

```text
Use case: identity-preserve. Edit target: the attached official Shiroko (Cycling) packed Spine texture atlas, NOT a composed character illustration. Primary request: restore only existing faint line detail and small color transitions; no redesign. Output exactly the original 1024 x 1024 full canvas with all packed pieces at their original coordinates, scales and rotations. Keep every face expression, disconnected facial patch, hair patch, both halo parts, upside-down upper body, lower body, rifle, bag, bicycle, text markings, transparent gap and crop fixed. Keep original line positions and widths, pose, anatomy, proportions, palette, cel shading and silhouette. Do not move, enlarge, rotate, repack, clean up, erase or reinterpret the peculiar striped atlas edge pixels; these are required texture data. Preserve transparency and edge coverage exactly; do not introduce new partly transparent pixels inside solid art. Resolve blur conservatively only where there is unambiguous existing detail. If detail is ambiguous retain the original. No added texture, features, shadows, glow or text.
```

D3 exact prompt:

```text
Use case: identity-preserve. This is an official Shiroko (Cycling) Spine atlas attachment, temporarily unrotated for restoration. Restore only existing blurred line and color-transition detail with maximal fidelity. Preserve exactly the 602 x 499 composition, pose, silhouette, anatomy, proportions, colours, costume, bicycle fragments, bag, rifle, lettering, blank face, crop and all transparent pixels. The face is intentionally blank because separate expression attachments are overlaid by the game: do NOT add eyes, eyebrows, nose or mouth. The detached cropped bicycle fragment at the upper left and all strange striped edge pixels are required atlas data: keep them in their original positions. Keep existing line positions and widths, cel shading, skin highlights and hair shapes. Do not redesign, add texture, shift any feature, clean up the atlas, enlarge the character, change the crop, or invent details. If uncertain, preserve the input. Output only this same attachment on genuine transparency, ideally exactly 602 x 499.
```

### Comparison method and restoration results

The same baseline Laplacian and effective-resolution definitions are used. Comparisons operate on stored RGB,
without a PMA conversion or color-space linearization. D1/D2/S1 are normalized to the original page by Pillow
RGBA Lanczos resize; alpha/RGB errors therefore include this deterministic resampling as well as generation.
Pillow's RGBA resampling handles alpha internally; no additional premultiply/unpremultiply step was applied.
D3 uses the reconstructed page described above. No registration or local warp conceals moved features.

RGB RMSE and signed mean channel changes use the fixed original opaque-interior mask (254722 samples). Alpha
MAE/RMSE/counts cover the entire page. Silhouette IoU thresholds alpha at 128. A region-border mask is the union
of every rectangle's inner two-pixel outline, including aliases/overlaps once. Border errors include stored RGB
in low-alpha pixels; a second metric restricts RGB to original alpha ≥ 250 on that border. They measure atlas
pixel drift, not a rendered animation seam. Packed pages contain unused edge/bleed data, so these whole-page
scores cannot directly predict how much of the rendered character changes.

For geometric drift, thresholded-alpha contours are `mask - MinFilter(3)(mask)`. Symmetric nearest-contour
distance uses repeated 3 × 3 dilation (Chebyshev pixel distance), with distances above 32 put in a final bin.
Report the pooled 95th percentile; it is a shape diagnostic, not a per-feature displacement registration.

| Page | Laplacian on fixed original mask | Laplacian on own opaque mask | Effective-resolution proxy at source size |
| --- | ---: | ---: | --- |
| Original | 5311.423 | 5311.423 | 1024 × 1024 |
| D1 reused page | 5304.781 | 5112.523 | 1024 × 1024 |
| D2 line-focused page | 3421.908 | 3353.508 | 1024 × 1024 |
| D3 attachment, repacked | 5281.401 | 5334.476 | 1024 × 1024 |

The 2/255 reconstruction threshold saturates at the full evaluated size for every page; it cannot distinguish
true restored detail here. At native returned-artifact dimensions, D1's own-mask Laplacian is 4052.697
(402927 samples), D2's 2658.751 (353388 samples), and their resolution proxies both select 1254 × 1254.
Native values differ in scale and mask and must not be treated as direct improvement ratios over the original.
The full downsampling curves are in the local `metrics-v3.json`. Neither the fixed-mask nor own-mask results prove
a detail increase: D2 becomes smoother, while D1 is close to the original at source scale. D3 also retains most
of the original page, so its whole-page value is not a fair equal-coverage comparison with D1/D2.

| Trial page | Interior RGB RMSE | Signed mean ΔR, ΔG, ΔB | Alpha MAE / RMSE | Changed alpha pixels | Alpha≥128 IoU | Contour p95, px |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| D1 reused page | 31.240 | -3.863, +1.255, +2.439 | 14.841 / 52.896 | 496117 | 0.831578 | 10 |
| D2 line-focused page | 23.778 | +6.949, +7.318, +7.504 | 5.029 / 22.948 | 486963 | 0.945936 | 3 |
| D3 attachment, repacked | 28.899 | -2.438, -0.969, -1.511 | 1.845 / 17.178 | 144846 | 0.977966 | 2 |

D1 has 146 pooled contour samples farther than 32 pixels; D2 and D3 have none. D3 edits only one rectangle,
about 28.6% of the page, with other pieces retained. Within that attachment alone, IoU is **0.951638**, alpha MAE
**6.441804**, and original-opaque-mask RGB RMSE **41.845222** after normalization. Its favorable whole-page IoU
partly reflects the unedited page area. The source's striped edge data is substantially reinterpreted in all
raw outputs. D1/D2 also alter lettering, expression patches and line placement; D3 keeps the blank face but
redraws hair strands, bag details and lettering. The owner may prefer the appearance; exact fidelity is not met.

| Trial page | RGBA border RMSE | Original-visible border RGB RMSE | Border max channel delta | Border alpha pixels changed |
| --- | ---: | ---: | ---: | ---: |
| D1 reused page | 82.855 | 31.876 | 255 | 7176 |
| D2 line-focused page | 73.395 | 26.174 | 255 | 6106 |
| D3 attachment, repacked | 16.928 | 29.502 | 255 | 1237 |
| S1 style page | 97.388 | 81.560 | 255 | 8041 |

Per-region inner-border RGBA RMSE (same 0–255 units; aliases intentionally retained):

| Region | D1 | D2 | D3 repacked | S1 |
| --- | ---: | ---: | ---: | ---: |
| `01_normal` | 128.079 | 84.856 | 0.000 | 132.846 |
| `00_default` | 128.079 | 84.856 | 0.000 | 132.846 |
| `02_respond` | 121.077 | 82.192 | 0.000 | 126.835 |
| `03_smile` | 135.932 | 87.388 | 0.000 | 132.550 |
| `04_embarrassed` | 130.443 | 96.564 | 0.000 | 137.519 |
| `05_serious` | 113.866 | 84.699 | 0.000 | 134.604 |
| `06_depressed` | 109.569 | 104.032 | 0.000 | 129.995 |
| `eyeclose` | 87.735 | 86.643 | 0.000 | 128.803 |
| `fronthair` | 93.759 | 107.096 | 0.000 | 121.243 |
| `halo1` | 93.431 | 102.715 | 0.000 | 128.861 |
| `halo2` | 112.951 | 132.122 | 0.000 | 130.494 |
| `shiroko_ridingsuit` | 30.408 | 26.034 | 21.843 | 51.073 |
| `shiroko_ridingsuit1` | 68.010 | 68.315 | 21.524 | 82.604 |

Native returned-image alpha counts (zero / partial / 255): D1 **829949 / 741525 / 1042**;
D2 **846380 / 724059 / 2077**; S1 **896491 / 673312 / 2713**. Thus the transparent-background argument produced
real alpha, but did not preserve the original alpha convention/coverage. Many apparently solid pixels are
250–254 rather than 255; the blur mask deliberately allows them. Counts after normalization and per-region
color/alpha statistics are retained in `metrics-v3.json`.

**Overlap tiling was not triggered:** every generated page was larger than its 1024-square edit target, and the
D3 patch was larger than its 602 × 499 input. The 2048-square style reference was not the edit target. No claim
of tested seamless tile generation/reassembly is made. A future larger target would require that experiment;
prompting for a size is demonstrably not a deterministic output-size control in this built-in interface.

## 3. Style repair

Base: the same official `shiroko_ridingsuit_spr` page. One reference was sufficient: original Shiroko,
`shiroko_spr`, extracted through the same `GameAssets` instance from the authorized dev view. Its 2048 × 2048
RGBA PNG is 3823698 bytes, SHA-256 `202dc1100c27b6086222d8e5aa661638b03f0d734b36886dd808e4d299c48eaa`.
Atlas SHA-256 is `995b3b2180836d46e8dfc6a1fac2b0575894430bbda6b001cd8c4b545c7abd97` and skeleton SHA-256 is
`95a955103ee754b5032bb0bfd83637ccab6e5d3878499369236c8eeaef9686cb`; original files are retained locally.

Selection rationale, based on inspecting the extracted art rather than names or dates: the original portrait
has broader, flatter skin/cloth shadows and firmer dark outlines; Cycling has glossy skin highlights, smaller
shading transitions and finer contours. This is a visible style difference, not a judgment that one artist's
work is better. Choosing the same character limits identity/reference confusion. No second reference or
unrelated-character style was needed for this one-variant trial. No composed portrait was rendered.

S1 used image 1 as edit target and image 2 as style reference, with `transparent_background: true`. It returned
1254 × 1254 in **114.077 seconds**. Exact prompt:

```text
Use case: style-transfer. Input image 1 is the ONLY edit target: the 1024 x 1024 Shiroko (Cycling) packed Spine atlas. Input image 2 is a style reference ONLY: original Shiroko's official game atlas. Apply the reference's restrained flat cel shading, broader clean shadow shapes, firmer dark contours, softer low-gloss skin and simpler hair shading to the existing Cycling art. Keep the Cycling palette and cycling costume. Do NOT import the school uniform, scarf, bag design or reference composition. Preserve image 1's exact canvas, packed layout, coordinates, scale, rotations, poses, anatomy, silhouettes, facial identities and expressions, hair, halo, bicycle, weapon, bag and every text marking. All disconnected parts must stay where they are; preserve transparent gaps and edge coverage. Keep every expression coherent with the same style. Do not compose a whole character, move pieces, add accessories, change the bike geometry or redraw lettering. Change only contour/shading treatment toward image 2; keep content and shape fixed. Output the complete original 1024 x 1024 atlas with genuine transparency.
```

The output visibly simplifies skin shadows/highlights and hair shading toward flatter cel shading. It retains
the cycling outfit, bicycle and bag as content categories, but that is not style-only preservation: attachment
shapes/placement, facial patches, bicycle details and lettering also change. Whole-page original-mask RGB RMSE
is **89.225892** with signed mean channel changes **−20.838, −18.266, −19.536**. Alpha MAE/RMSE are
**47.524450 / 104.455097**; **507166** alpha pixels change; silhouette IoU is **0.521012**, contour p95 **20 px**,
with **392** contour samples beyond 32 px. Those geometric changes are beyond the requested style treatment.
A percentage of pixels changed *only* by style cannot be separated reliably from these metrics.

S1's source-size Laplacian is **9590.263** on the original mask, but **2519.397** on its own opaque mask. The
large discrepancy reflects moved coverage/edges inside the old mask, not demonstrated restored detail. At the
returned artifact's own size/mask it is **1910.173** (371093 samples); resolution proxy 1254 × 1254. The
source-size proxy again selects 1024 × 1024. Border values are in the tables above. S1 fails the experiment's
content-preservation goal despite a visible style effect; its guarded version also shows internal ghosting.

## 4. Pass-through feasibility

The first-run baseline control cropped/replaced all 13 original rectangles, inverse-rotated/re-rotated the
rotated attachment, PNG-encoded/decoded, and recovered the original RGBA page with zero changed pixels. This
continuation additionally repacked D3's processed attachment and created guarded candidate pages for all four
trials. No official file or dev-view data was modified.

The local guard in `analyze-v3.py` is deliberately conservative:

1. Normalize generated data to the known original page/attachment geometry as described above.
2. Form a weight from original alpha exactly 255, eroded by a 9 × 9 minimum filter. Zero a six-pixel inner
   rectangle outline, Gaussian-blur the weight with radius 2, multiply by the original opaque mask again, and
   force every two-pixel inner rectangle outline back to zero.
3. Blend generated RGB into original RGB with that weight, then restore the original alpha channel exactly.
   Do one operation on the shared page, so overlapping rectangles and aliases are not independently overwritten.
   At alpha 255 straight and premultiplied RGB coincide; all zero/partial-alpha RGBA bytes are preserved rather
   than guessing an unpremultiplication policy.
4. Save a 1024 × 1024 RGBA PNG with the original filename alongside byte-identical original `.atlas` and `.skel`.
   Reload and verify exact encoded/decoded pixel equality. No alpha-mask paste that would apply alpha twice.

Executed assertions in `validate-layout.py`: every guarded page has original dimensions; all 13 region bounds
remain valid; alpha max error is zero; RGBA max error is zero at every zero/partial-alpha pixel, outside the
union of packed rectangles, and on every two-pixel region border. Atlas and skeleton bytes match the source.
The original has zero fully opaque pixels outside that rectangle union. This preserves the measured layout and
original edge data, including whatever padding it has; it does not infer a universal padding width.

| Guarded page | Changed RGB pixels | Share of whole page | Interior RGB RMSE | Laplacian, original mask |
| --- | ---: | ---: | ---: | ---: |
| D1 reused page | 32232 | 3.074% | 4.037 | 5161.217 |
| D2 line-focused page | 30752 | 2.933% | 3.045 | 5139.019 |
| D3 attachment, repacked | 17634 | 1.682% | 3.596 | 5204.043 |
| S1 style page | 43164 | 4.116% | 10.462 | 5111.982 |

All four guarded pages have alpha MAE/RMSE **0**, alpha IoU **1**, contour p95 **0**, border RGBA RMSE/max delta
**0**, and resolution proxy **1024 × 1024**. These equalities are guaranteed by retaining original pixels and
are not evidence that GPT Image learned the atlas constraints. Most pixels, including nearly all small facial
patch interiors after erosion, remain original. This loses much of the proposed refinement. Internal line
misalignment is still possible, and the guarded S1 visibly blends incompatible internal positions. Do not use
these equality checks as a claim of a useful or seamless repaired portrait.

The App's headless path is `ba_modding_toolkit.spine.SpineViewer.render_preview` / `render`, exercised by
`tests/test_external/test_spine_viewer.py`. It invokes `SpineViewerCLI.exe export` with skeleton, adjacent atlas,
chosen animation, transparency and render options. Running the tests' `resolve_external_tool` in this
continuation again returned **None** for both viewer and converter. The now-writable exported candidate triplets
are ready, but a configured compatible renderer executable and native runtime/graphics support are missing.
The optional converter would be needed if the available renderer requires a different skeleton version; no
converter/renderer was installed. The browser composition in `web/js/thumbs.js` / `detail.js` requires
DOM/canvas/WebGL, and its Node tests stub the renderer rather than produce pixels. No GUI/browser fallback was
used. The four external viewer tests skipped; there is no rendered evidence for these edited pages.

Game risks, inferred from code/layout rather than verified by running the game: a raw 1254-square page cannot
be substituted while keeping original 1024-coordinate metadata. Resizing fixes that size mismatch but not moved
features, mesh UV coverage, split-body joins, expression consistency or padding colors. A guard protects page
edges/alpha, not internal feature alignment or every mesh seam. Wrong alpha conversion can create fringes;
the original material/decoded-pixel discrepancy remains unresolved. PNG success does not test BC7 re-encoding,
Unity texture/material metadata, mip behavior, engine size limits, animation/expression joins or actual game
acceptance. No Mod, game bundle or installation patch was produced.

## 5. Codex CLI integration evidence

Each operational claim is marked below. Documentation-only facts remain unverified by running that behavior.

| Statement | Evidence / classification |
| --- | --- |
| Installed CLI path `/Users/A200237264/.local/share/mise/shims/codex`, version `codex-cli 0.163.0`; `image_generation` is stable/enabled. | **Verified by running** command discovery, version and feature list. |
| Current authentication is ChatGPT login. | **Verified by running** `codex login status`: `Logged in using ChatGPT`. No credential contents were read or printed. |
| Exec accepts `--image`, stdin prompt `-`, `--json`, `--ephemeral`, `-C`, `--add-dir` and `-o`. | **Verified by running** `codex exec --help` and launching the command below. The process failed before a turn; this verifies flags/startup attempt, not successful image ingestion. |
| Actual `--image` delivery to the model and successful non-interactive generation/save. | **Unverified**: startup failed first; no JSONL events, final text or `exec-restoration.png` was produced. |
| The built-in tool accepts local reference paths, including a target plus a style reference, and transparent-output requests. | **Verified by running** D2/D3/S1 with the saved inputs. |
| Built-in outputs land in `~/.codex/generated_images/<session>/...png`, then can be copied to the requested folder. | **Verified by running**: all four automatic files/copies exist and match byte-for-byte. The tool has no exposed destination-path argument. |
| Built-in image generation uses `gpt-image-2` and consumes general Codex usage; API use with a key has separate pricing. | **Unverified backend/accounting by running**; [official image-generation documentation](https://learn.chatgpt.com/docs/image-generation) states this. The returned metadata has `image_url` and `output_hint`, no independently confirmed model identifier or usage billing. No alternative model was requested. |
| Multiple game reference images can guide built-in editing. | **Verified for two files** in S1; maximum built-in input count is **unverified**. |
| `-m` is an agent-model selector, not a proven image-backend selector. | **Verified help semantics**; image-backend selection via `-m gpt-image-2` was not attempted or asserted. |
| JSONL can be used for progress; `-o` writes final agent text. | **Verified help semantics only**; general behavior is documented in [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [CLI reference](https://learn.chatgpt.com/docs/cli/reference). Image event schema, cancellation and reliable output discovery remain **unverified**. `-o file.png` is not a demonstrated image-save flag. |
| Per-image time/size and success. | **Verified in this session**: D2 70.993 s, D3 56.305 s, S1 114.077 s; all succeeded. D1's 84.835 s is recovered prior-run metadata. These few samples are not a service-wide reliability/latency estimate. |

The attempted command was equivalent to the following, with `OPENAI_API_KEY` removed only from the child
process environment to keep the probe on existing subscription authentication. `--ignore-user-config` avoids
user-configured providers/integrations; authentication still uses the existing Codex home. The prompt requested
one built-in restoration, a copy to the named folder and final text paths; it forbade API fallback, other
services, subagents and repository edits. It is retained as `exec-prompt.txt`.

```sh
/Users/A200237264/.local/share/mise/shims/codex -a never exec \
  --ignore-user-config --disable multi_agent \
  -C /Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment \
  --sandbox workspace-write --add-dir /private/tmp/bl056 \
  --ephemeral --json \
  --image /private/tmp/bl056/shiroko_ridingsuit_spr.png \
  -o /private/tmp/bl056/exec-final.txt \
  - < /private/tmp/bl056/exec-prompt.txt
```

**Verified failure:** exit code 1 after **0.493 s**, before generation. Stderr:

```text
WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)
Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
```

The exact failed startup operation is not identified by that message. The enclosing sandbox denial is evidence
of an environment blocker, not proof that normal `codex exec` cannot generate images. No sandbox/approval bypass,
new auth flow or API fallback was attempted. Its empty `exec-events.jsonl`, stderr and status are local evidence;
no CLI-generated image exists to inventory. The stop rule for unavailable built-in generation did not trigger:
the built-in service itself succeeded, while the separate integration probe could not start.

Proposed App workflow, **unverified as an integrated feature**: export a source through `GameAssets` into a
user-writable job folder; use the user's configured Codex CLI with explicit target/reference roles, `--image`
(repeated for references), a stdin prompt invoking `$imagegen`, and a request to copy the generated file into
that job folder. Capture JSONL and final text, then validate actual file existence, PNG dimensions/alpha,
layout and user acceptance before any Mod apply. Do not infer the image path from `-o`, pass an API-only size
option to the built-in tool, silently fall back to an API key, or assume `--add-dir` overrides an enclosing
filesystem restriction. The successful file-copy step is verified here; end-to-end exec output discovery,
subscription charging, app cancellation and automatic applying are not.

For context only, **unverified by running API requests**: the [official edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
allows up to 16 input images, says `gpt-image-2` transparent output is in preview, and says to omit
`input_fidelity` for that model. These are API facts, not controls demonstrated by built-in CLI generation.
The installed imagegen skill's older API fallback note disagrees on transparency; no fallback was used.

## 6. Local image inventory

All image names below are relative to **`/private/tmp/bl056/`**. Inputs/derived pages have no generated-image
home counterpart. Automatic copies from the built-in tool are allowed by the owner's third-run instruction
and have been left in place. No other generated output was evaluated.

| Image filename | Role / dimensions |
| --- | --- |
| `shiroko_ridingsuit_spr.png` | Official target atlas, 1024 × 1024 |
| `shiroko_spr.png` | Official same-character style reference, 2048 × 2048 |
| `d1-conservative.png` | Reused restoration output, 1254 × 1254 |
| `d2-line-focused.png` | New full-atlas restoration, 1254 × 1254 |
| `d3-upper-body-input.png` | Extracted/unrotated attachment, 602 × 499 |
| `d3-upper-body-output.png` | New attachment restoration, 1378 × 1142 |
| `d3-upper-body-page.png` | Attachment normalized/repacked, 1024 × 1024, pre-guard |
| `s1-original-shiroko-style.png` | New style repair output, 1254 × 1254 |
| `d1-conservative-guarded/shiroko_ridingsuit_spr.png` | Original-layout/alpha guarded D1, 1024 × 1024 |
| `d2-line-focused-guarded/shiroko_ridingsuit_spr.png` | Original-layout/alpha guarded D2, 1024 × 1024 |
| `d3-upper-body-page-guarded/shiroko_ridingsuit_spr.png` | Original-layout/alpha guarded D3, 1024 × 1024 |
| `s1-original-shiroko-style-guarded/shiroko_ridingsuit_spr.png` | Original-layout/alpha guarded S1, 1024 × 1024 |

Automatic generated locations and evaluated experiment copies:

- D1: `/Users/A200237264/.codex/generated_images/01a17da7-08d0-7ae2-afbd-6d84dd9452e4/exec-a3a36adc-f43b-47dc-8fdf-99c870097e3f.png` → `/private/tmp/bl056/d1-conservative.png`.
- D2: `/Users/A200237264/.codex/generated_images/01a17dab-8911-71d2-b599-aa5fb28ff2c3/exec-8476f736-89f4-415b-a9b1-586f29f590e3.png` → `/private/tmp/bl056/d2-line-focused.png`.
- D3: `/Users/A200237264/.codex/generated_images/01a17dab-8911-71d2-b599-aa5fb28ff2c3/exec-ad5ee31f-17fa-4be8-b903-c11a2eddb245.png` → `/private/tmp/bl056/d3-upper-body-output.png`.
- S1: `/Users/A200237264/.codex/generated_images/01a17dab-8911-71d2-b599-aa5fb28ff2c3/exec-a9569aec-cfe2-4626-9f00-15fe3434d00f.png` → `/private/tmp/bl056/s1-original-shiroko-style.png`.

Generated output SHA-256 checksums (automatic file and copy match):

- D1: `eff3d3dd01f02d03fe769a8287b8a69d8d23a34362030a38ec59a9d7153540c5`.
- D2: `053a328082393d5718376f0de687d14eac9159fd44f78e97c0990dcb59bba536`.
- S1: `93b9d8d838d02313740c42ee3267ed6309e839c734e075d9c1484ad38168e7f7`.
- D3 patch: `e3dde72ef0e4deaa09b04d9d14d279da0364ff480ab11aa5481e66db59a9bdd4`.

The folder also contains the original target/reference `.atlas`/`.skel`, identical target metadata in each
`*-guarded/` folder, numerical provenance/metrics/layout JSON, exact D2/D3/S1 prompts/timings, temporary analysis
scripts and test/probe logs. These remain local and are not committed. `source-metadata.json`, `analyze-v3.py`,
`validate-layout.py`, `d3-reassembly.json` and `metrics-v3.json` describe/reproduce the local measurements and
reassembly without consulting the owner's install. The earlier first-run numerical baseline is retained.
No original/generated image bytes or atlas/skeleton payloads are included in Git or the bundle.

## 7. Validation and delivery

- Target/source: `GameAssets` re-extraction of the target and style reference matched every saved `.png`,
  `.atlas` and `.skel` byte-for-byte. `AssetCache(allowed=False)` prevented App disk-cache writes.
- Experimental checks: original-layout round trip from run 1; D3 exact inverse-rotation control; four processed
  page reassemblies; dimension/region/alpha/border/outside-region/partial-alpha assertions; identical metadata;
  automatic-output/copy equality; numerical color/blur/contour comparisons. All asserted invariants passed.
- Related Python tests: `tests/test_spine_alpha.py` and `tests/test_external/test_spine_viewer.py` with the official
  dev-view plugin: **36 passed, 4 skipped**, 0.10 s, one existing locale deprecation warning. Viewer skips confirm
  that a successful composition render is not covered here.
- Full JavaScript suite: `node --test tests/js/*.test.mjs`: **1897 passed, 0 failed, 0 skipped**, 10.146 s.
- Full Python suite with the official development view: **3272 passed, 27 skipped, 3 warnings**, 241.66 s.
  The warnings concern existing `locale.getdefaultlocale` deprecation. Command:

  ```sh
  PYTHONDONTWRITEBYTECODE=1 TMPDIR=/private/tmp/bl056/test-tmp \
    PYTHONPATH=/Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment/src:/Users/A200237264/Repos/BA-student-manager/.bamt-dev-path \
    PYTEST_ADDOPTS='-p bamt_dev.testing' \
    /Users/A200237264/Repos/BA-student-manager/.venv/bin/python -m pytest -q -p no:cacheprovider
  ```

- No product tests were added for this report-only change. Full suites were run once at the end of the image
  experiment; temporary scripts validate the experiment rather than changing shipped behavior.
- Locale diff: `git diff main -- src/ba_modding_toolkit/locales` is empty; all six locales are unchanged.
- Files changed: `docs/research/bl056-experiment.md` (this same report) and the existing single BL-056 status line
  in `docs/backlog.md` (link wording updated to the completed report/image inventory).
- Commit list: prior `8df3ee87` — `docs: record BL-056 portrait experiment evidence and blockers`; this continuation
  — `docs: complete BL-056 portrait refinement experiments`. The new commit hash is provided in the delivery
  message, since the committed report cannot contain its own hash.

Normal staging failed with `Unable to create .../.git/worktrees/portrait-refine-experiment/index.lock:
Operation not permitted`. Delivery therefore uses the authorized isolated Git metadata fallback and
`/tmp/portrait-refine-experiment.bundle`, branch `codex/portrait-refine-experiment`, based on main
`962cc999b4ebd973d5ad877f797dbd2a981ad464`. The original worktree index and branch refs remain untouched. Only
the two named documentation files are explicitly staged; the bundle contains the prior first-run report
commit and this continuation commit, with no images, private files or product code changes.

Root cause / lead diagnosis: the first-run image-folder denial was real and is resolved by the newly authorized
writable destination. This is separate from the new CLI startup denial. The general claim of enlarged blurry
originals is **not confirmed** by this single 1024-square detail page or its saturated resolution proxy; output
polish is not recovery evidence. The style difference was established from the actual reference; the model's
failure to preserve atlas geometry/alpha is established by measured errors. The App's existing export path
preserves decoded RGBA; it was not changed or blamed for the generated drift.

Assumptions: use the discovered detail Spine source rather than the collection texture; use one same-character
style reference whose shading differs visibly; treat prompt dimensions as requests rather than guarantees;
preserve original partial-alpha bytes rather than guess a conversion; retain conservative pixels at unknown
padding/seams; process only the known upper-body rectangle for D3. No prefab was edited; the detail framing node
is recorded in section 1. No hidden skeleton/mesh alignment was invented.

Owner/native acceptance still needed: preferred restoration/style, small-text and face fidelity, composed poses,
all expressions and animation seams, alpha fringes, BC7/Unity round trip and actual game behavior. A configured
headless renderer and a successful subscription-backed `codex exec` image-save run remain missing evidence.
This experiment delivers the requested image trials, measured limits and local review artifacts; it does not
approve a production integration or a game-ready portrait.

## 8. K4: engine assembly and local owner test mods

`src/ba_modding_toolkit/refine_assembly.py` now provides `assemble_page` and `assemble_mod`, without UI,
generation or locale changes. Inputs are the official portrait parts and an arbitrary-size generated page,
unrotated trimmed region crop (name/index), or box crop in atlas coordinates (left, top, right, bottom).
The engine reuses `atlas_remap` parsing, region/page types, bounds, rotation, alpha conversion and aspect
validation; `Bundle` and `core.process_asset_packing` perform the named-PNG replacement.

Generated RGB maps onto the exact selected rectangle; official alpha is restored exactly. Only selected
atlas rectangles change; box edits are clipped to their union and whole-page aliases are composed once.
Integer enlargement replicates untouched official RGBA pixels with nearest neighbour, while generated RGB
uses Lanczos. There is no conservative erosion/border guard, blending or geometric warping. Per-processed-
region misalignment is the signed displacement of internal luminance-edge centroids, weighted by official
alpha, in official texture pixels; null means no measurable edges. This colour-sensitive diagnostic is
not a registration or seam score. Actual changed region names include overlaps: D3 processes only
`shiroko_ridingsuit`, but its rectangle also intersects `shiroko_ridingsuit1`.

Enlargement evidence: `atlas_remap._box` scales coordinates by image size / declared page size;
`page_size_mismatch` checks aspect ratio, and the existing `remap_pages` upscaled path leaves atlas coordinates
unchanged. The shipped Spine **4.2.120** runtime computes UVs as atlas coordinates divided by declared page
dimensions; `TextureAtlasPage.setTexture` binds texture/filter/wrap without replacing those dimensions.
New Node tests execute that runtime and prove identical page dimensions, region/mesh UVs, trim geometry and
vertices with unchanged atlas text at 1x/2x and all four rotations. K4 therefore keeps atlas/skeleton bytes
unchanged. This refutes the earlier blanket warning that larger textures require changed atlas metadata;
generated geometry drift remains independent. D3-2x retains a 1204 × 998 unrotated patch from its 1378 × 1142
output, versus 602 × 499 at native density. No GUI, browser or renderer was run.

Generated RGB defaults to straight; generated/page PMA overrides are supported. The owner mods use the
atlas's omitted-PMA/false default, consistent with the App's current export and straight-renderer path.
The previously recorded material/decoded-pixel discrepancy remains unresolved; this is an explicit
owner-review assumption, not proof of native game blending. Exact identity inputs bypass lossy PMA conversion.
The PNG packer retains target GPU format, so edited pages are first staged as **RGBA32**, following the
lossless policy already used by `library.portrait_edit.patch_portraits`; BC7 re-encoding could alter untouched
pixels and alpha. Identity inputs retain encoded BC7. Outputs use the official filename, LZ4, fixed CRC and
the synthetic packer's four `0x08` extra bytes. Reload checks prove exact assembled pixels and unchanged
unrelated serialized objects. The larger lossless bundles are intentional.

Each `/private/tmp/bl056/k4/mods/<label>/` contains only
`assets-_mx-spinecharacters-shiroko_ridingsuit_spr-_mxdependency-2024-11-18_003_assets_all_782832622.bundle`.
This table comes from local `k4/mods.json`, which records all input names/sizes/SHA-256, per-region diagnostics,
changed regions and output filename/size/SHA-256. No new game-file hashes or asset payloads are added here.

| Label | Generated input | Page | Processed / changed regions | Changed pixels | Max edge-centroid distance (px) | Bundle bytes | App import |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `shiroko-cycling-d1` | `d1-conservative.png` | 1024 × 1024 | 13 / 13 | 520054 | 14.025121 | 2044422 | Accepted |
| `shiroko-cycling-d3` | `d3-upper-body-output.png` | 1024 × 1024 | 1 / 2, upper/lower overlap | 178437 | 3.479856 | 1509114 | Accepted |
| `shiroko-cycling-s1` | `s1-original-shiroko-style.png` | 1024 × 1024 | 13 / 13 | 526460 | 29.587808 | 1878605 | Accepted |
| `shiroko-cycling-d3-2x` | `d3-upper-body-output.png` | 2048 × 2048 | 1 / 2, upper/lower overlap | 707060 | 4.753863 | 3134984 | Accepted |

All four actual mods passed unchanged `ModLibrary.identify_import`, `inspect_import(conversion=True)`
(direct, no rebuild), and `add` in temporary `k4/import-check`, identifying `shiroko_ridingsuit`, kind `spr`,
and the exact official filename. Local `k4/build_mods.py` reproduces them and verifies official input hashes
remain unchanged. No mod was applied, and no owner installation or App data folder was accessed.

Focused tests passed **45 Python / 4 Node checks**: synthetic straight/PMA pixels, identity, rotations,
arbitrary crop sizes, boxes, 2x density, aliases, invalid targets, real synthetic BC7/RGBA32 bundles, CRC and
unrelated objects. Optional `BAMT_TEST_GAME_DIR` tests skip without an official view; with it they prove the
Shiroko identity round trip, real import at 1x/2x, and the App extractor returning unchanged atlas/skeleton
plus the exact new page. Full suites ran once at the end: **1901 JavaScript passed**; Python with the official
development-view plugin: **3317 passed, 27 skipped, 3 existing locale-deprecation warnings**, 231.71 s.

Diagnosis: the missing generated-image-to-Mod bridge is confirmed and implemented in the engine. Feature
alignment is measured, not repaired. No prefab changed; the existing detail node remains
`UICharacterDetail/Inventory_ListControl/CharacterPos`. Locale diff is empty. Native/visual owner acceptance
still must judge composed detail/fullscreen portraits, version switching, poses, expressions, seams, style,
fringes and game behavior. Import/extraction/UV tests do not claim a rendered or visually accepted character.

The worktree index is blocked (`index.lock: Operation not permitted`). K4 commits use authorized temporary
Git metadata and are delivered in `/tmp/portrait-assembly.bundle`, branch `codex/portrait-assembly`, based on
`d46d9dd14a7c2376be19547f2b611807e77e9ce7`. Tests used only its temporary `GIT_INDEX_FILE` so the development
tripwire recognizes the new files; the original worktree index/refs and primary checkout remain untouched.

## 9. K5: setup-pose composite generation and projection

The engine is implemented and remains outside every UI path. `web/js/refine-composite.js` accepts the
App's shipped Spine 4.2.120 runtime, atlas text and binary 4.2 skeleton bytes, with optional slot attachment
replacements. `SkeletonBinary`, `AtlasAttachmentLoader`, `Skeleton.setToSetupPose`, `setAttachment`,
`updateWorldTransform(Physics.reset)`, attachment `computeWorldVertices`, and `SkeletonClipping`'s public
unpacked triangle API supply geometry. No runtime internals are copied or ported. The same module executes
under Node without a DOM or texture upload, and can accept the already-loaded runtime in the App. Python
never starts Node; the Node helper is test/experiment code only. Synthetic tests use JSON skeletons; the
opt-in official-view test proves the actual binary skeleton loads, composes, and poses all seven named face
attachments plus eye-close. Null replacements remove a slot attachment.

`refine_composite.py` performs bilinear triangle sampling, draw-order composition, skeleton/attachment/slot
colour multiplication and the four Spine premultiplied framebuffer blend-factor pairs (normal, additive,
multiply, screen), returning straight RGBA. Page PMA follows only the atlas declaration; the earlier material
versus decoded-pixel discrepancy is still unresolved. These trials use the omitted-PMA/false atlas default.
This does not change the App renderer. No gamma conversion or native GPU rendering is introduced.

The inverse map records sparse atlas texel centres, composite coordinates, visible colour contributions and
blend derivatives per drawn attachment. Texels outside its UV triangles are implicitly off-composite;
explicit off-frame/covered entries are retained but not edited. Projection solves the generated-minus-official
colour residual through those derivatives. Coincident UV/world triangles sum their colour contributions
(normal halo plus additive glow); noncoincident reuse of the same atlas texel has no unique solution and uses
the first visible occurrence. Such compromises remain measurable in the per-instance re-render errors.
Unobservable colour channels keep their official values. Exact identity bypasses conversion and filtering.

Alpha and untouched RGBA remain exact, relative to nearest-neighbour official replication on 2x pages.
Generated alpha is diagnostic only. A configurable three-official-texel inward fade returns RGB to official
colour at alpha and visibility/UV boundaries. Edge and seam reporting bands are disjoint; the seam band
excludes the alpha-edge band. Optional attachment colour matching removes a low-frequency DC join residual;
it is disabled in these trials to retain the jointly generated palette. Face projection can select only its
posed slot. The `assemble_mod(projected=Assembly(...))` extension validates page size, exact official alpha
and outside-region bytes, then reuses K4's RGBA32 named-PNG packer, released filename, LZ4 and CRC fix.
Reload verifies exact pixels and unchanged unrelated serialized objects. Atlas and skeleton bytes remain
unchanged. Both final pages are 2048 square; no 1x fallback was needed.

The movement gate compares alpha-at-least-0.5 silhouette IoU against 0.960 and symmetric nearest luminance-line
Chebyshev distance p95 against three official texels. Lines use a 0.16 luminance-gradient threshold and alpha
above 0.9; distances are capped at 12.5 texels at 2x. It checks the whole composite and attachment bounding
crops, rejecting flagged input by default. Local crops can include overlapping parts: these are diagnostics,
not isolated semantic feature registration. Explicit `allow_flagged=True` is used only to build the requested
flagged owner-review candidates. The gate cannot certify lettering, facial expression or stylistic fidelity.

### Diagnosis evidence

The K4 mechanism supports the lead's diagnosis. In the setup-pose inverse map, D3's upper-body packed box
also intersects **10,534 visible lower-body texels**; that lower attachment has 179,342 visible texels in total.
A rectangular upper-body edit therefore both misses most lower-body detail and modifies pixels used by another
attachment. K4 has no world-space occlusion map or seam fade. Its existing report records S1 raw-page IoU 0.521
and up to 29.588 texels of line-centroid drift, consistent with the owner's displaced halo and dark patches.
The new synthetic gate rejects a 20-pixel silhouette shift and a 25-pixel internal-line shift. New R1/S2
composite generations also trip the gate, so assembled prompting alone does not enforce geometry.

This confirms a missing assembled context/visibility/edge-control mechanism, not a theorem that per-page
processing can never produce consistent art. Likewise, fixed alpha cannot repair moved internal RGB features.
The inverse map and blend bands address that mechanism, but the residuals below and owner UAT determine whether
the result is useful. No claim of seamless joins, recovered original detail, or visual approval is made.
The previously proved 2x UV behaviour and successful CRC/import checks refute atlas-size or import corruption
as the demonstrated cause of these failures.

### Generation, density, and stop rule

All official inputs were extracted again from the verified development view in section 1, with no disk cache,
and matched the saved atlas/skeleton/page inputs. New inputs, crops, generated copies, scripts, metrics and
mods are under `/private/tmp/bl056/k5/`. Automatic image-tool copies below are the sole allowed exception.
No owner installation, App data folder, GUI, browser preview, screenshot, audio, package build or UI integration
was used. The imagegen skill's built-in tool was used; no other model/service or API-key fallback was used.

Density 1x is derived from the largest drawn UV triangle's texture/world area ratio, rather than assuming one
world unit equals one texture pixel. At 2x the target canvas is **1513 x 2035**; the 1x original-Shiroko style
reference is **1427 x 2871**. Both full-character generations returned **1081 x 1455**, approximately 1.43x
native texture detail in this framing. A 2x projection/page preserves that returned detail without reducing
it to 1x, but does not imply 2x newly recovered information. The official comparison uses the same frame and
2x replicated baseline as the assembled mod; generation inputs sample the native pages at 2x.

R1 restores the entire setup-pose character. Each distinct remaining expression is composed separately, then
only its face crop is generated against R1's restored face as a style/detail reference; projection edits only
the selected expression slot. `01_normal` aliases `00_default` at identical atlas coordinates and reuses its
restoration. The five other named faces and the separately posed eye-close overlay have six generated edits.
Face crops keep their exact geometry-derived boxes and surrounding context; generated alpha is discarded.
S2 uses the original `shiroko_spr` composite as a line/shading-only reference and preserves official nondefault
expression regions. The exact prompts, input/output SHA-256, dimensions, timings, thresholds, flags, all
per-attachment/expression metrics, output bundle size/SHA-256 and import results are in local `mods.json`.
Face calls were submitted together; their wall times include service queueing, not isolated backend latency.

**Eight generations were used. S2 is flagged. Its stricter retry would require a ninth image, so the task's
explicit stop-and-report rule was applied: that retry was not run.** R1 is also flagged. Both diagnostic mods
are supplied as requested, with flags retained in `mods.json`; neither is silently approved or corrected by
warping. This is the remaining uncompleted generation step, not an unavailable-service fallback.

| Generation | Returned pixels | Wall seconds |
| --- | --- | ---: |
| r1 | 1081 x 1455 | 52.350 |
| s2 | 1081 x 1455 | 70.051 |
| 02_respond | 1385 x 1136 | 84.772 |
| 03_smile | 1414 x 1112 | 118.825 |
| 04_embarrassed | 1362 x 1155 | 180.357 |
| 05_serious | 1422 x 1106 | 275.675 |
| 06_depressed | 1451 x 1084 | 237.363 |
| eyeclose | 1333 x 1180 | 323.434 |

### Final bundle re-render measurements

Each row reports straight RGB RMSE in 0–255 units at visible atlas texel centres mapped into the final decoded
bundle re-render, compared with its generated target in the same framing. Edge and seam columns use the
three-texel disjoint bands described above. A dash means no samples in that band. IoU and line p95 compare the
preprojection official and generated composite crops; expression rows use their actual face crops. They are
not alpha metrics of the assembled pages: assembled alpha is exactly official by construction.

| Label / slot | Visible RGB RMSE | Edge RGB RMSE | Seam RGB RMSE | IoU | Line p95 (px) |
| --- | ---: | ---: | ---: | ---: | ---: |
| shiroko-cycling-r1 / halo1 | 71.373 | 93.666 | 43.996 | 0.795 | 4.000 |
| shiroko-cycling-r1 / halo4 | 71.436 | 93.933 | 42.453 | 0.786 | 4.500 |
| shiroko-cycling-r1 / halo2 | 65.734 | 78.464 | 49.972 | 0.768 | 3.000 |
| shiroko-cycling-r1 / halo3 | 65.893 | 78.724 | 49.875 | 0.755 | 3.000 |
| shiroko-cycling-r1 / shiroko_ridingsuit | 15.235 | 38.500 | 8.199 | 0.967 | 1.000 |
| shiroko-cycling-r1 / shiroko_ridingsuit2 | 20.469 | 40.380 | 5.170 | 0.944 | 1.500 |
| shiroko-cycling-r1 / 00_default | 10.674 | 12.091 | — | 1.000 | 1.000 |
| shiroko-cycling-r1 / fronthair | 7.602 | 7.497 | — | 1.000 | 1.000 |
| shiroko-cycling-r1 / 02_respond | 20.701 | 24.931 | — | 1.000 | 2.000 |
| shiroko-cycling-r1 / 03_smile | 33.790 | 38.119 | — | 1.000 | 2.000 |
| shiroko-cycling-r1 / 04_embarrassed | 23.902 | 27.293 | — | 1.000 | 2.000 |
| shiroko-cycling-r1 / 05_serious | 26.849 | 30.451 | — | 1.000 | 2.000 |
| shiroko-cycling-r1 / 06_depressed | 26.026 | 28.873 | — | 1.000 | 2.000 |
| shiroko-cycling-r1 / eyeclose | 47.287 | 47.312 | — | 1.000 | 2.500 |
| shiroko-cycling-s2 / halo1 | 67.766 | 88.470 | 46.658 | 0.736 | 2.500 |
| shiroko-cycling-s2 / halo4 | 67.814 | 88.676 | 45.924 | 0.725 | 2.500 |
| shiroko-cycling-s2 / halo2 | 64.059 | 75.403 | 53.094 | 0.692 | 2.500 |
| shiroko-cycling-s2 / halo3 | 64.184 | 75.637 | 53.576 | 0.681 | 2.500 |
| shiroko-cycling-s2 / shiroko_ridingsuit | 19.942 | 51.683 | 12.189 | 0.937 | 2.000 |
| shiroko-cycling-s2 / shiroko_ridingsuit2 | 26.381 | 52.366 | 10.636 | 0.846 | 5.000 |
| shiroko-cycling-s2 / 00_default | 17.416 | 20.102 | — | 1.000 | 1.500 |
| shiroko-cycling-s2 / fronthair | 12.506 | 10.869 | — | 1.000 | 2.000 |

| Mod | Page | Changed pixels | Bundle bytes | Global IoU | Global line p95 | Import |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| shiroko-cycling-r1 (flagged) | 2048 x 2048 | 1174530 | 4579184 | 0.951 | 1.500 | Accepted, direct |
| shiroko-cycling-s2 (flagged) | 2048 x 2048 | 1151172 | 4459270 | 0.880 | 3.500 | Accepted, direct |

Each `k5/mods/<label>/` contains only the official-named texture bundle. Unchanged `ModLibrary.identify_import`,
`inspect_import(conversion=True)` and `add` accepted both as `shiroko_ridingsuit`, kind `spr`, without rebuild.
Actual bundle texture extraction equals the projected RGBA32 page byte-for-byte, and its re-render equals the
saved candidate. No mod was applied. Official source hashes were rechecked after packing. The lead's comparison
files are `k5/r1-side-by-side.png` and `k5/s2-side-by-side.png` (official left, final bundle right, same frame),
with individual `*-rerendered.png` copies. They are local review artifacts and are not embedded in Git.

Automatic tool copies (all retained locally; matching evaluated copies and hashes are in `mods.json`):

- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-5a3a4b48-eadc-43f0-81ad-3f03918fe762.png` -> `k5/r1-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-a9f880ef-5db1-45b3-8102-bc98a53b72e5.png` -> `k5/s2-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-e026eeee-2b00-43b0-9620-dff8608be00c.png` -> `k5/02_respond-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-aa1ee97b-588b-44b3-9d4a-89f79897f4f9.png` -> `k5/03_smile-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-d68e07f9-ef40-4d55-8a1d-16c181868959.png` -> `k5/04_embarrassed-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-93180e70-881b-47c0-99af-4242e4609d9b.png` -> `k5/05_serious-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-9cc130a5-4ccf-4442-9d8e-fe238b2c54e7.png` -> `k5/06_depressed-generated.png`.
- `/Users/A200237264/.codex/generated_images/01a17dee-207c-7430-84d0-62749c5803ca/exec-861ba96f-8f10-429e-a709-6f9a0a8aeba4.png` -> `k5/eyeclose-generated.png`.

### Validation, files, and limits

The synthetic repository tests cover all atlas rotations, region/mesh/weighted vertices, clipping, draw order,
slot colour, PMA, all four blend factors, partial overlap, off-frame/unused texels, exact identity at 1x/2x,
slot-only edits, colour matching, inward fade widths, distinct edge/seam bands, coincident normal/additive
instances, saturated colour channels, movement rejection, and K4 projected-page invariant/CRC validation.
The official-view test composes Shiroko (Cycling), proves byte-exact identity across the entire page (a stronger
bound than a nonzero visible-pixel tolerance), and poses every expression. It skips without `BAMT_TEST_GAME_DIR`.
There are no committed skeletons, atlases or images from the game.

- Related coverage in the final suites: 68 Python tests and 13 new Node tests passed.
- Full JavaScript suite: 1914 passed, zero failed/skipped.
- Full Python suite with the official development-view plugin: **3340 passed, 27 skipped, 3 existing locale-deprecation warnings**, 254.75 s.
  An earlier full run passed 3338 tests / 27 skips before the two final projection regressions were added;
  the final repeat is justified by the subsequent shared-UV/channel/band fixes.
- NumPy was absent from the named venv. The experiment copied an existing NumPy 2.3.5 runtime package into
  `k5/deps` and used that extra PYTHONPATH; the primary venv was not changed. The new engine dependency is
  declared and locked, with hashes checked against [PyPI's release files](https://pypi.org/project/numpy/2.3.5/#files).
  `uv lock --check --offline` passes. No package was built.
- Python command used the requested official-view plugin, worktree `src`, the primary checkout's read-only
  `.bamt-dev-path`, `TMPDIR=/private/tmp/bl056/k5`, `-q -p no:cacheprovider`, and the temporary Git index so
  isolation recognizes the new tracked files. Full logs remain in `k5/`.
- Engine files: `refine_composite.py`, `web/js/refine-composite.js`, and the projected-page extension to
  `refine_assembly.py`; dependency declarations: `pyproject.toml`, `uv.lock`, `requirements.txt`.
  Tests: `test_refine_composite.py`, `test_refine_assembly.py`, `js/refine_composite.test.mjs`, and the Node-only
  binary helper `js/helpers/refine-pose.mjs`. Documentation: this section and one BL-056 status line.
- No UI/prefab or locale changes. The existing portrait framing node remains
  `UICharacterDetail/Inventory_ListControl/CharacterPos`; no new prefab/widget was constructed.
  `git diff main -- src/ba_modding_toolkit/locales` is empty for all six locales.
- The worktree's index is blocked. Authorized temporary Git metadata under `k5/git` delivers separate
  `feat(core): ...`, `test: ...` and `docs: ...` commits in `/tmp/portrait-composite.bundle`, branch
  `codex/portrait-composite`. The normal index/refs, primary checkout and `main` remain untouched; the bundle
  is recreated after each commit. Commit hashes are given in the delivery message.

Assumptions are explicit: setup pose rather than animation sampling; largest-triangle density; atlas PMA
rather than the unresolved material override; exact official alpha and nearest replication at 2x; three-texel
bands, no DC matching; default alias reuse; only face-slot colour changes for nondefault R1 expressions; first
visible mapping where noncoincident shared UVs cannot satisfy multiple targets. These controls cannot correct
invented details, moved lettering, feature shape changes, hidden parts revealed by animation or style jumps
in S2's unprocessed expressions. Native/visual owner acceptance must judge seam quality, halos/fringes, faces,
small text, pose/expression/animation transitions, detail consistency, game blending and actual game loading.
No visual acceptance or successful geometric preservation by the image model is claimed.

## 10. R1b: re-cut with the revised method

R1b cuts K5's R1 base generation and its six face crops again, with no new generation. Only the cut changed:

- **Cover fill.** Every texel of an unmasked part takes the generated colour wherever anything shows through the parts
  above it. There is no fade back to official colour. Covered texels keep the official drawing, shifted by the part's
  smoothed colour change.
- **Masked halos.** Texels a halo draws stay official. Atlas rectangles overlap here: the halo mesh sits inside the
  lower body's rectangle. Protection therefore follows mesh polygons, not rectangles.
- **Outer silhouette.** Alpha follows the generated outline within each part's mesh, wherever the two outlines
  disagree. Added coverage goes to the part already drawing there, else to the nearest part. Generated alpha is
  normalised to its interior level (253/255).
- **Face overlays.** The expression slot and the eye-close slot draw their lines in alpha, so official alpha cannot
  carry the generated lines. Each texel takes the smallest alpha that reproduces the target over the final head,
  never below the official alpha. This is limited to 6 px around the slot's own drawn features and feathered 5 px
  inside its mesh boundary. A constant colour offset, taken from flat skin around the face, is removed first.
- **Head under the face.** Next to the default face's features, the head takes the per-texel median of every pose
  that shows it: the base generation and each expression crop. A wider generated default mouth therefore does not
  remain on the head. This skeleton reveals no other covered texels: its idle moves the whole body, and its blink
  swaps the face slot.

Gate: the join-band RMSE is divided by the RMSE of interior pixels with the same detail. Interior pixels are binned by
generated luminance gradient. Only pixels where the generation is opaque are counted.

| Band | K5 R1 | R1b |
| --- | ---: | ---: |
| Waist (lower body soft edge over upper body) | 2.08 | 0.94 |
| Face edge | 1.26 | 0.59 |
| Front hair edge | 0.86 | 0.79 |
| Silhouette IoU against the generation | 0.957 | 0.992 |

The packed page is 2048 x 2048 RGBA32 with LZ4 and the CRC fix. It reloads byte-identically, and its re-render equals
the checked one. Unrelated objects and pixels outside the official regions are unchanged, and the official inputs are
unchanged. The bundle is larger than K5's (6.5 MB against 4.6 MB). Known residue: a faint light trace under the
smile's mouth and above the right eye in the eye-close pose. The expression crops keep K5's undeformed setup geometry,
which matches how they were generated; the game's face deforms move these overlays slightly.


## 11. K6: deterministic cut engine and R1b reproduction

`web/js/refine-composite.js` now exports `poseTracks` and `listPoses`, alongside the unchanged setup-pose
entry point. The shipped runtime's public `AnimationState` applies idle, expression and blink on tracks 0, 1
and 2 with independent times. Geometry still comes from attachment `computeWorldVertices`, including mesh
deforms, clipping, draw order and colours. The runtime runs under Node without a DOM. No runtime internals
were inspected or reproduced; Python production code never launches Node. The test helper alone does so.

`refine_cut.py` accepts explicit `Pose` geometries, full-frame or boxed targets, untargeted animation poses,
official pages, density and frame. It returns pages, edited-mesh and allowed-change masks, and a serializable
per-slot/per-pose report. `CutParameters` names the fixed thresholds and radii. A manifest can be run with
`python -m ba_modding_toolkit.refine_cut manifest.json --output <absolute-external-folder>`; its geometry,
targets and masks are data, so another portrait requires no source changes. Output and PNG review sheets
must be outside the source tree. Generation is separate and was never invoked for K6.

Masking propagates from non-Normal and caller-named slots through shared regions and all their alternate
attachments. Frozen texels are excluded even when another mesh uses those page coordinates. Static colour
uses cover fill with smoothed residuals behind occluders. The median vote is restricted to static parts
beneath swappable slots near their default features; applying it to the front hair was an implementation
error caught by the golden comparison and corrected. Silhouette growth and shrinkage stay inside meshes,
with protected masked footprints. Untargeted reveals extend this part's edited colours. Bleed protects
unedited polygons and their two-texel margins, with atlas bounds used only for its extent and undrawn regions.

Several swappable slots are solved **bottom to top in each pose's draw order**. Each upper solve therefore
uses the final lower parts; the solve also removes the current upper composite. A repeated identical slot
attachment is solved once, using its first targeted pose in input order. Noncoincident reuse of an unmasked
region within a pose fails explicitly. Swappability is attachment identity, not a slot-name convention;
public runtime metadata distinguishes attachment removal from an animation making its colour invisible.

The gate compares each soft join with gradient-distribution-matched interior error (20 quantile bins,
opaque generated pixels only, maximum ratio 1.0). Crop gates use only the supplied target box: unrelated
pixels outside it would supply artificial zero-error reference samples. Every target is re-rendered and
compared, every untargeted pose has reveal counts, and page invariants check frozen texels, allowed changes
and alpha support. A failed check raises `GateError`; only an explicit diagnostic run returns failed gates.
Review output includes join crops, silhouette tiles and each expression beside its target.

`refine_assembly.assemble_mod` accepts `allow_generated_alpha=True` only with a projected RGBA page and an
explicit binary edited-mesh mask (or that mask in the assembly report). Alpha outside it is rejected.
Official-region bounds, integer scale, unrelated serialized objects, unchanged atlas/skeleton, RGBA32
staging, LZ4, CRC and decoded-pixel reload checks remain in force. NumPy remains a development dependency;
a tracked import check excludes the optional refinement modules from shipped Python and JavaScript paths.

### Reference differences and fixed assumptions

The brief's strict five-pixel exclusion differs from R1b's actual feather through those five pixels.
R1b raises **3,036 overlay texels** in that band, by as much as 170 alpha levels; strict exclusion cannot
also reproduce those bytes. The engine default excludes the first five pixels, then feathers over five
more. R1b also uses smooth push-pull bleed whereas the SOP specifies nearest colour. The default uses
nearest colour, with deterministic Chebyshev-grid ties and seeds from the same region. The explicit
`CutParameters.r1b_reference()` profile sets zero exclusion with a five-pixel feather and smooth bleed,
preserving the reference arithmetic. The local golden uses this fixed compatibility profile; it does not
change tolerances or tune any value per portrait. Default-policy results are not claimed byte-identical
to R1b. Both policies have synthetic controls.

Other assumptions are explicit: targets are already approved/aligned, the first pose is the base, pages
are straight alpha, density is an integer page scale, and geometry/frame share world coordinates. The
cut performs no alignment or semantic skin/lettering recognition. Skin-offset sampling uses R1b's flat,
opaque, local colour test. Atlas metadata is preferred; without it the drawn UV bounds constrain bleed.
Opaque-level normalization uses one when no opaque official interior exists. Existing setup geometries
are deliberately used for K5's generations, while the new animated geometry is verified independently.

### Golden and idle results

The local golden driver uses the supplied setup geometries and existing generations, then packs through
the engine. The page is **100.000000% byte-identical** to R1b: **0 differing texels**, maximum channel
difference **0**, with all masked texels identical. No threshold or golden tolerance was loosened.

| Join | Engine ratio | Saved R1b ratio | Absolute difference |
| --- | ---: | ---: | ---: |
| Waist | 0.940952 | 0.94 | 0.000952 |
| Face edge | 0.593096 | 0.59 | 0.003096 |
| Front hair | 0.791722 | 0.79 | 0.001722 |

The base silhouette IoU is **0.992023**. The seven targeted poses pass their gates. The packed RGBA32
bundle is **6,537,887 bytes**, with valid CRC, byte-identical decoded pixels and unchanged unrelated
objects and official inputs. All seven renders from the reloaded bundle also match their saved R1b renders byte for byte. No mod was
applied and no assets or review images are tracked.

The official animation helper lists 19 poses: base (`Idle_01` plus `00`), `01` through `06`, `99`, three
blink samples, and eight evenly spaced idle samples over the 3.33333349-second loop, excluding its duplicate
endpoint. Idle times are 0, 0.416667, 0.833333, 1.25, 1.666667, 2.083333, 2.5 and 2.916667 seconds.
Every sampled idle reveals **zero** texels between unmasked parts. Their vertices share a vertical root
translation (0 to -2.5 world units; floating-point spread below 0.00002), with unchanged attachments and
colours. Thus R1b's geometric idle assumption is confirmed for these samples. Comparing raster composites
alone gives 16–84 false reveals because subpixel translation changes bilinear resampling; the engine's
reveal counter instead samples occluding alpha directly in world/UV space. At native page density, `99`
and the middle blink sample each expose **854** head texels. Numbered expression counts are 0, 13, 230,
191, 231 and 284 for `01` through `06`. These include the posed face deforms and are not K5 setup counts.

### Validation and limits

Synthetic controls cover soft joins, shared masked atlas space, fully opaque silhouette growth beyond two
pixels and shrinkage, alpha-drawn overlays, median spill rejection, idle-only reveals, overlapping
swappable slots, polygon bleed protection, all gate outcomes, default/reference policy differences and
mesh-constrained alpha packing. The optional official-view test poses every listed animation through the
shipped runtime and skips without `BAMT_TEST_GAME_DIR`.

Validation completed from the worktree with the requested isolated pytest plugin and its official view:

- Full JavaScript suite: **1,916 passed**, zero failed or skipped (10.24 seconds).
- Full Python suite: **3,362 passed, 27 skipped**, zero failed (283.55 seconds). Three existing locale
  deprecation warnings remain. The requested `PYTHONPATH`, `PYTEST_ADDOPTS="-p bamt_dev.testing"` and
  `-p no:cacheprovider` configuration was used; the fallback without isolation was not needed.
- Related coverage: `test_refine_cut.py` has 20 cases, `test_refine_composite.py` 22 and
  `test_refine_assembly.py` 48; `js/refine_composite.test.mjs` has 15. The official animation test ran.
- Local golden: all seven targeted poses pass with diagnostic mode disabled; exact page, exact packed
  pose renders, masked bytes, source hashes and bundle reload all pass. The standalone idle probe also
  re-ran after adding public attachment-state metadata.

The worktree's index lock is outside the writable sandbox, so commits are delivered in the requested Git
bundle, under `codex/refine-cut`, based on `ed898163`. Engine commit: `efb6dd03`; tests: `7f39c35f`;
the final documentation commit records this section and the one backlog status line. No branch was
switched and no repository metadata or files in the primary checkout were changed.

Visual fidelity, lettering, expression character and the appearance in the game remain the owner's
acceptance. Numerical agreement with the accepted local R1b result proves reproduction, not a new visual
verdict. The default's stricter boundary and nearest bleed also require visual acceptance on later runs.
No GUI, screenshots, browser preview, audio, image generation, package build, push or installation was used.
