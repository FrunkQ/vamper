// The page's one picture: a strip of the song's parts on top (the holds coloured by what they do),
// the waveform with the bar grid below, singing and talking washed pink over it, and the playhead,
// the hold in play, the pending change and a riff's jumps drawn over that. Plain canvas 2D.
import type { Cue, Looper } from './engine/looper';
import { sectionNames, voiceAt, VOICE_QUIET } from './engine/plan';

export const STRIP = 26; // height of the strip row
const WAVE_TOP = STRIP + 8;
export const COLOUR = { riff: '#4f8a5b', loop: '#3f6e9c', off: '#c9bb9c', short: '#e3d3b0', voice: 'rgba(194,86,127,0.26)', ink: '#2d2117', pencil: '#b5362b' };

let peaks: { lo: Float32Array; hi: Float32Array; width: number; mono: Float32Array | null } = { lo: new Float32Array(0), hi: new Float32Array(0), width: 0, mono: null };

function ensurePeaks(mono: Float32Array, width: number) {
  if (peaks.mono === mono && peaks.width === width) return;
  const lo = new Float32Array(width), hi = new Float32Array(width), per = mono.length / width;
  for (let x = 0; x < width; x++) {
    let a = 0, b = 0;
    const s = Math.floor(x * per), e = Math.min(mono.length, Math.floor((x + 1) * per));
    for (let i = s; i < e; i += 4) { const v = mono[i]; if (v < a) a = v; if (v > b) b = v; }
    lo[x] = a; hi[x] = b;
  }
  peaks = { lo, hi, width, mono };
}

export interface ViewState { selection: [number, number] | null }

/** The cue (hold) under x in the strip row, if any; -1 for a part of the song that isn't one. */
export function stripHit(looper: Looper, width: number, x: number, y: number): number | null {
  if (y >= STRIP || !looper.buffer) return null;
  const t = (x / width) * looper.buffer.duration;
  const i = looper.cues.findIndex(c => t >= c.from && t < c.to);
  return i;
}

/** The cue whose passage starts at this section, if any. */
export function cueAt(cues: Cue[], t: number): number { return cues.findIndex(c => Math.abs(c.from - t) < 0.02); }

export function draw(canvas: HTMLCanvasElement, looper: Looper, ui: ViewState) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const buf = looper.buffer, score = looper.score;
  if (!buf || !looper.mono) return;
  const dur = buf.duration, X = (t: number) => (t / dur) * w;
  const st = looper.state();

  // Where the music is sung or spoken: a pink wash over the whole waveform band, so it is plain
  // why a part loops rather than riffs, and why a change waited.
  if (score?.envelopes.voice) {
    for (let x = 0; x < w; x++) {
      const v = voiceAt(score, (x / w) * dur);
      if (!v || v < 0.15) continue;
      g.fillStyle = v >= VOICE_QUIET ? COLOUR.voice : 'rgba(194,86,127,0.1)';
      g.fillRect(x, WAVE_TOP, 1, h - WAVE_TOP);
    }
  }

  // The holds, lightly over the waveform too, so the band and the strip read as one.
  for (const c of looper.cues) {
    if (c.mode === 'once' || c.hold === false) continue;
    g.fillStyle = c.mode === 'riff' ? 'rgba(79,138,91,0.14)' : 'rgba(63,110,156,0.14)';
    g.fillRect(X(c.from), WAVE_TOP, X(c.to) - X(c.from), h - WAVE_TOP);
  }

  // Staff lines, then the waveform in ink.
  const mid = (WAVE_TOP + h) / 2, amp = (h - WAVE_TOP) / 2 - 4;
  g.fillStyle = 'rgba(45,33,23,0.08)';
  for (let k = -2; k <= 2; k++) g.fillRect(0, Math.round(mid + k * amp * 0.4), w, 1);
  ensurePeaks(looper.mono, Math.round(w));
  g.fillStyle = COLOUR.ink;
  for (let x = 0; x < peaks.width; x++) g.fillRect(x, mid - peaks.hi[x] * amp, 1, Math.max(1, (peaks.hi[x] - peaks.lo[x]) * amp));
  if (!score) return;

  // Analysed so far.
  if (!score.final) { g.fillStyle = 'rgba(247,238,219,0.75)'; g.fillRect(X(score.frontierSec), WAVE_TOP, w, h); }

  // Bar grid, and a mark where each four-bar phrase starts.
  const barPx = w / Math.max(1, score.beats.length / 4);
  for (const b of score.beats) {
    if (!b.downbeat && barPx < 40) continue;
    g.fillStyle = b.downbeat ? 'rgba(45,33,23,0.16)' : 'rgba(45,33,23,0.05)';
    g.fillRect(Math.round(X(b.t)), WAVE_TOP, 1, h - WAVE_TOP);
  }
  g.fillStyle = 'rgba(181,54,43,0.55)';
  for (const p of score.phrases) g.fillRect(Math.round(X(p.t)), WAVE_TOP, 2, 6);

  // The strip: every part of the song, coloured by what the music does there.
  const names = sectionNames(score);
  const drawn = new Set<number>();
  score.sections.forEach((s, i) => {
    const end = score.sections[i + 1]?.t ?? (score.final ? dur : score.frontierSec);
    const k = cueAt(looper.cues, s.t), c = looper.cues[k];
    if (c && c.mode !== 'once') {
      drawn.add(k);
      const on = c.hold !== false;
      block(g, X(c.from), X(c.to), on ? COLOUR[c.mode] : COLOUR.off, `${c.name} ${c.mode === 'riff' ? '⤨' : '⟲'}`, st.cue === k, on);
      if (c.to < end - 0.02) block(g, X(c.to), X(end), COLOUR.short, '', false, false);
    } else block(g, X(s.t), X(end), COLOUR.short, names[i], st.cue === k, false);
  });
  looper.cues.forEach((c, k) => {
    if (drawn.has(k) || c.mode === 'once') return;
    block(g, X(c.from), X(c.to), c.hold !== false ? COLOUR[c.mode] : COLOUR.off, `${c.name} ${c.mode === 'riff' ? '⤨' : '⟲'}`, st.cue === k, c.hold !== false);
  });

  // Selection, the hold in play, the pending change, a riff's jumps, the playhead.
  if (ui.selection) { g.fillStyle = 'rgba(45,33,23,0.12)'; g.fillRect(X(ui.selection[0]), WAVE_TOP, X(ui.selection[1]) - X(ui.selection[0]), h - WAVE_TOP); }
  if (st.loop) {
    g.strokeStyle = st.riff ? COLOUR.riff : COLOUR.loop; g.lineWidth = 2;
    g.strokeRect(X(st.loop[0]) + 1, WAVE_TOP + 1, X(st.loop[1]) - X(st.loop[0]) - 2, h - WAVE_TOP - 2);
  }
  if (st.pending) { g.fillStyle = COLOUR.pencil; g.fillRect(X(st.pending.at) - 1, WAVE_TOP, 3, h - WAVE_TOP); }
  // A riff's jumps: an arc from the bar line it left to the one it landed on, the latest brightest.
  const jumps = st.joins.filter(j => j.riff).slice(-6);
  jumps.forEach((j, k) => {
    const x0 = X(j.from), x1 = X(j.to), r = Math.abs(x1 - x0) / 2;
    g.strokeStyle = `rgba(79,138,91,${0.3 + 0.7 * ((k + 1) / jumps.length)})`; g.lineWidth = 2;
    g.beginPath(); g.ellipse((x0 + x1) / 2, WAVE_TOP + 2, r, Math.min(36, r / 2 + 6), 0, 0, Math.PI); g.stroke();
  });
  for (const j of st.joins) {
    if (j.kind !== 'change' && j.score.warn) { g.fillStyle = COLOUR.pencil; g.fillRect(X(j.from) - 2, h - 8, 4, 8); }
    if (j.voice !== null && j.voice >= VOICE_QUIET) { g.fillStyle = '#c2567f'; g.fillRect(X(j.from) - 2, h - 16, 4, 6); }
  }
  if (st.playing) { g.fillStyle = COLOUR.pencil; g.fillRect(Math.round(X(st.position)), 0, 2, h); }
}

function block(g: CanvasRenderingContext2D, x0: number, x1: number, colour: string, text: string, on: boolean, bright: boolean) {
  g.fillStyle = colour;
  g.globalAlpha = bright ? 1 : 0.8;
  g.fillRect(x0 + 1, 2, Math.max(1, x1 - x0 - 2), STRIP - 4);
  g.globalAlpha = 1;
  if (on) { g.strokeStyle = COLOUR.pencil; g.lineWidth = 2; g.strokeRect(x0 + 1, 2, x1 - x0 - 2, STRIP - 4); }
  if (!text || x1 - x0 < 14) return;
  g.save();
  g.beginPath(); g.rect(x0 + 1, 0, x1 - x0 - 2, STRIP); g.clip();
  g.fillStyle = bright ? '#f7eedb' : '#6b5a48'; g.font = `italic ${bright ? 600 : 400} 13px "Iowan Old Style", Palatino, Georgia, serif`; g.fillText(text, x0 + 6, 17);
  g.restore();
}
