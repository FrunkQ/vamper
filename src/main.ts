// The editor page: a thin layer over the Looper (src/engine/looper.ts). Drop a song, select bars,
// make cues, then orchestrate with Back / Next, number keys or by clicking the strip.
import { Looper, type Cue } from './engine/looper';
import { barStarts, snapToBar, type Quantise } from './engine/plan';
import { draw, stripHit, STRIP, type ViewState } from './view';

declare const __BUILD__: string;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$('build').textContent = __BUILD__;

// Installable app: the service worker (public/sw.js) caches the page so it opens offline.
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('./sw.js').catch(() => { /* no offline: fine */ });
let installPrompt: any = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('install').hidden = false; });
$('install').onclick = () => { installPrompt?.prompt(); installPrompt = null; $('install').hidden = true; };

const looper = new Looper();
const ui: ViewState = { selection: null };
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
    if (p.stage === 'done') setTimeout(() => { $('progress').hidden = true; }, 1500);
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

// ---- cues, saved per song in this browser ----

function loadCues(h: string): Cue[] { try { return JSON.parse(localStorage.getItem('cues:' + h) ?? '[]'); } catch { return []; } }
function saveCues() { try { localStorage.setItem('cues:' + hash, JSON.stringify(looper.cues)); } catch { /* storage off: fine */ } }

function renderCues() {
  const box = $('cues');
  box.innerHTML = '';
  const cur = looper.state().cue;
  looper.cues.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cue' + (cur === i ? ' on' : '');
    const bars = barStarts(looper.score!);
    const b0 = bars.findIndex(t => Math.abs(t - c.from) < 0.01) + 1, b1 = bars.findIndex(t => Math.abs(t - c.to) < 0.01);
    el.innerHTML = `<button data-go>${i + 1}</button><input value="${c.name.replace(/"/g, '&quot;')}" /><small>bars ${b0}–${b1 > 0 ? b1 : 'end'}</small><button data-mode>${c.mode === 'loop' ? '⟲ loop' : '→ once'}</button><button data-del>✕</button>`;
    el.querySelector<HTMLButtonElement>('[data-go]')!.onclick = () => looper.goTo(i);
    el.querySelector('input')!.onchange = e => { c.name = (e.target as HTMLInputElement).value; saveCues(); };
    el.querySelector<HTMLButtonElement>('[data-mode]')!.onclick = () => { c.mode = c.mode === 'loop' ? 'once' : 'loop'; saveCues(); renderCues(); };
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
    if (st.loop) html += ' · looping';
    if (st.pending) html += ` · next change: <b>${st.pending.label}</b> in ${st.pending.inSec.toFixed(1)} s`;
    $('readout').innerHTML = html;
    $('joins').textContent = st.joins.map(j => `${j.kind.padEnd(6)} ${j.from.toFixed(3)} s → ${j.to.toFixed(3)} s   step ${j.score.db} dB   match ${j.score.r}${j.kind === 'loop' && j.score.warn ? '   ⚠ may be audible' : ''}`).reverse().join('\n') || 'No joins yet.';
  }
  if (st.cue !== lastCue) { lastCue = st.cue; renderCues(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
