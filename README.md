# Vamper

*Vamp till ready*: music that waits for the game. A browser app for game masters, using your own music files.

In film and game scoring, *vamping* is holding a phrase until the action moves on; Vamper does that with any song. Drop in a song from your own machine; it finds the beats, bars and sections, and marks the parts it can wait in. Press Play: the song plays from the top and, at each marked part, keeps playing that part (riffing on its bars, or repeating them) until you press **Go on**. The music moves on at the next bar with a join you shouldn't hear. Keep a rack of songs, a click apart, for the whole session.

**Use it at [vamper.sublime.co.uk](https://vamper.sublime.co.uk).** Everything runs in your browser: nothing is uploaded, there are no accounts, and it's free. Install it from the browser's address bar (or the **Install app** button) and it opens in its own window, offline too. Questions, songs that misbehave, ideas: [Discord](https://discord.gg/aec5rGTcyC). If it earns a place at your table: [Ko-fi](https://ko-fi.com/frunkq).

## Use it

1. Drop a song on the page (MP3, WAV, FLAC, OGG, M4A). It is listened to in a few seconds and remembered for next time. Then it listens for singing and talking (a few seconds more, while you can already play): a sung part repeats rather than riffs, and a change waits a bar or two rather than cut a sung line in half.
2. The parts the song will wait in are coloured on the strip: green **riffs** (the band plays the part's bars in a fresh order, so a long scene doesn't hear the same tape over and over), blue **loops** (the part repeats as it is, when its bars are too different to riff on, or it is sung). Pink is singing or talking.
3. **Play** starts from the top; the song holds at each coloured part until **Go on** (`→` or `Enter`); **Back** (`←`) returns to the part before. **Pause** (`Space`) fades out for when the phone rings, and Resume comes back in from a bar or so before. **Duck** (`D`) halves the loudness while you talk, **Mute** (`M`) silences it; both come straight back. Click a part on the strip to switch its hold on or off, click the waveform to play from there, `1`-`9` jump to a part. The readout says what the music is doing and when a change will land.
4. **Fine-tune**, underneath, lists every part: switch one off to let the song play through it, make it riff or loop, roll another riff (🎲), or drag across the waveform and **Add** your own bars. Choices are remembered per song.
5. **The rack.** Add more songs (they are read while the music plays on), give each a name for the game (Tavern, Ambush, Court) and a colour, and jump between them with ▶. The rack shows how much memory the songs take. It is kept in your browser, so next time the songs are a click away.
6. **A pack.** *Save as a pack* writes one `.vamper` file with the songs, their names, colours and holds. Drop it on Vamper on another machine, or give it to a co-GM.

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
  { name: 'Fight', from: fightFrom, to: fightTo, mode: 'riff' },   // its bars in a varied order; add seed: n to pick a riff
];

looper.goTo(0);            // starts at once from silence
looper.goTo(1);            // while playing: changes on the next bar, seamlessly
looper.state();            // position, bar, current cue, the pending change and its countdown
looper.setVolume(0.8, 1.5);   // the master level, faded over 1.5 s (duck and mute are just this)
looper.pause(); looper.resume(); // fades out and freezes; comes back from a bar line a moment earlier, fading in
looper.dispose();

// Several songs: add() reads one while the music plays on; select() makes it the one played.
const tavern = await looper.add(otherFile);   // in looper.songs; looper.select(looper.songs.indexOf(tavern))

// Or let the engine find the holds and wait at them, as the Vamper page does:
looper.cues = looper.holds().map(h => ({ name: h.name, from: h.from, to: h.to, mode: h.mode, hold: h.suggested }));
looper.autoHold = true;   // playing on into a loop or riff cue holds there
looper.play(0);           // from the top; looper.release() lets a hold go, and the song waits at the next
```

- **It's TypeScript source**, compiled by your bundler. With Vite, add `optimizeDeps: { exclude: ['vamper'] }` so the analysis worker loads (without a worker it still works, on the main thread). For Vitest, add `test.server.deps.inline: ['vamper']`.
- **Make the first `play`/`goTo` from a click**, as browsers require for audio.
- **Analysis is cached** per song (by content hash) in the browser's IndexedDB, in a database called `vamper`, so each song is analysed once per device.
- **To take an update**, re-pin to a newer commit; Mappadux's `npm run vamper:update` does it in one step. The public API is everything exported from [`src/index.ts`](src/index.ts) and only grows: names are added, not renamed.
- **Credit it** where your users can see it, such as an About page: *Music engine: [Vamper](https://github.com/FrunkQ/vamper) by FrunkQ.* The licence asks for that (it ships in the package; see [Credits and licence](#credits-and-licence)).

Every method and file: [docs/ENGINE.md](docs/ENGINE.md).

## Run it yourself

Node 22.12 or newer: `npm install`, `npm run dev`, open the printed URL. Checks: `npm run typecheck` (the app and the stricter engine build), `npm test` (the headless join test: joins, riffs, holds, voice-aware changes), `npm run build`.

## Deploy (Cloudflare Workers)

The site is static files in `dist/`; `wrangler.jsonc` tells Cloudflare to serve them.

- **From the dashboard (deploys on every push to `main`):** Workers & Pages → Create → Import a repository → pick `FrunkQ/vamper`. Build command `npm run build`, deploy command `npx wrangler deploy`, root directory `/`. Node 22 comes from `.node-version`. Add your domain under the worker's Settings → Domains & Routes.
- **From your machine:** `npm run deploy` (builds, then `npx wrangler deploy`; it asks you to log in to Cloudflare the first time).

## Credits and licence

[MIT plus a credit](LICENSE), copyright Alex (FrunkQ). Use it, change it and ship it, including commercially. Two things are asked: keep the copyright and licence notice with any copy of the code, and credit Vamper by name with a link, where your audience can see it. For a game, app or website that is the credits or About page; for a live production, stream, video, podcast or show, the credits, description or programme: *Vamper, https://github.com/FrunkQ/vamper*. No fee, no approval, no notice.

Versions up to commit `e938185` (4 November 2026) were plain MIT, and versions before 21 October 2026 (up to commit `f4bfc39`) The Unlicense; those stay so.

The music analysis (beats, bars, phrases, sections, moments), the score cache and the tag reader are vendored from [Gondryator](https://github.com/FrunkQ/gondryator) (The Unlicense), with thanks. The YIN pitch detector inside it is from A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", JASA 2002. The voice pass, which keeps changes from cutting a sung line, is cut down from the Gondryator's sound pass and runs Google's [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet) sound classifier (trained model, `public/models/yamnet/`) with [MediaPipe Tasks Audio](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-audio`, its WebAssembly runtime in `public/models/mediapipe/`), both © Google LLC under the Apache License 2.0 ([full text](licenses/Apache-2.0.txt)). The idea of jumping between similar parts of a song owes a lot to Paul Lamere's Infinite Jukebox.

**Have fun with this tech:** the same analyser drives [the Gondryator](https://gondryator.starsystemx.com/), which turns any song into a ride where the world keeps time with the music.

How it all works, in plain English with diagrams: [docs/TECHNOLOGY.md](docs/TECHNOLOGY.md). File-by-file reference: [docs/ENGINE.md](docs/ENGINE.md); notes for coding agents in [AGENTS.md](AGENTS.md).
