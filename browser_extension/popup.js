const q = document.getElementById('question');
const send = document.getElementById('send');
const sendEmpty = document.getElementById('send-empty');
const status = document.getElementById('status');
const apiBaseInput = document.getElementById('api-base');
const saveApi = document.getElementById('save-api');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

async function loadApiBase() {
  chrome.runtime.sendMessage({ type: 'get-api-base' }, (resp) => {
    if (resp && resp.base) apiBaseInput.value = resp.base;
  });
}
loadApiBase();

saveApi.addEventListener('click', () => {
  const base = apiBaseInput.value.trim();
  chrome.runtime.sendMessage({ type: 'set-api-base', base }, (resp) => {
    if (resp && resp.ok) setStatus('Saved API endpoint.', 'ok');
  });
});

async function ask(question) {
  setStatus('Sending…');
  chrome.runtime.sendMessage({ type: 'ask-page', question }, (resp) => {
    if (resp && resp.ok) {
      setStatus("Sent. You'll be notified when it finishes.", 'ok');
      setTimeout(() => window.close(), 900);
    } else {
      setStatus('Could not send. Check the API URL below.', 'err');
    }
  });
}

send.addEventListener('click', () => {
  const question = q.value.trim() || null;
  ask(question);
});
sendEmpty.addEventListener('click', () => ask(null));
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    send.click();
  }
});
