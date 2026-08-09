import RFB from '/console/vendor/core/rfb.js';

const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const overlayEl = document.getElementById('overlay');
const cardEl = document.getElementById('card');
const ctrlAltDelBtn = document.getElementById('ctrlAltDel');
const fullscreenBtn = document.getElementById('fullscreen');

let rfb = null;
let consoleData = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function showError(title, message) {
  overlayEl.classList.remove('hidden');
  cardEl.innerHTML = '';
  const h = document.createElement('h1');
  const p = document.createElement('p');
  h.textContent = title;
  p.textContent = message;
  cardEl.append(h, p);
  setStatus(title);
  ctrlAltDelBtn.disabled = true;
}

function tokenFromFragment() {
  const raw = String(window.location.hash || '').replace(/^#/, '').trim();
  if (!raw) return '';
  history.replaceState(null, document.title, window.location.pathname);
  return raw;
}

async function exchangeToken(token) {
  const response = await fetch('/console/session', {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      'x-console-request': 'true'
    },
    body: JSON.stringify({ token })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok || !body.data) {
    const error = new Error(body.message || 'این لینک کنسول معتبر نیست یا منقضی شده است.');
    error.code = body.error || 'CONSOLE_SESSION_INVALID';
    throw error;
  }
  return body.data;
}

function connect(data) {
  if (!/^wss:\/\//i.test(String(data.wssUrl || '')) || !data.password) {
    throw new Error('اطلاعات اتصال کنسول ناقص است.');
  }

  consoleData = data;
  setStatus('در حال اتصال به سرور…');
  overlayEl.classList.remove('hidden');

  rfb = new RFB(screenEl, data.wssUrl, {
    credentials: { password: data.password },
    shared: true
  });
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.clipViewport = false;
  rfb.background = '#05070b';

  rfb.addEventListener('credentialsrequired', () => {
    rfb.sendCredentials({ password: consoleData.password });
  });

  rfb.addEventListener('connect', () => {
    overlayEl.classList.add('hidden');
    setStatus(`متصل${data.serverId ? ` — سرور ${data.serverId}` : ''}`);
    ctrlAltDelBtn.disabled = false;
    rfb.focus();
  });

  rfb.addEventListener('desktopname', (event) => {
    const name = String(event.detail?.name || '').trim();
    if (name) setStatus(`متصل — ${name}`);
  });

  rfb.addEventListener('securityfailure', () => {
    showError('خطای احراز هویت کنسول', 'لینک جدیدی از داخل ربات بسازید و دوباره امتحان کنید.');
  });

  rfb.addEventListener('disconnect', (event) => {
    ctrlAltDelBtn.disabled = true;
    if (event.detail?.clean) {
      showError('اتصال کنسول بسته شد', 'برای اتصال دوباره، از داخل ربات لینک کنسول جدید بسازید.');
    } else {
      showError('اتصال کنسول قطع شد', 'لینک احتمالاً منقضی شده یا اتصال شبکه قطع شده است. از داخل ربات لینک جدید بسازید.');
    }
  });
}

ctrlAltDelBtn.addEventListener('click', () => {
  if (rfb) rfb.sendCtrlAltDel();
});

fullscreenBtn.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (_) {}
});

window.addEventListener('beforeunload', () => {
  try { rfb?.disconnect(); } catch (_) {}
});

(async () => {
  try {
    const token = tokenFromFragment();
    if (!token) {
      showError('لینک کنسول پیدا نشد', 'کنسول را از داخل ربات HamoonCloud باز کنید.');
      return;
    }
    const data = await exchangeToken(token);
    connect(data);
  } catch (error) {
    showError('باز کردن کنسول ممکن نشد', error.message || 'از داخل ربات لینک جدید بسازید.');
  }
})();
