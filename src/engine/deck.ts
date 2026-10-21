// The live engine: plays the song as a chain of segments (see cuts.ts) on the AudioContext clock.
// Each segment is an AudioBufferSourceNode with its own gain for the crossfades; the deck keeps
// the next segment queued a couple of seconds ahead. Milestone 1 uses chained buffer sources; an
// AudioWorklet "tape deck" can replace this file later without changing cuts.ts or plan.ts.
import { Cutter, fadeCurve, type JoinScore, type Segment } from './cuts';
import { nextBoundary, type Quantise } from './plan';
import type { Score } from '../score/types';

/** Queue the next segment when the current one has this long left (more than a background tab's 1 s timer). */
const LOOKAHEAD = 2.5;
/** The soonest a change can land after the button is pressed. */
const MARGIN = 0.12;
/** Room for fit() to move a cut point earlier, plus the crossfade. */
const SLACK = 0.04;

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time the segment's first sample plays. */
  when: number;
  seg: Segment;
  /** Context time its fade-out starts, once a successor is queued. */
  fadeOutAt: number | null;
}

/** A join that has been scheduled, for the debug readout: a loop wrapping, or a change of passage. */
export interface JoinLog { kind: 'loop' | 'change'; from: number; to: number; score: JoinScore }

export class Deck {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private out = this.ctx.createGain();
  private buffer: AudioBuffer | null = null;
  private cutter: Cutter | null = null;
  private score: Score | null = null;
  private voices: Voice[] = [];
  /** The passage being looped, as grid times [first downbeat, downbeat after the last bar], or null to play on. */
  loop: [number, number] | null = null;
  quantise: Quantise = 'bar';
  /** A change waiting to land: when (context time), where (song time) and what. */
  pending: { when: number; at: number; label: string } | null = null;
  joins: JoinLog[] = [];
  onChange: (() => void) | null = null;

  constructor() {
    this.out.connect(this.ctx.destination);
    setInterval(() => this.tick(), 40);
  }

  load(buffer: AudioBuffer, cutter: Cutter, score: Score) {
    this.stop();
    this.buffer = buffer; this.cutter = cutter; this.score = score;
    this.loop = null; this.joins = [];
  }

  get playing() { return this.voices.length > 0; }

  /** Song time (seconds) being heard now, corrected for output latency. */
  get position(): number {
    const heard = this.ctx.currentTime - (this.ctx.outputLatency || 0) - (this.ctx.baseLatency || 0);
    const v = this.voiceAt(heard);
    if (!v || !this.buffer) return 0;
    return (v.seg.s + Math.max(0, heard - v.when) * this.buffer.sampleRate) / this.buffer.sampleRate;
  }

  /** Start from song time `from` (snapped to the attack there), looping `loop` if given. */
  play(from: number, loop: [number, number] | null = null) {
    if (!this.cutter) return;
    void this.ctx.resume();
    this.stop();
    this.loop = loop;
    const seg = this.cutter.segment(from, loop ? loop[1] : null);
    const v = this.startVoice(seg, this.ctx.currentTime + 0.05);
    // A first segment can start mid-wave: a 4 ms fade-in keeps it click-free.
    v.gain.gain.setValueAtTime(0, v.when);
    v.gain.gain.linearRampToValueAtTime(1, v.when + 0.004);
    this.onChange?.();
  }

  stop() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.src.onended = null;
      v.gain.gain.cancelScheduledValues(0);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + 0.03);
      try { v.src.stop(now + 0.04); } catch { /* not started */ }
    }
    this.voices = [];
    this.pending = null;
    this.onChange?.();
  }

  /**
   * Loop [a, b) from the next quantise point. When the playhead is already inside the passage the
   * music simply carries on and wraps at b; otherwise it jumps to a at the next boundary.
   */
  setLoop(a: number, b: number, label = 'loop') {
    if (!this.playing) { this.play(a, [a, b]); return; }
    const p = this.position;
    if (p >= a - 0.02 && p < b - MARGIN) {
      const v = this.dropFuture();
      this.loop = [a, b];
      const jb = this.cutter!.join(b);
      if (v.seg.e > jb && this.timeOf(v, jb) - SLACK > this.ctx.currentTime + MARGIN) this.setEnd(v, jb, b);
      this.onChange?.();
    } else this.change(a, [a, b], label);
  }

  /** Stop looping: play on past the loop's end into the rest of the song. */
  release() {
    if (!this.playing) { this.loop = null; return; }
    this.dropFuture();
    this.loop = null;
    this.pending = null;
    this.onChange?.();
  }

  /**
   * At the next quantise point, cut to song time `target` and play on (or loop `loop`).
   * Returns the song time the change lands at, or null if there is nowhere left to land.
   */
  change(target: number, loop: [number, number] | null, label: string): number | null {
    if (!this.playing) { this.play(target, loop); return target; }
    const sr = this.buffer!.sampleRate, c = this.cutter!;
    const v = this.dropFuture();
    const soonest = this.ctx.currentTime + MARGIN + c.xfade / sr;
    const p = (v.seg.s + Math.max(0, soonest - v.when) * sr) / sr;
    const b = nextBoundary(this.score!, p, this.quantise === 'loop' && !this.loop ? 'bar' : this.quantise, v.seg.e / sr);
    // Land on that boundary, or at the end of this pass when there is none (or it is too close).
    if (b !== null && this.timeOf(v, c.join(b)) - SLACK > this.ctx.currentTime + MARGIN) this.setEnd(v, c.join(b), b);
    else if (v.seg.e >= this.buffer!.length) return null;
    this.loop = loop;
    this.link(v, c.segment(target, loop ? loop[1] : null), 'change');
    const at = v.seg.e / sr;
    this.pending = { when: this.timeOf(v, v.seg.e), at, label };
    this.onChange?.();
    return at;
  }

  // ---- internals ----

  private timeOf(v: Voice, sample: number) { return v.when + (sample - v.seg.s) / this.buffer!.sampleRate; }

  private voiceAt(t: number): Voice | null {
    let found: Voice | null = null;
    for (const v of this.voices) if (v.when <= t) found = v;
    return found ?? this.voices[0] ?? null;
  }

  private startVoice(seg: Segment, when: number): Voice {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.out);
    src.start(when, seg.s / this.buffer!.sampleRate);
    const v: Voice = { src, gain, when, seg, fadeOutAt: null };
    if (seg.e < this.buffer!.length) src.stop(this.timeOf(v, seg.e));
    src.onended = () => {
      this.voices = this.voices.filter(x => x !== v);
      gain.disconnect();
      if (!this.voices.length) { this.pending = null; this.onChange?.(); }
    };
    this.voices.push(v);
    return v;
  }

  /** End `v` at sample e, on the beat at grid time `to`. */
  private setEnd(v: Voice, e: number, to: number) {
    v.seg.e = e; v.seg.to = to;
    v.src.stop(this.timeOf(v, e));
  }

  /** Queue `seg` to crossfade in as `v` reaches its end (the cut points are fitted first). */
  private link(v: Voice, seg: Segment, kind: 'loop' | 'change' | 'on') {
    const sr = this.buffer!.sampleRate, X = this.cutter!.xfade, n = Math.max(2, X);
    const e0 = v.seg.e;
    this.cutter!.fit(v.seg, seg);
    if (v.seg.e !== e0) v.src.stop(this.timeOf(v, v.seg.e));
    const when = this.timeOf(v, v.seg.e - X);
    v.gain.gain.setValueCurveAtTime(fadeCurve(n, 'out', seg.r), when, X / sr);
    v.fadeOutAt = when;
    const next = this.startVoice(seg, when);
    next.gain.gain.setValueCurveAtTime(fadeCurve(n, 'in', seg.r), when, X / sr);
    if (kind !== 'on') this.joins.push({ kind, from: v.seg.e / sr, to: (seg.s + X) / sr, score: this.cutter!.score(v.seg.e, seg.s + X) });
    if (this.joins.length > 50) this.joins.shift();
  }

  /** Cancel queued segments that have not started yet; returns the one that will be playing. */
  private dropFuture(): Voice {
    const limit = this.ctx.currentTime + MARGIN;
    const keep = this.voices.filter(v => v.when <= limit);
    for (const v of this.voices) if (!keep.includes(v)) { v.src.onended = null; try { v.src.stop(); } catch { /* fine */ } v.gain.disconnect(); }
    this.voices = keep;
    const v = keep[keep.length - 1];
    if (v.fadeOutAt !== null) { v.gain.gain.cancelScheduledValues(v.fadeOutAt); v.fadeOutAt = null; }
    return v;
  }

  private tick() {
    if (!this.cutter || !this.buffer || !this.voices.length) return;
    if (this.pending && this.ctx.currentTime >= this.pending.when) { this.pending = null; this.onChange?.(); }
    const v = this.voices[this.voices.length - 1];
    if (v.seg.e >= this.buffer.length || this.timeOf(v, v.seg.e) - this.ctx.currentTime > LOOKAHEAD) return;
    const c = this.cutter, len = this.buffer.length;
    if (this.loop && v.seg.to === this.loop[1]) this.link(v, c.segment(this.loop[0], this.loop[1]), 'loop');
    else if (this.loop && v.seg.e < c.join(this.loop[1])) this.link(v, { s: 0, e: c.join(this.loop[1]), r: 1, to: this.loop[1] }, 'on');
    // Carry on from where this segment stops: the same audio on both sides, so the join is perfect.
    else this.link(v, { s: 0, e: len, r: 1 }, 'on');
  }
}
