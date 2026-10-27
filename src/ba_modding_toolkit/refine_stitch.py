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


def double_edge_count(a, b, merged, band, *, contrast=16., separation=6, locations=False):
    """New pairs of dark ridges absent as a pair in either source, near a seam.

    Count horizontal and vertical profiles with two local dark extrema separated
    by 2..6 pixels. This detects cross-faded contours; it is not semantic proof
    about every line in a drawing. Identical source pairs are never counted.
    """
    grey = [np.asarray(c, np.float32) @ np.array([.299, .587, .114]) for c in (a, b, merged)]
    count = 0
    hits = []
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
            if locations:
                yy, xx = np.nonzero(new)
                hits.extend([[int(x), int(y), axis, gap] for y, x in zip(yy, xx)])
    return hits if locations else count


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


def nearest_colour(colour, seeds, query, *, radius=12, direction=None):
    """Nearest RGB colour among local interior samples, with spatial tie order.

    A spatially nearest pale surface is not the colour reference for a thin dark
    contour when the same ink continues slightly farther inside the outline.
    """
    out = colour.copy()
    yy, xx = np.nonzero(query)
    best = np.full(len(xx), np.inf)
    support = np.full(len(xx), -np.inf)
    h, w = seeds.shape
    offsets = sorted((dx*dx+dy*dy,dy,dx) for dy in range(-radius,radius+1)
                     for dx in range(-radius,radius+1) if dx*dx+dy*dy <= radius*radius)
    for _, dy, dx in offsets:
        x, y = xx + dx, yy + dy
        ids = np.flatnonzero((x >= 0) & (x < w) & (y >= 0) & (y < h) & (best > 0))
        ids = ids[seeds[y[ids], x[ids]]]
        if direction is not None:
            support[ids] = np.maximum(support[ids], colour[y[ids],x[ids]] @ direction)
        distance = np.sum((colour[yy[ids],xx[ids]] - colour[y[ids],x[ids]]) ** 2, axis=-1)
        ids, distance = ids[distance < best[ids]], distance[distance < best[ids]]
        out[yy[ids],xx[ids]] = colour[y[ids],x[ids]]
        best[ids] = distance
    matched = np.zeros(query.shape, bool);matched[yy[np.isfinite(best)],xx[np.isfinite(best)]] = True
    if direction is not None:
        envelope = np.zeros(query.shape, np.float32);envelope[yy,xx] = np.where(np.isfinite(support), support, colour[yy,xx] @ direction)
        return out, matched, envelope
    return out, matched


def despill_key_band(rgb, alpha, key, band, *, tolerance=4 / 255):
    """Remove excess key chroma at every visible band pixel, including alpha 1.

    Neighbour colours come from the same observation. Opaque, neutral thin ink
    is a safe fallback seed when a narrow part has no deep interior. Removal
    follows the positive RGB key vector and stops at neutral or the selected
    interior chroma, so it cannot invent the key's complement or amplify RGB.
    """
    rgb = np.asarray(rgb, np.float32)
    k = np.asarray(key, np.float32)
    direction = k - k.mean()
    direction /= max(float(np.linalg.norm(direction)), 1e-6)
    high, low = k >= .5, k < .5
    dominance = np.min(rgb[..., high], axis=-1) - np.max(rgb[..., low], axis=-1)
    seeds = (alpha >= .98) & (~band | (dominance <= tolerance))
    query = band & (alpha > 0) & ((rgb @ direction) > tolerance)
    from .refine_cut import pushpull
    fallback = pushpull(rgb, seeds)
    out = rgb.copy()
    # Removing spill can change the nearest palette entry. Re-evaluate that
    # choice until stable; each step only removes positive key RGB.
    for _ in range(4):
        closest, matched = nearest_colour(out, seeds, query)
        closest[query & ~matched] = fallback[query & ~matched]
        allowed = np.maximum(closest @ direction, 0)
        excess = np.maximum(out @ direction - allowed, 0)
        amount = excess / max(float(k @ direction), 1e-6)
        updated = out.copy()
        updated[query] = np.clip(out[query] - amount[query, None] * k, 0, 1)
        change = float(np.max(abs(updated - out)))
        out = updated
        if change < .25 / 255: break
    return out


def key_fringe_gate(image, key, *, density=1., max_rate=.001, band_native=3,
                    lean_threshold=40., excess_threshold=8.):
    """Visible spill towards the key, with opaque silhouette samples included."""
    a = np.asarray(image.convert('RGBA'), np.float32)
    rgb, alpha = a[..., :3], a[..., 3] / 255
    outside = Image.fromarray(np.uint8(alpha < .5) * 255)
    radius = max(1, round(band_native * density))
    band = np.asarray(outside.filter(ImageFilter.MaxFilter(2 * radius + 1))) > 0
    key = np.asarray(key, np.float32)
    k = key / 255
    direction = k - k.mean()
    direction /= max(float(np.linalg.norm(direction)), 1e-6)
    high, low = k >= .5, k < .5
    visible = a[..., 3] > 128
    lean = (np.min(rgb[..., high], axis=-1) > np.max(rgb[..., low], axis=-1) + lean_threshold) & visible
    query = band & lean
    interior = (alpha >= .98) & ~band
    closest, matched = nearest_colour(rgb, interior, query)
    excess = ((rgb - closest) @ direction) > excess_threshold
    faults = query & (~matched | excess)
    one_outside = np.asarray(outside.filter(ImageFilter.MaxFilter(3))) > 0
    length = float(((alpha >= .5) & one_outside).sum())
    rate = float(faults.sum() / max(length, 1.))
    return {'visible_key_lean_pixels': int(lean.sum()), 'band_key_lean_pixels': int(query.sum()),
            'band_key_excess_pixels': int(faults.sum()), 'band_key_unpaired_pixels': int((query & ~matched).sum()),
            'key_outline_length_px': length, 'key_excess_per_outline_px': rate,
            'max_key_excess_per_outline_px': max_rate, 'key_lean_threshold_255': lean_threshold,
            'key_excess_threshold_255': excess_threshold, 'key_gate_passed': rate <= max_rate}


def fringe_gate(image, key, *, reference=None, max_distance=48., max_complement_share=.02,
                density=1., max_unpaired_rate=.001, max_key_rate=.001, band_native=3):
    """Measure outline colours, subtracting existing artwork's edge treatment.

    Raw distance and complement share remain visible. Gate excess over the same
    reference pixels so intentional dark contours and translucent parts do not
    fail an exact identity. Unpaired changed pixels use a length-normalised rate.
    """
    a = np.asarray(image.convert('RGBA'), np.float32)
    alpha, rgb = a[..., 3] / 255, a[..., :3]
    core = Image.fromarray(np.uint8(alpha >= .5) * 255)
    outside = Image.fromarray(np.uint8(alpha < .5) * 255)
    near_core = np.asarray(core.filter(ImageFilter.MaxFilter(9))) > 0
    near_outside = np.asarray(outside.filter(ImageFilter.MaxFilter(9))) > 0
    edge = (alpha > .02) & (alpha < .98) & near_core & near_outside
    toward = 127.5 - np.asarray(key, np.float32)
    toward -= toward.mean()
    unit = toward / max(float(np.linalg.norm(toward)), 1)
    nearest, matched, support = nearest_colour(rgb, alpha >= .98, edge, direction=unit)
    projection = np.maximum(0, rgb @ unit - support)
    baseline_projection = np.zeros(edge.shape, np.float32)
    baseline = np.zeros_like(rgb)
    baseline_distance = np.zeros(edge.shape, np.float32)
    if reference is not None:
        ref = np.asarray(reference.convert('RGBA'), np.float32)
        if np.array_equal(a, ref):
            inside = nearest
            baseline_projection = projection.copy()
        else:
            inside, _, ref_support = nearest_colour(ref[..., :3], ref[..., 3] >= 250, edge, direction=unit)
            baseline_projection = np.maximum(0, ref[..., :3] @ unit - ref_support)
        baseline = ref[..., :3] - inside
        baseline_distance = np.linalg.norm(baseline, axis=-1)
        changed = np.max(abs(a - ref), axis=-1) > 1
    else:
        changed = np.ones(edge.shape, bool)
    residual = rgb - nearest
    distances = np.linalg.norm(residual, axis=-1)
    # A colour interpolated between two existing interior paints is not a
    # complementary fringe. Require chroma beyond the entire local interior
    # palette, not merely beyond its single nearest RGB sample.
    extra_projection = np.maximum(0, projection - baseline_projection)
    chroma = residual - residual.mean(-1, keepdims=True)
    raw_leaning = (projection > 8) & (projection > .5 * np.maximum(np.linalg.norm(chroma, axis=-1), 1))
    leaning = (extra_projection > 8) & (extra_projection > .5 * np.maximum(np.linalg.norm(chroma, axis=-1), 1))
    used = edge & matched
    raw_p95 = float(np.percentile(distances[used], 95)) if used.any() else 0.
    excess = np.maximum(0, distances - baseline_distance)
    excess_p95 = float(np.percentile(excess[used], 95)) if used.any() else 0.
    raw_share = float(raw_leaning[used].mean()) if used.any() else 0.
    share = float(leaning[used].mean()) if used.any() else 0.
    unpaired_changed = int((edge & ~matched & changed).sum())
    # A one-pixel boundary, rather than a four-pixel band, supplies the length.
    one_outside = np.asarray(outside.filter(ImageFilter.MaxFilter(3))) > 0
    outline_length = float(((alpha >= .5) & one_outside).sum())
    unpaired_rate = unpaired_changed / max(outline_length, 1.)
    key_report = key_fringe_gate(image, key, density=density, max_rate=max_key_rate, band_native=band_native)
    return {**key_report, 'outline_pixels': int(edge.sum()), 'paired_pixels': int(used.sum()),
            'unmatched_pixels': int((edge & ~matched).sum()), 'unpaired_changed_pixels': unpaired_changed,
            'outline_length_px': outline_length, 'outline_length_native_px': outline_length / density,
            'unpaired_per_outline_px': unpaired_rate,
            'max_unpaired_per_outline_px': max_unpaired_rate,
            'distance_p95_255': raw_p95, 'complement_share': raw_share,
            'excess_distance_p95_255': excess_p95, 'excess_complement_share': share,
            'max_distance_255': max_distance, 'max_complement_share': max_complement_share,
            'passed': excess_p95 <= max_distance and share <= max_complement_share and unpaired_rate <= max_unpaired_rate and key_report['key_gate_passed']}


def frame_background(mask):
    """Four-connected definite-key pixels touching any edge, via row-run unions."""
    mask = np.asarray(mask, bool)
    h, w = mask.shape
    parent, runs = [0], []
    previous = []
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for y in range(h):
        changes = np.flatnonzero(np.diff(np.r_[False, mask[y], False]))
        current = []
        j = 0
        for l, r in changes.reshape(-1, 2):
            ident = len(parent); parent.append(ident)
            if y in (0, h - 1) or l == 0 or r == w: parent[ident] = 0
            while j < len(previous) and previous[j][1] <= l: j += 1
            k = j
            while k < len(previous) and previous[k][0] < r:
                a, b = root(ident), root(previous[k][2])
                parent[max(a, b)] = min(a, b)
                k += 1
            current.append((int(l), int(r), ident))
            runs.append((y, int(l), int(r), ident))
        previous = current
    connected = np.zeros_like(mask)
    for y, l, r, ident in runs:
        if root(ident) == 0: connected[y, l:r] = True
    return connected


def translate_rgb(values, shift, fill=(255, 0, 255)):
    """One rigid subpixel translation, no registration warp; identity is exact."""
    dx, dy = map(float, shift)
    if max(abs(dx), abs(dy)) < 1e-8: return values.copy()
    h, w = values.shape[:2]
    return np.stack([np.asarray(Image.fromarray(values[..., c].astype(np.float32)).transform(
        (w, h), Image.Transform.AFFINE, (1, 0, -dx, 0, 1, -dy),
        Image.Resampling.BICUBIC, fillcolor=float(fill[c]))) for c in range(3)], -1)


def estimate_translation(a, b, visible, *, density=1., search=3.):
    """Estimate a rigid shift of b towards a using relative native gradients.

    A coarse search followed by 1/8-native-pixel refinement. No image is moved
    here. The caller enforces the correction cap and applies the shift once.
    """
    h, w = visible.shape
    size = (max(1, round(w / density)), max(1, round(h / density)))
    def resize(values):
        return np.stack([np.asarray(Image.fromarray(values[..., c].astype(np.float32)).resize(
            size, Image.Resampling.LANCZOS)) for c in range(3)], -1)
    ga, gb = detail(resize(a)), detail(resize(b))
    mask = np.asarray(Image.fromarray(np.uint8(visible) * 255).resize(size, Image.Resampling.NEAREST)) > 0
    margin = int(np.ceil(search)) + 1
    mask[:margin] = mask[-margin:] = False
    mask[:, :margin] = mask[:, -margin:] = False
    mask &= ga > 12
    yy, xx = np.nonzero(mask)
    if not len(xx): return {'shift_native': [0., 0.], 'error': 0., 'zero_error': 0., 'samples': 0}
    goal = ga[yy, xx]
    def score(dx, dy):
        x, y = xx - dx, yy - dy
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = x - x0, y - y0
        x0=np.clip(x0,0,gb.shape[1]-2); y0=np.clip(y0,0,gb.shape[0]-2)
        sample = (gb[y0,x0]*(1-fx)*(1-fy)+gb[y0,x0+1]*fx*(1-fy)+
                  gb[y0+1,x0]*(1-fx)*fy+gb[y0+1,x0+1]*fx*fy)
        return float(np.mean(abs(goal-sample)/np.maximum(goal+sample,12)))
    candidates = [(score(dx,dy),float(dx),float(dy)) for dy in range(-int(search),int(search)+1)
                  for dx in range(-int(search),int(search)+1)]
    best = min(candidates,key=lambda z:(z[0],abs(z[1])+abs(z[2])))
    for step in (.5,.25,.125):
        candidates = [(score(best[1]+dx,best[2]+dy),best[1]+dx,best[2]+dy)
                      for dy in (-step,0,step) for dx in (-step,0,step)]
        best = min(candidates,key=lambda z:(z[0],abs(z[1])+abs(z[2])))
    zero = score(0,0)
    # Avoid inventing a shift from numerical noise or perfectly identical grids.
    shift = [best[1],best[2]] if best[0] < zero * .95 else [0.,0.]
    return {'shift_native':shift,'error':best[0],'zero_error':zero,'samples':len(xx)}
