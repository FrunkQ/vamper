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
