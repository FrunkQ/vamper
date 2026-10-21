/// <reference lib="webworker" />
// The voice pass, worker half: YAMNet (Google's sound classifier, run by MediaPipe's audio tasks
// in WebAssembly) listens to the song six seconds at a time and says, for each window of about a
// second, how sure it is that someone is singing or talking. Input: mono audio at 16 kHz. Nothing
// leaves the machine; the model is a file served with the app.
// Cut down from Gondryator's sound pass (src/analysis/sounds.worker.ts, commit 2f0fa70): only the
// voice classes are kept, and the worker reduces each window to one number.
import { AudioClassifier } from '@mediapipe/tasks-audio';

export interface VoiceStart { type: 'start'; pcm: Float32Array; modelUrl: string; loaderUrl: string; wasmUrl: string }

const SR = 16000;
const CHUNK = 6 * SR;
/** YAMNet classes (AudioSet) that are a human voice: speech (0-5, 12, 63), shouting (6-11) and singing (24-32). */
const VOICE = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 25, 26, 27, 28, 29, 30, 31, 32, 63]);

const post = (m: unknown) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (ev: MessageEvent<VoiceStart>) => {
  const m = ev.data;
  if (m.type !== 'start') return;
  try {
    const t0 = performance.now();
    const classifier = await AudioClassifier.createFromOptions(
      { wasmLoaderPath: m.loaderUrl, wasmBinaryPath: m.wasmUrl },
      { baseOptions: { modelAssetPath: m.modelUrl }, maxResults: 30, scoreThreshold: 0.04 },
    );
    post({ type: 'ready', loadSec: (performance.now() - t0) / 1000 });
    const t1 = performance.now();
    for (let a = 0; a < m.pcm.length; a += CHUNK) {
      const part = m.pcm.subarray(a, Math.min(m.pcm.length, a + CHUNK));
      if (part.length < SR * 0.5) break; // too short to classify
      // Each window: [start (seconds into the song), the strongest voice class's score].
      const frames = classifier.classify(part, SR).map(r => [
        a / SR + (r.timestampMs ?? 0) / 1000,
        Math.max(0, ...(r.classifications[0]?.categories ?? []).filter(c => VOICE.has(c.index)).map(c => c.score)),
      ]);
      post({ type: 'chunk', b: (a + part.length) / SR, frames, wallSec: (performance.now() - t1) / 1000 });
      await new Promise(r => setTimeout(r, 0)); // let messages out between chunks
    }
    classifier.close();
    post({ type: 'done' });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
