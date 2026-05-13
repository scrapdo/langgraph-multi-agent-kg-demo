/*
 * Lifecycle orchestration for the native (Docker-free) desktop app.
 *
 * Flow:
 *   1. Show a splash window ASAP (done in main.js).
 *   2. Ensure ~/Library/Application Support/Brain/ exists.
 *   3. If config.json is missing required keys → launch first-run wizard.
 *   4. Spawn the bundled brain_backend binary as a subprocess.
 *   5. Poll http://127.0.0.1:8000/health until it answers.
 *   6. Load the pre-built frontend (file://…/dist/index.html) into the main window.
 *   7. On app quit, SIGTERM the backend child process.
 *
 * The main.js API is preserved: startServices, sendPhase, resolveProjectRoot
 * still exist. composeDown / resolveComposeFile are replaced by stopBackend /
 * no-op aliases so main.js doesn't need edits.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');

// Port resolution is dynamic so the native app can coexist with the legacy
// Docker stack (which holds 8000) on the same machine. We resolve at startup
// and stash the chosen port + URL on these module-level vars; spawnBackend,
// pingHealth and the URL we hand to the frontend all read from here.
const PREFERRED_PORT = parseInt(process.env.BRAIN_PORT || '8000', 10);
const BACKEND_HOST = process.env.BRAIN_HOST || '127.0.0.1';
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_TIMEOUT_MS = 60 * 1000;
let backendPort = PREFERRED_PORT;
let healthUrl = `http://${BACKEND_HOST}:${backendPort}/health`;
let apiBaseUrl = `http://${BACKEND_HOST}:${backendPort}`;

/**
 * Find a free TCP port on BACKEND_HOST starting at PREFERRED_PORT, walking
 * upward. We try the preferred port first so single-instance installs keep
 * the familiar 8000; only when something else is squatting it (Docker, a
 * leftover process) do we slide to 8001+. Returns the chosen port or
 * throws if 50 consecutive ports are unavailable (vanishingly unlikely on
 * a normal machine).
 */
function pickFreePort(start) {
  const tryBind = (port) =>
    new Promise((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, BACKEND_HOST);
    });
  return (async () => {
    for (let i = 0; i < 50; i++) {
      const port = start + i;
      // eslint-disable-next-line no-await-in-loop
      if (await tryBind(port)) return port;
    }
    throw new Error(`No free port found between ${start} and ${start + 49}.`);
  })();
}

// The required keys the backend needs before it can do anything useful.
// If config.json is missing all of these, we show the first-run wizard.
const REQUIRED_KEYS_FOR_USEFUL_BACKEND = ['OPENAI_API_KEY'];

let backendChild = null;

function sendPhase(win, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('startup-event', payload);
}

// ---------------------------------------------------------------------------
// Path resolution — dev vs packaged

function resolveProjectRoot(app) {
  if (app.isPackaged) return path.join(process.resourcesPath);
  return path.resolve(__dirname, '..');
}

function resolveBackendBinary(app) {
  // Packaged: we copy dist/brain_backend/ into the .app's resources.
  // Dev: read directly from the backend's build output.
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'brain_backend', 'brain_backend'),
        path.join(process.resourcesPath, 'backend', 'brain_backend', 'brain_backend'),
      ]
    : [path.join(__dirname, '..', 'backend', 'dist', 'brain_backend', 'brain_backend')];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveFrontendIndex(app) {
  // Packaged: frontend/dist is shipped as an extraResource.
  // Dev: either load from the Vite dev server (if BRAIN_DEV_FRONTEND_URL is
  // set) or from frontend/dist after `npm run build`.
  if (!app.isPackaged && process.env.BRAIN_DEV_FRONTEND_URL) {
    return { kind: 'http', url: process.env.BRAIN_DEV_FRONTEND_URL };
  }
  const distIndex = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend', 'index.html')
    : path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
  return { kind: 'file', path: distIndex };
}

function dataDir() {
  // macOS convention. Linux/Windows paths mirror the backend's default.
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Brain');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Brain');
  }
  return path.join(os.homedir(), '.local', 'share', 'brain');
}

// ---------------------------------------------------------------------------
// Config file: keys + flags live in a single JSON the first-run wizard writes

function configPath() {
  return path.join(dataDir(), 'config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(obj) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj || {}, null, 2), { mode: 0o600 });
}

function hasMinimumConfig(cfg) {
  if (!cfg) return false;
  for (const key of REQUIRED_KEYS_FOR_USEFUL_BACKEND) {
    const v = cfg[key] ?? cfg[key.toLowerCase()];
    if (typeof v === 'string' && v.trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Backend subprocess lifecycle

function envForBackend(cfg) {
  const env = { ...process.env };
  env.BRAIN_PORT = String(backendPort);
  env.BRAIN_HOST = BACKEND_HOST;
  env.BRAIN_DATA_DIR = dataDir();
  // Flatten config into env vars. The backend picks them up via pydantic-settings.
  if (cfg && typeof cfg === 'object') {
    for (const [k, v] of Object.entries(cfg)) {
      if (v === null || v === undefined) continue;
      env[String(k).toUpperCase()] = String(v);
    }
  }
  // Explicitly blank the Docker-era services so the optional-service guards activate.
  env.POSTGRES_DSN = env.POSTGRES_DSN || '';
  env.REDIS_URL = env.REDIS_URL || '';
  env.NEO4J_URI = env.NEO4J_URI || '';
  return env;
}

function spawnBackend(app, cfg) {
  const bin = resolveBackendBinary(app);
  if (!bin) {
    throw new Error(
      'Bundled backend binary not found. Build it first with:\n' +
        '  cd backend && .venv-native/bin/pyinstaller brain_backend.spec --noconfirm',
    );
  }

  if (backendChild && !backendChild.killed) {
    return backendChild;
  }

  const child = spawn(bin, [], {
    env: envForBackend(cfg),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Surface backend output in the Electron console so we can debug spawn
  // failures without having to attach a debugger.
  child.stdout.on('data', (buf) => process.stdout.write(`[backend] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[backend] ${buf}`));
  child.on('exit', (code, signal) => {
    // eslint-disable-next-line no-console
    console.log(`[backend] exit code=${code} signal=${signal}`);
    backendChild = null;
  });
  child.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[backend] spawn error:', err);
  });

  backendChild = child;
  return child;
}

async function stopBackend() {
  if (!backendChild || backendChild.killed) return;
  return new Promise((resolve) => {
    const child = backendChild;
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      done();
      return;
    }
    // Force-kill after 3s if it's stuck.
    setTimeout(() => {
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      done();
    }, 3000);
  });
}

// ---------------------------------------------------------------------------
// Health polling

function pingHealth() {
  return new Promise((resolve) => {
    const req = http.get(healthUrl, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(onTick) {
  const start = Date.now();
  while (Date.now() - start < HEALTH_POLL_TIMEOUT_MS) {
    if (await pingHealth()) return true;
    if (onTick) onTick(Date.now() - start);
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Top-level startup orchestrator

async function startServices({ splashWindow, app }) {
  fs.mkdirSync(dataDir(), { recursive: true });

  // Resolve a free port BEFORE we read config / spawn anything. If 8000 is
  // taken (Docker stack, another Brain instance, etc.) we slide upward.
  // The chosen port flows through to the spawned backend, the health URL,
  // and the frontend's API base.
  backendPort = await pickFreePort(PREFERRED_PORT);
  healthUrl = `http://${BACKEND_HOST}:${backendPort}/health`;
  apiBaseUrl = `http://${BACKEND_HOST}:${backendPort}`;
  if (backendPort !== PREFERRED_PORT) {
    // eslint-disable-next-line no-console
    console.log(`[launcher] port ${PREFERRED_PORT} in use; bound to ${backendPort} instead.`);
  }

  const cfg = readConfig();
  if (!hasMinimumConfig(cfg)) {
    // Tell main.js that the first-run wizard needs to run. main.js opens
    // composer-style window at file://wizard.html, collects keys, writes config.
    // After the wizard writes config, main.js triggers startup-retry which
    // re-enters this function with config in place.
    sendPhase(splashWindow, {
      phase: 'needs-config',
      message: 'Welcome — let’s set up your API keys.',
      progress: 0,
    });
    const err = new Error('NEEDS_FIRST_RUN_CONFIG');
    err.code = 'NEEDS_FIRST_RUN_CONFIG';
    throw err;
  }

  sendPhase(splashWindow, { phase: 'spawn', message: 'Starting the Brain…', progress: 20 });
  spawnBackend(app, cfg);

  sendPhase(splashWindow, { phase: 'health', message: 'Waiting for the Brain to come online…', progress: 55 });
  const healthy = await waitForHealth((elapsed) => {
    const seconds = Math.round(elapsed / 1000);
    const progress = Math.min(95, 55 + Math.floor((elapsed / HEALTH_POLL_TIMEOUT_MS) * 40));
    sendPhase(splashWindow, {
      phase: 'health',
      message: `Waiting for the Brain to come online… (${seconds}s)`,
      progress,
    });
  });
  if (!healthy) {
    await stopBackend();
    throw new Error(
      `The backend did not come online on ${healthUrl} within ${HEALTH_POLL_TIMEOUT_MS / 1000}s.\n` +
        'Check the console for [backend] log lines.',
    );
  }

  sendPhase(splashWindow, { phase: 'ready', message: 'Opening the console…', progress: 100 });

  const frontend = resolveFrontendIndex(app);
  // Tag the frontend URL with the resolved API base so the bundled JS can
  // hit the right port even though it was built with localhost:8000 baked
  // in. The inline script in frontend/index.html reads ?api_base= and
  // promotes it to window.__BRAIN_API_BASE__ before React mounts.
  const baseUrl = frontend.kind === 'http' ? frontend.url : `file://${frontend.path}`;
  const sep = baseUrl.includes('?') ? '&' : '?';
  const frontendUrl = `${baseUrl}${sep}api_base=${encodeURIComponent(apiBaseUrl)}`;
  return {
    // Kept for main.js backward compatibility.
    frontendUrl,
    frontend,
    composeFile: null, // legacy field — always null in native mode
    backendHealthUrl: healthUrl,
    backendApiBase: apiBaseUrl,
    backendPort,
  };
}

// ---------------------------------------------------------------------------
// Legacy aliases — main.js still imports these. Map them to the native ops
// so we don't have to edit main.js.

function resolveComposeFile(_projectRoot) {
  // Compose no longer exists; return a safe placeholder so existing main.js
  // paths don't crash when they read the value.
  return null;
}

async function composeDown(_composeFile, _projectRoot) {
  // "Compose down" in native mode == stop the backend subprocess.
  await stopBackend();
}

module.exports = {
  // Public API used by main.js
  startServices,
  composeDown,          // legacy name, now wraps stopBackend
  resolveComposeFile,   // legacy name, always returns null
  resolveProjectRoot,
  sendPhase,
  // New surface — used by the first-run wizard IPC handler
  dataDir,
  configPath,
  readConfig,
  writeConfig,
  hasMinimumConfig,
  stopBackend,
  spawnBackend,
  waitForHealth,
  HEALTH_URL,
  REQUIRED_KEYS_FOR_USEFUL_BACKEND,
};
