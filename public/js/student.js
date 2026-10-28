/* Optional passwordless student dashboard.

   Opened two ways:
     * from the extension popup: student.html?token=<extensionToken>  -> authenticated automatically, token removed from the URL
     * directly, with no token  -> a Full name + Email + Class code lookup form (no password)

   This page is a VIEWER. It polls the read-only POST /api/student/lookup and never opens a socket or reports activity:
   entering a class over a socket would mark the student "online" to their educator even when no extension is streaming,
   and a page that watched your own tabs would double-count what the extension already reports. What is shown is exactly
   the row the educator sees. The extension is what streams. */
(function () {
  'use strict';
  const { byId, setText, show, setIfChanged, session, withBusy, toast, navigate, confirmDialog, api, engagement, validateFields, clearFieldErrors, fieldError, parseFieldError } = window.AM;
  const privacy = window.AMPrivacy;

  const POLL_MS = 8000;           // gentle: the global rate limit is per IP and a classroom often shares one
  const POLL_MAX_BACKOFF_MS = 60000;
  const STREAM_FRESH_MS = 20000;  // a heartbeat newer than this (server time) counts as "streaming"
  const MAX_SAMPLES = 90;         // ~12 minutes of the personal time series


  let creds = null;               // { name, email, classCode } for a no-token view (memory only, never stored)
  let current = null;             // last lookup response
  let pollTimer = null;
  let pollDelay = POLL_MS;
  let polling = false;
  let ended = false;
  let samples = [];               // [{ label, value }]
  let lastSampleAt = null;
  let selfChart = null;

  const hasToken = () => session.has();
  const notice = (text) => { const box = byId('sessionNotice'); box.textContent = text; box.classList.toggle('hidden', !text); };

  // ---- rendering --------------------------------------------------------------------------------------------------
  const fmtIdle = (ms) => (ms === null || ms === undefined ? '–' : ms < 1000 ? 'just now' : `${Math.round(ms / 1000)} s`);

  // Server time, not the browser clock, decides freshness: a student's laptop clock may be minutes off.
  function isStreaming(data) {
    const s = data.status;
    if (!data.consent.accepted || !s || !s.online || !s.lastActivityAt) return false;
    if (s.attentionState === null && engagement.scoreOf(s) === null) return false;
    return data.timestamp - s.lastActivityAt < STREAM_FRESH_MS;
  }

  function renderExtensionStatus(data) {
    const box = byId('extStatus');
    let text; let cls;
    if (!data.consent.accepted) { text = 'Monitoring paused — consent not given.'; cls = 'ext-paused'; }
    else if (isStreaming(data)) { text = 'Active & Streaming'; cls = 'ext-live'; }
    else { text = 'Extension Offline — Open the browser extension to stream attentiveness'; cls = 'ext-offline'; }
    setIfChanged(byId('extStatusText'), text); // unchanged text is not rewritten, so screen readers are not re-announced every poll
    const next = `ext-status ${cls}`;
    if (box.className !== next) box.className = next;
  }

  function renderScore(data) {
    const s = data.status;
    const live = Boolean(s && s.online && data.consent.accepted);
    const score = live ? engagement.scoreOf(s) : null;
    const state = data.consent.accepted && s ? engagement.stateOf(s) : 'Offline';

    setIfChanged(byId('scoreValue'), score === null ? '–' : String(score));
    byId('scoreUnit').hidden = score === null;
    const meter = byId('scoreMeter');
    if (score === null) meter.removeAttribute('aria-valuenow'); else meter.setAttribute('aria-valuenow', String(score));
    meter.setAttribute('aria-valuetext', score === null ? 'No score yet' : `${score} out of 100`);
    byId('scoreMeterFill').style.width = `${score === null ? 0 : score}%`;
    meter.className = `meter ${score === null ? '' : score >= engagement.CHECK_IN_THRESHOLD ? 'meter-ok' : 'meter-low'}`.trim();

    const badge = byId('stateBadge');
    setIfChanged(badge, state);
    const badgeClass = `state-badge state-${engagement.STATE_SLUG[state]}`;
    if (badge.className !== badgeClass) badge.className = badgeClass;
  }

  function renderDetails(data) {
    const s = data.status;
    const live = Boolean(s && data.consent.accepted);
    setText('selfIdle', live && s.online ? fmtIdle(s.mouseIdleMs) : '–');
    setText('selfFocusLoss', String(live ? Number(s.focusLossCount) || 0 : 0));
    setText('selfSwitches', String(live ? Number(s.tabSwitchCount) || 0 : 0));
    setText('selfReplies', String(live ? Number(s.chatResponses) || 0 : 0));
    setText('selfMeetingChat', String(live ? Number(s.meetingChatMessages) || 0 : 0));
    const list = byId('selfReasons');
    const reasons = live && s.online && Array.isArray(s.reasons) ? s.reasons : [];
    list.replaceChildren(...reasons.map((reason) => { const li = document.createElement('li'); li.textContent = reason; return li; }));
  }

  function ensureChart() {
    if (selfChart || !window.AMCharts) return;
    selfChart = window.AMCharts.createMatrixChart({
      canvas: byId('selfChart'), kind: 'trend', storageKey: 'am.chart.self', defaultType: 'line',
      noun: 'Your attentiveness score', datasetLabel: 'Your score', palette: ['--accent'],
      yMax: 100, threshold: engagement.CHECK_IN_THRESHOLD, thresholdLabel: `Check-in threshold (${engagement.CHECK_IN_THRESHOLD})`
    });
  }

  // One point per NEW heartbeat the server has seen, not one per poll, so a pause in streaming draws no fake points.
  function renderChart(data) {
    ensureChart();
    const s = data.status;
    const score = s ? engagement.scoreOf(s) : null;
    if (isStreaming(data) && score !== null && s.lastActivityAt !== lastSampleAt) {
      lastSampleAt = s.lastActivityAt;
      samples.push({ label: new Date(s.lastActivityAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), value: score });
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    }
    byId('selfChartEmpty').classList.toggle('hidden', samples.length > 0);
    if (selfChart && samples.length) selfChart.update({ labels: samples.map((p) => p.label), values: samples.map((p) => p.value) });
  }

  function renderPrivacy(data) {
    setText('consentStatus', privacy.describeConsent(data.consent));
    setText('consentToggleBtn', data.consent.accepted ? 'Withdraw my consent' : 'Give my consent');
    byId('consentToggleBtn').className = `btn ${data.consent.accepted ? 'btn-secondary' : 'btn-primary'}`;
    const tokenMode = hasToken();
    document.querySelectorAll('.token-only').forEach((node) => { node.hidden = !tokenMode; });
    show('tokenOnlyHint', !tokenMode);
  }

  function render(data) {
    current = data;
    const { student, class: klass } = data;
    setText('userName', `${student.name} · ${klass.className}${klass.section ? ` — ${klass.section}` : ''}`);
    setText('className', klass.className);
    setText('educatorName', klass.educatorName);
    setText('classCodeText', klass.classCode);
    show('pageLoading', false);
    show('lookupSection', false);
    show('dashboard', true);
    show('signOutBtn', hasToken());
    renderExtensionStatus(data);
    renderScore(data);
    renderDetails(data);
    renderChart(data);
    renderPrivacy(data);
  }

  // ---- loading / polling --------------------------------------------------------------------------------------------
  function showLookup(message) {
    stopPolling();
    show('pageLoading', false);
    current = null;
    show('dashboard', false);
    show('lookupSection', true);
    show('signOutBtn', false);
    setText('userName', 'Not signed in');
    if (message) notice(message);
    byId('lookupName').focus();
  }

  // The session is over (token revoked/expired, or the record was removed): say why and offer the form again.
  function sessionEnded(err) {
    if (err.status === 401) { session.clear(); showLookup('Your extension session ended. Open the extension again, or find your dashboard with your name, email and class code.'); return; }
    if (err.status === 404) { session.clear(); creds = null; showLookup('We could not find you in that class any more. You may have left it or been removed. Join again to continue.'); return; }
  }

  async function fetchOnce() {
    const data = await privacy.lookup(creds);
    notice('');
    render(data);
    return data;
  }

  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function schedulePoll() {
    stopPolling();
    if (ended) return;
    pollTimer = setTimeout(poll, pollDelay);
  }

  async function poll() {
    if (polling) return;
    if (document.hidden) { schedulePoll(); return; } // nothing to show in a hidden tab; catches up on return
    polling = true;
    try {
      await fetchOnce();
      pollDelay = POLL_MS;
    } catch (err) {
      if (err.status === 401 || err.status === 404) { polling = false; sessionEnded(err); return; }
      pollDelay = Math.min(pollDelay * 2, POLL_MAX_BACKOFF_MS); // 429 / network trouble: slow down, keep what is on screen
      notice(err.status === 429 ? 'Too many requests. Slowing down for a moment.' : 'Connection problem. Retrying…');
    } finally { polling = false; }
    schedulePoll();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current && !polling) { pollDelay = POLL_MS; stopPolling(); poll(); }
  });

  // Throws on any failure so the caller decides how to show it (inline on the lookup form, or as a notice on boot).
  async function start() {
    await fetchOnce();
    pollDelay = POLL_MS;
    schedulePoll();
    byId('liveTitle').focus();
  }

  // ---- lookup form (no token) --------------------------------------------------------------------------------------
  const codeInput = byId('lookupClassCode');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const FIELDS = { name: 'lookupName', email: 'lookupEmail', classCode: 'lookupClassCode' };

  byId('lookupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(event.target);
    setText('lookupFormError', '');
    if (!validateFields([['lookupName', 'name'], ['lookupEmail', 'email'], ['lookupClassCode', 'classCode']])) return undefined;
    creds = { name: byId('lookupName').value.trim(), email: byId('lookupEmail').value.trim(), classCode: codeInput.value.trim().toUpperCase() };

    return withBusy(byId('lookupBtn'), async () => {
      try {
        await start();
      } catch (err) {
        creds = null;
        if (err.status === 404) {
          setText('lookupFormError', 'No student found for that email and class code. If you have not joined yet, use the button below.');
          byId('joinInsteadLink').href = `/join.html?classCode=${encodeURIComponent(codeInput.value.trim().toUpperCase())}`;
          return;
        }
        const { field, text } = parseFieldError(err.message, Object.keys(FIELDS));
        if (field) { fieldError(FIELDS[field], text); byId(FIELDS[field]).focus(); } else setText('lookupFormError', err.message);
      }
    }, 'Looking up…');
  });

  // ---- privacy & consent controls ---------------------------------------------------------------------------------
  byId('consentToggleBtn').addEventListener('click', async () => {
    if (!current) return;
    const withdrawing = current.consent.accepted;
    if (withdrawing) {
      const ok = await confirmDialog({
        title: 'Withdraw your consent?',
        message: 'Monitoring stops at once and the live data held about you is deleted. You can give your consent again at any time.',
        confirmLabel: 'Withdraw consent', danger: true
      });
      if (!ok) return;
    }
    await withBusy(byId('consentToggleBtn'), async () => {
      try {
        await privacy.setConsent(withdrawing ? 'decline' : 'accept', creds);
        samples = []; lastSampleAt = null;
        await fetchOnce();
        toast(withdrawing ? 'Consent withdrawn. Monitoring has stopped.' : 'Consent saved.');
      } catch (err) {
        if (err.status === 401 || err.status === 404) sessionEnded(err); else toast(err.message, true);
      }
    }, 'Saving…');
    if (current) renderPrivacy(current); // withBusy restores the button's old label: put the right one back
  });

  byId('leaveClassBtn').addEventListener('click', async () => {
    if (!current) return;
    const ok = await confirmDialog({
      title: 'Leave this class?',
      message: `You will be unenrolled from ${current.class.className}, monitoring stops immediately and the live data about you is deleted. You can rejoin later with the class code.`,
      confirmLabel: 'Leave class', danger: true
    });
    if (!ok) return;
    try {
      await api('/api/classes/leave', 'POST', { classId: current.class.id });
      ended = true; stopPolling(); session.clear();
      navigate('/join.html');
    } catch (err) { toast(err.message, true); }
  });

  byId('deleteDataBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete your data?',
      message: 'Your name, email, consent record and class membership are erased and monitoring stops. This cannot be undone. You can join again later as a new student.',
      confirmLabel: 'Delete my data', danger: true
    });
    if (!ok) return;
    try {
      await api('/api/student/me', 'DELETE');
      ended = true; stopPolling(); session.clear();
      navigate('/join.html?deleted=1');
    } catch (err) { toast(err.message, true); }
  });

  byId('signOutAllBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Sign out everywhere?',
      message: 'Every signed-in browser of yours, including the browser extension, is signed out. You can join again with your name, email and class code.',
      confirmLabel: 'Sign out everywhere'
    });
    if (!ok) return;
    try {
      await api('/api/extension/logout', 'POST');
      ended = true; stopPolling(); session.clear();
      navigate('/join.html');
    } catch (err) { toast(err.message, true); }
  });

  // This browser only: the token stays valid until it expires (12 h) or is revoked with "Sign out everywhere".
  byId('signOutBtn').addEventListener('click', () => { ended = true; stopPolling(); session.clear(); navigate('/join.html'); });

  // ---- boot ---------------------------------------------------------------------------------------------------------
  (async function init() {
    session.consumeUrlToken(); // student.html?token=... -> stored, then removed from the address bar via history.replaceState
    if (!hasToken()) { showLookup(); return; }
    try { await start(); } catch (err) {
      if (err.status === 401 || err.status === 404) sessionEnded(err); else showLookup(err.message);
    }
  })();
})();
