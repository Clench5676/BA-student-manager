"""Validate the existing release tag before a manual Windows build."""

import os
from pathlib import Path
import subprocess
import tomllib


def check_tag(tag: str) -> None:
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"],
                            capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f"Release tag {tag!r} does not exist or does not point to a commit. "
                         "Create the release locally with scripts/release.sh first.")
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if result.stdout.strip() != head:
        raise SystemExit(f"Release tag {tag!r} does not point at the checked-out commit ({head}). "
                         "Run the workflow from the matching commit.")


def main() -> None:
    with open("pyproject.toml", "rb") as f:
        version = tomllib.load(f)["project"]["version"]
    tag = os.environ.get("RELEASE_TAG") or version
    check_tag(tag)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as f:
        print(f"tag={tag}", file=f)
    print(f"Release tag {tag!r} matches the checked-out commit.")


if __name__ == "__main__":
    main()
