"""CPU setup-pose composition and visibility-aware colour projection.

Geometry comes from web/js/refine-composite.js and the shipped public Spine API.
Python never invokes Node. Coordinates are world y-up, atlas UV top-down. Sampling
is bilinear, at pixel centres; no gamma conversion is applied (like the App).
The four Spine blend factors operate on premultiplied framebuffer channels.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
from PIL import Image, ImageFilter


@dataclass
class Composite:
    image: Image.Image
    geometry: dict
    pages: dict[str, Image.Image]
    density: float
    frame: tuple[float, float, float, float]
    layers: list[dict]
    inverse: list[dict]


def _rgba(image):
    return np.asarray(image.convert('RGBA'), dtype=np.float32) / 255


def _sample(array, xy):
    """Bilinear sample at centre coordinates; clamp to texture borders."""
    x = np.clip(xy[..., 0] - .5, 0, array.shape[1] - 1)
    y = np.clip(xy[..., 1] - .5, 0, array.shape[0] - 1)
    ix, iy = x.astype(int), y.astype(int)
    jx, jy = np.minimum(ix + 1, array.shape[1] - 1), np.minimum(iy + 1, array.shape[0] - 1)
    fx, fy = (x - ix)[..., None], (y - iy)[..., None]
    return ((array[iy, ix] * (1 - fx) + array[iy, jx] * fx) * (1 - fy)
            + (array[jy, ix] * (1 - fx) + array[jy, jx] * fx) * fy)


def _tri_map(vertices, targets, triangles, size):
    """Rasterize affine triangle maps. Shared edges are written once per attachment."""
    width, height = size
    result = np.full((height, width, 2), np.nan, np.float32)
    for ids in np.asarray(triangles).reshape(-1, 3):
        v, t = vertices[ids], targets[ids]
        lo = np.maximum(np.floor(v.min(0)).astype(int), 0)
        hi = np.minimum(np.ceil(v.max(0)).astype(int), (width, height))
        if np.any(hi <= lo):
            continue
        matrix = np.stack((v[1] - v[0], v[2] - v[0]), axis=1)
        if abs(np.linalg.det(matrix)) < 1e-10:
            continue
        yy, xx = np.mgrid[lo[1]:hi[1], lo[0]:hi[0]]
        points = np.stack((xx + .5, yy + .5), axis=-1)
        bary = (points - v[0]) @ np.linalg.inv(matrix).T
        mask = (bary.min(-1) >= -1e-6) & (bary.sum(-1) <= 1 + 1e-6)
        view = result[lo[1]:hi[1], lo[0]:hi[0]]
        mask &= ~np.isfinite(view[..., 0])
        view[mask] = (t[0] + bary[..., :1] * (t[1] - t[0]) + bary[..., 1:] * (t[2] - t[0]))[mask]
    return result


def _blend(dst, src, mode):
    a = src[..., 3:4]
    if mode == 0:  # ONE, ONE_MINUS_SRC_ALPHA
        out, gain, tail = src + dst * (1 - a), np.broadcast_to(a, src[..., :3].shape), np.broadcast_to(1 - a, src[..., :3].shape)
    elif mode == 1:  # ONE, ONE
        out, gain, tail = src + dst, np.broadcast_to(a, src[..., :3].shape), np.ones_like(src[..., :3])
    elif mode == 2:  # DST_COLOR, ONE_MINUS_SRC_ALPHA
        out, gain, tail = src * dst + dst * (1 - a), a * dst[..., :3], src[..., :3] + 1 - a
    elif mode == 3:  # ONE, ONE_MINUS_SRC_COLOR
        out, gain, tail = src + dst * (1 - src), a * (1 - dst[..., :3]), 1 - src[..., :3]
    else:
        raise ValueError(f'Unknown Spine blend mode: {mode}')
    unclipped = (out[..., :3] >= 0) & (out[..., :3] <= 1)
    return np.clip(out, 0, 1), gain * unclipped, tail * unclipped


def _distance(mask, limit):
    """Chebyshev inward distance, in pixels; outside the image is always absent."""
    current = Image.fromarray(np.uint8(mask) * 255)
    result = np.zeros(mask.shape, np.float32)
    for _ in range(max(1, math.ceil(limit) + 1)):
        result += np.asarray(current) > 0
        padded = Image.new('L', (current.width + 2, current.height + 2))
        padded.paste(current, (1, 1))
        current = padded.filter(ImageFilter.MinFilter(3)).crop((1, 1, current.width + 1, current.height + 1))
    return result


def compose(geometry: dict, pages: dict[str, Image.Image], *, density=1., frame=None,
            inverse=True) -> Composite:
    """Compose straight RGBA and map every drawn texture texel back to the composite.

    Density 1 is official texture pixels; geometry.textureDensity maps world units. Explicit frame
    is (left, bottom, right, top), shared across expressions and arbitrary outputs.
    Inverse entries are sparse page coordinates; off-frame texels are present but
    invisible. Translucent overlaps retain visibility where their colour contributes.
    """
    if not math.isfinite(density) or density <= 0:
        raise ValueError('Density must be positive')
    attachments = geometry['attachments']
    if not attachments:
        raise ValueError('No visible region or mesh attachments')
    specs = {p['name']: p for p in geometry['pages']}
    all_v = np.concatenate([np.asarray(a['vertices']).reshape(-1, 2) for a in attachments])
    if not np.isfinite(all_v).all():
        raise ValueError('Non-finite geometry')
    if frame is None:
        frame = (math.floor(all_v[:, 0].min()) - 4, math.floor(all_v[:, 1].min()) - 4,
                 math.ceil(all_v[:, 0].max()) + 4, math.ceil(all_v[:, 1].max()) + 4)
    left, bottom, right, top = frame
    screen_scale = density * geometry.get('textureDensity', 1.)
    width, height = math.ceil((right - left) * screen_scale), math.ceil((top - bottom) * screen_scale)
    if min(width, height) <= 0 or width * height > 32_000_000:
        raise ValueError('Invalid or excessive composite frame')
    framebuffer = np.zeros((height, width, 4), np.float32)
    layers = []
    for a in attachments:
        page = pages[a['region']['page']]
        spec = specs[a['region']['page']]
        if abs(page.width / page.height - spec['width'] / spec['height']) > 1e-6:
            raise ValueError('Atlas page aspect ratio mismatch')
        v = np.asarray(a['vertices'], np.float32).reshape(-1, 2)
        screen = (v - (left, top)) * (screen_scale, -screen_scale)
        uv = np.asarray(a['uvs'], np.float32).reshape(-1, 2) * page.size
        mapping = _tri_map(screen, uv, a['triangles'], (width, height))
        mask = np.isfinite(mapping[..., 0])
        tex = _rgba(page)
        sample = np.zeros_like(framebuffer)
        sample[mask] = _sample(tex, mapping[mask])
        if spec.get('pma', False):
            sample[..., :3] = np.divide(sample[..., :3], sample[..., 3:4], out=np.zeros_like(sample[..., :3]), where=sample[..., 3:4] > 0)
        tint = np.prod([a.get(k, [1, 1, 1, 1]) for k in ('slotColor', 'attachmentColor', 'skeletonColor')], axis=0)
        sample *= tint
        sample[..., :3] *= sample[..., 3:4]
        framebuffer, gain, tail = _blend(framebuffer, sample, a['blend'])
        gain *= tint[:3]
        layers.append({'map': mapping, 'alpha': sample[..., 3], 'gain': gain, 'tail': tail, 'screen': screen, 'uv': uv})
    straight = framebuffer.copy()
    straight[..., :3] = np.divide(straight[..., :3], straight[..., 3:4], out=np.zeros_like(straight[..., :3]), where=straight[..., 3:4] > 0)
    image = Image.fromarray(np.uint8(np.rint(np.clip(straight, 0, 1) * 255)))
    maps = []
    if inverse:
        transmission = np.ones((height, width, 3), np.float32)
        for a, layer in reversed(list(zip(attachments, layers))):
            page = pages[a['region']['page']]
            mapping = _tri_map(layer['uv'], layer['screen'], a['triangles'], page.size)
            yy, xx = np.nonzero(np.isfinite(mapping[..., 0]))
            xy = mapping[yy, xx]
            inside = (xy[:, 0] >= .5) & (xy[:, 0] <= width - .5) & (xy[:, 1] >= .5) & (xy[:, 1] <= height - .5)
            gain = _sample(layer['gain'] * transmission, xy)
            alpha = _sample(framebuffer[..., 3:4], xy)
            texalpha = np.asarray(page.getchannel('A'))[yy, xx] > 0
            visible = inside & texalpha & (gain.max(-1) > 1e-4)
            visibility = np.zeros((page.height, page.width), bool)
            visibility[yy, xx] = visible
            maps.append({'x': xx, 'y': yy, 'xy': xy, 'visible': visible, 'gain': gain, 'alpha': alpha,
                         'visibility': visibility})
            transmission *= layer['tail']
        maps.reverse()
    return Composite(image, geometry, pages, density, tuple(frame), layers, maps)


def movement_check(official, generated, *, density=1., min_iou=.96, max_offset=3.) -> dict:
    """Reject moved silhouettes or internal line maps. Thresholds are explicit.

    Symmetric nearest-line distance uses a capped Chebyshev distance in official
    pixels; p95 detects local moved features that a global centroid can hide.
    This diagnostic cannot certify semantic/text fidelity or successful registration.
    """
    a = _rgba(official)
    b = _rgba(generated.resize(official.size, Image.Resampling.LANCZOS))
    ma, mb = a[..., 3] >= .5, b[..., 3] >= .5
    union = (ma | mb).sum()
    iou = float((ma & mb).sum() / union) if union else 1.
    def lines(c):
        gray = c[..., :3] @ np.array([.299, .587, .114])
        gx = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
        gy = np.abs(np.diff(gray, axis=0, prepend=gray[:1]))
        return ((gx + gy) > .16) & (c[..., 3] > .9)
    def offsets(source, target):
        distance = np.full(source.shape, math.ceil(max_offset * density * 4) + 1, np.float32)
        expanded = Image.fromarray(np.uint8(target) * 255)
        for n in range(int(distance.max())):
            hit = np.asarray(expanded) > 0
            distance[hit] = np.minimum(distance[hit], n)
            expanded = expanded.filter(ImageFilter.MaxFilter(3))
        return distance[source] / density
    la, lb = lines(a), lines(b)
    values = np.concatenate((offsets(la, lb), offsets(lb, la)))
    offset = float(np.percentile(values, 95)) if len(values) else 0.
    flags = []
    if iou < min_iou:
        flags.append('silhouette_moved')
    if offset > max_offset:
        flags.append('features_moved')
    return {'silhouette_iou': iou, 'line_offset_p95_px': offset, 'min_iou': min_iou,
            'max_offset_px': max_offset, 'flags': flags}


def project(composite: Composite, generated: Image.Image, *, band_width=3., colour_match=False,
            allow_flagged=False, min_iou=.96, max_offset=3., only_slots=None) -> tuple[dict, dict]:
    """Project colour residuals through the blend Jacobian, retaining official alpha.

    Exact identity bypasses all filtering. Edge/seam fade distances are measured on
    each actual page, then divided by page density, so 2x retains the same band.
    Coincident shared UVs sum derivatives; other reuse selects the first visible draw.
    Flagged input requires explicit diagnostic override; production callers fail.
    """
    if band_width < 0:
        raise ValueError('Band width cannot be negative')
    if not composite.inverse:
        raise ValueError('Composition requires an inverse map')
    generated = generated.convert('RGBA').resize(composite.image.size, Image.Resampling.LANCZOS)
    check = movement_check(composite.image, generated, density=composite.density, min_iou=min_iou, max_offset=max_offset)
    if check['flags'] and not allow_flagged:
        raise ValueError(f"Generated composite moved: {', '.join(check['flags'])}")
    original, target = _rgba(composite.image), _rgba(generated)
    delta = target[..., :3] - original[..., :3]
    output = {name: np.asarray(page.convert('RGBA')).copy() for name, page in composite.pages.items()}
    claimed = {name: np.zeros(value.shape[:2], bool) for name, value in output.items()}
    specs = {p['name']: p for p in composite.geometry['pages']}
    bands = []
    identity = generated.tobytes() == composite.image.tobytes()
    # Identical UV/world triangles draw the same texels at the same positions.
    # Sum their derivatives (normal halo plus additive glow, for example).
    groups = {}
    for a, mapping in zip(composite.geometry['attachments'], composite.inverse):
        key = (a['region']['page'], tuple(a['vertices']), tuple(a['uvs']), tuple(a['triangles']))
        groups.setdefault(key, []).append(mapping)
    effective = {}
    for group in groups.values():
        gain = sum(m['gain'] for m in group)
        visible = np.logical_or.reduce([m['visible'] for m in group])
        for mapping in group:
            effective[id(mapping)] = (gain, visible)
    for a, mapping in zip(composite.geometry['attachments'], composite.inverse):
        name = a['region']['page']
        page = output[name]
        yy, xx, visible = mapping['y'], mapping['x'], mapping['visible']
        scale = page.shape[1] / specs[name]['width']
        edge_distance = _distance(page[..., 3] > 0, max(1, band_width * scale)) / scale
        seam_distance = _distance(mapping['visibility'], max(1, band_width * scale)) / scale
        edge = edge_distance[yy, xx] <= band_width
        seam = (seam_distance[yy, xx] <= band_width) & ~edge
        bands.append((edge, seam))
        gain, shared_visible = effective[id(mapping)]
        use = shared_visible & ~claimed[name][yy, xx]
        claimed[name][yy[use], xx[use]] = True
        if only_slots is not None and a['slot'] not in only_slots:
            continue
        if identity or not use.any():
            continue
        pixels = _rgba(composite.pages[name])[yy, xx]
        pma = specs[name].get('pma', False)
        colour = pixels[:, :3].copy()
        if pma:
            colour = np.divide(colour, pixels[:, 3:4], out=np.zeros_like(colour), where=pixels[:, 3:4] > 0)
        correction = np.divide(_sample(delta, mapping['xy']) * mapping['alpha'], gain,
                               out=np.zeros_like(gain), where=gain > 1e-4)
        if colour_match:
            # Remove the per-attachment DC residual near the official join.
            join = visible & (edge | seam)
            if join.any():
                correction -= np.median(correction[join], axis=0)
        weight = np.ones(len(xx)) if band_width == 0 else np.clip((np.minimum(edge_distance[yy, xx], seam_distance[yy, xx]) - 1 / scale) / band_width, 0, 1)
        colour = np.clip(colour + correction * weight[:, None], 0, 1)
        if pma:
            colour *= pixels[:, 3:4]
        page[yy[use], xx[use], :3] = np.uint8(np.rint(colour[use] * 255))
    pages = {name: Image.fromarray(value) for name, value in output.items()}
    rendered = compose(composite.geometry, pages, density=composite.density, frame=composite.frame, inverse=False)
    error = (_rgba(rendered.image)[..., :3] - target[..., :3]) * 255
    metrics = []
    for a, mapping, (edge, seam) in zip(composite.geometry['attachments'], composite.inverse, bands):
        residual = _sample(error, mapping['xy'])
        def metric(mask):
            mask = mask & mapping['visible']
            return {'pixels': int(mask.sum()), 'rgb_rmse': float(np.sqrt(np.mean(residual[mask] ** 2))) if mask.any() else None}
        layer = composite.layers[len(metrics)]
        covered = np.isfinite(layer['map'][..., 0]) & (layer['alpha'] > .01)
        cy, cx = np.nonzero(covered)
        local_alignment = None
        if len(cx):
            box = (int(cx.min()), int(cy.min()), int(cx.max()) + 1, int(cy.max()) + 1)
            local_alignment = movement_check(composite.image.crop(box), generated.crop(box), density=composite.density,
                                             min_iou=min_iou, max_offset=max_offset)
        metrics.append({'misalignment': local_alignment, 'slot': a['slot'], 'attachment': a['attachment'], 'region': a['region'],
                        'visible': metric(np.ones(len(edge), bool)), 'edge_band': metric(edge), 'seam_band': metric(seam),
                        'covered_or_off_frame': int((~mapping['visible']).sum())})
    for item in metrics:
        if item['misalignment'] and item['misalignment']['flags']:
            check['flags'].append('attachment_moved:' + item['slot'])
    if check['flags'] and not allow_flagged:
        raise ValueError('Generated attachment features moved')
    return pages, {'movement': check, 'band_width_px': band_width, 'colour_match': colour_match,
                   'density': composite.density, 'frame': composite.frame, 'attachments': metrics}
