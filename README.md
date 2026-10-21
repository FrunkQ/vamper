# Vamper

A film-score looper for game masters. Installable browser app using your own music files.

In film and game scoring, *vamping* is holding a phrase until the action moves on; Vamper does that with any song. Drop in a song from your own machine; it finds the beats, bars and sections. Mark the passages you want (a quiet loop for exploring, a loud one for combat), then during the session just step forward and back, or click a section, and the music moves on at the next bar with a join you shouldn't hear.

**Use it at [vamper.starsystemx.com](https://vamper.starsystemx.com).** Everything runs in your browser. Nothing is uploaded, there are no accounts, and it's free. Install it from the browser's address bar (or the **Install app** button) and it opens in its own window, offline too.

## Use it

1. Drop a song on the page (MP3, WAV, FLAC, OGG, M4A). It is analysed in a few seconds and remembered for next time.
2. Until you make cues, every section is a cue. To make your own, drag across the waveform to select bars and press **+ Cue** (or `C`). Each cue loops until you move on, or plays **once** and carries on.
3. Play with `Space`, step with `←` `→`, jump with `1`-`9`, or click a block on the strip. The readout says when the change will land.

## Use the engine in your own app

The engine is a small, framework-free TypeScript library: one `Looper` class over Web Audio, a Worker and IndexedDB, no dependencies. [Mappadux](https://www.mappadux.com/) uses it for its local-song soundtracks. Install it straight from this repository, pinned to a commit, so you get exactly the engine that was tested here:

```
npm install github:FrunkQ/vamper#<commit>
```

```ts
import { Looper, barSpan } from 'vamper';

const looper = new Looper();
await looper.load(file, p => console.log(p.stage, Math.round(p.done * 100) + '%'));   // a File; wrap a Blob with new File([blob], name)

// Cues are passages of the song. barSpan turns rough seconds into whole bars.
const [calmFrom, calmTo] = barSpan(looper.score!, 0, 30);
const [fightFrom, fightTo] = barSpan(looper.score!, 95, 125);
looper.cues = [
  { name: 'Calm',  from: calmFrom,  to: calmTo,  mode: 'loop' },
  { name: 'Fight', from: fightFrom, to: fightTo, mode: 'loop' },
];

looper.goTo(0);            // starts at once from silence
looper.goTo(1);            // while playing: changes on the next bar, seamlessly
looper.state();            // position, bar, current cue, the pending change and its countdown
looper.setVolume(0.8, 1.5); looper.pause(); looper.resume(); looper.dispose();
```

- **It's TypeScript source**, compiled by your bundler. With Vite, add `optimizeDeps: { exclude: ['vamper'] }` so the analysis worker loads (without a worker it still works, on the main thread). For Vitest, add `test.server.deps.inline: ['vamper']`.
- **Make the first `play`/`goTo` from a click**, as browsers require for audio.
- **Analysis is cached** per song (by content hash) in the browser's IndexedDB, in a database called `vamper`, so each song is analysed once per device.
- **To take an update**, re-pin to a newer commit; Mappadux's `npm run vamper:update` does it in one step. The public API is everything exported from [`src/index.ts`](src/index.ts) and only grows: names are added, not renamed.

How it works inside: [docs/TECHNOLOGY.md](docs/TECHNOLOGY.md). Every method and file: [docs/ENGINE.md](docs/ENGINE.md).

**Please credit Vamper** where your users can see it, such as an About page or credits list: *Music engine: [Vamper](https://github.com/FrunkQ/vamper) by FrunkQ.*

## Run it yourself

Node 22.12 or newer: `npm install`, `npm run dev`, open the printed URL. `npm test` runs the headless join test.

## Deploy (Cloudflare Workers)

The site is static files in `dist/`; `wrangler.jsonc` tells Cloudflare to serve them.

- **From the dashboard (deploys on every push to `main`):** Workers & Pages → Create → Import a repository → pick `FrunkQ/vamper`. Build command `npm run build`, deploy command `npx wrangler deploy`, root directory `/`. Node 22 comes from `.node-version`. Add your domain under the worker's Settings → Domains & Routes.
- **From your machine:** `npm run deploy` (builds, then `npx wrangler deploy`; it asks you to log in to Cloudflare the first time).

## Credits and licence

Public domain under [The Unlicense](LICENSE).

The music analysis (beats, bars, phrases, sections, moments), the score cache and the tag reader are vendored from [Gondryator](https://github.com/FrunkQ/gondryator) (The Unlicense), with thanks. The YIN pitch detector inside it is from A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", JASA 2002. The idea of jumping between similar parts of a song owes a lot to Paul Lamere's Infinite Jukebox.

**Have fun with this tech:** the same analyser drives [the Gondryator](https://gondryator.starsystemx.com/), which turns any song into a ride where the world keeps time with the music.

How it all works, in plain English with diagrams: [docs/TECHNOLOGY.md](docs/TECHNOLOGY.md). File-by-file reference: [docs/ENGINE.md](docs/ENGINE.md); notes for coding agents in [AGENTS.md](AGENTS.md).
