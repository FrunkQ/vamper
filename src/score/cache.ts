// Score cache in IndexedDB, keyed by a hash of the audio file, so a song is analysed once.
// Vendored from Gondryator (src/score/cache.ts); only the database name differs.
import type { Score } from './types';

const DB = 'music-looper';
const STORE = 'scores';
const ENGINE_KEY = 'v9'; // bump when the analysis changes so stale scores are ignored

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function hashFile(buf: ArrayBuffer): Promise<string> {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Non-secure context: a cheap content hash.
    const u8 = new Uint8Array(buf);
    let h = 2166136261;
    for (let i = 0; i < u8.length; i += 97) { h ^= u8[i]; h = Math.imul(h, 16777619); }
    return 'f' + (h >>> 0).toString(16) + u8.length.toString(16);
  }
}

export async function loadScore(hash: string): Promise<Score | null> {
  try {
    const db = await open();
    return await new Promise(resolve => {
      const r = db.transaction(STORE).objectStore(STORE).get(ENGINE_KEY + ':' + hash);
      r.onsuccess = () => resolve((r.result as Score) ?? null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function saveScore(score: Score): Promise<void> {
  try {
    const db = await open();
    const copy = { ...score, track: { ...score.track, art: null } };
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(copy, ENGINE_KEY + ':' + score.track.hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* storage unavailable: fine */ }
}
