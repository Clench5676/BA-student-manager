# scripts/build_windows.ps1
#
# Build the Windows GUI and CLI with Nuitka (one file each) and write an MD5 file next to each build:
#   dist\Blue-Archive-Modding-and-Patching-Tool-<version>-windows-x64.exe      (+ .md5)
#   dist\Blue-Archive-Modding-and-Patching-Tool-cli-<version>-windows-x64.exe  (+ .md5)
# The GUI build is the one the in-app update downloads; keep the names.
#
# Requires uv (https://docs.astral.sh/uv/); Nuitka downloads its C compiler on first use.
# Usage, from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1 [-Python 3.12.11] [-NuitkaVersion 4.3]

param(
    [string]$Python = "3.12.11",
    [string]$NuitkaVersion = "4.3"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
$Build = Join-Path $Root "build\windows"
$Dist = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $Build, $Dist | Out-Null

# --- Build environment (separate venv, leaves the development .venv alone) ---
$env:UV_PROJECT_ENVIRONMENT = Join-Path $Build "venv"
uv sync --frozen --no-dev --python $Python
if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
$Py = Join-Path $env:UV_PROJECT_ENVIRONMENT "Scripts\python.exe"
uv pip install --python $Py "nuitka==$NuitkaVersion" ordered-set
if ($LASTEXITCODE -ne 0) { throw "installing Nuitka failed" }

# --- Version info: _version.py for the app, a numeric file version for Windows ---
$Version = (& $Py -c "import tomllib; print(tomllib.load(open('pyproject.toml', 'rb'))['project']['version'])").Trim()
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "unexpected version $Version" }
$FileVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$VersionFile = "src\ba_modding_toolkit\_version.py"
$HadVersionFile = Test-Path $VersionFile
$env:GITHUB_SHA = (git rev-parse HEAD).Trim()
$env:GITHUB_REF_NAME = $Version
$env:GITHUB_REF_TYPE = "tag"
& $Py scripts\extract_version.py | Out-Null

$Name = "Blue-Archive-Modding-and-Patching-Tool"
$Gui = "$Name-$Version-windows-x64.exe"
$Cli = "$Name-cli-$Version-windows-x64.exe"
$Copyright = "Copyright $([char]0xA9)2025-2026 Agent-0808. Licensed under GPLv3."
$Trademarks = "Blue Archive $([char]0xA9)NEXON Games Co., Ltd. & Yostar, Inc. This tool is unofficial and not endorsed by them."
$Common = @(
    "--mode=onefile",
    "--include-package=ba_modding_toolkit",
    "--include-package=UnityPy.resources",
    "--include-package-data=ba_modding_toolkit",
    "--include-package-data=UnityPy",
    "--include-package-data=archspec",
    "--company-name=Agent-0808",
    "--copyright=$Copyright",
    "--trademarks=$Trademarks",
    "--product-version=$FileVersion",
    "--file-version=$FileVersion",
    "--output-dir=$Build",
    "--assume-yes-for-downloads"
)

try {
    # --- GUI: the web UI, with the classic GUI behind --classic ---
    Push-Location src
    & $Py -m nuitka @Common `
        --python-flag=-m `
        --enable-plugins=tk-inter `
        --include-data-dir=ba_modding_toolkit/assets=ba_modding_toolkit/assets `
        --include-data-dir=ba_modding_toolkit/locales=ba_modding_toolkit/locales `
        --include-data-dir=ba_modding_toolkit/web=ba_modding_toolkit/web `
        --include-data-dir=ba_modding_toolkit/catalog/data=ba_modding_toolkit/catalog/data `
        --windows-icon-from-ico=ba_modding_toolkit/assets/eligma.ico `
        --windows-console-mode=disable `
        --product-name="Blue Archive Modding and Patching Tool" `
        --file-description="Blue Archive Modding and Patching Tool" `
        --output-filename=$Gui `
        ba_modding_toolkit
    if ($LASTEXITCODE -ne 0) { throw "the GUI build failed" }
    Pop-Location

    # --- CLI ---
    & $Py -m nuitka @Common `
        --include-data-dir=src/ba_modding_toolkit/assets=ba_modding_toolkit/assets `
        --include-data-dir=src/ba_modding_toolkit/locales=ba_modding_toolkit/locales `
        --windows-icon-from-ico=src/ba_modding_toolkit/assets/eligma.ico `
        --windows-console-mode=force `
        --product-name="Blue Archive Modding and Patching Tool CLI" `
        --file-description="Blue Archive Modding and Patching Tool - Command Line Interface" `
        --output-filename=$Cli `
        src/ba_modding_toolkit/cli/__main__.py
    if ($LASTEXITCODE -ne 0) { throw "the CLI build failed" }
}
finally {
    if ((Get-Location).Path -ne $Root) { Pop-Location }
    if (-not $HadVersionFile) { Remove-Item -Force -ErrorAction SilentlyContinue $VersionFile }
}

# --- Builds and their MD5 files ("<hash>  <file name>") ---
foreach ($File in @($Gui, $Cli)) {
    Copy-Item -Force (Join-Path $Build $File) (Join-Path $Dist $File)
    $Hash = (Get-FileHash -Algorithm MD5 (Join-Path $Dist $File)).Hash.ToLower()
    [IO.File]::WriteAllText((Join-Path $Dist "$File.md5"), "$Hash  $File`n")
    Write-Host "Done: dist\$File ($Hash)"
}
