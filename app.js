/* ════════════════════════════════════════════════════════
   Świątynia Hwang — Boss Respawn Tracker
   app.js
   ════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import {
  getDatabase, ref, push, onValue, remove, set, serverTimestamp
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
    respMs: 80 * 60 * 1000,    // 1h 20min
    color: '#0ea5e9',
    image: IMG_PRZYWOLYWACZ,
    note: 'Odpal timer po zabiciu Przywoływacza — NIE Reinkarnacji!'
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

// Głos (Web Speech). voiceOn zapamiętane lokalnie; spokenSet pilnuje, by każdy
// komunikat (1 min / respawn) padł tylko raz na timer.
let voiceOn = localStorage.getItem('hwang-voice') === '1';
let spokenSet = new Set();
let plVoice = null;

// Różnica między zegarem tego klienta a zegarem serwera Firebase
// (serverTime ≈ Date.now() + serverTimeOffset). Dzięki temu timery liczą się
// w czasie SERWERA, więc wszyscy gracze widzą tę samą sekundę niezależnie od
// tego, jak ustawiony jest ich lokalny zegar.
let serverTimeOffset = 0;
function serverNow() { return Date.now() + serverTimeOffset; }

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

// ─── KALIBRACJA KOORDÓW ─────────────────────────────────────
// Koordy z gry (te pod minimapą) są liniowe po całej mapie, ale nie znamy
// rozmiaru tej konkretnej mapy ani czy obraz nie jest przycięty. Zamiast
// zgadywać, wyznaczamy przekształcenie afiniczne (osobno X i Y) z dwóch
// punktów odniesienia podanych przez gracza. calib = współczynniki:
//   normX = ax*gameX + bx ,  normY = ay*gameY + by
// Punkty źródłowe trzymamy w Firebase (współdzielone), współczynniki liczymy
// lokalnie. Dwa punkty muszą różnić się i X, i Y (po przekątnej).
let calibPoints = null;   // [{gx, gy, nx, ny}, …] — surowe punkty z Firebase
let calib = null;         // {ax, bx, ay, by} — wyliczone współczynniki

function computeCalib(p1, p2) {
  if (!p1 || !p2) return null;
  if (p1.gx === p2.gx || p1.gy === p2.gy) return null;   // brak przekątnej
  const ax = (p2.nx - p1.nx) / (p2.gx - p1.gx);
  const ay = (p2.ny - p1.ny) / (p2.gy - p1.gy);
  return { ax, bx: p1.nx - ax * p1.gx, ay, by: p1.ny - ay * p1.gy };
}

// Koord z gry → pozycja znormalizowana 0–1 na mapie (lub null bez kalibracji).
function gameToNorm(gx, gy) {
  if (!calib) return null;
  return { x: calib.ax * gx + calib.bx, y: calib.ay * gy + calib.by };
}

// Pozycja znormalizowana 0–1 → koord z gry (odwrotność, do podglądu na hover).
function normToGame(nx, ny) {
  if (!calib) return null;
  return { x: (nx - calib.bx) / calib.ax, y: (ny - calib.by) / calib.ay };
}

// Sufiks dymka markera z koordami z gry (pusty gdy mapa nieskalibrowana).
function coordSuffix(s) {
  const g = normToGame(s.x, s.y);
  return g ? ` · ${Math.round(g.x)}, ${Math.round(g.y)}` : '';
}

function saveCalibration(p1, p2) {
  return set(ref(db, 'calibration'), { p1, p2, updatedAt: Date.now() })
    .catch(err => {
      console.error('saveCalibration failed', err);
      alert('Nie udało się zapisać kalibracji: ' + err.message);
    });
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
    // Dane (timery/sightingi) podłączamy najpierw i niezależnie od UI mapy —
    // ewentualna awaria setupMap (np. stary, zcache'owany HTML bez nowych
    // elementów) nie może wyczyścić widoku timerów.
    subscribe();
    try { setupMap(); }
    catch (e) { console.error('setupMap failed — coord/map UI disabled:', e); }
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

    const noteHTML = boss.note
      ? `<div class="boss-note">${boss.note}</div>`
      : '';

    card.innerHTML = `
      <div class="boss-header">
        <div class="boss-avatar"></div>
        <div class="boss-name">${boss.name}</div>
        <div class="boss-resp">${respLabel}</div>
      </div>
      ${noteHTML}
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

// Stan trybu kalibracji. calMode=true gdy gracz wskazuje punkty odniesienia.
// calPending trzyma znorm. pozycję kliknięcia, dla której czekamy na wpisanie
// koordów z gry. calCollected gromadzi gotowe punkty (max 2).
let calMode = false;
let calPending = null;     // {nx, ny} — punkt klikniętej pozycji oczekujący na koordy
let calCollected = [];     // [{gx, gy, nx, ny}, …]

const HINT_DEFAULT = 'Kliknij na mapę aby dodać znacznik. Kliknij znacznik aby usunąć. Kliknij bossa w legendzie aby ukryć/pokazać.';

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

  // Klik na mapę = picker wyboru bossa, albo (w trybie kalibracji) wskazanie
  // punktu odniesienia.
  map.addEventListener('click', (e) => {
    // Jeśli kliknięto na istniejący marker — nic nie rób (handler markera załatwi delete)
    if (e.target.classList.contains('map-marker')) return;

    const rect = map.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Pozycje zapisujemy jako procenty 0–1 żeby były odporne na zmianę rozmiaru mapy
    const x = px / rect.width;
    const y = py / rect.height;

    if (calMode) {
      if (calPending) return;            // czekamy aż gracz wpisze koordy poprzedniego punktu
      calPending = { nx: x, ny: y };
      showCalPopup(px, py);
      return;
    }

    showPicker(px, py, x, y);
  });

  // Podgląd koordów z gry pod kursorem (gdy mapa skalibrowana)
  const coordsEl = document.getElementById('mapCoords');
  map.addEventListener('mousemove', (e) => {
    if (!calib) return;
    const rect = map.getBoundingClientRect();
    const g = normToGame((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    if (!g) return;
    coordsEl.hidden = false;
    coordsEl.textContent = `${Math.round(g.x)}, ${Math.round(g.y)}`;
  });
  map.addEventListener('mouseleave', () => { coordsEl.hidden = true; });

  // Zamknięcie pickera po kliknięciu gdziekolwiek poza nim
  document.addEventListener('click', (e) => {
    if (picker.hidden) return;
    if (picker.contains(e.target)) return;
    if (e.target.closest('.map') && !e.target.classList.contains('map-marker')) return; // właśnie się otwiera
    hidePicker();
  }, { capture: true });

  // Wpisanie koordów z gry → otwiera picker wyboru bossa w tym miejscu
  document.getElementById('coordForm').addEventListener('submit', (e) => {
    e.preventDefault();
    placeByCoords();
  });

  // Przyciski / formularz kalibracji
  document.getElementById('calBtn').addEventListener('click', toggleCalibration);
  document.getElementById('calPopupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitCalPoint();
  });

  // Escape przerywa kalibrację
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && calMode) cancelCalibration();
  });

  // Zmiana rozmiaru mapy zmienia odległości markerów w pikselach → przelicz
  // rozsunięcie. Throttling przez requestAnimationFrame.
  let relayoutQueued = false;
  window.addEventListener('resize', () => {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => { relayoutQueued = false; layoutMarkers(); });
  });

  updateCoordUI();
}

// Generyczne pozycjonowanie popupu względem .map-wrap tak, by nie wychodził
// poza obszar mapy. (px, py) to pozycja kliknięcia liczona od lewego-górnego
// rogu mapy.
function positionPopup(popup, px, py, estW, estH) {
  const map = document.getElementById('map');
  const mapRect = map.getBoundingClientRect();
  const wrapRect = map.parentElement.getBoundingClientRect();
  const offX = mapRect.left - wrapRect.left;
  const offY = mapRect.top - wrapRect.top;

  let left = offX + px - estW / 2;
  let top  = offY + py + 14;
  if (left < offX) left = offX;
  if (left + estW > offX + mapRect.width) left = offX + mapRect.width - estW;
  if (top + estH > offY + mapRect.height) top = offY + py - estH - 14;
  if (top < offY) top = offY;
  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';
}

function showPicker(px, py, normX, normY) {
  const picker = document.getElementById('mapPicker');
  picker.hidden = false;
  picker.dataset.x = normX;
  picker.dataset.y = normY;
  positionPopup(picker, px, py, 180, 80);
}

function hidePicker() {
  document.getElementById('mapPicker').hidden = true;
}

// ─── WSTAWIANIE PO KOORDACH ─────────────────────────────────
function parseCoords(str) {
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]+\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { gx: parseFloat(m[1]), gy: parseFloat(m[2]) };
}

function setCoordStatus(text, isError) {
  const el = document.getElementById('coordStatus');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function placeByCoords() {
  if (!calib) { setCoordStatus('Najpierw skalibruj mapę (przycisk Kalibruj).', true); return; }
  const input = document.getElementById('coordInput');
  const parsed = parseCoords(input.value);
  if (!parsed) { setCoordStatus('Wpisz koordy w formacie: 934, 306', true); return; }

  const n = gameToNorm(parsed.gx, parsed.gy);
  if (n.x < -0.02 || n.x > 1.02 || n.y < -0.02 || n.y > 1.02) {
    setCoordStatus(`Koordy ${parsed.gx}, ${parsed.gy} wypadają poza mapą.`, true);
    return;
  }

  // Otwórz picker wyboru bossa w wyliczonym miejscu (spójnie z klikaniem)
  const map = document.getElementById('map');
  const rect = map.getBoundingClientRect();
  showPicker(n.x * rect.width, n.y * rect.height, n.x, n.y);
  setCoordStatus('Wybierz bossa dla punktu ' + parsed.gx + ', ' + parsed.gy);
  input.value = '';
}

// ─── KALIBRACJA — przepływ UI ───────────────────────────────
function toggleCalibration() {
  if (calMode) { cancelCalibration(); return; }
  calMode = true;
  calPending = null;
  calCollected = [];
  hidePicker();
  document.getElementById('calBtn').classList.add('active');
  document.getElementById('calBtn').textContent = 'Anuluj';
  document.getElementById('map').classList.add('calibrating');
  updateCalHint();
}

function cancelCalibration() {
  calMode = false;
  calPending = null;
  calCollected = [];
  hideCalPopup();
  document.getElementById('calBtn').classList.remove('active');
  document.getElementById('calBtn').textContent = 'Kalibruj';
  document.getElementById('map').classList.remove('calibrating');
  document.getElementById('mapHint').textContent = HINT_DEFAULT;
}

function updateCalHint() {
  const n = calCollected.length;
  document.getElementById('mapHint').textContent =
    `KALIBRACJA ${n + 1}/2 — kliknij na mapie miejsce, którego koordy z gry znasz` +
    (n === 1 ? ' (najlepiej po przekątnej od pierwszego).' : '.');
}

function showCalPopup(px, py) {
  const popup = document.getElementById('calPopup');
  popup.hidden = false;
  positionPopup(popup, px, py, 170, 80);
  const input = document.getElementById('calPopupInput');
  input.value = '';
  input.focus();
}

function hideCalPopup() {
  document.getElementById('calPopup').hidden = true;
}

function submitCalPoint() {
  if (!calPending) return;
  const input = document.getElementById('calPopupInput');
  const parsed = parseCoords(input.value);
  if (!parsed) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }

  calCollected.push({ gx: parsed.gx, gy: parsed.gy, nx: calPending.nx, ny: calPending.ny });
  calPending = null;
  hideCalPopup();

  if (calCollected.length < 2) {
    updateCalHint();
    return;
  }

  // Mamy dwa punkty — sprawdź przekątną i zapisz
  const [p1, p2] = calCollected;
  if (computeCalib(p1, p2) === null) {
    setCoordStatus('Punkty muszą różnić się X oraz Y — spróbuj ponownie.', true);
    calCollected = [];
    updateCalHint();
    return;
  }
  saveCalibration(p1, p2);   // subskrypcja Firebase przeliczy calib i odświeży UI
  cancelCalibration();
  setCoordStatus('Mapa skalibrowana. Możesz wstawiać znaczniki po koordach.');
}

const WARN_NOCAL = 'Mapa nieskalibrowana — kliknij Kalibruj, aby wpisywać koordy.';

// Włącza/wyłącza pole koordów i komunikat zależnie od dostępności kalibracji.
// Gdy mapa staje się gotowa, czyścimy tylko nieaktualne ostrzeżenie — nie
// nadpisujemy np. komunikatu o sukcesie kalibracji.
function updateCoordUI() {
  const input = document.getElementById('coordInput');
  const go = document.getElementById('coordGo');
  const status = document.getElementById('coordStatus');
  if (!input || !go || !status) return;   // stary/zcache'owany HTML — pomiń
  const ready = !!calib;
  input.disabled = !ready;
  go.disabled = !ready;
  input.placeholder = ready ? 'Wpisz koordy: 934, 306' : 'Najpierw kalibracja →';

  if (!ready && !calMode) setCoordStatus(WARN_NOCAL, true);
  else if (ready && status.textContent === WARN_NOCAL) setCoordStatus('');
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

    // Dymek = nazwa bossa + (jeśli mapa skalibrowana) koordy z gry
    const label = boss.name + coordSuffix(s);

    if (existing.has(id)) {         // już na mapie — odświeżamy tylko dymek
      const el = existing.get(id);
      el.dataset.name = label;
      el.title = label;
      return;
    }

    const m = document.createElement('div');
    m.className = 'map-marker';
    m.dataset.id = id;
    m.dataset.boss = s.boss;
    m.dataset.bx = s.x;             // pozycja bazowa 0–1 (do liczenia kolizji w pikselach)
    m.dataset.by = s.y;
    m.style.setProperty('--marker-color', boss.color);
    m.style.left = (s.x * 100) + '%';
    m.style.top  = (s.y * 100) + '%';
    m.dataset.name = label;
    m.title = label;
    // Dymek nad markerem jest przycinany przez overflow:hidden mapy gdy marker
    // leży blisko krawędzi. Kotwiczymy go więc do wnętrza mapy zależnie od pozycji.
    if (s.x > 0.7)      m.classList.add('tip-left');
    else if (s.x < 0.3) m.classList.add('tip-right');
    if (s.y < 0.15)     m.classList.add('tip-below');
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      if (calMode) return;          // w trybie kalibracji nie usuwamy markerów
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
  layoutMarkers();   // rozsuń nakładające się markery (po filtrze, by liczyć tylko widoczne)

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

// ─── ROZSUWANIE NAKŁADAJĄCYCH SIĘ MARKERÓW ("spiderfy") ─────
// Markery sightingów grupują się w tych samych rejonach mapy i nakładają się
// na siebie — wtedy nie widać, ile ich jest, ani którego usuwasz. Po każdym
// renderze (i przy zmianie rozmiaru mapy) liczymy pozycje w pikselach, łączymy
// markery bliższe niż próg w grupy, a każdą grupę rozkładamy w pierścień wokół
// jej środka. Markery są przesuwane właściwością `translate` (osobną od
// `transform`, więc hover/animacja popu działają dalej), a cienka „nóżka”
// (::before) łączy rozsunięty marker z centrum skupiska. Pojedyncze markery
// bez sąsiada nie ruszają się.
const FAN_THRESHOLD_PX = 18;   // bliżej niż tyle px = traktujemy jako nakładające się

function layoutMarkers() {
  const map = document.getElementById('map');
  if (!map) return;
  const rect = map.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const markers = [...map.querySelectorAll('.map-marker')]
    .filter(el => !el.classList.contains('filtered-out'));

  // Reset poprzedniego rozsunięcia — layout jest idempotentny
  markers.forEach(el => {
    el.classList.remove('fanned');
    el.style.removeProperty('--fan-x');
    el.style.removeProperty('--fan-y');
    el.style.removeProperty('--leader-len');
    el.style.removeProperty('--leader-angle');
  });

  const pts = markers.map(el => ({
    el,
    px: parseFloat(el.dataset.bx) * rect.width,
    py: parseFloat(el.dataset.by) * rect.height
  }));

  clusterPoints(pts, FAN_THRESHOLD_PX).forEach(group => {
    if (group.length < 2) return;
    const cx = group.reduce((s, p) => s + p.px, 0) / group.length;
    const cy = group.reduce((s, p) => s + p.py, 0) / group.length;
    const n = group.length;
    // Promień pierścienia tak dobrany, by odstęp między sąsiadami ≳ 16 px
    const R = Math.min(Math.max(13, n * 2.6), 46);
    group.forEach((p, i) => {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const fx = cx + Math.cos(ang) * R - p.px;
      const fy = cy + Math.sin(ang) * R - p.py;
      p.el.classList.add('fanned');
      p.el.style.setProperty('--fan-x', fx.toFixed(1) + 'px');
      p.el.style.setProperty('--fan-y', fy.toFixed(1) + 'px');
      // Nóżka biegnie od rozsuniętego markera z powrotem do środka skupiska
      p.el.style.setProperty('--leader-len', R.toFixed(1) + 'px');
      p.el.style.setProperty('--leader-angle', (ang * 180 / Math.PI + 180).toFixed(1) + 'deg');
    });
  });
}

// Grupowanie pojedynczym wiązaniem (union-find): markery połączone, gdy są
// bliżej niż próg. N sightingów jest niewielkie, więc O(n²) wystarcza.
function clusterPoints(pts, thresh) {
  const parent = pts.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const t2 = thresh * thresh;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].px - pts[j].px, dy = pts[i].py - pts[j].py;
      if (dx * dx + dy * dy <= t2) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  pts.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });
  return [...groups.values()];
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

  // Firebase sam estymuje offset zegara względem serwera — śledzimy go, żeby
  // wszystkie obliczenia czasu (poniżej) opierały się o czas serwera.
  onValue(ref(db, '.info/serverTimeOffset'), snap => {
    serverTimeOffset = snap.val() || 0;
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

  onValue(ref(db, 'calibration'), snapshot => {
    const v = snapshot.val();
    if (v && v.p1 && v.p2) {
      calibPoints = [v.p1, v.p2];
      calib = computeCalib(v.p1, v.p2);
    } else {
      calibPoints = null;
      calib = null;
    }
    updateCoordUI();
    renderSightings();   // odśwież dymki markerów o koordy
  }, err => {
    console.error('calibration onValue error:', err);
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
    startedAt: serverTimestamp(),   // znacznik stempluje SERWER, nie zegar klikającego
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
  const now = serverNow();

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
  const now = serverNow();
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
  const now = serverNow();
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
      voiceCue(el, '60', 'minuta');   // ostrzeżenie na minutę przed
    } else if (-remaining < POST_RESP_LINGER_MS) {
      cd.textContent = 'RESP +' + fmt(-remaining);
      el.classList.add('respawn');
      anyRespawnNow = true;

      if (!notifiedAtZero.has(id)) {
        notifiedAtZero.add(id);
        beep();
        notify(el);
      }
      voiceCue(el, '0', 'respawn');
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

// Wypowiada komunikat dla danego timera raz na (timer, etap).
function voiceCue(el, tag, word) {
  if (!voiceOn) return;
  const key = el.dataset.id + ':' + tag;
  if (spokenSet.has(key)) return;
  spokenSet.add(key);
  const boss = BOSSES[el.dataset.boss];
  const ch = (el.querySelector('.timer-ch')?.textContent || '').replace(/\D/g, '');
  speak(`${boss.name}, kanał ${ch}, ${word}`);
}

(function wireVoice() {
  const btn = document.getElementById('voiceBtn');
  if (!btn) return;
  btn.textContent = 'Głos: ' + (voiceOn ? 'on' : 'off');
  btn.classList.toggle('granted', voiceOn);
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  btn.addEventListener('click', () => {
    voiceOn = !voiceOn;
    localStorage.setItem('hwang-voice', voiceOn ? '1' : '0');
    btn.textContent = 'Głos: ' + (voiceOn ? 'on' : 'off');
    btn.classList.toggle('granted', voiceOn);
    if (voiceOn) speak('Głos włączony');   // klik = gest użytkownika, odblokowuje audio
  });
})();

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
