# Switch layouts and Set / Installed

Base: `af3b5cb` (`0.4.0-alpha`). Branch: `codex/v040-switch`. No version change.

## 1. Switch layouts

- Portrait: a tall preview occupies the left half of the information body; name/pencil, chips and stacked File/Size/Status/CRC fields occupy the right half. Bundle filenames wrap. Actions remain across the bottom. The preview requests the same `portrait` thumbnail framing used by batch import. Four portrait cards wrap left to right; this is the chosen column count where the brief left it open.
- Memorial lobby: landscape preview bodies, 750 × 422 NGUI units (16:9), two per row.
- 3D model: square preview bodies, 360 × 360 NGUI units, four per row. Existing name bars remain below the lobby/model preview bodies. Existing model thumbnail content is retained.
- Selection checks, status/repair badges, pencils, new marks, scrolling, filtering, sorting, search and Apply/Save remain available. Apply can retry an already Set source whose installation is pending or failed.
- Very long error messages are bounded within the Status row; the complete message remains in its accessible label and the existing failure popup. Filenames remain wrapped rather than abbreviated.

Files: `web/js/detail.js`, `popup.js`, new `switch-layout.js`; tests in `tests/js/popup.test.mjs`, `detail_render.test.mjs`, and new `switch_prefabs.mjs`. Paths under `web/` are relative to `src/ba_modding_toolkit/`.

Prefab sources:

| Part | Source |
| --- | --- |
| Portrait candidate body, artwork window, name, status/repair bands, pin and new mark | `UICharacterCollectionPopulatorUnit/Grid/UICollectCard`; cloned native tree, native BG sprite alpha for the inclined corner contour |
| Portrait information preview | `UINonEquipmentInventory/Inventory_ListControl/EquipPos/Texture`, also used by batch import |
| Popup frame and action buttons | Existing `UIPopup_Sort` frame/button subtrees |
| Search, filter, sort and order controls | Existing `UICharacterCollection/SeletControl/TopMenu` |
| Lobby/model card decoration and selection check | Existing shared switch-card NGUI widgets and sprites, including `Common_Btn_BG` and `Card_Ability_Select_Line_Icon`; no new CSS skin |
| Roster status badge | A clone of `UICollectCard/Sort`, retaining its label and sprite styling |

Geometry tests exercise the NGUI renderer using authored prefab stand-ins in all six locales: aspects, sizes, columns, row wrapping, gaps, contained labels, the portrait split, long filenames/errors, and clearance above action buttons. They do not replace the owner's visual check with real exported game assets. No localhost/browser session was used.

## 2. Set / Installed

- The library saves a validated choice before attempting installation. Off saves the choice without writing game files; On installs it automatically. On reaches every Set source; Off restores originals and retains the selections. Externally changed bytes are preserved separately instead of becoming the selected Mod during Off.
- A failed install retains the choice and its error across restart. Retry clears the error after success. Original-file selection from the switch popup is also write-free while Off. Explicit Restore remains a recovery action with its existing write guards.
- Installed requires On, matching source records, every expected current part, matching file hashes, and no unresolved installation error. Hash caching includes ctime, so edits preserving file size, mtime and trailing bytes are detected. Drift, missing files and game updates show Set rather than Installed.
- Existing applied records migrate to Set + Installed when their files match; an external reset retains the migrated choice as Set.
- Manager portrait/lobby/model previews follow the saved selection, including after installation failure. Detail Info, switch-card text, popup chips/status, roster badges, add results, generic Mod rows and batch import notes use Set/Installed consistently. Failed batch imports can report both Set and the installation error.
- `webui/state.py` remains the UI-preference store. Selection/error persistence belongs in the existing library profiles, while installation evidence comes from file records and hashes. The master-switch/event/job flow remains in `mod-switch.js` and the existing services; no additional preference or state schema version is introduced.

Files: `library/service.py`; `webui/api.py`, `services.py`, `batch_import.py`; `web/js/switch-sources.js`, `detail.js`, `roster.js`, `roster-order.js`, `mod-add.js`, `batch-import.js`, `settings-other.js`; all six locale JSON files. Tests: `test_library_profiles.py`, `test_library.py`, `test_batch_import.py`, `test_webui.py`, plus the related existing library/model/Other/WebUI/localization suites and JavaScript suites listed below.

## Every visible label addition/change

No owner-chosen names, aliases, titles, button labels or version labels were renamed. Apply, Save, Enable Mods, Switch Portrait, Switch Memorial Lobby, the 3D switch title, File, Size, Status, CRC, Show in Finder and Extract are unchanged.

- Detail Info: a selected source now shows **Set** or **Installed**, replacing the former Original/Replaced status inference there. Unselected original/unknown file statuses retain their existing labels.
- Switch popup: the selected source's chip and badge now show **Set** or **Installed**. These replace **In Use** for selected Mod/variant status; original-file In Use indicators remain. The Status value follows the same verdict. Existing Not Installed and Game File labels remain for other candidates.
- Detail switch-card subtitle, roster badge and add-result note: added **Set**/**Installed** using existing localized strings.
- Generic Mod rows: active status **In Use → Installed**; Set uses the shared localized Set label.
- Batch results: **Applied → Installed** for successful installation; added **Set** for deferred selections and retained selections after failure. Not Applied remains for imports that did not set a source. Existing error strings are reused.
- `webui.switch.configured`: zh-CN **已设置 → 已设定**; the other five Set translations are unchanged.
- `webui.import.applied`: all six exact string changes are below. No new translation keys were needed.

| Locale | Previous import label | Installed | Set (reused/added to the places above) |
| --- | --- | --- | --- |
| en-US | Applied | Installed | Set |
| zh-CN | 已应用 | 已安装 | 已设定 |
| zh-TW | 已套用 | 已安裝 | 已設定 |
| ja-JP | 適用済み | 導入済み | 設定済み |
| ko-KR | 적용됨 | 설치됨 | 설정됨 |
| th-TH | ใช้แล้ว | ติดตั้งแล้ว | ตั้งค่าแล้ว |

## Validation

Final related Python run: **889 passed**, with three existing `locale.getdefaultlocale` deprecation warnings. Run from this worktree with `PYTHONPATH=src` and the repository's existing Python environment:

```sh
PYTHONPATH=src /Users/A200237264/Repos/BA-student-manager/.venv/bin/python -m pytest \
  tests/test_library_profiles.py tests/test_library.py tests/test_library_model.py \
  tests/test_library_other.py tests/test_batch_import.py tests/test_webui.py \
  tests/test_webui_mods.py tests/test_locales.py tests/test_i18n.py -q
```

Final related JavaScript run: **379 passed**:

```sh
node --test tests/js/popup.test.mjs tests/js/switch_sources.test.mjs \
  tests/js/mod_switch.test.mjs tests/js/switch_card.test.mjs tests/js/mod_add.test.mjs \
  tests/js/batch_import.test.mjs tests/js/settings_other.test.mjs \
  tests/js/switch_refresh.test.mjs tests/js/roster_order.test.mjs \
  tests/js/detail_render.test.mjs tests/js/mod_counts.test.mjs
```

`git diff --check` passed. Tests use synthetic game files and temporary settings/libraries; the owner's install, Mods, library and settings were not changed. Work stayed in one thread without subagents.

## Delivery

The original worktree's index is read-only (`index.lock: Operation not permitted`). Commits are therefore created in an isolated temporary checkout using the requested author/committer identity and Conventional Commit scopes. The delivery bundle is `/tmp/v040-switch.bundle`, containing branch `codex/v040-switch` with prerequisite `af3b5cb`; the edited files also remain in the requested worktree. The bundle is verified against that prerequisite before delivery.
