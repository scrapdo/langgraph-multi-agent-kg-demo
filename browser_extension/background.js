// Background service worker. Handles the toolbar-button click, the keyboard
// shortcut, and polling the brain for run completion so we can fire a
// chrome.notifications when the answer is ready.
//
// Configuration: chrome.storage.sync.apiBase (defaults to http://127.0.0.1:8000).

const DEFAULT_API_BASE = 'http://127.0.0.1:8000';

async function apiBase() {
  const saved = await chrome.storage.sync.get('apiBase');
  return saved.apiBase || DEFAULT_API_BASE;
}

async function askAboutPage(question = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith('http')) {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.svg',
      title: 'Brain',
      message: 'No web page in the active tab.',
    });
    return;
  }

  // Grab the current selection from the page.
  let selection = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection ? window.getSelection().toString() : ''),
    });
    selection = (results && results[0] && results[0].result) || '';
  } catch {
    // Ignore — some pages block scripting (chrome://, file://, etc.).
  }

  const base = await apiBase();
  let runId = '';
  try {
    const res = await fetch(`${base}/ask-about-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ url: tab.url, title: tab.title || '', selection, question }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    runId = String(body.run_id || '');
  } catch (err) {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.svg',
      title: 'Brain unreachable',
      message: err && err.message ? err.message : 'Could not reach the brain backend.',
    });
    return;
  }

  await chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.svg',
    title: 'Sent to brain',
    message: `Run ${runId.slice(0, 8)} started. You'll get a note when it finishes.`,
  });

  // Poll until terminal.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(`${base}/runs/${runId}`);
      if (!res.ok) continue;
      const detail = await res.json();
      const status = detail.status;
      if (status === 'completed' || status === 'failed' || status === 'degraded') {
        const state = detail.state || {};
        const output = String(detail.output || state.final_report || state.final_answer || '').trim();
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.svg',
          title: status === 'completed' ? 'Brain finished' : `Run ${status}`,
          message: output.slice(0, 220) || `Run ${runId.slice(0, 8)} finished.`,
        });
        return;
      }
    } catch {
      // transient — keep polling
    }
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'ask-page') {
    void askAboutPage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'ask-page') {
    void askAboutPage(message.question || null).then(() => sendResponse({ ok: true }));
    return true; // keep the channel open
  }
  if (message && message.type === 'get-api-base') {
    void apiBase().then((base) => sendResponse({ base }));
    return true;
  }
  if (message && message.type === 'set-api-base') {
    void chrome.storage.sync.set({ apiBase: message.base || DEFAULT_API_BASE }).then(() =>
      sendResponse({ ok: true }),
    );
    return true;
  }
});
