"""Deterministic seam ownership and native-grid controls for crop returns.

These controls belong to the input stage. They do not change the cut policy.
All colour distances use RGB values in 0-255 units.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from .refine_composite import movement_check


def detail(rgb):
    grey = np.asarray(rgb, np.float32) @ np.array([.299, .587, .114], np.float32)
    return np.hypot(np.diff(grey, axis=1, prepend=grey[:, :1]),
                    np.diff(grey, axis=0, prepend=grey[:1]))


def minimum_seam(cost):
    """One y per column; 8-connected, minimum summed cost, stable ties.

    Dynamic programming fits rectangular overlaps and makes the actual cut
    inspectable. No registration or displacement of either crop is performed.
    """
    cost = np.asarray(cost, np.float64)
    if cost.ndim != 2 or not cost.size or not np.isfinite(cost).all():
        raise ValueError('A finite, nonempty seam cost is required')
    h, w = cost.shape
    score = cost[:, 0].copy()
    back = np.zeros((h, w), np.int8)
    for x in range(1, w):
        candidates = np.stack((np.r_[np.inf, score[:-1]], score, np.r_[score[1:], np.inf]))
        step = np.argmin(candidates, axis=0)
        back[:, x] = step - 1
        score = cost[:, x] + candidates[step, np.arange(h)]
    path = np.empty(w, np.int32)
    path[-1] = np.argmin(score)
    for x in range(w - 1, 0, -1):
        path[x - 1] = path[x] + back[path[x], x]
    return path


def seam_mask(a, b, *, incoming_below=True, blend=2, agreement=6., preference=0.):
    """Choose one source per pixel; blend only flat, agreeing seam pixels.

    Disagreement and either source's detail dominate the weak position prior.
    A positive preference favours the incoming crop by moving the seam outward.
    """
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    if a.shape != b.shape or a.ndim != 3 or a.shape[2] != 3:
        raise ValueError('Seam observations must have matching RGB grids')
    h, w = a.shape[:2]
    y = np.arange(h)[:, None]
    disagreement = np.sqrt(np.mean((a - b) ** 2, axis=-1))
    gradient = np.maximum(detail(a), detail(b))
    position = y / max(h - 1, 1)
    preferred = .5 - preference if incoming_below else .5 + preference
    cost = disagreement + 2 * gradient + .25 * abs(position - preferred)
    # Keep both sources represented at the overlap's edges where possible.
    if h > 4:
        cost[[0, -1]] += 1e4
    path = minimum_seam(cost)
    signed = y - path[None, :]
    if not incoming_below:
        signed = -signed
    weight = (signed >= 0).astype(np.float32)
    band = abs(signed) <= blend
    # No softened duplicate contour: only sub-threshold colour and gradients mix.
    agree = (disagreement <= agreement) & (gradient <= agreement)
    if blend:
        use = band & agree
        weight[use] = np.clip(.5 + signed[use] / (2 * blend), 0, 1)
    return weight, band, path


def double_edge_count(a, b, merged, band, *, contrast=16., separation=6):
    """New pairs of dark ridges absent as a pair in either source, near a seam.

    Count horizontal and vertical profiles with two local dark extrema separated
    by 2..6 pixels. This detects cross-faded contours; it is not semantic proof
    about every line in a drawing. Identical source pairs are never counted.
    """
    grey = [np.asarray(c, np.float32) @ np.array([.299, .587, .114]) for c in (a, b, merged)]
    count = 0
    for axis in (0, 1):
        ridges = []
        for g in grey:
            lo, hi = np.roll(g, 1, axis), np.roll(g, -1, axis)
            ridge = (g < lo) & (g <= hi) & ((lo + hi) / 2 - g >= contrast)
            if axis == 0: ridge[[0, -1]] = False
            else: ridge[:, [0, -1]] = False
            ridges.append(ridge)
        for gap in range(2, separation + 1):
            pairs = [r & np.roll(r, gap, axis) for r in ridges]
            new = pairs[2] & ~pairs[0] & ~pairs[1] & band
            if axis == 0: new[:gap] = False
            else: new[:, :gap] = False
            count += int(new.sum())
    return count


def stitch(existing, incoming, covered, *, head=False, feather=48, blend=2, agreement=6.):
    """Stitch a rectangular crop into its already-covered local master window.

    Body tiles arrive in row order and may have top and left overlaps. A head
    arrives last, using four perimeter seams; its priority is a weak seam cost
    preference. The head's interior follows from those cuts, not a box overwrite.
    """
    h, w = covered.shape
    weight = np.ones((h, w), np.float32)
    band = np.zeros((h, w), bool)
    paths = []
    if not covered.any():
        return incoming.copy(), band, paths, weight

    def horizontal(start, stop, below, label, transpose=False):
        nonlocal weight, band
        aa = existing.transpose(1, 0, 2) if transpose else existing
        bb = incoming.transpose(1, 0, 2) if transpose else incoming
        wt, bd, path = seam_mask(aa[start:stop], bb[start:stop], incoming_below=below,
                                 blend=blend, agreement=agreement, preference=.4 if head else 0.)
        sl = (slice(None), slice(start, stop)) if transpose else (slice(start, stop), slice(None))
        weight[sl] = np.minimum(weight[sl], wt.T if transpose else wt)
        band[sl] |= bd.T if transpose else bd
        if below:
            if transpose: weight[:, :start] = 0
            else: weight[:start] = 0
        else:
            if transpose: weight[:, stop:] = 0
            else: weight[stop:] = 0
        points = [[int(start + v), int(x)] if transpose else [int(x), int(start + v)]
                  for x, v in enumerate(path)]
        paths.append({'side': label, 'points': points})

    if head and covered.all():
        fy, fx = min(feather, max(2, h // 4)), min(feather, max(2, w // 4))
        horizontal(0, fy, True, 'head-top')
        horizontal(h - fy, h, False, 'head-bottom')
        horizontal(0, fx, True, 'head-left', True)
        horizontal(w - fx, w, False, 'head-right', True)
    else:
        # Full covered strips, not a bounding box that would include uncovered pixels.
        top = 0
        while top < h and covered[top].all(): top += 1
        left = 0
        while left < w and covered[:, left].all(): left += 1
        if 0 < top < h: horizontal(0, top, True, 'top')
        if 0 < left < w: horizontal(0, left, True, 'left', True)
        if covered.any() and not paths:
            raise ValueError('Overlap is not a covered top/left strip or enclosed head')
    weight[~covered] = 1
    band &= covered
    merged = existing * (1 - weight[..., None]) + incoming * weight[..., None]
    return merged, band, paths, weight


def native_movement(official, generated, *, density, min_iou=.96, max_offset=1., max_shift=.5):
    """Reduce both observations to native density before making line maps.

    Translation search is a rejection control only: its result is never applied.
    It catches a coherent small drift even when a nearest-line percentile hides it.
    """
    size = tuple(max(1, round(s / density)) for s in official.size)
    a = official.convert('RGBA').resize(size, Image.Resampling.LANCZOS)
    b = generated.convert('RGBA').resize(size, Image.Resampling.LANCZOS)
    result = movement_check(a, b, density=1., min_iou=min_iou, max_offset=max_offset)
    result['symmetric_line_offset_p95_px'] = result['line_offset_p95_px']
    # Recall of existing lines tolerates added crispness. The reverse direction
    # is retained as a diagnostic, not used to penalise newly detectable detail.
    av, bv = np.asarray(a), np.asarray(b)
    reference_lines = (detail(av[..., :3]) > 20) & (av[..., 3] > 230)
    returned_lines = (detail(bv[..., :3]) > 20) & (bv[..., 3] > 128)
    distance = np.full(reference_lines.shape, 5., np.float32)
    expanded = Image.fromarray(np.uint8(returned_lines) * 255)
    for n in range(5):
        distance[np.asarray(expanded) > 0] = np.minimum(distance[np.asarray(expanded) > 0], n)
        expanded = expanded.filter(ImageFilter.MaxFilter(3))
    offset = float(np.percentile(distance[reference_lines], 95)) if reference_lines.any() else 0.
    result['line_offset_p95_px'] = offset
    result['flags'] = [f for f in result['flags'] if f != 'features_moved']
    if offset > max_offset: result['flags'].append('features_moved')
    aa, bb = np.asarray(a), np.asarray(b)
    ga, gb = detail(aa[..., :3]), detail(bb[..., :3])
    mask = (aa[..., 3] > 240) & (ga > 12)
    scores = []
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            shifted = np.roll(gb, (dy, dx), (0, 1))
            valid = mask.copy()
            valid[:3] = valid[-3:] = False
            valid[:, :3] = valid[:, -3:] = False
            # Relative gradients tolerate sharpening's change in contrast.
            error = abs(ga - shifted) / np.maximum(ga + shifted, 12)
            scores.append((float(np.mean(error[valid])) if valid.any() else 0., dx, dy))
    zero = next(s for s in scores if s[1:] == (0, 0))
    best = min(scores, key=lambda s: (s[0], abs(s[1]) + abs(s[2])))
    shift = float(np.hypot(best[1], best[2])) if best[0] < zero[0] * .95 else 0.
    result.update(native_size=list(size), translation_px=shift, max_translation_px=max_shift)
    if shift > max_shift: result['flags'].append('coherent_drift')
    return result


def gross_disagreement(a, b, visible, *, block=8, limit=48., max_share=.1):
    """Raw colour differences averaged over native-scale blocks, not line pixels.

    A large-area part change survives the box average; a narrow independent line
    placement does not dominate the gate. Limits are a contrast/area policy.
    """
    a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
    h, w = visible.shape
    values = []
    for y in range(0, h, block):
        for x in range(0, w, block):
            mask = visible[y:y + block, x:x + block]
            if mask.sum() < max(1, mask.size // 4): continue
            d = (a[y:y + block, x:x + block] - b[y:y + block, x:x + block])[mask]
            values.append(float(np.linalg.norm(np.mean(d, axis=0)) / np.sqrt(3)))
    share = float(np.mean(np.asarray(values) > limit)) if values else 0.
    return {'blocks': len(values), 'block_mean_limit_255': limit, 'gross_share': share,
            'max_share': max_share, 'passed': share <= max_share}


def nearest_inside(colour, seeds, query, *, radius=12, return_matched=False):
    """Exact nearest Euclidean interior seed within a bounded outline neighbourhood.

    The caller supplies a smooth fill for queries without a seed in that radius.
    This keeps large empty backgrounds out of the search and reports coverage.
    """
    result = colour.copy()
    possible = np.asarray(Image.fromarray(np.uint8(seeds) * 255).filter(ImageFilter.MaxFilter(2 * radius + 1))) > 0
    excluded = int((query & ~possible).sum())
    yy, xx = np.nonzero(query & possible)
    pending = np.ones(len(xx), bool)
    h, w = seeds.shape
    offsets = sorted((dx * dx + dy * dy, dy, dx) for dy in range(-radius, radius + 1)
                     for dx in range(-radius, radius + 1) if dx * dx + dy * dy <= radius * radius)
    for _, dy, dx in offsets:
        ids = np.flatnonzero(pending)
        if not len(ids): break
        y, x = yy[ids] + dy, xx[ids] + dx
        valid = (x >= 0) & (x < w) & (y >= 0) & (y < h)
        ids, x, y = ids[valid], x[valid], y[valid]
        hit = seeds[y, x]
        ids, x, y = ids[hit], x[hit], y[hit]
        result[yy[ids], xx[ids]] = colour[y, x]
        pending[ids] = False
    if return_matched:
        matched = np.zeros(query.shape, bool)
        matched[yy[~pending], xx[~pending]] = True
        return result, matched
    return result, int(pending.sum()) + excluded


def fringe_gate(image, key, *, reference=None, max_distance=48., max_complement_share=.02):
    """Measure outline colours, subtracting existing artwork's edge treatment.

    Raw distance and complement share remain visible. Gate excess over the same
    reference pixels so intentional dark contours and translucent parts do not
    fail an exact identity. Unpaired changed outline pixels fail closed.
    """
    a = np.asarray(image.convert('RGBA'), np.float32)
    alpha, rgb = a[..., 3] / 255, a[..., :3]
    core = Image.fromarray(np.uint8(alpha >= .5) * 255)
    outside = Image.fromarray(np.uint8(alpha < .5) * 255)
    near_core = np.asarray(core.filter(ImageFilter.MaxFilter(9))) > 0
    near_outside = np.asarray(outside.filter(ImageFilter.MaxFilter(9))) > 0
    edge = (alpha > .02) & (alpha < .98) & near_core & near_outside
    nearest, matched = nearest_inside(rgb, alpha >= .98, edge, return_matched=True)
    baseline = np.zeros_like(rgb)
    baseline_distance = np.zeros(edge.shape, np.float32)
    if reference is not None:
        ref = np.asarray(reference.convert('RGBA'), np.float32)
        if np.array_equal(a, ref):
            inside = nearest
        else:
            inside, _ = nearest_inside(ref[..., :3], ref[..., 3] >= 250, edge)
        baseline = ref[..., :3] - inside
        baseline_distance = np.linalg.norm(baseline, axis=-1)
        changed = np.max(abs(a - ref), axis=-1) > 1
    else:
        changed = np.ones(edge.shape, bool)
    residual = rgb - nearest
    distances = np.linalg.norm(residual, axis=-1)
    # Remove neutral lightness first: a dark official contour is not green spill.
    toward = 127.5 - np.asarray(key, np.float32)
    toward -= toward.mean()
    unit = toward / max(float(np.linalg.norm(toward)), 1)
    chroma = residual - residual.mean(-1, keepdims=True)
    extra = residual - baseline
    extra -= extra.mean(-1, keepdims=True)
    projection = (chroma * unit).sum(-1)
    extra_projection = (extra * unit).sum(-1)
    raw_leaning = (projection > 8) & (projection > .5 * np.maximum(np.linalg.norm(chroma, axis=-1), 1))
    leaning = (extra_projection > 8) & (extra_projection > .5 * np.maximum(np.linalg.norm(extra, axis=-1), 1))
    used = edge & matched
    raw_p95 = float(np.percentile(distances[used], 95)) if used.any() else 0.
    excess = np.maximum(0, distances - baseline_distance)
    excess_p95 = float(np.percentile(excess[used], 95)) if used.any() else 0.
    raw_share = float(raw_leaning[used].mean()) if used.any() else 0.
    share = float(leaning[used].mean()) if used.any() else 0.
    unpaired_changed = int((edge & ~matched & changed).sum())
    return {'outline_pixels': int(edge.sum()), 'paired_pixels': int(used.sum()),
            'unmatched_pixels': int((edge & ~matched).sum()), 'unpaired_changed_pixels': unpaired_changed,
            'distance_p95_255': raw_p95, 'complement_share': raw_share,
            'excess_distance_p95_255': excess_p95, 'excess_complement_share': share,
            'max_distance_255': max_distance, 'max_complement_share': max_complement_share,
            'passed': excess_p95 <= max_distance and share <= max_complement_share and unpaired_changed == 0}
