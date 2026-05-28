// ════════════════════════════════════════════════════════════
//   Hwang Overlay — proces główny Electron
//   Tworzy przezroczyste, zawsze-na-wierzchu okno HUD nad grą.
// ════════════════════════════════════════════════════════════
const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const path = require('path');

let win = null;

// Start w trybie klikalnym, żeby od razu ustawić bossa / włączyć głos.
// Ctrl+Alt+X przełącza w tryb przepuszczający kliknięcia (HUD nie przeszkadza w grze).
let clickThrough = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 300, H = 460;

  win = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 16,   // prawy-górny róg ekranu
    y: workArea.y + 16,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Poziom 'screen-saver' trzyma okno nad pełnoekranowymi oknami gier.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'overlay.html'));

  // showInactive() — pokaż bez zabierania fokusu grze.
  win.once('ready-to-show', () => {
    win.showInactive();
    applyClickThrough();
  });
}

function applyClickThrough() {
  if (!win) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  win.webContents.send('mode', { clickThrough });
}

function registerShortcuts() {
  // Ctrl+Alt+1..6 — wystartuj timer aktywnego bossa na danym kanale.
  for (let ch = 1; ch <= 6; ch++) {
    globalShortcut.register(`CommandOrControl+Alt+${ch}`, () => {
      win?.webContents.send('hotkey', { type: 'start', channel: ch });
    });
  }
  // Ctrl+Alt+B — przełącz aktywnego bossa (dla skrótów 1..6).
  globalShortcut.register('CommandOrControl+Alt+B', () => {
    win?.webContents.send('hotkey', { type: 'cycleBoss' });
  });
  // Ctrl+Alt+X — tryb klikalny / przepuszczający kliknięcia.
  globalShortcut.register('CommandOrControl+Alt+X', () => {
    clickThrough = !clickThrough;
    applyClickThrough();
  });
  // Ctrl+Alt+H — pokaż / ukryj overlay.
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
}

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
