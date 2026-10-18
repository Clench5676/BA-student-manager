#!/usr/bin/env bash
# scripts/release.sh
#
# Publish a release from local builds: tag the current commit with the version in pyproject.toml (the bare version,
# e.g. 0.1.0-alpha), push the tag, and upload the builds with their .md5 files to a GitHub release with no notes.
# Pre-release versions (with a "-") are marked as pre-releases.
#
# Usage: scripts/release.sh dist/<build> [dist/<build> ...]
#   e.g. scripts/release.sh dist/*-0.1.0-alpha-*.dmg dist/*-0.1.0-alpha-*.exe
# .md5 files ("<hash>  <file name>") are written when missing and checked when present.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')
if [[ $# -eq 0 ]]; then
    echo "usage: $0 <build files>..." >&2
    exit 1
fi
md5_of() { python3 -c 'import hashlib, sys; print(hashlib.md5(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }

FILES=()
for f in "$@"; do
    [[ $f == *.md5 ]] && continue
    if [[ ! -f $f ]]; then echo "missing: $f" >&2; exit 1; fi
    name=$(basename "$f")
    if [[ $name != *"-$VERSION-"* ]]; then echo "$name is not a $VERSION build" >&2; exit 1; fi
    hash=$(md5_of "$f")
    if [[ -f $f.md5 ]]; then
        if [[ $(cut -d' ' -f1 < "$f.md5" | tr 'A-F' 'a-f') != "$hash" ]]; then echo "MD5 mismatch: $name" >&2; exit 1; fi
    else
        echo "$hash  $name" > "$f.md5"
    fi
    FILES+=("$f" "$f.md5")
done

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "commit or stash your changes first" >&2
    exit 1
fi
if ! git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
    git tag -a "$VERSION" -m "$VERSION"
fi
git push origin "refs/tags/$VERSION"

PRERELEASE=()
[[ $VERSION == *-* ]] && PRERELEASE=(--prerelease)
gh release create "$VERSION" --verify-tag --title "$VERSION" --notes "" ${PRERELEASE[@]+"${PRERELEASE[@]}"} "${FILES[@]}"
echo "Released $VERSION: ${FILES[*]}"
