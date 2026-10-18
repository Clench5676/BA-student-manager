"""In-memory extraction of Spine files and atlas page names."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image

from .errors import AssetNotFound
from .unity import open_bundle


def png_bytes(image: Image.Image) -> bytes:
    """Encode an image as PNG bytes without creating a file."""
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def atlas_pages(data: bytes) -> list[str]:
    """Read page headers in both legacy and current Spine atlas syntax.

    A page starts after a blank line (or at the start); header properties contain
    colons. Region names may also end in .png and must not be treated as pages.
    """
    pages = []
    page_start = True
    for line in data.decode("utf-8-sig").splitlines():
        text = line.strip()
        if not text:
            page_start = True
        elif page_start and ":" not in text:
            pages.append(text)
            page_start = False
        else:
            page_start = False
    return pages


def extract_spine(bundles: list[Path]) -> dict[str, bytes]:
    """Extract every skeleton, atlas and texture, retaining atlas page filenames."""
    result, textures = {}, {}
    for path in bundles:
        with open_bundle(path) as env:
            for obj in env.objects:
                if obj.type.name == "TextAsset":
                    data = obj.read()
                    if data.m_Name.endswith((".skel", ".atlas")):
                        result[data.m_Name] = data.m_Script.encode("utf-8", "surrogateescape")
                elif obj.type.name == "Texture2D":
                    data = obj.read()
                    textures[data.m_Name] = png_bytes(data.image.convert("RGBA"))
    for name, data in textures.items():
        result[name if name.lower().endswith(".png") else name + ".png"] = data
    # Some bundles use a different case, a .png suffix, or a directory prefix
    # in the atlas. Serve the original page spelling as an alias.
    aliases = {Path(name).stem.lower(): data for name, data in textures.items()}
    aliases.update({name.lower(): data for name, data in textures.items()})
    for name, data in list(result.items()):
        if not name.endswith(".atlas"):
            continue
        for page in atlas_pages(data):
            if page in result:
                continue
            content = aliases.get(Path(page).stem.lower())
            if content is None:
                raise AssetNotFound(page)
            result[page] = content
    return result
