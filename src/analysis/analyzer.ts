// Vendored from Gondryator (https://github.com/FrunkQ/gondryator, The Unlicense). Two changes: two unused
// private fields removed, so the file compiles under stricter apps (see tsconfig.lib.json); and each
// bar's features (drum grid, chroma, bass notes, band loudness, density) are sent in the delta as
// `bars`, for riffing (src/engine/riff.ts).
// Progressive music analysis: audio -> score, front to back, in chunks.
//
// This is the "bands" engine: no neural stem separation. Drums are found from band-split
// onsets (kick / snare / hats), bass and lead notes from YIN pitch tracking on band-passed
// signals, pads from chroma, plus a causal beat tracker, bars, 4-bar phrases with repeat
// detection, section boundaries, and moments (drops, breaks, stops, builds) judged beat by beat. Every stage is causal or bounded-lookahead, so the
// score's frontier is honest: nothing before `frontierSec` ever changes.
//
// It is pure TypeScript with no DOM dependency so it runs in a Web Worker and in Node tests.

import { DEFAULT_TUNING, type Tuning } from './tuning';
import { FFT, biquad, clamp, decimate, halve, hzToMidi, percentile, yin } from './dsp';
import type { BarFeature, Beat, EventKind, Moment, Phrase, ScoreDelta, ScoreEvent, Section, Stem } from '../score/types';

const N = 1024; // STFT size at ~22 kHz
const HOP = 256; // ~11.6 ms
const ENV_RATE = 50;

interface Onset { frame: number; t: number; vel: number; kind: EventKind }
interface NoteTrack {
  pitch: Float32Array; // midi or 0 per frame
  energy: Float32Array; // dB per frame
  active: { start: number; pitchSum: number; count: number; peakDb: number; lowDbRun: number; all: number[] } | null;
  done: ScoreEvent[];
  stem: Stem;
  minFrames: number;
}

export interface AnalyzerOptions {
  /** Seconds of audio processed per step. */
  chunkSec?: number;
  /** Artificial slow-down for testing the frontier guard (wall-clock ms per audio second). */
  throttleMsPerSec?: number;
  /** The parser's knobs (Tuning screen). */
  tuning?: Partial<Tuning>;
}

export class Analyzer {
  readonly sr: number; // analysis sample rate
  readonly duration: number;
  readonly frames: number;
  readonly hopSec: number;

  private x: Float32Array;
  private bassSig: Float32Array; private bassSr: number;
  private fft = new FFT(N);
  private fftBig = new FFT(4096);
  private mags = new Float32Array(N / 2 + 1);
  private magsBig = new Float32Array(4096 / 2 + 1);
  private prevLog = new Float32Array(N / 2 + 1);
  private curLog = new Float32Array(N / 2 + 1);
  private yinScratch = new Float64Array(512);

  // Per-frame features.
  private fluxLow: Float32Array; private fluxMid: Float32Array; private fluxHigh: Float32Array;
  private dbLow: Float32Array; private dbMid: Float32Array; private dbHigh: Float32Array; private dbAll: Float32Array;
  private flat: Float32Array;
  private odf: Float32Array;
  /** Spectral centroid per frame, 0..1 on a log scale from 200 Hz to 8 kHz. */
  private centroid: Float32Array;
  /** The top line: the highest clearly sounding pitch, from harmonic sums on a long FFT (MIDI, 0 = none). */
  private topLine: Float32Array;
  private magsTop = new Float32Array(4096 / 2 + 1);
  // Contour / brightness / rise curve state (advanced in order as envelopes are committed).
  private contourVal = 0.3; private contourHist: number[] = [];
  private brightVal = 0.4; private emaFast = 0; private emaSlow = 0; private riseVal = 0; private curveInit = false;

  private framesDone = 0;
  private onsetScanned = 0; // frames scanned for onset peaks
  private onsets: Onset[] = [];
  private lastOnsetFrame: Record<string, number> = { kick: -1e9, snare: -1e9, hat: -1e9 };
  private p95 = { low: 1, mid: 1, high: 1 };
  private pScratch: number[] = [];

  // Beats.
  private periodFrames = 0;
  private beatsFrozen = 0;
  private tempoDisagree = 0;
  private beatFrames: number[] = [];
  private beatStrength: number[] = [];
  private bars: { sb: number; eb: number }[] = [];
  private dbEvidence: number[] = [];
  private phaseVotes = 0;
  private tempoOut: { t: number; bpm: number }[] = [];
  private lastBpm = 0;

  // Bars / phrases / sections.
  private barFeatures: { grid: Float32Array; chroma: Float32Array; bassPc: Float32Array; db: number[]; density: number[]; bassVoiced: number; midDb: number }[] = [];
  private barsDecided = 0; // bars whose section membership is known
  private phraseStart = 1; // first bar of the open phrase
  private novelty: number[] = [];
  private phrasesOut: Phrase[] = [];
  private phraseVecs: Float32Array[] = [];
  private sectionsOut: Section[] = [];
  private sectionVecs: Float32Array[] = [];
  private sectionStems: number[] = [];
  private sectionDrums: boolean[] = [];
  private groups = 0;
  private lastSectionBar = -999;
  /** The song's last sections are held back until the end is known, so a fade or a closing break can be named an outro. */
  private sectionsFinal = false;
  private deferTo = -1; // a section boundary moved on to the next phrase start
  private prevBlockActive: Set<Stem> = new Set();
  private padEvents: ScoreEvent[] = [];

  private bass: NoteTrack; private lead: NoteTrack;

  // Moments: sudden changes, judged per beat on loudness and kick/snare hits.
  private hitFrames: Float32Array; // kick + snare velocity per frame
  private beatLv: { db: number; hits: number; x: number }[] = [];
  private beatScore: MomentScore[] = [];
  private beatDbSorted: number[] = [];
  private momentScored = 0; private momentFinal = 0;
  private momentsOut: Moment[] = []; private dipBeats: number[] = []; private grooveSeen = false;
  private lastUp = -99; private lastDown = -99; private soundBeat = -1;
  private buildBar = 2; private buildStart = -1; private buildEnd = 0;

  // Commit bookkeeping.
  private committedSec = 0;
  private sentBeats = 0; private sentSections = 0; private sentPhrases = 0; private sentTempo = 0; private sentMoments = 0; private sentBars = 0;
  private sentEnv = 0;
  private eventId = 0;
  private drumEnv = 0;
  private startWall = 0;
  private opts: Required<AnalyzerOptions>;
  private k: Tuning;

  /** Calibrated onset offset (seconds) so event times land on the audible attack. */
  static ONSET_OFFSET = 0;

  constructor(pcm: Float32Array, sampleRate: number, opts: AnalyzerOptions = {}) {
    this.opts = { chunkSec: 4, throttleMsPerSec: 0, tuning: {}, ...opts };
    const k = this.k = { ...DEFAULT_TUNING, ...opts.tuning };
    let x = pcm;
    let sr = sampleRate;
    while (sr > 30000) { x = halve(x); sr /= 2; }
    this.x = x;
    this.sr = sr;
    this.duration = pcm.length / sampleRate;
    this.hopSec = HOP / sr;
    this.frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);

    const F = this.frames;
    this.fluxLow = new Float32Array(F); this.fluxMid = new Float32Array(F); this.fluxHigh = new Float32Array(F);
    this.dbLow = new Float32Array(F); this.dbMid = new Float32Array(F); this.dbHigh = new Float32Array(F); this.dbAll = new Float32Array(F);
    this.flat = new Float32Array(F);
    this.odf = new Float32Array(F);
    this.topLine = new Float32Array(F);
    this.centroid = new Float32Array(F);
    this.hitFrames = new Float32Array(F);

    // Band signals for pitch tracking.
    let b = biquad(x, sr, 'lp', k.bassCutHz);
    b = biquad(b, sr, 'lp', k.bassCutHz);
    this.bassSr = sr / 8;
    this.bassSig = decimate(b, 8);

    this.bass = { pitch: new Float32Array(F), energy: this.dbLow, active: null, done: [], stem: 'bass', minFrames: Math.max(1, Math.round(k.bassMinNote / this.hopSec)) };
    this.lead = { pitch: new Float32Array(F), energy: this.dbMid, active: null, done: [], stem: 'other', minFrames: Math.max(1, Math.round(k.leadMinNote / this.hopSec)) };
  }

  get finished() { return this.framesDone >= this.frames && this.committedSec >= this.duration - 1e-6; }
  get analyzedSec() { return Math.min(this.duration, this.framesDone * this.hopSec); }

  private frameTime(f: number) { return (f * HOP + N / 2) / this.sr + Analyzer.ONSET_OFFSET; }
  private timeFrame(t: number) { return Math.round(((t - Analyzer.ONSET_OFFSET) * this.sr - N / 2) / HOP); }

  /** Process one chunk. Returns a delta to send (or null if nothing new was committed). */
  step(): ScoreDelta | null {
    if (this.startWall === 0) this.startWall = performance.now();
    const target = Math.min(this.frames, this.framesDone + Math.ceil(this.opts.chunkSec / this.hopSec));
    for (let f = this.framesDone; f < target; f++) this.computeFrame(f);
    this.framesDone = target;
    const final = this.framesDone >= this.frames;

    this.detectOnsets(final);
    this.trackPitch(this.bass, final);
    this.trackPitch(this.lead, final);
    this.trackBeats(final);
    this.buildBars(final);
    return this.commit(final);
  }

  // ---------------------------------------------------------------- frame features
  private computeFrame(f: number) {
    const { mags, curLog, prevLog } = this;
    this.fft.magnitudes(this.x, f * HOP, mags);
    const binHz = this.sr / N;
    const lowA = Math.max(1, Math.round(30 / binHz)), lowB = Math.round(160 / binHz);
    const midA = Math.round(200 / binHz), midB = Math.round(3000 / binHz);
    const highA = Math.round(5000 / binHz), highB = Math.min(N / 2, Math.round(12000 / binHz));
    let eL = 0, eM = 0, eH = 0, eA = 0, fL = 0, fM = 0, fH = 0;
    let logSum = 0, linSum = 0, flatCount = 0, cNum = 0, cDen = 0;
    const flatA = Math.round(400 / binHz), flatB = Math.min(N / 2, Math.round(9000 / binHz));
    const cA = Math.round(200 / binHz), cB = Math.min(N / 2, Math.round(8000 / binHz));
    for (let k = 0; k <= N / 2; k++) {
      const m = mags[k];
      const p = m * m;
      eA += p;
      const lg = Math.log(1 + 100 * m);
      curLog[k] = lg;
      const d = lg - prevLog[k];
      const pos = d > 0 ? d : 0;
      if (k >= lowA && k <= lowB) { eL += p; fL += pos; }
      if (k >= midA && k <= midB) { eM += p; fM += pos; }
      if (k >= highA && k <= highB) { eH += p; fH += pos; }
      if (k >= flatA && k <= flatB) { logSum += Math.log(p + 1e-12); linSum += p; flatCount++; }
      if (k >= cA && k <= cB) { cNum += k * p; cDen += p; }
    }
    this.centroid[f] = cDen > 1e-12 ? clamp(Math.log2(Math.max(1, (cNum / cDen) * binHz / 200)) / Math.log2(40), 0, 1) : 0;
    prevLog.set(curLog);
    const norm = 3 * (N / 4) * (N / 4);
    const db = (e: number) => 10 * Math.log10(e / norm + 1e-10);
    this.dbLow[f] = db(eL); this.dbMid[f] = db(eM); this.dbHigh[f] = db(eH); this.dbAll[f] = db(eA);
    this.fluxLow[f] = fL / (lowB - lowA + 1);
    this.fluxMid[f] = fM / (midB - midA + 1);
    this.fluxHigh[f] = fH / (highB - highA + 1);
    this.flat[f] = linSum > 1e-9 ? Math.exp(logSum / flatCount) / (linSum / flatCount) : 0;

    // Pitch (YIN) on band signals, gated by band energy.
    const center = (f * HOP + N / 2) / this.sr;
    if (this.dbLow[f] > -42) {
      const fr = yin(this.bassSig, Math.round(center * this.bassSr), 200, Math.floor(this.bassSr / 330), Math.ceil(this.bassSr / 35), this.bassSr, this.k.bassYin, this.yinScratch);
      this.bass.pitch[f] = fr > 0 ? hzToMidi(fr) : 0;
    }
    if (this.dbMid[f] > -45) {
      if ((f & 1) === 0) this.topLine[f] = this.topLineAt(f);
      else this.topLine[f] = this.topLine[f & ~1];
      this.lead.pitch[f] = this.topLine[f];
    }
  }

  // ---------------------------------------------------------------- onsets
  private detectOnsets(final: boolean) {
    const until = final ? this.framesDone : this.framesDone - 12;
    if (until <= this.onsetScanned) return;
    // Band scale: 95th percentile of flux so far (sampled).
    const s = this.pScratch;
    this.p95.low = Math.max(1e-4, percentile(this.fluxLow, 0, this.framesDone, 0.97, s));
    this.p95.mid = Math.max(1e-4, percentile(this.fluxMid, 0, this.framesDone, 0.97, s));
    this.p95.high = Math.max(1e-4, percentile(this.fluxHigh, 0, this.framesDone, 0.97, s));

    const lowRef = percentile(this.dbLow, 0, this.framesDone, 0.95, s);
    for (let f = this.onsetScanned; f < until; f++) {
      const lo = this.fluxLow, mi = this.fluxMid, hi = this.fluxHigh;
      const lowPeakDb = Math.max(this.dbLow[f], this.dbLow[f + 1] ?? -200, this.dbLow[f + 2] ?? -200);
      const K = this.k;
      const kick = this.isPeak(lo, f, K.kickFloor * this.p95.low) && lowPeakDb > lowRef - 15 && this.kickDecay(f);
      const midRise = (this.dbMid[f + 1] ?? -200) - (this.dbMid[f - 2] ?? -200);
      const snare = !kick && this.isPeak(mi, f, K.snareFloor * this.p95.mid) && this.flatAround(f) > K.snareNoise && hi[f] > 0.3 * this.p95.high && midRise > 2;
      const snareWithKick = kick && this.isPeak(mi, f, (K.snareFloor + 0.05) * this.p95.mid) && this.flatAround(f) > K.snareNoise + 0.1 && hi[f] > 0.5 * this.p95.high;
      const hat = !snare && !snareWithKick && this.isPeak(hi, f, K.hatFloor * this.p95.high, K.hatPeak) && mi[f] < 0.8 * this.p95.mid;
      const t = this.frameTime(f);
      let accent = 0;
      if (kick && f - this.lastOnsetFrame.kick > K.kickGap / this.hopSec) {
        const vel = clamp(lo[f] / this.p95.low, 0.05, 1);
        this.onsets.push({ frame: f, t, kind: 'kick', vel });
        this.lastOnsetFrame.kick = f;
        this.hitFrames[f] += vel;
        accent += 2 * vel;
      }
      if ((snare || snareWithKick) && f - this.lastOnsetFrame.snare > K.snareGap / this.hopSec) {
        const vel = clamp(mi[f] / this.p95.mid, 0.05, 1);
        this.onsets.push({ frame: f, t, kind: 'snare', vel });
        this.lastOnsetFrame.snare = f;
        this.hitFrames[f] += vel;
        accent += vel;
      }
      if (hat && f - this.lastOnsetFrame.hat > K.hatGap / this.hopSec) {
        this.onsets.push({ frame: f, t, kind: 'hat', vel: clamp(hi[f] / this.p95.high, 0.05, 1) });
        this.lastOnsetFrame.hat = f;
      }
      // Onset detection function for beat tracking: spectral flux plus a strong accent on
      // detected kicks and snares, so off-beat bass and hats don't pull the beat.
      this.odf[f] = 0.5 * (lo[f] / this.p95.low + 0.8 * mi[f] / this.p95.mid + 0.4 * hi[f] / this.p95.high) + accent;
    }
    this.onsetScanned = until;
  }

  private isPeak(a: Float32Array, f: number, floor: number, ratio = 1.5): boolean {
    const v = a[f];
    if (v < floor) return false;
    for (let k = f - 3; k <= f + 3; k++) {
      if (k === f || k < 0 || k >= this.framesDone) continue;
      if (a[k] > v || (a[k] === v && k < f)) return false;
    }
    let sum = 0, n = 0;
    for (let k = Math.max(0, f - 20); k < Math.min(this.framesDone, f + 6); k++) { sum += a[k]; n++; }
    return v > ratio * (sum / n);
  }

  private kickDecay(f: number): boolean {
    let peak = -200;
    for (let k = f; k <= f + 3 && k < this.framesDone; k++) peak = Math.max(peak, this.dbLow[k]);
    const later = this.dbLow[Math.min(this.framesDone - 1, f + 9)];
    return peak - later > this.k.kickDecayDb;
  }

  private flatAround(f: number) {
    let m = 0;
    for (let k = f; k <= f + 2 && k < this.framesDone; k++) m = Math.max(m, this.flat[k]);
    return m;
  }

  // ---------------------------------------------------------------- notes
  private trackPitch(tr: NoteTrack, final: boolean) {
    const until = final ? this.framesDone : this.framesDone - 12;
    const start = (tr as any)._scanned ?? 0;
    for (let f = start; f < until; f++) {
      // 3-tap median on pitch for stability.
      const a = tr.pitch[f - 1] ?? 0, b = tr.pitch[f], c = tr.pitch[f + 1] ?? 0;
      const p = med3(a, b, c);
      const db = tr.energy[f];
      const act = tr.active;
      if (act) {
        const cur = act.pitchSum / act.count;
        const changed = p > 0 && Math.abs(p - cur) > this.k.pitchBend && Math.abs((tr.pitch[f + 1] ?? 0) - cur) > this.k.pitchBend;
        if (p === 0) act.lowDbRun++; else act.lowDbRun = 0;
        // Re-articulation: energy dropped and came back up.
        const dipped = db < act.peakDb - 9;
        const tooLong = f - act.start > 4 / this.hopSec;
        if (changed || act.lowDbRun > 3 || dipped || tooLong) {
          this.endNote(tr, f - (act.lowDbRun > 3 ? act.lowDbRun : 0));
          if (p > 0 && !dipped) this.startNote(tr, f, p, db);
        } else if (p > 0) {
          if (act.count < 4) { act.pitchSum += p; act.count++; }
          if (act.all.length < 64) act.all.push(p);
          act.peakDb = Math.max(act.peakDb, db);
        }
      } else if (p > 0) {
        this.startNote(tr, f, p, db);
      }
    }
    (tr as any)._scanned = Math.max(start, until);
    if (final && tr.active) this.endNote(tr, this.framesDone - 1);
  }

  private startNote(tr: NoteTrack, f: number, p: number, db: number) {
    tr.active = { start: f, pitchSum: p, count: 1, peakDb: db, lowDbRun: 0, all: [p] };
  }

  private endNote(tr: NoteTrack, endFrame: number) {
    const a = tr.active!;
    tr.active = null;
    const frames = endFrame - a.start;
    if (frames < tr.minFrames) return;
    // Median over the settled part of the note (skip the attack, which still carries
    // whatever was sounding before).
    const settled = a.all.length > 4 ? a.all.slice(2) : a.all;
    const sorted = settled.slice().sort((x, y) => x - y);
    const pitch = Math.round(sorted[sorted.length >> 1]);
    // Pitch tracking settles a little after the attack; pull the start back.
    const t = this.frameTime(a.start) - 0.02;
    // Drop short bass blips that sit on a kick (the kick's pitch sweep).
    if (tr.stem === 'bass' && frames < 0.14 / this.hopSec && this.onsets.some(o => o.kind === 'kick' && t - o.t > -0.04 && t - o.t < 0.16)) return;
    tr.done.push({
      id: '', t, dur: frames * this.hopSec, stem: tr.stem, kind: 'note', pitch,
      vel: clamp((a.peakDb + 40) / 34, 0.05, 1),
    });
  }

  // ---------------------------------------------------------------- beats
  private trackBeats(final: boolean) {
    const until = this.onsetScanned;
    const fps = 1 / this.hopSec;
    if (until < 6 * fps && !final) return;
    // Tempo from autocorrelation of the most recent 20 s of ODF.
    const est = this.estimatePeriod(Math.max(0, until - Math.round(20 * fps)), until);
    if (est > 0) {
      if (this.periodFrames === 0) this.periodFrames = est;
      else if (Math.abs(est / this.periodFrames - 1) < 0.06) { this.periodFrames = 0.7 * this.periodFrames + 0.3 * est; this.tempoDisagree = 0; }
      else if (++this.tempoDisagree >= 2) { this.periodFrames = est; this.tempoDisagree = 0; }
    }
    const P = this.periodFrames;
    if (P <= 0) return;

    // Dynamic-programming beat tracker (Ellis 2007) over the not-yet-frozen stretch,
    // anchored on the last frozen beat so frozen beats never move.
    const anchor = this.beatsFrozen > 0 ? this.beatFrames[this.beatsFrozen - 1] : -1;
    const s0 = anchor >= 0 ? anchor : 0;
    const len = until - s0;
    if (len <= P) return;
    const C = new Float64Array(len);
    const back = new Int32Array(len).fill(-1);
    const alpha = this.k.beatTightness;
    for (let i = 0; i < len; i++) {
      const f = s0 + i;
      const local = this.odf[f];
      if (anchor >= 0 && i === 0) { C[0] = 1000; continue; }
      let best = -Infinity, arg = -1;
      const a = Math.max(0, Math.round(i - 2 * P)), b = Math.round(i - P / 2);
      for (let j = a; j <= b; j++) {
        if (anchor >= 0 && back[j] === -1 && j !== 0) continue; // must chain back to the anchor
        const r = Math.log((i - j) / P);
        const v = C[j] - alpha * r * r;
        if (v > best) { best = v; arg = j; }
      }
      if (arg >= 0) { C[i] = local + best; back[i] = arg; }
      else C[i] = anchor >= 0 ? -Infinity : local;
      if (anchor < 0 && arg < 0) back[i] = -2; // a free start
    }
    // Best end in the last period, then backtrace.
    let endI = -1, endV = -Infinity;
    for (let i = Math.max(0, len - Math.round(P)); i < len; i++) if (C[i] > endV) { endV = C[i]; endI = i; }
    if (endI < 0 || !isFinite(endV)) return;
    const path: number[] = [];
    for (let i = endI; i >= 0; i = back[i]) {
      path.push(s0 + i);
      if (back[i] < 0) break;
    }
    path.reverse();
    if (anchor >= 0 && path[0] === anchor) path.shift();
    this.beatFrames.length = this.beatsFrozen;
    this.beatStrength.length = this.beatsFrozen;
    if (anchor < 0) {
      // Extend backwards to the start of the track on the grid.
      let first = path[0];
      const pre: number[] = [];
      while (first - P >= 0) { first -= P; pre.unshift(Math.round(first)); }
      for (const f of pre) this.pushBeat(f);
    }
    for (const f of path) this.pushBeat(f);
    if (final) {
      let last = this.beatFrames[this.beatFrames.length - 1];
      while (last + P < this.frames) { last += P; this.pushBeat(Math.round(last)); }
    }

    const bpm = 60 / (P * this.hopSec);
    if (Math.abs(bpm - this.lastBpm) > 0.5) {
      const t = this.beatsFrozen > 0 ? this.frameTime(this.beatFrames[this.beatsFrozen - 1]) : 0;
      if (this.tempoOut.length === 0 || t > this.tempoOut[this.tempoOut.length - 1].t) {
        this.tempoOut.push({ t: this.tempoOut.length ? t : 0, bpm: Math.round(bpm * 100) / 100 });
        this.lastBpm = bpm;
      }
    }

  }

  /** Evidence that beat i is a downbeat: kick yes, snare no, harmony changes. */
  private downbeatEvidence(i: number): number {
    const cached = this.dbEvidence[i];
    if (cached !== undefined) return cached;
    const f = this.beatFrames[i];
    let kickHere = 0, snareHere = 0;
    for (const o of this.onsets) {
      if (Math.abs(o.frame - f) > 3) continue;
      if (o.kind === 'kick') kickHere = Math.max(kickHere, o.vel);
      if (o.kind === 'snare') snareHere = Math.max(snareHere, o.vel);
    }
    const prev = i > 0 ? this.beatFrames[i - 1] : f - this.periodFrames;
    const next = i + 1 < this.beatFrames.length ? this.beatFrames[i + 1] : f + this.periodFrames;
    // Arrangements change on the one: a big loudness step (the drums coming in or dropping out)
    // is a vote for a downbeat. Only judged where the beats around are settled.
    const step = i >= 4 && i + 4 < this.beatsFrozen ? Math.abs(this.levelStep(i)) : 0;
    const v = kickHere - 0.8 * snareHere + 3 * this.harmonicChange(prev, f) + this.bassChange(prev, f, next) + 0.1 * Math.max(0, step - 3);
    if (i + 4 < this.beatsFrozen) this.dbEvidence[i] = v;
    return v;
  }

  /** 1 when the bass pitch class differs between the beat before f and the beat at f. */
  private bassChange(prev: number, f: number, next: number): number {
    const pc = (a: number, b: number) => {
      const h = new Float32Array(12);
      for (let k = Math.round(a); k < Math.round(b); k++) { const p = this.bass.pitch[k]; if (p > 0) h[((Math.round(p) % 12) + 12) % 12]++; }
      let arg = -1, m = 2;
      for (let j = 0; j < 12; j++) if (h[j] > m) { m = h[j]; arg = j; }
      return arg;
    };
    const a = pc(prev, f), b = pc(f, next);
    return a >= 0 && b >= 0 && a !== b ? 1 : 0;
  }

  private bestPhase(from: number, to: number): { best: number; score: number[] } {
    const score = [0, 0, 0, 0];
    for (let i = Math.max(0, from); i < to; i++) score[i % 4] += this.downbeatEvidence(i);
    let best = 0;
    for (let i = 1; i < 4; i++) if (score[i] > score[best]) best = i;
    return { best, score };
  }

  /** Chroma distance between the beat before f and the beat starting at f.
   * Chords and bass lines tend to change on downbeats. */
  private harmonicChange(prevBeat: number, f: number) {
    const span = Math.max(4, f - prevBeat);
    const a = this.chromaAt(prevBeat + span / 2), b = this.chromaAt(f + span / 2);
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < 12; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na > 0 && nb > 0 ? 1 - d / Math.sqrt(na * nb) : 0;
  }

  /**
   * The melody's pitch as the top line of the mix: harmonic sums for every semitone in the melody band,
   * then the highest candidate that is nearly as strong as the strongest and whose own
   * fundamental really sounds (so neither the octave below nor the octave above wins).
   */
  private topLineAt(frame: number): number {
    const m = this.magsTop;
    // Centred a little before the frame: the long window otherwise hears each note ~35 ms early.
    this.fftBig.magnitudes(this.x, Math.round(frame * HOP + N / 2 - 3 * HOP) - 2048, m);
    const binHz = this.sr / 4096;
    const at = (hz: number) => { const k = Math.round(hz / binHz); return k + 1 < m.length ? Math.max(m[k - 1], m[k], m[k + 1]) : 0; };
    const lo = Math.max(40, Math.ceil(hzToMidi(this.k.leadLowHz))), hi = Math.min(100, Math.floor(hzToMidi(this.k.leadHighHz)));
    let peak = 0;
    for (let k = Math.round(this.k.leadLowHz * 0.9 / binHz); k < Math.round(this.k.leadHighHz * 1.2 / binHz); k++) if (m[k] > peak) peak = m[k];
    if (peak <= 1e-6) return 0;
    const sal = new Float32Array(hi + 1);
    let best = 0;
    for (let n = lo; n <= hi; n++) {
      const f0 = 440 * 2 ** ((n - 69) / 12);
      let sum = 0, w = 1;
      for (let h = 1; h <= 6; h++) { sum += w * at(f0 * h); w *= 0.85; }
      sal[n] = sum;
      if (sum > best) best = sum;
    }
    for (let n = hi; n >= lo; n--) {
      const f0 = 440 * 2 ** ((n - 69) / 12);
      if (sal[n] >= this.k.leadClarity * best && at(f0) >= this.k.leadPresence * peak) return this.refinePitch(n, binHz);
    }
    return 0;
  }

  /**
   * The exact pitch near semitone n, so slides glide instead of stepping: the strongest of the
   * first three harmonics, its peak bin refined by parabolic interpolation.
   */
  private refinePitch(n: number, binHz: number): number {
    const m = this.magsTop;
    let bestH = 1, bestK = 0, bestV = 0;
    for (let h = 1; h <= 3; h++) {
      const f = 440 * 2 ** ((n - 69) / 12) * h;
      const k0 = Math.floor((f * 0.966) / binHz), k1 = Math.ceil((f * 1.035) / binHz);
      for (let k = Math.max(1, k0); k <= k1 && k + 1 < m.length; k++) if (m[k] > bestV * (h > bestH ? 1.15 : 1) && m[k] >= m[k - 1] && m[k] >= m[k + 1]) { bestV = m[k]; bestK = k; bestH = h; }
    }
    if (!bestK) return n;
    const a = m[bestK - 1], b = m[bestK], c = m[bestK + 1];
    const den = a - 2 * b + c;
    const k = bestK + (Math.abs(den) > 1e-12 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0);
    const exact = hzToMidi((k * binHz) / bestH);
    return Math.abs(exact - n) < 0.6 ? exact : n;
  }

  private chromaAt(frame: number): Float32Array {
    const out = new Float32Array(12);
    const centerSample = Math.round(frame * HOP + N / 2);
    this.fftBig.magnitudes(this.x, centerSample - 2048, this.magsBig);
    const binHz = this.sr / 4096;
    for (let k = Math.round(55 / binHz); k < Math.round(2000 / binHz); k++) {
      const pc = ((Math.round(hzToMidi(k * binHz)) % 12) + 12) % 12;
      out[pc] += this.magsBig[k];
    }
    return out;
  }

  private localMax(f: number, r: number) {
    let m = 0;
    for (let k = f - r; k <= f + r; k++) { const v = this.odf[k] ?? 0; if (v > m) m = v; }
    return m;
  }

  private pushBeat(f: number) {
    this.beatFrames.push(f);
    this.beatStrength.push(clamp(this.localMax(f, 2) / 3, 0, 1));
  }

  private estimatePeriod(a: number, b: number): number {
    const fps = 1 / this.hopSec;
    const minL = Math.floor((60 / 180) * fps), maxL = Math.ceil((60 / 70) * fps);
    let mean = 0;
    for (let i = a; i < b; i++) mean += this.odf[i];
    mean /= Math.max(1, b - a);
    const ac = new Float64Array(maxL * 2 + 2);
    for (let L = minL; L <= Math.min(maxL * 2, b - a - 1); L++) {
      let s = 0;
      for (let i = a; i + L < b; i++) s += (this.odf[i] - mean) * (this.odf[i + L] - mean);
      ac[L] = s / (b - a - L);
    }
    let best = 0, bestV = -Infinity;
    for (let L = minL; L <= maxL; L++) {
      const bpm = 60 / (L * this.hopSec);
      const w = Math.exp(-0.5 * (Math.log2(bpm / this.k.tempoCentre) / this.k.tempoWidth) ** 2);
      // Reward periods whose double also correlates (metrical support).
      const v = (ac[L] + 0.5 * (ac[2 * L] ?? 0)) * w;
      if (v > bestV) { bestV = v; best = L; }
    }
    if (best <= minL || best >= maxL || bestV <= 0) return best > 0 && bestV > 0 ? best : 0;
    const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
    const den = y0 + y2 - 2 * y1;
    return Math.abs(den) > 1e-12 ? best + (0.5 * (y0 - y2)) / den : best;
  }

  // ---------------------------------------------------------------- bars, phrases, sections
  /** Index of the beat that starts bar n (1-based). */
  private barStartBeat(n: number) {
    const B = this.bars;
    if (n - 1 < B.length) return B[n - 1].sb;
    return B[B.length - 1].eb + 4 * (n - 1 - B.length);
  }

  private buildBars(final: boolean) {
    const onsetLimit = this.onsetScanned;
    const stableUntil = final ? Infinity : onsetLimit - 4 / this.hopSec;
    let stable = 0;
    while (stable < this.beatFrames.length && this.beatFrames[stable] < stableUntil) stable++;
    if (this.bars.length === 0 && stable < 20 && !final) return;
    while (true) {
      let sb: number;
      if (this.bars.length === 0) {
        sb = this.bestPhase(0, stable).best;
      } else {
        sb = this.bars[this.bars.length - 1].eb;
      }
      if (!final && sb + 8 >= stable) break;
      if (final && sb >= this.beatFrames.length - 1) break;
      // Bar length: 4, unless the downbeat evidence around here has consistently moved.
      let len = 4;
      if (this.bars.length > 0) {
        const { best, score } = this.bestPhase(sb - 8, Math.min(stable, sb + 8));
        const cur = sb % 4;
        if (best !== cur && score[best] > 1.25 * score[cur] + 0.2) this.phaseVotes++;
        else this.phaseVotes = 0;
        if (this.phaseVotes >= 2) {
          len = (((best - cur) % 4) + 4) % 4 || 4;
          this.phaseVotes = 0;
        }
      }
      const eb = sb + len;
      const fs = this.beatFrames[sb];
      const fe = eb < this.beatFrames.length ? this.beatFrames[eb] : this.frames;
      this.bars.push({ sb, eb });
      this.beatsFrozen = Math.max(this.beatsFrozen, Math.min(eb + 1, this.beatFrames.length));
      this.barFeatures.push(this.barFeature(sb, fs, fe));
    }
    // Sudden changes first, so a drop or a stop can open a section.
    this.findMoments(final);
    // Decide 4-bar blocks.
    this.decideBars(final);
  }

  private barFeature(sb: number, fs: number, fe: number) {
    const grid = new Float32Array(48);
    const beatAt = (i: number) => this.beatFrames[Math.min(i, this.beatFrames.length - 1)] ?? fe;
    const density = [0, 0, 0];
    for (const o of this.onsets) {
      if (o.frame < fs - 2 || o.frame >= fe - 2) continue;
      // Sixteenth step within bar.
      let step = 0;
      for (let b = 0; b < 4; b++) {
        const a = beatAt(sb + b), c = b < 3 ? beatAt(sb + b + 1) : fe;
        if (o.frame >= a - 2 && (o.frame < c - 2 || b === 3)) { step = b * 4 + clamp(Math.round(((o.frame - a) / Math.max(1, c - a)) * 4), 0, 3); break; }
      }
      const row = o.kind === 'kick' ? 0 : o.kind === 'snare' ? 1 : 2;
      grid[row * 16 + step] = Math.max(grid[row * 16 + step], o.vel);
      density[row] += 1 / 4;
    }
    // Chroma from one big FFT per beat.
    const chroma = new Float32Array(12);
    for (let b = 0; b < 4; b++) {
      const a = beatAt(sb + b), c = b < 3 ? beatAt(sb + b + 1) : fe;
      const centerSample = Math.round(((a + c) / 2) * HOP + N / 2);
      this.fftBig.magnitudes(this.x, centerSample - 2048, this.magsBig);
      const binHz = this.sr / 4096;
      for (let k = Math.round(110 / binHz); k < Math.round(2000 / binHz); k++) {
        const pc = ((Math.round(hzToMidi(k * binHz)) % 12) + 12) % 12;
        chroma[pc] += this.magsBig[k];
      }
    }
    const bassPc = new Float32Array(12);
    let voiced = 0;
    const db = [0, 0, 0];
    let midDb = 0;
    for (let f = fs; f < fe; f++) {
      const p = this.bass.pitch[f];
      if (p > 0) { bassPc[((Math.round(p) % 12) + 12) % 12]++; voiced++; }
      db[0] += this.dbLow[f]; db[1] += this.dbMid[f]; db[2] += this.dbHigh[f];
      midDb += this.dbAll[f];
    }
    const n = Math.max(1, fe - fs);
    return { grid, chroma, bassPc, db: db.map(v => v / n), density, bassVoiced: voiced / n, midDb: midDb / n, fs, fe } as any;
  }

  private activeStems(bars: any[]): Set<Stem> {
    const s = new Set<Stem>();
    const avg = (fn: (b: any) => number) => bars.reduce((a, b) => a + fn(b), 0) / bars.length;
    if (avg(b => b.density[0] + b.density[1]) > 0.3) s.add('drums');
    if (avg(b => b.bassVoiced) > 0.25 && avg(b => b.db[0]) > -40) s.add('bass');
    if (avg(b => b.db[1]) > -36) s.add('other');
    return s;
  }

  /** Novelty at bar b (1-based): how different bars b..b+3 are from bars b-4..b-1. */
  private noveltyAt(b: number): number {
    if (this.novelty[b] !== undefined) return this.novelty[b];
    const F = this.barFeatures as any[];
    const prev = F.slice(Math.max(0, b - 5), b - 1), next = F.slice(b - 1, b + 3);
    if (prev.length === 0 || next.length === 0) return 0;
    const dDb = Math.abs(avgOf(next, x => x.midDb) - avgOf(prev, x => x.midDb)) / 4;
    const pa = this.activeStems(prev), na = this.activeStems(next);
    let stem = 0;
    for (const s of ['drums', 'bass', 'other'] as Stem[]) if (pa.has(s) !== na.has(s)) stem += 1;
    const chroma = 1 - cosine(meanVec(next.map(x => x.chroma)), meanVec(prev.map(x => x.chroma)));
    const dens = (xs: any[], r: number) => avgOf(xs, x => x.density[r]);
    let dd = 0;
    for (let r = 0; r < 3; r++) dd += Math.abs(dens(next, r) - dens(prev, r));
    const v = dDb + stem + 3 * chroma + dd;
    if (next.length === 4 && prev.length === 4) this.novelty[b] = v;
    return v;
  }

  private decideBars(final: boolean) {
    const F = this.barFeatures as any[];
    // Bar b can be decided once bars up to b+4 exist (so novelty at b and b+1 are known).
    while (this.barsDecided < F.length && (final || this.barsDecided + 1 + 4 <= F.length)) {
      const b = this.barsDecided + 1;
      let boundary = b === 1;
      if (!boundary && b - this.lastSectionBar >= 4 && b > 4) {
        const n0 = this.noveltyAt(b);
        const n1 = b + 1 <= F.length ? this.noveltyAt(b + 1) : 0;
        const nm = this.noveltyAt(b - 1);
        // Sections last a while; only a drastic change (a drop, a breakdown) cuts one short.
        // And the bar is set by this song: busy, ever-changing music needs a bigger change to count.
        const seen = this.novelty.filter(x => x !== undefined).sort((x, y) => x - y);
        const typical = seen.length >= 8 ? seen[Math.floor(seen.length * 0.5)] * 1.25 : 0;
        const base = Math.max(this.k.sectionNovelty, typical);
        const need = b - this.lastSectionBar >= this.k.sectionMinBars ? base : base * 2.2;
        boundary = n0 > need && n0 >= n1 && n0 > nm;
        // A sudden change on this downbeat (a drop, a break, a stop, a build starting) opens a
        // section as soon as a phrase has passed, if the arrangement really changed with it: the
        // novelty peak can sit a bar late when the change runs into silence or another change.
        const m = this.momentAtBar(b);
        if (!boundary && m && m.size >= 0.3 && b - this.lastSectionBar >= 4 && n0 > 0.5 * base) boundary = true;
        // Songs move in 4-bar phrases: a change one bar short of the next phrase that is nearly as
        // strong a bar later waits for the phrase to start, unless something sudden happened here.
        else if (boundary && !m && (b - this.lastSectionBar) % 4 === 3 && n1 >= 0.8 * n0) { boundary = false; this.deferTo = b + 1; }
      }
      if (b === this.deferTo) boundary = true;
      // The silence after the music has ended is not a section of its own.
      if (boundary && b > 1 && avgOf(F.slice(b - 1, b + 1), x => x.midDb) < -55) boundary = false;
      if (boundary || b - this.phraseStart >= 4) {
        if (b > this.phraseStart) this.emitPhrase(this.phraseStart, b - 1);
        this.phraseStart = b;
      }
      if (boundary) this.emitSection(b);
      this.emitPads(b);
      this.barsDecided++;
    }
    if (final && this.barsDecided === F.length && this.phraseStart <= F.length) {
      this.emitPhrase(this.phraseStart, F.length);
      this.phraseStart = F.length + 1;
    }
    if (final && this.barsDecided === F.length && !this.sectionsFinal) { this.findOutro(); this.sectionsFinal = true; }
  }

  /**
   * Name the ending. Most songs close on an outro, and the fast labeller can't call one until it
   * has heard the end, so the last minute's sections wait for this. A fade (the same material
   * getting steadily quieter over the last bars) becomes an outro from where the fade starts; a
   * closing break with no fade becomes the outro. A song that stops dead keeps its last section.
   */
  private findOutro() {
    const F = this.barFeatures as any[], S = this.sectionsOut;
    if (F.length < 12 || S.length < 2) return;
    let L = F.length;
    while (L > 1 && F[L - 1].midDb < -55) L--; // the silence after the end
    const db = (b: number) => avgOf(F.slice(Math.max(0, b - 2), Math.min(L, b + 1)), x => x.midDb); // 3-bar smoothed, bar b 1-based
    // Walk back from the last bar while it keeps getting louder (allowing a little wobble).
    let k = L, peak = db(L);
    for (let b = L - 1; b >= Math.max(2, L - 32); b--) {
      const v = db(b);
      if (v < peak - 1.5) break;
      if (v > peak) { peak = v; k = b; }
    }
    const drop = db(k) - db(L), bars = L - k + 1;
    // Repetitive-ish: the fading bars carry the harmony of what came just before.
    const before = F.slice(Math.max(0, k - 9), k - 1), during = F.slice(k - 1, L);
    const same = before.length >= 4 && cosine(meanVec(during.map(x => x.chroma)), meanVec(before.map(x => x.chroma))) > 0.8;
    const last = S[S.length - 1];
    const open = S.length - 1 >= this.sentSections; // (one already sent can't be renamed)
    const songEnd = this.barTime(L) + 4 * 60 / Math.max(60, this.tempoOut[this.tempoOut.length - 1]?.bpm ?? 120);
    if (drop >= 9 && bars >= 4 && same) {
      // Start the outro on a phrase line from the last section, if one is close.
      const off = (k - last.bar) % 4;
      if (k - last.bar >= 4 && off !== 0) k += off <= 2 ? -off : 4 - off;
      if (k - last.bar < 4) { if (last.bar > 1 && open) last.label = 'outro'; }
      else {
        const next = F.slice(k - 1, k + 3);
        S.push({ t: round3(this.barTime(k)), label: 'outro', energy: Math.round(clamp((avgOf(next, x => x.midDb) + 34) / 26, 0, 1) * 100) / 100, bar: k, group: this.groups++ });
        this.sectionVecs.push(new Float32Array(0)); this.sectionStems.push(this.activeStems(next).size); this.sectionDrums.push(this.activeStems(next).has('drums'));
      }
      return;
    }
    // No fade: a closing breakdown is the outro only if it runs right to the end of the song (the
    // drums never come back in any 4 bars of it, and the music plays on to the last bar or so).
    if (!open || last.label !== 'breakdown' || last.bar <= 1 || this.duration - songEnd > 4) return;
    for (let b = last.bar; b <= L; b += 4) if (this.activeStems(F.slice(b - 1, Math.min(L, b + 3))).has('drums')) return;
    last.label = 'outro';
  }

  /** The biggest moment landing on bar b's downbeat (a build where it starts), if already decided. */
  private momentAtBar(b: number): Moment | undefined {
    let best: Moment | undefined;
    for (let i = this.momentsOut.length - 1; i >= 0; i--) {
      const m = this.momentsOut[i];
      if (m.bar === b && m.beat === 1 && (!best || m.size > best.size)) best = m;
    }
    return best;
  }

  /** A build starts at bar b. */
  private buildAt(b: number) { return this.momentsOut.some(m => m.kind === 'build' && m.bar === b); }

  private barTime(b: number) { return this.frameTime(this.beatFrames[this.barStartBeat(b)]); }

  private emitPhrase(first: number, last: number) {
    const bars = (this.barFeatures as any[]).slice(first - 1, last);
    const vec = new Float32Array(4 * 72);
    bars.forEach((b, i) => {
      const o = i * 72;
      writeNorm(vec, o, b.grid, 1.0);
      writeNorm(vec, o + 48, b.chroma, 0.8);
      writeNorm(vec, o + 60, b.bassPc, 0.6);
    });
    let repeatOf: number | null = null, id = this.phrasesOut.length, bestSim = 0;
    for (let i = 0; i < this.phraseVecs.length; i++) {
      if (this.phrasesOut[i].bars !== bars.length) continue;
      const s = cosine(vec, this.phraseVecs[i]);
      if (s > 0.9 && s > bestSim) { bestSim = s; repeatOf = i; id = this.phrasesOut[i].id; }
    }
    const active = this.activeStems(bars);
    const entering = [...active].filter(s => !this.prevBlockActive.has(s));
    this.prevBlockActive = active;
    this.phraseVecs.push(vec);
    this.phrasesOut.push({ t: round3(this.barTime(first)), bar: first, bars: bars.length, id, repeatOf, entering });
  }

  private emitSection(b: number) {
    const next = (this.barFeatures as any[]).slice(b - 1, b + 3);
    const energy = clamp((avgOf(next, x => x.midDb) + 34) / 26, 0, 1);
    const active = this.activeStems(next);
    const prevLabel = this.sectionsOut.length ? this.sectionsOut[this.sectionsOut.length - 1].label : null;
    const drums = active.has('drums');
    const remaining = this.duration - this.barTime(b);
    // Which earlier section is this one coming back? Sounding alike (harmony, bass line, groove,
    // who plays, how loud each band is) puts it in the same group, and a group keeps its label:
    // that is what makes a chorus a chorus.
    const vec = sectionVec(next, active);
    let group = -1, best = SECTION_SAME;
    this.sectionVecs.forEach((v, i) => { const c = cosine(vec, v); if (c >= best && this.sectionsOut[i].bar > 1) { best = c; group = this.sectionsOut[i].group ?? -1; } });
    const known = group >= 0 ? this.sectionsOut.find(x => x.group === group && (x.label === 'verse' || x.label === 'chorus')) : undefined;
    if (group < 0) group = this.groups++;
    let label: Section['label'];
    if (b === 1) label = 'intro';
    else if (!drums && remaining < 25 && this.framesDone >= this.frames) label = 'outro';
    else if (!drums && energy < 0.75) label = 'breakdown';
    else if (drums && (prevLabel === 'breakdown' || this.momentAtBar(b)?.kind === 'drop') && !this.buildAt(b)) label = 'drop';
    else if (known) label = known.label;
    else {
      // A new kind of section: a chorus if it is fuller or clearly louder than every groove so far.
      const grooves = this.sectionsOut.filter((x, i) => x.bar > 1 && this.sectionStems[i] > 0 && this.sectionDrums[i]);
      const stems = active.size;
      if (!drums) label = 'verse';
      else if (!grooves.length) label = energy > 0.72 && stems === 3 ? 'chorus' : 'verse';
      else {
        const maxE = Math.max(...grooves.map(x => x.energy));
        const maxS = Math.max(...grooves.map(x => this.sectionStems[this.sectionsOut.indexOf(x)]));
        label = energy >= maxE + 0.05 || (stems >= maxS && energy >= maxE - 0.03) ? 'chorus' : 'verse';
      }
    }
    this.sectionVecs.push(vec);
    this.sectionStems.push(active.size);
    this.sectionDrums.push(drums);
    this.sectionsOut.push({ t: round3(this.barTime(b)), label, energy: Math.round(energy * 100) / 100, bar: b, group });
    this.lastSectionBar = b;
  }

  /** Pads: one long note per bar where the harmony is clear. */
  private emitPads(b: number) {
    const f = (this.barFeatures as any[])[b - 1];
    const c = f.chroma as Float32Array;
    let max = 0, arg = 0, sum = 0;
    for (let j = 0; j < 12; j++) { sum += c[j]; if (c[j] > max) { max = c[j]; arg = j; } }
    const peaky = sum > 0 ? max / (sum / 12) : 0;
    if (peaky > this.k.padPeakiness && f.db[1] > -38) {
      const bt = this.frameTime(f.fs), et = this.frameTime(f.fe);
      this.padEvents.push({ id: '', t: bt, dur: Math.max(0.5, et - bt), stem: 'other', kind: 'note', pitch: 48 + arg, vel: clamp((f.db[1] + 40) / 30, 0.1, 1), bar: b, step: 0 });
    }
  }

  // ---------------------------------------------------------------- moments
  /**
   * Beat i's loudness (dB, power mean over the beat, floored at -60), its kick and snare hits, and
   * an "intensity" for builds (loudness, brightness and how busy the drums are). Settled beats only.
   */
  private beatLevel(i: number) {
    const c = this.beatLv[i];
    if (c) return c;
    const fa = this.beatFrames[i];
    const fb = i + 1 < this.beatFrames.length ? this.beatFrames[i + 1] : Math.min(this.frames, fa + Math.round(this.periodFrames));
    const n = Math.max(1, fb - fa);
    let p = 0, br = 0, h = 0;
    for (let f = fa; f < fa + n && f < this.frames; f++) { p += 10 ** (this.dbAll[f] / 10); br += this.centroid[f]; }
    // Hits are counted a little early: an onset is stamped a frame or two after the beat it is on.
    for (let f = Math.max(0, fa - 3); f < fb - 3; f++) h += this.hitFrames[f];
    const db = Math.max(-60, 10 * Math.log10(p / n + 1e-12));
    const v = { db, hits: h, x: db + 12 * (br / n) + 2 * Math.min(4, h) };
    if (i + 1 < this.beatsFrozen || this.framesDone >= this.frames) this.beatLv[i] = v;
    return v;
  }

  /** Mean of fn over beats a..b-1 (clipped to the beats that exist), NaN if none. */
  private beatMean(a: number, b: number, nB: number, fn: (v: { db: number; hits: number; x: number }) => number) {
    a = Math.max(0, a); b = Math.min(nB, b);
    if (b <= a) return NaN;
    let s = 0;
    for (let k = a; k < b; k++) s += fn(this.beatLevel(k));
    return s / (b - a);
  }

  /**
   * Loudness of beats a..b-1 in dB, averaged as power: a beat or two of silence ahead pulls a bar
   * down by a few dB, not by half the distance to the floor. NaN if no beats.
   */
  private beatDb(a: number, b: number, nB: number) {
    return Math.max(-60, 10 * Math.log10(this.beatMean(a, b, nB, v => 10 ** (v.db / 10)) + 1e-12));
  }

  /** Loudness of the bar after beat i minus the bar before it (dB). */
  private levelStep(i: number) {
    const nB = this.beatsFrozen;
    return this.beatDb(i, i + 4, nB) - this.beatDb(i - 4, i, nB);
  }

  private isDownbeat(i: number) { const b = this.beatsOut()[i]; return !!b && b.downbeat; }

  /**
   * Find sudden changes. Each settled beat gets an "up" and a "down" score: the loudness step across
   * it at three scales (half a bar, a bar, two bars) plus a bonus when the kicks and snares arrive or
   * vanish. Peaks above MOMENT_MIN become moments, snapped to the downbeat when one is close and
   * nearly as strong. Needs two bars of settled beats after a beat to judge it.
   */
  private findMoments(final: boolean) {
    const nB = final ? this.beatFrames.length : this.beatsFrozen;
    const scoreTo = final ? nB : nB - 9;
    for (; this.momentScored < scoreTo; this.momentScored++) this.scoreBeat(this.momentScored, nB);
    const finalTo = final ? this.momentScored : this.momentScored - 4;
    for (; this.momentFinal < finalTo; this.momentFinal++) {
      const j = this.momentFinal;
      if (this.isDownbeat(j)) this.buildStep(j);
      this.pickMoment(j, nB);
    }
    if (final && this.buildStart >= 0) this.closeBuild(this.bars.length + 1);
  }

  private scoreBeat(i: number, nB: number) {
    // Nothing changes in the first bar of sound, and the silence before it is not compared:
    // the song starting is not a lift.
    if (this.soundBeat < 0 && this.beatLevel(i).db > -45) this.soundBeat = i;
    const early = this.soundBeat < 0 || i < this.soundBeat + 4;
    const from = Math.max(0, this.soundBeat);
    const hits = (v: { hits: number }) => v.hits;
    const m = (a: number, b: number) => this.beatDb(Math.max(from, i + a), i + b, nB);
    const pre1 = m(-1, 0), post1 = m(0, 1), pre2 = m(-2, 0), post2 = m(0, 2), pre4 = m(-4, 0), post4 = m(0, 4);
    const hPre = this.beatMean(Math.max(from, i - 4), i, nB, hits), hPost = this.beatMean(i, i + 4, nB, hits);
    // The drums arriving or leaving: in proportion to how many hits come or go, so a stray
    // detection in a quiet intro counts for little.
    const drumsIn = !(hPre > 0.35 * hPost) ? clamp((hPost - (hPre || 0)) / 0.8, 0, 1) : 0;
    const drumsOut = !(hPost > 0.35 * hPre) ? clamp((hPre - (hPost || 0)) / 0.8, 0, 1) : 0;
    const best = (...xs: number[]) => xs.reduce((a, x) => (x > a ? x : a), 0);
    // Sudden means within a bar: a slow swell over two bars is a build, not a step. Half a bar
    // counts for a little less, and a single beat only going down (one quiet beat is a stop).
    const up = early ? 0 : best(post4 - pre4, 0.8 * (post2 - pre2)) + 4 * drumsIn;
    const down = early ? 0 : best(pre4 - post4, 0.8 * (pre2 - post2), 0.6 * (pre1 - post1)) + 4 * drumsOut;
    // The song's loud level so far (90th percentile of beats), so a stop is judged against it.
    const lv = this.beatLevel(i).db, S = this.beatDbSorted;
    let lo = 0, hi = S.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid] < lv) lo = mid + 1; else hi = mid; }
    S.splice(lo, 0, lv);
    const ref = S[Math.floor(S.length * 0.9)];
    this.beatScore[i] = { up, down, pre4: isNaN(pre4) ? lv : pre4, post1: isNaN(post1) ? lv : post1, drumsIn, drumsOut, ref };
  }

  private pickMoment(j: number, nB: number) {
    const S = this.beatScore;
    for (const dir of ['up', 'down'] as const) {
      const v = S[j][dir];
      if (v < MOMENT_MIN) continue;
      let peak = true;
      for (let k = j - 3; k <= j + 3 && peak; k++) if (k !== j && S[k] && (S[k][dir] > v || (S[k][dir] === v && k < j))) peak = false;
      if (!peak) continue;
      // Changes land on the one: move to a downbeat within two beats if it is nearly as strong.
      let at = j;
      if (!this.isDownbeat(j)) for (const d of [1, -1, 2, -2]) { const k = j + d; if (S[k] && this.isDownbeat(k) && S[k][dir] >= 0.7 * v) { at = k; break; } }
      if (at - (dir === 'up' ? this.lastUp : this.lastDown) < 6) continue;
      const s = S[at], size = clamp(v / 14, 0.15, 1);
      let kind: Moment['kind'], dur: number | undefined, slam = -1;
      if (dir === 'up') {
        // Coming back after a break or a stop, or the end of a build, is a drop; so is a big
        // slam with the drums arriving once they have been heard before. Anything else lifts.
        const atBar = this.beatsOut()[at]?.bar ?? 0;
        const afterDip = this.dipBeats.some(b => at > b && at - b <= 16);
        const afterBuild = this.buildStart >= 0 && atBar - this.buildStart >= 2 && this.buildClimb(atBar) >= BUILD_MIN;
        kind = afterDip || afterBuild || (s.drumsIn > 0.5 && v >= 10 && this.grooveSeen) ? 'drop' : 'lift';
        if (afterBuild) this.closeBuild(atBar);
        // A build can only start after the step up, never take it in.
        this.buildEnd = Math.max(this.buildEnd, atBar);
        this.lastUp = at;
      } else {
        // Nearly silent compared with the bar before (or with the song's loud level): a stop.
        if (s.post1 <= Math.max(s.ref - 30, s.pre4 - 18)) {
          kind = 'stop';
          let k = at;
          while (k < Math.min(nB, at + 16) && S[k] && this.beatLevel(k).db < s.pre4 - 12) k++;
          // Silence to the end is the song ending, not a stop.
          if (k >= nB && this.framesDone >= this.frames) { this.lastDown = at; continue; }
          // Where it comes back in is a drop (judged here: after a beat of silence, a bar either
          // side hardly differs, so the up score cannot see it).
          if (k < nB && S[k] && this.beatLevel(k).db >= s.pre4 - 6 && k - this.lastUp >= 6) slam = k;
          dur = round3(this.frameTime(this.beatFrames[Math.min(k, this.beatFrames.length - 1)]) - this.frameTime(this.beatFrames[at]));
        } else kind = 'break';
        this.lastDown = at;
        this.dipBeats.push(at);
        this.grooveSeen = true;
      }
      this.pushMoment(at, kind, size, dur);
      if (slam >= 0) {
        this.pushMoment(slam, 'drop', size, undefined);
        this.lastUp = slam;
        this.buildEnd = Math.max(this.buildEnd, this.beatsOut()[slam]?.bar ?? 0);
      }
    }
  }

  private pushMoment(at: number, kind: Moment['kind'], size: number, dur?: number) {
    const b = this.beatsOut()[at];
    const m: Moment = { t: round3(this.frameTime(this.beatFrames[at])), kind, size: Math.round(size * 100) / 100, bar: b?.bar ?? 0, beat: b?.beat ?? 1 };
    if (dur !== undefined && dur > 0) m.dur = dur;
    this.momentsOut.push(m);
  }

  /** Intensity of bar b (mean over its beats). */
  private barX(b: number) {
    const sb = this.barStartBeat(b);
    return this.beatMean(sb, sb + 4, this.beatFrames.length, v => v.x);
  }

  /** How much the open build has climbed by the bar before `bar`. */
  private buildClimb(bar: number) { return this.buildStart >= 0 && bar - 1 > this.buildStart ? this.barX(bar - 1) - this.barX(this.buildStart) : 0; }

  /**
   * Builds, a bar at a time as each downbeat j is reached: a run of bars each more intense than the
   * last (louder, brighter, busier drums). The run closes when it stops climbing or a drop lands,
   * and becomes a build if it climbed far enough over two bars or more.
   */
  private buildStep(j: number) {
    // j starts the bar after bar b, which has just been heard in full.
    let b = 0;
    while (b < this.bars.length && this.bars[b].sb < j) b++;
    if (b < 2 || b < this.buildBar || b <= this.buildEnd) return;
    this.buildBar = b + 1;
    const rising = this.barX(b) >= this.barX(b - 1) + 0.3;
    if (rising) {
      if (this.buildStart < 0) this.buildStart = Math.max(this.buildEnd, b - 1);
      // A build is a run-up of a few bars, not a slow swell over minutes.
      if (b - this.buildStart > 8) this.buildStart = b - 8;
    } else if (this.buildStart >= 0) this.closeBuild(b);
  }

  /** Close the open run at the start of bar `end`, emitting a build if it climbed enough. */
  private closeBuild(end: number) {
    const start = this.buildStart;
    this.buildStart = -1;
    this.buildEnd = end;
    // At least two rising bars, climbing far enough, and not all in one jump (that is a lift).
    if (start < 1 || end - start < 3) return;
    const climb = this.barX(end - 1) - this.barX(start);
    let jump = 0;
    for (let k = start + 1; k < end; k++) jump = Math.max(jump, this.barX(k) - this.barX(k - 1));
    if (!(climb >= BUILD_MIN) || jump > 0.6 * climb) return;
    const sb = this.barStartBeat(start), eb = Math.min(this.barStartBeat(end), this.beatFrames.length - 1);
    if (sb >= this.beatFrames.length) return;
    const dur = round3(this.frameTime(this.beatFrames[eb]) - this.frameTime(this.beatFrames[sb]));
    this.pushMoment(sb, 'build', clamp(climb / 14, 0.15, 1), dur);
  }

  // ---------------------------------------------------------------- commit
  private commit(final: boolean): ScoreDelta | null {
    // Frontier: end of the last decided 4-bar block (bars + phrases + sections all known),
    // but never past the start of a note that is still sounding.
    let frontier: number;
    if (final) frontier = this.duration;
    else {
      // Everything before the open phrase is final.
      if (this.phraseStart <= 1) return null;
      const endBeat = this.barStartBeat(this.phraseStart);
      if (endBeat >= this.beatFrames.length) return null;
      frontier = this.frameTime(this.beatFrames[endBeat]);
      for (const tr of [this.bass, this.lead]) if (tr.active) frontier = Math.min(frontier, this.frameTime(tr.active.start) - 0.01);
      frontier = Math.min(frontier, this.frameTime(this.onsetScanned) - 0.05);
      // Moments are decided a few beats behind the beats (and may snap back two), and a build is
      // only known once it ends, so hold the frontier before both.
      const undecided = this.momentFinal - 2;
      if (undecided < this.beatFrames.length) frontier = Math.min(frontier, this.frameTime(this.beatFrames[Math.max(0, undecided)]) - 0.01);
      if (this.buildStart >= 0) frontier = Math.min(frontier, this.frameTime(this.beatFrames[Math.min(this.beatFrames.length - 1, this.barStartBeat(this.buildStart))]) - 0.01);
    }
    if (frontier <= this.committedSec && !final) return null;

    const events: ScoreEvent[] = [];
    const take = (e: ScoreEvent) => {
      if (e.t < this.committedSec || e.t >= frontier) return false;
      events.push(e);
      return true;
    };
    for (const o of this.onsets) {
      // A soft "kick" off the eighth-note grid is usually a bass synth note, not a drum.
      if (o.kind === 'kick' && this.k.kickGrid > 0 && o.vel < this.k.kickGrid && this.offGrid(o.t, 2) > 0.05) continue;
      take({ id: '', t: o.t, dur: o.kind === 'kick' ? 0.12 : o.kind === 'snare' ? 0.1 : 0.04, stem: 'drums', kind: o.kind, pitch: null, vel: round3(o.vel) });
    }
    for (const tr of [this.bass, this.lead]) {
      tr.done = tr.done.filter(e => !take(e) && e.t >= this.committedSec);
    }
    this.padEvents = this.padEvents.filter(e => !take(e) && e.t >= this.committedSec);
    this.onsets = this.onsets.filter(o => o.t >= frontier || o.frame > this.onsetScanned - 600);
    events.sort((a, b) => a.t - b.t);
    for (const e of events) {
      e.id = 'e' + this.eventId++;
      e.t = round3(e.t); e.dur = round3(e.dur);
      if (e.bar === undefined) { const g = this.gridPos(e.t); e.bar = g.bar; e.step = g.step; }
    }

    // Beats.
    const beats: Beat[] = [];
    const allBeats = this.beatsOut();
    for (; this.sentBeats < allBeats.length && allBeats[this.sentBeats].t < frontier; this.sentBeats++) beats.push(allBeats[this.sentBeats]);
    const hold = this.sectionsFinal ? Infinity : this.duration - 60;
    let nSec = this.sentSections;
    while (nSec < this.sectionsOut.length && this.sectionsOut[nSec].t < Math.min(frontier, hold)) nSec++;
    const sections = this.sectionsOut.slice(this.sentSections, nSec);
    this.sentSections += sections.length;
    const phrases = this.phrasesOut.slice(this.sentPhrases).filter(p => p.t < frontier);
    this.sentPhrases += phrases.length;
    const tempo = this.tempoOut.slice(this.sentTempo);
    this.sentTempo = this.tempoOut.length;
    // A build is found after the moments inside it, so put the unsent ones in time order first.
    const unsent = this.momentsOut.slice(this.sentMoments).sort((a, b) => a.t - b.t);
    this.momentsOut.splice(this.sentMoments, unsent.length, ...unsent);
    const moments = unsent.filter(m => m.t < frontier);
    this.sentMoments += moments.length;
    // Per-bar features, rounded (they are compared, not played).
    const bars: BarFeature[] = [];
    for (; this.sentBars < this.barFeatures.length; this.sentBars++) {
      const t = this.barTime(this.sentBars + 1);
      if (t >= frontier) break;
      const f = this.barFeatures[this.sentBars], top = (v: Float32Array) => { const m = Math.max(1e-9, ...v); return [...v].map(x => Math.round((x / m) * 100) / 100); };
      bars.push({ t: round3(t), bar: this.sentBars + 1, grid: [...f.grid].map(x => Math.round(x * 100) / 100), chroma: top(f.chroma), bass: top(f.bassPc), db: f.db.map(x => Math.round(x * 10) / 10), density: f.density.map(x => Math.round(x * 100) / 100) });
    }

    // Envelopes at 50 Hz.
    const envTo = Math.floor(frontier * ENV_RATE);
    const env: ScoreDelta['envelopes'] = { mix: [], bass: [], other: [], drums: [], contour: [], bright: [], rise: [], leadPitch: [], bassPitch: [] };
    for (let i = this.sentEnv; i < envTo; i++) {
      const f = clamp(this.timeFrame(i / ENV_RATE), 0, this.frames - 1);
      const mix = clamp((this.dbAll[f] + 50) / 50, 0, 1);
      env.mix!.push(round3(mix));
      env.bass!.push(round3(clamp((this.dbLow[f] + 50) / 50, 0, 1)));
      env.other!.push(round3(clamp((this.dbMid[f] + 50) / 50, 0, 1)));
      this.curves(f, mix);
      env.contour!.push(round3(this.contourVal));
      env.bright!.push(round3(this.brightVal));
      env.rise!.push(round3(this.riseVal));
      env.leadPitch!.push(this.glide(this.lead.pitch, f));
      env.bassPitch!.push(this.glide(this.bass.pitch, f));
    }
    // Drum envelope: decaying hits.
    const drumHits = events.filter(e => e.stem === 'drums');
    let hi = 0;
    for (let i = this.sentEnv; i < envTo; i++) {
      const tt = i / ENV_RATE;
      this.drumEnv *= 0.82;
      while (hi < drumHits.length && drumHits[hi].t <= tt) { this.drumEnv = Math.max(this.drumEnv, drumHits[hi].vel); hi++; }
      env.drums!.push(round3(this.drumEnv));
    }
    this.sentEnv = Math.max(this.sentEnv, envTo);

    this.committedSec = frontier;
    const wall = (performance.now() - this.startWall) / 1000;
    return {
      frontierSec: round3(frontier), final, tempo, beats, sections, phrases, moments, bars, events,
      envelopes: env, envelopeRate: ENV_RATE,
      realtimeFactor: Math.round((this.analyzedSec / Math.max(1e-3, wall)) * 10) / 10,
    };
  }

  /**
   * Advance the continuous curves by one envelope sample (1/50 s), in order:
   * - contour: the melody's pitch as the top line of the mix (see topLineAt), median-filtered,
   *   gliding rather than stepping, sinking back between phrases;
   * - bright: the spectral centroid, smoothed;
   * - rise: build-ups, where loudness and brightness have been climbing for a few seconds.
   */
  private curves(f: number, mix: number) {
    const raw = this.topLine[f];
    const h = this.contourHist;
    if (raw > 0) {
      h.push(raw); if (h.length > 5) h.shift();
      const m = [...h].sort((a, b) => a - b)[h.length >> 1];
      const target = clamp((m - 48) / 36, 0, 1);
      this.contourVal += (target - this.contourVal) * 0.25;
    } else {
      // No melody: sink slowly, so the skyline falls back between phrases.
      this.contourVal += (0.12 - this.contourVal) * 0.01;
      if (h.length) h.shift();
    }
    this.brightVal += (this.centroid[f] - this.brightVal) * 0.08;
    const x = 0.6 * mix + 0.4 * this.brightVal;
    if (!this.curveInit) { this.emaFast = this.emaSlow = x; this.curveInit = true; }
    this.emaFast += (x - this.emaFast) * (1 / (ENV_RATE * 1.5));
    this.emaSlow += (x - this.emaSlow) * (1 / (ENV_RATE * 7));
    const trend = clamp((this.emaFast - this.emaSlow) * 9, 0, 1);
    // Builds swell slowly and let go quickly.
    this.riseVal += (trend - this.riseVal) * (trend > this.riseVal ? 0.04 : 0.12);
  }

  /** A pitch track at frame f as MIDI to 0.05 semitones (median of 5 frames, 0 = silent). */
  private glide(p: Float32Array, f: number): number {
    const v: number[] = [];
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < this.frames && p[k] > 0) v.push(p[k]);
    if (v.length < 3) return 0;
    v.sort((a, b) => a - b);
    return Math.round(v[v.length >> 1] * 20) / 20;
  }

  private _beatsCache: Beat[] = [];
  private beatsOut(): Beat[] {
    const out = this._beatsCache;
    const B = this.bars;
    if (B.length === 0) return out;
    const limit = this.finished || this.framesDone >= this.frames ? this.beatFrames.length : B[B.length - 1].eb;
    let bi = 0;
    for (let i = out.length; i < Math.min(limit, this.beatFrames.length); i++) {
      let bar: number, beat: number;
      if (i < B[0].sb) { bar = 0; beat = Math.max(1, 4 - (B[0].sb - i) + 1); }
      else {
        while (bi < B.length - 1 && B[bi + 1].sb <= i) bi++;
        if (i >= B[bi].eb) { bar = B.length + 1 + Math.floor((i - B[B.length - 1].eb) / 4); beat = ((i - B[B.length - 1].eb) % 4) + 1; }
        else { bar = bi + 1; beat = i - B[bi].sb + 1; }
      }
      out.push({ t: round3(this.frameTime(this.beatFrames[i])), bar, beat, downbeat: beat === 1, strength: round3(this.beatStrength[i]) });
    }
    return out;
  }

  /** Seconds from t to the nearest 1/n of a beat. */
  private offGrid(t: number, n: number): number {
    const beats = this.beatsOut();
    if (beats.length < 2) return 0;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (beats[m].t <= t) lo = m; else hi = m; }
    const a = beats[lo].t, p = (beats[lo + 1]?.t ?? a + 0.5) - a;
    const x = ((t - a) / p) * n;
    return Math.abs(x - Math.round(x)) * p / n;
  }

  private gridPos(t: number): { bar: number; step: number } {
    const beats = this.beatsOut();
    if (beats.length < 2) return { bar: 0, step: 0 };
    let lo = 0, hi = beats.length - 1;
    if (t < beats[0].t) return { bar: beats[0].bar, step: 0 };
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (beats[m].t <= t) lo = m; else hi = m; }
    const b = beats[lo];
    const next = beats[lo + 1]?.t ?? b.t + 0.5;
    const sub = clamp(Math.round(((t - b.t) / (next - b.t)) * 4), 0, 4);
    let step = (b.beat - 1) * 4 + sub;
    let bar = b.bar;
    if (step >= 16) { step -= 16; bar++; }
    return { bar, step };
  }
}

function med3(a: number, b: number, c: number) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}
function round3(v: number) { return Math.round(v * 1000) / 1000; }
function writeNorm(dst: Float32Array, o: number, src: Float32Array, w: number) {
  let n = 0;
  for (let i = 0; i < src.length; i++) n += src[i] * src[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < src.length; i++) dst[o + i] = (src[i] / n) * w;
}
function cosine(a: Float32Array, b: Float32Array) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : (na === 0 && nb === 0 ? 1 : 0);
}
function meanVec(vs: Float32Array[]) {
  const out = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i] / vs.length;
  return out;
}
function avgOf<T>(xs: T[], f: (x: T) => number) { return xs.reduce((a, x) => a + f(x), 0) / Math.max(1, xs.length); }

interface MomentScore { up: number; down: number; pre4: number; post1: number; drumsIn: number; drumsOut: number; ref: number }
/** Score (about dB) a beat needs to be a moment: a bar 5 dB louder or quieter, or the drums arriving or leaving with a step. */
const MOMENT_MIN = 5;
/** How far (intensity units, about dB) a run of rising bars must climb to count as a build. */
const BUILD_MIN = 5;

/** How alike two sections must sound (cosine of sectionVec) to count as the same part coming back. */
const SECTION_SAME = 0.925;

/**
 * What a section sounds like, for spotting it when it comes back. Harmony is weighted down: many
 * dance tracks loop one chord sequence all the way through, and it is the arrangement (the groove,
 * who plays, how loud each band is) that tells a verse from a chorus.
 */
function sectionVec(bars: any[], active: Set<Stem>): Float32Array {
  const v = new Float32Array(12 + 12 + 48 + 3 + 3 + 3);
  writeNorm(v, 0, meanVec(bars.map(x => x.chroma)), 0.3);
  writeNorm(v, 12, meanVec(bars.map(x => x.bassPc)), 0.3);
  writeNorm(v, 24, meanVec(bars.map(x => x.grid)), 1.0);
  (['drums', 'bass', 'other'] as Stem[]).forEach((st, i) => {
    v[72 + i] = active.has(st) ? 1 : 0;
    v[75 + i] = Math.min(3, avgOf(bars, x => x.density[i])) / 3 * 0.6;
    v[78 + i] = (avgOf(bars, x => x.db[i]) + 60) / 40;
  });
  return v;
}
