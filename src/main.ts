// The page: a thin layer over the Looper (src/engine/looper.ts). Drop a song; it is analysed and
// its holds (the parts the music can wait in) are found and armed; Play starts from the top and
// the song waits at each hold until Go on. Several songs sit in a rack with friendly names, a click
// apart. Fine-tuning (which parts hold, riff or loop, your own bars) folds away underneath.
// Choices are saved per song in this browser.
import { Looper, type Cue, type Song } from './engine/looper';
import { voiceShare, RIFF_VOICE_MAX, type Hold } from './engine/holds';
import { barStarts, snapToBar, type Quantise } from './engine/plan';
import { voiceModel } from './analysis/voice';
import { draw, stripHit, STRIP, type ViewState } from './view';

declare const __BUILD__: string;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$('build').textContent = __BUILD__;

// Installable app: the service worker (public/sw.js) caches the page so it opens offline.
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('./sw.js').catch(() => { /* no offline: fine */ });
let installPrompt: any = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('install').hidden = false; });
$('install').onclick = () => { installPrompt?.prompt(); installPrompt = null; $('install').hidden = true; };

// The voice pass's model and runtime are served from public/models/ (?novoice turns it off).
const looper = new Looper(new URLSearchParams(location.search).has('novoice') ? {} : { voice: voiceModel(new URL('models/', document.baseURI).href) });
looper.autoHold = true;
const ui: ViewState = { selection: null };
(window as any).__vamper = looper; // for headless checks and the console
const canvas = $<HTMLCanvasElement>('view');
let hash = '';
let holds: Hold[] = [];
let built = ''; // what the cues were last built from

// ---- loading ----

// Songs go into the rack one after another; the first (or any added while nothing plays) is
// selected at once so its analysis can be watched. The rest are read while the music plays on.
let reading = 0;
async function addSongs(files: FileList | File[]) {
  $('welcome').hidden = true; $('song').hidden = false;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('audio') && !/\.(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/i.test(file.name)) continue;
    reading++;
    const name = aliasOf(file.name, null);
    $('progress').hidden = false;
    try {
      const song = await looper.add(file, p => {
        $('bar').style.width = `${Math.round(p.done * 100)}%`;
        $('progress-text').textContent =
          p.stage === 'decode' ? `Opening ${name}…` :
          p.stage === 'analyse' ? `Listening to ${name} for the beat and the parts of the song… ${Math.round(p.done * 100)}%${p.etaSec !== null ? `, about ${Math.ceil(p.etaSec)} s left` : ''}` :
          p.cached ? `Heard ${name} before: ready at once.` : `Heard the whole of ${name}.`;
      }, looper.songs.length === 0 || !looper.deck.playing);
      void keep(file, song.hash);
    } catch (e) { $('progress-text').textContent = `Couldn't open ${name}: ${(e as Error).message}`; }
    reading--;
    renderRack();
  }
  setTimeout(() => { if (!listening() && !reading) $('progress').hidden = true; }, 1500);
}
looper.onChange = () => {
  if (looper.score && looper.score.track.hash !== hash) { hash = looper.score.track.hash; prefs = loadPrefs(hash); ui.selection = null; built = ''; }
  const t = looper.score?.track;
  $('track').textContent = t ? `${looper.song ? aliasOf(looper.song.name, looper.song) : t.title}${t.artist ? ' · ' + t.artist : ''} · ${looper.score!.tempo.at(-1)?.bpm ?? '?'} bpm · ${looper.score!.beats.filter(b => b.downbeat).length} bars` : 'Music that waits for the game.';
  renderRack();
};

$<HTMLInputElement>('file0').onchange = e => { const f = (e.target as HTMLInputElement).files; if (f?.length) void addSongs(f); (e.target as HTMLInputElement).value = ''; };
window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
window.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drag'); const f = e.dataTransfer?.files; if (f?.length) void addSongs(f); });

// ---- the rack is kept on disk (the browser's own storage), so it is back on the next visit ----

interface Kept { hash: string; name: string; type: string; data: Blob; added: number }
let kept: Kept[] = [];
function rackDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('vamper-rack', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'hash' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function keep(file: File, hash: string) {
  try {
    const db = await rackDb(), tx = db.transaction('songs', 'readwrite');
    tx.objectStore('songs').put({ hash, name: file.name, type: file.type, data: file, added: Date.now() } satisfies Kept);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    await listKept();
  } catch { /* storage off: the rack lasts this visit only */ }
}
async function forget(hash: string) {
  try { const db = await rackDb(), tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').delete(hash); await new Promise(r => { tx.oncomplete = r; tx.onerror = r; }); await listKept(); } catch { /* fine */ }
}
async function listKept() {
  try {
    const db = await rackDb(), req = db.transaction('songs').objectStore('songs').getAll();
    kept = await new Promise<Kept[]>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    kept.sort((a, b) => a.added - b.added);
  } catch { kept = []; }
  rackShown = ''; renderRack();
}
const bringBack = (k: Kept) => addSongs([new File([k.data], k.name, { type: k.type })]);
void listKept().then(() => { if (kept.length) { $('welcome').hidden = true; $('song').hidden = false; $('readout').textContent = `Your songs from last time are in the rack: press ▶ on one to bring it back${kept.length > 1 ? ', or Bring them all back' : ''}.`; } });

// ---- the rack: the songs held, with friendly names, a click apart ----

function aliasOf(fileName: string, song: Song | null): string {
  try { const a = song && localStorage.getItem('alias:' + song.hash); if (a) return a; } catch { /* fine */ }
  return song?.title || fileName.replace(/\.[^.]+$/, '');
}
/** Inks to tag a song by its feel: a fight, a forest, the sea, something eerie… cycled with the swatch, kept per song. */
const INKS = ['', '#b5362b', '#c77a1f', '#4f8a5b', '#3f6e9c', '#6e4f9c', '#555'];
const inkOf = (s: Song) => { try { return localStorage.getItem('ink:' + s.hash) ?? ''; } catch { return ''; } };
let rackShown = '';
function renderRack() {
  const key = looper.songs.map(s => `${s.hash}:${s.score.final}:${looper.voiceOf(s).state}:${inkOf(s)}`).join('|') + `:${looper.songs.indexOf(looper.song!)}:${reading}:` + kept.map(k => k.hash).join('|');
  if (key === rackShown) return;
  rackShown = key;
  const box = $('rack');
  box.innerHTML = '';
  looper.songs.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'chip' + (s === looper.song ? ' now' : '');
    const ink = inkOf(s);
    if (ink) { el.style.borderLeftColor = ink; el.style.borderLeftWidth = '8px'; el.style.borderLeftStyle = 'solid'; }
    const state = !s.score.final ? ' · reading…' : looper.voiceOf(s).state === 'running' || looper.voiceOf(s).state === 'loading' ? ' · listening for singing…' : '';
    el.innerHTML = `<button data-ink class="ink" title="Colour it by its feel: a fight, a forest, the sea, something eerie…" style="background:${ink || 'transparent'}"></button><button data-play title="Play this song from the top">▶</button><input value="${aliasOf(s.name, s).replace(/"/g, '&quot;')}" title="Give the song a name for the game: Tavern, Ambush, Court…" /><small>${Math.round(s.buffer.duration / 60)} min${state}</small><button data-del title="Take it out of the rack">✕</button>`;
    el.querySelector<HTMLButtonElement>('[data-play]')!.onclick = () => { looper.select(i); looper.play(0); };
    el.querySelector<HTMLButtonElement>('[data-ink]')!.onclick = () => { try { localStorage.setItem('ink:' + s.hash, INKS[(INKS.indexOf(ink) + 1) % INKS.length]); } catch { /* fine */ } rackShown = ''; renderRack(); };
    el.querySelector('input')!.onchange = e => { try { localStorage.setItem('alias:' + s.hash, (e.target as HTMLInputElement).value.trim()); } catch { /* fine */ } rackShown = ''; looper.onChange?.(); };
    el.querySelector<HTMLButtonElement>('[data-del]')!.onclick = () => { looper.remove(i); void forget(s.hash); if (!looper.song && looper.songs.length) looper.select(Math.min(i, looper.songs.length - 1)); if (!looper.songs.length && kept.length <= 1) { $('song').hidden = true; $('welcome').hidden = false; } };
    box.append(el);
  });
  // Songs kept from last time, not brought back yet: dim, a ▶ away.
  const waiting = kept.filter(k => !looper.songs.some(s => s.hash === k.hash));
  for (const k of waiting) {
    const el = document.createElement('div');
    el.className = 'chip kept';
    let alias = k.name.replace(/\.[^.]+$/, '');
    try { alias = localStorage.getItem('alias:' + k.hash) || alias; } catch { /* fine */ }
    const ink = (() => { try { return localStorage.getItem('ink:' + k.hash) ?? ''; } catch { return ''; } })();
    if (ink) { el.style.borderLeftColor = ink; el.style.borderLeftWidth = '8px'; el.style.borderLeftStyle = 'solid'; }
    el.innerHTML = `<button data-play title="Bring this song back and play it">▶</button><span>${alias.replace(/</g, '&lt;')}</span><small>from last time</small><button data-del title="Forget it">✕</button>`;
    el.querySelector<HTMLButtonElement>('[data-play]')!.onclick = () => { void bringBack(k).then(() => { const i = looper.songs.findIndex(s => s.hash === k.hash); if (i >= 0) { looper.select(i); looper.play(0); } }); };
    el.querySelector<HTMLButtonElement>('[data-del]')!.onclick = () => { void forget(k.hash); };
    box.append(el);
  }
  if (waiting.length > 1) {
    const all = document.createElement('button');
    all.className = 'chip add'; all.textContent = 'Bring them all back';
    all.onclick = () => { void addSongs(waiting.map(k => new File([k.data], k.name, { type: k.type }))); };
    box.append(all);
  }
  const add = document.createElement('label');
  add.className = 'chip add';
  add.innerHTML = '+ Add a song<input id="file" type="file" accept="audio/*" multiple hidden />';
  add.querySelector('input')!.onchange = e => { const f = (e.target as HTMLInputElement).files; if (f?.length) void addSongs(f); (e.target as HTMLInputElement).value = ''; };
  box.append(add);
  const mb = looper.bytes / 2 ** 20, meter = document.createElement('small');
  meter.className = 'meter' + (mb > 1200 ? ' heavy' : '');
  meter.textContent = `${looper.songs.length} ${looper.songs.length === 1 ? 'song' : 'songs'} · ${mb < 1000 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB'} in memory${mb > 1200 ? ' (getting heavy: take some out when done with them)' : ''}`;
  box.append(meter);
}

// The voice pass runs after the analysis, while the song is already playable: same progress bar.
const listening = () => looper.voice.state === 'loading' || looper.voice.state === 'running';
let voiceShown = '';
function showVoice() {
  const v = looper.voice;
  if (listening()) {
    $('progress').hidden = false;
    $('bar').style.width = `${Math.round(v.done * 100)}%`;
    $('progress-text').textContent = `${v.state === 'loading' ? 'Getting ready to listen for singing' : 'Listening for singing and talking'}, so a riff never cuts a word… ${Math.round(v.done * 100)}%${v.etaSec !== null ? `, about ${Math.ceil(v.etaSec)} s left` : ''}. You can press Play already.`;
  } else if ((v.state === 'done' || v.state === 'failed') && voiceShown !== v.state) {
    $('progress-text').textContent = v.state === 'done' ? 'Done listening: the sung parts are marked in pink, and they loop rather than riff.' : `Couldn't listen for singing (${v.why}), so a riff may cut a word; make a sung part loop instead.`;
    setTimeout(() => { if (!listening()) $('progress').hidden = true; }, v.state === 'done' ? 2500 : 6000);
  }
  voiceShown = v.state;
}

// ---- holds: found from the score, with your choices on top, saved per song ----

interface Prefs { hold: Record<string, boolean>; mode: Record<string, 'riff' | 'loop'>; seed: Record<string, number>; custom: { from: number; to: number }[] }
let prefs: Prefs = { hold: {}, mode: {}, seed: {}, custom: [] };
const key = (t: number) => t.toFixed(3);
function loadPrefs(h: string): Prefs { try { return { hold: {}, mode: {}, seed: {}, custom: [], ...JSON.parse(localStorage.getItem('holds:' + h) ?? '{}') }; } catch { return { hold: {}, mode: {}, seed: {}, custom: [] }; } }
function savePrefs() { try { localStorage.setItem('holds:' + hash, JSON.stringify(prefs)); } catch { /* storage off: fine */ } }

/** Riff when the bars are alike enough to jump between and nobody sings there; else loop. */
function autoMode(from: number, to: number): Cue['mode'] {
  if ((voiceShare(looper.score!, from, to) ?? 0) > RIFF_VOICE_MAX) return 'loop';
  const r = looper.riffFor({ from, to });
  return r.jumps.flat().some(j => r.voiceClear(j)) ? 'riff' : 'loop';
}

const barNo = (t: number) => barStarts(looper.score!).filter(b => b < t - 0.02).length + 1;
const barsOf = (c: Cue) => `bars ${barNo(c.from)}–${barNo(c.to) - 1}`;

/** Rebuild the cue list from the holds and the saved choices (when the score or the voice pass has moved on). */
function buildCues() {
  const score = looper.score;
  if (!score) return;
  const now = `${hash}:${score.sections.length}:${score.final}:${looper.voice.state}:${prefs.custom.length}`;
  if (now === built) return;
  built = now;
  holds = looper.holds();
  const cue = (from: number, to: number, name: string, mode: Cue['mode'], on: boolean): Cue => {
    const k = key(from), c: Cue = { name, from, to, mode: prefs.mode[k] ?? mode, hold: prefs.hold[k] ?? on };
    if (prefs.seed[k] !== undefined) c.seed = prefs.seed[k];
    return c;
  };
  const cues = holds.map(h => cue(h.from, h.to, h.name, h.mode, h.suggested));
  for (const c of prefs.custom) cues.push(cue(c.from, c.to, 'mine', autoMode(c.from, c.to), true));
  cues.sort((a, b) => a.from - b.from);
  looper.cues = cues;
  renderCues();
}

/** What a hold does and why, in a few words, for the list. */
function why(c: Cue): string {
  const h = holds.find(x => Math.abs(x.from - c.from) < 0.02 && Math.abs(x.to - c.to) < 0.02);
  const parts: string[] = [];
  if (c.mode === 'riff') { const r = looper.riffFor(c), n = r.jumps.flat().filter(j => r.voiceClear(j)).length; parts.push(n ? `riffs, ${n} places it can jump` : 'no two bars alike enough to jump: it will just repeat'); }
  else if (h) parts.push(h.voice !== null && h.voice > RIFF_VOICE_MAX ? `repeats, since it is sung (${Math.round(h.voice * 100)}% of it)` : h.jumps === 0 && h.voice !== null ? 'repeats: no two bars alike enough to riff on' : 'repeats');
  else parts.push('repeats');
  if (h?.wrapVoice !== null && h?.wrapVoice !== undefined && h.wrapVoice >= 0.3) parts.push('the repeat cuts a sung line');
  if (h && h.bars < h.sectionBars) parts.push(`shortened to ${h.bars} bars so the repeat is clear of the singing`);
  return parts.join(' · ');
}

function renderCues() {
  const box = $('cues');
  box.innerHTML = '';
  const cur = looper.state().cue;
  looper.cues.forEach((c, i) => {
    const el = document.createElement('div'), on = c.hold !== false, k = key(c.from), mine = holds.every(h => Math.abs(h.from - c.from) >= 0.02);
    el.className = 'cue' + (cur === i ? ' now' : '') + (on ? '' : ' off');
    el.innerHTML = `<label class="switch" title="When the song reaches this part, wait here until Go on"><input type="checkbox" ${on ? 'checked' : ''}/> wait here</label>` +
      `<b>${i + 1}. ${c.name}</b> <small>${barsOf(c)} · ${why(c)}</small>` +
      `<button data-mode title="Riff: the band plays these bars in a fresh order. Loop: repeat them as they are">${c.mode === 'riff' ? '⤨ riff' : '⟲ loop'}</button>` +
      (c.mode === 'riff' ? '<button data-seed title="Another riff on the same bars">🎲</button>' : '') +
      `<button data-go title="Play this part now">▶ hear</button>` + (mine ? '<button data-del title="Remove">✕</button>' : '');
    el.querySelector('input')!.onchange = e => { c.hold = (e.target as HTMLInputElement).checked; prefs.hold[k] = c.hold; savePrefs(); renderCues(); };
    el.querySelector<HTMLButtonElement>('[data-mode]')!.onclick = () => { c.mode = c.mode === 'riff' ? 'loop' : 'riff'; prefs.mode[k] = c.mode; savePrefs(); if (looper.state().cue === i && looper.deck.loop) looper.goTo(i); renderCues(); };
    el.querySelector<HTMLButtonElement>('[data-seed]')?.addEventListener('click', () => {
      c.seed = Math.floor(Math.random() * 2 ** 32); prefs.seed[k] = c.seed; savePrefs();
      if (looper.state().cue === i && looper.deck.riff) looper.goTo(i); // the new riff takes over at the next bar
    });
    el.querySelector<HTMLButtonElement>('[data-go]')!.onclick = () => looper.goTo(i);
    el.querySelector<HTMLButtonElement>('[data-del]')?.addEventListener('click', () => { prefs.custom = prefs.custom.filter(x => Math.abs(x.from - c.from) >= 0.02); savePrefs(); built = ''; buildCues(); });
    box.append(el);
  });
}

function addCue() {
  if (!ui.selection) return;
  prefs.custom.push({ from: ui.selection[0], to: ui.selection[1] });
  ui.selection = null; savePrefs(); built = ''; buildCues();
  $<HTMLDetailsElement>('tune').open = true;
}

// ---- Play, Back, Go on ----

/** The holds the song waits at, in order. */
const armed = () => looper.cues.map((c, i) => ({ c, i })).filter(x => x.c.mode !== 'once' && x.c.hold !== false);

const togglePlay = () => { if (looper.deck.playing) looper.stop(); else if (looper.score) looper.play(ui.selection?.[0] ?? 0); };
/** Pause freezes the music where it is (the phone rings); resume carries on from the same spot. */
const togglePause = () => { if (!looper.deck.playing) { togglePlay(); return; } if (looper.paused) looper.resume(); else looper.pause(); };
/** Go on: let a held part go (the song plays on and waits at the next hold); when already playing on, jump to the next hold. */
function goOn() {
  const st = looper.state();
  if (!st.playing) { togglePlay(); return; }
  if (st.loop) { looper.release(); return; }
  if (st.pending) return;
  const next = armed().find(x => x.c.from > st.position + 0.5);
  if (next) looper.goTo(next.i);
}
/** Back: the hold before the one being held (or before the playhead). */
function goBack() {
  const st = looper.state(), from = st.loop ? st.loop[0] : st.position;
  const list = armed(), prev = list.filter(x => x.c.from < from - 0.5).at(-1) ?? list[0];
  if (prev) looper.goTo(prev.i);
}

// ---- the picture: click a part to hear it, click the waveform to play from there, drag to choose bars ----

let dragFrom: number | null = null, dragX = 0;
const timeAt = (e: MouseEvent) => (e.offsetX / canvas.clientWidth) * (looper.buffer?.duration ?? 0);
canvas.onmousedown = e => {
  if (!looper.score) return;
  const hit = stripHit(looper, canvas.clientWidth, e.offsetX, e.offsetY);
  if (hit !== null) { if (hit >= 0) looper.goTo(hit); return; }
  dragFrom = timeAt(e); dragX = e.offsetX;
};
canvas.onmousemove = e => {
  if (dragFrom === null || !looper.score || Math.abs(e.offsetX - dragX) < 4) return;
  const a = snapToBar(looper.score, Math.min(dragFrom, timeAt(e))), b = snapToBar(looper.score, Math.max(dragFrom, timeAt(e)));
  ui.selection = b > a ? [a, b] : null;
};
canvas.onmouseup = e => {
  if (dragFrom !== null && Math.abs(e.offsetX - dragX) < 4 && looper.score && e.offsetY >= STRIP) {
    const bars = barStarts(looper.score), t = timeAt(e);
    ui.selection = null;
    looper.play(bars.filter(b => b <= t).at(-1) ?? 0);
  }
  dragFrom = null;
};

// ---- buttons and keys ----

$('play').onclick = togglePlay;
$('pause').onclick = togglePause;
$('prev').onclick = goBack;
$('next').onclick = goOn;
$('loop').onclick = () => { if (ui.selection) looper.loop(...ui.selection); };
$('addcue').onclick = addCue;
$<HTMLSelectElement>('quantise').onchange = e => { looper.quantise = (e.target as HTMLSelectElement).value as Quantise; };
$<HTMLInputElement>('zoom').oninput = e => { canvas.style.width = `${Number((e.target as HTMLInputElement).value) * 100}%`; };
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') goOn();
  else if (e.key === 'ArrowLeft') goBack();
  else if (e.key === 'l') { if (ui.selection) looper.loop(...ui.selection); }
  else if (e.key === 'a' || e.key === 'c') addCue();
  else if (/^[1-9]$/.test(e.key)) looper.goTo(Number(e.key) - 1);
});

// ---- the live readout, in plain words ----

let lastCue = -2;
function frame() {
  buildCues();
  draw(canvas, looper, ui);
  const st = looper.state(), score = looper.score;
  $('play').textContent = st.playing ? '■ Stop' : '▶ Play';
  const paused = st.playing && looper.paused;
  $('pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  ($('pause') as HTMLButtonElement).disabled = !st.playing;
  ($('addcue') as HTMLButtonElement).disabled = ($('loop') as HTMLButtonElement).disabled = !ui.selection;
  $('next').textContent = st.loop ? 'Go on ▶' : 'Next hold ▶';
  if (score) {
    const cue = looper.cues[st.cue], list = armed(), nextHold = list.find(x => x.c.from > st.position + 0.5);
    const does = (c: Cue) => c.mode === 'riff' ? 'riffing on it' : 'repeating it';
    let text: string, hint: string;
    if (paused) {
      text = `Paused at bar <b>${st.bar}</b>`;
      hint = 'Press Resume (or Space) and the music carries on from exactly here.';
    } else if (!st.playing) {
      text = !score.final ? 'Still listening to the song. You can press Play already.' :
        list.length ? `Ready. The song will hold in <b>${list.length}</b> ${list.length === 1 ? 'place' : 'places'}: ${list.map(x => `<b>${x.c.name}</b> (${x.c.mode})`).join(', ')}.` : 'Ready. No part is set to hold, so the song will just play through.';
      hint = 'Press Play: the song starts from the top and, when it reaches a coloured part, keeps playing that part until you press Go on. Or click a coloured part to hear it straight away.';
    } else if (st.pending) {
      text = `Bar <b>${st.bar}</b> · moving to <b>${st.pending.label}</b> in ${st.pending.inSec.toFixed(1)} s${st.pending.forVoice ? ' (waiting for a gap in the singing)' : ''}`;
      hint = 'The change lands on a bar line, so you shouldn\'t hear the join.';
    } else if (st.loop && cue) {
      text = `Bar <b>${st.bar}</b> · holding in <b>${cue.name}</b>, ${does(cue)}${st.riff ? ` · bars so far: ${st.riff.path.slice(-8).join(' ')}` : ''}`;
      hint = `Press Go on when the scene moves: the song carries on${nextHold ? ` and holds again at ${nextHold.c.name}` : ' to the end'}. Back goes to the part before.`;
    } else if (st.loop) {
      text = `Bar <b>${st.bar}</b> · holding on the chosen bars`;
      hint = 'Press Go on to carry on with the song.';
    } else {
      text = `Bar <b>${st.bar}</b> · playing on${nextHold ? ` · holds at <b>${nextHold.c.name}</b> in ${Math.max(0, nextHold.c.from - st.position).toFixed(0)} s` : ' · plays to the end'}`;
      hint = nextHold ? 'The song plays through until it reaches the next coloured part, then holds there. Next hold jumps there now.' : 'No more holds ahead: the song plays to its end.';
    }
    $('readout').innerHTML = text;
    $('hint').textContent = hint;
    const vs = looper.voice.state;
    $('joins').textContent = (vs === 'off' ? '' : `voice pass: ${vs}${looper.voice.why ? ' (' + looper.voice.why + ')' : ''}, waits up to ${looper.voiceWaitBars} bars for a gap\n`) +
      `holds: ${holds.map(h => `${h.name} ${h.mode}${h.suggested ? '*' : ''} ${h.bars}/${h.sectionBars} bars${h.jumps ? ` ${h.jumps} jumps` : ''} voice ${h.voice === null ? '?' : Math.round(h.voice * 100) + '%'} wrap ${h.wrapDb} dB${h.rough ? ' ⚠' : ''}`).join('; ')}\n` +
      (st.riff ? `riff path (bars, latest last): ${st.riff.path.join(' ')}\n${st.riff.jumps} possible jumps in this passage\n` : '') +
      (st.joins.map(j => `${j.kind.padEnd(6)} ${j.from.toFixed(3)} s → ${j.to.toFixed(3)} s${j.riff ? `   bar ${j.riff.after} → ${j.riff.into}, alike ${j.riff.sim}` : ''}   step ${j.score.db} dB   match ${j.score.r}   voice ${j.voice === null ? '?' : j.voice.toFixed(2)}${j.kind !== 'change' && j.score.warn ? '   ⚠ may be audible' : ''}${j.voice !== null && j.voice >= 0.3 ? '   🎤 cuts a vocal' : ''}`).reverse().join('\n') || 'No joins yet.');
  }
  if (st.cue !== lastCue) { lastCue = st.cue; renderCues(); }
  showVoice();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
