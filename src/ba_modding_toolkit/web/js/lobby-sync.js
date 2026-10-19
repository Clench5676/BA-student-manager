// Clips the memorial lobby plays at random times and the sounds its clips carry, as the game's SpineBase does
// (GameAssembly.dll: PlaySpineClip, CoPlayMaskedRandomTiming, ResetRandomizedDelayWithDuration, AddRandomCountLoop,
// QueueTrackClose, EnqueueSoundKeys, CoPlaySoundKeys). lobby.js starts them with a skeleton's idle and feeds them
// its frames; nothing here touches the page.
// - A clip of PlayMode 2 (masked at random times: snow, clouds, petals, stars, Shigure's train) waits, plays once on
//   its own track, plus the extra plays its loops add, and, when it loops, waits again from that start for its
//   playing time plus a random min to max. The first wait depends on its RandomTimingIntroDelayMode: none, min to
//   max, or its preDelay plus min to max. It starts at full weight on an empty track and mixes in from its own last
//   frame after that; between plays the track holds that last frame.
// - A clip's sound keys play their events when the track entry's animation time reaches them, each once (every loop
//   on a looping entry), and no more once the entry is interrupted, ends or completes.

// UnityEngine.Random.Range: a float in [min, max], an int in [min, max) (min when the range is empty)
export const range = (min, max, rnd = Math.random) => min + (max - min) * rnd();
export const rangeInt = (min, max, rnd = Math.random) => (max > min ? min + Math.floor(rnd() * (max - min)) : min);

// the wait before a random-timing clip first plays (SpineClip.RandomTimingIntroDelayMode: 0 Immediate, 1 Random,
// 2 DelayedRandom)
export function firstWait(r, rnd = Math.random) {
  if (!r || !r.pre) return 0;
  return (r.pre === 2 ? r.preDelay || 0 : 0) + range(r.min || 0, r.max || 0, rnd);
}
// the plays queued after the first one (AddRandomCountLoop: Random.Range(min, max + 1) when max is above 0)
export function extraPlays(r, rnd = Math.random) {
  const [lo, hi] = r?.loops || [0, 0];
  return hi > 0 ? Math.max(0, rangeInt(lo, hi + 1, rnd)) : 0;
}

// handlers on a track entry's events, added to any it has (spine-ts calls entry.listener; entries are pooled, so a
// handler must let go of the entry on dispose)
export function listen(entry, handlers) {
  const old = entry.listener || {};
  const merged = { ...old };
  for (const [kind, fn] of Object.entries(handlers)) {
    const prev = old[kind];
    merged[kind] = prev ? (e, ...rest) => { prev(e, ...rest); fn(e, ...rest); } : fn;
  }
  entry.listener = merged;
  return entry;
}

// The random-timing clips of one skeleton. state: its spine AnimationState; clip(name): the clip (lobby.json clips);
// duration(name): its animation's duration; onEntry(entry, clip, name): each track entry a play sets (its sound
// keys); random: [0, 1). The clock is the skeleton's own animation time, advanced by tick.
export class Runs {
  constructor(state, { clip, duration, onEntry = () => {}, random = Math.random } = {}) {
    Object.assign(this, { state, clip, duration, onEntry, random });
    this.time = 0;
    this.runs = new Map(); // clip name -> {name, from, wait, plays}
  }

  // (re)start a clip's run (PlaySpineClip on a MaskedRandomTiming clip stops the one it had): its first wait, and
  // at once when that is 0
  start(name) {
    const c = this.clip(name);
    if (!c || !(this.duration(name) > 0)) return null;
    const run = { name, track: c.track, from: this.time, wait: firstWait(c.random, this.random), plays: 0 };
    this.runs.set(name, run);
    if (run.wait <= 0) this.fire(run);
    return run;
  }

  stop(name) { this.runs.delete(name); }
  stopAll() { this.runs.clear(); }

  // a dialogue starts or ends (SpineCharacter.PlayTalkAnimation and ChatDialog.ReturnToIdleSpines return to the
  // idle keeping its sync clips): a clip that has not played yet, its track still empty, starts again
  returnToIdle(names) {
    for (const name of names) {
      const c = this.clip(name), run = this.runs.get(name);
      if (c?.mode === 2 && (!run || !this.state.tracks[c.track])) this.start(name);
    }
  }

  // every frame, before the animation update: the clock, and the runs that are due
  tick(dt) {
    this.time += Math.max(0, dt || 0);
    for (const run of [...this.runs.values()]) if (this.runs.get(run.name) === run && this.time - run.from >= run.wait) this.fire(run);
  }

  fire(run) {
    const c = this.clip(run.name), d = this.duration(run.name), st = this.state;
    if (!c || !(d > 0)) { this.runs.delete(run.name); return; }
    const entry = st.setAnimation(c.track, run.name, false);
    entry.mixDuration = c.intro || 0;
    this.onEntry(entry, c, run.name);
    const extra = extraPlays(c.random, this.random);
    // each extra play starts one duration after the one before, mixing in by the skeleton's default
    for (let i = 0; i < extra; i++) this.onEntry(st.addAnimation(c.track, run.name, false, d), c, run.name);
    run.plays += 1 + extra;
    if (c.loop) {
      run.from = this.time;
      run.wait = (1 + extra) * d + range(c.random?.min || 0, c.random?.max || 0, this.random);
      return;
    }
    this.runs.delete(run.name);
    // the track fades out after it (QueueTrackClose), at the clip's end or when its outro starts
    if (c.finish === 2) st.addEmptyAnimation(c.track, c.outro || 0, c.outroAt == null ? 0 : d + c.outroAt);
  }

  // for checks: each run's clip, track, seconds until it plays, plays so far
  list() {
    return [...this.runs.values()].map((r) => ({ clip: r.name, track: r.track, in: +(r.from + r.wait - this.time).toFixed(3),
      plays: r.plays }));
  }
}

// The sound keys of the track entries of one skeleton. play(event id) plays one.
export class SoundKeys {
  constructor(play) {
    this.play = play;
    this.watches = new Map(); // track entry -> {keys, k, started, wrap, last}
  }

  // keys: [[time, event id]] in the clip's order (an entry is watched once)
  watch(entry, keys) {
    if (!entry || !keys?.length || this.watches.has(entry)) return;
    if (entry.loop && !(entry.animationEnd > 0)) return;
    this.watches.set(entry, { keys, k: 0, started: false, wrap: false, last: 0 });
    const drop = () => this.watches.delete(entry);
    listen(entry, { interrupt: drop, end: drop, dispose: drop, complete: (e) => { if (!e.loop) drop(); } });
  }

  // after the animation update: the keys the entries' animation time has reached
  tick() {
    for (const [entry, w] of this.watches) {
      const t = entry.getAnimationTime();
      if (!w.started) {
        if (!(t > 0)) continue;
        w.started = true;
      }
      if (w.wrap) {
        if (t >= w.last) continue; // a looping entry: the next loop
        w.wrap = false;
        w.k = 0;
      }
      while (w.k < w.keys.length && w.keys[w.k][0] <= t) {
        this.play(w.keys[w.k][1]);
        w.k += 1;
      }
      if (w.k >= w.keys.length) {
        if (entry.loop) { w.wrap = true; w.last = t; } else this.watches.delete(entry);
      }
    }
  }

  clear() { this.watches.clear(); }
}
