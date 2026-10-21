// Riffing: play a passage's bars in a varied order, the way a band vamps, instead of a tape loop.
// A graph over the passage's bars says which bar may follow which: always the next one (the last
// bar's next is the first, the loop's own wrap), plus a jump i -> j wherever bar j sounds like the
// bar that would have followed i (and j's bar before sounds like i), and the cut is not a loudness
// step. A seeded walk then picks the bars: mostly in order, a jump every few bars, preferably where
// a phrase starts, never the same jump twice running, never out of or into a sung line, and always
// to the same place in a phrase, so the music keeps breathing in fours. Pure, so the deck and the
// Node join test share it.
import type { BarFeature, Score } from '../score/types';
import { voiceAcross, VOICE_QUIET } from './plan';

export interface RiffOptions {
  /** The same seed gives the same riff (from the same bar, with the same voice curve). */
  seed?: number;
  /** About how many bars between jumps (default 4). */
  jumpEvery?: number;
  /** How alike (0..1) two bars must sound for a jump between them (default 0.8). */
  minSimilarity?: number;
  /** Loudness step (dB) of a cut from grid time `out` to grid time `into` (Cutter.score); jumps above `maxDb` are refused. */
  joinDb?: (out: number, into: number) => number;
  /** Default 3 dB, the level at which a loop's wrap is flagged as likely audible. */
  maxDb?: number;
}

/** A possible jump: after bar `from` (0-based in the passage) play bar `to`; how alike the bars are (0..1) and the cut's loudness step (dB, null when not measured). */
export interface RiffJump { from: number; to: number; sim: number; db: number | null }

/** A stretch the deck plays in one go: grid times `from`..`to` (whole bars in order), entered by `jump` (null: the start, or the loop's wrap). */
export interface RiffRun { from: number; to: number; first: number; jump: RiffJump | null }

/** How alike two bars sound, 0..1: drum grid, harmony and bass notes (as the analyser compares phrases), less a little for a loudness difference. */
export function barSimilarity(a: BarFeature, b: BarFeature): number {
  const parts: [number[], number[], number][] = [[a.grid, b.grid, 1], [a.chroma, b.chroma, 0.64], [a.bass, b.bass, 0.36]];
  let s = 0, w = 0;
  for (const [x, y, k] of parts) { s += k * cosine(x, y); w += k; }
  const loud = Math.max(...a.db.map((v, i) => Math.abs(v - (b.db[i] ?? v))));
  return Math.max(0, s / w - Math.max(0, loud - 2) * 0.03);
}

function cosine(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * (b[i] ?? 0); na += a[i] * a[i]; nb += (b[i] ?? 0) ** 2; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : na === 0 && nb === 0 ? 1 : 0;
}

/** A small seeded random generator (mulberry32), 0..1. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A seed from text (a song's hash and a cue's start), so a cue riffs the same way every time until rerolled. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export class Riff {
  /** Downbeat times of the passage's bars, plus its end: bar k is times[k]..times[k + 1]. */
  readonly times: number[];
  /** Possible jumps out of each bar (index = the bar played before the jump). */
  readonly jumps: RiffJump[][];
  /** Bars a jump keeps the place in: 4 (whole phrases) when the passage is whole phrases of at least 8 bars, 2 for other even lengths, else 1. */
  readonly unit: number;
  /** Song bar numbers (1-based) of the bars chosen so far, the latest last (up to 64), for the readout. */
  readonly path: number[] = [];
  private rng: () => number;
  private every: number;
  private since = 0;
  private gap = 0;
  private lastJump = '';
  private upcoming: { bar: number; jump: RiffJump | null } = { bar: 0, jump: null };
  private firstBar: number;

  constructor(private score: Score, from: number, to: number, opts: RiffOptions = {}) {
    const downbeats = score.beats.filter(b => b.downbeat).map(b => b.t);
    this.times = [...downbeats.filter(t => t >= from - 0.02 && t < to - 0.02), to];
    const n = this.bars;
    this.firstBar = downbeats.filter(t => t < from - 0.02).length + 1;
    this.unit = n >= 8 && n % 4 === 0 ? 4 : n >= 4 && n % 2 === 0 ? 2 : 1;
    this.rng = seeded(opts.seed ?? 1);
    this.every = Math.max(2, opts.jumpEvery ?? 4);
    this.gap = this.every;
    const min = opts.minSimilarity ?? 0.8, maxDb = opts.maxDb ?? 3;
    const feats = this.times.slice(0, n).map(t => score.bars?.find(b => Math.abs(b.t - t) < 0.05) ?? null);
    this.jumps = this.times.slice(0, n).map((_, i) => {
      const out: RiffJump[] = [], nat = (i + 1) % n;
      for (let j = 0; j < n; j++) {
        if (j === nat || ((j - nat) % this.unit + this.unit) % this.unit !== 0) continue;
        // Bar j must sound like the bar it replaces, and the bar before j like bar i: the jump then
        // lands in the same musical place.
        const fi = feats[i], fn = feats[nat], fj = feats[j], fp = feats[(j - 1 + n) % n];
        // The cut's step compares what we land on with what would have played: the next bar, or
        // after the last bar the first (the loop's own wrap, already accepted with the passage).
        const step = () => (opts.joinDb ? opts.joinDb(this.times[nat === 0 ? 0 : i + 1], this.times[j]) : null);
        let sim: number, db: number | null = null;
        if (fi && fn && fj && fp) sim = 0.65 * barSimilarity(fj, fn) + 0.35 * barSimilarity(fp, fi);
        else if (opts.joinDb) sim = 1 - (db = step())! / 6; // no features (an old score): the audio alone
        else continue;
        if (sim < min) continue;
        db ??= step();
        if (db !== null && db > maxDb) continue;
        out.push({ from: i, to: j, sim: Math.round(sim * 100) / 100, db: db === null ? null : Math.round(db * 10) / 10 });
      }
      return out;
    });
  }

  get bars() { return this.times.length - 1; }
  /** How many jumps the graph has (before the voice curve rules any out). */
  get jumpCount() { return this.jumps.reduce((a, js) => a + js.length, 0); }
  /** The bar (0-based in the passage) playing at song time t, or -1 outside it. */
  barAt(t: number): number {
    for (let k = this.bars - 1; k >= 0; k--) if (t >= this.times[k] - 0.02) return t < this.times[this.bars] ? k : -1;
    return -1;
  }
  /** True when grid time t is the end of one of the passage's bars (where a run can end). */
  ends(t: number) { return this.times.some((x, k) => k > 0 && Math.abs(x - t) < 1e-6); }

  /** Whether a jump is clear of sung lines at both its cut (out) and where it lands (in). Unknown voice counts as clear. */
  voiceClear(j: RiffJump): boolean {
    const a = voiceAcross(this.score, this.times[j.from + 1]), b = voiceAcross(this.score, this.times[j.to]);
    return (a === null || a < VOICE_QUIET) && (b === null || b < VOICE_QUIET);
  }

  /** Start (or restart) the walk at bar k; the next run begins there. */
  start(k: number) { this.upcoming = { bar: Math.max(0, Math.min(this.bars - 1, k)), jump: null }; this.since = 0; }

  /** The next stretch to play: from the bar chosen last time, in order, until the walk jumps or wraps. */
  next(): RiffRun {
    const first = this.upcoming;
    let k = first.bar;
    for (;;) {
      this.note(k);
      const d = this.after(k);
      if (d.jump || d.bar !== k + 1) { this.upcoming = d; break; }
      k = d.bar;
    }
    return { from: this.times[first.bar], to: this.times[k + 1], first: first.bar, jump: first.jump };
  }

  /** What follows bar i: the next bar, or (every few bars, preferably at a phrase start) a jump. */
  private after(i: number): { bar: number; jump: RiffJump | null } {
    const n = this.bars, nat = (i + 1) % n;
    this.since++;
    const phraseStart = nat % Math.min(4, Math.max(this.unit, 2)) === 0;
    if (this.since < this.gap || (!phraseStart && this.since < this.gap + 2)) return { bar: nat, jump: null };
    const options = this.jumps[i].filter(j => `${j.from}>${j.to}` !== this.lastJump && this.voiceClear(j));
    if (!options.length) return { bar: nat, jump: null };
    // Better matches are likelier, but any good jump can come up.
    const w = options.map(j => (j.sim - 0.7) ** 2 + 0.01), total = w.reduce((a, b) => a + b, 0);
    let r = this.rng() * total, pick = options[0];
    for (let q = 0; q < options.length; q++) { r -= w[q]; if (r <= 0) { pick = options[q]; break; } }
    this.since = 0;
    this.gap = this.every - 1 + Math.floor(this.rng() * 3);
    this.lastJump = `${pick.from}>${pick.to}`;
    return { bar: pick.to, jump: pick };
  }

  private note(k: number) { this.path.push(this.firstBar + k); if (this.path.length > 64) this.path.shift(); }
}
