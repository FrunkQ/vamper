// The editor's one picture: the section strip and cue strip on top, the waveform with the bar
// grid below, and the playhead, loop and pending change drawn over it. Plain canvas 2D.
import type { Looper } from './engine/looper';
import { sectionNames, voiceAt, VOICE_QUIET } from './engine/plan';

export const STRIP = 24; // height of each strip row
const WAVE_TOP = STRIP * 2 + 6;
const COLOURS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f'];

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

/** Which strip block is under (x, y), if any. */
export function stripHit(looper: Looper, width: number, x: number, y: number): { row: 'section' | 'cue'; index: number } | null {
  const t = (x / width) * (looper.buffer?.duration ?? 1);
  if (y < STRIP && looper.score) {
    const i = looper.score.sections.findIndex((s, k) => t >= s.t && t < (looper.score!.sections[k + 1]?.t ?? Infinity));
    return i >= 0 ? { row: 'section', index: i } : null;
  }
  if (y < STRIP * 2) {
    const i = looper.cues.findIndex(c => t >= c.from && t < c.to);
    return i >= 0 ? { row: 'cue', index: i } : null;
  }
  return null;
}

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

  // Waveform.
  ensurePeaks(looper.mono, Math.round(w));
  const mid = (WAVE_TOP + h) / 2, amp = (h - WAVE_TOP) / 2 - 4;
  g.fillStyle = '#4b5563';
  for (let x = 0; x < peaks.width; x++) g.fillRect(x, mid - peaks.hi[x] * amp, 1, Math.max(1, (peaks.hi[x] - peaks.lo[x]) * amp));
  if (!score) return;

  // Analysed so far.
  if (!score.final) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(X(score.frontierSec), WAVE_TOP, w, h); }

  // Bar grid and phrase starts.
  const barPx = w / Math.max(1, score.beats.length / 4);
  for (const b of score.beats) {
    if (!b.downbeat && barPx < 40) continue;
    g.fillStyle = b.downbeat ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    g.fillRect(Math.round(X(b.t)), WAVE_TOP, 1, h - WAVE_TOP);
  }
  for (const p of score.phrases) {
    g.fillStyle = p.repeatOf === null ? 'rgba(240,180,41,0.6)' : 'rgba(240,180,41,0.3)';
    g.fillRect(Math.round(X(p.t)), WAVE_TOP, 2, 8);
  }

  // The voice curve, lightly along the bottom: pink where someone is singing or talking (from the
  // voice pass), so it is easy to see why a change waited or a loop's wrap is flagged.
  if (score.envelopes.voice) {
    const vh = Math.min(40, (h - WAVE_TOP) / 4);
    for (let x = 0; x < w; x++) {
      const v = voiceAt(score, (x / w) * dur);
      if (!v || v < 0.1) continue;
      g.fillStyle = v >= VOICE_QUIET ? 'rgba(236,112,198,0.45)' : 'rgba(236,112,198,0.2)';
      g.fillRect(x, h - v * vh, 1, v * vh);
    }
  }

  // Section strip.
  const names = sectionNames(score);
  score.sections.forEach((s, i) => {
    const end = score.sections[i + 1]?.t ?? (score.final ? dur : score.frontierSec);
    block(g, X(s.t), X(end), 0, COLOURS[(s.group ?? i) % COLOURS.length], `${names[i]} · ${s.label}`, looper.cues.length === 0 && st.cue === i);
  });
  // Cue strip.
  looper.cues.forEach((c, i) => block(g, X(c.from), X(c.to), STRIP, c.mode === 'loop' ? '#2f6f9f' : c.mode === 'riff' ? '#3a8a68' : '#7a5c2e', `${i + 1} ${c.name}${c.mode === 'loop' ? ' ⟲' : c.mode === 'riff' ? ' ⤨' : ''}`, st.cue === i));

  // Selection, loop, pending change, playhead.
  if (ui.selection) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(X(ui.selection[0]), WAVE_TOP, X(ui.selection[1]) - X(ui.selection[0]), h - WAVE_TOP); }
  if (st.loop) {
    g.strokeStyle = '#3fa7ff'; g.lineWidth = 2;
    g.strokeRect(X(st.loop[0]) + 1, WAVE_TOP + 1, X(st.loop[1]) - X(st.loop[0]) - 2, h - WAVE_TOP - 2);
  }
  if (st.pending) { g.fillStyle = '#f0b429'; g.fillRect(X(st.pending.at) - 1, WAVE_TOP, 3, h - WAVE_TOP); }
  // A riff's jumps: an arc from where it left to where it landed, the latest brightest.
  const jumps = st.joins.filter(j => j.riff).slice(-6);
  jumps.forEach((j, k) => {
    const x0 = X(j.from), x1 = X(j.to), r = Math.abs(x1 - x0) / 2;
    g.strokeStyle = `rgba(92,214,160,${0.25 + 0.75 * ((k + 1) / jumps.length)})`; g.lineWidth = 2;
    g.beginPath(); g.ellipse((x0 + x1) / 2, WAVE_TOP + 4, r, Math.min(40, r / 2 + 6), 0, 0, Math.PI); g.stroke();
  });
  for (const j of st.joins) {
    if (j.kind !== 'change' && j.score.warn) { g.fillStyle = '#e15759'; g.fillRect(X(j.from) - 2, h - 8, 4, 8); }
    if (j.voice !== null && j.voice >= VOICE_QUIET) { g.fillStyle = '#ec70c6'; g.fillRect(X(j.from) - 2, h - 16, 4, 6); }
  }
  if (st.playing) { g.fillStyle = '#fff'; g.fillRect(Math.round(X(st.position)), WAVE_TOP - 4, 2, h - WAVE_TOP + 4); }
}

function block(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, colour: string, text: string, on: boolean) {
  g.fillStyle = colour;
  g.globalAlpha = on ? 1 : 0.55;
  g.fillRect(x0 + 1, y + 2, Math.max(1, x1 - x0 - 2), STRIP - 4);
  g.globalAlpha = 1;
  if (on) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x0 + 1, y + 2, x1 - x0 - 2, STRIP - 4); }
  g.save();
  g.beginPath(); g.rect(x0 + 1, y, x1 - x0 - 2, STRIP); g.clip();
  g.fillStyle = '#fff'; g.font = '12px system-ui, sans-serif'; g.fillText(text, x0 + 5, y + 16);
  g.restore();
}
