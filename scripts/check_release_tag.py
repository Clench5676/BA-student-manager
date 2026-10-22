"""Validate a published stable release and its exact checkout before a Windows build."""

import json
import os
from pathlib import Path
import re
import subprocess
import tomllib


STABLE_TAG = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")


def stable_tag(tag: object) -> str:
    if not isinstance(tag, str) or STABLE_TAG.fullmatch(tag) is None:
        raise SystemExit("Only a stable MAJOR.MINOR.PATCH release tag may build Windows release assets.")
    return tag


def published_tag(event: object) -> str:
    if os.environ.get("GITHUB_EVENT_NAME") != "release" or not isinstance(event, dict) or event.get("action") != "published":
        raise SystemExit("Windows release assets require a published release event.")
    release = event.get("release")
    if (not isinstance(release, dict) or release.get("draft") is not False or release.get("prerelease") is not False
            or not isinstance(release.get("published_at"), str) or not release["published_at"]):
        raise SystemExit("Draft, unpublished and prerelease releases cannot build Windows release assets.")
    tag = stable_tag(release.get("tag_name"))
    if os.environ.get("RELEASE_TAG", tag) != tag:
        raise SystemExit("The requested release tag differs from the published release event.")
    return tag


def check_tag(tag: str) -> None:
    tag = stable_tag(tag)
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"],
                            capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f"Release tag {tag!r} does not exist or does not point to a commit.")
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if result.stdout.strip() != head:
        raise SystemExit(f"Release tag {tag!r} does not point at the checked-out commit ({head}).")
    event_commit = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?", event_commit) or event_commit.lower() != head.lower():
        raise SystemExit("The checked-out commit differs from the published release event.")


def main() -> None:
    try:
        with Path(os.environ["GITHUB_EVENT_PATH"]).open(encoding="utf-8") as stream:
            event = json.load(stream)
    except (KeyError, OSError, ValueError) as error:
        raise SystemExit("Cannot read the published release event.") from error
    tag = published_tag(event)
    with open("pyproject.toml", "rb") as stream:
        version = tomllib.load(stream)["project"]["version"]
    if version != tag:
        raise SystemExit(f"Project version {version!r} differs from release tag {tag!r}.")
    check_tag(tag)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
        print(f"tag={tag}", file=stream)
    print(f"Published stable release {tag!r} matches the project version and checked-out commit.")


if __name__ == "__main__":
    main()
