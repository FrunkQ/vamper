// The engine as a package: what another app imports (`import { Looper } from 'vamper'`).
// Everything here is plain TypeScript over Web Audio, a Worker and IndexedDB; see docs/ENGINE.md.
export { Looper, type Cue, type LoadProgress, type LooperOptions, type LooperState } from './engine/looper';
export { voiceModel, type VoiceModel, type VoiceProgress } from './analysis/voice';
export type { JoinLog } from './engine/deck';
export { barSpan, barStarts, barIndexAt, lastBar, snapToBar, sectionNames, voiceAt, voiceAcross, type Quantise } from './engine/plan';
export type { Score, Section } from './score/types';
