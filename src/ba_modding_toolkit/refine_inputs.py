"""Offline generation inputs, distance keying and seam stitching for refinement.

No generator or runtime is launched. The caller supplies posed public-runtime
geometry. All images and plans are external artifacts. Cut policy stays in K6.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import shutil

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .refine_composite import compose, _rgba
from .refine_cut import Pose, GateError, cut, _masks, subset, pushpull, join_band_gate
from .refine_stitch import (stitch, native_movement, gross_disagreement, nearest_inside,
                            fringe_gate, double_edge_count, detail, frame_background,
                            estimate_translation, translate_rgb, despill_key_band)


@dataclass(frozen=True)
class InputParameters:
    pixel_budget: int = 1_573_000
    overlap: int = 64
    head_context: float = .65
    feather: int = 48
    # Retained for loading K7 plans; raw RMSE is diagnostic only.
    overlap_rmse: float = 2.
    seam_blend: int = 2
    seam_agreement: float = 6.
    native_line_offset: float = 1.
    native_translation: float = .5
    gross_block_contrast: float = 48.
    gross_share: float = .1
    fringe_distance: float = 48.
    fringe_complement_share: float = .02
    fringe_key_rate: float = .001
    silhouette_band_native: int = 3
    key_background_tolerance: float = 32.
    key_chroma_seed_tolerance: float = 4.
    translation_cap_native: float = 2.
    contour_rate: float = .05
    unpaired_outline_rate: float = .001
    min_iou: float = .96
    line_offset: float = 3.  # Legacy K7 plan field; native_line_offset gates returns.
    aspect_tolerance: float = .005
    budget_tolerance: float = .15
    alpha_normalisation: float = 1.
    alpha_snap: float = 1.
    key_alpha_rmse: float = 1.
    key_alpha_p99: float = 3.
    boundary_ratio: float = 1.
    expression_context_radius: int = 8


class InputGateError(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('Input gates failed: ' + ', '.join(report['failures']))


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def _external(folder):
    folder = Path(folder).resolve()
    root = Path(__file__).resolve().parents[2]
    if folder == root or root in folder.parents:
        raise ValueError('Artifacts must be outside the repository')
    return folder


def templates():
    return json.loads(Path(__file__).with_name('refine_prompts.json').read_text())['templates']


def prompt(template_id, *, version=1, **fields):
    selected = [t for t in templates() if (t['id'], t['version']) == (template_id, version)]
    if len(selected) != 1:
        raise ValueError('Unknown prompt template id/version')
    text = selected[0]['text'].format(**fields)
    if re.search(r'\b(?:transparen\w*|restor\w*|redesign\w*)\b', text, re.I):
        raise ValueError('Forbidden prompt wording')
    return text


def choose_key(image):
    """Maximise the minimum Euclidean RGB distance to visible straight colours."""
    a = _rgba(image)
    colours = a[..., :3][a[..., 3] > .02] * 255
    if not len(colours):
        raise ValueError('No character colours')
    candidates = [(0, 255, 0), (255, 0, 255), (0, 255, 255), (255, 128, 0), (0, 0, 255)]
    scores = [float(np.linalg.norm(colours - c, axis=-1).min()) for c in candidates]
    if max(scores) < 16:
        raise ValueError('No sufficiently distinct key colour among the candidates')
    return list(candidates[int(np.argmax(scores))]), scores


def flatten(image, key):
    a = _rgba(image)
    rgb = a[..., :3] * a[..., 3:] + np.asarray(key) / 255 * (1 - a[..., 3:])
    return Image.fromarray(np.uint8(np.rint(rgb * 255)))


def key_image(image, official, key, *, parameters=None, density=1.):
    """Outline-only distance matte; opaque returned interiors are byte-preserved.

    Alpha is the returned distance to the key relative to a local foreground
    estimate. Straight edge colour is copied from alpha >= .5 and despilled
    towards the interior; weaker coverage is filled from inside. Null edits
    preserve the reference's otherwise unobservable bytes exactly.
    """
    p = parameters or InputParameters()
    c = np.asarray(image.convert('RGB'), np.float32) / 255
    ref = _rgba(official)
    if c.shape[:2] != ref.shape[:2]:
        raise ValueError('Key and reference grids must match')
    k = np.asarray(key, np.float32) / 255
    unchanged = np.all(c == np.asarray(flatten(official, key), np.float32) / 255, -1)
    if unchanged.all():
        pixels = np.array(official.convert('RGBA'))
        alpha = np.clip(ref[..., 3] / p.alpha_normalisation, 0, 1)
        alpha[alpha >= p.alpha_snap] = 1
        pixels[..., 3] = np.uint8(np.rint(alpha * 255))
        error = abs(pixels[..., 3].astype(float) - np.asarray(official)[..., 3])
        edge = (ref[..., 3] > 0) & (ref[..., 3] < 1)
        values = error[edge] if edge.any() else error.ravel()
        return Image.fromarray(pixels), {'alpha_rmse_255': float(np.sqrt(np.mean(values ** 2))),
            'alpha_p99_255': float(np.percentile(values, 99)),
            'alpha_max_255': float(error.max()), 'outline_pixels': int(edge.sum())}
    distance = np.linalg.norm(c - k, axis=-1)
    definite = np.max(abs(c - k), axis=-1) <= p.key_background_tolerance / 255
    connected = frame_background(definite)
    radius = max(1, round(p.silhouette_band_native * density))
    band = np.asarray(Image.fromarray(np.uint8(connected) * 255).filter(
        ImageFilter.MaxFilter(2 * radius + 1))) > 0
    # Colour is never evidence for soft interior alpha. Only the frame-connected
    # background's narrow neighbourhood may have fractional coverage.
    interior = ~band & ~definite
    prior = pushpull(ref[..., :3], ref[..., 3] >= .5)
    key_chroma = k - k.mean()
    key_chroma /= max(float(np.linalg.norm(key_chroma)), 1e-6)
    # Opaque neutral ink can lie inside the outline band. Luminance alone must
    # not turn it into partial coverage; include returned colours without a
    # significant key-chroma excess as foreground seeds, even on thin contours.
    excess = ((c - prior) * key_chroma).sum(-1)
    high, low = k >= .5, k < .5
    dominance = np.min(c[..., high], axis=-1) - np.max(c[..., low], axis=-1)
    seeds = ~definite & (interior | (excess <= p.key_chroma_seed_tolerance / 255) |
                         (dominance <= p.key_chroma_seed_tolerance / 255))
    local = pushpull(c, seeds)
    inside, _ = nearest_inside(np.where(seeds[..., None], c, local), seeds, band & ~definite)
    alpha = np.ones(distance.shape, np.float32)
    alpha[band] = np.clip(distance[band] /
        np.maximum(np.linalg.norm(inside[band] - k, axis=-1), 1e-6), 0, 1)
    alpha[definite] = 0
    alpha[unchanged & band] = ref[..., 3][unchanged & band]
    alpha[band] = np.clip(alpha[band] / p.alpha_normalisation, 0, 1)
    alpha[alpha >= p.alpha_snap] = 1
    soft = (alpha > 0) & (alpha < 1)
    rgb = c.copy()
    rgb[soft & (alpha < .5)] = inside[soft & (alpha < .5)]
    rgb[alpha == 0] = 0
    # Identity observations keep hidden reference bytes. Changed images still
    # require edge cleanup even when individual opaque observations are equal.
    retain = unchanged & (abs(alpha - ref[..., 3]) < .5 / 255)
    rgb[retain] = ref[..., :3][retain]
    # Chroma cleanup covers every foreground/background boundary, including
    # enclosed key gaps. Alpha's soft band remains frame-connected as before.
    outside = Image.fromarray(np.uint8(alpha < .5) * 255)
    chroma_band = np.asarray(outside.filter(ImageFilter.MaxFilter(2 * radius + 1))) > 0
    rgb = despill_key_band(rgb, alpha, k, chroma_band,
                          tolerance=p.key_chroma_seed_tolerance / 255)
    colour_interior = ~chroma_band & ~definite
    pixels = np.uint8(np.rint(np.clip(np.dstack((rgb, alpha)), 0, 1) * 255))
    result = Image.fromarray(pixels)
    error = abs(pixels[..., 3].astype(float) - np.asarray(official)[..., 3])
    edge = (ref[..., 3] > 0) & (ref[..., 3] < 1)
    values = error[edge] if edge.any() else error.ravel()
    return result, {'alpha_rmse_255': float(np.sqrt(np.mean(values ** 2))),
                    'alpha_p99_255': float(np.percentile(values, 99)),
                    'alpha_max_255': float(error.max()), 'outline_pixels': int(edge.sum()),
                    'interior_pixels': int(interior.sum()), 'colour_interior_pixels': int(colour_interior.sum()),
                    'interior_soft_pixels': int((interior & (pixels[..., 3] < 255)).sum()),
                    'interior_colour_changed_pixels': int((colour_interior & np.any(pixels[..., :3] != np.asarray(image.convert('RGB')), axis=-1)).sum()),
                    'soft_outside_outline_band': int(((pixels[..., 3] > 0) & (pixels[..., 3] < 255) & ~band).sum())}


def _box_frame(box, frame, scale):
    l, t, r, b = box
    return [frame[0] + l / scale, frame[3] - b / scale,
            frame[0] + r / scale, frame[3] - t / scale]


def crop_boxes(size, head, parameters, image=None):
    """Fewest rectangular tiles fitting the budget at master density; no gaps."""
    w, h = size
    p = parameters
    choices = []
    for nx in range(1, math.ceil(w / max(1, math.sqrt(p.pixel_budget) - p.overlap)) + 2):
        for ny in range(1, math.ceil(h / max(1, math.sqrt(p.pixel_budget) - p.overlap)) + 2):
            tw = math.ceil((w + (nx - 1) * p.overlap) / nx)
            th = math.ceil((h + (ny - 1) * p.overlap) / ny)
            if tw * th <= p.pixel_budget and (nx == 1 or tw > p.overlap) and (ny == 1 or th > p.overlap):
                choices.append((nx * ny, abs(math.log(tw / th)), nx, ny, tw, th))
    if not choices:
        raise ValueError('Budget cannot accommodate the minimum overlap')
    _, _, nx, ny, tw, th = min(choices)
    boxes = [('head', head)]
    for y in range(ny):
        for x in range(nx):
            left = round(x * (w - tw) / max(nx - 1, 1))
            top = round(y * (h - th) / max(ny - 1, 1))
            boxes.append(('body', (left, top, min(left + tw, w), min(top + th, h))))
    if image is not None:
        # Move shared boundaries together, keeping overlap width and the budget.
        # Existing plans are immutable; only newly rendered plans use this choice.
        gradient = detail(np.asarray(image.convert('RGB')))
        alpha = np.asarray(image.convert('RGBA'))[..., 3] >= 128
        body = [list(box) for _, box in boxes[1:]]
        for axis in (0, 1):
            starts = sorted({box[axis] for box in body})[1:]
            for start in starts:
                ends = min(box[axis + 2] for box in body if box[axis + 2] > start)
                candidates = []
                for shift in range(-p.overlap // 2, p.overlap // 2 + 1):
                    trial = [box.copy() for box in body]
                    for box in trial:
                        if box[axis] == start: box[axis] += shift
                        if box[axis + 2] == ends: box[axis + 2] += shift
                    if any(not (0 <= b[0] < b[2] <= w and 0 <= b[1] < b[3] <= h) or
                           (b[2] - b[0]) * (b[3] - b[1]) > p.pixel_budget for b in trial): continue
                    sl = (slice(start + shift, ends + shift), slice(None)) if axis else (slice(None), slice(start + shift, ends + shift))
                    mask = alpha[sl]
                    score = float(gradient[sl][mask].mean()) if mask.any() else 0.
                    candidates.append((score, abs(shift), shift, trial))
                if candidates: body = min(candidates, key=lambda c: c[:3])[3]
        boxes = boxes[:1] + [('body', tuple(box)) for box in body]
    return boxes


def _validate(p, density):
    if type(density) is not int or density < 1:
        raise ValueError('Density/page scale must be a positive integer')
    for field in ('pixel_budget', 'overlap', 'feather', 'seam_blend', 'silhouette_band_native'):
        if type(getattr(p, field)) is not int or getattr(p, field) < 1:
            raise ValueError('Invalid budget or overlap')
    if p.overlap < 48 or p.pixel_budget <= p.overlap ** 2:
        raise ValueError('Overlap must be at least 48 output pixels and fit the budget')
    for value in asdict(p).values():
        if not math.isfinite(value) or value <= 0:
            raise ValueError('Parameters must be finite and positive')
    if max(p.alpha_snap, p.min_iou, p.gross_share, p.fringe_complement_share, p.contour_rate, p.unpaired_outline_rate, p.fringe_key_rate) > 1:
        raise ValueError('Invalid alpha or IoU threshold')


def plan_inputs(poses, pages, output, *, density=2, frame=None, masked_slots=(),
                parameters=None, template_id='detail-crisp-lines', template_version=1, source_hashes=None):
    """Write opaque crops and a self-contained, hashed plan to an external folder.

    Page replication matches K6. Each input is rendered directly on its recorded
    crop grid. Merge resamples edit residuals onto the master, so an identity edit
    adds neither an extra filtering pass nor a crop-grid seam to official pixels.
    """
    p = parameters or InputParameters()
    _validate(p, density)
    if not poses or len({pose.name for pose in poses}) != len(poses):
        raise ValueError('Unique poses, base first, are required')
    masked, swaps = _masks(poses, masked_slots)
    if not swaps:
        raise ValueError('No switching slots identified in supplied poses')
    if any(spec.get('pma', False) for pose in poses for spec in pose.geometry['pages']):
        raise ValueError('Straight-alpha pages are required')
    out = _external(output)
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'plan.json').exists():
        raise ValueError('Plan already exists')
    base_pages = {n: im.convert('RGBA').resize((im.width * density, im.height * density), Image.Resampling.NEAREST)
                  for n, im in pages.items()}
    clean = [subset(pose.geometry, lambda i, a: a['slot'] not in masked) for pose in poses]
    master = compose(clean[0], base_pages, density=density, frame=frame, inverse=False)
    frame, size = master.frame, master.image.size
    key, scores = choose_key(master.image)
    # Switching-slot geometry across every supplied pose, expanded for local hair context.
    vertices = [np.asarray(a['vertices']).reshape(-1, 2) for g in clean for a in g['attachments'] if a['slot'] in swaps]
    if not vertices:
        raise ValueError('Switching slots have no visible geometry')
    v = np.concatenate(vertices)
    scale = density * clean[0].get('textureDensity', 1.)
    xy = (v - (frame[0], frame[3])) * (scale, -scale)
    lo, hi = xy.min(0), xy.max(0)
    pad = max(hi - lo) * p.head_context
    head = tuple(map(int, (max(0, math.floor(lo[0] - pad)), max(0, math.floor(lo[1] - pad)),
                           min(size[0], math.ceil(hi[0] + pad)), min(size[1], math.ceil(hi[1] + pad)))))
    if (head[2] - head[0]) * (head[3] - head[1]) > p.pixel_budget:
        raise ValueError('Head context exceeds budget at master density; increase budget')
    plan = {'version': 1, 'density': density, 'page_scale': density, 'frame': list(frame), 'master_size': list(size),
            'parameters': asdict(p), 'key_colour': key, 'key_candidate_distances_255': scores,
            'masked_slots': sorted(masked), 'switching_slots': sorted(swaps), 'crops': [], 'poses': [], 'pages': {},
            'source_hashes': source_hashes or {}, 'prompt_template': {'id': template_id, 'version': template_version}}
    hashes = plan['artifact_hashes'] = {}

    def save_image(image, filename):
        image.save(out / filename)
        hashes[filename] = _hash((out / filename).read_bytes())
        return filename

    for i, (name, image) in enumerate(pages.items()):
        plan['pages'][name] = save_image(image, f'source-page-{i}.png')
        plan['source_hashes'][f'page:{name}'] = _hash(image.convert('RGBA').tobytes())
    boxes = crop_boxes(size, head, p, master.image)
    plan['boundary_strategy'] = 'minimum-visible-gradient-within-budget'
    plan['boundary_boxes_changed'] = boxes != crop_boxes(size, head, p)
    for i, (pose, geometry) in enumerate(zip(poses, clean)):
        geom_file = f'geometry-{i}.json'
        (out / geom_file).write_bytes(_json(pose.geometry))
        hashes[geom_file] = _hash((out / geom_file).read_bytes())
        plan['source_hashes'][f'geometry:{pose.name}'] = hashes[geom_file]
        official = master.image if i == 0 else compose(geometry, base_pages, density=density, frame=frame, inverse=False).image
        pose_info = {'name': pose.name, 'geometry': geom_file,
                     'official': save_image(official, f'official-pose-{i}.png')}
        plan['poses'].append(pose_info)
        for j, (role, box) in enumerate(boxes if i == 0 else boxes[:1]):
            w, h = box[2] - box[0], box[3] - box[1]
            factor = max(1., math.sqrt(p.pixel_budget / (w * h)))
            crop_density = density * factor
            world = _box_frame(box, frame, scale)
            expected = compose(geometry, base_pages, density=crop_density, frame=world, inverse=False).image
            ident = f'crop-{i}-{j}'
            rgba_file = save_image(expected, ident + '-official.png')
            input_file = save_image(flatten(expected, key), ident + '.png')
            tid = template_id if i == 0 else 'expression-crisp-lines'
            version = template_version if i == 0 else 1
            text = prompt(tid, version=version, crop_role=role, pose=pose.name, width=expected.width, height=expected.height,
                          preserve='all existing features and their exact coordinates',
                          key_colour=f'RGB({key[0]}, {key[1]}, {key[2]})',
                          style_edit='the existing line and shading treatment to match the reference')
            plan['crops'].append({'id': ident, 'role': role, 'pose': pose.name, 'box': list(box), 'world_frame': world,
                                  'density': crop_density, 'size': list(expected.size), 'pixels': expected.width * expected.height,
                                  'input': input_file, 'official': rgba_file,
                                  'prompt_template': {'id': tid, 'version': version}, 'prompt': text})
    overlay = flatten(master.image, key)
    draw = ImageDraw.Draw(overlay)
    for n, crop in enumerate(c for c in plan['crops'] if c['pose'] == poses[0].name):
        box = crop['box']
        draw.rectangle(box, outline=(255, 255, 0) if crop['role'] == 'head' else (0, 255, 255), width=3)
        draw.text((box[0] + 8, box[1] + 8), f"{n}: {crop['role']} {crop['density']:.4f}x {crop['size']}", fill='black', stroke_width=1, stroke_fill='white')
    overlay.save(out / 'crop-plan.png')
    (out / 'plan.json').write_text(json.dumps(plan, indent=2))
    return plan


def load_plan(path):
    path = Path(path).resolve()
    plan = json.loads(path.read_text())
    if plan['version'] != 1:
        raise ValueError('Unknown plan version')
    for name, expected in plan['artifact_hashes'].items():
        source = (path.parent / name).resolve()
        if source.parent != path.parent or _hash(source.read_bytes()) != expected:
            raise ValueError(f'Changed plan artifact: {name}')
    return plan


def _resize_float(values, size):
    if values.shape[:2] == size[::-1]:
        return values.copy()
    return np.stack([np.asarray(Image.fromarray(values[..., k]).resize(size, Image.Resampling.LANCZOS))
                     for k in range(values.shape[-1])], -1)


def _intersection(a, b):
    l, t, r, bottom = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if l >= r or t >= bottom:
        return None
    return (slice(t - a[1], bottom - a[1]), slice(l - a[0], r - a[0])), (slice(t - b[1], bottom - b[1]), slice(l - b[0], r - b[0]))


def merge_inputs(plan_path, returned, output, *, diagnostic=False, base_only=False):
    """Validate returns, colour-match overlaps, stitch residuals, key and gate.

    ``returned`` is a directory containing each crop id plus .png. Inputs are
    valid identity returns. Explicit diagnostic mode retains failed targets;
    the command never packs diagnostic failures.
    """
    path = Path(plan_path).resolve()
    plan = load_plan(path)
    if base_only:
        base = plan['poses'][0]['name']
        plan['poses'] = plan['poses'][:1]
        plan['crops'] = [c for c in plan['crops'] if c['pose'] == base]
    p = InputParameters(**plan['parameters'])
    _validate(p, plan['density'])
    out = _external(output)
    out.mkdir(parents=True, exist_ok=True)
    read = lambda name: Image.open(path.parent / name).convert('RGBA')
    report = {'failures': [], 'crops': {}, 'overlaps': [], 'key_method': 'connected-background-outline-only-despill',
              'merge_method': 'dynamic-programming-seams', 'parameters': asdict(p),
              'alpha_normalisation': p.alpha_normalisation, 'alpha_snap': p.alpha_snap}
    rows = []
    official_by_pose = {pose['name']: np.asarray(read(pose['official'])) for pose in plan['poses']}
    for crop in plan['crops']:
        filename = Path(returned) / (crop['id'] + '.png')
        with Image.open(filename) as loaded:
            if loaded.mode == 'RGBA' and loaded.getchannel('A').getextrema() != (255, 255):
                raise ValueError(f'Return must be opaque: {crop["id"]}')
            image = loaded.convert('RGB')
        w, h = image.size
        cw, ch = crop['size']
        if abs((w / h) / (cw / ch) - 1) > p.aspect_tolerance:
            raise ValueError(f'Returned aspect ratio changed: {crop["id"]}')
        if abs(w * h / p.pixel_budget - 1) > p.budget_tolerance:
            raise ValueError(f'Return is outside the pixel budget: {crop["id"]}')
        # Compare observations on the returned grid before either is filtered
        # again. Comparing a twice-filtered return with an unfiltered reference
        # would manufacture an edit, especially at the head/body density change.
        expected_grid = read(crop['input']).convert('RGB').resize((w, h), Image.Resampling.LANCZOS)
        delta = np.asarray(image, np.float32) - np.asarray(expected_grid, np.float32)
        image = Image.fromarray(np.uint8(np.rint(np.clip(
            np.asarray(read(crop['input']).convert('RGB'), np.float32) + _resize_float(delta, (cw, ch)), 0, 255))))
        official = read(crop['official'])
        keyed, matte_quality = key_image(image, official, plan['key_colour'], parameters=p, density=crop['density'])
        _, quality = key_image(flatten(official, plan['key_colour']), official, plan['key_colour'], parameters=p)
        movement = native_movement(official, keyed, density=crop['density'], min_iou=p.min_iou,
                                   max_offset=p.native_line_offset, max_shift=p.native_translation)
        report['crops'][crop['id']] = {'movement': movement, 'identity_key_quality': quality,
                                      'returned_size': [w, h], 'sha256': _hash(filename.read_bytes()), 'matte_quality': matte_quality}
        if movement['flags']: report['failures'].append(crop['id'] + ':movement')
        if quality['alpha_rmse_255'] > p.key_alpha_rmse or quality['alpha_p99_255'] > p.key_alpha_p99:
            report['failures'].append(crop['id'] + ':key')
        l, t, r, b = crop['box']
        rows.append({'crop': crop, 'delta': _resize_float(delta, (r - l, b - t))})
    # Estimate only rigid whole-crop corrections from overlap observations.
    # The original official-geometry gate above remains independent: correcting
    # overlap sampling must not rehabilitate a drifted or locally moved return.
    equations, shifts = [], []
    registrations = []
    for i, a in enumerate(rows):
        for j in range(i + 1, len(rows)):
            b = rows[j]
            if a['crop']['pose'] != b['crop']['pose']: continue
            overlap = _intersection(a['crop']['box'], b['crop']['box'])
            if overlap is None: continue
            sa, sb = overlap
            abox, bbox = a['crop']['box'], b['crop']['box']
            l, t = max(abox[0], bbox[0]), max(abox[1], bbox[1])
            r, bottom = min(abox[2], bbox[2]), min(abox[3], bbox[3])
            official_overlap = Image.fromarray(official_by_pose[a['crop']['pose']][t:bottom, l:r])
            base = np.asarray(flatten(official_overlap, plan['key_colour']), np.float32)
            visible = np.asarray(official_overlap)[..., 3] > 250
            estimate = estimate_translation(base + a['delta'][sa], base + b['delta'][sb], visible,
                                            density=plan['density'])
            eq = np.zeros(len(rows)); eq[i], eq[j] = -1, 1
            equations.append(eq); shifts.append(estimate['shift_native'])
            registrations.append({'a': a['crop']['id'], 'b': b['crop']['id'], **estimate})
    for pose in plan['poses']:
        anchor = next(i for i, row in enumerate(rows) if row['crop']['pose'] == pose['name'])
        eq = np.zeros(len(rows)); eq[anchor] = 1
        equations.append(eq); shifts.append([0., 0.])
    correction = np.linalg.lstsq(np.asarray(equations), np.asarray(shifts), rcond=None)[0]
    report['registration'] = registrations
    for i, row in enumerate(rows):
        shift = correction[i]
        if np.linalg.norm(shift) > p.translation_cap_native:
            report['failures'].append(row['crop']['id'] + ':translation-cap')
            shift = np.zeros(2)
        l, t, r, b = row['crop']['box']
        official = Image.fromarray(official_by_pose[row['crop']['pose']][t:b, l:r])
        base = np.asarray(flatten(official, plan['key_colour']), np.float32)
        row['delta'] = translate_rgb(base + row['delta'], shift * plan['density'], plan['key_colour']) - base
        report['crops'][row['crop']['id']]['applied_shift_native_px'] = shift.tolist()
        report['crops'][row['crop']['id']]['estimated_shift_native_px'] = correction[i].tolist()
    # Solve a DC colour offset graph, anchored on the head; expressions are separate poses.
    offsets = np.zeros((len(rows), 3), np.float64)
    equations, differences = [], []
    edges = []
    for i, a in enumerate(rows):
        for j in range(i + 1, len(rows)):
            b = rows[j]
            if a['crop']['pose'] != b['crop']['pose']: continue
            overlap = _intersection(a['crop']['box'], b['crop']['box'])
            if overlap is None: continue
            sa, sb = overlap
            d = a['delta'][sa] - b['delta'][sb]
            abox, bbox = a['crop']['box'], b['crop']['box']
            l, t = max(abox[0], bbox[0]), max(abox[1], bbox[1])
            r, bottom = min(abox[2], bbox[2]), min(abox[3], bbox[3])
            visible = official_by_pose[a['crop']['pose']][t:bottom, l:r, 3] > 250
            if not visible.any(): continue
            # Median rejects line differences while matching the low-frequency tone.
            offset = np.median(d[visible], axis=0)
            eq = np.zeros(len(rows)); eq[i], eq[j] = 1, -1
            equations.append(eq); differences.append(-offset)
            edges.append((i, j, sa, sb, visible))
    for pose in plan['poses']:
        anchor = next(i for i, row in enumerate(rows) if row['crop']['pose'] == pose['name'])
        eq = np.zeros(len(rows)); eq[anchor] = 1
        equations.append(eq); differences.append(np.zeros(3))
    if equations:
        offsets = np.linalg.lstsq(np.array(equations), np.array(differences), rcond=None)[0]
    for i, row in enumerate(rows):
        l, t, r, b = row['crop']['box']
        alpha = official_by_pose[row['crop']['pose']][t:b, l:r, 3].astype(np.float32) / 255
        row['delta'] += offsets[i].astype(np.float32) * alpha[..., None]
        report['crops'][row['crop']['id']]['colour_offset_255'] = offsets[i].tolist()
    for i, j, sa, sb, visible in edges:
        rmse = float(np.sqrt(np.mean((rows[i]['delta'][sa] - rows[j]['delta'][sb])[visible] ** 2)))
        report['overlaps'].append({'a': rows[i]['crop']['id'], 'b': rows[j]['crop']['id'], 'rmse_255': rmse})
        gross = gross_disagreement(rows[i]['delta'][sa], rows[j]['delta'][sb], visible,
                                   block=max(1, round(8 * plan['density'])),
                                   limit=p.gross_block_contrast, max_share=p.gross_share)
        report['overlaps'][-1]['raw_disagreement'] = gross
        if not gross['passed']: report['failures'].append(f'overlap:{i}:{j}:gross')
        abox, bbox = rows[i]['crop']['box'], rows[j]['crop']['box']
        l, t = max(abox[0], bbox[0]), max(abox[1], bbox[1])
        r, b = min(abox[2], bbox[2]), min(abox[3], bbox[3])
        ref = Image.fromarray(official_by_pose[rows[i]['crop']['pose']][t:b, l:r])
        base = np.asarray(flatten(ref, plan['key_colour']), np.float32)
        observations = [Image.fromarray(np.uint8(np.rint(np.clip(np.dstack((base + d, np.asarray(ref)[..., 3])), 0, 255))))
                        for d in (rows[i]['delta'][sa], rows[j]['delta'][sb])]
        overlap_motion = native_movement(*observations, density=plan['density'], min_iou=p.min_iou,
                                        max_offset=p.native_line_offset, max_shift=p.native_translation)
        residual = estimate_translation(base + rows[i]['delta'][sa], base + rows[j]['delta'][sb],
                                        visible, density=plan['density'])
        overlap_motion['integer_translation_diagnostic_px'] = overlap_motion['translation_px']
        overlap_motion['translation_px'] = float(np.linalg.norm(residual['shift_native']))
        overlap_motion['residual_shift_native_px'] = residual['shift_native']
        overlap_motion['flags'] = [f for f in overlap_motion['flags'] if f != 'coherent_drift']
        if overlap_motion['translation_px'] > p.native_translation:
            overlap_motion['flags'].append('coherent_drift')
        source_faults = [row['crop']['id'] for row in (rows[i], rows[j])
                         if report['crops'][row['crop']['id']]['movement']['flags']]
        overlap_motion['unaligned_source_geometry_faults'] = source_faults
        if source_faults: overlap_motion['flags'].append('source_geometry')
        report['overlaps'][-1]['movement'] = overlap_motion
        if overlap_motion['flags']: report['failures'].append(f'overlap:{i}:{j}:movement')
    size = tuple(plan['master_size'])
    targets = {}
    base_pose = plan['poses'][0]['name']
    for pose in plan['poses']:
        selected = [r for r in rows if r['crop']['pose'] == pose['name']]
        delta = np.zeros(size[::-1] + (3,), np.float32)
        covered = np.zeros(size[::-1], bool)
        boundary = np.zeros(size[::-1], bool)
        paths = []
        doubles = 0
        mixed_detail = 0
        contour_crops = []
        # Row-order bodies first, then the head's four perimeter seams.
        selected.sort(key=lambda row: (row['crop']['role'] == 'head', row['crop']['box'][1], row['crop']['box'][0]))
        opaque = np.asarray(flatten(read(pose['official']), plan['key_colour']), np.float32)
        for row in selected:
            crop = row['crop']; l, t, r, b = crop['box']
            base = opaque[t:b, l:r]
            merged_crop, band, cuts, ownership = stitch(base + delta[t:b, l:r], base + row['delta'],
                covered[t:b, l:r], head=crop['role'] == 'head', feather=p.feather,
                blend=p.seam_blend, agreement=p.seam_agreement)
            added_pairs = double_edge_count(base + delta[t:b, l:r], base + row['delta'], merged_crop, band)
            doubles += added_pairs
            contour_crops.append({'crop': crop['id'], 'new_ridge_pairs': added_pairs})
            mixed = (ownership > 0) & (ownership < 1)
            disagreement = np.sqrt(np.mean((delta[t:b, l:r] - row['delta']) ** 2, axis=-1))
            mixed_detail += int((mixed & (disagreement > p.seam_agreement)).sum())
            delta[t:b, l:r] = merged_crop - base
            boundary[t:b, l:r] |= band
            covered[t:b, l:r] = True
            for seam_path in cuts:
                seam_path['crop'] = crop['id']
                seam_path['points'] = [[x + l, y + t] for x, y in seam_path['points']]
                paths.append(seam_path)
        if pose['name'] == base_pose and not covered.all():
            raise ValueError('Crop plan leaves uncovered master pixels')
        report.setdefault('seams', {})[pose['name']] = paths
        seam_length = sum(float(np.linalg.norm(np.diff(np.asarray(path['points']), axis=0), axis=1).sum())
                          for path in paths)
        contour_rate = doubles / max(seam_length, 1.)
        report.setdefault('double_edges', {})[pose['name']] = {
            'new_ridge_pairs': doubles, 'by_crop': contour_crops, 'mixed_disagreeing_pixels': mixed_detail,
            'seam_length_px': seam_length, 'seam_length_native_px': seam_length / plan['density'],
            'pairs_per_seam_px': contour_rate,
            'max_pairs_per_seam_px': p.contour_rate,
            'passed': contour_rate <= p.contour_rate and mixed_detail == 0}
        if contour_rate > p.contour_rate or mixed_detail: report['failures'].append(pose['name'] + ':double-edge')
        official = read(pose['official'])
        opaque = np.asarray(flatten(official, plan['key_colour']), np.float32)
        merged = Image.fromarray(np.uint8(np.rint(np.clip(opaque + delta, 0, 255))))
        target, quality = key_image(merged, official, plan['key_colour'], parameters=p, density=plan['density'])
        report.setdefault('matte_quality', {})[pose['name']] = quality
        target.save(out / f'target-{len(targets)}.png')
        merged.save(out / f'merged-{len(targets)}.png')
        seam = join_band_gate(target, official, {'crop_boundary': boundary},
                              np.asarray(official)[..., 3] > 250, max_ratio=p.boundary_ratio)
        report.setdefault('crop_boundaries', {})[pose['name']] = seam['crop_boundary']
        Image.fromarray(np.uint8(boundary) * 255).save(out / f'seam-band-{len(targets)}.png')
        overlay = merged.copy(); draw = ImageDraw.Draw(overlay)
        for seam_path in paths: draw.line([tuple(pt) for pt in seam_path['points']], fill=(0, 255, 255), width=1)
        overlay.save(out / f'seam-paths-{len(targets)}.png')
        fringe = fringe_gate(target, plan['key_colour'], reference=official, max_distance=p.fringe_distance,
                             max_complement_share=p.fringe_complement_share, density=plan['density'],
                             max_unpaired_rate=p.unpaired_outline_rate, max_key_rate=p.fringe_key_rate,
                             band_native=p.silhouette_band_native)
        report.setdefault('fringe', {})[pose['name']] = fringe
        if not fringe['passed']: report['failures'].append(pose['name'] + ':fringe')
        if not seam['crop_boundary']['passed']: report['failures'].append(pose['name'] + ':crop-boundary')
        box = None if pose['name'] == base_pose else selected[0]['crop']['box']
        targets[pose['name']] = (target if box is None else target.crop(box), box)
    report['passed'] = not report['failures']
    (out / 'merge-report.json').write_text(json.dumps(report, indent=2))
    if not report['passed'] and not diagnostic: raise InputGateError(report)
    return targets, report


def expression_inputs(plan_path, base_target, output):
    """Put official expression features into the generated base head's fixed context.

    The editable feature window is the union of all switching-slot alpha, padded
    by a named radius. Outside it the supplied base head is fixed, including its
    keyed outline. The expression itself is always the animated official pose.
    A new plan records the context hash; the original plan remains reviewable.
    """
    from .refine_cut import dilate
    path = Path(plan_path).resolve()
    plan = load_plan(path)
    out = _external(output)
    if out == path.parent or (out / 'plan.json').exists():
        raise ValueError('Expression context requires a new output folder')
    out.mkdir(parents=True, exist_ok=True)
    p = InputParameters(**plan['parameters'])
    base = Image.open(base_target).convert('RGBA')
    if base.size != tuple(plan['master_size']):
        raise ValueError('Base context must use the master grid')
    original = Image.open(path.parent / plan['poses'][0]['official']).convert('RGBA')
    check = native_movement(original, base, density=plan['density'], min_iou=p.min_iou,
                            max_offset=p.native_line_offset, max_shift=p.native_translation)
    if check['flags']:
        raise InputGateError({'failures': ['base-context:movement'], 'movement': check})
    for filename in plan['artifact_hashes']:
        shutil.copyfile(path.parent / filename, out / filename)
    plan['base_context_sha256'] = _hash(Path(base_target).read_bytes())
    base.save(out / 'base-context.png')
    plan['artifact_hashes']['base-context.png'] = _hash((out / 'base-context.png').read_bytes())
    pages = {n: Image.open(out / f).convert('RGBA') for n, f in plan['pages'].items()}
    pages = {n: im.resize((im.width * plan['density'], im.height * plan['density']), Image.Resampling.NEAREST)
             for n, im in pages.items()}
    swaps = set(plan['switching_slots'])
    base_geometry = json.loads((out / plan['poses'][0]['geometry']).read_text())
    base_delta = _rgba(base) - _rgba(original)
    for pose in plan['poses'][1:]:
        geometry = json.loads((out / pose['geometry']).read_text())
        crop = next(c for c in plan['crops'] if c['pose'] == pose['name'])
        l, t, r, b = crop['box']
        masks = []
        for g in (base_geometry, geometry):
            selected = subset(g, lambda i, a: a['slot'] in swaps)
            if selected['attachments']:
                image = compose(selected, pages, density=crop['density'], frame=crop['world_frame'], inverse=False).image
                masks.append(np.asarray(image)[..., 3] > 2)
        mask = np.logical_or.reduce(masks)
        radius = math.ceil(p.expression_context_radius * crop['density'] / plan['density'])
        window = Image.fromarray(np.uint8(dilate(mask, radius)) * 255)
        official = Image.open(out / crop['official']).convert('RGBA')
        delta = _resize_float(base_delta[t:b, l:r], official.size)
        context = Image.fromarray(np.uint8(np.rint(np.clip(_rgba(official) + delta, 0, 1) * 255)))
        expression = Image.composite(official, context, window)
        expression.save(out / crop['official'])
        flatten(expression, plan['key_colour']).save(out / crop['input'])
        # Reference calibration now includes the fixed generated context.
        reference = Image.open(out / pose['official']).convert('RGBA')
        pixels = _rgba(reference)
        weight = 1 - np.asarray(window.resize((r - l, b - t), Image.Resampling.BILINEAR), np.float32) / 255
        pixels[t:b, l:r] += base_delta[t:b, l:r] * weight[..., None]
        reference = Image.fromarray(np.uint8(np.rint(np.clip(pixels, 0, 1) * 255)))
        reference.save(out / pose['official'])
        for filename in (crop['official'], crop['input'], pose['official']):
            plan['artifact_hashes'][filename] = _hash((out / filename).read_bytes())
        clean_base = subset(base_geometry, lambda i, a: a['slot'] not in set(plan['masked_slots']))
        head = compose(clean_base, pages, density=crop['density'], frame=crop['world_frame'], inverse=False).image
        head = Image.fromarray(np.uint8(np.rint(np.clip(_rgba(head) + delta, 0, 1) * 255)))
        filename = crop['id'] + '-base-context.png'
        flatten(head, plan['key_colour']).save(out / filename)
        plan['artifact_hashes'][filename] = _hash((out / filename).read_bytes())
        crop['fixed_context'] = filename
    (out / 'plan.json').write_text(json.dumps(plan, indent=2))
    return plan


def finish(plan_path, returned, output, *, diagnostic=False, atlas=None, pack=None):
    """Merge, key, cut, gate, optionally pack through the existing assembly engine."""
    path = Path(plan_path).resolve()
    plan = load_plan(path)
    out = _external(output)
    targets, merge_report = merge_inputs(path, returned, out, diagnostic=diagnostic)
    pages = {name: Image.open(path.parent / filename).convert('RGBA') for name, filename in plan['pages'].items()}
    poses = []
    baseline = {n: im.resize((im.width * plan['density'], im.height * plan['density']), Image.Resampling.NEAREST) for n, im in pages.items()}
    for item in plan['poses']:
        geometry = json.loads((path.parent / item['geometry']).read_text())
        target, box = targets[item['name']]
        # Masked slots never enter model inputs. Restore their official composite
        # pixels for K6's full-composite identity and display convention.
        full = compose(geometry, baseline, density=plan['density'], frame=plan['frame'], inverse=False)
        clean = Image.open(path.parent / item['official']).convert('RGBA')
        mask = np.any(np.asarray(full.image) != np.asarray(clean), -1)
        a = np.array(target)
        if box is not None:
            l, t, r, b = box; mask = mask[t:b, l:r]
            ref = np.asarray(full.image)[t:b, l:r]
        else: ref = np.asarray(full.image)
        a[mask] = ref[mask]
        poses.append(Pose(item['name'], geometry, Image.fromarray(a), tuple(box) if box else None))
    try:
        result = cut(poses, pages, density=plan['density'], frame=plan['frame'], atlas=atlas,
                     masked_slots=plan['masked_slots'], diagnostic=diagnostic, review_dir=out / 'cut-review')
    except GateError as exc:
        (out / 'report.json').write_text(json.dumps({'merge': merge_report, 'cut': exc.report, 'packed': []}, indent=2))
        raise
    for i, (name, image) in enumerate(result.pages.items()):
        image.save(out / f'page-{i}.png')
        result.edited_meshes[name].save(out / f'page-{i}-meshes.png')
    report = {'merge': merge_report, 'cut': result.report, 'packed': []}
    if pack and merge_report['passed'] and result.report['passed']:
        from .refine_assembly import Assembly, assemble_mod
        for filename, expected in pack.get('hashes', {}).items():
            if _hash(Path(filename).read_bytes()) != expected:
                raise ValueError('Changed packing source')
        current_sources = [Path(p) for p in pack['bundles']]
        touched_bundles = set()
        for i, (name, image) in enumerate(result.pages.items()):
            assembly = Assembly(image, {})
            packed = assemble_mod(current_sources, image, out / f'pack-stage-{i}',
                atlas_name=pack['atlas_name'], page_name=name, scale=plan['page_scale'], projected=assembly,
                allow_generated_alpha=True, edited_mesh_mask=result.edited_meshes[name])
            report['packed'].append(packed)
            filename = packed['bundle']
            touched_bundles.add(filename)
            current_sources = [out / f'pack-stage-{i}' / filename if source.name == filename else source
                               for source in current_sources]
        packed_dir = out / 'packed'
        packed_dir.mkdir()
        for source in current_sources:
            if source.name in touched_bundles: shutil.copyfile(source, packed_dir / source.name)
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    return result, report


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('plan', 'merge-base', 'expressions', 'finish'))
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--returns', type=Path)
    parser.add_argument('--diagnostic', action='store_true')
    parser.add_argument('--base-target', type=Path)
    args = parser.parse_args(argv)
    manifest = args.manifest.resolve()
    spec = json.loads(manifest.read_text())
    resolve = lambda name: manifest.parent / name
    if args.stage == 'plan':
        pages = {n: Image.open(resolve(p)).convert('RGBA') for n, p in spec['pages'].items()}
        poses = [Pose(p['name'], json.loads(resolve(p['geometry']).read_text())) for p in spec['poses']]
        result = plan_inputs(poses, pages, args.output, density=spec.get('density', 2), frame=spec.get('frame'),
                             masked_slots=spec.get('masked_slots', ()), parameters=InputParameters(**spec.get('input_parameters', {})),
                             template_id=spec.get('prompt_template', 'detail-crisp-lines'),
                             template_version=spec.get('prompt_version', 1),
                             source_hashes={'manifest': _hash(manifest.read_bytes())})
        # Packing sources are explicit, never inferred from a portrait name.
        if spec.get('pack'):
            result['pack'] = {**spec['pack'], 'bundles': [str(resolve(p).resolve()) for p in spec['pack']['bundles']]}
            result['pack']['hashes'] = {p: _hash(Path(p).read_bytes()) for p in result['pack']['bundles']}
        if spec.get('atlas'):
            result['atlas'] = str(resolve(spec['atlas']).resolve())
            result['source_hashes']['atlas'] = _hash(resolve(spec['atlas']).read_bytes())
        (args.output / 'plan.json').write_text(json.dumps(result, indent=2))
        print(json.dumps({'crops': len(result['crops']), 'key_colour': result['key_colour']}))
    elif args.stage == 'expressions':
        if args.base_target is None: parser.error('--base-target is required for expressions')
        result = expression_inputs(manifest, args.base_target, args.output)
        print(json.dumps({'expression_crops': len(result['poses']) - 1}))
    elif args.stage == 'merge-base':
        if args.returns is None: parser.error('--returns is required for merge-base')
        _, report = merge_inputs(manifest, args.returns, args.output, diagnostic=args.diagnostic, base_only=True)
        print(json.dumps({'passed': report['passed']}))
    else:
        if args.returns is None: parser.error('--returns is required for finish')
        atlas = None
        if spec.get('atlas'):
            from .atlas_remap import parse_atlas
            raw = Path(spec['atlas']).read_bytes()
            if _hash(raw) != spec['source_hashes']['atlas']: raise ValueError('Changed atlas source')
            atlas = parse_atlas(raw)
        _, report = finish(manifest, args.returns, args.output, diagnostic=args.diagnostic, atlas=atlas, pack=spec.get('pack'))
        print(json.dumps({'passed': report['merge']['passed'] and report['cut']['passed']}))


if __name__ == '__main__':
    main()
