const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  version: process.versions.electron,

  // Splash lifecycle events — used only by splash.html.
  onStartupEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('startup-event', listener);
    return () => ipcRenderer.removeListener('startup-event', listener);
  },
  requestRetry: () => ipcRenderer.send('startup-retry'),
  quit: () => ipcRenderer.send('startup-quit'),

  // Main-window runtime bridge.
  onFocusInput: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('focus-input', listener);
    return () => ipcRenderer.removeListener('focus-input', listener);
  },
  focusWindow: () => ipcRenderer.send('focus-window'),
  notify: (payload) => ipcRenderer.send('notify', payload || {}),
  getWindowState: () => ipcRenderer.invoke('window-state'),
  trackBackgroundRun: (payload) => ipcRenderer.send('track-background-run', payload || {}),
});

// Composer mini-window bridge.
contextBridge.exposeInMainWorld('composer', {
  hide: () => ipcRenderer.send('composer-hide'),
  trackRun: (runId) => ipcRenderer.send('composer-track-run', runId),
});

// First-run wizard bridge. Only exposed when wizard.html is loaded; main.js
// sets a different preload for that window so these APIs are scoped.
contextBridge.exposeInMainWorld('brainWizard', {
  readConfig: () => ipcRenderer.invoke('wizard-read-config'),
  writeConfig: (patch) => ipcRenderer.invoke('wizard-write-config', patch || {}),
  startBackend: () => ipcRenderer.invoke('wizard-start-backend'),
});
