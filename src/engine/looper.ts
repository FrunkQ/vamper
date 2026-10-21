// The Looper: the one class an app needs. Load a song (decoded, analysed in a worker, score
// cached), mark cues, then orchestrate in play: next(), prev(), goTo(i). Each change lands at the
// next quantise point (a bar by default) with a click-free join. No framework, no DOM beyond Web
// Audio, a Worker and IndexedDB, so it can be dropped into other apps (see docs/ENGINE.md).
import { Cutter } from './cuts';
import { Deck, type JoinLog } from './deck';
import { barIndexAt, sectionNames, type Quantise } from './plan';
import { applyDelta, emptyScore, type Score, type ScoreDelta } from '../score/types';
import { hashFile, loadScore, saveScore } from '../score/cache';
import { readTags } from '../audio/tags';

/**
 * A passage the music can sit in: `loop` repeats from..to until the next change; `once` plays
 * from `from` and carries on through the song. Times are downbeats (seconds).
 */
export interface Cue { name: string; from: number; to: number; mode: 'loop' | 'once' }

export interface LoadProgress { stage: 'decode' | 'analyse' | 'done'; done: number; etaSec: number | null; cached: boolean }

export interface LooperState {
  playing: boolean;
  /** Song time being heard (seconds), and the 1-based bar there (0 before the first). */
  position: number;
  bar: number;
  /** The cue being played or about to be (index into cues), or -1. */
  cue: number;
  /** A change waiting to land: song time it lands at, seconds until then, and what it is. */
  pending: { at: number; inSec: number; label: string } | null;
  loop: [number, number] | null;
  joins: JoinLog[];
}

export class Looper {
  readonly deck = new Deck();
  buffer: AudioBuffer | null = null;
  /** The full-rate mono mix (for drawing and for cut refinement). */
  mono: Float32Array | null = null;
  score: Score | null = null;
  cues: Cue[] = [];
  private cueIndex = -1;
  private worker: Worker | null = null;
  /** Called whenever the score grows or the playback state changes. */
  onChange: (() => void) | null = null;

  constructor() { this.deck.onChange = () => this.onChange?.(); }

  get quantise() { return this.deck.quantise; }
  set quantise(q: Quantise) { this.deck.quantise = q; }

  /** Decode and analyse a song file. Resolves when the score is final; the score grows (and onChange fires) as it goes. */
  async load(file: File, onProgress?: (p: LoadProgress) => void): Promise<Score> {
    this.worker?.terminate();
    this.deck.stop();
    onProgress?.({ stage: 'decode', done: 0, etaSec: null, cached: false });
    const data = await file.arrayBuffer();
    const tags = readTags(data, file.name);
    const hash = await hashFile(data);
    const buffer = await this.deck.ctx.decodeAudioData(data.slice(0));
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels; }
    this.buffer = buffer; this.mono = mono; this.cues = []; this.cueIndex = -1;
    const track = { title: tags.title || file.name.replace(/\.[^.]+$/, ''), artist: tags.artist, album: tags.album, year: tags.year || undefined, durationSec: buffer.duration, art: null, hash };
    const cached = await loadScore(hash);
    if (cached?.final) {
      this.setScore(cached);
      onProgress?.({ stage: 'done', done: 1, etaSec: 0, cached: true });
      return cached;
    }
    const score = emptyScore(track, buffer.duration);
    this.setScore(score);
    return new Promise(resolve => {
      const w = this.worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type === 'progress') {
          const rate = m.analyzedSec / Math.max(1e-3, m.wallSec);
          onProgress?.({ stage: 'analyse', done: m.analyzedSec / buffer.duration, etaSec: m.analyzedSec > 2 ? (buffer.duration - m.analyzedSec) / rate : null, cached: false });
        } else if (m.type === 'delta') {
          applyDelta(score, m.delta as ScoreDelta);
          this.onChange?.();
          if (score.final) {
            w.terminate(); this.worker = null;
            void saveScore(score);
            onProgress?.({ stage: 'done', done: 1, etaSec: 0, cached: false });
            resolve(score);
          }
        }
      };
      const pcm = mono.slice();
      w.postMessage({ type: 'start', pcm, sampleRate: buffer.sampleRate }, [pcm.buffer]);
    });
  }

  private setScore(score: Score) {
    this.score = score;
    this.deck.load(this.buffer!, new Cutter(this.mono!, this.buffer!.sampleRate), score);
    this.onChange?.();
  }

  /** Cues to step through: the ones marked, or, until any are, every section as a loop. */
  get playlist(): Cue[] {
    if (this.cues.length || !this.score) return this.cues;
    const S = this.score.sections, names = sectionNames(this.score);
    const end = this.score.final ? this.score.track.durationSec : this.score.frontierSec;
    return S.map((s, i) => ({ name: names[i], from: s.t, to: S[i + 1]?.t ?? lastBar(this.score!, end), mode: 'loop' as const }));
  }

  /** Change to cue i at the next quantise point (or start it, when stopped). */
  goTo(i: number) {
    const cue = this.playlist[i];
    if (!cue) return;
    this.cueIndex = i;
    if (cue.mode === 'loop') this.deck.setLoop(cue.from, cue.to, cue.name);
    else this.deck.change(cue.from, null, cue.name);
  }

  next() { this.goTo(Math.min(this.playlist.length - 1, this.currentCue() + 1)); }
  prev() { this.goTo(Math.max(0, this.currentCue() - 1)); }

  play(from = 0) { this.cueIndex = -1; this.deck.play(from); }
  stop() { this.deck.stop(); }
  /** Loop an arbitrary passage (downbeat times), e.g. a selection. */
  loop(from: number, to: number) { this.cueIndex = -1; this.deck.setLoop(from, to, 'selection'); }
  release() { this.deck.release(); }

  /** The cue in play: the one last chosen while it is still targeted or playing, else the cue under the playhead. */
  currentCue(): number {
    const list = this.playlist, p = this.deck.position, d = this.deck;
    if (this.cueIndex >= 0 && d.playing) {
      const c = list[this.cueIndex];
      if (c && (d.pending || (p >= c.from - 0.05 && (c.mode === 'once' || p < c.to + 0.05)))) return this.cueIndex;
    }
    for (let i = list.length - 1; i >= 0; i--) if (p >= list[i].from - 0.05) return i;
    return -1;
  }

  state(): LooperState {
    const d = this.deck, p = d.position;
    return {
      playing: d.playing, position: p, bar: this.score ? barIndexAt(this.score, p) + 1 : 0, cue: this.currentCue(),
      pending: d.pending ? { at: d.pending.at, inSec: Math.max(0, d.pending.when - d.ctx.currentTime), label: d.pending.label } : null,
      loop: d.loop, joins: d.joins,
    };
  }
}

/** The last downbeat before `end` (so a final section's loop is whole bars). */
function lastBar(score: Score, end: number): number {
  let t = end;
  for (const b of score.beats) if (b.downbeat && b.t < end - 0.5) t = b.t;
  return t;
}
