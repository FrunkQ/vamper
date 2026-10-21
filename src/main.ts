// The editor page: a thin layer over the Looper (src/engine/looper.ts). Drop a song, select bars,
// make cues, then orchestrate with Back / Next, number keys or by clicking the strip.
import { Looper, type Cue } from './engine/looper';
import { barStarts, snapToBar, voiceAcross, VOICE_QUIET, type Quantise } from './engine/plan';
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
const ui: ViewState = { selection: null };
(window as any).__vamper = looper; // for headless checks and the console
const canvas = $<HTMLCanvasElement>('view');
let hash = '';

// ---- loading ----

async function open(file: File) {
  $('track').textContent = file.name;
  $('progress').hidden = false;
  const t0 = performance.now();
  await looper.load(file, p => {
    $('bar').style.width = `${Math.round(p.done * 100)}%`;
    $('progress-text').textContent =
      p.stage === 'decode' ? 'Decoding the audio…' :
      p.stage === 'analyse' ? `Finding beats, bars and sections: ${Math.round(p.done * 100)}%${p.etaSec !== null ? `, about ${Math.ceil(p.etaSec)} s left` : ''}` :
      p.cached ? 'Opened from the cache.' : `Analysed in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    if (p.stage === 'done') setTimeout(() => { if (!listening()) $('progress').hidden = true; }, 1500);
  }).then(score => {
    const t = score.track;
    $('track').textContent = `${t.title}${t.artist ? ' · ' + t.artist : ''} · ${score.tempo.at(-1)?.bpm ?? '?'} bpm · ${score.beats.filter(b => b.downbeat).length} bars`;
  });
}
looper.onChange = () => { if (looper.score && looper.score.track.hash !== hash) { hash = looper.score.track.hash; looper.cues = loadCues(hash); ui.selection = null; renderCues(); } };

$<HTMLInputElement>('file').onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void open(f); };
window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
window.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drag'); const f = e.dataTransfer?.files[0]; if (f) void open(f); });

// The voice pass runs after the analysis, while the song is already playable: same progress bar.
const listening = () => looper.voice.state === 'loading' || looper.voice.state === 'running';
let voiceShown = '';
function showVoice() {
  const v = looper.voice;
  if (listening()) {
    $('progress').hidden = false;
    $('bar').style.width = `${Math.round(v.done * 100)}%`;
    $('progress-text').textContent = `${v.state === 'loading' ? 'Loading the voice model' : 'Listening for singing and talking'}, so changes don't cut a line in half: ${Math.round(v.done * 100)}%${v.etaSec !== null ? `, about ${Math.ceil(v.etaSec)} s left` : ''}. You can play already.`;
  } else if ((v.state === 'done' || v.state === 'failed') && voiceShown !== v.state) {
    $('progress-text').textContent = v.state === 'done' ? 'Voices heard: changes now avoid cutting a sung line.' : `Couldn't listen for voices (${v.why}); changes land on the next bar as usual.`;
    setTimeout(() => { if (!listening()) $('progress').hidden = true; }, v.state === 'done' ? 1500 : 5000);
  }
  voiceShown = v.state;
}

// ---- cues, saved per song in this browser ----

function loadCues(h: string): Cue[] { try { return JSON.parse(localStorage.getItem('cues:' + h) ?? '[]'); } catch { return []; } }
function saveCues() { try { localStorage.setItem('cues:' + hash, JSON.stringify(looper.cues)); } catch { /* storage off: fine */ } }

// How many jumps a riff cue's passage has (the bar graph doesn't change with the seed, so it is kept).
const riffInfo = new Map<string, { jumps: number; vocal: number }>();
function riffSummary(c: Cue) {
  const key = `${hash}:${c.from}:${c.to}:${looper.voice.state}`;
  let info = riffInfo.get(key);
  if (!info) {
    const r = looper.riffFor(c);
    info = { jumps: r.jumpCount, vocal: r.jumps.flat().filter(j => !r.voiceClear(j)).length };
    riffInfo.set(key, info);
  }
  return info.jumps ? ` · ${info.jumps} jumps${info.vocal ? ` (${info.vocal} wait for a gap in the vocal)` : ''}` : ' · no bars alike enough to jump between: plays as a loop';
}
const MODES = { loop: '⟲ loop', riff: '⤨ riff', once: '→ once' } as const;
const NEXT_MODE = { loop: 'riff', riff: 'once', once: 'loop' } as const;

function renderCues() {
  const box = $('cues');
  box.innerHTML = '';
  const cur = looper.state().cue;
  looper.cues.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cue' + (cur === i ? ' on' : '');
    const bars = barStarts(looper.score!);
    const b0 = bars.findIndex(t => Math.abs(t - c.from) < 0.01) + 1, b1 = bars.findIndex(t => Math.abs(t - c.to) < 0.01);
    // A loop whose wrap splits a vocal line (at its end or its start) will be heard every pass.
    const cuts = c.mode !== 'once' && Math.max(voiceAcross(looper.score!, c.from) ?? 0, voiceAcross(looper.score!, c.to) ?? 0) >= VOICE_QUIET;
    el.innerHTML = `<button data-go>${i + 1}</button><input value="${c.name.replace(/"/g, '&quot;')}" /><small>bars ${b0}–${b1 > 0 ? b1 : 'end'}${c.mode === 'riff' ? riffSummary(c) : ''}${cuts ? ' <span title="The loop wraps in the middle of a sung or spoken line">🎤 wrap cuts a vocal</span>' : ''}</small><button data-mode title="Loop the bars as they are, riff on them (a varied order), or play on through the song">${MODES[c.mode]}</button>${c.mode === 'riff' ? '<button data-seed title="Another riff on the same bars">🎲</button>' : ''}<button data-del>✕</button>`;
    el.querySelector<HTMLButtonElement>('[data-go]')!.onclick = () => looper.goTo(i);
    el.querySelector('input')!.onchange = e => { c.name = (e.target as HTMLInputElement).value; saveCues(); };
    el.querySelector<HTMLButtonElement>('[data-mode]')!.onclick = () => { c.mode = NEXT_MODE[c.mode]; saveCues(); renderCues(); };
    el.querySelector<HTMLButtonElement>('[data-seed]')?.addEventListener('click', () => {
      c.seed = Math.floor(Math.random() * 2 ** 32); saveCues();
      if (looper.state().cue === i && looper.deck.riff) looper.goTo(i); // the new riff takes over at the next bar
    });
    el.querySelector<HTMLButtonElement>('[data-del]')!.onclick = () => { looper.cues.splice(i, 1); saveCues(); renderCues(); };
    box.append(el);
  });
}

function addCue() {
  if (!ui.selection) return;
  const names = ['Explore', 'Tension', 'Combat', 'Victory', 'Calm', 'Chase', 'Mystery', 'Boss', 'Rest'];
  looper.cues.push({ name: names[looper.cues.length % names.length], from: ui.selection[0], to: ui.selection[1], mode: 'loop' });
  looper.cues.sort((a, b) => a.from - b.from);
  saveCues(); renderCues();
}

// ---- selection: drag across bars; a click plays from that bar ----

let dragFrom: number | null = null, dragX = 0;
const timeAt = (e: MouseEvent) => (e.offsetX / canvas.clientWidth) * (looper.buffer?.duration ?? 0);
canvas.onmousedown = e => {
  if (!looper.score) return;
  const hit = stripHit(looper, canvas.clientWidth, e.offsetX, e.offsetY);
  if (hit) {
    if (hit.row === 'cue') looper.goTo(hit.index);
    else if (looper.cues.length === 0) looper.goTo(hit.index);
    else { const s = looper.score.sections; ui.selection = [s[hit.index].t, s[hit.index + 1]?.t ?? looper.playlist.at(-1)!.to]; }
    return;
  }
  if (e.offsetY < STRIP * 2) return;
  dragFrom = timeAt(e); dragX = e.offsetX;
};
canvas.onmousemove = e => {
  if (dragFrom === null || !looper.score || Math.abs(e.offsetX - dragX) < 4) return;
  const a = snapToBar(looper.score, Math.min(dragFrom, timeAt(e))), b = snapToBar(looper.score, Math.max(dragFrom, timeAt(e)));
  ui.selection = b > a ? [a, b] : null;
};
canvas.onmouseup = e => {
  if (dragFrom !== null && Math.abs(e.offsetX - dragX) < 4 && looper.score) {
    const bars = barStarts(looper.score), t = timeAt(e);
    looper.play(bars.filter(b => b <= t).at(-1) ?? 0);
  }
  dragFrom = null;
};
canvas.ondblclick = e => {
  if (!looper.score || e.offsetY < STRIP * 2) return;
  const t = timeAt(e), S = looper.score.sections, i = S.findIndex((s, k) => t >= s.t && t < (S[k + 1]?.t ?? Infinity));
  if (i >= 0) ui.selection = [S[i].t, S[i + 1]?.t ?? looper.playlist[i].to];
};

// ---- buttons and keys ----

const togglePlay = () => { if (looper.deck.playing) looper.stop(); else if (looper.score) looper.play(ui.selection?.[0] ?? 0); };
const loopSel = () => { if (ui.selection) looper.loop(...ui.selection); };
$('play').onclick = togglePlay;
$('prev').onclick = () => looper.prev();
$('next').onclick = () => looper.next();
$('loop').onclick = loopSel;
$('release').onclick = () => looper.release();
$('addcue').onclick = addCue;
$<HTMLSelectElement>('quantise').onchange = e => { looper.quantise = (e.target as HTMLSelectElement).value as Quantise; };
$<HTMLInputElement>('zoom').oninput = e => { canvas.style.width = `${Number((e.target as HTMLInputElement).value) * 100}%`; };
window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') looper.next();
  else if (e.key === 'ArrowLeft') looper.prev();
  else if (e.key === 'l') loopSel();
  else if (e.key === 'r') looper.release();
  else if (e.key === 'c') addCue();
  else if (/^[1-9]$/.test(e.key)) looper.goTo(Number(e.key) - 1);
});

// ---- the live picture and readout ----

let lastCue = -2;
function frame() {
  draw(canvas, looper, ui);
  const st = looper.state(), list = looper.playlist;
  $('play').textContent = st.playing ? '■ Stop' : '▶ Play';
  if (looper.score) {
    const cue = list[st.cue];
    let html = st.playing ? `Bar <b>${st.bar}</b>` : 'Stopped';
    if (cue) html += ` · ${looper.cues.length ? 'cue' : 'section'} <b>${cue.name}</b>`;
    if (st.riff) html += ` · riffing ⤨ bars ${st.riff.path.slice(-8).join(' ')} (the last ones queued)`;
    else if (st.loop) html += ' · looping';
    if (st.pending) html += ` · next change: <b>${st.pending.label}</b> in ${st.pending.inSec.toFixed(1)} s${st.pending.forVoice ? ' (waiting for a gap in the vocal)' : ''}`;
    $('readout').innerHTML = html;
    const vs = looper.voice.state;
    $('joins').textContent = (vs === 'off' ? '' : `voice pass: ${vs}${looper.voice.why ? ' (' + looper.voice.why + ')' : ''}, waits up to ${looper.voiceWaitBars} bars for a gap\n`) +
      (st.riff ? `riff path (bars, latest last): ${st.riff.path.join(' ')}\n${st.riff.jumps} possible jumps in this passage\n` : '') +
      (st.joins.map(j => `${j.kind.padEnd(6)} ${j.from.toFixed(3)} s → ${j.to.toFixed(3)} s${j.riff ? `   bar ${j.riff.after} → ${j.riff.into}, alike ${j.riff.sim}` : ''}   step ${j.score.db} dB   match ${j.score.r}   voice ${j.voice === null ? '?' : j.voice.toFixed(2)}${j.kind !== 'change' && j.score.warn ? '   ⚠ may be audible' : ''}${j.voice !== null && j.voice >= VOICE_QUIET ? '   🎤 cuts a vocal' : ''}`).reverse().join('\n') || 'No joins yet.');
  }
  if (st.cue !== lastCue || looper.voice.state !== voiceShown) { lastCue = st.cue; renderCues(); }
  showVoice();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
