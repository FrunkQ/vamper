// The engine as a package: what another app imports (`import { Looper } from 'vamper'`).
// Everything here is plain TypeScript over Web Audio, a Worker and IndexedDB; see docs/ENGINE.md.
export { Looper, type Cue, type LoadProgress, type LooperState } from './engine/looper';
export type { JoinLog } from './engine/deck';
export { barSpan, barStarts, barIndexAt, lastBar, snapToBar, sectionNames, type Quantise } from './engine/plan';
export type { Score, Section } from './score/types';
