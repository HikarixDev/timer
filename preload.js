// Most między procesem głównym a stroną overlaya. Tylko zdarzenia jednokierunkowe.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  // Skróty globalne z procesu głównego: { type:'start', channel } | { type:'cycleBoss' }
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  // Zmiana trybu click-through: { clickThrough: boolean }
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode))
});
