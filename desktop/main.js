const path = require('node:path');
const { app, BrowserWindow, Notification, globalShortcut, ipcMain, Menu, session, shell } = require('electron');

const {
  startServices,
  composeDown,
  resolveComposeFile,
  resolveProjectRoot,
  sendPhase,
  readConfig,
  writeConfig,
  stopBackend,
} = require('./launcher');

const isDev = !app.isPackaged;
const GLOBAL_HOTKEY = process.env.KG_HOTKEY || 'CommandOrControl+Shift+Space';
const COMPOSER_HOTKEY = process.env.KG_COMPOSER_HOTKEY || 'CommandOrControl+Alt+Space';
let splashWindow = null;
let mainWindow = null;
let composerWindow = null;
let wizardWindow = null;
let composeFilePath = null;
let shuttingDown = false;
let pendingBackgroundRuns = 0;

function updateDockBadge() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setBadge(pendingBackgroundRuns > 0 ? String(pendingBackgroundRuns) : '');
}

function incrementBadge() {
  pendingBackgroundRuns += 1;
  updateDockBadge();
}

function decrementBadge() {
  pendingBackgroundRuns = Math.max(0, pendingBackgroundRuns - 1);
  updateDockBadge();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('focus-input');
}

function notify({ title, body, silent = false }) {
  if (!Notification.isSupported()) return;
  try {
    const note = new Notification({ title: title || 'The Brain', body: body || '', silent });
    note.on('click', () => focusMainWindow());
    note.show();
  } catch {
    // Notifications can fail silently if permissions are denied.
  }
}

function createComposerWindow() {
  if (composerWindow && !composerWindow.isDestroyed()) return composerWindow;
  composerWindow = new BrowserWindow({
    width: 560,
    height: 130,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  composerWindow.loadFile(path.join(__dirname, 'composer.html'));
  composerWindow.on('blur', () => {
    if (composerWindow && !composerWindow.isDestroyed()) composerWindow.hide();
  });
  composerWindow.on('closed', () => {
    composerWindow = null;
  });
  return composerWindow;
}

function showComposerWindow() {
  const win = createComposerWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.focus();
    return;
  }
  win.center();
  win.show();
  win.focus();
}

/**
 * Poll a run id until it terminates, then fire a macOS notification and
 * decrement the dock badge. Used for both mini-composer and in-app
 * "send in background" submissions.
 */
let backendApiBase = 'http://127.0.0.1:8000';

async function watchRunAndNotify(runId, title) {
  if (!runId) return;
  incrementBadge();
  const http = require('node:http');
  const started = Date.now();
  const poll = () =>
    new Promise((resolve) => {
      const req = http.get(`${backendApiBase}/runs/${runId}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(body);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(null);
      });
    });
  try {
    while (Date.now() - started < 10 * 60 * 1000) {
      const detail = await poll();
      const status = detail && detail.status;
      if (status === 'completed' || status === 'failed' || status === 'degraded') {
        const output = (detail && (detail.output || (detail.state && (detail.state.final_report || detail.state.final_answer)))) || '';
        const body = String(output || '').trim().slice(0, 220) || `Run ${runId.slice(0, 8)} finished (${status}).`;
        const finalTitle = title || (status === 'completed' ? 'Brain finished' : `Run ${status}`);
        notify({ title: finalTitle, body });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    decrementBadge();
  }
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0d12',
    title: 'The Brain',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
  return splashWindow;
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    title: 'The Brain',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Only allow the main window to navigate to the embedded frontend and open
  // external links in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!shuttingDown) {
      // User closed the primary window — treat as a quit so services shut down.
      app.quit();
    }
  });

  return mainWindow;
}

function installCSP() {
  // Content-Security-Policy: restrict to local origins plus the third-party
  // endpoints the frontend needs (Google Fonts, Chromium speech-api for voice).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self' http://127.0.0.1:* http://localhost:*",
      "script-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https:",
      "media-src 'self' blob: data: http://127.0.0.1:* http://localhost:*",
      "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://speech.googleapis.com https://www.google.com wss://www.google.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function installPermissionHandlers() {
  // Without this handler Chromium silently denies microphone access from
  // non-https origins like http://127.0.0.1, which is why voice recognition
  // was aborting the instant we called .start().
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin) => {
    return permission === 'media' || permission === 'audioCapture' || permission === 'microphone';
  });
}

async function clearCacheOnBoot() {
  // Electron caches HTTP responses aggressively. Force a fresh fetch so a
  // newly-built frontend container's assets actually show up on launch.
  try {
    await session.defaultSession.clearCache();
  } catch {
    /* ignore */
  }
}

async function handleStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('Startup failed:', message);
  sendPhase(splashWindow, {
    phase: 'docker',
    message: 'Startup failed.',
    progress: 0,
    error: message,
  });
}

function createWizardWindow() {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.show();
    wizardWindow.focus();
    return;
  }
  wizardWindow = new BrowserWindow({
    width: 680,
    height: 680,
    backgroundColor: '#0a0d13',
    title: 'Brain — Setup',
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  wizardWindow.loadFile(path.join(__dirname, 'wizard.html'));
  wizardWindow.once('ready-to-show', () => wizardWindow.show());
  wizardWindow.on('closed', () => {
    wizardWindow = null;
  });
}

async function startBackendAfterWizard() {
  try {
    const { frontendUrl, composeFile, backendApiBase: api } = await startServices({ splashWindow, app });
    if (typeof api === 'string' && api) backendApiBase = api;
    composeFilePath = composeFile;
    setTimeout(() => {
      createMainWindow(frontendUrl);
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
    }, 200);
    return { ok: true };
  } catch (err) {
    await handleStartupFailure(err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// Wizard IPC — scoped, idempotent, safe to call repeatedly.
ipcMain.handle('wizard-read-config', () => {
  try {
    return readConfig();
  } catch {
    return {};
  }
});

ipcMain.handle('wizard-write-config', (_event, patch) => {
  const existing = readConfig();
  const merged = { ...existing, ...(patch || {}) };
  // Drop empty-string values so the user can "clear" a key by submitting blank.
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v === 'string' && v.trim() === '') delete merged[k];
  }
  writeConfig(merged);
  return { ok: true };
});

ipcMain.handle('wizard-start-backend', async () => startBackendAfterWizard());

async function boot() {
  createSplashWindow();

  installCSP();
  installPermissionHandlers();
  await clearCacheOnBoot();

  try {
    const { frontendUrl, composeFile, backendApiBase: api } = await startServices({ splashWindow, app });
    if (typeof api === 'string' && api) backendApiBase = api;
    composeFilePath = composeFile;

    // Small delay so users see the "ready" step briefly before the swap.
    setTimeout(() => {
      createMainWindow(frontendUrl);
      if (splashWindow) splashWindow.close();
    }, 400);
  } catch (err) {
    if (err && err.code === 'NEEDS_FIRST_RUN_CONFIG') {
      createWizardWindow();
      return;
    }
    await handleStartupFailure(err);
  }
}

ipcMain.on('focus-window', () => focusMainWindow());

ipcMain.on('notify', (_event, payload = {}) => {
  const { title, body, silent } = payload;
  if (mainWindow && mainWindow.isFocused()) return;
  notify({ title: String(title ?? ''), body: String(body ?? ''), silent: Boolean(silent) });
});

ipcMain.on('composer-hide', () => {
  if (composerWindow && !composerWindow.isDestroyed()) composerWindow.hide();
});

ipcMain.on('composer-track-run', (_event, runId) => {
  if (typeof runId === 'string' && runId) {
    void watchRunAndNotify(runId);
  }
});

ipcMain.on('track-background-run', (_event, payload = {}) => {
  const runId = typeof payload.runId === 'string' ? payload.runId : '';
  const title = typeof payload.title === 'string' ? payload.title : '';
  if (runId) void watchRunAndNotify(runId, title);
});

ipcMain.handle('window-state', () => ({
  focused: Boolean(mainWindow && mainWindow.isFocused()),
  visible: Boolean(mainWindow && mainWindow.isVisible()),
}));

ipcMain.on('startup-retry', async () => {
  if (splashWindow) {
    try {
      const { frontendUrl, composeFile, backendApiBase: api } = await startServices({ splashWindow, app });
    if (typeof api === 'string' && api) backendApiBase = api;
      composeFilePath = composeFile;
      setTimeout(() => {
        createMainWindow(frontendUrl);
        if (splashWindow) splashWindow.close();
      }, 400);
    } catch (err) {
      if (err && err.code === 'NEEDS_FIRST_RUN_CONFIG') {
        createWizardWindow();
        return;
      }
      await handleStartupFailure(err);
    }
  }
});

ipcMain.on('startup-quit', () => {
  app.quit();
});

function buildMenu() {
  const template = [
    {
      label: 'The Brain',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        {
          label: 'Hard Reload (clear cache)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: async () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            try {
              await session.defaultSession.clearCache();
            } catch {
              /* ignore */
            }
            mainWindow.webContents.reloadIgnoringCache();
          },
        },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  boot();

  const registered = globalShortcut.register(GLOBAL_HOTKEY, focusMainWindow);
  if (!registered) {
    // eslint-disable-next-line no-console
    console.warn(`Could not register global hotkey ${GLOBAL_HOTKEY} (already in use by another app).`);
  }

  const composerRegistered = globalShortcut.register(COMPOSER_HOTKEY, showComposerWindow);
  if (!composerRegistered) {
    // eslint-disable-next-line no-console
    console.warn(`Could not register composer hotkey ${COMPOSER_HOTKEY} (already in use by another app).`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
    else focusMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  const projectRoot = resolveProjectRoot(app);
  const composeFile = composeFilePath || resolveComposeFile(projectRoot);
  event.preventDefault();
  try {
    await composeDown(composeFile, projectRoot);
  } finally {
    app.exit(0);
  }
});
