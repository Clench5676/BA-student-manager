<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="BMPT" src="docs/logo.png" width="280">
  </picture>

  <h1>Blue Archive Modding and Patching Tool</h1>

  <p><b>像游戏一样好用的碧蓝档案 Mod 管理工具。</b></p>

  <p>
    <a href="https://www.gnu.org/licenses/gpl-3.0"><img alt="License: GPLv3" src="https://img.shields.io/badge/License-GPL--3.0-orange.svg"></a>
    <img alt="GitHub Release" src="https://img.shields.io/github/v/release/Clench5676/BlueArchive-Modding-and-Patching-Tool?include_prereleases">
    <img alt="GitHub Downloads" src="https://img.shields.io/github/downloads/Clench5676/BlueArchive-Modding-and-Patching-Tool/total">
  </p>

  <p><a href="README.md">English</a> | 简体中文</p>
</div>

> [!NOTE]
> 本文由 AI 从[英文版](README.md)翻译，内容以英文版为准。

## 为什么选 BMPT

- **能改的学生一目了然。** 学生名单直接读取你本机的游戏：所有立绘变种、中英日韩官方名称，可招募学生有标记，收藏置顶。
- **先预览，再进游戏。** 实时 Spine 立绘和全部差分，记忆大厅连同对话台词与语音。
- **一键切换立绘。** 给任意变种换上 Mod 或其他服装的立绘。首次替换时自动保留官方文件，随时一键还原。
- **解决「不正常的用户端」。** 自动修正 Mod 文件的 CRC，游戏照常登录。
- **旧 Mod 也能用。** 把为旧版本制作的 Mod 更新到当前游戏文件。
- **原有工具全都在。** 批量更新、批量安装、CRC 工具、资源打包与提取、ADB 推送到安卓、Mod 报告与备份。
- **始终最新。** 自动检查新版本并在线更新。

支持 Steam（国际服）与日服 PC 客户端；安卓文件可通过 ADB 处理。

## 下载

在 [Releases](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/releases) 下载最新版本。

| 平台 | 文件 | 要求 |
|---|---|---|
| Windows | `...-windows-x64.exe` | Windows 10 或 11，需要 [WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 11 已内置） |
| macOS | `...-macos-arm64.dmg` | macOS 11 及以上，Apple 芯片 |
| 命令行 | `...-cli-...-windows-x64.exe` | Windows 10 或 11 |

每个安装包都附带 `.md5` 文件，可用于校验下载。

## 三步上手

1. 打开 BMPT。它会自动找到游戏目录；找不到时在设置中选择。
2. 允许一次素材缓存，之后打开即刻载入游戏界面。
3. 选择学生，打开「切换立绘」，选好立绘后点「应用」。

把 Mod 文件拖进窗口即可加入 Mod 仓库。

## 你的游戏，只在你的设备上

- 游戏素材每次都从你本机的游戏中读取，不会离开你的电脑。BMPT 不附带任何游戏素材。
- 经你同意后，只缓存轻量界面素材（图标、按钮、边框），存放在用户目录。立绘、记忆大厅、语音和背景从不保存。可随时在设置中清除缓存。
- 记忆大厅台词与语音按需从[基沃托斯古书馆（Kivo）](https://kivo.wiki)读取，只保留在内存中。

## 经典工具

原工具箱的全部功能都在底部导航栏中，一键打开（也可用 `--classic` 打开经典窗口）：

| 工具 | 用途 |
|---|---|
| Mod 更新 | 把 Mod 移植到当前游戏文件，或在平台间移植 |
| 批量更新 | 一次更新多个 Mod |
| 批量安装 | 对照游戏检查并安装 Mod，附安装前后预览 |
| CRC 工具 | 计算与修正 CRC 校验值 |
| 资源打包 | 把图片、骨骼和图集打包进游戏资源包 |
| 资源提取 | 从资源包中提取贴图、Spine 骨骼等 |
| ADB 推送 | 读写安卓设备上的游戏文件 |
| 工具 | Mod 报告、修复「不正常的用户端」、Mod 备份、批量预览 |

批量安装支持同步缩放与平移、渲染与提取预览、全部安装 / 全部跳过，以及组级并行安装。

更多说明见[使用指南](https://github.com/Agent-0808/BA-Modding-Toolkit/wiki/Usage)。

### 可选扩展

均为独立的第三方程序，在经典设置中配置路径。BMPT 只负责调用，不附带它们的任何文件。

- [SpineSkeletonDataConverter](https://github.com/wang606/SpineSkeletonDataConverter)：把旧 Mod 的 Spine 3 骨骼转换为 Spine 4，提取时也可反向转换。
- [SpineViewer](https://github.com/ww-rm/SpineViewer)：渲染预览图，对比动画列表。
- [Android Debug Bridge](https://developer.android.com/tools/releases/platform-tools)：处理安卓设备上的文件（[指南](https://github.com/Agent-0808/BA-Modding-Toolkit/wiki/ADB-Usage)）。

## 语言

简体中文、繁體中文、English、日本語、한국어。接下来是泰文和越南文。

## 命令行

```bash
bamt-cli -h          # 全部命令
bamt-cli update -h   # 某个命令的参数和示例
```

命令：`update`、`batch-update`、`pack`、`extract`、`crc`、`report`、`backup`、`env`。
详见 [CLI 指南](https://github.com/Agent-0808/BA-Modding-Toolkit/wiki/CLI-Usage-&-Arguments)。

## 从源码构建

需要 Python 3.12 和 [uv](https://docs.astral.sh/uv/)：

```bash
git clone https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool.git
cd BlueArchive-Modding-and-Patching-Tool
uv sync
uv run bamt            # 启动应用；uv run bamt --classic 打开经典窗口
uv run pytest
```

发布构建：`scripts/build_macos.sh`（macOS）与 `scripts/build_windows.ps1`（Windows）。界面实现说明见
[docs/web-ui.md](docs/web-ui.md)。

## 致谢

基于 Agent-0808 的 [BA Modding Toolkit](https://github.com/Agent-0808/BA-Modding-Toolkit)，感谢
[Deathemonic](https://github.com/Deathemonic)（[BA-CY](https://github.com/Deathemonic/BA-CY) 的 CRC 修正）、
[kalina](https://github.com/kalinaowo)（`CRCUtils` 的雏形）以及所有贡献者。

角色名称来自 [BA-characters-internal-id](https://github.com/Agent-0808/BA-characters-internal-id)（CC BY-SA 4.0，整理自
[Kivo](https://kivo.wiki)）与 [SchaleDB](https://schaledb.com)。

使用了 [UnityPy](https://github.com/K0lb3/UnityPy)、[pywebview](https://github.com/r0x0r/pywebview)、
[Spine Runtimes](https://github.com/EsotericSoftware/spine-runtimes)（Spine Runtimes License）、
[Resource Han Rounded](https://github.com/CyanoHao/Resource-Han-Rounded)（SIL OFL 1.1）、
[Pillow](https://python-pillow.github.io/)、[SpineAtlas](https://github.com/Rin-Wood/SpineAtlas)、
[ttkbootstrap](https://github.com/israel-dryer/ttkbootstrap)、[tkinterdnd2](https://github.com/pmgagne/tkinterdnd2)、
[toml](https://github.com/uiri/toml) 与 [Tap](https://github.com/swansonk14/typed-argument-parser)。

另见 [BA-AD](https://github.com/Deathemonic/BA-AD)（下载游戏资源）与
[AtlasToolkit](https://github.com/com55/AtlasToolkit)（编辑图集精灵）。

<sub>BMPT 是个人非官方项目，与 NEXON Games Co., Ltd.、NEXON Korea Corp.、Yostar, Inc. 及其子公司无关，也未获其认可。碧蓝档案及其全部素材、角色与音乐归各自权利人所有，仅用于在你自己的设备上实现互操作。请遵守游戏服务条款，不要将本工具用于作弊。</sub>
