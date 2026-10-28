/* Attentix - MV3 service worker.
 *
 * Owns the Socket.IO connection and everything that depends on tabs/windows. Chrome can stop a service worker at any
 * time, so anything durable lives in chrome.storage.local and the worker re-hydrates itself whenever it wakes up.
 *
 * Telemetry path:  content scripts --signals--> here --computeAttentiveness--> heartbeat --> server
 *   * one sample every TICK_MS (2 s); one heartbeat every HEARTBEAT_MS (5 s), or at once when the state changes
 *   * heartbeats go over Socket.IO; while it is down the last 5 wait in a buffer and are sent on reconnect or, after
 *     FALLBACK_AFTER_MS, over REST
 *   * the toolbar badge always shows the live score and state colour
 */
importScripts('lib/socket.io.min.js', 'scoring.js');
// config.js is written by the professor's server ("Download Pre-Configured Student Extension"). It is optional: a missing file must never stop the worker.
try { importScripts('config.js'); } catch { /* not pre-configured */ }

const {
  MEETING_URL_PATTERNS, isMeetingUrl, locate, computeAttentiveness, mergeFrameSignals, smoothScore,
  newSwitchTracker, stepSwitchTracker, summarizeSwitches
} = self.AttentionScoring;

const TICK_MS = 2000;
const HEARTBEAT_MS = 5000;
const MIN_STATE_CHANGE_GAP_MS = 1000;
const MAX_BUFFER = 5;
const MAX_BEAT_AGE_MS = 60 * 1000;          // the server ignores older beats, so they are not sent
const CONNECT_TIMEOUT_MS = 10000;
const ACK_TIMEOUT_MS = 4000;
const FALLBACK_AFTER_MS = 12000;            // socket not joined for this long -> deliver over REST instead
const SERVER_FRESH_MS = 15000;              // a server-confirmed score older than this is shown as local
const FRAME_FORGET_MS = 30000;
const POPUP_SEEN_MS = 3000;                 // a popup that polled within this long ago is still open
const POPUP_GRACE_MS = 2000;                // focus returns to the page a moment after the popup closes
const LOGOUT_TIMEOUT_MS = 4000;             // best-effort token revoke when the student leaves the class

// Texts the popup shows the student as-is (notices and the error line).
const MSG = {
  sessionEnded: 'Your session ended. Join the class again.',
  sessionExpired: 'Your session expired. Join the class again.',
  stoppedByServer: 'Monitoring was stopped by the server.',
  unreachable: 'Cannot reach the server - retrying...'
};

const STATE_COLORS = {                      // white badge text on each: all >= 4.5:1
  Focused: '#15803d', Passive: '#7a5a00', Distracted: '#b91c1c', Idle: '#475569', Offline: '#b45309', None: '#475569'
};

const runtime = {
  session: null,        // mirrors chrome.storage.local `session`: { serverUrl, token, expiresAt, classId, classCode, className, ... }
  socket: null,
  joined: false,
  connecting: null,
  timer: null,
  attempts: 0,          // reconnect attempts since the last successful connect
  offlineSince: null,
  restOkAt: 0,          // last time a REST heartbeat was accepted
  frames: new Map(),    // `${tabId}:${frameId}` -> latest signals from that frame
  switchTracker: newSwitchTracker(),
  switchTimes: [],
  outbox: [],           // the last <= 5 heartbeats not yet acknowledged by the server
  flushing: false,
  lastBeatAt: 0,
  lastBeatKey: null,
  local: null,          // latest local reading { score, state, location, isFocused, idleSeconds, tabSwitches, at }
  smooth: null,
  smoothAt: 0,
  server: null,         // latest server-confirmed row { focusScore, attentionState, reasons, ..., at }
  lastSyncAt: null,
  meetingTabs: 0,
  popupPorts: new Set(), // open connections from the toolbar popup (its presence = the student is using the extension)
  popupSeenAt: 0,
  popupClosedAt: 0,
  lastError: null
};

// ---- storage helpers ----
const store = () => chrome.storage.local;
// AbortSignal.timeout does not exist in every runtime; without it a request simply has no client-side timeout.
const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const sessionUsable = (s) => Boolean(s && typeof s.token === 'string' && s.token && s.expiresAt > Date.now() && originOf(s.serverUrl));

function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
  const serverUrl = originOf(raw.serverUrl);
  const session = {
    serverUrl,
    token: str(raw.token, 1024),
    expiresAt: Number(raw.expiresAt),
    studentId: str(raw.studentId, 64),
    classId: str(raw.classId, 64),
    classCode: str(raw.classCode, 16),
    className: str(raw.className, 200),
    educatorName: str(raw.educatorName, 200),
    student: { name: str(raw.student && raw.student.name, 200), email: str(raw.student && raw.student.email, 254) },
    joinedAt: Date.now()
  };
  return serverUrl && session.token && session.classId && Number.isFinite(session.expiresAt) ? session : null;
}

// ---- what the student sees: score + state ----
// Prefer the server's smoothed value (it is exactly what the educator sees); fall back to the local reading while offline.
function reading() {
  const server = runtime.server;
  if (server && typeof server.focusScore === 'number' && Date.now() - server.at < SERVER_FRESH_MS && runtime.local) {
    return { score: server.focusScore, state: server.attentionState || runtime.local.state, source: 'server' };
  }
  if (runtime.local && runtime.smooth !== null) {
    return { score: Math.round(runtime.smooth), state: runtime.local.state, source: 'local' };
  }
  return { score: null, state: null, source: null };
}

const healthOf = () => {
  if (runtime.joined) return 'connected';
  if (Date.now() - runtime.restOkAt < SERVER_FRESH_MS) return 'fallback';
  return 'reconnecting';
};

// ---- toolbar badge ----
function renderBadge() {
  let text = '';
  let color = STATE_COLORS.None;
  let title = 'Attentix: not joined to a class';
  if (runtime.session) {
    const health = healthOf();
    const r = reading();
    if (health === 'reconnecting') {
      text = '...'; color = STATE_COLORS.Offline;
      title = `Attentix: reconnecting to ${runtime.session.className || 'your class'}`;
    } else if (r.score === null) {
      text = '--'; color = STATE_COLORS.None;
      title = `Attentix: connected to ${runtime.session.className || 'your class'}. Open your Meet or Zoom class tab to start.`;
    } else {
      text = String(r.score); color = STATE_COLORS[r.state] || STATE_COLORS.None;
      title = `Attentix: ${r.state} (${r.score}%) in ${runtime.session.className || 'your class'}`;
    }
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
  if (chrome.action.setTitle) chrome.action.setTitle({ title });
}

// ---- meeting tabs ----
const findMeetingTabs = async () => (await chrome.tabs.query({ url: MEETING_URL_PATTERNS })).filter((t) => isMeetingUrl(t.url));

// Tabs open before the extension was installed/reloaded never got the content script: inject it, or signals stay missing until the student reloads Meet.
async function injectContentScripts() {
  const tabs = await chrome.tabs.query({ url: MEETING_URL_PATTERNS });
  await Promise.all(tabs.map((tab) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {})
  ));
}

// Shows an educator question on every open meeting tab (top frame).
async function deliverPrompt(text) {
  const tabs = await findMeetingTabs();
  const message = { type: 'prompt', text: String(text || '').slice(0, 300) };
  await Promise.all(tabs.map((tab) => Promise.resolve(chrome.tabs.sendMessage(tab.id, message, { frameId: 0 })).catch(() => {})));
}

// ---- session end ----
// Stops telemetry, forgets the token and class, and leaves a notice for the popup to show on the Join form.
async function endSession(kind, text) {
  runtime.session = null;
  stopLoop();
  closeSocket();
  runtime.lastError = text || null;
  await store().remove('session');
  if (text) await store().set({ notice: { kind, text, at: Date.now() } });
  renderBadge();
}

// ---- socket ----
function closeSocket() {
  if (runtime.socket) {
    runtime.socket.removeAllListeners();
    if (runtime.socket.io) runtime.socket.io.off('reconnect_attempt');
    runtime.socket.disconnect();
  }
  runtime.socket = null;
  runtime.joined = false;
}

const emitIfJoined = (event, payload, ack) => {
  if (runtime.socket && runtime.socket.connected && runtime.joined) runtime.socket.emit(event, payload, ack);
};

const markOffline = () => { if (runtime.offlineSince === null) runtime.offlineSince = Date.now(); };

// Resolves { ok: true } once the class was joined, { ok: false, fatal: true, error } when the server refuses the student for
// good, or { ok: true, degraded: true } when the server is unreachable (it keeps retrying; heartbeats are buffered or sent over REST).
async function connectAndJoin() {
  if (runtime.connecting) return runtime.connecting;
  runtime.connecting = (async () => {
    const session = runtime.session;
    if (!sessionUsable(session)) return { ok: false, fatal: true, error: MSG.sessionExpired };

    closeSocket();
    runtime.lastError = null;
    runtime.attempts = 0;
    markOffline();

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => {
        runtime.lastError = MSG.unreachable;
        renderBadge();
        settle({ ok: true, degraded: true });
      }, CONNECT_TIMEOUT_MS);

      // WebSocket only: XHR long-polling does not exist in a service worker. Reconnects use exponential backoff (1 s up to 30 s, +-50% jitter) so a class does not reconnect in step.
      const socket = io(session.serverUrl, {
        transports: ['websocket'],
        auth: { token: session.token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
        forceNew: true
      });
      runtime.socket = socket;
      socket.io.on('reconnect_attempt', (n) => { runtime.attempts = n; renderBadge(); });

      const join = () => {
        socket.emit('join_class', session.classId, (ack) => {
          if (runtime.socket !== socket) return;
          if (ack && ack.ok) {
            runtime.joined = true;
            runtime.offlineSince = null;
            runtime.attempts = 0;
            runtime.lastError = null;
            if (ack.className) { session.className = ack.className; store().set({ session }); }
            renderBadge();
            flush();                                  // deliver whatever was buffered while offline
            return settle({ ok: true });
          }
          runtime.joined = false;
          const error = (ack && ack.error) || 'Unable to join the class.';
          // The server said no (consent withdrawn, un-enrolled, class gone...). Retrying would only be refused again.
          if (settled) endSession('revoked', error); else settle({ ok: false, fatal: true, error });
        });
      };

      socket.on('connect', join);
      socket.on('disconnect', (reason) => {
        runtime.joined = false;
        markOffline();
        renderBadge();
        // Socket.IO retries after a network drop but NOT after the server closed this socket (restart, connection limit...). session:revoked already ended the session if that was final.
        if (reason === 'io server disconnect') setTimeout(() => { if (runtime.socket === socket && runtime.session) socket.connect(); }, 2000);
      });
      socket.on('chat:prompt', (payload) => { deliverPrompt(payload && payload.text); });
      socket.on('student:self', (payload) => {
        if (payload && payload.status && payload.classId === session.classId) runtime.server = { ...payload.status, at: Date.now() };
        renderBadge();
      });
      // The server ended monitoring on purpose (consent withdrawn, removed from the class, signed out...). Stop for good.
      socket.on('session:revoked', (payload) => {
        const reason = (payload && payload.reason) || MSG.stoppedByServer;
        settle({ ok: false, fatal: true, error: reason });
        endSession('revoked', reason);
      });
      socket.on('connect_error', (err) => {
        runtime.joined = false;
        markOffline();
        const message = String((err && err.message) || err);
        if (message.includes('Authentication')) {
          // Bad / expired / revoked token, or the student record is gone. There is no password to fall back on.
          settle({ ok: false, fatal: true, error: MSG.sessionEnded });
          endSession('expired', MSG.sessionEnded);
        } else {
          runtime.lastError = message.includes('Too many') ? message : MSG.unreachable;
          renderBadge();
        }
      });
      // The server restarted and forgot this socket's class: join again.
      socket.on('error', (payload) => {
        if (payload && /join a class/i.test(String(payload.message))) join();
      });
    });
  })().finally(() => { runtime.connecting = null; });
  return runtime.connecting;
}

// ---- heartbeats ----
const beatPayload = (beats, now) => ({
  beats: beats
    .map((b) => ({
      score: b.score, state: b.state, location: b.location, isFocused: b.isFocused,
      idleSeconds: b.idleSeconds, ageMs: Math.max(0, now - b.t)
    }))
    .filter((b) => b.ageMs <= MAX_BEAT_AGE_MS)
});

const dropSent = (sent) => { runtime.outbox = runtime.outbox.filter((b) => !sent.includes(b)); };

function onDelivered(sent, status, via) {
  dropSent(sent);
  runtime.lastSyncAt = Date.now();
  if (via === 'rest') runtime.restOkAt = Date.now();
  if (status) runtime.server = { ...status, at: Date.now() };
  renderBadge();
}

async function flushOverRest(session, sent, payload) {
  let res;
  try {
    res = await fetch(`${session.serverUrl}/api/extension/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(payload),
      signal: timeoutSignal(ACK_TIMEOUT_MS)
    });
  } catch {
    runtime.lastError = MSG.unreachable;
    return;                                           // offline: the buffer keeps the last 5 beats
  }
  if (runtime.session !== session) return;
  const data = await res.json().catch(() => ({}));
  if (res.ok) { runtime.lastError = null; return onDelivered(sent, data.status, 'rest'); }
  if (res.status === 401) return endSession('expired', MSG.sessionEnded);
  if (res.status === 403) return endSession('revoked', data.error || MSG.stoppedByServer);
  runtime.lastError = data.error || `The server answered ${res.status}.`;
}

async function flush() {
  const session = runtime.session;
  if (!session || runtime.flushing || runtime.outbox.length === 0) return;
  const now = Date.now();
  const sent = runtime.outbox.slice();
  const payload = beatPayload(sent, now);
  if (payload.beats.length === 0) { dropSent(sent); return; }

  if (runtime.joined && runtime.socket && runtime.socket.connected) {
    runtime.flushing = true;
    runtime.socket.timeout(ACK_TIMEOUT_MS).emit('attention:heartbeat', payload, (err, ack) => {
      runtime.flushing = false;
      if (runtime.session !== session) return;
      if (!err && ack && ack.ok) return onDelivered(sent, ack.status, 'socket');
      if (ack && ack.code === 'not_joined') runtime.joined = false; // the server forgot us: the next 'connect' re-joins
    });
    return;
  }

  // Socket not joined. Give Socket.IO's backoff a moment, then use REST so students behind a WebSocket-blocking
  // proxy are still counted.
  if (runtime.offlineSince !== null && now - runtime.offlineSince >= FALLBACK_AFTER_MS) {
    runtime.flushing = true;
    try { await flushOverRest(session, sent, payload); } finally { runtime.flushing = false; renderBadge(); }
  }
}

// ---- monitoring lifecycle ----
function startLoop() {
  if (runtime.timer) return;
  runtime.switchTracker = newSwitchTracker();
  runtime.timer = setInterval(() => { tick().catch((e) => console.warn('tick failed', e)); }, TICK_MS);
}

function stopLoop() {
  clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.frames.clear();
  runtime.outbox = [];
  runtime.flushing = false;
  runtime.local = null;
  runtime.server = null;
  runtime.smooth = null;
  runtime.lastBeatAt = 0;
  runtime.lastBeatKey = null;
  runtime.lastSyncAt = null;
  runtime.meetingTabs = 0;
  runtime.switchTimes = [];
  runtime.switchTracker = newSwitchTracker();
  runtime.offlineSince = null;
  runtime.restOkAt = 0;
}

async function startSession(raw) {
  const session = sanitizeSession(raw);
  if (!session) return { ok: false, error: 'The server sent an invalid session. Try joining again.' };
  if (runtime.session) { stopLoop(); closeSocket(); }
  runtime.session = session;
  await store().set({ session });
  await store().remove('notice');
  const result = await connectAndJoin();
  if (!result.ok) {
    // `endSession` may already have run (revoked while joining); make sure nothing is left behind either way.
    if (runtime.session) await endSession(null, null);
    return result;
  }
  startLoop();
  renderBadge();
  injectContentScripts();
  return { ok: true, degraded: Boolean(result.degraded) };
}

// Tells the server to invalidate every token issued to this student, so a copied or forgotten token stops working.
// Best effort: leaving a class locally must never be blocked by a network problem.
async function revokeTokenOnServer(session) {
  try {
    if (!session || !session.token || typeof fetch !== 'function') return;
    await fetch(`${session.serverUrl}/api/extension/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: timeoutSignal(LOGOUT_TIMEOUT_MS)
    });
  } catch { /* offline or already expired: nothing more to do */ }
}

async function disconnect() {
  const session = runtime.session;
  await endSession(null, null);            // telemetry stops first, whatever the network does next
  await store().remove('notice');
  await revokeTokenOnServer(session);
}

async function retry() {
  if (!runtime.session) return { ok: false, error: 'Not joined to a class.' };
  if (!sessionUsable(runtime.session)) { await endSession('expired', MSG.sessionExpired); return { ok: false, error: 'Session expired.' }; }
  runtime.lastError = null;
  connectAndJoin().then((result) => { if (!result.ok && result.fatal && runtime.session) endSession('revoked', result.error); });
  return { ok: true };
}

// Runs on every service-worker wake-up.
async function rehydrate() {
  const { session } = await store().get('session');
  if (!session) { runtime.session = null; renderBadge(); return; }
  if (!sessionUsable(session)) { await endSession('expired', MSG.sessionExpired); return; }
  // Keep the live object when it is the same session: in-flight acknowledgements compare it by identity.
  if (!runtime.session || runtime.session.token !== session.token) runtime.session = session;
  startLoop();
  if (!runtime.socket) await connectAndJoin();
  renderBadge();
}

// What is the student looking at? Opening the popup makes Chrome report the window as unfocused, so while it is open (or just
// closed) the window still counts as the student's; the extension's own pages count as class, like the Attentix website.
async function readLocation(session, now) {
  const popupOpen = runtime.popupPorts.size > 0 || now - runtime.popupSeenAt < POPUP_SEEN_MS || now - runtime.popupClosedAt < POPUP_GRACE_MS;
  const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal', 'popup'] });
  const activeTab = win && (win.focused || popupOpen) ? (win.tabs || []).find((t) => t.active) : null;
  const location = locate({
    activeUrl: activeTab && activeTab.url,
    windowFocused: Boolean(win && win.focused),
    popupOpen,
    serverOrigin: originOf(session.serverUrl),
    extensionOrigin: chrome.runtime.getURL('')
  });
  return { activeTab, location };
}

// One heartbeat per HEARTBEAT_MS, or right away when the picture changed (so a tab switch shows up in ~1 s).
function queueHeartbeatIfDue(result, location, isFocused, now) {
  const key = `${result.state}|${location}|${isFocused}`;
  const due = now - runtime.lastBeatAt >= HEARTBEAT_MS;
  const changed = key !== runtime.lastBeatKey && now - runtime.lastBeatAt >= MIN_STATE_CHANGE_GAP_MS;
  if (!due && !changed) return;
  runtime.outbox.push({ t: now, score: result.score, state: result.state, location, isFocused, idleSeconds: result.idleSeconds });
  if (runtime.outbox.length > MAX_BUFFER) runtime.outbox.splice(0, runtime.outbox.length - MAX_BUFFER);
  runtime.lastBeatAt = now;
  runtime.lastBeatKey = key;
}

// ---- one sample every TICK_MS ----
// Tab/window state is read here (authoritative): Chrome throttles timers in background tabs, so a page script cannot report
// "I am hidden" on time. The page supplies only what it can see: interaction cadence, scrolling, media playback.
async function tick() {
  const session = runtime.session;
  if (!session) return;
  const now = Date.now();
  if (!sessionUsable(session)) { await endSession('expired', MSG.sessionExpired); return; }

  for (const [key, frame] of runtime.frames) if (now - frame.receivedAt > FRAME_FORGET_MS) runtime.frames.delete(key);

  const tabs = await findMeetingTabs();
  runtime.meetingTabs = tabs.length;

  if (tabs.length === 0) {           // not in a meeting: send nothing rather than invent a score
    runtime.local = null;
    runtime.smooth = null;
    runtime.switchTracker = stepSwitchTracker(runtime.switchTracker, 'none').tracker;
    renderBadge();
    flush();                          // anything still buffered from before the tab closed
    return;
  }

  const { activeTab, location } = await readLocation(session, now);

  const step = stepSwitchTracker(runtime.switchTracker, location);
  runtime.switchTracker = step.tracker;
  if (step.switched) {
    runtime.switchTimes.push(now);
    emitIfJoined('extension:event', { type: 'tab-switch' });
  }
  const switches = summarizeSwitches(runtime.switchTimes, now);
  runtime.switchTimes = switches.times;

  let signals = null;
  if (location === 'meeting' && activeTab) {
    const frames = [...runtime.frames.entries()].filter(([key]) => key.startsWith(`${activeTab.id}:`)).map(([, f]) => f);
    signals = mergeFrameSignals(frames, now);
  }
  // The page says it is hidden although Chrome says it is in front (rare, e.g. a minimised PiP window): believe the page.
  const isFocused = location !== 'away' && !(signals && signals.visible === false);

  const result = computeAttentiveness({
    isFocused,
    idleSeconds: signals ? signals.idleSeconds : null,     // null = the page has not reported (yet): neutral, not "idle"
    activeBuckets: signals ? signals.activeBuckets : 0,
    scrolling: signals ? signals.scrolling : false,
    mediaPlaying: signals ? signals.mediaPlaying : false,
    onToolPage: location === 'tool',
    tabSwitches: switches.recent,
    rapidSwitches: switches.rapid
  });

  runtime.smooth = smoothScore(runtime.smooth === null ? undefined : runtime.smooth, result.score, now - (runtime.smoothAt || now));
  runtime.smoothAt = now;
  runtime.local = { ...result, location, at: now };

  queueHeartbeatIfDue(result, location, isFocused, now);
  renderBadge();
  flush();
}

// ---- messages ----
const ready = rehydrate();

async function statusSnapshot({ forPage = false } = {}) {
  const { notice } = await store().get('notice');
  const session = runtime.session;
  const r = reading();
  const local = runtime.local;
  const snapshot = {
    ok: true,
    joined: Boolean(session),
    monitoring: session ? { classId: session.classId, className: session.className, classCode: session.classCode } : null,
    connected: runtime.joined,
    score: r.score,
    state: r.state,
    meetingTabs: runtime.meetingTabs
  };
  if (forPage) return snapshot;           // the meeting page only ever learns what its own badge shows
  return {
    ...snapshot,
    session: session ? {
      serverUrl: session.serverUrl, classId: session.classId, classCode: session.classCode, className: session.className,
      educatorName: session.educatorName, student: session.student, expiresAt: session.expiresAt
    } : null,
    health: session ? healthOf() : null,
    attempts: runtime.attempts,
    buffered: runtime.outbox.length,
    lastSyncAt: runtime.lastSyncAt,
    scoreSource: r.source,
    location: local ? local.location : null,
    isFocused: local ? local.isFocused : null,
    idleSeconds: local ? local.idleSeconds : null,
    tabSwitches: local ? local.tabSwitches : 0,
    reasons: runtime.server && Array.isArray(runtime.server.reasons) ? runtime.server.reasons : [],
    error: runtime.lastError,
    notice: notice || null
  };
}

const answerPrompt = (response) => new Promise((resolve) => {
  if (!runtime.socket || !runtime.socket.connected || !runtime.joined) return resolve({ ok: false, error: 'Not connected to the class.' });
  const timer = setTimeout(() => resolve({ ok: false, error: 'No response from the server.' }), 5000);
  runtime.socket.emit('student:chatResponse', { response: String(response || '').slice(0, 500) }, (ack) => {
    clearTimeout(timer);
    resolve(ack && ack.ok ? { ok: true } : { ok: false, error: (ack && ack.error) || 'Could not send.' });
  });
});

const num = (v, max) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0);

function recordSignals(msg, sender) {
  if (!sender.tab || typeof sender.tab.id !== 'number') return;
  runtime.frames.set(`${sender.tab.id}:${sender.frameId || 0}`, {
    receivedAt: Date.now(),
    idleMs: num(msg.idleMs, 24 * 60 * 60 * 1000),
    buckets: num(msg.buckets, 20),
    scrolling: msg.scrolling === true,
    media: msg.media === true,
    visible: msg.visible !== false
  });
}

async function handle(msg, sender) {
  await ready;
  const fromPage = Boolean(sender && sender.tab);           // content scripts get a small, fixed set of messages
  if (!fromPage && sender && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('popup.html'))) runtime.popupSeenAt = Date.now();
  const pageOnly = ['signals', 'chatSent', 'promptReply', 'status'];
  if (fromPage && !pageOnly.includes(msg && msg.type)) return { ok: false, error: 'Not allowed.' };

  switch (msg && msg.type) {
    case 'signals':
      recordSignals(msg, sender);
      return { ok: true };
    case 'chatSent':
      // Only the fact that a message was sent. The text never reaches the extension.
      if (runtime.session) emitIfJoined('extension:event', { type: 'chat-sent' });
      return { ok: true };
    case 'promptReply':
      return answerPrompt(msg.response);
    case 'status':
      return statusSnapshot({ forPage: fromPage });
    case 'connect':
      return startSession(msg.session);
    case 'retry':
      return retry();
    case 'disconnect':
      await disconnect();
      return { ok: true };
    case 'dismissNotice':
      await store().remove('notice');
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown message.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});

// The popup keeps a port open while it is showing: that is how the worker knows the student is using the extension.
if (chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'amp-popup') return;
    runtime.popupPorts.add(port);
    port.onDisconnect.addListener(() => { runtime.popupPorts.delete(port); runtime.popupClosedAt = Date.now(); });
  });
}

if (chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const key of [...runtime.frames.keys()]) if (key.startsWith(`${tabId}:`)) runtime.frames.delete(key);
  });
}

// Safety net: if Chrome stopped the worker, the alarm wakes it and rehydrate() resumes the session.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'keepalive') rehydrate(); });
chrome.runtime.onStartup.addListener(() => { rehydrate(); });
// The server address from config.js becomes the remembered address, so everything reading `prefs` points at the right server.
// Only the address is stored; the popup re-reads the class code from config.js each time.
async function applyPreconfig() {
  const cfg = globalThis.AMP_PRECONFIG;
  const serverUrl = cfg && typeof cfg.serverUrl === 'string' && /^https?:\/\//i.test(cfg.serverUrl) ? originOf(cfg.serverUrl) : null;
  if (!serverUrl) return;
  const { prefs } = await store().get('prefs');
  if (prefs && prefs.serverUrl === serverUrl) return;
  await store().set({ prefs: { ...(prefs || {}), serverUrl } });
}
chrome.runtime.onInstalled.addListener(() => {
  injectContentScripts();
  applyPreconfig().catch(() => { /* storage unavailable: the popup still reads config.js itself */ });
});
