(function () {
  'use strict';
  const { byId, setText, setIfChanged, api: baseApi, withBusy, toast, prefs, confirmDialog, deleteAccountFlow, copyText, engagement } = window.AM;
  const { STATES, STATE_SLUG, CHECK_IN_THRESHOLD } = engagement;

  const AVERAGE_SAMPLE_MS = 5000;   // one trendline point every 5 s at most
  const AVERAGE_MAX_SAMPLES = 120;  // ~10 minutes
  const COPY_FEEDBACK_MS = 2500;

  const BASE_TITLE = document.title;
  let socket;
  let enteredChannelKey = null;   // `${socket.id}:${classId}` of the room this connection has already asked to enter
  let currentUser = null;
  let currentClass = null;
  let latestStudents = [];
  let averageSamples = [];          // [{ label, value }]
  let lastAverageAt = 0;

  // ---- auth redirects ----
  // A sign-in redirect is forced ONLY by an explicit 401 (or the server's own "Authentication" socket refusal /
  // "session revoked" event). A dropped connection, a timeout, a proxy page or a 5xx never signs the teacher out.
  // window.AM.navigate is location.replace, so the dead dashboard entry leaves the history stack and the Back button
  // can never bounce the teacher into a redirect loop. The latch makes sure only one redirect is ever started.
  let redirecting = false;
  function redirectOnce(url) {
    if (redirecting) return;
    redirecting = true;
    if (socket) socket.close();
    window.AM.navigate(url);
  }
  const isUnauthorized = (err) => Boolean(err) && err.status === 401;

  // Educator pages use the cookie session only: never attach a student token an earlier visit may have left in this tab.
  async function api(url, method, body) {
    try { return await baseApi(url, method, body, { bearer: false }); } catch (err) {
      if (isUnauthorized(err)) redirectOnce('/login.html');
      throw err;
    }
  }

  const el = (tag, props = {}, text) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const setBadge = (text, cls) => { const b = byId('liveBadge'); b.textContent = text; b.className = `badge ${cls || ''}`.trim(); };
  const spell = (code) => String(code).split('').join(' '); // "ABC234" -> "A B C 2 3 4" for screen readers

  // ---- auth + socket ----
  const AUTH_RETRY_BASE_MS = 1000;
  const AUTH_RETRY_MAX_MS = 15000;
  const AUTH_RETRY_JITTER_MS = 250;

  // Resolves after `ms`, or as soon as the browser reports that the network is back.
  const pauseUntilOnline = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); window.removeEventListener('online', done); resolve(); };
    const timer = setTimeout(done, ms);
    window.addEventListener('online', done, { once: true });
  });

  // true  -> an educator is signed in (currentUser is set)
  // false -> a redirect has been started: a 401, or a signed-in account that is not an educator
  // Anything else (offline, timeout, 5xx, a captive-portal page that is not JSON) is retried with back-off and never
  // signs the teacher out.
  async function checkAuth() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const data = await api('/api/me');
        if (!data || !data.user) throw new Error('Unexpected response from the server.');
        if (data.user.role !== 'educator') { redirectOnce('/join.html'); return false; }
        currentUser = data.user;
        setText('userName', `Signed in as ${currentUser.name}`);
        if (attempt > 0) setBadge('Connecting…', '');
        return true;
      } catch (err) {
        if (isUnauthorized(err)) return false; // api() has already started the redirect
        if (attempt === 0) toast('Cannot reach the server. Retrying…', true);
        setBadge('Offline — retrying…', 'bad');
        const delay = Math.min(AUTH_RETRY_MAX_MS, AUTH_RETRY_BASE_MS * (2 ** attempt)) + Math.random() * AUTH_RETRY_JITTER_MS;
        await pauseUntilOnline(delay);
      }
    }
  }

  // Joins the class room on THIS connection exactly once. A buffered emit made before the socket connected would be
  // followed by the 'connect' handler's own emit, so nothing is sent until the connection is up, and the key
  // (connection id + class id) makes every further call for the same pair a no-op. A reconnect gets a new id, so it
  // re-enters correctly.
  function enterClassChannel(klass) {
    if (!socket || !socket.connected || !klass) return;
    const key = `${socket.id}:${klass.id}`;
    if (enteredChannelKey === key) return;
    enteredChannelKey = key;
    socket.emit('educator:enterClass', { classId: klass.id }, (response) => {
      if (response && response.ok) return;
      if (enteredChannelKey === key) enteredChannelKey = null; // allow a retry
      if (!currentClass || currentClass.id !== klass.id) return; // the teacher has moved on: no stale error
      toast((response && response.error) || 'Unable to open class dashboard.', true);
    });
  }

  function setupSocket() {
    socket = io();
    socket.on('connect', () => {
      setBadge('Live', 'good');
      enteredChannelKey = null; // a fresh connection has joined no room yet
      if (currentClass) enterClassChannel(currentClass);
    });
    socket.on('connect_error', (err) => {
      if (/Authentication/i.test(String(err.message))) redirectOnce('/login.html');
      else setBadge('Reconnecting…', 'bad');
    });
    socket.on('disconnect', (reason) => {
      enteredChannelKey = null;
      if (reason !== 'io server disconnect') setBadge('Reconnecting…', 'bad');
    });
    socket.on('session:revoked', () => { redirectOnce('/login.html'); });
    socket.on('class:update', (payload) => {
      if (!payload || !currentClass || payload.classId !== currentClass.id) return;
      latestStudents = Array.isArray(payload.students) ? payload.students : [];
      checkAlert(); // before scheduleRender: rendering pauses in a background tab, alerts must not
      scheduleRender();
    });
  }

  // ---- check-in alerts (Settings > General > Notifications) ----
  // One alert when the open class's average drops below the check-in threshold, then silence until it has recovered a
  // little (hysteresis) and a couple of minutes have passed. The text never names a student.
  const ALERT_RECOVER_AT = CHECK_IN_THRESHOLD + 5;
  const ALERT_COOLDOWN_MS = 2 * 60 * 1000;
  const ALERT_MIN_SCORED = 2;
  let alertArmed = true;
  let lastAlertAt = 0;

  function checkAlert(now = Date.now()) {
    if (!currentClass || prefs.get('alerts', false) !== true) return;
    const stats = engagement.classStats(latestStudents);
    if (stats.average === null || stats.scored < ALERT_MIN_SCORED) return;
    if (stats.average >= ALERT_RECOVER_AT) { alertArmed = true; return; }
    if (stats.average >= CHECK_IN_THRESHOLD || !alertArmed || now - lastAlertAt < ALERT_COOLDOWN_MS) return;
    alertArmed = false;
    lastAlertAt = now;
    const message = `Average attentiveness in ${currentClass.name} is ${stats.average}%. A quick check-in may help.`;
    const canNotify = prefs.get('alertsDesktop', false) === true && 'Notification' in window && window.Notification.permission === 'granted';
    if (document.hidden && canNotify) {
      try { new window.Notification('Attentix check-in alert', { body: message, tag: 'attentix-check-in' }); return; } catch { /* fall back to the in-page message */ }
    }
    toast(message, false, { force: true });
  }

  // ---- copy buttons ----
  // One-click copy with feedback in three places: the button label, an inline status next to it, and a toast.
  const feedbackTimers = new WeakMap();
  async function copyWithFeedback(button, statusEl, text, what) {
    const ok = await copyText(text);
    const message = ok ? `${what} copied.` : 'Copy failed. Select the text and copy it manually.';
    toast(message, !ok);
    if (statusEl) statusEl.textContent = message;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    if (ok) button.textContent = 'Copied ✓';
    clearTimeout(feedbackTimers.get(button));
    feedbackTimers.set(button, setTimeout(() => {
      button.textContent = button.dataset.label;
      if (statusEl) statusEl.textContent = '';
    }, COPY_FEEDBACK_MS));
  }

  // ---- downloads ----
  // Hands a Blob to the browser as a file. The link is attached to the document before the click (some browsers and
  // download-manager extensions ignore a detached link) and the object URL is released only after a generous delay,
  // because the download starts asynchronously and an immediate revoke can cancel it.
  const DOWNLOAD_REVOKE_DELAY_MS = 30000;
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename, rel: 'noopener' });
    link.hidden = true;
    document.body.append(link);
    try { link.click(); } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
    }
  }

  // ---- pre-configured extension download ----
  // fetch + blob instead of a plain link so an expired session or an error shows a message instead of saving a JSON
  // error body as "Attentix-Extension-XXXXXX.zip".
  async function downloadExtension(klass) {
    try {
      const res = await fetch(`/api/extension/preconfigured?classCode=${encodeURIComponent(klass.classCode)}`, { credentials: 'same-origin' });
      if (res.status === 401) { redirectOnce('/login.html'); return; }
      if (!res.ok) {
        let message = 'Could not prepare the extension.';
        try { message = (await res.json()).error || message; } catch { /* not JSON */ }
        throw new Error(message);
      }
      downloadBlob(await res.blob(), `Attentix-Extension-${klass.classCode}.zip`);
      const server = res.headers.get('X-Server-Url');
      toast(server ? `Extension downloaded, set up for ${server}` : 'Extension downloaded');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---- server address + shutdown ----
  async function loadServerInfo() {
    let info;
    try { info = await api('/api/server-info'); } catch { return; } // the panel is a convenience: never block the dashboard
    byId('serverSection').hidden = false;
    const serverLink = byId('settingsNavServer');
    if (serverLink) serverLink.hidden = false;
    setText('serverAddress', info.preferredUrl);
    const others = [info.localUrl, ...info.lanUrls].filter((u) => u !== info.preferredUrl);
    setText('serverLocal', others.length ? `Also reachable at: ${others.join(' · ')}` : '');
    byId('serverNoLan').hidden = info.hasLan || Boolean(info.publicUrl);
    byId('serverHttpNote').hidden = !info.preferredUrl.startsWith('http://') || info.preferredUrl.startsWith(info.localUrl);
    byId('shutdownRow').hidden = !info.canShutdown;
    // On the computer that runs the app, signing out also stops the server: say so on the button.
    if (info.canShutdown) { setText('logoutBtn', 'Log out & stop server'); byId('logoutBtn').title = 'Signs you out and stops Attentix on this computer. Students are disconnected.'; }
    byId('copyServerBtn').onclick = () => copyWithFeedback(byId('copyServerBtn'), byId('serverCopyStatus'), info.preferredUrl, 'Server address');
  }

  // The server is gone: tabs and the live badge would lead nowhere, so retire them (the message replaces #main).
  function showStopped() {
    const nav = byId('appNav');
    if (nav) nav.hidden = true;
    setBadge('Server stopped', 'bad');
  }

  async function shutDownServer() {
    const ok = await confirmDialog({
      title: 'Shut down the server?',
      message: 'This stops Attentix on this computer. Every student is disconnected and live data is lost. Start the app again to continue.',
      confirmLabel: 'Shut down',
      danger: true
    });
    if (!ok) return;
    try {
      await api('/api/server/shutdown', 'POST');
      if (socket) socket.close();
      const main = byId('main');
      showStopped();
      main.replaceChildren(el('h1', {}, 'Server stopped'), el('p', { className: 'muted' }, 'Attentix has shut down. You can close this tab. Start the app again whenever you need it.'));
    } catch (err) { toast(err.message, true); }
  }

  // Log out. The server decides: on the computer that runs the app it also shuts down; anywhere else it is a plain sign-out.
  async function signOut() {
    window.AM.invite.clear(); // a cached class code must not be inherited by whoever uses this tab next
    let result = {};
    try { result = await api('/api/server/sign-out', 'POST') || {}; } catch { /* the session may already be gone */ }
    if (!result.stopped) { window.AM.navigate('/login.html'); return; }
    if (socket) socket.close();
    const main = byId('main');
    showStopped();
    const heading = el('h1', { tabIndex: -1 }, 'Signed out. Server stopped');
    main.replaceChildren(heading, el('p', { className: 'muted' }, 'Attentix has shut down. You can close this tab. Start the app again whenever you need it.'));
    heading.focus();
  }

  // ---- classes ----
  // A class code is permanent (the server refuses to change it), so there is deliberately no "new code" action.
  // The list lives on the Classes tab; one class lives on its own page, #class/<id> (see syncRoute).
  const VIEW_KEY = 'am.classes.view';
  const SORT_KEY = 'am.classes.sort';
  const RECENT_MAX = 5;
  let allClasses = [];
  let classesReady = null;          // the first load, shared by everything that needs the list
  let classesLoaded = false;        // true once a load has succeeded (later reloads refresh quietly)
  let classView = 'grid';

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode: the choice just isn't remembered */ } }
  };

  const classTitle = (klass) => `${klass.name}${klass.section ? ` — ${klass.section}` : ''}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const classHref = (klass) => `#class/${encodeURIComponent(klass.id)}`;
  const inviteUrlOf = (klass) => `${window.location.origin}/join?classCode=${klass.classCode}`;

  function ago(time, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(time).toLocaleDateString();
  }

  // Recently opened classes: only class ids and times, kept in this browser, one list per educator account.
  const recentKey = () => `am.recentClasses.${currentUser ? currentUser.id : 'anon'}`;
  function readRecents() {
    try {
      const list = JSON.parse(store.get(recentKey()) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.at)) : [];
    } catch { return []; }
  }
  function rememberClass(id) {
    const list = readRecents().filter((r) => r.id !== id);
    list.unshift({ id, at: Date.now() });
    store.set(recentKey(), JSON.stringify(list.slice(0, RECENT_MAX * 2)));
  }

  // A round icon for empty states, drawn from the page's inline SVG sprite.
  function emptyIcon(symbol) {
    const wrap = el('span', { className: 'empty-icon' });
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${symbol}`);
    svg.append(use);
    wrap.append(svg);
    return wrap;
  }

  function loadingRow(text) {
    const row = el('div', { className: 'loading-row' });
    const spinner = el('span', { className: 'spinner' });
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner, el('span', {}, text));
    row.setAttribute('aria-hidden', 'true'); // the status line above the list says it for screen readers
    return row;
  }

  function classCard(klass) {
    const card = el('article', { className: 'class-card' });
    card.dataset.classId = klass.id;
    const heading = el('h3');
    heading.id = `class-${klass.id}`;
    card.setAttribute('aria-labelledby', heading.id);
    const link = el('a', { href: classHref(klass), className: 'class-link' }, klass.name);
    link.setAttribute('aria-label', `Open ${classTitle(klass)}`);
    heading.append(link);
    if (klass.section) heading.append(' ', el('span', { className: 'muted' }, `— ${klass.section}`));

    const codeRow = el('div', { className: 'class-code-row' });
    const code = el('span', { className: 'class-code' }, klass.classCode);
    code.setAttribute('aria-hidden', 'true');
    const spoken = el('span', { className: 'visually-hidden' }, `Class code: ${spell(klass.classCode)}`);
    const copyStatus = el('span', { className: 'copy-status no-print' });
    copyStatus.setAttribute('role', 'status');
    const copyCode = el('button', { type: 'button', className: 'btn btn-primary btn-small no-print' }, 'Copy Class Code');
    copyCode.setAttribute('aria-label', `Copy Class Code for ${klass.name}`);
    copyCode.addEventListener('click', () => copyWithFeedback(copyCode, copyStatus, klass.classCode, 'Class code'));
    codeRow.append(code, spoken, copyCode, copyStatus);

    const info = el('p', { className: 'muted class-meta' }, `Students: ${klass.studentCount} · Active now: ${klass.activeCount}`);
    const open = el('span', { className: 'class-open' }, 'Open class →');
    open.setAttribute('aria-hidden', 'true');
    card.append(heading, codeRow, info, open);
    return card;
  }

  function compareClasses(sort) {
    const byName = (a, b) => classTitle(a).localeCompare(classTitle(b));
    const recents = readRecents().map((r) => r.id);
    const rank = (k) => { const i = recents.indexOf(k.id); return i === -1 ? Infinity : i; };
    const created = (k) => (typeof k.createdAt === 'number' ? k.createdAt : Date.parse(k.createdAt)) || 0; // the server stores ms
    switch (sort) {
      case 'newest': return (a, b) => created(b) - created(a) || byName(a, b);
      case 'students': return (a, b) => (b.studentCount - a.studentCount) || byName(a, b);
      case 'active': return (a, b) => (b.activeCount - a.activeCount) || byName(a, b);
      case 'recent': return (a, b) => (rank(a) === rank(b) ? byName(a, b) : rank(a) - rank(b));
      default: return byName;
    }
  }

  function visibleClasses() {
    const q = byId('classSearch').value.trim().toLowerCase();
    const matching = allClasses.filter((k) => !q || [k.name, k.section, k.classCode].some((v) => String(v || '').toLowerCase().includes(q)));
    return matching.sort(compareClasses(byId('classSort').value));
  }

  function renderClassList() {
    const list = byId('classList');
    const shown = visibleClasses();
    list.replaceChildren();
    if (!allClasses.length) {
      const empty = el('div', { className: 'empty class-empty' });
      const create = el('button', { type: 'button', className: 'btn btn-primary' }, 'Create your first class');
      create.addEventListener('click', openCreateDialog);
      empty.append(emptyIcon('i-book'), el('h3', {}, 'No classes yet'), el('p', { className: 'muted' }, 'Create a class to get its permanent code, then share the code with your students.'), el('div', { className: 'button-row' }, undefined));
      empty.lastChild.append(create);
      list.append(empty);
      setText('classCount', '');
      return;
    }
    if (!shown.length) {
      list.append(el('p', { className: 'muted class-empty' }, `No classes match “${byId('classSearch').value.trim()}”.`));
      setText('classCount', `Showing 0 of ${plural(allClasses.length, 'class', 'classes')}.`);
      return;
    }
    shown.forEach((klass) => list.append(classCard(klass)));
    setText('classCount', `Showing ${shown.length} of ${plural(allClasses.length, 'class', 'classes')}.`);
  }

  function setClassView(view) {
    classView = view === 'list' ? 'list' : 'grid';
    byId('classList').className = `class-list view-${classView}`;
    [['viewGrid', 'grid'], ['viewList', 'list']].forEach(([id, name]) => {
      const button = byId(id);
      button.setAttribute('aria-pressed', String(name === classView));
      button.classList.toggle('is-active', name === classView);
    });
  }

  async function loadClasses() {
    const list = byId('classList');
    if (!classesLoaded) { list.replaceChildren(loadingRow('Loading classes…')); setText('classCount', 'Loading classes…'); }
    try {
      const data = await api('/api/educator/classes');
      allClasses = Array.isArray(data.classes) ? data.classes : [];
      classesLoaded = true;
      renderOverview();
      renderRecents();
      renderActivity();
      renderClassList();
      refreshOpenClass();
    } catch (err) {
      const box = el('div', { className: 'empty class-empty' });
      const retry = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Try again');
      retry.addEventListener('click', () => { classesReady = null; ensureClasses(); });
      box.append(emptyIcon('i-alert'), el('h3', {}, 'Could not load your classes'), el('p', { className: 'error' }, err.message), el('div', { className: 'button-row' }, undefined)); // textContent: never parsed as HTML
      box.lastChild.append(retry);
      list.replaceChildren(box);
      setText('classCount', '');
    }
  }
  const ensureClasses = () => { if (!classesReady) classesReady = loadClasses(); return classesReady; };

  // ---- Home: totals, recently opened, recent activity ----
  function renderOverview() {
    const sum = (key) => allClasses.reduce((total, k) => total + (Number(k[key]) || 0), 0);
    const scored = sum('scoredCount');
    const weighted = allClasses.reduce((total, k) => total + (Number(k.averageScore) || 0) * (Number(k.scoredCount) || 0), 0);
    setIfChanged(byId('homeClasses'), String(allClasses.length));
    setIfChanged(byId('homeStudents'), String(sum('studentCount')));
    setIfChanged(byId('homeActive'), String(sum('activeCount')));
    setIfChanged(byId('homeAverage'), scored ? `${Math.round(weighted / scored)}%` : '–');
    setIfChanged(byId('homeBelow'), String(sum('belowThresholdCount')));
  }

  function miniItem(klass, detail) {
    const item = el('li', { className: 'mini-item' });
    item.dataset.classId = klass.id;
    item.append(el('a', { href: classHref(klass) }, classTitle(klass)), el('span', { className: 'small' }, detail));
    return item;
  }

  function renderRecents() {
    const byClass = new Map(allClasses.map((k) => [k.id, k]));
    const items = readRecents().filter((r) => byClass.has(r.id)).slice(0, RECENT_MAX)
      .map((r) => { const k = byClass.get(r.id); return miniItem(k, `${plural(k.studentCount, 'student', 'students')} · ${k.activeCount} active now · opened ${ago(r.at)}`); });
    byId('recentClasses').replaceChildren(...items);
    byId('recentEmpty').hidden = items.length > 0;
  }

  function renderActivity() {
    const items = allClasses.filter((k) => k.lastActivityAt).sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, RECENT_MAX)
      .map((k) => {
        const below = k.belowThresholdCount ? ` · ${k.belowThresholdCount} below 60` : '';
        return miniItem(k, `${k.activeCount} active now · last activity ${ago(k.lastActivityAt)}${below}`);
      });
    byId('recentActivity').replaceChildren(...items);
    byId('activityEmpty').hidden = items.length > 0;
  }

  // ---- one class: #class/<id> ----
  const routeClassId = () => { const m = /^#class\/([^/]+)$/.exec(window.location.hash || ''); return m ? decodeURIComponent(m[1]) : null; };

  function resetLiveView() {
    latestStudents = [];
    averageSamples = []; lastAverageAt = 0;
    rowCache.clear(); lastOrder = []; lastOrderKey = null;
    byId('studentTable').replaceChildren();
  }

  // Only the class in the address is ever in memory: leaving the page drops its roster and charts.
  function leaveClass() {
    if (!currentClass && byId('classMissing').classList.contains('hidden')) return;
    currentClass = null;
    enteredChannelKey = null;
    resetLiveView();
    byId('dashboardSection').classList.add('hidden');
    byId('classMissing').classList.add('hidden');
    document.title = BASE_TITLE;
  }

  function showClass(klass) {
    currentClass = klass;
    resetLiveView();
    rememberClass(klass.id);
    renderRecents();
    byId('classMissing').classList.add('hidden');
    byId('dashboardSection').classList.remove('hidden');
    document.title = `${klass.name} · Attentix`;
    setText('dashboardClassTitle', classTitle(klass));
    setText('dashboardClassMeta', `Educator: ${klass.educatorName}`);
    setText('dashClassCode', klass.classCode);
    setText('dashClassCodeSpoken', `Class code: ${spell(klass.classCode)}`);
    byId('dashboardClassTitle').focus();
    scheduleRender();
    enterClassChannel(klass);
  }

  // Keeps the open class's name/code current after the list is reloaded (a class is never renamed, but counts move).
  function refreshOpenClass() {
    if (!currentClass) return;
    const fresh = allClasses.find((k) => k.id === currentClass.id);
    if (fresh) currentClass = fresh;
  }

  // ---- class page: loading / error surface ----
  // #panel-class is revealed by nav.js the moment the address names a class, long before the class list has arrived.
  // This surface fills that gap. #classLoadingStatus is a polite live region that exists from the first paint, so the
  // text put into it is announced; the visual spinner row (or the retry card) lives beside it and is not read twice.
  let classLoadingParts = null;
  function classLoadingSurface() {
    if (classLoadingParts) return classLoadingParts;
    const status = el('div', { id: 'classLoadingStatus', className: 'visually-hidden' });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const visual = el('div', { id: 'classLoadingVisual' });
    const wrap = el('div', { id: 'classLoading', className: 'no-print' });
    wrap.append(status, visual);
    byId('classMissing').before(wrap);
    classLoadingParts = { wrap, status, visual };
    return classLoadingParts;
  }

  function showClassLoading(text) {
    const { wrap, status, visual } = classLoadingSurface();
    visual.replaceChildren(loadingRow(text));
    status.textContent = text;
    wrap.setAttribute('aria-busy', 'true');
  }

  function showClassLoadError(onRetry) {
    const { wrap, status, visual } = classLoadingSurface();
    const box = el('div', { className: 'card empty' });
    const actions = el('div', { className: 'button-row' });
    const retry = el('button', { type: 'button', className: 'btn btn-secondary' }, 'Try again');
    retry.addEventListener('click', onRetry);
    actions.append(retry);
    box.append(emptyIcon('i-alert'), el('h2', {}, 'Could not load this class'), el('p', { className: 'error' }, 'The class list could not be loaded. Check the connection and try again.'), actions);
    visual.replaceChildren(box);
    status.textContent = 'Could not load this class.';
    wrap.removeAttribute('aria-busy');
  }

  function hideClassLoading() {
    if (!classLoadingParts) return;
    classLoadingParts.visual.replaceChildren();
    classLoadingParts.status.textContent = '';
    classLoadingParts.wrap.removeAttribute('aria-busy');
  }

  // ---- route machine: #class/<id> ----
  // ONE reconciliation runs at a time. Every trigger (am:tabchange, hashchange, init, a retry) only marks the machine
  // dirty; the drain loop then re-reads the address and runs a fresh pass. Each pass re-checks the world AFTER its
  // await (the address may have moved, the class may already be open), so two triggers for the same address cannot both
  // reach showClass, and `educator:enterClass` is emitted once.
  const routeMachine = { running: false, dirty: false, idle: Promise.resolve() };
  const isClassOpen = (id) => Boolean(currentClass) && currentClass.id === id;

  async function reconcileRoute() {
    if (!currentUser) return;
    const id = routeClassId();
    if (!id) { hideClassLoading(); leaveClass(); return; }
    if (isClassOpen(id)) return;

    if (!classesLoaded) {
      // Deep link / refresh: no class is on screen and nothing to look it up in yet. Show the placeholder at once.
      leaveClass();
      byId('classMissing').classList.add('hidden');
      showClassLoading('Loading class…');
    }
    await ensureClasses();

    // ---- lifecycle check after the await ----
    if (routeClassId() !== id) { routeMachine.dirty = true; return; } // the address moved on: run a fresh pass
    if (isClassOpen(id)) { hideClassLoading(); return; }             // another pass already opened it
    if (!classesLoaded) {
      // The list failed to load. "Class not found" would be a lie: offer a retry instead.
      leaveClass();
      showClassLoadError(() => { classesReady = null; syncRoute(); });
      return;
    }
    hideClassLoading();
    const klass = allClasses.find((k) => k.id === id);
    if (klass) { showClass(klass); return; }
    leaveClass();
    byId('dashboardSection').classList.add('hidden');
    byId('classMissing').classList.remove('hidden');
    document.title = 'Class not found · Attentix';
  }

  async function drainRoute() {
    routeMachine.running = true;
    try {
      while (routeMachine.dirty) {
        routeMachine.dirty = false;
        try { await reconcileRoute(); } catch (err) { console.error('Route sync failed:', err); }
      }
    } finally { routeMachine.running = false; }
  }

  // Always returns the promise of the running drain, so `await syncRoute()` resolves once the machine is idle.
  function syncRoute() {
    routeMachine.dirty = true;
    if (!routeMachine.running) routeMachine.idle = drainRoute();
    return routeMachine.idle;
  }

  // ---- create class (dialog) ----
  const createDialog = () => byId('createClassDialog');
  function openCreateDialog() {
    setText('createClassError', '');
    window.AM.fieldError('classNameInput', '');
    const dialog = createDialog();
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    byId('classNameInput').focus();
  }
  function closeCreateDialog() {
    const dialog = createDialog();
    try { dialog.close(); } catch { dialog.removeAttribute('open'); }
  }

  // ---- rendering ----
  // Updates arrive about once a second. Rendering is coalesced into one animation frame, skipped while the tab is
  // hidden (it catches up on return) and the table is patched in place instead of being rebuilt.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || document.hidden) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderDashboard(); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });

  const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);

  function renderDashboard() {
    const stats = engagement.classStats(latestStudents);
    recordAverage(stats);
    renderSummary(stats);
    renderTable(stats);
    renderCharts(stats);
  }

  function renderSummary(stats) {
    STATES.forEach((state) => {
      setIfChanged(byId(`cell${state}`), String(stats.counts[state]));
      setIfChanged(byId(`cell${state}Pct`), `${pct(stats.counts[state], stats.total)}%`);
    });
    const score = (v) => (v === null ? '–' : `${v}%`);
    setIfChanged(byId('metricAverage'), score(stats.average));
    setIfChanged(byId('metricMedian'), score(stats.median));
    setIfChanged(byId('metricLowest'), score(stats.lowest));
    setIfChanged(byId('metricBelow'), String(stats.belowThreshold));
    setIfChanged(byId('metricFocusLoss'), String(stats.focusLosses));
    setIfChanged(byId('metricUnanswered'), String(stats.unanswered));
  }

  // ---- roster ----
  const rowCache = new Map(); // studentId -> { tr, cells }
  let lastOrder = [];         // student ids in the order currently on screen
  let lastOrderKey = null;
  const COLUMNS = ['name', 'state', 'score', 'reasons', 'focusLoss', 'idle', 'switches', 'replies', 'meeting', 'last'];

  function createRow(student) {
    const tr = el('tr');
    const cells = {};
    COLUMNS.forEach((key) => { cells[key] = el('td', { className: `col-${key}` }); tr.append(cells[key]); });
    cells.state.append(el('span', { className: 'chip' }));
    cells.score.append(el('span', { className: 'score-num' }), el('span', { className: 'mini-meter' }));
    cells.score.lastChild.append(el('span', { className: 'mini-meter-fill' }));
    const actions = el('td', { className: 'no-print' });
    const remove = el('button', { type: 'button', className: 'btn btn-ghost btn-small' }, 'Remove');
    remove.addEventListener('click', () => removeStudent(student.studentId, tr.dataset.name));
    actions.append(remove);
    tr.append(actions);
    return { tr, cells, remove };
  }

  function updateRow({ tr, cells, remove }, s) {
    const state = engagement.stateOf(s);
    const slug = STATE_SLUG[state];
    const trClass = `row-${slug}`;
    if (tr.className !== trClass) tr.className = trClass;
    tr.dataset.name = s.name;
    const reasons = Array.isArray(s.reasons) && s.reasons.length ? s.reasons.join(' ') : s.online ? 'Active in class.' : '';
    setIfChanged(cells.name, s.name);
    const chip = cells.state.firstChild;
    setIfChanged(chip, state);
    const chipClass = `chip chip-${slug}`;
    if (chip.className !== chipClass) chip.className = chipClass;

    const score = engagement.scoreOf(s);
    const shown = s.online && score !== null ? score : null;
    setIfChanged(cells.score.firstChild, shown === null ? '–' : `${shown}%`);
    cells.score.lastChild.firstChild.style.width = `${shown === null ? 0 : shown}%`;
    cells.score.lastChild.className = `mini-meter${shown !== null && shown < CHECK_IN_THRESHOLD ? ' mini-meter-low' : ''}`;

    setIfChanged(cells.reasons, reasons);
    setIfChanged(cells.focusLoss, String(Number(s.focusLossCount) || 0));
    setIfChanged(cells.idle, s.mouseIdleMs === null || s.mouseIdleMs === undefined ? '–' : `${Math.round(s.mouseIdleMs / 1000)}s`);
    setIfChanged(cells.switches, String(Number(s.tabSwitchCount) || 0));
    setIfChanged(cells.replies, String(Number(s.chatResponses) || 0));
    setIfChanged(cells.meeting, String(Number(s.meetingChatMessages) || 0));
    setIfChanged(cells.last, s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : '–');
    remove.setAttribute('aria-label', `Remove ${s.name} from this class`);
  }

  function visibleStudents() {
    const filtered = engagement.filterRoster(latestStudents, { query: byId('searchInput').value, state: byId('stateFilter').value });
    return engagement.sortRoster(filtered, byId('sortSelect').value);
  }

  // Sorting by score reshuffles rows as numbers move. While the educator is hovering over or has keyboard focus inside
  // the table, rows keep their positions (cells still update) so a click or a Tab never lands on a different student.
  function orderRows(rows) {
    const wrap = document.querySelector('.table-wrap');
    const holding = wrap && (wrap.matches(':hover') || wrap.contains(document.activeElement)) && lastOrder.length;
    if (!holding) return rows;
    const byIdMap = new Map(rows.map((r) => [r.studentId, r]));
    const known = new Set(lastOrder);
    return lastOrder.filter((id) => byIdMap.has(id)).map((id) => byIdMap.get(id)).concat(rows.filter((r) => !known.has(r.studentId)));
  }

  function renderTable(stats) {
    const tbody = byId('studentTable');
    const matching = visibleStudents();
    const rows = orderRows(matching);
    const seen = new Set();
    for (const s of rows) {
      let entry = rowCache.get(s.studentId);
      if (!entry) { entry = createRow(s); rowCache.set(s.studentId, entry); }
      updateRow(entry, s);
      seen.add(s.studentId);
    }
    for (const [id, entry] of rowCache) if (!seen.has(id)) { entry.tr.remove(); rowCache.delete(id); }

    const orderKey = rows.map((s) => s.studentId).join('|');
    if (orderKey !== lastOrderKey) { // only touch the DOM order when it actually changed
      lastOrderKey = orderKey;
      lastOrder = rows.map((s) => s.studentId);
      if (!rows.length) {
        const empty = el('tr');
        empty.append(el('td', { colSpan: 11, className: 'muted table-empty' }, latestStudents.length ? 'No students match the filter.' : 'No students have joined this class yet. Share the class code above, or download the pre-configured extension for them.'));
        tbody.replaceChildren(empty);
      } else tbody.replaceChildren(...rows.map((s) => rowCache.get(s.studentId).tr));
    }

    const unscored = stats.unscored ? ` · ${stats.unscored} online without a score yet` : '';
    setIfChanged(byId('rosterCount'), latestStudents.length ? `Showing ${rows.length} of ${latestStudents.length} students${unscored}.` : 'No students yet.');
  }

  // ---- charts ----
  // Every chart is fed plain JSON ({ labels, values }). js/chartMatrix.js turns that into a line, bar or doughnut chart
  // (or, for the trendline, a single time series), remembers the choice per chart, and rebuilds itself when the theme or
  // the text size changes. Charts resize with their container (see .chart-box / .chart-card in styles.css).
  const STATE_PALETTE = ['--state-focused', '--state-passive', '--state-distracted', '--state-offline'];

  const statusChart = window.AMCharts.createMatrixChart({
    canvas: byId('statusChart'), switcher: byId('statusChartType'), storageKey: 'am.chart.states',
    defaultType: 'doughnut', noun: 'Student states', datasetLabel: 'Students', palette: STATE_PALETTE
  });
  const averageChart = window.AMCharts.createMatrixChart({
    canvas: byId('averageChart'), kind: 'trend', storageKey: 'am.chart.average', defaultType: 'line',
    noun: 'Class average over time', datasetLabel: 'Class average', palette: ['--accent'],
    yMax: 100, threshold: CHECK_IN_THRESHOLD, thresholdLabel: `Check-in threshold (${CHECK_IN_THRESHOLD})`
  });
  const scoreChart = window.AMCharts.createMatrixChart({
    canvas: byId('scoreChart'), switcher: byId('scoreChartType'), storageKey: 'am.chart.scores',
    defaultType: 'bar', noun: 'Score distribution', datasetLabel: 'Students', palette: ['--state-distracted', '--state-passive', '--chart-1', '--state-focused']
  });

  // One trendline point per ~5 s while at least one online student has a score.
  function recordAverage(stats, now = Date.now()) {
    if (stats.average === null || now - lastAverageAt < AVERAGE_SAMPLE_MS) return;
    lastAverageAt = now;
    averageSamples.push({ label: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), value: stats.average });
    if (averageSamples.length > AVERAGE_MAX_SAMPLES) averageSamples.splice(0, averageSamples.length - AVERAGE_MAX_SAMPLES);
  }

  function renderCharts(stats) {
    statusChart.update({ labels: STATES, values: STATES.map((state) => stats.counts[state]) });
    scoreChart.update({ labels: engagement.SCORE_BUCKETS, values: stats.buckets });
    byId('averageChartEmpty').classList.toggle('hidden', averageSamples.length > 0);
    if (averageSamples.length) averageChart.update({ labels: averageSamples.map((p) => p.label), values: averageSamples.map((p) => p.value) });
  }

  // ---- CSV export ----
  // Spreadsheet formula injection guard: a name like =HYPERLINK(...) must not run when the file is opened.
  function sanitizeCsvCell(cell) {
    let str = String(cell == null ? '' : cell);
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return `"${str.replaceAll('"', '""')}"`;
  }

  const CSV_BOM = '\uFEFF'; // makes Excel read the file as UTF-8 ("Peña", "Zoë" stay intact)

  async function exportCsv() {
    if (!currentClass) return;
    const klass = currentClass;
    const ok = await confirmDialog({
      title: 'Export student data?',
      message: 'The file contains student names and engagement flags. Keep it private, share it only as your school’s policy allows, and delete it when you no longer need it.',
      confirmLabel: 'Export CSV'
    });
    if (!ok) return;
    if (!currentClass || currentClass.id !== klass.id) return; // the teacher left this class while the dialog was open
    const rows = [['Name', 'Online', 'State', 'Score', 'Signals', 'Focus losses', 'Mouse idle seconds', 'Tab switches', 'Chat replies', 'Meeting chat msgs', 'Last activity']];
    latestStudents.forEach((s) => {
      const score = engagement.scoreOf(s);
      rows.push([
        s.name, s.online ? 'Yes' : 'No', engagement.stateOf(s), score === null ? '' : score,
        (Array.isArray(s.reasons) ? s.reasons : []).join(' '),
        Number(s.focusLossCount) || 0,
        s.mouseIdleMs === null || s.mouseIdleMs === undefined ? '' : Math.round(s.mouseIdleMs / 1000),
        Number(s.tabSwitchCount) || 0, Number(s.chatResponses) || 0, Number(s.meetingChatMessages) || 0,
        s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : ''
      ]);
    });
    const csv = `${CSV_BOM}${rows.map((row) => row.map(sanitizeCsvCell).join(',')).join('\r\n')}\r\n`;
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `class-report-${klass.id}.csv`);
  }

  async function removeStudent(studentId, name) {
    if (!currentClass) return;
    const ok = await confirmDialog({
      title: `Remove ${name || 'this student'}?`,
      message: 'They are unenrolled from this class and their monitoring stops immediately. Class codes are permanent, so they can rejoin with the same code if they choose to.',
      confirmLabel: 'Remove student', danger: true
    });
    if (!ok) return;
    try { await api(`/api/classes/${currentClass.id}/students/${studentId}`, 'DELETE'); toast('Student removed'); }
    catch (err) { toast(err.message, true); }
  }

  // ---- events ----
  byId('createClassForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const nameInput = byId('classNameInput');
    const sectionInput = byId('classSectionInput');
    const name = nameInput.value.trim();
    const section = sectionInput.value.trim();
    setText('createClassError', '');
    window.AM.fieldError('classNameInput', '');
    if (name.length < 3) { window.AM.fieldError('classNameInput', 'Class name must be at least 3 characters.'); nameInput.focus(); return; }
    await withBusy(byId('createClassBtn'), async () => {
      try {
        await api('/api/classes', 'POST', { name, section });
        nameInput.value = ''; sectionInput.value = '';
        closeCreateDialog();
        toast('Class created');
        await loadClasses();
        if (window.AMNav && window.AMNav.current() !== 'classes') window.AMNav.show('classes'); // show it where it now appears
      } catch (err) { setText('createClassError', err.message); }
    }, 'Creating…');
  });
  byId('createCancelBtn').addEventListener('click', closeCreateDialog);
  byId('createClassOpenBtn').addEventListener('click', openCreateDialog);
  byId('quickCreateBtn').addEventListener('click', openCreateDialog);

  byId('classSearch').addEventListener('input', renderClassList);
  byId('classSort').addEventListener('change', () => { store.set(SORT_KEY, byId('classSort').value); renderClassList(); });
  byId('viewGrid').addEventListener('click', () => { store.set(VIEW_KEY, 'grid'); setClassView('grid'); });
  byId('viewList').addEventListener('click', () => { store.set(VIEW_KEY, 'list'); setClassView('list'); });

  byId('dashCopyLinkBtn').addEventListener('click', () => {
    if (currentClass) copyWithFeedback(byId('dashCopyLinkBtn'), byId('dashCopyStatus'), inviteUrlOf(currentClass), 'Invite link');
  });
  byId('dashDownloadBtn').addEventListener('click', () => {
    if (currentClass) withBusy(byId('dashDownloadBtn'), () => downloadExtension(currentClass), 'Preparing…');
  });

  byId('dashCopyCodeBtn').addEventListener('click', () => {
    if (currentClass) copyWithFeedback(byId('dashCopyCodeBtn'), byId('dashCopyStatus'), currentClass.classCode, 'Class code');
  });

  byId('sendPromptBtn').addEventListener('click', async () => {
    const input = byId('promptText');
    const text = input.value.trim();
    if (!currentClass || !socket) { toast('Open a class dashboard first.', true); return; }
    if (!text) { toast('Type a question first.', true); return; }
    await withBusy(byId('sendPromptBtn'), () => new Promise((resolve) => {
      const timer = setTimeout(() => { toast('No response from the server. Try again.', true); resolve(); }, 5000);
      socket.emit('educator:sendPrompt', { classId: currentClass.id, text }, (response) => {
        clearTimeout(timer);
        if (response && response.ok) { input.value = ''; toast('Question sent'); }
        else toast((response && response.error) || 'Could not send the question.', true);
        resolve();
      });
    }), 'Sending…');
  });
  byId('promptText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); byId('sendPromptBtn').click(); } });

  byId('resetBtn').addEventListener('click', async () => {
    if (!currentClass || !socket) return;
    const ok = await confirmDialog({
      title: 'Clear live data?',
      message: 'Resets every counter and flag for this class and forgets offline students. Connected students stay connected. Use it between lessons.',
      confirmLabel: 'Clear live data'
    });
    if (!ok) return;
    socket.emit('educator:resetClass', { classId: currentClass.id }, (response) => {
      if (response && response.ok) { averageSamples = []; lastAverageAt = 0; toast('Live data cleared'); } else toast((response && response.error) || 'Could not clear the data.', true);
    });
  });

  ['searchInput', 'stateFilter', 'sortSelect'].forEach((id) => byId(id).addEventListener('input', () => { lastOrderKey = null; lastOrder = []; scheduleRender(); }));
  byId('exportCsvBtn').addEventListener('click', exportCsv);
  byId('printBtn').addEventListener('click', () => window.print());
  byId('deleteAccountBtn').addEventListener('click', () =>
    deleteAccountFlow('Your account and all of your classes will be erased, and their students will be disconnected.'));
  byId('logoutBtn').addEventListener('click', () => withBusy(byId('logoutBtn'), signOut, 'Signing out…'));
  byId('shutdownBtn').addEventListener('click', shutDownServer);

  // Counts on Home and the class list go stale while students come and go: refresh them whenever the person returns to
  // those tabs. The address also decides which class (if any) is open.
  document.addEventListener('am:tabchange', (event) => {
    if (event.detail && (event.detail.tab === 'home' || event.detail.tab === 'classes') && currentUser && classesReady) loadClasses();
    syncRoute();
  });
  window.addEventListener('hashchange', syncRoute);

  // Settings tab: class layout / sort order / recently opened were changed or reset somewhere else.
  document.addEventListener('am:prefchange', (event) => {
    const name = event.detail && event.detail.name;
    if (name === 'classView' || name === '*') setClassView(store.get(VIEW_KEY));
    if (name === 'classSort' || name === '*') {
      const savedSort = store.get(SORT_KEY);
      const fallback = byId('classSort').options[0].value;
      byId('classSort').value = [...byId('classSort').options].some((o) => o.value === savedSort) ? savedSort : fallback;
      renderClassList();
    }
    if (name === 'recents' || name === '*') { renderRecents(); if (name === 'recents' && allClasses.length && byId('classSort').value === 'recent') renderClassList(); }
  });

  (async function init() {
    classLoadingSurface(); // the live region must exist before its text changes
    if (routeClassId()) showClassLoading('Loading class…'); // refreshed deep link: never leave the panel blank
    if (!(await checkAuth())) return;
    const savedSort = store.get(SORT_KEY);
    if ([...byId('classSort').options].some((o) => o.value === savedSort)) byId('classSort').value = savedSort;
    setClassView(store.get(VIEW_KEY));
    setupSocket();
    loadServerInfo();
    await ensureClasses();
    await syncRoute();
  })();
})();
