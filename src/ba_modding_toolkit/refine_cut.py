"""Deterministic join/generate/cut engine. No generation service or runtime launcher.

Inputs are public-runtime geometry, straight official pages and aligned full-frame
or cropped targets. All radii are composite pixels except bleed protection, which
is in output page texels. Geometry and page masks are explicit, never inferred from
portrait names. NumPy is a development dependency; this module has no App imports.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .refine_composite import compose, _distance, _rgba, _sample, _tri_map


@dataclass(frozen=True)
class CutParameters:
    swap_alpha: float = .1
    hidden: float = .01
    top_hidden: float = .9
    fill_measure_alpha: float = .005
    outline_zero: float = .004
    outline_opaque: float = .99
    colour_alpha: float = .5
    interior_alpha: float = .98
    drift_alpha: float = .01
    flat_gradient: float = .02
    flat_blur: int = 2
    halo_pad: int = 6
    grow: int = 16
    alpha_snap: float = .95
    feature_radius: int = 6
    feature_feather: int = 3
    drift_radius: int = 16
    drift_min_pixels: int = 50
    mesh_inset: int = 0
    mesh_feather: int = 5
    bleed_mode: str = 'smooth'
    ramp_low: float = 3 / 255
    ramp_high: float = 12 / 255
    bleed_pad: int = 2
    join_ratio: float = 1.
    min_iou: float = .96
    max_pose_rmse: float = 255.
    gradient_bins: int = 20

    @classmethod
    def r1b_reference(cls):
        """The owner-accepted R1b arithmetic, pinned: the defaults equal it.

        Overlay alpha feathers through the first five mesh pixels; bleed is a smooth push-pull fill.
        """
        return cls(mesh_inset=0, mesh_feather=5, bleed_mode='smooth')

    @classmethod
    def strict(cls):
        """A stricter variant, not visually accepted: no overlay alpha in the first five mesh pixels,
        then a five-pixel feather; bleed copies the nearest edited colour."""
        return cls(mesh_inset=5, bleed_mode='nearest')


@dataclass
class Pose:
    name: str
    geometry: dict
    target: Image.Image | None = None
    box: tuple[int, int, int, int] | None = None


@dataclass
class CutResult:
    pages: dict[str, Image.Image]
    report: dict
    edited_meshes: dict[str, Image.Image]
    allowed_changes: dict[str, Image.Image]


class GateError(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('Cut gates failed: ' + ', '.join(report['failures']))


def render_subset(geometry, keep, pages, comp):
    g = subset(geometry, keep)
    if not g['attachments']:
        return np.zeros(comp.image.size[::-1] + (4,), np.float32)
    return _rgba(compose(g, pages, density=comp.density, frame=comp.frame, inverse=False).image)


def dilate(mask, n):
    if n <= 0:
        return mask
    return np.asarray(Image.fromarray(np.uint8(mask) * 255).filter(ImageFilter.MaxFilter(2 * n + 1))) > 0


def pushpull(values, valid):
    """Fill invalid entries smoothly from the valid ones (pyramid push-pull)."""
    levels = []
    v = np.where(valid[..., None], values, 0).astype(np.float32)
    w = valid.astype(np.float32)
    while True:
        levels.append((v, w))
        h, wd = w.shape
        if h == 1 and wd == 1:
            break
        ph, pw = h + h % 2, wd + wd % 2
        vp = np.zeros((ph, pw, v.shape[2]), np.float32)
        vp[:h, :wd] = v * w[..., None]
        wp = np.zeros((ph, pw), np.float32)
        wp[:h, :wd] = w
        ws = wp.reshape(ph // 2, 2, pw // 2, 2).sum((1, 3))
        vs = vp.reshape(ph // 2, 2, pw // 2, 2, -1).sum((1, 3))
        v = np.divide(vs, ws[..., None], out=np.zeros_like(vs), where=ws[..., None] > 0)
        w = np.minimum(ws, 1)
    filled = levels[-1][0]
    for v, w in reversed(levels[:-1]):
        up = upsample(filled, v.shape[:2])
        filled = v * w[..., None] + up * (1 - w[..., None])
    return filled


def upsample(values, shape):
    """Bilinear 2x upsampling, cropped to ``shape``; nearest steps would leave blocks in the fill."""
    h, w = values.shape[:2]
    planes = [np.asarray(Image.fromarray(values[..., k]).resize((w * 2, h * 2), Image.Resampling.BILINEAR))
              for k in range(values.shape[2])]
    return np.stack(planes, -1)[:shape[0], :shape[1]]


def blur(values, radius):
    """Separable box blur with edge clamping."""
    out = values
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (radius + 1, radius)
        c = np.cumsum(np.pad(out, pad, mode='edge'), axis=axis)
        n = out.shape[axis]
        out = (np.take(c, np.arange(2 * radius + 1, 2 * radius + 1 + n), axis=axis)
               - np.take(c, np.arange(0, n), axis=axis)) / (2 * radius + 1)
    return out


def subset(geometry, keep):
    return {**geometry, 'attachments': [a for i, a in enumerate(geometry['attachments']) if keep(i, a)]}


def at(array, xy):
    """Bilinear sample of a composite-space array at texel centres."""
    value = _sample(array if array.ndim == 3 else array[..., None], xy)
    return value if array.ndim == 3 else value[:, 0]


def pixel(xy, size):
    return (np.clip(np.floor(xy[:, 1]).astype(int), 0, size[1] - 1),
            np.clip(np.floor(xy[:, 0]).astype(int), 0, size[0] - 1))


def inside(xy, size):
    return (xy[:, 0] >= .5) & (xy[:, 0] <= size[0] - .5) & (xy[:, 1] >= .5) & (xy[:, 1] <= size[1] - .5)


def fill_hidden(page, official, xx, yy, edited, hidden):
    """Hidden texels keep the official drawing, shifted by the layer's smoothed colour change.

    ``edited`` are the texels the change is measured on."""
    if not hidden.any():
        return
    if not edited.any():
        return
    x0, x1, y0, y1 = xx.min(), xx.max() + 1, yy.min(), yy.max() + 1
    residual = np.zeros((y1 - y0, x1 - x0, 3), np.float32)
    valid = np.zeros((y1 - y0, x1 - x0), bool)
    residual[yy[edited] - y0, xx[edited] - x0] = page[yy[edited], xx[edited], :3] - official[yy[edited], xx[edited], :3]
    valid[yy[edited] - y0, xx[edited] - x0] = True
    filled = pushpull(residual, valid)
    hy, hx = yy[hidden], xx[hidden]
    page[hy, hx, :3] = np.clip(official[hy, hx, :3] + filled[hy - y0, hx - x0], 0, 1)


def cut_swappable(geometry, comp, index, target, page, official, pages_of, touched, frozen, box=None, *, density, params):
    """Solve a swappable overlay slot (face, eyelids) against the final slots beneath and above it.

    Its lines are drawn in its alpha, so official alpha cannot carry the generated ones: each texel
    takes the smallest alpha, never below the official one, that reproduces the target over what lies
    beneath. The target's overall colour drift against the head is removed first, so the overlay does
    not end in a step at its mesh boundary.
    """
    a = geometry['attachments'][index]
    m = comp.inverse[index]
    keep = ~frozen[m['y'], m['x']]
    xx, yy, xy = m['x'][keep], m['y'][keep], m['xy'][keep]
    touched[yy, xx] = True
    size = comp.image.size
    below = render_subset(geometry, lambda i, _: i < index, pages_of(), comp)
    above = render_subset(geometry, lambda i, _: i > index, pages_of(), comp)
    a_f = comp.layers[index]['alpha']
    a_h = above[..., 3]
    # What the slot and everything beneath it must show, with the slots above removed.
    mid = np.divide(target - above[..., :3] * a_h[..., None], (1 - a_h)[..., None],
                    out=target.copy(), where=(1 - a_h)[..., None] > 1e-3)
    head = below[..., :3]
    if box is None:
        ys, xs = np.nonzero(a_f > params.drift_alpha)
        box = ((max(xs.min() - 24, 0), max(ys.min() - 24, 0), min(xs.max() + 25, size[0]), min(ys.max() + 25, size[1]))
               if len(xs) else (0, 0, *size))
    l, t, r, b = box
    window = np.zeros(a_f.shape, bool)
    window[t:b, l:r] = True
    # One colour offset per pose, from flat skin right around the face: hair next to it is redrawn
    # by the generation, not just shifted in colour.
    grey = head @ np.array([.299, .587, .114], np.float32)
    flat = blur(np.abs(np.diff(grey, axis=1, prepend=grey[:, :1])) + np.abs(np.diff(grey, axis=0, prepend=grey[:1])), params.flat_blur) < params.flat_gradient
    ring = window & (a_f < params.drift_alpha) & dilate(a_f > params.drift_alpha, params.drift_radius) & flat & (below[..., 3] > .99) & (a_h < .01)
    drift = np.median((head - mid)[ring], axis=0) if ring.sum() > params.drift_min_pixels else np.zeros(3, np.float32)
    mid = np.clip(mid + drift, 0, 1)
    delta = mid - head
    need = np.where(delta > 0, delta / np.maximum(1 - head, 1e-4), -delta / np.maximum(head, 1e-4)).max(-1)
    deviation = np.abs(delta).max(-1)
    need = np.clip(need, 0, 1) * np.clip((deviation - params.ramp_low) / (params.ramp_high - params.ramp_low), 0, 1)
    # Raise alpha only around this slot's own drawn features, feathered, and never at its mesh
    # boundary: elsewhere a separately generated crop redraws the head (jaw, hair tips) and would end
    # in a step.
    mesh = np.isfinite(comp.layers[index]['map'][..., 0])
    need *= np.clip((_distance(mesh, params.mesh_inset + params.mesh_feather) - 1 - params.mesh_inset) / params.mesh_feather, 0, 1)
    need *= np.clip(blur(dilate(a_f > params.swap_alpha, params.feature_radius).astype(np.float32), params.feature_feather), 0, 1)
    shown = inside(xy, size) & (at(a_h, xy) < params.top_hidden)
    texel = official[yy, xx, 3]
    alpha = np.where(shown, np.maximum(texel, at(need, xy)), texel)
    hx, hy = at(head, xy), at(mid, xy)
    colour = np.clip(hx + np.divide(hy - hx, alpha[:, None], out=np.zeros_like(hx), where=alpha[:, None] > 1e-3), 0, 1)
    colour = np.where((alpha > 1e-3)[:, None], colour, hy)
    page[yy[shown], xx[shown], :3] = colour[shown]
    page[yy[shown], xx[shown], 3] = alpha[shown]
    fill_hidden(page, official, xx, yy, shown, ~shown)
    return {'slot': a['slot'], 'attachment': a['attachment'], 'texels': int(len(xx)), 'edited': int(shown.sum()),
            'hidden': int((~shown).sum()), 'drift_255': np.round(np.asarray(drift) * 255, 1).tolist(),
            'ring_px': int(ring.sum()), 'alpha_raised': int((np.rint(alpha * 255) > np.rint(texel * 255)).sum())}


def transmission(geometry, comp, index, swaps, params):
    result = np.ones(comp.image.size[::-1], np.float32)
    for k in range(index + 1, len(geometry['attachments'])):
        a, alpha = geometry['attachments'][k], comp.layers[k]['alpha']
        if a['blend'] == 0:
            result *= 1 - (np.clip(alpha / params.swap_alpha, 0, 1) if a['slot'] in swaps else alpha)
    return result


def _region(a):
    r = a['region']
    return r['page'], r['name'], r.get('index', -1)


def _identity(a):
    return a['attachment'], _region(a)


def _mesh(a, size):
    uv = np.asarray(a['uvs'], np.float32).reshape(-1, 2) * size
    mask = Image.new('L', size)
    draw = ImageDraw.Draw(mask)
    for t in np.asarray(a['triangles']).reshape(-1, 3):
        draw.polygon([tuple(uv[k]) for k in t], fill=255)
    return np.asarray(mask) > 0


def _compact(comp):
    # The cut needs alpha and UV maps, not projection Jacobians.
    for layer in comp.layers:
        for key in ('gain', 'tail', 'screen', 'uv'):
            layer.pop(key, None)
    for mapping in comp.inverse:
        for key in ('gain', 'alpha', 'visibility', 'visible'):
            mapping.pop(key, None)
    return comp


def _masks(poses, masked_slots):
    all_a = [a for pose in poses for a in pose.geometry['attachments']]
    slots = {a['slot'] for a in all_a}
    unknown = set(masked_slots) - slots
    if unknown:
        raise ValueError(f'Unknown masked slots: {sorted(unknown)}')
    masked = set(masked_slots) | {a['slot'] for a in all_a if a['blend'] != 0}
    # Shared regions propagate masking to slots and their alternate attachments.
    while True:
        regions = {_region(a) for a in all_a if a['slot'] in masked}
        expanded = masked | {a['slot'] for a in all_a if _region(a) in regions}
        if expanded == masked:
            break
        masked = expanded
    swaps = set()
    for slot in slots - masked:
        identities = set()
        for pose in poses:
            attached = [a for a in pose.geometry['attachments'] if a['slot'] == slot]
            if len(attached) > 1:
                raise ValueError(f'Slot drawn more than once: {slot}')
            state = pose.geometry.get('slotAttachments')
            # Public runtime metadata distinguishes a hidden tint from attachment removal.
            identities.add(state.get(slot) if state is not None else (_identity(attached[0]) if attached else None))
        if len(identities) > 1:
            swaps.add(slot)
    for pose in poses:
        seen = {}
        for a in pose.geometry['attachments']:
            key = _region(a)
            if a['slot'] in masked:
                continue
            if key in seen:
                other = seen[key]
                if any(a[k] != other[k] for k in ('vertices', 'uvs', 'triangles')):
                    raise ValueError(f'Region drawn at different places: {key}, {other["slot"]}, {a["slot"]}')
            seen[key] = a
    return masked, swaps


def _target(pose, size, background=None):
    if pose.target is None:
        return None
    if pose.box is None:
        return pose.target.convert('RGBA').resize(size, Image.Resampling.LANCZOS)
    l, t, r, b = pose.box
    if not all(type(v) is int for v in pose.box) or not (0 <= l < r <= size[0] and 0 <= t < b <= size[1]):
        raise ValueError(f'Invalid target crop: {pose.name}')
    result = background.copy() if background is not None else Image.new('RGBA', size)
    result.paste(pose.target.convert('RGBA').resize((r - l, b - t), Image.Resampling.LANCZOS), (l, t))
    return result


def _nearest(values, valid):
    """Nearest seed on the texel grid, with deterministic Chebyshev tie order."""
    out, known = values.copy(), valid.copy()
    if not known.any():
        raise ValueError('Revealed part has no edited colour to extend')
    while not known.all():
        before = known.copy()
        for dy, dx in ((-1, 0), (0, -1), (0, 1), (1, 0), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            source = np.roll(before, (dy, dx), (0, 1))
            if dy < 0: source[dy:] = False
            if dy > 0: source[:dy] = False
            if dx < 0: source[:, dx:] = False
            if dx > 0: source[:, :dx] = False
            use = source & ~known
            out[use] = np.roll(out, (dy, dx), (0, 1))[use]
            known |= use
    return out


def join_band_gate(rendered, target, bands, reference, *, max_ratio=1., bins=20):
    """Gradient-distribution-matched interior RMSE, in straight RGB / 255 units."""
    actual, goal = _rgba(rendered), _rgba(target)
    opaque = goal[..., 3] > .97
    bands = {name: mask & opaque for name, mask in bands.items()}
    reference = reference & opaque
    for mask in bands.values():
        reference &= ~mask
    if not reference.any():
        return {name: {'pixels': int(mask.sum()), 'ratio': None, 'passed': not mask.any()}
                for name, mask in bands.items()}
    grey = goal[..., :3] @ np.array([.299, .587, .114])
    grad = np.hypot(np.diff(grey, axis=1, prepend=grey[:, :1]), np.diff(grey, axis=0, prepend=grey[:1]))
    boundaries = np.quantile(grad[reference], np.linspace(0, 1, bins + 1))
    idx = np.clip(np.digitize(grad, boundaries) - 1, 0, bins - 1)
    err2 = (((actual[..., :3] - goal[..., :3]) * 255).astype(np.float64) ** 2).mean(-1)
    ref = np.array([np.mean(err2[reference & (idx == b)]) if (reference & (idx == b)).any() else np.nan for b in range(bins)])
    report = {}
    for name, mask in bands.items():
        if not mask.any():
            report[name] = {'pixels': 0, 'ratio': 0., 'passed': True}
            continue
        weights = np.bincount(idx[mask], minlength=bins)[:bins]
        used = weights > 0
        expected = float(np.sqrt(np.sum(ref[used] * weights[used]) / weights.sum()))
        measured = float(np.sqrt(np.mean(err2[mask])))
        ratio = measured / expected if expected > 0 else (0. if measured == 0 else float('inf'))
        report[name] = {'pixels': int(mask.sum()), 'join_rmse': measured,
                        'detail_matched_interior_rmse': expected, 'ratio': ratio,
                        'passed': bool(np.isfinite(ratio) and ratio <= max_ratio)}
    return report


def check_invariants(pages, baseline, frozen, allowed, edited):
    report = {}
    for name, image in pages.items():
        a, b = np.asarray(image), np.asarray(baseline[name])
        changed = np.any(a != b, -1)
        report[name] = {'changed_texels': int(changed.sum()),
                        'masked_changed': int((changed & frozen[name]).sum()),
                        'outside_changed': int((changed & ~allowed[name]).sum()),
                        'alpha_outside_mesh': int(((a[..., 3] != b[..., 3]) & ~edited[name]).sum())}
    return report


def _review(folder, name, rendered, target, bands, focus_box=None):
    # Asset images must never be written into the source tree.
    folder = Path(folder).resolve()
    source_root = Path(__file__).resolve().parents[2]
    if folder == source_root or source_root in folder.parents:
        raise ValueError('Review folder must be outside the repository')
    folder.mkdir(parents=True, exist_ok=True)
    name = re.sub(r'[^a-zA-Z0-9_.-]', '_', name)
    masks = {'pose': None, **bands}
    boxes = []
    for label, mask in masks.items():
        box = focus_box
        if mask is not None:
            y, x = np.nonzero(mask)
            if not len(x): continue
            box = (max(0, int(x.min()) - 8), max(0, int(y.min()) - 8),
                   min(rendered.width, int(x.max()) + 9), min(rendered.height, int(y.max()) + 9))
        boxes.append((label, box))
        if label == 'silhouette' and mask is not None:
            for top in range(0, rendered.height, 128):
                for left in range(0, rendered.width, 128):
                    if mask[top:top + 128, left:left + 128].any():
                        boxes.append((f'silhouette-{left}-{top}', (left, top, min(left + 128, rendered.width), min(top + 128, rendered.height))))
    for label, box in boxes:
        tiles = [im.crop(box) if box else im for im in (target, rendered)]
        sheet = Image.new('RGBA', (tiles[0].width * 2 + 8, tiles[0].height), (128, 128, 128, 255))
        sheet.alpha_composite(tiles[0]); sheet.alpha_composite(tiles[1], (tiles[0].width + 8, 0))
        sheet.convert('RGB').save(folder / f'{name}-{re.sub(r"[^a-zA-Z0-9_.-]", "_", label)}.png')


def cut(poses: list[Pose], official_pages: dict[str, Image.Image], *, density=1, frame=None,
        atlas=None, masked_slots=(), parameters=None, diagnostic=False, review_dir=None,
        join_bands=None) -> CutResult:
    """Cut aligned targets onto integer-density pages, then gate every pose.

    The first pose is the base and requires a full-frame target. Swappable slots
    are solved bottom to top in each pose's actual draw order: upper overlays then
    see the final lower layers. Repeated identical attachments are solved once.
    Optional atlas metadata constrains bleed to exact packed region rectangles;
    without it, UV bounding boxes constrain bleed. No part names are hard-coded.
    """
    p = parameters or CutParameters()
    if type(density) is not int or density < 1:
        raise ValueError('Cut density must be a positive integer page scale')
    if not poses or poses[0].target is None or poses[0].box is not None:
        raise ValueError('The base pose requires a full-frame target')
    if len({pose.name for pose in poses}) != len(poses):
        raise ValueError('Pose names must be unique')
    if not (0 < p.swap_alpha <= 1 and 0 < p.hidden < 1 and 0 <= p.top_hidden <= 1
            and 0 < p.alpha_snap <= 1 and p.ramp_high > p.ramp_low >= 0
            and 0 <= p.min_iou <= 1 and p.join_ratio > 0 and p.max_pose_rmse >= 0
            and type(p.gradient_bins) is int and p.gradient_bins > 0 and p.bleed_mode in ('nearest', 'smooth')):
        raise ValueError('Invalid cut thresholds')
    for key in ('halo_pad', 'grow', 'feature_radius', 'feature_feather', 'drift_radius', 'mesh_inset', 'mesh_feather', 'bleed_pad', 'flat_blur'):
        if type(getattr(p, key)) is not int or getattr(p, key) < (1 if key == 'mesh_feather' else 0):
            raise ValueError(f'Invalid radius: {key}')
    masked, swaps = _masks(poses, masked_slots)
    if any(spec.get('pma', False) for pose in poses for spec in pose.geometry['pages']):
        raise ValueError('Cut requires straight-alpha atlas pages')
    baseline = {n: im.convert('RGBA').resize((im.width * density, im.height * density), Image.Resampling.NEAREST)
                for n, im in official_pages.items()}
    official = {n: _rgba(im) for n, im in baseline.items()}
    pages = {n: a.copy() for n, a in official.items()}
    pages_of = lambda: {n: Image.fromarray(np.uint8(np.rint(np.clip(a, 0, 1) * 255))) for n, a in pages.items()}
    base = _compact(compose(poses[0].geometry, baseline, density=density, frame=frame))
    frame, size = base.frame, base.image.size
    comps = [base]
    for pose in poses[1:]:
        comps.append(_compact(compose(pose.geometry, baseline, density=density, frame=frame)))
    identity = all(pose.target is None or _target(pose, size, comp.image).tobytes() == comp.image.tobytes()
                   for pose, comp in zip(poses, comps))
    frozen = {n: np.zeros(a.shape[:2], bool) for n, a in pages.items()}
    touched = {n: a.copy() for n, a in frozen.items()}
    edited = set()
    for pose, comp in zip(poses, comps):
        for a, m in zip(pose.geometry['attachments'], comp.inverse):
            if a['slot'] in masked:
                frozen[a['region']['page']][m['y'], m['x']] = True
    geometry = poses[0].geometry
    attachments = geometry['attachments']
    char = [i for i, a in enumerate(attachments) if a['slot'] not in masked]
    shape = size[::-1]
    a_off = 1 - np.prod([1 - base.layers[i]['alpha'] for i in char if attachments[i]['blend'] == 0], axis=0) if char else np.zeros(shape, np.float32)
    halo = np.maximum.reduce([base.layers[i]['alpha'] for i, a in enumerate(attachments) if a['slot'] in masked] or [np.zeros(shape, np.float32)])
    halo_zone = dilate(halo > .01, p.halo_pad)
    generated = _rgba(_target(poses[0], size))
    interior = generated[..., 3][a_off >= p.interior_alpha]
    level = float(np.median(interior)) if interior.size else 1.
    if level <= 0: raise ValueError('Generated interior alpha is zero')
    a_gen = np.clip(generated[..., 3] / level, 0, 1)
    a_gen[a_gen >= p.alpha_snap] = 1
    target = pushpull(generated[..., :3], (a_gen >= p.colour_alpha) & ~(halo_zone & (a_off < .9)))
    report = {'parameters': asdict(p), 'masked_slots': sorted(masked), 'swappable_slots': sorted(swaps),
              'opaque_level': level, 'layers': [], 'expressions': [], 'poses': [], 'failures': [],
              'frozen_shared_texels': 0, 'head_median_texels': {}, 'untargeted_filled': {}}
    shown_base = {}
    for i in char:
        a, m = attachments[i], base.inverse[i]
        if a['slot'] in swaps: continue
        name = a['region']['page']; page = pages[name]
        keep = ~frozen[name][m['y'], m['x']]
        report['frozen_shared_texels'] += int((~keep).sum())
        xx, yy, xy = m['x'][keep], m['y'][keep], m['xy'][keep]
        touched[name][yy, xx] = True
        shown = inside(xy, size) & (at(transmission(geometry, base, i, swaps, p), xy) > p.hidden)
        page[yy[shown], xx[shown], :3] = np.clip(at(target, xy[shown]), 0, 1)
        swap_above = np.maximum.reduce([base.layers[k]['alpha'] for k in range(i + 1, len(attachments))
                                       if attachments[k]['slot'] in swaps] or [np.zeros(shape, np.float32)])
        fill_hidden(page, official[name], xx, yy, shown & (at(swap_above, xy) < p.fill_measure_alpha), ~shown)
        shown_base[a['slot']] = (i, xx, yy, xy, shown)
        edited.add(_region(a))
        report['layers'].append({'slot': a['slot'], 'texels': int(len(xx)), 'edited': int(shown.sum()),
                                 'hidden': int((~shown).sum()), 'frozen': int((~keep).sum())})

    # Outer silhouette, including fully opaque generated pixels beyond the old outline.
    band = ((a_off < p.outline_opaque) | (a_gen < 1)) & ((a_off > p.outline_zero) | (a_gen > p.outline_zero)) & ~halo_zone & dilate(a_off > p.outline_zero, p.grow)
    ratio = a_gen / np.maximum(a_off, 1e-3)
    static = [i for i in char if attachments[i]['blend'] == 0 and attachments[i]['slot'] not in swaps]
    if static:
        distance = np.full((len(static),) + shape, p.grow + 1, np.float32)
        for n, i in enumerate(static):
            cover = base.layers[i]['alpha'] > .5
            for d in range(p.grow, -1, -1):
                distance[n][dilate(cover, d)] = d
            distance[n][~np.isfinite(base.layers[i]['map'][..., 0])] = np.inf
        contrib = np.stack([base.layers[i]['alpha'] for i in static])
        owner = np.where(contrib.max(0) > p.outline_zero, contrib.argmax(0), np.argmin(distance, axis=0))
        alpha_changes = 0
        for n, i in enumerate(static):
            a, m = attachments[i], base.inverse[i]; name = a['region']['page']
            keep = ~frozen[name][m['y'], m['x']]
            xx, yy, xy = m['x'][keep], m['y'][keep], m['xy'][keep]
            py, px = pixel(xy, size)
            in_band = inside(xy, size) & band[py, px]
            texel = official[name][yy, xx, 3]; r = ratio[py, px]
            shrink = in_band & (r <= 1)
            grow = in_band & (r > 1) & (owner[py, px] == n)
            new = texel.copy(); new[shrink] *= r[shrink]
            new[grow] = np.maximum(texel[grow], a_gen[py[grow], px[grow]])
            alpha_changes += int((np.rint(new * 255) != np.rint(texel * 255)).sum())
            pages[name][yy, xx, 3] = new
        report['alpha_changed_texels'] = alpha_changes

    # Targeted median vote near default swappable features, sampled in each pose's own UV map.
    features = np.maximum.reduce([base.layers[i]['alpha'] for i in char if attachments[i]['slot'] in swaps]
                                 or [np.zeros(shape, np.float32)]) > p.swap_alpha
    near_features = dilate(features, p.feature_radius)
    goals = [target]
    for pose in poses[1:]:
        goals.append(_rgba(_target(pose, size))[..., :3] if pose.target is not None else None)
    revealed_by = {pose.name: {} for pose in poses}
    for slot, (i, xx, yy, xy, shown) in shown_base.items():
        a = attachments[i]; name = a['region']['page']
        py, px = pixel(xy, size)
        sel = inside(xy, size) & near_features[py, px]
        if not any(b['slot'] in swaps for b in attachments[i + 1:]):
            sel[:] = False
        samples = np.full((len(poses), int(sel.sum()), 3), np.nan, np.float32)
        target_seen = shown.copy()
        no_target_seen = np.zeros(len(xx), bool)
        base_direct = (_texel_visibility(geometry, baseline, i, swaps, p)[yy, xx]
                       if any(pose.target is None for pose in poses) else np.zeros(len(xx), bool))
        for n, (pose, comp, goal) in enumerate(zip(poses, comps, goals)):
            matches = [j for j, b in enumerate(pose.geometry['attachments']) if b['slot'] == slot and _identity(b) == _identity(a)]
            if not matches:
                revealed_by[pose.name][slot] = 0
                continue
            j = matches[0]; m = comp.inverse[j]
            # Map by atlas texel, never reuse base world positions after animation.
            lookup = np.full(pages[name].shape[:2] + (2,), np.nan, np.float32)
            lookup[m['y'], m['x']] = m['xy']
            pxy = lookup[yy, xx]
            finite = np.isfinite(pxy).all(-1)
            pxy = np.nan_to_num(pxy)
            use = finite & inside(pxy, size) & (at(transmission(pose.geometry, comp, j, swaps, p), pxy) > p.hidden)
            if pose.box is not None:
                by, bx = pixel(pxy, size); l, t, r, b = pose.box
                use &= (bx > l) & (bx < r - 1) & (by > t) & (by < b - 1)
            revealed_by[pose.name][slot] = int((use & ~shown).sum())
            if goal is not None:
                target_seen |= use
                samples[n, use[sel]] = at(goal, pxy[sel][use[sel]])
            else:
                no_target_seen |= _texel_visibility(pose.geometry, baseline, j, swaps, p)[yy, xx]
        have = np.isfinite(samples[..., 0]).any(0)
        sx, sy = xx[sel], yy[sel]
        pages[name][sy[have], sx[have], :3] = np.clip(np.nanmedian(samples[:, have], axis=0), 0, 1)
        report['head_median_texels'][slot] = int(have.sum())
        # Untargeted animation reveals extend the nearest edited colour of this part only.
        extend = no_target_seen & ~target_seen & ~base_direct
        report['untargeted_filled'][slot] = int(extend.sum())
        if extend.any():
            x0, x1, y0, y1 = xx.min(), xx.max() + 1, yy.min(), yy.max() + 1
            valid = np.zeros((y1 - y0, x1 - x0), bool)
            valid[yy[target_seen] - y0, xx[target_seen] - x0] = True
            fill = _nearest(pages[name][y0:y1, x0:x1, :3], valid)
            pages[name][yy[extend], xx[extend], :3] = fill[yy[extend] - y0, xx[extend] - x0]

    solved = set()
    for n, (pose, original_comp) in enumerate(zip(poses, comps)):
        if pose.target is None: continue
        pg = pose.geometry
        # Base uses official alpha to define support; expression support follows the final pages, as R1b.
        pc = base if n == 0 else _compact(compose(pg, pages_of(), density=density, frame=frame))
        goal = target if n == 0 else _rgba(_target(pose, size, pc.image))[..., :3]
        for j, a in enumerate(pg['attachments']):
            if a['slot'] not in swaps or a['slot'] in masked: continue
            key = (a['slot'], _identity(a))
            if key in solved: continue
            name = a['region']['page']
            item = cut_swappable(pg, pc, j, goal, pages[name], official[name], pages_of,
                                 touched[name], frozen[name], box=pose.box, density=density, params=p)
            item.update(pose=pose.name, frozen=int(frozen[name][pc.inverse[j]['y'], pc.inverse[j]['x']].sum()))
            report['layers' if n == 0 else 'expressions'].append(item)
            solved.add(key); edited.add(_region(a))

    # Mesh protection permits polygon packing; rectangles constrain only bleed extent.
    covered = {n: np.zeros_like(a) for n, a in frozen.items()}
    protect = {n: np.zeros_like(a) for n, a in frozen.items()}
    rects = {}
    drawn = set()
    for pose in poses:
        for a in pose.geometry['attachments']:
            name = a['region']['page']; key = _region(a); drawn.add(key)
            mesh = _mesh(a, baseline[name].size)
            if key in edited: covered[name] |= mesh
            else: protect[name] |= dilate(mesh, p.bleed_pad)
            uv = np.asarray(a['uvs']).reshape(-1, 2) * baseline[name].size
            rects[key] = (*np.floor(uv.min(0)).astype(int), *np.ceil(uv.max(0)).astype(int))
    if atlas is not None:
        from .atlas_remap import _box
        rects = {(r.page, r.name, r.index): _box(r, atlas.pages[r.page], baseline[r.page]) for r in atlas.regions.values()}
        edited_boxes = {(key[0], rects[key]) for key in edited}
        for key, box in rects.items():
            if key not in drawn and (key[0], box) not in edited_boxes:
                l, t, r, b = box; protect[key[0]][t:b, l:r] = True
    allowed = {n: covered[n] | touched[n] for n in pages}
    mesh_masks = {n: touched[n].copy() for n in pages}
    # Preserve reference draw-order region traversal, including aliases only once.
    ordered = list(dict.fromkeys(_region(a) for pose in poses for a in pose.geometry['attachments'] if _region(a) in edited))
    for key in ordered:
        name = key[0]; l, t, r, b = rects[key]
        view = pages[name][t:b, l:r]
        if p.bleed_mode == 'smooth':
            fill = pushpull(view[..., :3], view[..., 3] > 0)
        else:
            # Only this region supplies seed colours; overlapping atlas rectangles do not.
            own = np.zeros(pages[name].shape[:2], bool)
            for pose in poses:
                for a in pose.geometry['attachments']:
                    if _region(a) == key: own |= _mesh(a, baseline[name].size)
            valid = (view[..., 3] > 0) & own[t:b, l:r] & ~frozen[name][t:b, l:r]
            fill = _nearest(view[..., :3], valid) if valid.any() else view[..., :3]
        bleed = (view[..., 3] == 0) & ~covered[name][t:b, l:r] & ~protect[name][t:b, l:r] & ~frozen[name][t:b, l:r]
        view[..., :3][bleed] = fill[bleed]
        allowed[name][t:b, l:r] |= bleed
    result = {n: im.copy() for n, im in baseline.items()} if identity else pages_of()
    report['identity'] = identity
    report['edited_regions'] = [list(key) for key in sorted(edited)]
    report['invariants'] = check_invariants(result, baseline, frozen, allowed, mesh_masks)
    for name, checks in report['invariants'].items():
        for key in ('masked_changed', 'outside_changed', 'alpha_outside_mesh'):
            if checks[key]: report['failures'].append(f'{name}:{key}')

    direct_reveals = revealed_texels(poses, baseline, masked_slots=masked_slots, parameters=p)
    for n, (pose, comp) in enumerate(zip(poses, comps)):
        rendered = compose(pose.geometry, result, density=density, frame=frame, inverse=False).image
        slot_rows = []
        for j, (a, m) in enumerate(zip(pose.geometry['attachments'], comp.inverse)):
            name = a['region']['page']; yy, xx = m['y'], m['x']
            off, final = np.asarray(baseline[name])[yy, xx], np.asarray(result[name])[yy, xx]
            shown = inside(m['xy'], size) & (at(transmission(pose.geometry, comp, j, swaps, p), m['xy']) > p.hidden)
            items = [r for r in report['layers'] + report['expressions'] if r.get('slot') == a['slot'] and r.get('pose') == pose.name]
            slot_rows.append({'slot': a['slot'], 'attachment': a['attachment'],
                              'edited': int(np.any(off != final, -1).sum()), 'hidden': int((~shown).sum()),
                              'revealed': direct_reveals[n]['slots'].get(a['slot'], {}).get('revealed', 0),
                              'alpha_raised': int((final[:, 3] > off[:, 3]).sum()),
                              'drift_255': items[0].get('drift_255', [0., 0., 0.]) if items else [0., 0., 0.],
                              'frozen': int(frozen[name][yy, xx].sum())})
        row = {'name': pose.name, 'slots': slot_rows,
               'revealed': {slot: value['revealed'] for slot, value in direct_reveals[n]['slots'].items()},
               'revealed_texels': direct_reveals[n]['revealed_texels'],
               'drawn_revealed_texels': direct_reveals[n]['drawn_revealed_texels'],
               'raster_revealed': revealed_by[pose.name]}
        if pose.target is not None:
            goal = _target(pose, size, rendered)
            if n == 0:
                goal = Image.fromarray(np.uint8(np.rint(np.dstack((generated[..., :3], np.clip(generated[..., 3] / level, 0, 1))) * 255)))
            ga, ra = _rgba(goal), _rgba(rendered)
            valid = (ga[..., 3] > .97) & ~halo_zone
            if pose.box is not None:
                window = np.zeros(shape, bool); l, t, r, b = pose.box; window[t:b, l:r] = True; valid &= window
            row['rgb_rmse'] = float(np.sqrt(np.mean(((ra[..., :3] - ga[..., :3]) * 255)[valid] ** 2))) if valid.any() else 0.
            keep = ~halo_zone
            if pose.box is not None: keep = keep & window
            ma, mb = (ra[..., 3] >= .5) & keep, (ga[..., 3] >= .5) & keep
            union = (ma | mb).sum()
            row['silhouette_iou'] = float((ma & mb).sum() / union) if union else 1.
            bands = {}
            beneath = np.zeros(shape, np.float32)
            for j, a in enumerate(pose.geometry['attachments']):
                alpha = comp.layers[j]['alpha']
                if a['slot'] in masked: continue
                bands[a['slot']] = (alpha > .02) & (alpha < .98) & (beneath > .5)
                beneath = 1 - (1 - beneath) * (1 - alpha)
            if join_bands is not None:
                bands = join_bands(pose, comp) if callable(join_bands) else join_bands
            reference = (_rgba(comp.image)[..., 3] > .99) & (halo < .01)
            if pose.box is not None:
                bands = {label: mask & window for label, mask in bands.items()}
                reference &= window
            row['joins'] = join_band_gate(rendered, goal, bands, reference, max_ratio=p.join_ratio, bins=p.gradient_bins)
            for label, check in row['joins'].items():
                if not check['passed']: report['failures'].append(f'{pose.name}:join:{label}')
            if row['silhouette_iou'] < p.min_iou: report['failures'].append(f'{pose.name}:silhouette')
            if row['rgb_rmse'] > p.max_pose_rmse: report['failures'].append(f'{pose.name}:rmse')
            if review_dir is not None:
                _review(review_dir, pose.name, rendered, goal, {**bands, 'silhouette': (((ra[..., 3] > .004) & (ra[..., 3] < .99)) | ((ga[..., 3] > .004) & (ga[..., 3] < .99)) | ((ra[..., 3] >= .5) ^ (ga[..., 3] >= .5))) & keep}, focus_box=pose.box)
        report['poses'].append(row)
    report['passed'] = not report['failures']
    masks = lambda values: {n: Image.fromarray(np.uint8(a) * 255) for n, a in values.items()}
    output = CutResult(result, report, masks(mesh_masks), masks(allowed))
    if report['failures'] and not diagnostic:
        raise GateError(report)
    return output


def _texel_visibility(geometry, pages, index, swaps, params):
    """Sample occlusion directly in world/UV space, independent of the pixel grid."""
    a = geometry['attachments'][index]
    page = pages[a['region']['page']]
    uv = np.asarray(a['uvs'], np.float32).reshape(-1, 2) * page.size
    world = np.asarray(a['vertices'], np.float32).reshape(-1, 2)
    mapping = _tri_map(uv, world, a['triangles'], page.size)
    yy, xx = np.nonzero(np.isfinite(mapping[..., 0]))
    points = mapping[yy, xx].astype(np.float64)
    transmission = np.ones(len(xx), np.float64)
    for b in geometry['attachments'][index + 1:]:
        if b['blend'] != 0: continue
        vertices = np.asarray(b['vertices'], np.float64).reshape(-1, 2)
        tex = pages[b['region']['page']]
        uvs = np.asarray(b['uvs'], np.float64).reshape(-1, 2) * tex.size
        sample_uv = np.full((len(xx), 2), np.nan)
        for ids in np.asarray(b['triangles']).reshape(-1, 3):
            v, target = vertices[ids], uvs[ids]
            use = np.isnan(sample_uv[:, 0]) & (points >= v.min(0) - 1e-6).all(-1) & (points <= v.max(0) + 1e-6).all(-1)
            indices = np.flatnonzero(use)
            if not len(indices): continue
            matrix = np.stack((v[1] - v[0], v[2] - v[0]), axis=1)
            if abs(np.linalg.det(matrix)) < 1e-10: continue
            bary = (points[indices] - v[0]) @ np.linalg.inv(matrix).T
            keep = (bary.min(-1) >= -1e-6) & (bary.sum(-1) <= 1 + 1e-6)
            sample_uv[indices[keep]] = target[0] + bary[keep, :1] * (target[1] - target[0]) + bary[keep, 1:] * (target[2] - target[0])
        hit = np.isfinite(sample_uv[:, 0])
        alpha = np.zeros(len(xx))
        tint = np.prod([b.get(k, [1, 1, 1, 1])[3] for k in ('slotColor', 'attachmentColor', 'skeletonColor')])
        alpha[hit] = _sample(_rgba(tex)[..., 3:], sample_uv[hit])[:, 0] * tint
        if b['slot'] in swaps: alpha = np.clip(alpha / params.swap_alpha, 0, 1)
        transmission *= 1 - alpha
    mask = np.zeros(page.size[::-1], bool)
    mask[yy, xx] = transmission > params.hidden
    return mask


def revealed_texels(poses: list[Pose], pages: dict[str, Image.Image], *, density=1., frame=None,
                    masked_slots=(), parameters=None):
    """Count newly exposed atlas texels without composite raster resampling.

    Counts include potential transparent mesh texels, plus a separate count for
    texels with nonzero official alpha. World/UV sampling avoids false reveals
    when a common root translation changes the composite pixel grid phase.
    Density/frame are accepted for parity with cut; visibility is frame independent.
    """
    if not poses: raise ValueError('At least one pose is required')
    p = parameters or CutParameters()
    masked, swaps = _masks(poses, masked_slots)
    initial = {}
    result = []
    for n, pose in enumerate(poses):
        row = {'name': pose.name, 'slots': {}, 'revealed_texels': 0, 'drawn_revealed_texels': 0}
        for j, a in enumerate(pose.geometry['attachments']):
            if a['slot'] in masked or a['slot'] in swaps: continue
            key = (a['slot'], _identity(a)); name = a['region']['page']
            mask = _texel_visibility(pose.geometry, pages, j, swaps, p)
            if n == 0: initial[key] = mask
            reveal = mask & ~initial.get(key, np.zeros_like(mask))
            count = int(reveal.sum()); drawn = int((reveal & (np.asarray(pages[name].getchannel('A')) > 0)).sum())
            row['slots'][a['slot']] = {'revealed': count, 'drawn_revealed': drawn}
            row['revealed_texels'] += count; row['drawn_revealed_texels'] += drawn
        result.append(row)
    return result


def main(argv=None):
    """Run a JSON manifest with explicit geometry; targets may be full frames or crops.

    Manifest keys: pages (name:path), poses ([name, geometry path, target path or
    null, box or null]), frame, density, atlas (optional path), masked_slots and
    parameters (optional named overrides). All manifest paths resolve beside it.
    Output pages, mesh masks, allowed masks, report and PNG reviews go outside Git.
    """
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--diagnostic', action='store_true')
    args = parser.parse_args(argv)
    source_root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output == source_root or source_root in output.parents:
        parser.error('Output must be outside the repository')
    manifest = args.manifest.resolve()
    spec = json.loads(manifest.read_text())
    resolve = lambda name: manifest.parent / name
    with_images = lambda name: Image.open(resolve(name)).convert('RGBA')
    pages = {name: with_images(path) for name, path in spec['pages'].items()}
    poses = [Pose(item['name'], json.loads(resolve(item['geometry']).read_text()),
                  with_images(item['target']) if item.get('target') else None,
                  tuple(item['box']) if item.get('box') else None) for item in spec['poses']]
    atlas = None
    if spec.get('atlas'):
        from .atlas_remap import parse_atlas
        atlas = parse_atlas(resolve(spec['atlas']).read_bytes())
    output.mkdir(parents=True, exist_ok=True)
    try:
        result = cut(poses, pages, density=spec.get('density', 1), frame=spec.get('frame'),
                     atlas=atlas, masked_slots=spec.get('masked_slots', ()),
                     parameters=CutParameters(**spec.get('parameters', {})), diagnostic=args.diagnostic,
                     review_dir=output / 'review')
    except GateError as exc:
        (output / 'report.json').write_text(json.dumps(exc.report, indent=2))
        raise
    files = {}
    for index, (name, image) in enumerate(result.pages.items()):
        # Atlas page names are logical keys, never output paths supplied by assets.
        prefix = f'page-{index}'
        image.save(output / (prefix + '.png'))
        result.edited_meshes[name].save(output / (prefix + '-meshes.png'))
        result.allowed_changes[name].save(output / (prefix + '-allowed.png'))
        files[name] = prefix + '.png'
    result.report['page_files'] = files
    (output / 'report.json').write_text(json.dumps(result.report, indent=2))
    print(json.dumps({'passed': result.report['passed'], 'pages': files, 'failures': result.report['failures']}))


if __name__ == '__main__':
    main()
