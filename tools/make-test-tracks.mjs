// Synthesises test tracks with known ground truth (beats, drum hits, notes, sections, and the
// sudden changes in test-120: a build, a stop and a slam back in), so the analysis can be measured.
// Section options: `ramp: [from, to]` swells the drums and bass across the section (a build),
// `stop: n` silences the last n beats of its last bar, `moment` names the change it opens with. Writes WAV + truth JSON (and MP3 with tags if ffmpeg exists).
//   node tools/make-test-tracks.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 44100;
const out = process.argv[2] ?? 'test-tracks';
fs.mkdirSync(out, { recursive: true });

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const mtof = m => 440 * 2 ** ((m - 69) / 12);

function render({ name, title, artist, bpm, structure, seed, key = 45 }) {
  const beat = 60 / bpm, bar = beat * 4;
  const totalBars = structure.reduce((a, s) => a + s.bars, 0);
  const lead = 2 * beat; // two beats of silence before bar 1
  const dur = lead + totalBars * bar + 3;
  const L = new Float32Array(Math.ceil(dur * SR));
  const R = rand(seed);
  function rand(s) { return rng(s); }
  const truth = { bpm, firstDownbeat: lead, kicks: [], snares: [], hats: [], bass: [], lead: [], pads: [], sections: [], downbeats: [], moments: [] };

  const add = (t, fn, len) => {
    const a = Math.floor(t * SR), n = Math.floor(len * SR);
    for (let i = 0; i < n && a + i < L.length; i++) L[a + i] += fn(i / SR);
  };
  const kick = (t, v) => { let ph = 0; add(t, s => { const f = 45 + 90 * Math.exp(-s / 0.03); ph += (2 * Math.PI * f) / SR; return v * 0.9 * Math.sin(ph) * Math.exp(-s / 0.07); }, 0.35); truth.kicks.push(t); };
  const noise = R;
  const snare = (t, v) => { let lp = 0; add(t, s => { const n = noise() * 2 - 1; lp = lp * 0.6 + n * 0.4; return v * (0.55 * (n - 0.5 * lp) * Math.exp(-s / 0.08) + 0.3 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s / 0.04)); }, 0.3); truth.snares.push(t); };
  const hat = (t, v) => { let prev = 0; add(t, s => { const n = noise() * 2 - 1; const h = n - prev; prev = n; return v * 0.25 * h * Math.exp(-s / 0.025); }, 0.12); truth.hats.push(t); };
  const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
  const bassNote = (t, m, len, v) => { const f = mtof(m); let lp = 0; add(t, s => { const env = Math.min(1, s / 0.005) * (s > len - 0.03 ? Math.max(0, (len - s) / 0.03) : 1); const x = saw(f * s) * 0.6 + Math.sin(2 * Math.PI * f * s) * 0.6; lp += 0.12 * (x - lp); return v * 0.45 * env * lp; }, len); truth.bass.push({ t, m, len }); };
  const leadNote = (t, m, len, v) => { const f = mtof(m); add(t, s => { const env = Math.min(1, s / 0.01) * Math.exp(-s / 0.8) * (s > len - 0.04 ? Math.max(0, (len - s) / 0.04) : 1); return v * 0.22 * env * (Math.sin(2 * Math.PI * f * s) + 0.4 * Math.sin(4 * Math.PI * f * s) + 0.2 * Math.sin(6 * Math.PI * f * s)); }, len); truth.lead.push({ t, m, len }); };
  const pad = (t, notes, len, v) => { add(t, s => { const env = Math.min(1, s / 0.3) * Math.min(1, Math.max(0, (len - s) / 0.3)); let x = 0; for (const m of notes) { const f = mtof(m); x += Math.sin(2 * Math.PI * f * s) + 0.3 * Math.sin(2 * Math.PI * f * 1.003 * s); } return v * 0.06 * env * x; }, len); truth.pads.push({ t, notes, len }); };

  const chords = [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [-5, -1, 2]]; // i VI VII v-ish relative to key
  const bassLine = [0, 0, 12, 0, -4, -4, 8, -4, -2, -2, 10, -2, -5, -5, 7, -5];
  const melody = [12, 15, 19, 17, 15, 12, 10, 12];
  let barIdx = 0;
  for (const sec of structure) {
    const t0 = lead + barIdx * bar;
    truth.sections.push({ t: t0, label: sec.label, bar: barIdx + 1 });
    if (sec.moment) truth.moments.push({ t: t0, kind: sec.moment });
    if (sec.ramp) truth.moments.push({ t: t0, kind: 'build', dur: sec.bars * bar });
    for (let b = 0; b < sec.bars; b++) {
      const tb = t0 + b * bar;
      truth.downbeats.push(tb);
      const ci = b % 4;
      const ch = chords[ci];
      const cut = b === sec.bars - 1 ? sec.stop ?? 0 : 0;
      if (cut) truth.moments.push({ t: tb + (4 - cut) * beat, kind: 'stop', dur: cut * beat });
      const g = q => sec.ramp ? sec.ramp[0] + (sec.ramp[1] - sec.ramp[0]) * (b * 4 + q) / (sec.bars * 4) : 1;
      if (sec.pads) pad(tb, ch.map(c => key + 12 + c), bar - cut * beat, sec.pads);
      for (let q = 0; q < 4 - cut; q++) {
        const tq = tb + q * beat;
        if (sec.kick) kick(tq, sec.kick * g(q));
        if (sec.snare && (q === 1 || q === 3)) snare(tq, sec.snare * g(q));
        if (sec.hats) for (let e = 0; e < (sec.hats16 ? 4 : 2); e++) { if (!sec.hats16 && e === 0 && sec.kick) continue; hat(tq + e * beat / (sec.hats16 ? 4 : 2), sec.hats * g(q) * (e % 2 ? 1 : 0.7)); }
        if (sec.bass) { const m = key - 12 + bassLine[ci * 4 + q]; bassNote(tq + beat / 2, m, beat / 2 - 0.02, sec.bass * g(q)); }
      }
      if (sec.lead) for (let k = 0; k < 4 - cut; k++) { const m = key + 12 + melody[((b % 2) * 4 + k) % 8] + (ch[0] < 0 ? -2 : 0); leadNote(tb + k * beat, m, beat * 0.9, sec.lead); }
    }
    barIdx += sec.bars;
  }
  if (!truth.moments.length) delete truth.moments;
  // Normalise.
  let peak = 0;
  for (const v of L) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < L.length; i++) L[i] = (L[i] / peak) * 0.89;

  // WAV
  const buf = Buffer.alloc(44 + L.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + L.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(L.length * 2, 40);
  for (let i = 0; i < L.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 2);
  const wav = path.join(out, `${name}.wav`);
  fs.writeFileSync(wav, buf);
  fs.writeFileSync(path.join(out, `${name}.truth.json`), JSON.stringify(truth));
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-b:a', '192k', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', 'album=Gondryator Test Tones', path.join(out, `${name}.mp3`)]);
  } catch { /* optional */ }
  console.log(`${name}: ${dur.toFixed(1)}s, ${truth.kicks.length} kicks, ${truth.bass.length} bass, ${truth.lead.length} lead`);
}

render({
  name: 'test-124', title: 'Valence Line', artist: 'Test Tones', bpm: 124, seed: 7,
  structure: [
    { label: 'intro', bars: 8, pads: 1, hats: 0.6 },
    { label: 'verse', bars: 16, kick: 1, snare: 0.8, hats: 0.7, bass: 1, pads: 0.7 },
    { label: 'breakdown', bars: 8, pads: 1, lead: 0.9 },
    { label: 'drop', bars: 16, kick: 1, snare: 0.9, hats: 0.8, hats16: true, bass: 1, lead: 0.9, pads: 0.6 },
    { label: 'outro', bars: 8, pads: 0.8, hats: 0.4 },
  ],
});
render({
  name: 'test-100', title: 'Nimes Morning', artist: 'Test Tones', bpm: 100, seed: 3, key: 43,
  structure: [
    { label: 'intro', bars: 4, pads: 1 },
    { label: 'verse', bars: 8, kick: 1, snare: 0.7, hats: 0.5, bass: 0.9 },
    { label: 'chorus', bars: 8, kick: 1, snare: 0.9, hats: 0.8, bass: 1, lead: 1, pads: 0.7 },
    { label: 'breakdown', bars: 4, pads: 1, lead: 0.8 },
    { label: 'drop', bars: 8, kick: 1, snare: 0.9, hats: 0.8, hats16: true, bass: 1, lead: 1, pads: 0.7 },
  ],
});
render({
  name: 'test-120', title: 'Stop Start', artist: 'Test Tones', bpm: 120, seed: 11, key: 41,
  structure: [
    { label: 'intro', bars: 4, pads: 1, hats: 0.5 },
    { label: 'verse', bars: 8, kick: 1, snare: 0.8, hats: 0.7, bass: 1, pads: 0.6, moment: 'lift' },
    { label: 'breakdown', bars: 4, pads: 1, lead: 0.8, moment: 'break' },
    { label: 'build', bars: 4, kick: 1, snare: 0.9, hats: 0.8, hats16: true, pads: 1, ramp: [0.12, 1] },
    { label: 'drop', bars: 8, kick: 1, snare: 0.9, hats: 0.8, hats16: true, bass: 1, lead: 0.9, pads: 0.6, stop: 2, moment: 'drop' },
    { label: 'chorus', bars: 8, kick: 1, snare: 0.9, hats: 0.8, bass: 1, lead: 1, pads: 0.7, moment: 'drop' },
    { label: 'outro', bars: 4, pads: 0.8, hats: 0.4, moment: 'break' },
  ],
});
