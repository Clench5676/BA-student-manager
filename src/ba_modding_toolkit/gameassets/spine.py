"""In-memory extraction of Spine files and atlas page names."""

from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path

from PIL import Image

from .errors import AssetNotFound
from .unity import open_bundle, ref_key, reference


def spine_stamps(bundles: list[Path]) -> list[tuple[str, int, int, int]]:
    """Ordered file versions, including replacements that preserve size and mtime."""
    stamps = []
    for path in dict.fromkeys(Path(path).resolve() for path in bundles):
        try:
            stat = path.stat()
        except FileNotFoundError:
            raise AssetNotFound(str(path)) from None
        stamps.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
    if not stamps:
        raise AssetNotFound("spine")
    return stamps


def spine_revision(bundles: list[Path]) -> str:
    """A URL segment identifying one ordered composition of bundle versions."""
    return hashlib.sha256(json.dumps(spine_stamps(bundles)).encode()).hexdigest()


def png_bytes(image: Image.Image, level: int | None = None) -> bytes:
    """Encode an image as PNG bytes without creating a file. ``level``: zlib level (default Pillow's 6)."""
    buffer = BytesIO()
    image.save(buffer, format="PNG", **({} if level is None else {"compress_level": level}))
    return buffer.getvalue()


def material_pma(tree: dict) -> bool | None:
    """The texture encoding expected by a Spine material, unknown without an alpha input setting."""
    keywords = set(tree.get("m_ValidKeywords") or []) | set((tree.get("m_ShaderKeywords") or "").split())
    if "_STRAIGHT_ALPHA_INPUT" in keywords:
        return False
    floats = dict((tree.get("m_SavedProperties") or {}).get("m_Floats") or [])
    if "_StraightAlphaInput" in floats:
        return True  # the shader keyword, rather than its inspector toggle, selects straight input
    return None


def atlas_alpha(data: bytes, materials: dict[str, bool]) -> bytes:
    """Fill missing page alpha flags from matching materials; explicit atlas flags win, including false."""
    if not materials:
        return data
    lines = data.decode("utf-8-sig").splitlines(keepends=True)
    out, start, changed = [], 0, False
    while start < len(lines):
        if not lines[start].strip():
            out.append(lines[start])
            start += 1
            continue
        end = start + 1
        while end < len(lines) and lines[end].strip():
            end += 1
        block = lines[start:end]
        if block and block[0].strip() and ":" not in block[0]:
            header = 1
            while header < len(block) and ":" in block[header]:
                header += 1
            page = Path(block[0].strip()).stem.lower()
            if page in materials and not any(line.strip().startswith("pma:") for line in block[1:header]):
                newline = "\r\n" if block[0].endswith("\r\n") else "\n"
                if not block[header - 1].endswith("\n"):
                    block[header - 1] += newline
                block.insert(header, f"pma: {str(materials[page]).lower()}{newline}")
                changed = True
        out.extend(block)
        start = end
    if not changed:
        return data
    return "".join(out).encode("utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8")


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
    result, textures, texture_names, materials = {}, {}, {}, {}
    for path in bundles:
        with open_bundle(path) as env:
            for obj in env.objects:
                if obj.type.name == "TextAsset":
                    data = obj.read()
                    if data.m_Name.endswith((".skel", ".atlas")):
                        result[data.m_Name] = data.m_Script.encode("utf-8", "surrogateescape")
                elif obj.type.name == "Texture2D":
                    data = obj.read()
                    texture_names[ref_key(obj.assets_file.name, obj.path_id)] = Path(data.m_Name).stem.lower()
                    # served from the same machine and held in memory only: level 1 encodes a lobby's large pages
                    # several times faster than the default and the larger bytes cost nothing on loopback
                    textures[data.m_Name] = png_bytes(data.image.convert("RGBA"), level=1)
                elif obj.type.name == "Material":
                    tree = obj.read_typetree()
                    pma = material_pma(tree)
                    main = dict((tree.get("m_SavedProperties") or {}).get("m_TexEnvs") or []).get("_MainTex") or {}
                    if pma is not None and (main.get("m_Texture") or {}).get("m_PathID"):
                        materials[ref_key(*reference(obj, main["m_Texture"]))] = pma
    alpha = {texture_names[key]: pma for key, pma in materials.items() if key in texture_names}
    for name, data in textures.items():
        result[name if name.lower().endswith(".png") else name + ".png"] = data
    # Some bundles use a different case, a .png suffix, or a directory prefix
    # in the atlas. Serve the original page spelling as an alias.
    aliases = {Path(name).stem.lower(): data for name, data in textures.items()}
    aliases.update({name.lower(): data for name, data in textures.items()})
    for name, data in list(result.items()):
        if not name.endswith(".atlas"):
            continue
        result[name] = atlas_alpha(data, alpha)
        for page in atlas_pages(data):
            if page in result:
                continue
            content = aliases.get(Path(page).stem.lower())
            if content is None:
                raise AssetNotFound(page)
            result[page] = content
    return result
