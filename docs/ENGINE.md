# Engine reference

The plain-English tour with diagrams is [TECHNOLOGY.md](TECHNOLOGY.md); this page maps the files.

```
song file ──decode──> AudioBuffer ──mono──> Analyzer (worker) ──> Score (beats, bars + bar features, phrases, sections)
                                    │                                   │
                                    └──> Cutter (cut points, fades) <───┘
                                                  │
                         Looper: cues, next/prev/goTo ──> Deck (Web Audio segments) ──> speakers
                                    │
           (optional) VoicePass: YAMNet (worker) ──> score.envelopes.voice ──> changes wait for a gap
```

## Files

| File | What it does |
|---|---|
| `src/index.ts` | The package entry: everything another app may import. |
| `src/engine/looper.ts` | **The one class an app needs.** `load(file)`, `cues`, `goTo(i)`, `next()`, `prev()`, `play()`, `stop()`, `loop(from, to)`, `release()`, `pause()`, `resume()`, `setVolume(gain, rampSec)`, `dispose()`, `state()`. Falls back to analysing on the main thread when a Worker can't be created. |
| `src/engine/deck.ts` | Live playback: a chain of `AudioBufferSourceNode`s, each with a gain node for its crossfades, queued 2.5 s ahead on the AudioContext clock. Quantised changes (`change`), loops (`setLoop`), play on (`release`). |
| `src/engine/cuts.ts` | Sample-level cuts, pure TypeScript: attack refinement, join fitting, the crossfade curve, the join score, and `render()` (the same chain, offline, for tests). |
| `src/engine/riff.ts` | Riffing: `Riff` builds the bar graph of a passage (`jumps`, from `score.bars` and the Cutter's join score) and walks it with a seeded random generator (`start(k)`, `next()` gives the next run of bars). `barSimilarity`, `seedOf`. |
| `src/engine/plan.ts` | Musical decisions on the score: bar starts, the next beat/bar/phrase, the following section, section letters; the voice curve (`voiceAt`, `voiceAcross`) and the voice-aware next cut (`nextCut`). |
| `src/analysis/voice.ts`, `voice.worker.ts` | The voice pass: YAMNet (via MediaPipe, WebAssembly) in a worker writes `score.envelopes.voice`, final up to `score.soundsFrontier`. Cut down from Gondryator's sound pass. The model files are `public/models/`. |
| `src/main.ts`, `src/view.ts` | The editor page, a thin layer over `Looper`: canvas strip and waveform, buttons, keys, cue list (saved in `localStorage` by file hash). |
| `src/analysis/*`, `src/score/*`, `src/audio/tags.ts` | Vendored from Gondryator, unchanged except the worker (no auto-tune), the cache's database name and the voice pass (above). |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icon*` | The installable app: manifest, icons, and a service worker that caches the page (network first) and the hashed build files (cache first) so it opens offline. Bump `CACHE` in `sw.js` if its caching rules change. |
| `tools/join-test.mjs` | The headless join test (`npm test`): a loop-and-change session and a 32-bar riff per track, the riff walk's rules, and the voice-aware choice of bar on a made-up voice curve. |

Using the engine elsewhere: install it from this repository, pinned to a commit (`npm install github:FrunkQ/vamper#<commit>`), rather than copying files, so every fix arrives exactly. The README's "Use the engine in your own app" has a worked example; Mappadux is the first app to use it (`src/audio/VamperSongPlayer.ts` there).

- **The package** is TypeScript source: `exports` points at `src/index.ts`, and `files` in `package.json` lists what an app receives (the engine, analysis, score cache, tag reader, licence and docs). The app's bundler compiles it.
- **Public API** = what `src/index.ts` exports. Add to it; don't rename or remove, or a pinned app breaks on its next update.
- **Strictness:** `tsconfig.lib.json` compiles the engine under Mappadux's flags (`exactOptionalPropertyTypes`, `noUnused*`, `verbatimModuleSyntax`); `npm run typecheck` runs it, and so does CI.
- **Worker:** loaded with `new URL('../analysis/worker.ts', import.meta.url)`, which Vite and webpack understand (with Vite, list `vamper` in `optimizeDeps.exclude`); elsewhere it quietly analyses on the main thread instead.
- **Cues:** a `once` cue plays on from `from` to the end of the song; its `to` is ignored. `barSpan(score, from, to)` turns rough seconds into a whole-bar passage at least one bar long (`to` null = the last bar).
- **Storage:** scores are cached in IndexedDB database `vamper` (store `scores`), keyed by a hash of the file.

**The voice pass is opt-in** for other apps, because it needs the model files served: copy Vamper's `public/models/` folder (it comes with the package, in `node_modules/vamper/public/models/`) (YAMNet, about 4 MB, and MediaPipe's WebAssembly runtime, about 7 MB) to your app's static files and pass its URL:

```ts
import { Looper, voiceModel } from 'vamper';
const looper = new Looper({ voice: voiceModel(new URL('models/', document.baseURI).href) });
looper.voice;            // { state: 'off' | 'loading' | 'running' | 'done' | 'failed', done, etaSec, why }
looper.voiceWaitBars = 2; // how many extra bars a change may wait for a gap in the vocal (0: never)
```

`load()` still resolves when the song is playable; the voice pass carries on behind it (`onChange` fires as it goes) and saves its curve with the cached score. Without the option nothing changes, and the pass's worker (about 57 kB, it pulls in `@mediapipe/tasks-audio`, Vamper's one dependency) is never loaded.


## Segments and joins

Playback is a list of segments of the source, `{ s, e }` in samples. Each segment after the first starts `XFADE` (20 ms) before its join and overlaps the end of the one before; the two crossfade over that overlap.

Where a join goes:

1. **The grid is only frame-accurate** (about 11.6 ms; on the test tracks bar lines are off by up to 13 ms). So every cut is refined: `findAttack` looks within ±15 ms of the grid beat for the biggest rise in 2 ms energy over the 5 ms before it, then walks back to where a soft attack starts. No 6 dB rise means no attack (a pad); the grid time is used.
2. **Cut just before the hit.** A join sits 3 to 20 ms before the attacks on both sides, so the hit plays whole on the new side and masks the join.
3. **Both cut points move together** (`fit`): the offset is chosen where the two sides of the crossfade differ least (smallest sum of squared differences), which picks either matching audio or a quiet spot. Moving both by the same amount keeps the groove exact.
4. **The fade adapts to the material:** `fadeGains(x, r)` is equal power for unrelated audio (r = 0), equal gain for identical audio (r = 1, so a loop of identical bars doesn't bump), and boosted for partly cancelling audio (r down to -0.5).
5. **Lengths come from the recording,** never from a tempo: a loop is the audio between two refined downbeats.

**Voice.** With a voice curve, `Deck.change` asks `nextCut` (plan.ts) instead of `nextBoundary`: when the voice is above `VOICE_QUIET` (0.3) on both sides of the next quantise point (±0.3 s), it may wait up to `voiceWaitBars` (2) more bars for one that isn't, else takes the least-bad (a phrase start counts 0.2 better). `pending.forVoice` says it waited. Every `JoinLog` carries `voice`, the worse of `voiceAcross` at its two grid times (null where the pass hasn't listened). A loop's own wrap is where the cue says, so the editor flags a cue whose wrap cuts a vocal instead.

The join score (`Cutter.score`) is the loudness step between what would have followed the cut and what follows instead, over 80 ms. For a loop's wrap, more than 3 dB is flagged as likely audible (a red mark under the waveform, ⚠ in the debug list). For a change of section a big step is just the music changing.

## Riffs

A `riff` cue (`{ mode: 'riff', seed? }`) stays inside its passage like a loop but plays its bars in a varied order. `Looper.riffFor(cue)` builds the `Riff`; `Deck.setRiff(a, b, riff)` plays it (inside the passage: the playing segment ends at the next reachable bar line and the walk starts there; outside: a change, as for a loop).

**Bar features.** The analyser's per-bar features go into the score as `score.bars` (one `BarFeature` per bar: `grid` 3×16 drum velocities, `chroma` 12, `bass` pitch-class histogram 12, band `db` 3, `density` 3), rounded to two decimals, about 400 bytes a bar. Scores cached before this (`ENGINE_KEY` v9) are re-analysed once.

**The graph.** Over the passage's n bars, bar i is followed by i+1 (the last by the first: the loop's own wrap), and may jump to j when:
- j keeps the place in the phrase: `(j − (i+1)) mod unit = 0`, where `unit` is 4 for passages of whole phrases of 8+ bars, 2 for other even lengths, else 1;
- `0.65 × barSimilarity(j, i+1) + 0.35 × barSimilarity(j−1, i)` ≥ 0.8 (`minSimilarity`). `barSimilarity` is the cosine of the drum grid, chroma and bass histogram (weights 1, 0.64, 0.36, as the analyser compares phrases), less 0.03 per dB of band loudness difference beyond 2 dB;
- the cut's loudness step (`Cutter.score` between the bar it lands on and the bar that would have played: i+1, or the first bar after the last) is at most 3 dB (`maxDb`).
Without bar features (an old or MIDI score) the similarity is `1 − step/6`.

**The walk** (`Riff.next`): bars in order until a jump is due. A jump is due `jumpEvery − 1` to `jumpEvery + 1` bars (default 3 to 5) after the last, at a phrase start (or up to two bars later if none comes), never the same jump twice running, and only where `voiceClear`: no voice across the cut or the landing (checked live, so the voice curve can arrive later). Choices are weighted by `(sim − 0.7)² + 0.01`. The random generator is seeded (`seed`, else `seedOf(songHash:cueStart)`), so the same cue from the same bar replays the same riff. Each run of bars in order is one segment; jumps are logged as `JoinLog` `kind: 'riff'` with `riff: { after, into, sim }` (song bars); the wrap is `kind: 'loop'`. `state().riff` has the path (song bars, latest last, including what is queued) and the passage's jump count.

## Changes

`Deck.change(target, loop, label)` finds the next quantise point after now + 120 ms (`beat`, `bar`, `phrase`, or `loop` = the end of the current pass), ends the playing segment there and queues the target. A change inside the passage being looped (`setLoop` with the playhead inside) just moves the wrap point. `release()` lets the loop play on into the song. The readout's countdown comes from `deck.pending`.

## The join test

`npm test` generates the three synthetic test tracks (Gondryator's generator), analyses them, and renders a session per track: a 4-bar loop three times, a change at the next bar mid-pass to the next section, then back to the loop. For every join it checks: no sample-to-sample jump larger than the track's own largest; loudness across the crossfade stays between the two sides (5 ms windows, within 1.5 dB, ignoring near-silence); and the bar spanning the join is as long as in the source, within 3 ms. The rendered WAVs are in `test-tracks/out/`.

What it can't tell you: whether a join on real music is heard. That's Alex's listening tests.

## Not yet

Voice-aware snapping of cue ends when they are made; voice-aware loop wraps. Riffs that follow the game's intensity (a riff cue that leans toward its louder bars as tension rises); an AudioWorklet deck, grid repair (shift downbeat, halve/double, drag a bar line), cue sheets as JSON files and in IndexedDB, a big-button live mode, playlists.
