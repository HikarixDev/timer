/* ════════════════════════════════════════════════════════
   Świątynia Hwang — Boss Respawn Tracker
   app.js
   ════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, remove
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

// ─── 1. FIREBASE CONFIG ─────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAlRwBnXsjhjJ_KVwIesFFh60slfMGeDtM",
  authDomain: "hwang-timer.firebaseapp.com",
  databaseURL: "https://hwang-timer-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "hwang-timer",
  storageBucket: "hwang-timer.firebasestorage.app",
  messagingSenderId: "532557757339",
  appId: "1:532557757339:web:b9779641e8d09b2a347f3e"
};

// ─── 2. OBRAZY ──────────────────────────────────────────────
const IMG_CHUNG_HEE    = "images/chung-hee.png";
const IMG_OSTRZOWIEC   = "images/ostrzowiec.png";
const IMG_PRZYWOLYWACZ = "images/przywolywacz.png";
const IMG_MAP          = "images/map.png";

// ─── 3. DEFINICJE BOSSÓW ────────────────────────────────────
const BOSSES = {
  'chung-hee': {
    name: 'Chung-Hee',
    respMs: 40 * 60 * 1000,
    color: '#dc2626',
    image: IMG_CHUNG_HEE
  },
  'ostrzowiec': {
    name: 'Ezoteryczny Ostrzowiec',
    respMs: 40 * 60 * 1000,
    color: '#7c3aed',
    image: IMG_OSTRZOWIEC
  },
  'przywolywacz': {
    name: 'Ezoteryczny Przywoływacz',
    respMs: 75 * 60 * 1000,    // 1h 15min
    color: '#0ea5e9',
    image: IMG_PRZYWOLYWACZ
  }
};

const POST_RESP_LINGER_MS = 15 * 60 * 1000;
const WARN_THRESHOLD_MS   = 5 * 60 * 1000;
const CRIT_THRESHOLD_MS   = 1 * 60 * 1000;

// ─── 4. STATE ───────────────────────────────────────────────
let db = null;
let timersState = {};
let sightingsState = {};
let notifiedAtZero = new Set();
let beepCtx = null;
let pendingDeletes = new Set();   // timery z usuwaniem w locie — chroni przed zduplikowanymi zapisami

// Filtr mapy per boss — zbiór kluczy bossów UKRYTYCH na mapie. Trzymany
// w localStorage, więc wybór przeżywa odświeżenie strony (filtr jest lokalny,
// nie współdzielony przez Firebase).
const FILTER_KEY = 'hwang-hidden-bosses';
let hiddenBosses = loadHiddenBosses();

function loadHiddenBosses() {
  try {
    const arr = JSON.parse(localStorage.getItem(FILTER_KEY) || '[]');
    // Pomijamy klucze spoza definicji, żeby stary stan nie blokował filtra
    return new Set(arr.filter(k => k in BOSSES));
  } catch { return new Set(); }
}

function saveHiddenBosses() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify([...hiddenBosses])); } catch {}
}

// ─── 5. INIT ────────────────────────────────────────────────
(function init() {
  if (firebaseConfig.apiKey === "WKLEJ_TUTAJ") {
    document.body.innerHTML = `
      <div class="setup-warning">
        <h2>⚙ Konfiguracja Firebase wymagana</h2>
        <p>Otwórz <code>app.js</code> i wklej swój config.</p>
      </div>`;
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    renderBosses();
    setupMap();
    subscribe();
    setInterval(tick, 250);
  } catch (e) {
    console.error(e);
    setConnStatus('error', 'Błąd konfiguracji');
  }
})();

// ════════════════════════════════════════════════════════════
//   BOSS CARDS
// ════════════════════════════════════════════════════════════

function renderBosses() {
  const grid = document.getElementById('bossesGrid');
  grid.innerHTML = '';

  Object.entries(BOSSES).forEach(([key, boss]) => {
    const card = document.createElement('div');
    card.className = 'boss-card';
    card.style.setProperty('--boss-color', boss.color);
    card.style.setProperty('--boss-image', `url("${boss.image}")`);

    const disabled = boss.respMs == null;
    const respLabel = disabled
      ? 'CZAS RESPU: ?'
      : `RESP: ${formatRespLabel(boss.respMs)}`;

    card.innerHTML = `
      <div class="boss-header">
        <div class="boss-avatar"></div>
        <div class="boss-name">${boss.name}</div>
        <div class="boss-resp">${respLabel}</div>
      </div>
      <div class="ch-ring" data-boss="${key}"></div>
      <div class="boss-timers" data-boss-timers="${key}"></div>
    `;

    const ring = card.querySelector('.ch-ring');
    for (let i = 1; i <= 6; i++) {
      const angle = (i - 1) * 60 - 90;
      const rad = angle * Math.PI / 180;
      const r = 80;
      const cx = 110 + Math.cos(rad) * r;
      const cy = 110 + Math.sin(rad) * r;

      const btn = document.createElement('button');
      btn.className = 'ch-btn' + (disabled ? ' disabled' : '');
      btn.style.left = cx + 'px';
      btn.style.top = cy + 'px';
      btn.dataset.boss = key;
      btn.dataset.channel = i;
      btn.innerHTML = `CH${i}<span class="count" data-count style="display:none">0</span>`;
      if (!disabled) btn.addEventListener('click', () => startTimer(key, i));
      ring.appendChild(btn);
    }

    grid.appendChild(card);
  });
}

function formatRespLabel(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} MIN`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}H` : `${h}H ${m}MIN`;
}

// ════════════════════════════════════════════════════════════
//   MAP / SIGHTINGS
// ════════════════════════════════════════════════════════════

function setupMap() {
  const map = document.getElementById('map');
  map.style.setProperty('--map-image', `url("${IMG_MAP}")`);

  const picker = document.getElementById('mapPicker');
  const pickerBtns = document.getElementById('mapPickerBtns');

  // Buduje przyciski wyboru bossa w pickerze
  pickerBtns.innerHTML = '';
  Object.entries(BOSSES).forEach(([key, boss]) => {
    const btn = document.createElement('button');
    btn.className = 'map-picker-btn';
    btn.style.setProperty('--boss-color', boss.color);
    btn.style.setProperty('--boss-image', `url("${boss.image}")`);
    btn.dataset.boss = key;
    btn.dataset.name = boss.name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const x = parseFloat(picker.dataset.x);
      const y = parseFloat(picker.dataset.y);
      addSighting(key, x, y);
      hidePicker();
    });
    pickerBtns.appendChild(btn);
  });

  // Klik na mapę = pokaż picker
  map.addEventListener('click', (e) => {
    // Jeśli kliknięto na istniejący marker — nic nie rób (handler markera załatwi delete)
    if (e.target.classList.contains('map-marker')) return;

    const rect = map.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Pozycje markerów zapisujemy jako procenty 0–1 żeby były odporne na zmianę rozmiaru mapy
    const x = px / rect.width;
    const y = py / rect.height;

    showPicker(px, py, x, y);
  });

  // Zamknięcie pickera po kliknięciu gdziekolwiek poza nim
  document.addEventListener('click', (e) => {
    if (picker.hidden) return;
    if (picker.contains(e.target)) return;
    if (e.target.closest('.map') && !e.target.classList.contains('map-marker')) return; // właśnie się otwiera
    hidePicker();
  }, { capture: true });
}

function showPicker(px, py, normX, normY) {
  const picker = document.getElementById('mapPicker');
  const map = document.getElementById('map');
  const mapRect = map.getBoundingClientRect();

  picker.hidden = false;
  picker.dataset.x = normX;
  picker.dataset.y = normY;

  // Pozycjonujemy picker względem .map-wrap (rodzica)
  const wrap = map.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const mapOffsetX = mapRect.left - wrapRect.left;
  const mapOffsetY = mapRect.top - wrapRect.top;

  // Dostosuj pozycję żeby picker nie wychodził za mapę
  const pickerW = 180;  // szacowana szerokość
  const pickerH = 80;
  let left = mapOffsetX + px - pickerW / 2;
  let top  = mapOffsetY + py + 14;
  if (left < mapOffsetX) left = mapOffsetX;
  if (left + pickerW > mapOffsetX + mapRect.width) left = mapOffsetX + mapRect.width - pickerW;
  if (top + pickerH > mapOffsetY + mapRect.height) top = mapOffsetY + py - pickerH - 14;
  picker.style.left = left + 'px';
  picker.style.top  = top + 'px';
}

function hidePicker() {
  document.getElementById('mapPicker').hidden = true;
}

function addSighting(bossKey, x, y) {
  push(ref(db, 'sightings'), { boss: bossKey, x, y, addedAt: Date.now() })
    .catch(err => {
      console.error('addSighting failed', err);
      alert('Nie udało się zapisać sightingu: ' + err.message);
    });
}

function deleteSighting(id) {
  remove(ref(db, 'sightings/' + id)).catch(err => console.error('delete sighting failed', err));
}

function renderSightings() {
  const map = document.getElementById('map');
  const sightings = sightingsState || {};
  const ids = Object.keys(sightings);

  // Tryb gęsty: przy dużej liczbie sightingów markery są mniejsze i bez
  // poświaty, żeby nie zlewały się w jedną świecącą plamę
  map.classList.toggle('dense', ids.length > 12);

  // Reconcile: indeksujemy istniejące markery po id, usuwamy nieobecne,
  // dodajemy tylko nowe. Sightingi są niezmienne (jedynie dodawane/usuwane),
  // więc istniejących markerów nie ruszamy — dzięki temu animacja markerPop
  // nie odpala się ponownie u wszystkich przy każdej zdalnej zmianie.
  const existing = new Map();
  map.querySelectorAll('.map-marker').forEach(el => existing.set(el.dataset.id, el));

  const wanted = new Set(ids);
  existing.forEach((el, id) => { if (!wanted.has(id)) el.remove(); });

  // Zliczanie per boss dla legendy
  const counts = {};
  Object.keys(BOSSES).forEach(k => counts[k] = 0);

  ids.forEach(id => {
    const s = sightings[id];
    const boss = BOSSES[s.boss];
    if (!boss) return;
    counts[s.boss] = (counts[s.boss] || 0) + 1;

    if (existing.has(id)) return;   // już na mapie — nie odtwarzamy

    const m = document.createElement('div');
    m.className = 'map-marker';
    m.dataset.id = id;
    m.dataset.boss = s.boss;
    m.style.setProperty('--marker-color', boss.color);
    m.style.left = (s.x * 100) + '%';
    m.style.top  = (s.y * 100) + '%';
    m.dataset.name = boss.name;
    m.title = boss.name;
    // Dymek nad markerem jest przycinany przez overflow:hidden mapy gdy marker
    // leży blisko krawędzi. Kotwiczymy go więc do wnętrza mapy zależnie od pozycji.
    if (s.x > 0.7)      m.classList.add('tip-left');
    else if (s.x < 0.3) m.classList.add('tip-right');
    if (s.y < 0.15)     m.classList.add('tip-below');
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSighting(id);
    });
    map.appendChild(m);
  });

  // Legenda = filtr per boss. Klik na pozycję przełącza widoczność markerów
  // danego bossa na mapie (stan zapisywany lokalnie w localStorage).
  const legend = document.getElementById('mapLegend');
  legend.innerHTML = '';
  Object.entries(BOSSES).forEach(([key, boss]) => {
    const hidden = hiddenBosses.has(key);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item' + (hidden ? ' inactive' : '');
    item.dataset.boss = key;
    item.title = hidden ? `Pokaż na mapie: ${boss.name}` : `Ukryj z mapy: ${boss.name}`;
    item.setAttribute('aria-pressed', String(!hidden));
    item.innerHTML = `
      <span class="legend-dot" style="--dot-color: ${boss.color}"></span>
      <span>${boss.name}</span>
      <span class="count">${counts[key] || 0}</span>
    `;
    item.addEventListener('click', () => toggleBossFilter(key));
    legend.appendChild(item);
  });

  applyMarkerFilter();

  // Licznik pokazuje widoczne / wszystkie, gdy filtr jest aktywny
  const visible = ids.filter(id => {
    const s = sightings[id];
    return BOSSES[s.boss] && !hiddenBosses.has(s.boss);
  }).length;
  document.getElementById('sightingsCount').textContent =
    hiddenBosses.size ? `${visible}/${ids.length}` : ids.length;
}

// Przełącza widoczność markerów danego bossa i przerysowuje legendę/markery.
function toggleBossFilter(key) {
  if (hiddenBosses.has(key)) hiddenBosses.delete(key);
  else hiddenBosses.add(key);
  saveHiddenBosses();
  renderSightings();
}

// Ukrywa/pokazuje markery zgodnie z filtrem. Markery zostają w DOM (klasa
// .filtered-out -> display:none), więc reconcile i animacja markerPop nie są
// zaburzone przy przełączaniu filtra.
function applyMarkerFilter() {
  document.querySelectorAll('.map-marker').forEach(el => {
    el.classList.toggle('filtered-out', hiddenBosses.has(el.dataset.boss));
  });
}

// ════════════════════════════════════════════════════════════
//   FIREBASE SUBSCRIPTION
// ════════════════════════════════════════════════════════════

function subscribe() {
  setConnStatus('connecting', 'Łączenie...');

  onValue(ref(db, '.info/connected'), snap => {
    if (snap.val() === true) setConnStatus('online', 'Online');
    else setConnStatus('offline', 'Offline');
  });

  onValue(ref(db, 'timers'), snapshot => {
    timersState = snapshot.val() || {};
    renderTimers();
  }, err => {
    console.error(err);
    setConnStatus('error', 'Błąd: ' + err.code);
  });

  onValue(ref(db, 'sightings'), snapshot => {
    sightingsState = snapshot.val() || {};
    renderSightings();
  }, err => {
    console.error('sightings onValue error:', err);
  });
}

// ════════════════════════════════════════════════════════════
//   TIMERS
// ════════════════════════════════════════════════════════════

function startTimer(bossKey, channel) {
  const boss = BOSSES[bossKey];
  if (!boss || boss.respMs == null) return;
  const data = {
    boss: bossKey,
    channel: channel,
    startedAt: Date.now(),
    duration: boss.respMs
  };
  push(ref(db, 'timers'), data).catch(err => {
    console.error('startTimer failed', err);
    alert('Nie udało się zapisać timera: ' + err.message);
  });
}

function deleteTimer(id) {
  if (pendingDeletes.has(id)) return;   // usuwanie już w toku — nie dubluj zapisu
  pendingDeletes.add(id);
  remove(ref(db, 'timers/' + id)).catch(err => {
    console.error('delete failed', err);
    pendingDeletes.delete(id);          // pozwól ponowić po błędzie
  });
  // Po sukcesie id znika z timersState i jest sprzątane z pendingDeletes w renderTimers
}

function renderTimers() {
  const now = Date.now();

  // Sprzątanie samego DOM-u jest odłączone od usuwania z bazy (patrz
  // cleanupExpiredTimers w pętli tick). Tutaj tylko odzwierciedlamy stan bazy
  // i czyścimy guard usuwania dla timerów, których już w bazie nie ma.
  pendingDeletes.forEach(id => { if (!(id in timersState)) pendingDeletes.delete(id); });

  // Lista do wyświetlenia: pomijamy bossów spoza definicji oraz timery po
  // okresie linger (cleanup je usunie). Kolejność wg pozostałego czasu jest
  // stała w czasie (remaining = duration + startedAt − now, a −now jest
  // wspólne dla wszystkich), więc sortujemy tylko tutaj, a tick nie przestawia.
  const sorted = Object.entries(timersState)
    .map(([id, t]) => ({ id, ...t, remaining: t.duration - (now - t.startedAt) }))
    .filter(t => BOSSES[t.boss] && -t.remaining < POST_RESP_LINGER_MS)
    .sort((a, b) => a.remaining - b.remaining);

  // Liczniki badge per (boss, channel)
  const counts = {};
  sorted.forEach(t => {
    const k = `${t.boss}:${t.channel}`;
    counts[k] = (counts[k] || 0) + 1;
  });

  document.querySelectorAll('.ch-btn').forEach(btn => {
    const k = `${btn.dataset.boss}:${btn.dataset.channel}`;
    const badge = btn.querySelector('[data-count]');
    if (counts[k]) {
      badge.textContent = counts[k];
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  });

  // Feed globalny — reconcile zamiast pełnego rebuildu
  document.getElementById('feedCount').textContent = sorted.length;
  reconcileTimerList(
    document.getElementById('feed'),
    sorted,
    '<div class="feed-empty" data-empty>Kliknij kanał aby wystartować timer</div>'
  );

  // Per-boss listy
  Object.keys(BOSSES).forEach(bossKey => {
    const container = document.querySelector(`[data-boss-timers="${bossKey}"]`);
    if (!container) return;
    reconcileTimerList(
      container,
      sorted.filter(t => t.boss === bossKey),
      '<div class="boss-timers-empty" data-empty>— brak —</div>'
    );
  });
}

// Uzgadnia zawartość kontenera z listą timerów: dodaje nowe węzły, usuwa
// nieobecne i przestawia istniejące w żądanej kolejności, przesuwając tylko
// te, które tego wymagają. Nie niszczymy i nie odtwarzamy całego DOM, więc
// animacja fadeIn nie odpala się ponownie przy każdej zdalnej zmianie.
function reconcileTimerList(container, timers, emptyHTML) {
  const existing = new Map();
  container.querySelectorAll(':scope > .timer').forEach(n => existing.set(n.dataset.id, n));

  // Placeholder pustego stanu usuwamy — dodamy z powrotem, jeśli trzeba
  const ph = container.querySelector('[data-empty]');
  if (ph) ph.remove();

  const wanted = new Set(timers.map(t => t.id));
  existing.forEach((node, id) => { if (!wanted.has(id)) node.remove(); });

  if (timers.length === 0) {
    container.innerHTML = emptyHTML;
    return;
  }

  let anchor = container.firstChild;
  for (const t of timers) {
    const node = existing.get(t.id) || buildTimerNode(t);
    if (node === anchor) {
      anchor = node.nextSibling;          // już na właściwym miejscu
    } else {
      container.insertBefore(node, anchor); // wstaw/przesuń przed bieżącą kotwicę
    }
  }
}

// Usuwa z bazy timery, które przekroczyły okres linger. Wywoływane z pętli
// tick (oparte o zegar), nie z renderu — render odpala się tylko przy zmianie
// danych, więc wygasłe timery nie czekałyby na przypadkowy zapis. Guard w
// deleteTimer zapobiega dublowaniu zapisu w obrębie tej karty.
function cleanupExpiredTimers() {
  if (!db) return;
  const now = Date.now();
  Object.entries(timersState).forEach(([id, t]) => {
    if (now > t.startedAt + t.duration + POST_RESP_LINGER_MS) deleteTimer(id);
  });
}

function buildTimerNode(t) {
  const boss = BOSSES[t.boss];
  const node = document.createElement('div');
  node.className = 'timer';
  node.style.setProperty('--boss-color', boss.color);
  node.style.setProperty('--boss-image', `url("${boss.image}")`);
  node.dataset.id = t.id;
  node.dataset.boss = t.boss;
  node.dataset.startedAt = t.startedAt;
  node.dataset.duration = t.duration;

  node.innerHTML = `
    <div class="timer-mini-avatar"></div>
    <div class="timer-info">
      <div class="timer-line1">
        <span class="timer-ch">CH${t.channel}</span>
        <span class="timer-boss">${boss.name}</span>
      </div>
      <div class="timer-countdown" data-countdown>--:--</div>
    </div>
    <button class="timer-close" title="Usuń timer">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 3 L13 13 M13 3 L3 13"/>
      </svg>
    </button>
  `;

  node.querySelector('.timer-close').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTimer(t.id);
  });

  return node;
}

function tick() {
  const now = Date.now();
  let anyRespawnNow = false;

  cleanupExpiredTimers();   // sprzątanie oparte o zegar, nie o zmiany danych

  document.querySelectorAll('.timer').forEach(el => {
    const id = el.dataset.id;
    const startedAt = +el.dataset.startedAt;
    const duration = +el.dataset.duration;
    const remaining = duration - (now - startedAt);
    const cd = el.querySelector('[data-countdown]');

    el.classList.remove('warn', 'critical', 'respawn');

    if (remaining > WARN_THRESHOLD_MS) {
      cd.textContent = fmt(remaining);
    } else if (remaining > CRIT_THRESHOLD_MS) {
      cd.textContent = fmt(remaining);
      el.classList.add('warn');
    } else if (remaining > 0) {
      cd.textContent = fmt(remaining);
      el.classList.add('critical');
    } else if (-remaining < POST_RESP_LINGER_MS) {
      cd.textContent = 'RESP +' + fmt(-remaining);
      el.classList.add('respawn');
      anyRespawnNow = true;

      if (!notifiedAtZero.has(id)) {
        notifiedAtZero.add(id);
        beep();
        notify(el);
      }
    } else {
      cd.textContent = '—';
    }
  });

  document.title = anyRespawnNow
    ? '🔴 RESP! — Świątynia Hwang'
    : 'Świątynia Hwang — Timery Bossów';
}

function fmt(ms) {
  if (ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════
//   UTILS — connection, notifications, beep
// ════════════════════════════════════════════════════════════

function setConnStatus(state, text) {
  const dot = document.getElementById('connDot');
  const txt = document.getElementById('connText');
  dot.classList.remove('online', 'error');
  if (state === 'online') dot.classList.add('online');
  else if (state === 'error') dot.classList.add('error');
  txt.textContent = text;
}

function notify(el) {
  const boss = BOSSES[el.dataset.boss];
  const ch = el.querySelector('.timer-ch')?.textContent || '';
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Resp!', { body: `${boss.name} — ${ch}`, silent: false });
  }
}

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

document.getElementById('notifBtn').addEventListener('click', async () => {
  const btn = document.getElementById('notifBtn');
  if (!('Notification' in window)) { btn.textContent = 'Brak wsparcia'; return; }
  if (Notification.permission === 'granted') {
    btn.textContent = 'Powiadomienia: on';
    btn.classList.add('granted');
    return;
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    btn.textContent = 'Powiadomienia: on';
    btn.classList.add('granted');
  } else {
    btn.textContent = 'Powiadomienia: odrzucone';
  }
});

if ('Notification' in window && Notification.permission === 'granted') {
  const b = document.getElementById('notifBtn');
  b.textContent = 'Powiadomienia: on';
  b.classList.add('granted');
}
