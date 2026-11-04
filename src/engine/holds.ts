// Holds: the passages of a song the music can wait in, found from the score so a song "just works"
// the moment it is analysed. Each section of four bars or more is a hold. It riffs when its bars
// are alike enough to jump between and nobody is singing or talking in it (a riff cuts words;
// a loop only cuts at its wrap), and loops otherwise. A loop's wrap is checked: a vocal line across
// it is heard on every pass, so then a shorter passage of whole phrases whose wrap is clear of the
// vocal is used instead; a loudness step is only reported (at a section's end, what would have
// followed is the next section, so a step there is often just the music changing). Up to four holds
// are `suggested`, the ones a song waits at when played from the top: the two longest riffs and the
// two longest loops, never the intro, a breakdown or the outro while there is anything else (those
// are passages between grooves, not grooves to sit in). Pure, so the deck and the Node join test share it.
import type { Score } from '../score/types';
import { barStarts, sectionNames, voiceAcross, voiceAt, VOICE_QUIET } from './plan';
import type { Riff } from './riff';

/** A section with more of its time sung or spoken than this (0..1) loops rather than riffs. */
export const RIFF_VOICE_MAX = 0.2;
/** A loop's wrap with a bigger loudness step (dB) than this is likely to be heard. */
export const WRAP_MAX_DB = 3;
/** Sections a song doesn't wait at by default: passages between grooves rather than grooves. */
export const PASSING = new Set(['intro', 'breakdown', 'outro']);

export interface Hold {
  /** The section it comes from (index into score.sections). */
  section: number;
  /** The section's letter (or intro, outro...) and its label. */
  name: string;
  label: string;
  /** Downbeat times: the passage is from..to, `bars` long (fewer than the section's `sectionBars` when shortened for a clean wrap). */
  from: number;
  to: number;
  bars: number;
  sectionBars: number;
  mode: 'riff' | 'loop';
  /** Jumps the riff can take (after the voice curve rules some out); 0 for a loop. */
  jumps: number;
  /** Share of the passage (0..1) with someone singing or talking; null until the voice pass has listened there. */
  voice: number | null;
  /** The wrap's loudness step (dB) and whether it cuts a vocal line (null: not listened yet). */
  wrapDb: number;
  wrapVoice: number | null;
  /** True when the wrap may be heard on every pass: a loudness step over WRAP_MAX_DB, or a vocal line across it. */
  rough: boolean;
  /** The holds a song waits at by default: the two longest riffs and the two longest loops (not the intro, a breakdown or the outro). */
  suggested: boolean;
}

export interface HoldTools {
  /** The riff over a passage (Looper.riffFor / Deck.riffOn). */
  riff: (from: number, to: number) => Riff;
  /** The loudness step (dB) of a cut from grid time `out` to grid time `into` (Cutter.score). */
  joinDb: (out: number, into: number) => number;
}

/** Share of from..to with a voice at or above VOICE_QUIET, or null while the voice pass hasn't reached `to`. */
export function voiceShare(score: Score, from: number, to: number): number | null {
  const v = score.envelopes.voice;
  if (!v || (score.soundsFrontier ?? 0) < to - 0.5) return null;
  let n = 0, on = 0;
  for (let t = from + 0.5 / v.rate; t < to; t += 1 / v.rate) { n++; if ((voiceAt(score, t) ?? 0) >= VOICE_QUIET) on++; }
  return n ? on / n : 0;
}

/** The holds of a song: every section of four bars or more, as a riff or a loop; the two longest riffs and the two longest loops marked `suggested`. */
export function findHolds(score: Score, tools: HoldTools, minBars = 4): Hold[] {
  const bars = barStarts(score), S = score.sections, names = sectionNames(score);
  const end = score.final ? score.track.durationSec : score.frontierSec;
  const holds: Hold[] = [];
  S.forEach((s, i) => {
    const from = s.t, secEnd = S[i + 1]?.t ?? bars.filter(t => t < end - 0.5).pop() ?? from;
    const inside = bars.filter(t => t >= from - 0.02 && t < secEnd - 0.02);
    if (inside.length < minBars) return;
    const voice = voiceShare(score, from, secEnd);
    const wrap = (to: number) => {
      const db = Math.round(tools.joinDb(to, from) * 10) / 10, wv = max(voiceAcross(score, from), voiceAcross(score, to));
      const sung = wv !== null && wv >= VOICE_QUIET;
      return { db, wv, sung, rough: sung || db > WRAP_MAX_DB };
    };
    let to = secEnd, w = wrap(to), mode: Hold['mode'] = 'loop', jumps = 0;
    if ((voice ?? 0) <= RIFF_VOICE_MAX) {
      const r = tools.riff(from, secEnd);
      jumps = r.jumps.flat().filter(j => r.voiceClear(j)).length;
      if (jumps > 0) mode = 'riff';
    }
    if (mode === 'loop' && w.sung) {
      // Try shorter passages of whole phrases, longest first, for a wrap clear of the vocal.
      for (let n = Math.floor((inside.length - 1) / 4) * 4; n >= minBars; n -= 4) {
        const alt = inside[n], aw = wrap(alt);
        if (!aw.sung) { to = alt; w = aw; break; }
      }
    }
    holds.push({ section: i, name: names[i], label: s.label, from, to, bars: inside.filter(t => t < to - 0.02).length, sectionBars: inside.length, mode, jumps, voice, wrapDb: w.db, wrapVoice: w.wv, rough: w.rough, suggested: false });
  });
  // The song waits at the two longest riffs and the two longest loops, leaving the intro, breakdowns
  // and the outro alone (unless they are all there is): a few holds is plenty to start with; the rest can be switched on.
  const middle = holds.filter(h => !PASSING.has(h.label)), pool = middle.length ? middle : holds;
  for (const mode of ['riff', 'loop'] as const) {
    for (const h of pool.filter(h => h.mode === mode).sort((a, b) => b.bars - a.bars || Number(a.rough) - Number(b.rough)).slice(0, 2)) h.suggested = true;
  }
  return holds;
}
function max(a: number | null, b: number | null) { return a === null ? b : b === null ? a : Math.max(a, b); }
