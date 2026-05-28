/* ════════════════════════════════════════════════════════
   Hwang Overlay — kompaktowy HUD nad oknem gry
   Czyta te same dane z Firebase co dashboard (app.js).
   ════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

// ─── KONFIG ─────────────────────────────────────────────────
// UWAGA: firebaseConfig + BOSSES muszą być spójne z app.js. Trzymane tu osobno,
// bo Electron ładuje stronę przez file:// i lokalny import modułu byłby blokowany
// przez CORS — a import z https (Firebase) działa.
const firebaseConfig = {
  apiKey: "AIzaSyAlRwBnXsjhjJ_KVwIesFFh60slfMGeDtM",
  authDomain: "hwang-timer.firebaseapp.com",
  databaseURL: "https://hwang-timer-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "hwang-timer",
  storageBucket: "hwang-timer.firebasestorage.app",
  messagingSenderId: "532557757339",
  appId: "1:532557757339:web:b9779641e8d09b2a347f3e"
};

const BOSSES = {
  'chung-hee':    { name: 'Chung-Hee',               short: 'Chung-Hee',   respMs: 40 * 60 * 1000, color: '#dc2626' },
  'ostrzowiec':   { name: 'Ezoteryczny Ostrzowiec',  short: 'Ostrzowiec',  respMs: 40 * 60 * 1000, color: '#7c3aed' },
  'przywolywacz': { name: 'Ezoteryczny Przywoływacz', short: 'Przywoływacz', respMs: 80 * 60 * 1000, color: '#0ea5e9' }
};
const BOSS_KEYS = Object.keys(BOSSES);

const POST_RESP_LINGER_MS = 15 * 60 * 1000;
const WARN_THRESHOLD_MS   = 5 * 60 * 1000;
const CRIT_THRESHOLD_MS   = 1 * 60 * 1000;

// ─── STATE ──────────────────────────────────────────────────
let db = null;
let timersState = {};
let serverTimeOffset = 0;
let pendingDeletes = new Set();
let notifiedAtZero = new Set();
let beepCtx = null;

// Głos (Web Speech). voiceOn zapamiętane lokalnie; spoken pilnuje, by każdy
// komunikat (1 min / respawn) padł tylko raz na timer.
let voiceOn = localStorage.getItem('hwang-overlay-voice') === '1';
let spoken = new Set();
let plVoice = null;

const ACTIVE_KEY = 'hwang-overlay-active-boss';
let activeBoss = localStorage.getItem(ACTIVE_KEY);
if (!BOSSES[activeBoss]) activeBoss = BOSS_KEYS[0];

function serverNow() { return Date.now() + serverTimeOffset; }

// ─── INIT ───────────────────────────────────────────────────
(function init() {
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    renderActiveBoss();
    renderChannels();
    subscribe();
    setInterval(tick, 250);
  } catch (e) {
    console.error('Overlay init failed', e);
  }
  wireHotkeys();
  wireVoice();
})();

function subscribe() {
  const dot = document.getElementById('dot');
  onValue(ref(db, '.info/connected'), s => dot.classList.toggle('online', s.val() === true));
  onValue(ref(db, '.info/serverTimeOffset'), s => { serverTimeOffset = s.val() || 0; });
  onValue(ref(db, 'timers'), s => { timersState = s.val() || {}; }, err => console.error(err));
}

// ─── AKTYWNY BOSS (dla skrótów 1..6) ────────────────────────
function renderActiveBoss() {
  const el = document.getElementById('activeBoss');
  const b = BOSSES[activeBoss];
  el.textContent = b.name;
  el.style.color = b.color;
}

function renderChannels() {
  const wrap = document.getElementById('chans');
  wrap.innerHTML = '';
  for (let ch = 1; ch <= 6; ch++) {
    const btn = document.createElement('button');
    btn.textContent = 'CH' + ch;
    btn.addEventListener('click', () => startTimer(activeBoss, ch));
    wrap.appendChild(btn);
  }
}

function cycleBoss() {
  const i = BOSS_KEYS.indexOf(activeBoss);
  activeBoss = BOSS_KEYS[(i + 1) % BOSS_KEYS.length];
  localStorage.setItem(ACTIVE_KEY, activeBoss);
  renderActiveBoss();
}

// ─── TIMERY ─────────────────────────────────────────────────
function startTimer(bossKey, channel) {
  const boss = BOSSES[bossKey];
  if (!boss) return;
  push(ref(db, 'timers'), {
    boss: bossKey,
    channel,
    startedAt: serverTimestamp(),
    duration: boss.respMs
  }).catch(err => console.error('startTimer failed', err));
}

function deleteTimer(id) {
  if (pendingDeletes.has(id)) return;
  pendingDeletes.add(id);
  remove(ref(db, 'timers/' + id)).catch(err => { console.error(err); pendingDeletes.delete(id); });
}

function cleanupExpired(now) {
  Object.entries(timersState).forEach(([id, t]) => {
    if (now > t.startedAt + t.duration + POST_RESP_LINGER_MS) deleteTimer(id);
  });
}

// Render listy + odliczanie. Pętla 250ms. Lista jest mała, więc przebudowujemy
// ją w całości — prościej niż reconcile, a wizualnie bez różnicy.
function tick() {
  if (!db) return;
  const now = serverNow();
  cleanupExpired(now);
  pendingDeletes.forEach(id => { if (!(id in timersState)) pendingDeletes.delete(id); });
  // Sprzątanie znaczników alertów dla timerów, których już nie ma.
  notifiedAtZero.forEach(id => { if (!(id in timersState)) notifiedAtZero.delete(id); });
  spoken.forEach(k => { if (!(k.split(':')[0] in timersState)) spoken.delete(k); });

  const list = Object.entries(timersState)
    .map(([id, t]) => ({ id, ...t, remaining: t.duration - (now - t.startedAt) }))
    .filter(t => BOSSES[t.boss] && -t.remaining < POST_RESP_LINGER_MS)
    .sort((a, b) => a.remaining - b.remaining);

  const container = document.getElementById('list');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty">Brak aktywnych timerów</div>';
    return;
  }

  container.innerHTML = '';
  let anyRespawn = false;
  for (const t of list) {
    const boss = BOSSES[t.boss];
    const row = document.createElement('div');
    row.className = 'row';
    row.style.setProperty('--rc', boss.color);

    let cdText, cls = '';
    if (t.remaining > WARN_THRESHOLD_MS)      { cdText = fmt(t.remaining); }
    else if (t.remaining > CRIT_THRESHOLD_MS) { cdText = fmt(t.remaining); cls = 'warn'; }
    else if (t.remaining > 0)                 { cdText = fmt(t.remaining); cls = 'critical'; }
    else                                      { cdText = 'RESP +' + fmt(-t.remaining); cls = 'respawn'; anyRespawn = true; }
    if (cls) row.classList.add(cls);

    row.innerHTML =
      `<span class="ch">CH${t.channel}</span>` +
      `<span class="nm">${boss.short}</span>` +
      `<span class="cd">${cdText}</span>` +
      `<button class="x" title="Usuń">×</button>`;
    row.querySelector('.x').addEventListener('click', () => deleteTimer(t.id));
    container.appendChild(row);

    // Alert raz, w momencie respu.
    if (t.remaining <= 0 && !notifiedAtZero.has(t.id)) {
      notifiedAtZero.add(t.id);
      beep();
      notify(boss, t.channel);
    }

    // Głos: ostrzeżenie na minutę przed i w momencie respu.
    if (voiceOn) {
      if (t.remaining <= 60000 && t.remaining > 0 && !spoken.has(t.id + ':60')) {
        spoken.add(t.id + ':60');
        speak(`${boss.short}, kanał ${t.channel}, minuta`);
      } else if (t.remaining <= 0 && !spoken.has(t.id + ':0')) {
        spoken.add(t.id + ':0');
        speak(`${boss.short}, kanał ${t.channel}, respawn`);
      }
    }
  }

  document.getElementById('mode').classList.toggle('live', anyRespawn);
}

function fmt(ms) {
  if (ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── ALERTY ─────────────────────────────────────────────────
function beep() {
  try {
    if (!beepCtx) beepCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = beepCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

function notify(boss, channel) {
  try { new Notification('Resp!', { body: `${boss.name} — CH${channel}`, silent: false }); }
  catch (e) {}
}

// ─── GŁOS (Web Speech) ──────────────────────────────────────
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices();
    plVoice = vs.find(v => v.lang && v.lang.toLowerCase().startsWith('pl')) || null;
  } catch (e) {}
}

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    if (!plVoice) pickVoice();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pl-PL';
    if (plVoice) u.voice = plVoice;
    speechSynthesis.speak(u);   // kolejkuj — nie ucinaj poprzedniego komunikatu
  } catch (e) {}
}

function updateVoiceLabel() {
  document.getElementById('voiceToggle').textContent = 'głos: ' + (voiceOn ? 'on' : 'off');
}

function wireVoice() {
  updateVoiceLabel();
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  document.getElementById('voiceToggle').addEventListener('click', () => {
    voiceOn = !voiceOn;
    localStorage.setItem('hwang-overlay-voice', voiceOn ? '1' : '0');
    updateVoiceLabel();
    if (voiceOn) speak('Głos włączony');   // klik = gest użytkownika, odblokowuje audio
  });
}

// ─── SKRÓTY GLOBALNE (z main.js przez preload) ──────────────
function wireHotkeys() {
  const api = window.overlayAPI;
  if (!api) return;
  api.onHotkey(a => {
    if (a.type === 'start') startTimer(activeBoss, a.channel);
    else if (a.type === 'cycleBoss') cycleBoss();
  });
  api.onMode(m => {
    document.getElementById('mode').textContent = m.clickThrough ? 'klik-przez' : 'klikalny';
  });
}
