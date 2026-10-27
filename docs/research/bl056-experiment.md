# BL-056 portrait refinement experiment

Date: 2026-10-27. Owner review report; **image trials blocked, experiment incomplete**.

## Outcome and blocker

The official Shiroko (Cycling) detail portrait was identified and measured through the App's asset code, in
memory. Its original atlas survived a lossless in-memory layout round trip. No restoration or style output was
generated, so this report cannot establish GPT Image quality, fidelity, latency, or game compatibility.

The required first write failed:

```text
mkdir -p /Users/A200237264/Library/Caches/BAMT-Dev/experiments/bl056
mkdir: /Users/A200237264/Library/Caches/BAMT-Dev/experiments: Operation not permitted
```

The session permits writes to the task worktree and temporary directories, but not the requested cache directory.
Approval escalation is disabled. No alternative image directory, model, API-key workflow, or third-party service
was used. This is an environment restriction, not an image-service failure. The built-in `image_gen.imagegen`
tool is exposed; it was not invoked because the authorized local image destination is unavailable. Accordingly,
service access and its actual backend model remain unverified by generation. The stop rule for unavailable
generation was not exercised by a failed generation request.

**Image-file inventory in the experiments folder: none.** The folder could not be created. No official or generated
images were written to the repository, temporary directories, or another image directory, displayed inline,
committed, shipped, or published by the experiment. Asset bytes were decoded only in memory. Temporary measurement
code and numerical JSON were held under `/private/tmp`; they are not experiment-image deliverables.

Worktree: `/Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment`.
Branch: `codex/portrait-refine-experiment`. Starting HEAD and main: `962cc999b4ebd973d5ad877f797dbd2a981ad464`.
Only this report and the requested BL-056 review-status line are changed. No App UI, locale, or shipped code path
changes. The experiment does not change BL-056's funnel/design scheduling decision.

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

Verified extracted-file metadata, without saving the files:

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

## 2. Blur baseline and detail-restoration trials

Environment: Python 3.12.11, Pillow 12.0.0, UnityPy 1.23.0. Measurement/extraction took 0.497 seconds in the recorded
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

The requested two generation variants were **not run**. These are prepared prompt variants, not experimental
results or evidence of fidelity:

- D1, conservative: “Edit target image 1 only. Restore fine detail in this official Shiroko (Cycling) portrait atlas.
  Preserve the 1024 × 1024 canvas, every region position and rotation, all poses, expressions, silhouette, line
  locations, colors, and transparent pixels. Resolve blur without redesign, added features, altered anatomy,
  additional texture, or changed shading style. Preserve all separate atlas pieces and their shared boundaries.”
- D2, line-focused: “Edit target image 1 only. Make existing faint lines and small color transitions legible while
  retaining their original positions, widths, palette, and cel shading. Keep every expression, attachment, halo,
  crop, and transparent gap fixed in the original 1024 × 1024 atlas. If a detail is ambiguous, retain it. Do not
  invent detail or redraw the character.”

For both, the intended built-in tool request is transparent output with the same page size requested in the
prompt. The exposed tool has a transparency argument but no deterministic size, quality, seed, fidelity, or model
argument. Prompt constraints are not pixel guarantees. No claim is made that the tool can preserve PMA bytes.

| Requested trial measurement | D1 | D2 |
| --- | --- | --- |
| Generated dimensions, output PNG, generation time | Not run | Not run |
| Laplacian variance and resolution proxy | Not measured | Not measured |
| Color RMSE / color difference | Not measured | Not measured |
| Alpha error, silhouette drift | Not measured | Not measured |
| Region-border displacement and seam error | Not measured | Not measured |

Tiling with overlap was not run: no output exists to compare against the 1024-square source. For a later trial,
only a measured smaller output should trigger the requested tile experiment. Overlap blending must account for
attachment masks, shared pixels, alpha convention, and independently invented details; averaging tile edges alone
does not prove seamless animated composition. All such behavior is unverified.

## 3. Style repair

Not run. The identified base is Shiroko (Cycling). Discovery also confirms `shiroko_spr` (original Shiroko), making
the same character a possible reference without changing identity. It was not extracted, displayed, or selected
as a **visibly different style** reference. No stylistic difference was established, and none is asserted from
names or dates. A second reference was not chosen without visual evidence.

Consequently there is no style output and no measured non-style change in pose, face, anatomy, palette, costume,
line placement, expressions, or alpha. A later trial must choose references by actual visual differences and
label target/reference roles explicitly; the owner still needs the requested one or two executed style variants.

## 4. Pass-through feasibility

Verified baseline control, entirely in memory:

- Crop all 13 original packed rectangles; unrotate/re-rotate the one rotated region; replace original pixels in
  a copy without using the image itself as an alpha paste mask; losslessly PNG-encode and decode.
- Assert the entire decoded RGBA page equals the original. Result: 0 changed pixels, 0 changed alpha values,
  maximum region-border channel delta 0. Dimensions remain 1024 × 1024. Original atlas bytes remain identical.
- This control uses only original pixels. It does not test processed pixels, a new atlas, a Unity repack, or a
  rendered character. Avoid alpha-masked paste when copying already-alpha-bearing pixels: that would apply alpha
  again rather than perform a byte-preserving replacement.

The App has an external render path: `ba_modding_toolkit.spine.SpineViewer.render_preview` / `render`, exercised by
`tests/test_external/test_spine_viewer.py`. It invokes `SpineViewerCLI.exe export` with the skeleton, atlas, chosen
animation, transparent background and render options. Running the tests' `resolve_external_tool` returned **None**
for both viewer and converter. Thus the missing pieces are a configured compatible renderer executable (and its
native runtime/graphics support), writable exported atlas/skeleton/page inputs, and writable render output in the
authorized folder. No external tool was installed and no alternative renderer was introduced. The in-App
composition in `web/js/thumbs.js` depends on DOM/canvas/WebGL; its Node tests use stubs, not a headless pixel renderer.
No browser or GUI was launched.

Inference, not verified game behavior: keeping page dimensions and atlas/skeleton bytes is necessary but
insufficient. Generated content can move beyond the original mesh UV coverage, alter attachment boundaries,
create inconsistencies between expressions, or replace transparent/extruded edge colors. Overlapping rectangles
and aliased expressions forbid treating every region as an independently writable tile. Wrong alpha treatment
can produce dark/bright fringes. A successful PNG round trip also does not prove BC7 recompression fidelity,
Unity texture/material metadata preservation, game size limits, or animation seams. No game mod was produced.

## 5. Codex CLI integration evidence

Every statement below is classified by whether the relevant behavior was run. Documentation-only statements
remain **unverified by running**, even when supported by an official source.

| Statement | Verification |
| --- | --- |
| Installed command is `/Users/A200237264/.local/share/mise/shims/codex`, version `codex-cli 0.163.0`. | **Verified by running** `command -v codex` and `codex --version`. |
| Local CLI has `image_generation` stable and enabled. | **Verified by running** `codex features list`. This does not prove a successful service call. |
| Interactive and exec help accept `-i, --image <FILE>...`. | **Verified by running** both help commands; actual image passing was not run. |
| Exec accepts stdin prompts, `--json`, `--ephemeral`, `-C`, `--add-dir`, and `-o/--output-last-message`. | **Verified by running** `codex exec --help`; operational use was not tested. |
| `-m/--model` chooses the agent model. It is not documented here as selecting the image backend. | **Verified by running** CLI help. Do not pass `-m gpt-image-2` as a claimed image-generation switch. |
| Built-in generation uses `gpt-image-2` against general Codex usage, and an interactive prompt can invoke `$imagegen`. | **Unverified by running**; supported by [official image-generation documentation](https://learn.chatgpt.com/docs/image-generation). No generation or subscription accounting was observed. |
| `codex exec` can generate and save images non-interactively using subscription auth. | **Unverified**. No generation exec was launched. General non-interactive support is not evidence of this specific capability. |
| Exec can reuse saved authentication; JSONL reports progress and `-o` writes the final agent message. | **Unverified by running** beyond local flag help; supported by [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode). `-o output.png` is not an image-save flag. |
| Built-in output defaults under `$CODEX_HOME/generated_images/...`, followed by copying to a requested destination. | **Unverified by generation**; local imagegen skill says this. No actual output path was observed. The exposed tool has no destination-path argument, so “write all images only in the experiment folder” is not established for built-in intermediates either. |
| Current API edit documentation permits up to 16 input images and describes `gpt-image-2` transparent output as preview; omit `input_fidelity` for that model. | **Unverified by running API requests**; checked against [official edit reference](https://developers.openai.com/api/reference/resources/images/methods/edit). These API statements do not establish built-in CLI controls. |
| Time per generated image, failure rate, usable output sizes, image-event schema and reliable output-file discovery. | **Unverified**: no generated samples. |

The installed imagegen skill's older fallback note says `gpt-image-2` does not support transparent API output;
the current official edit reference describes preview support. No fallback or model substitution was attempted.
The built-in tool in this session accepts reference file paths, recent conversation images, a prompt, and a
transparency flag; its advertised interface does not expose the backend model. Official documentation names
`gpt-image-2`, but no response metadata independently confirmed that model in this experiment.

Candidate App-driven exec invocation, **not run**, after resolving storage permissions and exporting the input:

```sh
/Users/A200237264/.local/share/mise/shims/codex \
  -a never exec \
  -C /Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment \
  --sandbox workspace-write \
  --add-dir /Users/A200237264/Library/Caches/BAMT-Dev/experiments/bl056 \
  --ephemeral --json \
  --image /Users/A200237264/Library/Caches/BAMT-Dev/experiments/bl056/shiroko_ridingsuit_spr.png \
  - < /private/tmp/bl056-prompt.txt
```

Both named input and prompt are **proposed files, not delivered files**. The prompt would invoke `$imagegen`,
include D1 or D2, require built-in generation only, state the destination, and require a final text list of saved
paths and failures. `--add-dir` cannot overcome this session's enclosing filesystem denial. It is not a verified
solution for controlling built-in intermediate storage. Do not enable an API fallback automatically when built-in
generation fails. An App prototype would need an actual successful exec run, output-path/event observations,
file existence/format/dimension checks, a captured generation duration, and an alpha/layout review before this
command could be described as an integration recipe.

## Validation and delivery

Full suites were invoked from the task worktree; no product code changed.

- JavaScript: `node --test tests/js/*.test.mjs`: **1897 passed, 0 failed, 0 skipped**, 9.945 seconds.
- Python with the official development view: **3272 passed, 27 skipped, 3 warnings**, 277.98 seconds. Command:

  ```sh
  PYTHONPATH=/Users/A200237264/Repos/BA-student-manager/.claude/worktrees/portrait-refine-experiment/src:/Users/A200237264/Repos/BA-student-manager/.bamt-dev-path \
    PYTEST_ADDOPTS='-p bamt_dev.testing' PYTHONDONTWRITEBYTECODE=1 \
    /Users/A200237264/Repos/BA-student-manager/.venv/bin/python \
    -m pytest -q -p no:cacheprovider
  ```

  The three warnings concern existing `locale.getdefaultlocale` deprecation. Skips mean the suite does not prove
  external-renderer availability; the explicit viewer/converter discovery also returned None.
- Read-only experiment checks: exact catalogue/core identification; page/region bounds; original blur/alpha
  measurements; lossless in-memory 13-region round trip; viewer/converter discovery. No new product tests were
  added for this documentation-only change.
- Locale diff: `git diff main -- src/ba_modding_toolkit/locales` produced no output. All six locales are unchanged.
- Single logical commit: `docs: record BL-056 portrait experiment evidence and blockers`, containing only
  `docs/research/bl056-experiment.md` and one BL-056 status line in `docs/backlog.md`. The report cannot contain its
  own commit hash; the delivery message identifies the resulting commit/bundle.

Normal staging failed with `Unable to create .../.git/worktrees/portrait-refine-experiment/index.lock: Operation
not permitted`. Delivery therefore uses the authorized isolated Git-metadata fallback and
`/tmp/portrait-refine-experiment.bundle`, branch `codex/portrait-refine-experiment`, based on the starting HEAD
above. The original worktree index, branch refs, and the primary checkout were not modified. Only the two named
documentation files are added to that commit; no private files or image assets are included.

Assumptions: use the App's actual discovered detail Spine source as the baseline; use the stated numerical
resolution proxy without claiming original source resolution; stop image writes at the sandbox denial rather
than relocating art. No diagnosis of poor style or enlarged source art is asserted without visual evidence.

Outstanding owner/native acceptance: the two detail-restoration outputs; a visibly justified style-reference
choice and one or two style outputs; color/alpha/border and overlap-tile comparisons; rendered animation/expression
seams; native/game acceptance; and a successful subscription-backed non-interactive CLI image-save trial. This
report is ready for review of the evidence and blockers, **not acceptance of a completed image experiment**.
