# Vamper

A film-score looper for game masters. Installable browser app using your own music files.

In film and game scoring, *vamping* is holding a phrase until the action moves on; Vamper does that with any song. Drop in a song from your own machine; it finds the beats, bars and sections. Mark the passages you want (a quiet loop for exploring, a loud one for combat), then during the session just step forward and back, or click a section, and the music moves on at the next bar with a join you shouldn't hear.

**Use it at [vamper.starsystemx.com](https://vamper.starsystemx.com).** Everything runs in your browser. Nothing is uploaded, there are no accounts, and it's free. Install it from the browser's address bar (or the **Install app** button) and it opens in its own window, offline too.

## Use it

1. Drop a song on the page (MP3, WAV, FLAC, OGG, M4A). It is analysed in a few seconds and remembered for next time. Then it listens for singing and talking (a few seconds, while you can already play), so a change waits a bar or two rather than cut a sung line in half.
2. Until you make cues, every section is a cue. To make your own, drag across the waveform to select bars and press **+ Cue** (or `C`). Each cue loops until you move on, or plays **once** and carries on.
3. Play with `Space`, step with `←` `→`, jump with `1`-`9`, or click a block on the strip. The readout says when the change will land.

## Run it yourself

Node 22.12 or newer: `npm install`, `npm run dev`, open the printed URL. `npm test` runs the headless join test.

## Deploy (Cloudflare Workers)

The site is static files in `dist/`; `wrangler.jsonc` tells Cloudflare to serve them.

- **From the dashboard (deploys on every push to `main`):** Workers & Pages → Create → Import a repository → pick `FrunkQ/vamper`. Build command `npm run build`, deploy command `npx wrangler deploy`, root directory `/`. Node 22 comes from `.node-version`. Add your domain under the worker's Settings → Domains & Routes.
- **From your machine:** `npm run deploy` (builds, then `npx wrangler deploy`; it asks you to log in to Cloudflare the first time).

## Credits and licence

Public domain under [The Unlicense](LICENSE).

The music analysis (beats, bars, phrases, sections, moments), the score cache and the tag reader are vendored from [Gondryator](https://github.com/FrunkQ/gondryator) (The Unlicense), with thanks. The YIN pitch detector inside it is from A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", JASA 2002. The voice pass, which keeps changes from cutting a sung line, is cut down from the Gondryator's sound pass and runs Google's [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet) sound classifier (trained model, `public/models/yamnet/`) with [MediaPipe Tasks Audio](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-audio`, its WebAssembly runtime in `public/models/mediapipe/`), both © Google LLC under the Apache License 2.0 ([full text](licenses/Apache-2.0.txt)). The idea of jumping between similar parts of a song owes a lot to Paul Lamere's Infinite Jukebox.

**Have fun with this tech:** the same analyser drives [the Gondryator](https://gondryator.starsystemx.com/), which turns any song into a ride where the world keeps time with the music.

How it all works, in plain English with diagrams: [docs/TECHNOLOGY.md](docs/TECHNOLOGY.md). File-by-file reference: [docs/ENGINE.md](docs/ENGINE.md); notes for coding agents in [AGENTS.md](AGENTS.md).
