/* Attentix popup.
 *
 * Views (document.body.dataset.view):
 *   loading       asking the background worker whether this browser already joined a class (spinner)
 *   idle          not joined: the Join Class form, with inline validation
 *   joining       the form was submitted: fields disabled, spinner on the button (also the `loading` look)
 *   connected     joined and talking to the server: score ring, state, class + student, connection health
 *   reconnecting  joined, but the server cannot be reached (or only the REST backup works): same view + a banner with Retry
 *
 * The popup never handles a password. Joining is one POST to /api/extension/join; the signed token that comes back goes to
 * the background worker, which keeps the session in chrome.storage.local.
 */
(() => {
  'use strict';

  const DEFAULT_SERVER = 'http://localhost:3000';
  const RING_CIRCUMFERENCE = 2 * Math.PI * 40;      // r=40 in popup.html
  const POLL_MS = 1000;
  const $ = (id) => document.getElementById(id);
  const send = (message) => chrome.runtime.sendMessage(message);

  // Tells the background worker the popup is open, so using the extension is never counted as leaving the class tab.
  function keepPresence() {
    if (!chrome.runtime.connect) return;
    try {
      const port = chrome.runtime.connect({ name: 'amp-popup' });
      port.onDisconnect.addListener(() => { setTimeout(keepPresence, 500); }); // the worker restarted: connect again
    } catch { /* the worker is starting; the status polling below also marks the popup as open */ }
  }
  keepPresence();

  // ---- pure helpers ---------------------------------------------------------------------------------------
  function normalizeServer(raw) {
    let url;
    try { url = new URL(String(raw).trim()); } catch { return null; }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  }

  // Name and email cross the network. Plain http:// is accepted only for this computer and for the professor's own
  // classroom network (private addresses such as 192.168.x.x, 10.x.x.x, 172.16-31.x.x, or a .local name): the traffic
  // stays on that network. Anything else on the internet must use https://.
  const PRIVATE_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|[a-z0-9-]+(\.[a-z0-9-]+)*\.local)$/i;
  const isPlainHttpRemote = (origin) => {
    if (!origin.startsWith('http://')) return false;
    try { return !PRIVATE_HOST.test(new URL(origin).hostname); } catch { return true; }
  };

  // Defaults written by the professor's server into config.js (window.AMP_PRECONFIG). Anything invalid is ignored.
  function readPreconfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const serverUrl = typeof cfg.serverUrl === 'string' ? normalizeServer(cfg.serverUrl) : null;
    const classCode = typeof cfg.classCode === 'string' ? cfg.classCode.trim().toUpperCase() : '';
    return { serverUrl: serverUrl || '', classCode: /^[A-Z0-9]{6,8}$/.test(classCode) ? classCode : '' };
  }
  const PRECONFIG = readPreconfig(window.AMP_PRECONFIG);

  const cleanCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanName = (raw) => String(raw || '').replace(/\s+/g, ' ').trim();
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Field keys -> the ids of the input and of its error line.
  const FIELDS = {
    serverUrl: { input: 'serverUrl', error: 'serverError' },
    classCode: { input: 'classCode', error: 'classCodeError' },
    fullName: { input: 'fullName', error: 'fullNameError' },
    email: { input: 'email', error: 'emailError' },
    consent: { input: 'consent', error: 'consentError' }
  };
  const FIELD_ORDER = ['serverUrl', 'classCode', 'fullName', 'email', 'consent'];
  const SERVER_FIELD_KEYS = { name: 'fullName', email: 'email', classCode: 'classCode', consent: 'consent' };

  const readForm = () => ({
    serverUrl: $('serverUrl').value,
    classCode: cleanCode($('classCode').value),
    fullName: cleanName($('fullName').value),
    email: $('email').value.trim(),
    consent: $('consent').checked
  });

  // Returns { field: message } for everything wrong; {} when the form is good.
  function validateField(key, values) {
    switch (key) {
      case 'serverUrl': {
        const origin = normalizeServer(values.serverUrl);
        if (!origin) return 'Enter the server address, for example http://localhost:3000.';
        if (isPlainHttpRemote(origin)) return 'Use an https:// address, or an address on your own network such as http://192.168.1.20:3000. Your name and email would not be encrypted over plain http:// on the internet.';
        return '';
      }
      case 'classCode':
        if (!values.classCode) return 'Enter the class code from your educator.';
        return /^[A-Z0-9]{6,8}$/.test(values.classCode) ? '' : 'Class codes have 6 to 8 letters and numbers.';
      case 'fullName':
        if (!values.fullName) return 'Enter your full name.';
        return values.fullName.length > 100 ? 'Use 100 characters or fewer.' : '';
      case 'email':
        if (!values.email) return 'Enter your email address.';
        return EMAIL_RE.test(values.email) && values.email.length <= 254 ? '' : 'Enter a valid email address, like name@school.edu.';
      case 'consent':
        return values.consent ? '' : 'Agree to the privacy notice to join.';
      default:
        return '';
    }
  }

  function validateAll(values) {
    const errors = {};
    for (const key of FIELD_ORDER) {
      const message = validateField(key, values);
      if (message) errors[key] = message;
    }
    return errors;
  }

  // ---- field error display --------------------------------------------------------------------------------
  function setFieldError(key, message) {
    const { input, error } = FIELDS[key];
    const line = $(error);
    const el = $(input);
    if (message) {
      line.textContent = message;
      line.hidden = false;
      el.setAttribute('aria-invalid', 'true');
    } else {
      line.textContent = '';
      line.hidden = true;
      el.removeAttribute('aria-invalid');
    }
  }
  const showErrors = (errors) => {
    FIELD_ORDER.forEach((key) => setFieldError(key, errors[key] || ''));
    if (errors.serverUrl) $('advanced').open = true; // an error inside a closed section would be invisible
  };
  const focusFirstInvalid = (errors) => {
    const first = FIELD_ORDER.find((key) => errors[key]);
    if (first) $(FIELDS[first].input).focus();
  };

  // When the educator's server address came with the extension, keep it out of the way (but visible, so a student
  // always sees where their data goes); otherwise the Advanced section starts open so the field is not hidden.
  function applyServerPresentation() {
    const preconfigured = Boolean(PRECONFIG.serverUrl);
    $('advanced').open = !preconfigured;
    $('serverNotice').hidden = !preconfigured;
    if (preconfigured) $('serverShown').textContent = PRECONFIG.serverUrl;
  }

  // ---- view switching -------------------------------------------------------------------------------------
  const ui = { view: 'loading', joining: false, joinBanner: false, bannerKey: '', liveKey: '' };

  function setView(view) {
    ui.view = view;
    document.body.dataset.view = view;
    const connectedLike = view === 'connected' || view === 'reconnecting';
    $('viewLoading').hidden = view !== 'loading';
    $('viewJoin').hidden = !(view === 'idle' || view === 'joining');
    $('viewConnected').hidden = !connectedLike;
  }

  function setBanner(banner) {
    const el = $('banner');
    if (!banner) { el.hidden = true; ui.bannerKey = ''; return; }
    const key = `${banner.kind}|${banner.text}|${banner.action ? banner.action.label : ''}`;
    if (key === ui.bannerKey) return;           // the same message is not re-announced every second
    ui.bannerKey = key;
    el.dataset.kind = banner.kind;
    $('bannerText').textContent = banner.text;
    const button = $('bannerAction');
    if (banner.action) {
      button.textContent = banner.action.label;
      button.onclick = banner.action.run;
      button.hidden = false;
    } else {
      button.hidden = true;
      button.onclick = null;
    }
    el.hidden = false;
  }

  function announce(text) {
    if (text !== ui.liveKey) { ui.liveKey = text; $('live').textContent = text; }
  }

  function setJoining(on) {
    ui.joining = on;
    $('joinForm').setAttribute('aria-busy', String(on));
    $('fsClass').disabled = on;
    $('fsYou').disabled = on;
    $('fsConsent').disabled = on;
    $('joinBtn').disabled = on;
    $('joinBtn').querySelector('.spinner').hidden = !on;
    $('joinBtnLabel').textContent = on ? 'Joining…' : 'Join class';
    setView(on ? 'joining' : 'idle');
  }

  // ---- connected view -------------------------------------------------------------------------------------
  const STATE_HINTS = {
    Focused: 'You are active in your class tab.',
    Passive: 'Watching or listening to the class counts.',
    Distracted: 'Your class tab is not in front, or you are switching tabs a lot.',
    Idle: 'No recent activity in your class tab.'
  };

  const setText = (id, text) => { const el = $(id); if (el.textContent !== text) el.textContent = text; };

  function ago(ms) {
    if (!ms) return 'not yet';  // callers handle "never" themselves
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 2 ? 'just now' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  }

  function healthText(status) {
    const kept = status.buffered ? ` ${status.buffered} reading${status.buffered === 1 ? '' : 's'} saved.` : '';
    if (status.health === 'connected') {
      if (status.lastSyncAt) return `Connected. Last sync ${ago(status.lastSyncAt)}.`;
      return status.meetingTabs ? 'Connected. First reading on the way.' : 'Connected. Waiting for a class tab.';
    }
    if (status.health === 'fallback') return `Backup connection. Last sync ${ago(status.lastSyncAt)}.`;
    return `Reconnecting${status.attempts ? ` (attempt ${status.attempts})` : ''}.${kept}`;
  }

  // The score ring, state badge and hint. Returns the state name shown (null while there is no reading yet).
  function renderScore(status) {
    const hasScore = typeof status.score === 'number';
    const state = hasScore ? status.state : null;
    const stateKey = state || 'None';
    const ring = $('ring');
    ring.dataset.state = stateKey;
    $('stateBadge').dataset.state = stateKey;
    setText('stateBadge', state || 'Idle');
    setText('scoreText', hasScore ? String(status.score) : '--');
    // A custom property, not an attribute: the stylesheet's stroke-dashoffset would override a presentation attribute.
    ring.style.setProperty('--ring-offset', String(Math.round(RING_CIRCUMFERENCE * (1 - (hasScore ? status.score : 0) / 100) * 100) / 100));
    ring.setAttribute('aria-label', hasScore ? `Attentiveness score ${status.score} out of 100, ${state}` : 'Attentiveness score unavailable');
    setText('stateHint', hasScore ? (STATE_HINTS[state] || '') : (status.meetingTabs ? 'Waiting for the first reading…' : 'Open your Meet or Zoom class tab to start.'));
    return state;
  }

  // What the educator sees flagged about this student, in the same words (transparency).
  function renderReasons(rawReasons) {
    const reasons = Array.isArray(rawReasons) ? rawReasons : [];
    const list = $('reasons');
    const key = reasons.join('\n');
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...reasons.map((r) => { const li = document.createElement('li'); li.textContent = r; return li; }));
    }
    list.hidden = reasons.length === 0;
  }

  // Warning / info banner and the connected vs reconnecting view, from the connection health.
  function renderHealth(status) {
    const retry = { label: 'Retry', run: async () => { await send({ type: 'retry' }); refresh(); } };
    if (status.health === 'reconnecting') {
      const detail = status.error && !/cannot reach/i.test(status.error) ? status.error : null;
      setBanner({
        kind: 'warn',
        text: detail || 'Can’t reach the server. Your most recent readings are kept and will be sent when it is back.',
        action: retry
      });
      setView('reconnecting');
    } else if (status.health === 'fallback') {
      setBanner({ kind: 'info', text: 'Using a backup connection. Questions from your educator won’t appear until the main connection is back.', action: retry });
      setView('reconnecting');
    } else {
      setBanner(null);
      setView('connected');
    }
  }

  function renderConnected(status) {
    const { session } = status;
    setText('factClass', session.className || 'Your class');
    setText('factCode', session.classCode || '');
    setText('factName', (session.student && session.student.name) || '');
    setText('factEmail', (session.student && session.student.email) || '');
    setText('factHealth', healthText(status));

    const state = renderScore(status);
    renderReasons(status.reasons);
    renderHealth(status);
    announce(`${state || 'Idle'}. ${status.health === 'connected' ? 'Connected' : status.health === 'fallback' ? 'Using backup connection' : 'Reconnecting'}.`);
  }

  // ---- idle view ------------------------------------------------------------------------------------------
  function renderIdle(status) {
    setView('idle');
    const notice = status && status.notice;
    if (notice && notice.text) {
      setBanner({ kind: 'warn', text: notice.text, action: { label: 'Dismiss', run: async () => { await send({ type: 'dismissNotice' }); setBanner(null); refresh(); } } });
    } else if (!ui.joinBanner) {
      setBanner(null);
    }
    announce('');
  }

  async function refresh() {
    if (ui.joining) return;
    let status;
    try { status = await send({ type: 'status' }); } catch { status = null; }
    if (ui.joining) return;
    if (!status || !status.ok) {
      setView('idle');
      setBanner({ kind: 'error', text: 'The extension is not responding. Close this popup and open it again.', action: null });
      return;
    }
    if (status.session) { ui.joinBanner = false; renderConnected(status); } else renderIdle(status);
  }

  // ---- join -----------------------------------------------------------------------------------------------
  class JoinError extends Error {
    constructor(message, { field = null, network = false, fields = null } = {}) { super(message); this.field = field; this.network = network; this.fields = fields; }
  }

  function errorFromResponse(status, data) {
    if (status === 400 && Array.isArray(data.details) && data.details.length) {
      const fields = {};
      for (const issue of data.details) {
        const key = SERVER_FIELD_KEYS[issue.path && issue.path[0]];
        if (key && !fields[key]) fields[key] = issue.message || 'Check this field.';
      }
      if (Object.keys(fields).length) return new JoinError(data.message || 'Check the highlighted fields.', { fields });
    }
    if (status === 404) return new JoinError('No class found for that code. Check it with your educator.', { field: 'classCode' });
    if (status === 429) return new JoinError(data.error || 'Too many attempts. Wait a few minutes and try again.');
    return new JoinError(data.message || data.error || `The server answered ${status}.`);
  }

  // A server other than the default needs a one-time permission grant (must happen inside the click that started the join).
  async function ensureServerPermission(origin) {
    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return;
    if (!(await chrome.permissions.request({ origins: [pattern] }))) {
      throw new JoinError('Chrome needs your permission to contact that server. Select Join class again and choose Allow.', { field: 'serverUrl' });
    }
  }

  // POST /api/extension/join. Sends exactly the name, email, class code and the student's consent: nothing else.
  async function requestJoin(origin, values) {
    let res;
    try {
      res = await fetch(`${origin}/api/extension/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.fullName, email: values.email, classCode: values.classCode, consent: true })
      });
    } catch {
      throw new JoinError('Can’t reach the server. Check the address and your connection, then try again.', { field: 'serverUrl', network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw errorFromResponse(res.status, data);
    return data;
  }

  async function submitJoin() {
    if (ui.joining) return;
    const values = readForm();
    const errors = validateAll(values);
    showErrors(errors);
    if (Object.keys(errors).length) { setBanner(null); focusFirstInvalid(errors); return; }

    const origin = normalizeServer(values.serverUrl);
    setBanner(null);
    ui.joinBanner = false;
    setJoining(true);
    try {
      await ensureServerPermission(origin);
      const data = await requestJoin(origin, values);

      const connected = await send({
        type: 'connect',
        session: {
          serverUrl: origin, token: data.token, expiresAt: data.expiresAt, studentId: data.studentId,
          classId: data.classId, classCode: data.classCode, className: data.className, educatorName: data.educatorName,
          student: data.student
        }
      });
      if (!connected || !connected.ok) throw new JoinError((connected && connected.error) || 'Could not start. Try joining again.');

      await chrome.storage.local.set({ prefs: { serverUrl: origin, name: (data.student && data.student.name) || values.fullName, email: (data.student && data.student.email) || values.email } });
      $('classCode').value = '';
      $('consent').checked = false;
      showErrors({});
      setJoining(false);
      await refresh();
      $('connectedHeading').focus();
    } catch (err) {
      setJoining(false);
      if (err instanceof JoinError) {
        const fields = err.fields || (err.field ? { [err.field]: err.message } : null);
        if (fields) { showErrors(fields); focusFirstInvalid(fields); }
        ui.joinBanner = true;
        setBanner({ kind: 'error', text: err.message, action: err.network ? { label: 'Try again', run: () => submitJoin() } : null });
      } else {
        ui.joinBanner = true;
        setBanner({ kind: 'error', text: 'Something went wrong while joining. Try again.', action: null });
      }
    }
  }

  // ---- events ---------------------------------------------------------------------------------------------
  function updatePrivacyLink() {
    const origin = normalizeServer($('serverUrl').value);
    const link = $('privacyLink');
    if (origin) link.setAttribute('href', `${origin}/privacy.html`); else link.removeAttribute('href');
  }

  $('joinForm').addEventListener('submit', (event) => { event.preventDefault(); submitJoin(); });

  // Inline validation: when a field is left, and again on every keystroke while it is showing an error (so the message
  // goes away as soon as the problem does).
  for (const key of FIELD_ORDER) {
    const el = $(FIELDS[key].input);
    el.addEventListener('blur', () => { if (!ui.joining) setFieldError(key, validateField(key, readForm())); });
    el.addEventListener(key === 'consent' ? 'change' : 'input', () => {
      if (key === 'classCode') {
        const cleaned = cleanCode(el.value);
        if (el.value !== cleaned) el.value = cleaned;       // upper case, letters and digits only
      }
      if (key === 'serverUrl') { updatePrivacyLink(); const typed = normalizeServer(el.value); if (PRECONFIG.serverUrl && typed !== PRECONFIG.serverUrl) { $('serverNotice').hidden = true; } }
      if (el.getAttribute('aria-invalid') === 'true') setFieldError(key, validateField(key, readForm()));
    });
  }

  $('openDashboard').addEventListener('click', async () => {
    const { session } = await chrome.storage.local.get('session');
    if (!session || !session.token) return;
    chrome.tabs.create({ url: `${session.serverUrl}/student.html?token=${encodeURIComponent(session.token)}` });
  });

  $('disconnectBtn').addEventListener('click', async () => {
    $('disconnectBtn').disabled = true;
    try { await send({ type: 'disconnect' }); } finally { $('disconnectBtn').disabled = false; }
    showErrors({});
    setBanner(null);
    setView('idle');
    $('classCode').value = PRECONFIG.classCode;
    $('consent').checked = false;
    $('classCode').focus();
    announce('You left the class. Enter a class code to join another.');
  });

  // ---- start ----------------------------------------------------------------------------------------------
  (async function init() {
    setView('loading');
    const { prefs } = await chrome.storage.local.get('prefs');
    // Educator's pre-configured address wins over whatever an earlier install remembered (the professor's address may have
    // changed); then the last address used; then localhost.
    $('serverUrl').value = PRECONFIG.serverUrl || (prefs && prefs.serverUrl) || DEFAULT_SERVER;
    $('classCode').value = PRECONFIG.classCode;
    applyServerPresentation();
    if (prefs && prefs.name) $('fullName').value = prefs.name;
    if (prefs && prefs.email) $('email').value = prefs.email;
    updatePrivacyLink();
    await refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener('pagehide', () => clearInterval(timer));
  })();
})();
