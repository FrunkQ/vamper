# Engine reference

The plain-English tour with diagrams is [TECHNOLOGY.md](TECHNOLOGY.md); this page maps the files.

```
song file ──decode──> AudioBuffer ──mono──> Analyzer (worker) ──> Score (beats, bars, phrases, sections)
                                    │                                   │
                                    └──> Cutter (cut points, fades) <───┘
                                                  │
                         Looper: cues, next/prev/goTo ──> Deck (Web Audio segments) ──> speakers
```

## Files

| File | What it does |
|---|---|
| `src/engine/looper.ts` | **The one class an app needs.** `load(file)`, `cues`, `goTo(i)`, `next()`, `prev()`, `play()`, `stop()`, `loop(from, to)`, `release()`, `state()`. Falls back to analysing on the main thread when a Worker can't be created. |
| `src/engine/deck.ts` | Live playback: a chain of `AudioBufferSourceNode`s, each with a gain node for its crossfades, queued 2.5 s ahead on the AudioContext clock. Quantised changes (`change`), loops (`setLoop`), play on (`release`). |
| `src/engine/cuts.ts` | Sample-level cuts, pure TypeScript: attack refinement, join fitting, the crossfade curve, the join score, and `render()` (the same chain, offline, for tests). |
| `src/engine/plan.ts` | Musical decisions on the score: bar starts, the next beat/bar/phrase, the following section, section letters. |
| `src/main.ts`, `src/view.ts` | The editor page, a thin layer over `Looper`: canvas strip and waveform, buttons, keys, cue list (saved in `localStorage` by file hash). |
| `src/analysis/*`, `src/score/*`, `src/audio/tags.ts` | Vendored from Gondryator, unchanged except the worker (no auto-tune) and the cache's database name. |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icon*` | The installable app: manifest, icons, and a service worker that caches the page (network first) and the hashed build files (cache first) so it opens offline. Bump `CACHE` in `sw.js` if its caching rules change. |
| `tools/join-test.mjs` | The headless join test (`npm test`). |

Using the engine elsewhere: copy `src/engine`, `src/analysis`, `src/score` and `src/audio/tags.ts`. No framework, no dependencies. The worker is loaded with `new URL('../analysis/worker.ts', import.meta.url)`, which Vite and webpack understand; elsewhere it quietly analyses on the main thread instead.

## Segments and joins

Playback is a list of segments of the source, `{ s, e }` in samples. Each segment after the first starts `XFADE` (20 ms) before its join and overlaps the end of the one before; the two crossfade over that overlap.

Where a join goes:

1. **The grid is only frame-accurate** (about 11.6 ms; on the test tracks bar lines are off by up to 13 ms). So every cut is refined: `findAttack` looks within ±15 ms of the grid beat for the biggest rise in 2 ms energy over the 5 ms before it, then walks back to where a soft attack starts. No 6 dB rise means no attack (a pad); the grid time is used.
2. **Cut just before the hit.** A join sits 3 to 20 ms before the attacks on both sides, so the hit plays whole on the new side and masks the join.
3. **Both cut points move together** (`fit`): the offset is chosen where the two sides of the crossfade differ least (smallest sum of squared differences), which picks either matching audio or a quiet spot. Moving both by the same amount keeps the groove exact.
4. **The fade adapts to the material:** `fadeGains(x, r)` is equal power for unrelated audio (r = 0), equal gain for identical audio (r = 1, so a loop of identical bars doesn't bump), and boosted for partly cancelling audio (r down to -0.5).
5. **Lengths come from the recording,** never from a tempo: a loop is the audio between two refined downbeats.

The join score (`Cutter.score`) is the loudness step between what would have followed the cut and what follows instead, over 80 ms. For a loop's wrap, more than 3 dB is flagged as likely audible (a red mark under the waveform, ⚠ in the debug list). For a change of section a big step is just the music changing.

## Changes

`Deck.change(target, loop, label)` finds the next quantise point after now + 120 ms (`beat`, `bar`, `phrase`, or `loop` = the end of the current pass), ends the playing segment there and queues the target. A change inside the passage being looped (`setLoop` with the playhead inside) just moves the wrap point. `release()` lets the loop play on into the song. The readout's countdown comes from `deck.pending`.

## The join test

`npm test` generates the three synthetic test tracks (Gondryator's generator), analyses them, and renders a session per track: a 4-bar loop three times, a change at the next bar mid-pass to the next section, then back to the loop. For every join it checks: no sample-to-sample jump larger than the track's own largest; loudness across the crossfade stays between the two sides (5 ms windows, within 1.5 dB, ignoring near-silence); and the bar spanning the join is as long as in the source, within 3 ms. The rendered WAVs are in `test-tracks/out/`.

What it can't tell you: whether a join on real music is heard. That's Alex's listening tests.

## Not yet

Riffing (re-ordering bars, needs per-bar features exposed from `Analyzer.barFeature()`), an AudioWorklet deck, grid repair (shift downbeat, halve/double, drag a bar line), cue sheets as JSON files and in IndexedDB, a big-button live mode, playlists.
