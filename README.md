<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="BMPT" src="docs/logo.png" width="280">
  </picture>

  <h1>Blue Archive Modding and Patching Tool</h1>

  <p><b>Your Blue Archive mods, managed in an interface that feels like the game.</b></p>

  <p>
    <a href="https://www.gnu.org/licenses/gpl-3.0"><img alt="License: GPLv3" src="https://img.shields.io/badge/License-GPL--3.0-orange.svg"></a>
    <img alt="GitHub Release" src="https://img.shields.io/github/v/release/Clench5676/BlueArchive-Modding-and-Patching-Tool?include_prereleases">
    <img alt="GitHub Downloads" src="https://img.shields.io/github/downloads/Clench5676/BlueArchive-Modding-and-Patching-Tool/total">
  </p>

  <p>English | <a href="README_zh-CN.md">简体中文</a></p>
</div>

## Why BMPT

- **A WYSIWYG mod manager.** What you see in BMPT is what you get in game.
- **Every student, previewable.** Even the ones you haven't pulled yet.
- **One-click portrait swaps.** The official or original file is backed up on replace, so rolling back is always one
  click away.
- **One-click mod toggle.** Flip mods off and the game is back to stock.

Works with the Steam (Global) and Japanese PC clients; Android files through ADB.

## Get BMPT

Download the latest build from [Releases](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases).

| Platform | File | Requirements |
|---|---|---|
| Windows | `...-windows-x64.exe` | Windows 10 or 11 with the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (built into Windows 11) |
| macOS | `...-macos-arm64.dmg` | macOS 11 or later, Apple silicon |

Each build comes with an `.md5` file to check the download.

## Start in three steps

1. Open BMPT. It finds your game folder on its own; if not, choose it in Settings.
2. Allow the asset cache once, so the game's interface loads instantly next time.
3. Pick a student, open **Switch Portrait**, choose a portrait and **Apply**.

Drop mod files onto the window to add them to your mod library.

## Your game, your device

- Game art is read from your own installation each time and never leaves your computer. BMPT ships no game assets.
- With your consent, only light interface assets (icons, buttons, frames) are cached, in your user folder. Portraits,
  memorial lobbies, voices and backgrounds are never stored. Clear the cache in Settings at any time.
- Memorial lobby lines and voices are read on demand from [Kivo](https://kivo.wiki) and kept in memory only.

On macOS, user data is stored in `~/Library/Application Support/bluearchive-modding-patching-tool`;
Windows builds keep data next to the executable.
The old `BA-Modding-Toolkit` user folder is renamed automatically on first start, once the older app is closed.

## Classic tools

Every tool of the original toolkit is one click away in the bottom bar (or `--classic` to open the classic window):

| Tool | What it does |
|---|---|
| Mod Update | Port a mod to the current game files, or between platforms |
| Batch Update | Update many mods at once |
| Batch Install | Check mods against your game and install them, with before and after previews |
| CRC Tool | Calculate and correct CRC checksums |
| Asset Packer | Pack images, skeletons and atlases into a game bundle |
| Asset Extractor | Extract textures, Spine skeletons and more from bundles |
| ADB Push | Read and write game files on an Android device |
| Tools | Mod report, "Abnormal Client" repair, mod backup, batch previews |

Batch Install supports linked zoom and pan, rendered and extracted previews, Install All / Skip All, and parallel installation of groups.

More in the [usage guide](https://github.com/Agent-0808/BA-Modding-Toolkit/wiki/Usage).

### Optional add-ons

Independent third-party programs; set their paths in the classic Settings. BMPT only starts them and ships none of
their files.

- [SpineSkeletonDataConverter](https://github.com/wang606/SpineSkeletonDataConverter): convert Spine 3 skeletons of
  older mods to Spine 4, and back when extracting.
- [SpineViewer](https://github.com/ww-rm/SpineViewer): render previews and compare animation lists.
- [Android Debug Bridge](https://developer.android.com/tools/releases/platform-tools): work with files on Android
  devices ([guide](https://github.com/Agent-0808/BA-Modding-Toolkit/wiki/ADB-Usage)).

## Languages

English, Simplified Chinese, Traditional Chinese, Japanese and Korean. Thai and Vietnamese are next.

## Build from source

Python 3.12 and [uv](https://docs.astral.sh/uv/):

```bash
git clone https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool.git
cd BlueArchive-Modding-and-Patching-Tool
uv sync
uv run bamt            # the app; uv run bamt --classic for the classic window
uv run pytest
```

Release builds: `scripts/build_macos.sh` (macOS) and `scripts/build_windows.ps1` (Windows). How the interface works:
[docs/web-ui.md](docs/web-ui.md).

## License

Blue Archive Modding and Patching Tool (hereinafter "BMPT") is licensed under the GNU General Public License,
version 3 (the "GPLv3").

The previews in BMPT use the Spine Runtimes of Esoteric Software LLC (the "Spine Runtimes"), which are licensed
under the [Spine Runtimes License Agreement](https://esotericsoftware.com/spine-runtimes-license) and not under the
GPLv3. Use of the Spine Runtimes requires that each user hold a valid Spine license. BMPT obtains the user's
confirmation that such a license is held before it loads the Spine Runtimes; absent such confirmation, previews are
limited to static images.

The holders of the copyright in the code contributed to BMPT (the "BMPT Contributors") grant the following
additional permission solely with respect to that code. Code originating from upstream projects and authored by
persons other than the BMPT Contributors remains subject to the GPLv3 without this additional permission.

> **Additional permission under GNU GPL version 3 section 7**
>
> If you modify this Program, or any covered work, by linking or combining it with the Spine Runtimes (or a modified version of that library), containing parts covered by the terms of the Spine Runtimes License Agreement, the licensors of this Program grant you additional permission to convey the resulting work. Corresponding Source for a non-source form of such a combination shall include the source code for the parts of the Spine Runtimes used as well as that of the covered work.

## Credits

Based on [BA Modding Toolkit](https://github.com/Agent-0808/BA-Modding-Toolkit) by Agent-0808, with thanks to
[Deathemonic](https://github.com/Deathemonic) (CRC patching with [BA-CY](https://github.com/Deathemonic/BA-CY)),
[kalina](https://github.com/kalinaowo) (the first `CRCUtils`) and every contributor.

Character names come from [BA-characters-internal-id](https://github.com/Agent-0808/BA-characters-internal-id)
(CC BY-SA 4.0, compiled from [Kivo](https://kivo.wiki)) and [SchaleDB](https://schaledb.com).

Built with [UnityPy](https://github.com/K0lb3/UnityPy), [pywebview](https://github.com/r0x0r/pywebview),
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes) (Spine Runtimes License),
[Three.js](https://threejs.org) (MIT),
[Resource Han Rounded](https://github.com/CyanoHao/Resource-Han-Rounded) (SIL OFL 1.1),
[Pillow](https://python-pillow.github.io/), [SpineAtlas](https://github.com/Rin-Wood/SpineAtlas),
[ttkbootstrap](https://github.com/israel-dryer/ttkbootstrap), [tkinterdnd2](https://github.com/pmgagne/tkinterdnd2),
[toml](https://github.com/uiri/toml) and [Tap](https://github.com/swansonk14/typed-argument-parser).

See also [BA-AD](https://github.com/Deathemonic/BA-AD) (download game resources) and
[AtlasToolkit](https://github.com/com55/AtlasToolkit) (edit atlas sprites).

<sub>BMPT is a personal, unofficial project, not affiliated with or endorsed by NEXON Games Co., Ltd., NEXON Korea
Corp., Yostar, Inc. or their subsidiaries. Blue Archive and all of its assets, characters and music belong to their
owners and are used only for interoperability on your own device. Respect the game's Terms of Service; do not use this
tool for cheating.</sub>
