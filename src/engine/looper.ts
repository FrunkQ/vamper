// The Looper: the one class an app needs. Load a song (decoded, analysed in a worker, score
// cached), mark cues, then orchestrate in play: next(), prev(), goTo(i). Each change lands at the
// next quantise point (a bar by default) with a click-free join. No framework, no DOM beyond Web
// Audio, a Worker and IndexedDB, so it can be dropped into other apps (see docs/ENGINE.md).
// Optionally (options.voice) it then listens for singing and talking, so changes avoid cutting a
// vocal line in half; the song plays while it listens. A `riff` cue plays its bars in a varied
// order instead of looping them (see riff.ts). With `autoHold` on, a song played from the top
// waits at each loop or riff cue it reaches until next() or release(); holds() finds those cues
// from the score (see holds.ts). It can hold several songs at once (`add`, `songs`, `select`), each
// decoded and analysed, so a session can jump between them.
import { Analyzer } from '../analysis/analyzer';
import { Cutter } from './cuts';
import { Deck, type JoinLog } from './deck';
import { barIndexAt, barStarts, lastBar, sectionNames, type Quantise } from './plan';
import { seedOf, type Riff, type RiffOptions } from './riff';
import { findHolds, type Hold } from './holds';
import { applyDelta, emptyScore, type Score, type ScoreDelta } from '../score/types';
import { hashFile, loadScore, saveScore } from '../score/cache';
import { readTags } from '../audio/tags';
import { VoicePass, type VoiceModel, type VoiceProgress } from '../analysis/voice';

export interface LooperOptions {
  /**
   * Where the voice model is served (voiceModel(folderUrl) builds this), to run the voice pass
   * after the analysis. Off when left out: the host app must serve the model files (about 11 MB,
   * see docs/ENGINE.md).
   */
  voice?: VoiceModel;
}

/**
 * A passage the music can sit in: `loop` repeats from..to until the next change; `riff` stays in
 * from..to too, but plays its bars in a varied order, like a band vamping (the same `seed` gives
 * the same riff; left out, it comes from the song and the cue's start); `once` plays from `from`
 * and carries on through the song. Times are downbeats (seconds). With `autoHold` on, playing on
 * into a loop or riff cue holds there unless the cue says `hold: false`.
 */
export interface Cue { name: string; from: number; to: number; mode: 'loop' | 'once' | 'riff'; seed?: number; hold?: boolean }

export interface LoadProgress { stage: 'decode' | 'analyse' | 'done'; done: number; etaSec: number | null; cached: boolean }

/** A song held in memory, decoded and (being) analysed, with its own cues; `select` makes it the one played. */
export interface Song {
  /** The file's name, and the title from its tags (or the file name without its extension). */
  name: string;
  title: string;
  hash: string;
  buffer: AudioBuffer;
  /** The full-rate mono mix (for drawing and for cut refinement). */
  mono: Float32Array;
  score: Score;
  cues: Cue[];
  /** Memory it takes, in bytes (the decoded channels plus the mono mix). */
  bytes: number;
}

export interface LooperState {
  playing: boolean;
  /** Song time being heard (seconds), and the 1-based bar there (0 before the first). */
  position: number;
  bar: number;
  /** The cue being played or about to be (index into cues), or -1. */
  cue: number;
  /** A change waiting to land: song time it lands at, seconds until then, and what it is. */
  pending: { at: number; inSec: number; label: string; forVoice: boolean } | null;
  loop: [number, number] | null;
  /** While riffing: the song bars (1-based) chosen so far, latest last, and how many jumps the passage has. */
  riff?: { path: number[]; jumps: number };
  joins: JoinLog[];
}

export class Looper {
  readonly deck = new Deck();
  /** The songs held in memory, in the order added; `song` is the one in the deck. */
  readonly songs: Song[] = [];
  song: Song | null = null;
  /** The current song's audio and score (null until one is selected). */
  buffer: AudioBuffer | null = null;
  mono: Float32Array | null = null;
  score: Score | null = null;
  private noSongCues: Cue[] = [];
  /** The current song's cues (kept with the song, so they come back when it is selected again). */
  get cues(): Cue[] { return this.song ? this.song.cues : this.noSongCues; }
  set cues(c: Cue[]) { if (this.song) this.song.cues = c; else this.noSongCues = c; }
  private cueIndex = -1;
  /**
   * When on, a song playing on (from play(), a once cue, or release()) holds at each loop or riff
   * cue it reaches, as if goTo had been pressed there, unless the cue says `hold: false`; so the
   * song plays from the top and waits at each hold until next() or release(). Off by default.
   */
  autoHold = false;
  /** The cue release() let go of: not held again until the playhead has left it. */
  private released: Cue | null = null;
  private watcher: ReturnType<typeof setInterval>;
  private workers = new Map<Song, Worker>();
  private passes = new Map<Song, VoicePass>();
  /** Called whenever the score grows or the playback state changes. */
  onChange: (() => void) | null = null;

  constructor(private options: LooperOptions = {}) {
    this.deck.onChange = () => this.onChange?.();
    this.watcher = setInterval(() => this.watch(), 50);
  }

  /** How far the current song's voice pass has got (state 'off' when it isn't running for this song). */
  get voice(): VoiceProgress { return this.voiceOf(this.song); }
  voiceOf(song: Song | null): VoiceProgress { return (song && this.passes.get(song)?.progress) ?? { state: 'off', done: 0, etaSec: null, why: '' }; }
  /** Memory the held songs take, in bytes. */
  get bytes() { return this.songs.reduce((a, s) => a + s.bytes, 0); }
  /** How many bars past the quantise point a change may wait for a gap in the vocal (default 2; 0 never waits). */
  get voiceWaitBars() { return this.deck.voiceWaitBars; }
  set voiceWaitBars(n: number) { this.deck.voiceWaitBars = n; }

  get quantise() { return this.deck.quantise; }
  set quantise(q: Quantise) { this.deck.quantise = q; }

  /** Decode, analyse and select a song file (the one song an app plays). Resolves when the score is final; the score grows (and onChange fires) as it goes. */
  async load(file: File, onProgress?: (p: LoadProgress) => void): Promise<Score> {
    return (await this.add(file, onProgress, true)).score;
  }

  /**
   * Add a song to the rack: decoded, analysed (in a worker, the score cached) and, with the voice
   * option, listened to, while whatever is playing plays on. With `select`, it becomes the current
   * song as soon as it is decoded, so its score can be watched growing. Resolves when the score is
   * final; the Song is in `songs` from the moment it is decoded.
   */
  async add(file: File, onProgress?: (p: LoadProgress) => void, select = false): Promise<Song> {
    onProgress?.({ stage: 'decode', done: 0, etaSec: null, cached: false });
    const data = await file.arrayBuffer();
    const tags = readTags(data, file.name);
    const hash = await hashFile(data);
    const buffer = await this.deck.ctx.decodeAudioData(data.slice(0));
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels; }
    const track = { title: tags.title || file.name.replace(/\.[^.]+$/, ''), artist: tags.artist, album: tags.album, ...(tags.year ? { year: tags.year } : {}), durationSec: buffer.duration, art: null, hash };
    const cached = await loadScore(hash);
    const score = cached?.final ? cached : emptyScore(track, buffer.duration);
    const song: Song = { name: file.name, title: track.title, hash, buffer, mono, score, cues: [], bytes: (buffer.length * buffer.numberOfChannels + mono.length) * 4 };
    this.songs.push(song);
    if (select) this.select(this.songs.length - 1); else this.onChange?.();
    if (cached?.final) {
      onProgress?.({ stage: 'done', done: 1, etaSec: 0, cached: true });
      this.listen(song);
      return song;
    }
    const done = () => {
      void saveScore(score);
      onProgress?.({ stage: 'done', done: 1, etaSec: 0, cached: false });
      this.listen(song);
      return song;
    };
    const progress = (analyzedSec: number, wallSec: number) => {
      const rate = analyzedSec / Math.max(1e-3, wallSec);
      onProgress?.({ stage: 'analyse', done: analyzedSec / buffer.duration, etaSec: analyzedSec > 2 ? (buffer.duration - analyzedSec) / rate : null, cached: false });
    };
    const delta = (d: ScoreDelta) => { applyDelta(score, d); this.onChange?.(); };
    const viaWorker = await new Promise<boolean>(resolve => {
      let w: Worker;
      try { w = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' }); }
      catch { resolve(false); return; }
      this.workers.set(song, w);
      let heard = false;
      w.onerror = () => { if (!heard) { w.terminate(); this.workers.delete(song); resolve(false); } };
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        heard = true;
        if (m.type === 'progress') progress(m.analyzedSec, m.wallSec);
        else if (m.type === 'delta') {
          delta(m.delta);
          if (score.final) { w.terminate(); this.workers.delete(song); resolve(true); }
        }
      };
      const pcm = mono.slice();
      w.postMessage({ type: 'start', pcm, sampleRate: buffer.sampleRate }, [pcm.buffer]);
    });
    if (viaWorker) return done();
    // No worker (a sandboxed page, or a bundler that can't load one): analyse here, a chunk at a time.
    const a = new Analyzer(mono, buffer.sampleRate, { chunkSec: 3 }), t0 = performance.now();
    while (!a.finished && this.songs.includes(song)) {
      const d = a.step();
      if (d) delta(d);
      progress(a.analyzedSec, (performance.now() - t0) / 1000);
      await new Promise(r => setTimeout(r, 0));
    }
    return done();
  }

  /** Make songs[i] the one in the deck (stopping whatever played); play() or goTo() then start it. */
  select(i: number) {
    const song = this.songs[i];
    if (!song || song === this.song) return;
    this.song = song; this.buffer = song.buffer; this.mono = song.mono; this.score = song.score;
    this.cueIndex = -1; this.released = null;
    this.deck.load(song.buffer, new Cutter(song.mono, song.buffer.sampleRate), song.score);
    this.onChange?.();
  }

  /** Drop songs[i] from the rack and free its memory (stopping it if it is playing). */
  remove(i: number) {
    const song = this.songs[i];
    if (!song) return;
    this.songs.splice(i, 1);
    this.workers.get(song)?.terminate(); this.workers.delete(song);
    this.passes.get(song)?.stop(); this.passes.delete(song);
    if (song === this.song) { this.deck.stop(); this.song = null; this.buffer = null; this.mono = null; this.score = null; this.cueIndex = -1; }
    this.onChange?.();
  }

  /** Run the voice pass in the background, unless it is off or this score already has the whole curve. */
  private listen(song: Song) {
    const score = song.score;
    if (!this.options.voice || !this.songs.includes(song) || (score.envelopes.voice && (score.soundsFrontier ?? 0) >= score.track.durationSec)) return;
    const pass = new VoicePass(score, () => this.onChange?.());
    this.passes.set(song, pass);
    void pass.start(song.buffer, this.options.voice).then(ok => { if (ok && this.songs.includes(song)) void saveScore(score); });
  }

  /** Cues to step through: the ones marked, or, until any are, every section as a loop. */
  get playlist(): Cue[] {
    if (this.cues.length || !this.score) return this.cues;
    const S = this.score.sections, names = sectionNames(this.score);
    const end = this.score.final ? this.score.track.durationSec : this.score.frontierSec;
    return S.map((s, i) => ({ name: names[i], from: s.t, to: S[i + 1]?.t ?? lastBar(this.score!, end), mode: 'loop' as const }));
  }

  /**
   * The holds of this song: every section of four bars or more, as a riff (bars alike enough to
   * jump between, nobody singing or talking) or a loop, the best per group `suggested`. They
   * change as the score grows and once the voice pass has listened, so ask again then.
   */
  holds(): Hold[] {
    if (!this.score || !this.deck.cutter) return [];
    const c = this.deck.cutter;
    return findHolds(this.score, { riff: (a, b) => this.riffFor({ from: a, to: b }), joinDb: (o, i) => c.score(c.join(o), c.join(i)).db });
  }

  /** autoHold: playing on into a loop or riff cue holds there. */
  private watch() {
    const d = this.deck;
    if (!this.autoHold || !d.playing || d.loop || d.pending) return;
    const p = d.position, list = this.playlist;
    if (this.released && p >= this.released.from - 0.1 && p < this.released.to + 0.1) return;
    this.released = null;
    const i = list.findIndex(c => c.mode !== 'once' && c.hold !== false && p >= c.from && p < c.to - 0.5);
    if (i >= 0) this.goTo(i);
  }

  /** Change to cue i at the next quantise point (or start it, when stopped). */
  goTo(i: number) {
    const cue = this.playlist[i];
    if (!cue) return;
    this.cueIndex = i; this.released = null;
    if (cue.mode === 'riff') this.deck.setRiff(cue.from, cue.to, this.riffFor(cue), cue.name);
    else if (cue.mode === 'loop') this.deck.setLoop(cue.from, cue.to, cue.name);
    else this.deck.change(cue.from, null, cue.name);
  }

  next() { this.goTo(Math.min(this.playlist.length - 1, this.currentCue() + 1)); }
  prev() { this.goTo(Math.max(0, this.currentCue() - 1)); }

  play(from = 0) { this.cueIndex = -1; this.released = null; this.deck.play(from); }
  stop() { this.deck.stop(); }
  /**
   * The riff a cue would play: its bar graph (`jumps`, `jumpCount`) and its walk. Options other
   * than the seed are the defaults unless given (see RiffOptions).
   */
  riffFor(cue: Pick<Cue, 'from' | 'to' | 'seed'>, opts: RiffOptions = {}): Riff {
    return this.deck.riffOn(cue.from, cue.to, { seed: cue.seed ?? seedOf(`${this.score?.track.hash}:${cue.from}`), ...opts });
  }

  /** Loop an arbitrary passage (downbeat times), e.g. a selection. */
  loop(from: number, to: number) { this.cueIndex = -1; this.released = null; this.deck.setLoop(from, to, 'selection'); }
  /** Play on past the loop's end into the rest of the song (with autoHold, the next hold waits). */
  release() { this.released = this.playlist[this.currentCue()] ?? (this.deck.loop ? { name: '', from: this.deck.loop[0], to: this.deck.loop[1], mode: 'loop' } : null); this.deck.release(); }
  private pausing: ReturnType<typeof setTimeout> | null = null;
  /** Fade out over `fadeSec` and hold everything where it is (the audio clock stops). */
  pause(fadeSec = 0.4) {
    if (this.pausing || this.paused) return;
    if (!this.deck.playing) { void this.deck.ctx.suspend(); return; }
    this.deck.fadeTo(0, fadeSec);
    this.pausing = setTimeout(() => { this.pausing = null; void this.deck.ctx.suspend(); this.onChange?.(); }, fadeSec * 1000);
  }
  /**
   * Carry on: from the bar line at least `rewindSec` before where it paused (so the ear gets back
   * into the music), fading in over `fadeSec`. A hold stays a hold; a riff keeps its walk.
   */
  resume(rewindSec = 1.5, fadeSec = 0.3) {
    if (this.pausing) { clearTimeout(this.pausing); this.pausing = null; }
    const d = this.deck;
    void d.ctx.resume();
    if (!d.playing || !this.score) { d.fadeTo(1, fadeSec); return; }
    const at = d.position, floor = d.loop ? d.loop[0] : 0;
    const back = Math.max(floor, barStarts(this.score).filter(t => t <= at - rewindSec).pop() ?? 0);
    d.fadeTo(0, 0);
    d.play(back, d.loop, d.riff);
    d.fadeTo(1, fadeSec);
  }
  get paused() { return this.deck.ctx.state === 'suspended' || this.pausing !== null; }
  /** Output level, 0..1 linear gain, faded over `rampSec`. */
  setVolume(gain: number, rampSec = 0) { this.deck.setVolume(gain, rampSec); }
  /** Done with this Looper: stops the worker, the audio and the AudioContext. */
  dispose() { clearInterval(this.watcher); for (const w of this.workers.values()) w.terminate(); for (const p of this.passes.values()) p.stop(); this.workers.clear(); this.passes.clear(); this.deck.dispose(); }

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
      pending: d.pending ? { at: d.pending.at, inSec: Math.max(0, d.pending.when - d.ctx.currentTime), label: d.pending.label, forVoice: d.pending.forVoice } : null,
      loop: d.loop, joins: d.joins,
      ...(d.riff ? { riff: { path: d.riff.path, jumps: d.riff.jumpCount } } : {}),
    };
  }
}
