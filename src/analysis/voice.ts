// The voice pass, main-thread half: runs YAMNet (voice.worker.ts) over the song after the fast
// analysis and writes a voice curve to the score: score.envelopes.voice, about one value a second,
// 0..1, how sure it is that someone is singing or talking then. The deck uses it to avoid cutting
// a sung line in half (plan.ts, voiceAcross). The song plays while this runs; the curve is final up
// to score.soundsFrontier.
// Cut down from Gondryator's sound pass (src/analysis/sounds.ts, commit 2f0fa70, The Unlicense):
// the voice curve only, no sound cues.
import type { Score } from '../score/types';

/** Where the model and its WebAssembly runtime are served from (Vamper serves them from public/models/). */
export interface VoiceModel { modelUrl: string; loaderUrl: string; wasmUrl: string }

/** The three files under one folder URL laid out as Vamper's public/models/ (yamnet/, mediapipe/). */
export function voiceModel(base: string): VoiceModel {
  const u = (p: string) => new URL(p, base.endsWith('/') ? base : base + '/').href;
  return {
    modelUrl: u('yamnet/yamnet.tflite'),
    loaderUrl: u('mediapipe/audio_wasm_module_internal.js'),
    wasmUrl: u('mediapipe/audio_wasm_module_internal.wasm'),
  };
}

export interface VoiceProgress {
  /** off: not asked for; loading: fetching the model; running; done; failed (why says why). */
  state: 'off' | 'loading' | 'running' | 'done' | 'failed';
  /** Share of the song listened to, 0..1, and a guess at the seconds left (from last time's speed on this machine). */
  done: number;
  etaSec: number | null;
  why: string;
}

const SR = 16000;
const SPEED_KEY = 'vamper:voice-speed';

export class VoicePass {
  progress: VoiceProgress = { state: 'off', done: 0, etaSec: null, why: '' };
  private worker: Worker | null = null;
  private hop = 0.975;

  constructor(private score: Score, private onChange: () => void) {}

  /** Listen to the whole song. Resolves true when the curve is complete, false if the pass could not run. */
  start(audio: AudioBuffer, model: VoiceModel): Promise<boolean> {
    const sc = this.score, dur = audio.duration;
    sc.envelopes.voice = { rate: 1 / this.hop, values: [] };
    sc.soundsFrontier = 0;
    let speed = 40, loadSec = 4;
    try { [speed, loadSec] = JSON.parse(localStorage.getItem(SPEED_KEY) ?? '') as [number, number]; } catch { /* first time: guess */ }
    const set = (p: Partial<VoiceProgress>) => { Object.assign(this.progress, p); this.onChange(); };
    set({ state: 'loading', done: 0, etaSec: loadSec + dur / speed, why: '' });
    return new Promise(resolve => {
      const fail = (why: string) => { this.stop(); set({ state: 'failed', etaSec: null, why }); resolve(false); };
      void resample(audio).then(pcm => {
        let w: Worker;
        try { w = this.worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' }); }
        catch { fail('no worker'); return; }
        // A failure deep inside the WebAssembly loader may never surface: give up after a while.
        setTimeout(() => { if (this.progress.state === 'loading' && this.worker === w) fail('the model did not load'); }, 60_000);
        w.onerror = e => fail(e.message || 'worker failed');
        w.onmessage = (ev: MessageEvent) => {
          const m = ev.data;
          if (m.type === 'ready') { loadSec = m.loadSec; set({ state: 'running' }); }
          else if (m.type === 'error') fail(m.message);
          else if (m.type === 'chunk') {
            const frames = m.frames as [number, number][], voice = sc.envelopes.voice!;
            if (frames.length > 1) this.hop = Math.max(0.2, frames[1][0] - frames[0][0]);
            voice.rate = 1 / this.hop;
            for (const [t, v] of frames) {
              const at = Math.round(t / this.hop);
              while (voice.values.length < at) voice.values.push(voice.values.at(-1) ?? 0);
              voice.values[at] = v;
            }
            sc.soundsFrontier = Math.min(dur, m.b);
            speed = m.b / Math.max(0.001, m.wallSec);
            set({ done: sc.soundsFrontier / dur, etaSec: (dur - sc.soundsFrontier) / speed });
          } else if (m.type === 'done') {
            sc.soundsFrontier = dur;
            this.stop();
            try { localStorage.setItem(SPEED_KEY, JSON.stringify([speed, loadSec])); } catch { /* fine */ }
            set({ state: 'done', done: 1, etaSec: 0 });
            resolve(true);
          }
        };
        w.postMessage({ type: 'start', pcm, ...model }, [pcm.buffer]);
      }, () => fail('could not resample'));
    });
  }

  stop() { this.worker?.terminate(); this.worker = null; }
}

/** The song as mono audio at 16 kHz, through the browser's own resampler. */
async function resample(buf: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * SR), SR);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}
