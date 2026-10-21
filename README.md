# Music Looper

A film-score looper for game masters. Drop in a song from your own machine; it finds the beats, bars and sections. Mark the passages you want (a quiet loop for exploring, a loud one for combat), then during the session just step forward and back, or click a section, and the music moves on at the next bar with a join you shouldn't hear.

Everything runs in your browser. Nothing is uploaded, there are no accounts, and it's free.

## Use it

1. Drop a song on the page (MP3, WAV, FLAC, OGG, M4A). It is analysed in a few seconds and remembered for next time.
2. Until you make cues, every section is a cue. To make your own, drag across the waveform to select bars and press **+ Cue** (or `C`). Each cue loops until you move on, or plays **once** and carries on.
3. Play with `Space`, step with `←` `→`, jump with `1`-`9`, or click a block on the strip. The readout says when the change will land.

## Run it yourself

Node 22.12 or newer: `npm install`, `npm run dev`, open the printed URL. `npm test` runs the headless join test. `npm run build` then `npx wrangler deploy` publishes `dist/` to Cloudflare Workers.

## Credits and licence

Public domain under [The Unlicense](LICENSE).

The music analysis (beats, bars, phrases, sections, moments), the score cache and the tag reader are vendored from [Gondryator](https://github.com/FrunkQ/gondryator) (The Unlicense), with thanks. The YIN pitch detector inside it is from A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", JASA 2002. The idea of jumping between similar parts of a song owes a lot to Paul Lamere's Infinite Jukebox.

Technical notes are in [docs/ENGINE.md](docs/ENGINE.md); notes for coding agents in [AGENTS.md](AGENTS.md).
