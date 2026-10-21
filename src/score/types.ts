// Vendored from Gondryator (https://github.com/FrunkQ/gondryator, The Unlicense), unchanged.
// The score: the one data format between analysis and every renderer (spec section 5).
// Renderers never touch raw audio. Everything here is plain JSON so it can be cached,
// exported, and read by a future UE5 renderer.

export type Stem = 'drums' | 'bass' | 'vocals' | 'other' | 'mix';
export type EventKind = 'kick' | 'snare' | 'hat' | 'note' | 'hit';

export interface ScoreEvent {
  id: string;
  /** Onset time in seconds from track start. */
  t: number;
  dur: number;
  stem: Stem;
  kind: EventKind;
  /** MIDI pitch, or null for unpitched events. */
  pitch: number | null;
  /** 0..1 */
  vel: number;
  /** Beat-relative position (bar, beat index 0..3, sixteenth 0..15). Lets packs make a
   * repeated bar produce the same visual pattern. */
  bar?: number;
  step?: number;
}

export interface Beat {
  t: number;
  bar: number;
  /** 1-based beat in bar. */
  beat: number;
  downbeat: boolean;
  strength: number;
}

export interface Section {
  t: number;
  label: 'intro' | 'verse' | 'chorus' | 'breakdown' | 'drop' | 'outro';
  /** 0..1 relative loudness of the section. */
  energy: number;
  /** Bar number where the section starts. */
  bar: number;
  /**
   * Sections that sound alike share a group number (0, 1, 2... in order of first appearance), so a
   * returning chorus can bring its picture back. Missing in scores from MIDI files.
   */
  group?: number;
}

export interface Phrase {
  t: number;
  bar: number;
  bars: number;
  /** Phrases with the same id sound alike. */
  id: number;
  /** Index of the first earlier phrase this one repeats, or null if new material. */
  repeatOf: number | null;
  /** Stems that became active in this phrase. */
  entering: Stem[];
}

/**
 * A sudden change, found ahead of time, on the beat it lands on (snapped to the downbeat when one
 * is within two beats and nearly as strong):
 * - `drop`: a slam-in, a big step up in loudness with the drums arriving, or anything coming back
 *   after a break, a stop or a build;
 * - `lift`: a smaller step up (the band filling out, a new layer coming in);
 * - `break`: the music thins out or the drums cut out, but something keeps playing;
 * - `stop`: everything stops (a near-silence), for `dur` seconds;
 * - `build`: a crescendo: `t` is where the climb starts and `dur` how long it climbs, so
 *   `t + dur` is where it peaks (usually a drop).
 */
export interface Moment {
  t: number;
  kind: 'drop' | 'lift' | 'break' | 'stop' | 'build';
  /** 0..1: how big the change is (decibels, plus the drums coming or going). */
  size: number;
  /** Bar and 1-based beat it lands on (same numbering as `beats`). */
  bar: number;
  beat: number;
  /** Seconds: how long a stop lasts, or how long a build climbs. */
  dur?: number;
}

/**
 * Continuous curves at 50 Hz: per-band loudness (`mix`, `bass`, `other`, `drums`), plus the shapes
 * between the hits: `contour` (the melody's pitch, 0 low .. 1 high, held through gaps),
 * `bright` (how bright the sound is), `rise` (build-ups: loudness and brightness climbing),
 * `leadPitch` / `bassPitch` (the exact pitch as MIDI with fractions, so slides glide; 0 = silent).
 */
export type EnvelopeKey = Stem | 'mix' | 'contour' | 'bright' | 'rise' | 'leadPitch' | 'bassPitch' | 'voice';

/**
 * What the sound pass (analysis/sounds.ts: YAMNet, a sound classifier) can recognise besides the
 * music itself, grouped into a few families that each get their own kind of reaction:
 * - `speech`: someone talking (dialogue samples, spoken word); `shout`: shouting, screaming;
 * - `laugh`; `sing`: singing, rapping, a choir, humming;
 * - `crowd`: cheering, applause, clapping, a crowd;
 * - `animal`: birds, dogs, whales and the rest; `nature`: wind, rain, thunder, water, fire;
 * - `siren`: sirens, alarms, phones, horns, whistles; `engine`: cars, trains, planes, engines;
 * - `impact`: explosions, bangs, slams, smashes, gunshots, fireworks; `whoosh`: whooshes, whips;
 * - `tick`: a clock ticking; `beep`: beeps, pings, dings, jingles.
 */
export type SoundKind = 'speech' | 'shout' | 'laugh' | 'sing' | 'crowd' | 'animal' | 'nature' | 'siren' | 'engine' | 'impact' | 'whoosh' | 'tick' | 'beep';

/** A recognised sound: from `t` for `dur` seconds, its family, the classifier's own label and how sure it was (0..1). */
export interface SoundCue {
  t: number;
  dur: number;
  kind: SoundKind;
  label: string;
  score: number;
}

export interface Envelope {
  /** Samples per second. */
  rate: number;
  values: number[];
}

export interface Score {
  version: 1;
  track: {
    title: string;
    artist: string;
    album: string;
    /** Release year from the tags (or a year in the title), if known: picks the climax's decade. */
    year?: number;
    durationSec: number;
    art: string | null;
    hash: string;
  };
  analysis: {
    /** 'bands' = no neural stem separation; stems are approximated by frequency bands. */
    mode: 'bands' | 'stems' | 'midi';
    stems: Stem[];
    engine: string;
    realtimeFactor: number;
  };
  tempo: { t: number; bpm: number }[];
  beats: Beat[];
  sections: Section[];
  phrases: Phrase[];
  /**
   * Sudden changes (drops, lifts, breaks, stops, builds), in time order. Missing in scores cached
   * before they existed and in scores from MIDI files; treat missing as unknown, not as none.
   */
  moments?: Moment[];
  events: ScoreEvent[];
  envelopes: Partial<Record<EnvelopeKey, Envelope>>;
  /**
   * Recognised sounds (speech, crowds, sirens, explosions...), in time order, from the sound pass,
   * which runs alongside the fast parser and has a frontier of its own: cues before
   * `soundsFrontier` are final. Missing when the pass has not run (or cannot, on this device).
   */
  sounds?: SoundCue[];
  soundsFrontier?: number;
  /** Everything with t < frontierSec is final and will never change. */
  frontierSec: number;
  final: boolean;
}

/** Incremental update sent from the analysis worker. Only ever appends. */
export interface ScoreDelta {
  frontierSec: number;
  final: boolean;
  tempo: Score['tempo'];
  beats: Beat[];
  sections: Section[];
  phrases: Phrase[];
  moments?: Moment[];
  events: ScoreEvent[];
  envelopes: Partial<Record<EnvelopeKey, number[]>>;
  envelopeRate: number;
  realtimeFactor: number;
}

export function emptyScore(track: Score['track'], durationSec: number): Score {
  return {
    version: 1,
    track: { ...track, durationSec },
    analysis: { mode: 'bands', stems: ['drums', 'bass', 'other'], engine: 'gondryator-dsp 0.1', realtimeFactor: 0 },
    tempo: [],
    beats: [],
    sections: [],
    phrases: [],
    moments: [],
    events: [],
    envelopes: {},
    frontierSec: 0,
    final: false,
  };
}

export function applyDelta(score: Score, d: ScoreDelta): void {
  score.frontierSec = d.frontierSec;
  score.final = d.final;
  score.analysis.realtimeFactor = d.realtimeFactor;
  for (const x of d.tempo) score.tempo.push(x);
  for (const x of d.beats) score.beats.push(x);
  for (const x of d.sections) score.sections.push(x);
  for (const x of d.phrases) score.phrases.push(x);
  if (d.moments) for (const x of d.moments) (score.moments ??= []).push(x);
  for (const x of d.events) score.events.push(x);
  for (const k of Object.keys(d.envelopes) as EnvelopeKey[]) {
    const env = (score.envelopes[k] ??= { rate: d.envelopeRate, values: [] });
    for (const v of d.envelopes[k]!) env.values.push(v);
  }
}

/** Sample an envelope at time t (linear). */
export function sampleEnvelope(env: Envelope | undefined, t: number): number {
  if (!env || env.values.length === 0) return 0;
  const x = t * env.rate;
  const i = Math.floor(x);
  if (i < 0) return env.values[0];
  if (i >= env.values.length - 1) return env.values[env.values.length - 1];
  const f = x - i;
  return env.values[i] * (1 - f) + env.values[i + 1] * f;
}

/**
 * Where t sits on the 4/4 grid, for anticipating the music: the beat and bar it is in, how far
 * through them it is (0..1), and when the next beat, downbeat and phrase start. Times past the
 * last known beat carry on at the last beat's spacing. Null until the first beats are known.
 */
export interface GridPos {
  bar: number;
  /** 1-based beat in the bar. */
  beat: number;
  beatFrac: number;
  barFrac: number;
  /** Seconds per beat here. */
  beatSec: number;
  nextBeat: number;
  nextDownbeat: number;
  /** The phrase t is in (index into `phrases`, -1 before the first), and when the next one starts. */
  phrase: number;
  phraseFrac: number;
  nextPhrase: number;
}

export function gridAt(score: Score, t: number): GridPos | null {
  const B = score.beats;
  if (B.length < 2) return null;
  let lo = 0, hi = B.length - 1;
  if (t < B[0].t) lo = 0;
  else { while (lo < hi - 1) { const m = (lo + hi) >> 1; if (B[m].t <= t) lo = m; else hi = m; } if (t >= B[B.length - 1].t) lo = B.length - 1; }
  const b = B[lo];
  const beatSec = (lo + 1 < B.length ? B[lo + 1].t : b.t + (b.t - B[lo - 1].t)) - b.t;
  // Past the last beat, extrapolate on the last spacing.
  const k = t > b.t + beatSec ? Math.floor((t - b.t) / beatSec) : 0;
  const t0 = b.t + k * beatSec;
  const idx = b.beat - 1 + k;
  const bar = b.bar + Math.floor(idx / 4), beat = (idx % 4) + 1;
  const beatFrac = Math.min(1, Math.max(0, (t - t0) / beatSec));
  let nextDownbeat = t0 + (4 - (beat - 1)) * beatSec;
  for (let i = lo + 1; i < B.length && k === 0; i++) if (B[i].downbeat && B[i].t > t) { nextDownbeat = B[i].t; break; }
  const P = score.phrases;
  let phrase = -1;
  for (let i = 0; i < P.length && P[i].t <= t + 1e-6; i++) phrase = i;
  const cur = P[phrase];
  const nextPhrase = P[phrase + 1]?.t ?? (cur ? cur.t + cur.bars * 4 * beatSec : nextDownbeat);
  return {
    bar, beat, beatFrac, barFrac: (beat - 1 + beatFrac) / 4, beatSec, nextBeat: t0 + beatSec, nextDownbeat,
    phrase, phraseFrac: cur ? Math.min(1, Math.max(0, (t - cur.t) / Math.max(1e-3, nextPhrase - cur.t))) : 0, nextPhrase,
  };
}

/** The next moment after t (optionally of the given kinds), or null. */
export function nextMoment(score: Score, t: number, kinds?: Moment['kind'][]): Moment | null {
  for (const m of score.moments ?? []) if (m.t > t && (!kinds || kinds.includes(m.kind))) return m;
  return null;
}

export function sectionAt(score: Score, t: number): { section: Section | null; index: number } {
  let idx = -1;
  for (let i = 0; i < score.sections.length; i++) {
    if (score.sections[i].t <= t + 1e-6) idx = i;
    else break;
  }
  return { section: idx >= 0 ? score.sections[idx] : null, index: idx };
}

/**
 * Long sections split into sub-parts of SUB_BARS bars (C1 becomes C1a, C1b, C1c...), so a long,
 * samey stretch still changes: a palette swap on each, a bigger change every other one. A section
 * shorter than two sub-parts stays whole; a short tail joins the last sub-part.
 */
export const SUB_BARS = 8;
const subCache = new WeakMap<Score, Map<string, number[]>>();
/** Start times of the sub-parts of section `idx` (just its own start when it is short). */
export function subPartsOf(score: Score, idx: number): number[] {
  const sec = score.sections[idx];
  if (!sec) return [];
  const end = score.sections[idx + 1]?.t ?? (score.final ? score.track.durationSec : score.frontierSec);
  const key = `${idx}:${end.toFixed(2)}:${score.beats.length}`;
  let m = subCache.get(score);
  if (!m) subCache.set(score, m = new Map());
  const hit = m.get(key);
  if (hit) return hit;
  const downs = score.beats.filter(b => b.downbeat && b.t >= sec.t - 0.05 && b.t < end - 0.05);
  const n = downs.length >= 2 * SUB_BARS ? Math.floor(downs.length / SUB_BARS) : 1;
  const out = Array.from({ length: n }, (_, k) => (k === 0 ? sec.t : downs[k * SUB_BARS].t));
  m.set(key, out);
  return out;
}
/** Which sub-part of which section t is in (sub 0 = the section's start; subs = how many). */
export function subPartAt(score: Score, t: number): { index: number; sub: number; subs: number } {
  const { index } = sectionAt(score, t);
  if (index < 0) return { index, sub: 0, subs: 1 };
  const parts = subPartsOf(score, index);
  let sub = 0;
  while (sub + 1 < parts.length && parts[sub + 1] <= t + 1e-6) sub++;
  return { index, sub, subs: parts.length };
}

/**
 * The song's shape in one line, like "intro · A A · B B · breakdown · drop (A) · C · A · outro":
 * sections that sound alike share a letter, in order of first appearance. `current` (a section
 * index) is shown in brackets.
 */
export function describeStructure(score: Score, current = -1): string {
  const letter = new Map<number, string>();
  const named = (l: string) => l === 'intro' || l === 'outro' || l === 'breakdown';
  const words = score.sections.map((sec, i) => {
    let w: string;
    if (named(sec.label) || sec.group === undefined) w = sec.label;
    else {
      if (!letter.has(sec.group)) letter.set(sec.group, String.fromCharCode(65 + letter.size));
      w = sec.label === 'drop' ? `drop (${letter.get(sec.group)})` : letter.get(sec.group)!;
    }
    return i === current ? `[${w}]` : w;
  });
  let out = '';
  words.forEach((w, i) => {
    if (i === 0) { out = w; return; }
    const prev = words[i - 1].replace(/[[\]]/g, ''), cur = w.replace(/[[\]]/g, '');
    const run = prev === cur;
    out += (run ? ' ' : ' · ') + w;
  });
  return out + (score.final ? '' : ' …');
}
