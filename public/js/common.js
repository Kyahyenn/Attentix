/* Shared helpers for every page. Loaded with <script src="/js/common.js"> (no inline scripts: see the CSP).

   Students have no password. They hold a signed bearer token (from POST /api/extension/join, or handed over by the
   browser extension as student.html?token=...). It lives in sessionStorage (this tab only) unless the student
   explicitly asks to be remembered on this device (localStorage, and the token itself expires after 12 hours).
   Educators use a normal cookie session and never send the student token (see `bearer: false` in api()). */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text; };
  const on = (id, eventName, handler) => { const el = byId(id); if (el) el.addEventListener(eventName, handler); };
  const show = (id, visible) => byId(id).classList.toggle('hidden', !visible);
  // Skips the write when nothing changed, so a live table does not restart screen-reader announcements or selections.
  const setIfChanged = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };

  // ---- student token store ------------------------------------------------------------------------------------
  const TOKEN_KEY = 'am.token';              // sessionStorage: the token itself (name kept from the previous release)
  const PERSIST_KEY = 'am.token.persist';    // localStorage: { token, expiresAt } only when "remember me" was ticked
  const TOKEN_SHAPE = /^[A-Za-z0-9_-]{10,1000}\.[A-Za-z0-9_-]{10,200}$/;
  const guard = (fn, fallback) => { try { return fn(); } catch { return fallback; } }; // storage can be blocked

  const session = {
    get() {
      const live = guard(() => window.sessionStorage.getItem(TOKEN_KEY), null);
      if (live) return live;
      const saved = guard(() => JSON.parse(window.localStorage.getItem(PERSIST_KEY) || 'null'), null);
      if (saved && typeof saved.token === 'string' && Number(saved.expiresAt) > Date.now()) {
        guard(() => window.sessionStorage.setItem(TOKEN_KEY, saved.token));
        return saved.token;
      }
      if (saved) guard(() => window.localStorage.removeItem(PERSIST_KEY));
      return null;
    },
    set(token, { persist = false, expiresAt } = {}) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false;
      guard(() => window.sessionStorage.setItem(TOKEN_KEY, token));
      if (persist) guard(() => window.localStorage.setItem(PERSIST_KEY, JSON.stringify({ token, expiresAt: Number(expiresAt) || Date.now() + 12 * 60 * 60 * 1000 })));
      else guard(() => window.localStorage.removeItem(PERSIST_KEY));
      return true;
    },
    clear() {
      guard(() => window.sessionStorage.removeItem(TOKEN_KEY));
      guard(() => window.localStorage.removeItem(PERSIST_KEY));
    },
    has() { return Boolean(session.get()); },
    // "Keep me signed in on this device" (localStorage) can be undone without ending this tab's own session.
    isRemembered() {
      const saved = guard(() => JSON.parse(window.localStorage.getItem(PERSIST_KEY) || 'null'), null);
      return Boolean(saved && typeof saved.token === 'string' && Number(saved.expiresAt) > Date.now());
    },
    forgetDevice() { guard(() => window.localStorage.removeItem(PERSIST_KEY)); },
    // student.html?token=... (from the extension popup): store it, then take it out of the address bar, history entry
    // and any bookmark. Returns true when a well-formed token was found. Other query parameters are left alone.
    consumeUrlToken() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has('token')) return false;
      const token = params.get('token');
      params.delete('token');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
      return session.set(token);
    }
  };

  async function api(url, method = 'GET', body, { bearer = true } = {}) {
    let res;
    try {
      const token = bearer ? session.get() : null;
      const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      res = await fetch(url, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
    } catch {
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Disables the button while `task` runs so a double-click can't submit twice; always restores it.
  async function withBusy(button, task, busyLabel = 'Please wait…') {
    if (!button || button.disabled) return undefined;
    const original = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyLabel;
    try { return await task(); } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = original;
    }
  }

  // Wires every <button class="show-password" data-target="inputId"> to reveal / hide that password field.
  function wirePasswordToggles() {
    document.querySelectorAll('.show-password').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = byId(btn.dataset.target);
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        btn.textContent = reveal ? 'Hide' : 'Show';
        btn.setAttribute('aria-pressed', String(reveal));
        btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      });
    });
  }

  // ---- app preferences (Settings page) -------------------------------------------------------------------------------
  // Plain values (booleans, short strings) under am.pref.<name>, kept only in this browser. Display and accessibility
  // choices live in js/a11y.js instead, because they must be applied before the page paints.
  const PREF_PREFIX = 'am.pref.';
  const prefs = {
    get(name, fallback) {
      return guard(() => {
        const raw = window.localStorage.getItem(PREF_PREFIX + name);
        return raw === null ? fallback : JSON.parse(raw);
      }, fallback);
    },
    set(name, value) {
      guard(() => window.localStorage.setItem(PREF_PREFIX + name, JSON.stringify(value)));
      document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name, value } }));
    },
    remove(name) {
      guard(() => window.localStorage.removeItem(PREF_PREFIX + name));
      document.dispatchEvent(new window.CustomEvent('am:prefchange', { detail: { name, value: undefined } }));
    }
  };

  // Non-blocking replacement for alert()/prompt(). Announced to screen readers through role=status.
  // Confirmation messages can be switched off in Settings; errors, and messages the person asked for (`force`, e.g. a
  // check-in alert), always show.
  let toastTimer;
  function toast(message, isError = false, { force = false } = {}) {
    if (!isError && !force && prefs.get('toasts', true) === false) return;
    let box = byId('toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast';
      box.className = 'toast';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    box.classList.toggle('toast-error', Boolean(isError));
    box.textContent = message;
    box.classList.add('toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('toast-visible'), isError ? 6000 : 3500);
  }

  // Single choke point for page changes (replace(): the Back button must not return to a finished sign-in form).
  // Every caller goes through window.AM.navigate, so tests can replace it.
  const navigate = (url) => window.location.replace(url);

  // Educators land on their dashboard; anyone else (a leftover student record) is sent to the passwordless pages.
  function redirectAfterAuth(user) {
    window.AM.navigate(user && user.role === 'educator' ? '/educator-dashboard.html' : '/student.html');
  }

  // ---- class code (deep links: /join?classCode=ABC234) -----------------------------------------------------------
  // Only used to PRE-FILL the join form. The 30 minute sessionStorage cache survives a detour through the privacy
  // notice and is cleared as soon as it is used. Nothing is stored on the server.
  const INVITE_KEY = 'am.pendingInvite';
  const INVITE_TTL_MS = 30 * 60 * 1000;
  const INVITE_STORE = window.sessionStorage;
  const invite = {
    normalize(raw) {
      const code = String(raw || '').trim().toUpperCase();
      return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
    },
    // Reads ?classCode=XYZ (current links) or ?code=XYZ (links created before the rename).
    fromUrl(search = window.location.search) {
      const params = new URLSearchParams(search);
      return invite.normalize(params.get('classCode') || params.get('code'));
    },
    save(raw) {
      const code = invite.normalize(raw);
      if (!code) return null;
      try { INVITE_STORE.setItem(INVITE_KEY, JSON.stringify({ code, savedAt: Date.now() })); } catch { /* storage blocked */ }
      return code;
    },
    peek() {
      try {
        const saved = JSON.parse(INVITE_STORE.getItem(INVITE_KEY) || 'null');
        if (saved && invite.normalize(saved.code) && Date.now() - saved.savedAt < INVITE_TTL_MS) return saved.code;
        INVITE_STORE.removeItem(INVITE_KEY);
      } catch { /* corrupt or blocked */ }
      return null;
    },
    take() { const code = invite.peek(); invite.clear(); return code; },
    clear() { try { INVITE_STORE.removeItem(INVITE_KEY); } catch { /* ignore */ } }
  };

  // ---- forms: inline, accessible validation -----------------------------------------------------------------------
  // Markup contract: <input id="x" aria-describedby="xError"> + <p id="xError" class="field-error" hidden></p>.
  // Errors are attached to the field (aria-invalid + describedby) instead of only being shown in a banner.
  const validators = {
    name: (v) => (String(v || '').trim().length < 2 ? 'Enter your full name.' : ''),
    email: (v) => (/^\S+@\S+\.\S+$/.test(String(v || '').trim()) ? '' : 'Enter a valid email address.'),
    classCode: (v) => (/^[A-Za-z0-9]{6,8}$/.test(String(v || '').trim()) ? '' : 'Class codes are 6 to 8 letters and numbers.'),
    password: (v) => (String(v || '').length < 8 ? 'Password must be at least 8 characters.' : '')
  };

  function fieldError(inputId, message) {
    const input = byId(inputId);
    const box = byId(`${inputId}Error`);
    if (box) { box.textContent = message || ''; box.hidden = !message; }
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
    return Boolean(message);
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('[aria-invalid]').forEach((input) => fieldError(input.id, ''));
    form.querySelectorAll('.field-error').forEach((box) => { box.textContent = ''; box.hidden = true; });
  }

  // Runs [[inputId, validatorName | fn], ...]; shows every message, focuses the first bad field, returns true if valid.
  function validateFields(checks) {
    let firstBad = null;
    for (const [inputId, rule] of checks) {
      const input = byId(inputId);
      const check = typeof rule === 'function' ? rule : validators[rule];
      const message = check(input ? input.value : '');
      if (fieldError(inputId, message) && !firstBad) firstBad = input;
    }
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  // The API reports validation problems as "classCode: Class codes are 6 to 8 letters and numbers".
  function parseFieldError(message, knownFields) {
    const match = /^([A-Za-z][\w.]*):\s*(.+)$/.exec(String(message || ''));
    return match && knownFields.includes(match[1]) ? { field: match[1], text: match[2] } : { field: null, text: String(message || '') };
  }

  // ---- clipboard ------------------------------------------------------------------------------------------------
  // Resolves true when the text was copied. The Clipboard API is unavailable on non-HTTPS origins (a classroom server
  // on http://192.168.x.x), so fall back to a selected off-screen textarea without blocking the page.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.className = 'offscreen';
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    field.remove();
    return copied;
  }

  // ---- engagement helpers (educator roster + student dashboard share one definition of "state") --------------------
  // A row is what the server's `class:update` / `/api/student/lookup` carry (see src/state/engagementState.js).
  // Four display states. The extension reports Focused / Passive / Distracted / Idle; "Idle" has no cell of its own and
  // is shown as Passive. "Focused" additionally needs the server to have raised no flag: if the client says Focused
  // but the server sees the meeting tab out of focus, an unanswered question, etc., the row is Passive. A student who
  // has only ever used the old web page protocol (no attentionState) is derived from the server's own flags.
  const STATES = ['Focused', 'Passive', 'Distracted', 'Offline'];
  const STATE_SLUG = { Focused: 'focused', Passive: 'passive', Distracted: 'distracted', Offline: 'offline' };
  const CHECK_IN_THRESHOLD = 60; // same cut-off as the server (EXTENSION_ATTENTIVE_MIN)
  const TAB_SWITCH_LIMIT = 3;
  const IDLE_LIMIT_MS = 60 * 1000;
  const CHAT_RESPONSE_LIMIT_MS = 45 * 1000;
  const SCORE_BUCKETS = ['0–39', '40–59', '60–79', '80–100'];

  const scoreOf = (row) => (row && typeof row.focusScore === 'number' && Number.isFinite(row.focusScore) ? row.focusScore : null);

  function stateOf(row) {
    if (!row || !row.online) return 'Offline';
    switch (row.attentionState) {
      case 'Distracted': return 'Distracted';
      case 'Focused': return row.attentive ? 'Focused' : 'Passive';
      case 'Passive': case 'Idle': return 'Passive';
      default: // legacy web-page-only student
        if (row.attentive) return 'Focused';
        return row.tabHidden || (Number(row.tabSwitchCount) || 0) >= TAB_SWITCH_LIMIT ? 'Distracted' : 'Passive';
    }
  }

  const needsCheckIn = (row) => { const s = stateOf(row); return s === 'Passive' || s === 'Distracted'; };
  const isIdle = (row) => (row.mouseIdleMs || 0) >= IDLE_LIMIT_MS;
  const isUnanswered = (row) => row.promptWaitingMs !== null && row.promptWaitingMs !== undefined && row.promptWaitingMs >= CHAT_RESPONSE_LIMIT_MS;

  const median = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  // Everything the dashboard summary needs, from one pass over the rows.
  function classStats(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const counts = { Focused: 0, Passive: 0, Distracted: 0, Offline: 0 };
    const scores = [];
    const buckets = [0, 0, 0, 0];
    let focusLosses = 0; let hiddenTabs = 0; let idle = 0; let unanswered = 0; let online = 0; let unscored = 0;
    for (const row of list) {
      counts[stateOf(row)] += 1;
      focusLosses += Number(row.focusLossCount) || 0;
      if (!row.online) continue;
      online += 1;
      if (row.tabHidden) hiddenTabs += 1;
      if (isIdle(row)) idle += 1;
      if (isUnanswered(row)) unanswered += 1;
      const score = scoreOf(row);
      if (score === null) { unscored += 1; continue; }
      scores.push(score);
      buckets[score < 40 ? 0 : score < 60 ? 1 : score < 80 ? 2 : 3] += 1;
    }
    return {
      total: list.length, online, counts, scored: scores.length, unscored,
      average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      median: median(scores),
      lowest: scores.length ? Math.min(...scores) : null,
      belowThreshold: scores.filter((s) => s < CHECK_IN_THRESHOLD).length,
      focusLosses, hiddenTabs, idle, unanswered, buckets
    };
  }

  // Roster filter: free-text name search + one state filter ('all' | 'check-in' | a state name).
  function filterRoster(rows, { query = '', state = 'all' } = {}) {
    const q = String(query).trim().toLowerCase();
    return rows.filter((row) => {
      if (q && !String(row.name || '').toLowerCase().includes(q)) return false;
      if (state === 'all') return true;
      if (state === 'check-in') return needsCheckIn(row);
      return stateOf(row) === state;
    });
  }

  const SORTS = {
    'state': 'Needs a check-in first',
    'score-asc': 'Lowest score first',
    'score-desc': 'Highest score first',
    'focus-loss': 'Most focus losses first',
    'name': 'Name A–Z'
  };

  // Returns a NEW sorted array. Offline students and students without a score yet never crowd out the people the
  // educator is looking for: they come after every scored, online student when sorting by score.
  function sortRoster(rows, key = 'state') {
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const stateRank = (r) => ({ Distracted: 0, Passive: 1, Focused: 2, Offline: 3 })[stateOf(r)];
    // 0 = online with a score, 1 = online, no score yet, 2 = offline
    const group = (r) => (!r.online ? 2 : scoreOf(r) === null ? 1 : 0);
    const copy = rows.slice();
    switch (key) {
      case 'name': return copy.sort(byName);
      case 'focus-loss': return copy.sort((a, b) => (Number(b.focusLossCount) || 0) - (Number(a.focusLossCount) || 0) || byName(a, b));
      case 'score-asc': return copy.sort((a, b) => group(a) - group(b) || (group(a) === 0 ? scoreOf(a) - scoreOf(b) : 0) || byName(a, b));
      case 'score-desc': return copy.sort((a, b) => group(a) - group(b) || (group(a) === 0 ? scoreOf(b) - scoreOf(a) : 0) || byName(a, b));
      default: return copy.sort((a, b) => stateRank(a) - stateRank(b) || group(a) - group(b) || (group(a) === 0 ? scoreOf(a) - scoreOf(b) : 0) || byName(a, b));
    }
  }

  const engagement = { STATES, STATE_SLUG, SORTS, SCORE_BUCKETS, CHECK_IN_THRESHOLD, TAB_SWITCH_LIMIT, scoreOf, stateOf, needsCheckIn, isIdle, isUnanswered, classStats, filterRoster, sortRoster };

  // ---- dialogs ----------------------------------------------------------------------------------------------------
  // Native <dialog> gives a real focus trap, Escape-to-close and screen-reader semantics for free.
  // Resolves with the entered password, or null when cancelled.
  function askPassword({ title, message, confirmLabel, label = 'Your password', type = 'password', autocomplete = 'current-password' }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'dialog';
      dialog.setAttribute('aria-labelledby', 'pwTitle');
      const form = document.createElement('form');
      form.method = 'dialog';
      const h = document.createElement('h2'); h.id = 'pwTitle'; h.textContent = title;
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = message;
      const fieldLabel = document.createElement('label'); fieldLabel.className = 'field-label'; fieldLabel.htmlFor = 'pwInput'; fieldLabel.textContent = label;
      const input = document.createElement('input'); input.type = type; input.id = 'pwInput'; input.autocomplete = autocomplete; input.required = true;
      const row = document.createElement('div'); row.className = 'button-row';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.type = 'submit'; ok.className = 'btn btn-danger'; ok.textContent = confirmLabel;
      row.append(cancel, ok);
      form.append(h, p, fieldLabel, input, row);
      dialog.append(form);
      document.body.append(dialog);

      let value = null;
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', () => { value = input.value; });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(value); });
      dialog.showModal();
      input.focus();
    });
  }

  // Accessible yes/no confirmation (replaces window.confirm). Resolves true/false.
  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'dialog';
      dialog.setAttribute('aria-labelledby', 'cfTitle');
      const form = document.createElement('form');
      form.method = 'dialog';
      const h = document.createElement('h2'); h.id = 'cfTitle'; h.textContent = title;
      const p = document.createElement('p'); p.textContent = message;
      const row = document.createElement('div'); row.className = 'button-row';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.type = 'submit'; ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`; ok.textContent = confirmLabel;
      row.append(cancel, ok);
      form.append(h, p, row);
      dialog.append(form);
      document.body.append(dialog);
      let result = false;
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', () => { result = true; });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
      dialog.showModal();
      cancel.focus();
    });
  }

  // ---- educator sign-out / account deletion (cookie session) ------------------------------------------------------
  async function logout() {
    invite.clear(); // a cached class code must not be inherited by whoever uses this tab next
    try { await api('/api/logout', 'POST', undefined, { bearer: false }); } catch { /* the session may already be gone */ }
    window.AM.navigate('/login.html');
  }

  // "Delete my account and classes" (educators; students erase their data from their own dashboard instead).
  async function deleteAccountFlow(whatGoes) {
    const password = await askPassword({
      title: 'Delete your account?',
      message: `${whatGoes} This cannot be undone.`,
      confirmLabel: 'Delete permanently'
    });
    if (!password) return;
    try {
      await api('/api/me', 'DELETE', { password }, { bearer: false });
      invite.clear();
      window.AM.navigate('/login.html?deleted=1');
    } catch (err) { toast(err.message, true); }
  }

  window.AM = {
    byId, setText, on, show, setIfChanged, api, session, withBusy, toast, prefs, navigate, redirectAfterAuth, invite,
    fieldError, clearFieldErrors, validateFields, parseFieldError, wirePasswordToggles, copyText, engagement,
    logout, confirmDialog, deleteAccountFlow
  };
})();
