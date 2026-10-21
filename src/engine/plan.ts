// Musical decisions on the score: where bars start, where a change may land, what comes next.
// Pure, so the deck and the Node join test share them.
import type { Score, Section } from '../score/types';

/** When a change may land: the next beat, the next bar (default), the next phrase, or the end of the current loop pass. */
export type Quantise = 'beat' | 'bar' | 'phrase' | 'loop';

/** Downbeat times, one per bar, in order. */
export function barStarts(score: Score): number[] {
  return score.beats.filter(b => b.downbeat).map(b => b.t);
}

/** The downbeat nearest t (or t itself before the grid is known). */
export function snapToBar(score: Score, t: number): number {
  let best = t, d = Infinity;
  for (const b of barStarts(score)) if (Math.abs(b - t) < d) { d = Math.abs(b - t); best = b; }
  return best;
}

/** The last downbeat before `end` (so a final section's loop is whole bars). */
export function lastBar(score: Score, end: number): number {
  let t = end;
  for (const b of score.beats) if (b.downbeat && b.t < end - 0.5) t = b.t;
  return t;
}

/**
 * Rough times (say, a playhead grabbed by hand) turned into a passage of whole bars: both ends
 * snap to the nearest downbeat, a missing end means the last bar, and it is at least one bar long.
 */
export function barSpan(score: Score, from: number, to: number | null): [number, number] {
  const bars = barStarts(score), last = lastBar(score, score.track.durationSec);
  const a = Math.min(snapToBar(score, from), bars.filter(t => t < last).pop() ?? from);
  let b = to === null ? last : snapToBar(score, to);
  if (b <= a + 0.05) b = bars.find(t => t > a + 0.05) ?? last;
  return [a, b];
}

/** The bar index (0-based into barStarts) that starts at or before t, or -1. */
export function barIndexAt(score: Score, t: number): number {
  const bars = barStarts(score);
  let i = -1;
  while (i + 1 < bars.length && bars[i + 1] <= t + 1e-6) i++;
  return i;
}

/** The first point after t (and before `before`) where a change may land, or null if there is none. */
export function nextBoundary(score: Score, t: number, q: Quantise, before = Infinity): number | null {
  if (q === 'loop') return null;
  const times = q === 'beat' ? score.beats.map(b => b.t) : q === 'bar' ? barStarts(score) : score.phrases.map(p => p.t);
  for (const x of times) if (x > t && x < before - 1e-6) return x;
  return null;
}

/** The section that starts after t (the one to advance to), or null at the last section. */
export function followingSection(score: Score, t: number): Section | null {
  return score.sections.find(s => s.t > t + 1e-3) ?? null;
}

/** Section letters as describeStructure gives them (A, B... by group; intro, outro and breakdown by name). */
export function sectionNames(score: Score): string[] {
  const letter = new Map<number, string>();
  return score.sections.map(sec => {
    if (sec.label === 'intro' || sec.label === 'outro' || sec.label === 'breakdown' || sec.group === undefined) return sec.label;
    if (!letter.has(sec.group)) letter.set(sec.group, String.fromCharCode(65 + letter.size));
    return letter.get(sec.group)!;
  });
}

/** Below this (0..1) the voice pass hears nobody singing or talking. */
export const VOICE_QUIET = 0.3;

/** How sure the voice pass is that someone is singing or talking at t (0..1), or null where it hasn't listened (yet). */
export function voiceAt(score: Score, t: number): number | null {
  const v = score.envelopes.voice;
  if (!v || t < 0 || t >= (score.soundsFrontier ?? 0)) return null;
  return v.values[Math.min(v.values.length - 1, Math.floor(t * v.rate))] ?? null;
}

/**
 * How likely a cut at t splits a sung or spoken line: the voice on both sides of it (the smaller,
 * so a line that ends just before the bar, or starts on it, doesn't count). Null when unknown.
 */
export function voiceAcross(score: Score, t: number): number | null {
  const a = voiceAt(score, t - 0.3), b = voiceAt(score, t + 0.3);
  return a === null || b === null ? null : Math.min(a, b);
}

/**
 * Like nextBoundary, but it may wait up to `waitBars` more bars for a cut that doesn't split a
 * vocal line: the first boundary in that window with no voice across it, or else the one with the
 * least (a phrase start counts as 0.2 less, since a new vocal line usually starts there).
 * `held` is true when it chose a later boundary than nextBoundary would have.
 */
export function nextCut(score: Score, t: number, q: Quantise, before = Infinity, waitBars = 2): { at: number; voice: number | null; held: boolean } | null {
  const first = nextBoundary(score, t, q, before);
  if (first === null) return null;
  const v0 = voiceAcross(score, first);
  if (waitBars <= 0 || v0 === null || v0 < VOICE_QUIET || q === 'loop') return { at: first, voice: v0, held: false };
  const bars = barStarts(score), k = bars.findIndex(b => b > first + 1e-6);
  const limit = Math.min(before, bars[k + waitBars - 1] ?? Infinity);
  const phrase = new Set(score.phrases.map(p => p.t));
  let best = { at: first, voice: v0 as number | null, cost: v0 - (phrase.has(first) ? 0.2 : 0) };
  for (let x = nextBoundary(score, first, q, before); x !== null && x <= limit + 1e-6; x = nextBoundary(score, x, q, before)) {
    const v = voiceAcross(score, x);
    if (v === null || v < VOICE_QUIET) return { at: x, voice: v, held: true };
    const cost = v - (phrase.has(x) ? 0.2 : 0);
    if (cost < best.cost - 0.05) best = { at: x, voice: v, cost };
  }
  return { at: best.at, voice: best.voice, held: best.at !== first };
}
