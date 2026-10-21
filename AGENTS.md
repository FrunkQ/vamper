# Notes for agents

Vamper: an RPG soundtrack looper (named after *vamping*, holding a phrase until the action moves on). The game master marks passages (cues) in a local song; in play they step forward and back and the music changes at the next bar with an inaudible join. Read `docs/TECHNOLOGY.md` for the plain-English tour, then `docs/ENGINE.md`, which maps every file. Keep both accurate when the code changes.

## How Alex likes to work

- Working code over ideas. Iterate on your own and show results. Keep code lean and readable by an LLM with a modest context window.
- Free, private, local: browser only, nothing uploaded, no accounts, no trackers.
- Never a blank screen; every wait shows progress and a time.
- The engine must stay small and framework-free: Alex reuses it in other apps. `Looper` (src/engine/looper.ts) is the public face; keep UI out of `src/engine`.
- The engine is a package other apps install from this repo by commit (Mappadux does: `"vamper": "github:FrunkQ/vamper#<commit>"`). Its public API is `src/index.ts`; changing anything exported there can break them, so add rather than rename. They compile the source with stricter flags than the app, so `npm run typecheck` (which includes `tsconfig.lib.json`) must pass. Files they get are listed in `package.json` `files`.
- Licence: MIT (since 2026-10-21; earlier versions were The Unlicense). Credit third-party code in the README. The files vendored from Gondryator keep their 'The Unlicense' header: that is the licence they came under.
- Alex listens on the deployed site, https://vamper.starsystemx.com. You can't judge audio in a container: ship, give the commit hash, and ask which joins they hear. The debug list (Joins) gives times to talk about.

## Rules of the engine

- Cut, fade and fit code lives only in `src/engine/cuts.ts`, so the deck and the join test can't drift apart. If you change how a join is made, `npm test` must still pass, and add a case if you found a new way to fail.
- Never assume a fixed tempo: lengths come from refined downbeats of the recording.
- The vendored analyser (`src/analysis`, `src/score/types.ts`) is unchanged from Gondryator commit 2f0fa70, except two unused fields removed from `analyzer.ts`. If you change it, say so at the top of the file, and bump `ENGINE_KEY` in `src/score/cache.ts` when the score changes.
- The voice pass (`src/analysis/voice.ts`, cut down from Gondryator's sound pass) is the only neural model, and it is optional: `new Looper({ voice })` turns it on, the app does, other apps must serve `public/models/` to use it. It runs after the fast analysis and never blocks playing; keep it that way. `@mediapipe/tasks-audio` is pinned exactly because its WebAssembly files in `public/models/mediapipe/` must match it: update both together. Voice decisions live in `plan.ts` (`voiceAcross`, `nextCut`), so the join test can check them. `?novoice` turns the pass off in the app; `window.__vamper` is the page's Looper, for headless checks.

## Deploy

Live at https://vamper.starsystemx.com, deployed by Cloudflare Workers Builds on every push to `main` (see README). The build stamp (commit and date) in the page header shows which build is live: `npm run build`, `npx wrangler deploy`, Node 22. `npm run preview` writes `.cache/artifact.html`, a one-file build for sharing before a deploy.

## Checks

`npx tsc` (types), `npm test` (headless join test, about 20 s), `npm run build`.
