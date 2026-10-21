/// <reference lib="webworker" />
// Analysis worker: runs the progressive analyzer front to back and posts score deltas.
// Vendored from Gondryator (src/analysis/worker.ts) without its auto-tune branch.
import { Analyzer } from './analyzer';

let cancelled = false;

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type !== 'start') return;
  cancelled = false;
  const a = new Analyzer(msg.pcm as Float32Array, msg.sampleRate, { chunkSec: 3 });
  const t0 = performance.now();
  while (!a.finished && !cancelled) {
    const d = a.step();
    if (d) (self as DedicatedWorkerGlobalScope).postMessage({ type: 'delta', delta: d });
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'progress', analyzedSec: a.analyzedSec, wallSec: (performance.now() - t0) / 1000 });
    await new Promise(r => setTimeout(r, 0)); // let a cancel in
  }
};
