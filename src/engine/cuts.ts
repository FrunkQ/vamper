// Cut points and crossfades: the sample-level part of the engine. Pure TypeScript, no DOM, so the
// browser deck (deck.ts) and the Node join test (tools/join-test.mjs) run exactly the same code.
//
// The model: playback is a chain of segments of the source, each a sample range [s, e). Each
// segment after the first starts XFADE samples before its join, and the one before it ends at its
// own join, so neighbours overlap by XFADE samples and crossfade there. A join sits a few ms
// before the refined attack of a beat (PRE by default; fit() picks the best spot), in the quiet
// just before the hit, so the hit itself plays whole on the new side and masks the join (see
// docs/ENGINE.md).

export const XFADE_SEC = 0.02;
export const PRE_SEC = 0.008;
/** How far either side of a grid beat to look for its real attack. */
export const SEARCH_SEC = 0.015;

export interface Segment {
  /** First and one-past-last source sample. */
  s: number;
  e: number;
  /** How alike the two sides of the crossfade into this segment are (correlation, -1..1); shapes the fade. 1 for the first segment. */
  r: number;
  /** The grid times (beats) the segment starts and ends on, when it does; fit() refines cuts around them. */
  from?: number;
  to?: number;
}

/** What a join is likely to sound like: lower is better. */
export interface JoinScore {
  /** Loudness step (dB) between what would have followed and what follows instead, over 80 ms. Large for a loop's wrap means a likely audible join; large for a change of section is just the music changing. */
  db: number;
  /** Correlation of the two sides across the crossfade (1 = identical audio). */
  r: number;
  /** True when the join is likely to be heard. */
  warn: boolean;
}

/**
 * Crossfade gains at position x (0..1) through the fade, for two sides with correlation r:
 * equal power for unrelated audio (r = 0), equal gain for identical audio (r = 1), and boosted for
 * audio that partly cancels (r < 0, down to -0.5), so the mix keeps its level either way.
 */
export function fadeGains(x: number, r: number): { out: number; in: number } {
  const a = Math.cos((Math.PI / 2) * x), b = Math.sin((Math.PI / 2) * x);
  const k = 1 / Math.sqrt(a * a + b * b + 2 * Math.max(-0.5, Math.min(1, r)) * a * b);
  return { out: a * k, in: b * k };
}

/** The fade as a gain curve of n points, for Web Audio's setValueCurveAtTime. */
export function fadeCurve(n: number, dir: 'in' | 'out', r: number): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fadeGains(i / (n - 1), r)[dir];
  return c;
}

export class Cutter {
  readonly xfade: number;
  readonly pre: number;
  private joins = new Map<number, number>();

  /** `mono` is the full-rate mono mix of the song. */
  constructor(readonly mono: Float32Array, readonly sr: number) {
    this.xfade = Math.round(XFADE_SEC * sr);
    this.pre = Math.round(PRE_SEC * sr);
  }

  /**
   * The attack nearest grid time t (seconds), as a sample: the biggest rise in 2 ms energy over the
   * 5 ms before it, within SEARCH_SEC. Falls back to t itself when nothing rises by 6 dB (a pad, a
   * soft entry), since a weak rise is as likely to be a wobble as the beat.
   */
  attack(t: number): number { return this.findAttack(t) ?? Math.round(t * this.sr); }

  /** The attack near grid time t, as a sample, or null when nothing rises clearly. */
  findAttack(t: number): number | null {
    const x = this.mono, sr = this.sr;
    const w = Math.max(1, Math.round(0.002 * sr)), hop = Math.max(1, Math.round(0.0005 * sr)), back = Math.round(0.005 * sr);
    const c = Math.round(t * sr), lo = Math.max(back, c - Math.round(SEARCH_SEC * sr)), hi = Math.min(x.length - w, c + Math.round(SEARCH_SEC * sr));
    const energy = (a: number, n: number) => { let s = 0; for (let i = a; i < a + n; i++) s += x[i] * x[i]; return s / n + 1e-10; };
    const riseAt = (i: number) => energy(i, w) / energy(i - back, back);
    let best = -1, bestRise = 4;
    for (let i = lo; i <= hi; i += hop) { const r = riseAt(i); if (r > bestRise) { bestRise = r; best = i; } }
    if (best < 0) return null;
    // A soft attack rises over several ms and peaks late: walk back to where it starts (half the rise, in dB).
    while (best - hop >= lo && riseAt(best - hop) > Math.sqrt(bestRise)) best -= hop;
    return best;
  }

  /** The default join sample for a cut at the beat near grid time t: PRE before its attack. */
  join(t: number): number {
    const key = Math.round(t * 1000);
    let j = this.joins.get(key);
    if (j === undefined) this.joins.set(key, j = Math.max(this.xfade, this.attack(t) - this.pre));
    return j;
  }

  /** The segment from the beat at grid time `from` to the beat at `to` (null: the end of the song). */
  segment(from: number, to: number | null): Segment {
    const seg: Segment = { s: this.join(from), e: to === null ? this.mono.length : this.join(to), r: 1, from };
    if (to !== null) seg.to = to;
    return seg;
  }

  /**
   * Fit `next` to follow `prev` (both may be changed). When both ends sit on beats, the two cut
   * points slide together, 3 to 20 ms before their attacks, to where the two sides of the
   * crossfade differ least (the smallest sum of squared differences: alike, or both quiet), so
   * the fade neither dips nor bumps, and the groove is untouched because both move together.
   * Otherwise `next` simply carries on from where `prev` stops.
   */
  fit(prev: Segment, next: Segment) {
    const X = this.xfade;
    if (prev.to === undefined || next.from === undefined || prev.to === next.from) { next.s = prev.e - X; next.r = 1; return; }
    const aOut = this.attack(prev.to), aIn = this.attack(next.from);
    const x = this.mono;
    let best = { cost: Infinity, pre: this.pre };
    for (let ms = 3; ms <= 20; ms += 0.5) {
      const pre = Math.round((ms / 1000) * this.sr), o = aOut - pre - X, n = aIn - pre - X;
      if (o < 0 || n < 0) continue;
      let cost = 0;
      for (let i = 0; i < X; i++) { const d = (x[o + i] ?? 0) - (x[n + i] ?? 0); cost += d * d; }
      if (cost < best.cost * 0.95) best = { cost, pre };
    }
    prev.e = aOut - best.pre;
    next.s = aIn - best.pre - X;
    next.r = this.correlation(prev.e, aIn - best.pre);
  }

  /** Correlation (-1..1) of the XFADE samples before two join samples. */
  private correlation(jOut: number, jIn: number): number {
    const x = this.mono, X = this.xfade;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < X; i++) { const p = x[jOut - X + i] ?? 0, q = x[jIn - X + i] ?? 0; sab += p * q; saa += p * p; sbb += q * q; }
    return saa * sbb < 1e-14 ? 1 : sab / Math.sqrt(saa * sbb);
  }

  /** How audible a join is likely to be: the loudness step between what would have followed `jOut` and what follows instead, over 80 ms. */
  score(jOut: number, jIn: number): JoinScore {
    const x = this.mono, n = Math.round(0.08 * this.sr);
    if (jOut === jIn) return { db: 0, r: 1, warn: false };
    const rms = (a: number) => { let s = 0; const b = Math.min(x.length, a + n); for (let i = a; i < b; i++) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, b - a) + 1e-9); };
    const db = Math.round(Math.abs(rms(jOut) - rms(jIn)) * 10) / 10;
    return { db, r: Math.round(this.correlation(jOut, jIn) * 100) / 100, warn: db > 3 };
  }
}

/**
 * Plays a chain of segments offline, exactly as the deck does live: each segment starts XFADE
 * samples before the previous one ends, with the crossfade shaped by fadeGains. One array per channel.
 */
export function render(channels: Float32Array[], segs: Segment[], xfade: number): Float32Array[] {
  let len = 0;
  segs.forEach((g, i) => { len += g.e - g.s - (i < segs.length - 1 ? xfade : 0); });
  const out = channels.map(() => new Float32Array(len));
  let p = 0;
  segs.forEach((g, i) => {
    const next = segs[i + 1];
    for (let k = 0; k < g.e - g.s; k++) {
      let gain = 1;
      if (i > 0 && k < xfade) gain *= fadeGains(k / (xfade - 1), g.r).in;
      const tail = g.e - g.s - k - 1; // samples left after this one
      if (next && tail < xfade) gain *= fadeGains((xfade - 1 - tail) / (xfade - 1), next.r).out;
      for (let c = 0; c < channels.length; c++) if (p + k < len) out[c][p + k] += (channels[c][g.s + k] ?? 0) * gain;
    }
    p += g.e - g.s - xfade;
  });
  return out;
}
