#!/usr/bin/env bash
# scripts/build_macos.sh
#
# Build "Blue Archive Modding and Patching Tool.app" with Nuitka on macOS and package it as a DMG
# (for the architecture of the build machine), with an MD5 file next to it:
#   dist/Blue-Archive-Modding-and-Patching-Tool-<version>-macos-<arch>.dmg (+ .md5)
# The in-app update downloads this DMG; keep the name.
# Requires uv and the Xcode Command Line Tools (clang); sips / iconutil / hdiutil ship with macOS.
#
# Usage: scripts/build_macos.sh
#   PYTHON=...          interpreter for the build (version or path), default 3.12.11
#   NUITKA_VERSION=...  default 4.3
#
# The tkdnd bundled with tkinterdnd2 0.4.3 only loads into Tk 8.6, and python-build-standalone
# switched to Tk 9 starting with 3.12.12, so the default is pinned to 3.12.11
# (the last 3.12 build that ships Tk 8.6).

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PYTHON="${PYTHON:-3.12.11}"
NUITKA_VERSION="${NUITKA_VERSION:-4.3}"
APP_NAME="Blue Archive Modding and Patching Tool"
BUNDLE_ID="io.github.agent-0808.ba-modding-toolkit"
BUILD_DIR="$ROOT/build/macos"
DIST_DIR="$ROOT/dist"

# --- Build environment (separate venv, leaves the development .venv alone) ---
export UV_PROJECT_ENVIRONMENT="$BUILD_DIR/venv"
uv sync --frozen --no-dev --python "$PYTHON"
PY="$UV_PROJECT_ENVIRONMENT/bin/python"
uv pip install --python "$PY" "nuitka==$NUITKA_VERSION" ordered-set

TK_VERSION=$("$PY" -c 'import tkinter; print(tkinter.Tcl().eval("info patchlevel"))')
if [[ $TK_VERSION != 8.6.* ]]; then
    echo "Error: Tk 8.6 is required, but this interpreter has Tk $TK_VERSION (the tkdnd of tkinterdnd2 0.4.3 cannot load into it); pick another interpreter with PYTHON=..." >&2
    exit 1
fi

# --- Version info ---
read -r VERSION FILE_VERSION < <("$PY" - <<'EOF'
import re, tomllib
version = tomllib.load(open("pyproject.toml", "rb"))["project"]["version"]
match = re.match(r"[vV]?(\d+)\.(\d+)\.(\d+)", version)
print(version, ".".join(match.groups()) if match else "0.0.0")
EOF
)

# Generate _version.py so the app can show its version; remove it afterwards if it did not exist before
VERSION_FILE="src/ba_modding_toolkit/_version.py"
if [[ ! -e $VERSION_FILE ]]; then
    trap 'rm -f "$ROOT/$VERSION_FILE"' EXIT
fi
GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}" \
GITHUB_REF_NAME="${GITHUB_REF_NAME:-$VERSION}" GITHUB_REF_TYPE="${GITHUB_REF_TYPE:-tag}" \
    "$PY" scripts/extract_version.py >/dev/null

# --- Bundled character ID map (BA-Characters-Internal-ID, CC BY-SA 4.0), copied to the user data dir on first launch ---
ADDONS_DIR="$BUILD_DIR/Addons"
BACII_BASE="https://agent-0808.github.io/BA-characters-internal-id/data"
rm -rf "$ADDONS_DIR"
mkdir -p "$ADDONS_DIR"
EXTRA_ARGS=()
if curl -fsSL "$BACII_BASE/students_data.csv" -o "$ADDONS_DIR/BA-Characters-Internal-ID.csv" &&
   curl -fsSL "$BACII_BASE/LICENSE-DATA.txt" -o "$ADDONS_DIR/BA-Characters-Internal-ID-LICENSE.txt"; then
    EXTRA_ARGS+=("--include-data-dir=$ADDONS_DIR=Addons")
else
    echo "Warning: failed to download the character ID map, building without bundled Addons" >&2
    rm -rf "$ADDONS_DIR"
fi

# Nuitka's tk-inter plugin only bundles the Tcl module directory tcl8/ (msgcat and other .tm modules)
# on Windows; add it by hand on macOS, otherwise ttkbootstrap fails with
# invalid command name "::msgcat::mcmset" at startup
TCL8_DIR=$("$PY" -c 'import os, tkinter; print(os.path.join(os.path.dirname(tkinter.Tcl().eval("info library")), "tcl8"))')
if [[ ! -d $TCL8_DIR ]]; then
    echo "Error: Tcl module directory not found: $TCL8_DIR" >&2
    exit 1
fi
EXTRA_ARGS+=("--include-data-dir=$TCL8_DIR=tcl8")

# archspec (used by the texture decoders) finds its CPU tables through archspec/cpu/../json, which only resolves
# when the archspec/cpu folder exists; compiled modules leave no folder, so ship one with a placeholder file
ARCHSPEC_CPU="$BUILD_DIR/archspec-cpu"
mkdir -p "$ARCHSPEC_CPU"
echo "keeps archspec/cpu/../json resolvable in the compiled app" > "$ARCHSPEC_CPU/placeholder"
EXTRA_ARGS+=("--include-data-dir=$ARCHSPEC_CPU=archspec/cpu")

# The ccache Nuitka downloads is x86_64; under Rosetta it invokes clang through xcrun, whose libxcrun
# no longer has an x86_64 slice in recent Command Line Tools, so compilation fails.
# Disable ccache unless a native one is on PATH
if ! command -v ccache >/dev/null; then
    EXTRA_ARGS+=("--disable-cache=ccache")
fi

# --- Icon (PNG -> icns) ---
ICONSET="$BUILD_DIR/eligma.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256; do
    sips -z $size $size src/ba_modding_toolkit/assets/eligma.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) src/ba_modding_toolkit/assets/eligma.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD_DIR/eligma.icns"

# --- Build the .app with Nuitka (options match the Windows build in .github/workflows/build.yml) ---
rm -rf "$BUILD_DIR"/*.app
(
    cd src
    "$PY" -m nuitka \
        --mode=app \
        --python-flag=-m \
        --enable-plugins=tk-inter \
        --include-package=ba_modding_toolkit \
        --include-package=UnityPy.resources \
        --include-package-data=ba_modding_toolkit \
        --include-package-data=UnityPy \
        --include-package-data=archspec \
        --include-data-dir=ba_modding_toolkit/assets=ba_modding_toolkit/assets \
        --include-data-dir=ba_modding_toolkit/locales=ba_modding_toolkit/locales \
        --include-data-dir=ba_modding_toolkit/web=ba_modding_toolkit/web \
        --include-data-dir=ba_modding_toolkit/catalog/data=ba_modding_toolkit/catalog/data \
        ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
        --macos-app-name="$APP_NAME" \
        --macos-signed-app-name="$BUNDLE_ID" \
        --macos-app-version="$FILE_VERSION" \
        --macos-app-icon="$BUILD_DIR/eligma.icns" \
        --product-name="$APP_NAME" \
        --product-version="$FILE_VERSION" \
        --company-name="Agent-0808" \
        --copyright="Copyright ©2025-2026 Agent-0808. Licensed under GPLv3." \
        --trademarks="Blue Archive ©NEXON Games Co., Ltd. & Yostar, Inc. This tool is unofficial and not endorsed by them." \
        --output-dir="$BUILD_DIR" \
        --output-filename=Blue-Archive-Modding-and-Patching-Tool \
        --report="$BUILD_DIR/compilation-report.xml" \
        --assume-yes-for-downloads \
        ba_modding_toolkit
)

BUILT_APPS=("$BUILD_DIR"/*.app)
APP="$BUILD_DIR/$APP_NAME.app"
if [[ ${BUILT_APPS[0]} != "$APP" ]]; then
    mv "${BUILT_APPS[0]}" "$APP"
fi
codesign --verify --deep --strict "$APP"

# --- Package the DMG (.app + /Applications shortcut) ---
STAGING="$BUILD_DIR/dmg"
rm -rf "$STAGING"
mkdir -p "$STAGING" "$DIST_DIR"
ditto "$APP" "$STAGING/$APP_NAME.app"
ln -s /Applications "$STAGING/Applications"

DMG="$DIST_DIR/Blue-Archive-Modding-and-Patching-Tool-$VERSION-macos-$(uname -m).dmg"
rm -f "$DMG" "$DMG.md5"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$STAGING"

# MD5 file in md5sum format ("<hash>  <file name>"), uploaded with the DMG
HASH=$(md5 -q "$DMG")
echo "$HASH  $(basename "$DMG")" > "$DMG.md5"

echo "Done: $DMG ($HASH)"
