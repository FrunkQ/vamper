# Notes for agents

Vamper: an RPG soundtrack looper (named after *vamping*, holding a phrase until the action moves on). The game master marks passages (cues) in a local song; in play they step forward and back and the music changes at the next bar with an inaudible join. Read `docs/ENGINE.md` first; it maps every file.

## How Alex likes to work

- Working code over ideas. Iterate on your own and show results. Keep code lean and readable by an LLM with a modest context window.
- Free, private, local: browser only, nothing uploaded, no accounts, no trackers.
- Never a blank screen; every wait shows progress and a time.
- The engine must stay small and framework-free: Alex reuses it in other apps. `Looper` (src/engine/looper.ts) is the public face; keep UI out of `src/engine`.
- Licence: The Unlicense; credit third-party code in the README.
- Alex listens on the deployed site, https://vamper.starsystemx.com. You can't judge audio in a container: ship, give the commit hash, and ask which joins they hear. The debug list (Joins) gives times to talk about.

## Rules of the engine

- Cut, fade and fit code lives only in `src/engine/cuts.ts`, so the deck and the join test can't drift apart. If you change how a join is made, `npm test` must still pass, and add a case if you found a new way to fail.
- Never assume a fixed tempo: lengths come from refined downbeats of the recording.
- The vendored analyser (`src/analysis`, `src/score/types.ts`) is unchanged from Gondryator commit 2f0fa70. If you change it, say so at the top of the file, and bump `ENGINE_KEY` in `src/score/cache.ts` when the score changes.

## Deploy

Live at https://vamper.starsystemx.com, deployed by Cloudflare Workers Builds on every push to `main` (see README). The build stamp (commit and date) in the page header shows which build is live: `npm run build`, `npx wrangler deploy`, Node 22. `npm run preview` writes `.cache/artifact.html`, a one-file build for sharing before a deploy.

## Checks

`npx tsc` (types), `npm test` (headless join test, about 20 s), `npm run build`.
