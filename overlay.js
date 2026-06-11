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

// Mapy + bossowie. Spójne z app.js. Każda mapa ma swój prefiks w Firebase
// (Hwang w korzeniu — zgodność wstecz, nowe mapy pod maps/<id>/…).
const MAPS = {
  'hwang': {
    dbPrefix: '', channels: 6,
    bosses: {
      'chung-hee':    { name: 'Chung-Hee',                short: 'Chung-Hee',    respMs: 40 * 60 * 1000, color: '#dc2626' },
      'ostrzowiec':   { name: 'Ezoteryczny Ostrzowiec',   short: 'Ostrzowiec',   respMs: 40 * 60 * 1000, color: '#7c3aed' },
      'przywolywacz': { name: 'Ezoteryczny Przywoływacz', short: 'Przywoływacz', respMs: 80 * 60 * 1000, color: '#0ea5e9' }
    }
  },
  'weze': {
    dbPrefix: 'maps/weze/', channels: 5,
    bosses: {
      'zadlak':     { name: 'Szkarłaczny Żądłak', short: 'Żądłak',     respMs: 40 * 60 * 1000, color: '#e11d48' },
      'szeptotruj': { name: 'Szeptotruj',         short: 'Szeptotruj', respMs: 40 * 60 * 1000, color: '#16a34a' },
      'serpentor':  { name: 'Serpentor',          short: 'Serpentor',  respMs: 45 * 60 * 1000, color: '#0d9488' }
    }
  }
};

// Płaski rejestr: klucz bossa → boss z dołączonym mapId/dbPrefix/liczbą kanałów.
// Klucze bossów są unikalne między mapami, więc lookup BOSSES[t.boss] działa dla
// timerów z dowolnej mapy.
const BOSSES = {};
const BOSS_KEYS = [];
for (const [mapId, m] of Object.entries(MAPS)) {
  for (const [key, b] of Object.entries(m.bosses)) {
    BOSSES[key] = { ...b, mapId, dbPrefix: m.dbPrefix, channels: m.channels };
    BOSS_KEYS.push(key);
  }
}

const POST_RESP_LINGER_MS = 15 * 60 * 1000;
const WARN_THRESHOLD_MS   = 5 * 60 * 1000;
const CRIT_THRESHOLD_MS   = 1 * 60 * 1000;

// ─── STATE ──────────────────────────────────────────────────
let db = null;
let timersByMap = {};          // mapId → { id: timer } — timery każdej mapy osobno
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
  // Subskrybujemy timery KAŻDEJ mapy — HUD pokazuje wszystkie naraz.
  for (const [mapId, m] of Object.entries(MAPS)) {
    onValue(ref(db, m.dbPrefix + 'timers'), s => { timersByMap[mapId] = s.val() || {}; }, err => console.error(err));
  }
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
  const n = BOSSES[activeBoss].channels;   // liczba kanałów zależy od mapy bossa
  for (let ch = 1; ch <= n; ch++) {
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
  renderChannels();   // inna mapa może mieć inną liczbę kanałów
}

// ─── TIMERY ─────────────────────────────────────────────────
function startTimer(bossKey, channel) {
  const boss = BOSSES[bossKey];
  if (!boss) return;
  push(ref(db, boss.dbPrefix + 'timers'), {
    boss: bossKey,
    channel,
    startedAt: serverTimestamp(),
    duration: boss.respMs
  }).catch(err => console.error('startTimer failed', err));
}

// id timera jest unikalne tylko w obrębie mapy, więc usuwanie i guard
// pendingDeletes klucze po uid = mapId:id.
function deleteTimer(mapId, id) {
  const uid = mapId + ':' + id;
  if (pendingDeletes.has(uid)) return;
  pendingDeletes.add(uid);
  remove(ref(db, MAPS[mapId].dbPrefix + 'timers/' + id))
    .catch(err => { console.error(err); pendingDeletes.delete(uid); });
}

function cleanupExpired(now) {
  for (const [mapId, m] of Object.entries(MAPS)) {
    Object.entries(timersByMap[mapId] || {}).forEach(([id, t]) => {
      if (now > t.startedAt + t.duration + POST_RESP_LINGER_MS) deleteTimer(mapId, id);
    });
  }
}

// Render listy + odliczanie. Pętla 250ms. Lista jest mała, więc przebudowujemy
// ją w całości — prościej niż reconcile, a wizualnie bez różnicy.
function tick() {
  if (!db) return;
  const now = serverNow();
  cleanupExpired(now);

  // Zbierz timery ze wszystkich map w jedną listę. uid = mapId:id jest globalnie
  // unikalny i służy jako klucz guardów (delete/alert/głos).
  const list = [];
  const liveUids = new Set();
  for (const [mapId, m] of Object.entries(MAPS)) {
    for (const [id, t] of Object.entries(timersByMap[mapId] || {})) {
      const boss = BOSSES[t.boss];
      if (!boss) continue;
      const remaining = t.duration - (now - t.startedAt);
      if (-remaining >= POST_RESP_LINGER_MS) continue;
      const uid = mapId + ':' + id;
      liveUids.add(uid);
      list.push({ uid, mapId, id, boss, channel: t.channel, remaining });
    }
  }
  list.sort((a, b) => a.remaining - b.remaining);

  // Sprzątanie guardów dla timerów, których już nie ma.
  pendingDeletes.forEach(u => { if (!liveUids.has(u)) pendingDeletes.delete(u); });
  notifiedAtZero.forEach(u => { if (!liveUids.has(u)) notifiedAtZero.delete(u); });
  spoken.forEach(k => { if (!liveUids.has(k.split('@')[0])) spoken.delete(k); });

  const container = document.getElementById('list');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty">Brak aktywnych timerów</div>';
    document.getElementById('mode').classList.remove('live');
    return;
  }

  container.innerHTML = '';
  let anyRespawn = false;
  for (const t of list) {
    const boss = t.boss;
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
    row.querySelector('.x').addEventListener('click', () => deleteTimer(t.mapId, t.id));
    container.appendChild(row);

    // Alert raz, w momencie respu.
    if (t.remaining <= 0 && !notifiedAtZero.has(t.uid)) {
      notifiedAtZero.add(t.uid);
      beep();
      notify(boss, t.channel);
    }

    // Głos: ostrzeżenie na minutę przed i w momencie respu.
    if (voiceOn) {
      if (t.remaining <= 60000 && t.remaining > 0 && !spoken.has(t.uid + '@60')) {
        spoken.add(t.uid + '@60');
        speak(`${boss.short}, kanał ${t.channel}, minuta`);
      } else if (t.remaining <= 0 && !spoken.has(t.uid + '@0')) {
        spoken.add(t.uid + '@0');
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
