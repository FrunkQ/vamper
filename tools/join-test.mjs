// Headless join test: no browser. For each synthetic test track it runs the analyser, plans a
// session the way the deck would (loop four bars three times, advance mid-pass at a bar line to the
// next section, then step back to the loop), renders it offline with the same cut and crossfade
// code the deck uses (src/engine/cuts.ts), writes the WAV, and measures every join:
//   - click: no sample-to-sample jump larger than the track's own largest;
//   - level: short-term loudness across the crossfade stays between the two sides (no dip, no bump),
//     wherever it is within 20 dB of the music around it;
//   - groove: the bar spanning the join is as long as the same bar in the source, within 3 ms.
//   node tools/join-test.mjs            (exits 1 if any join fails)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

fs.mkdirSync('.cache', { recursive: true });
buildSync({ stdin: { contents: "export * from './src/analysis/analyzer'; export * from './src/engine/cuts'; export * from './src/engine/plan';", resolveDir: '.', loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: '.cache/engine.mjs', logLevel: 'error' });
const { Analyzer, Cutter, render, barStarts, followingSection, nextCut } = await import(process.cwd() + '/.cache/engine.mjs?' + Date.now());

const TRACKS = ['test-124', 'test-100', 'test-120'];
if (TRACKS.some(t => !fs.existsSync(`test-tracks/${t}.wav`))) execFileSync('node', ['tools/make-test-tracks.mjs'], { stdio: 'inherit' });
fs.mkdirSync('test-tracks/out', { recursive: true });

function readWav(file) {
  const b = fs.readFileSync(file), sr = b.readUInt32LE(24), n = b.readUInt32LE(40) / 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { x, sr };
}
function writeWav(file, x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, b);
}
const maxJump = (x, a = 1, b = x.length) => { let m = 0; for (let i = Math.max(1, a); i < Math.min(x.length, b); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
const rmsDb = (x, a, n) => { let s = 0; for (let i = a; i < a + n; i++) s += (x[i] ?? 0) ** 2; return 10 * Math.log10(s / n + 1e-9); };

let failures = 0;
for (const name of TRACKS) {
  const { x, sr } = readWav(`test-tracks/${name}.wav`);
  const a = new Analyzer(x, sr, { chunkSec: 4 });
  const score = { beats: [], sections: [], phrases: [] };
  while (!a.finished) { const d = a.step(); if (d) for (const k of Object.keys(score)) score[k].push(...d[k]); }
  const bars = barStarts(score), cut = new Cutter(x, sr), X = cut.xfade;

  // The session: the first section with drums and at least 8 bars, looped 4 bars at a time.
  const sec = score.sections.find((s, i) => s.label !== 'intro' && s.label !== 'breakdown' && (score.sections[i + 1]?.bar ?? 1e9) - s.bar >= 8);
  const i0 = bars.findIndex(t => Math.abs(t - sec.t) < 0.05);
  const A = bars[i0], B = bars[i0 + 4], mid = bars[i0 + 2], next = followingSection(score, B);
  const nb = bars.findIndex(t => Math.abs(t - next.t) < 0.05);
  const plan = [];
  // As the deck does it: cut the playing segment at a bar (cutAt), then fit the next one to it.
  const add = (from, to, cutAt) => {
    const prev = plan.at(-1), seg = cut.segment(from, to);
    if (prev) { if (cutAt !== undefined) { prev.e = cut.join(cutAt); prev.to = cutAt; } cut.fit(prev, seg); }
    plan.push(seg);
  };
  add(A, B); add(A, B, B); add(A, B, B); // three passes
  add(next.t, bars[nb + 4], mid);        // advance at the next bar, mid-pass
  add(A, B, bars[nb + 4]);               // step back to the loop
  const [out] = render([x], plan, X);
  writeWav(`test-tracks/out/${name}-session.wav`, out, sr);

  // Where each join lands in the output.
  const limit = maxJump(x) * 1.0 + 1e-4, outCut = new Cutter(out, sr);
  let p = 0;
  console.log(`\n${name}: loop bars ${i0 + 1}-${i0 + 4} of "${sec.label}", advance to "${next.label}" at bar ${nb + 1}; source max jump ${limit.toFixed(3)}`);
  for (let k = 1; k < plan.length; k++) {
    p += plan[k - 1].e - plan[k - 1].s - X;
    const j = p + X; // the join in the output: where the incoming side is fully in
    const sc = cut.score(plan[k - 1].e, plan[k].s + X);
    const jump = maxJump(out, p - 4, j + 4);
    // Level across the crossfade, in 5 ms windows, against the two sides on their own.
    let worst = 0;
    const w = Math.round(0.005 * sr);
    for (let q = p - w; q < j + w; q += w) {
      const o = rmsDb(out, q, w), sOut = rmsDb(x, plan[k - 1].e - X + (q - p), w), sIn = rmsDb(x, plan[k].s + (q - p), w);
      const lo = Math.min(sOut, sIn), hi = Math.max(sOut, sIn);
      if (hi < rmsDb(out, q - 0.1 * sr, 0.2 * sr) - 20) continue; // a dip in near-silence is not heard
      worst = Math.max(worst, o < lo ? lo - o : o > hi ? o - hi : 0);
    }
    // Groove: in the output, the bar that ends at the join (from the outgoing side's last downbeat
    // to the incoming downbeat) must be as long as that bar is in the source, within 3 ms.
    const to = plan[k - 1].to, bi = bars.findIndex(t => Math.abs(t - to) < 1e-6);
    const barLen = (cut.attack(to) - cut.attack(bars[bi - 1])) / sr;
    const after = outCut.attack((j + 0.01 * sr) / sr), before = outCut.attack(after / sr - barLen);
    const groove = Math.abs((after - before) / sr - barLen) * 1000;
    const ok = jump <= limit && worst <= 1.5 && groove <= 3;
    if (!ok) failures++;
    console.log(`  join ${k} at ${(j / sr).toFixed(3)} s: jump ${jump.toFixed(3)}, level off by ${worst.toFixed(1)} dB, bar ${groove.toFixed(1)} ms off, score ${sc.db} dB / r ${sc.r}  ${ok ? 'ok' : 'FAIL'}`);
  }
}
// Voice-aware changes (plan.ts nextCut), on a made-up voice curve over the last track: a sung line
// across the next two bar lines makes a change wait for the third; with no voice it doesn't wait;
// a line across every bar in reach falls back to the least-bad one (a phrase start if there is one).
{
  const name = TRACKS.at(-1), { x, sr } = readWav(`test-tracks/${name}.wav`), a = new Analyzer(x, sr, { chunkSec: 4 });
  const score = { beats: [], sections: [], phrases: [], envelopes: {}, soundsFrontier: x.length / sr };
  while (!a.finished) { const d = a.step(); if (d) for (const k of ['beats', 'sections', 'phrases']) score[k].push(...d[k]); }
  const bars = barStarts(score), rate = 1 / 0.975, n = Math.ceil((x.length / sr) * rate);
  const curve = (sung) => { score.envelopes.voice = { rate, values: Array.from({ length: n }, (_, i) => (sung((i + 0.5) / rate) ? 0.8 : 0.02)) }; };
  const k = bars.findIndex(t => t > 10), t0 = bars[k] - 0.5;
  const checks = [];
  curve(() => false);
  checks.push(['no voice: next bar', nextCut(score, t0, 'bar'), bars[k], false]);
  curve(t => t > bars[k] - 1 && t < bars[k + 1] + 1);
  checks.push(['line across two bar lines: waits for the third', nextCut(score, t0, 'bar'), bars[k + 2], true]);
  checks.push(['waiting off: next bar', nextCut(score, t0, 'bar', Infinity, 0), bars[k], false]);
  curve(() => true);
  const ph = score.phrases.map(p => p.t).find(t => t > bars[k] + 0.01 && t <= bars[k + 2] + 0.01);
  checks.push(['voice everywhere: least bad', nextCut(score, t0, 'bar'), ph ?? bars[k], ph !== undefined]);
  console.log(`\nvoice-aware changes on ${name} (from ${t0.toFixed(2)} s):`);
  for (const [what, got, at, held] of checks) {
    const ok = got && Math.abs(got.at - at) < 1e-6 && got.held === held;
    if (!ok) failures++;
    console.log(`  ${what}: ${got ? got.at.toFixed(3) + ' s' + (got.held ? ' (held)' : '') : 'none'}  ${ok ? 'ok' : 'FAIL (want ' + at.toFixed(3) + ' s)'}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall joins ok');
process.exit(failures ? 1 : 0);
