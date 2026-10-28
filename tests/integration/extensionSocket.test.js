/**
 * End-to-end: the REAL extension/background.js (run in a vm with a fake `chrome` API and a real WebSocket) joins a class
 * with a passwordless student token, talks to a REAL server over a real socket, and a REAL educator socket receives what
 * the dashboard would show. Only Chrome itself is faked.
 * The last block drives the same server with bare Socket.IO clients to pin down how heartbeats become scores and who
 * is sent what (educator rows, the student's own row, class average).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const WebSocket = require('ws');
const { io: ioClient } = require('socket.io-client');
const { Server } = require('socket.io');
const request = require('supertest');

const { app, sessionMiddleware } = require('../../src/app');
const db = require('../../src/config/db');
const socketHandler = require('../../src/socket/socketHandler');

const EXT_DIR = path.join(__dirname, '../../extension');
const MEET = 'https://meet.google.com/abc-defg-hij';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(100);
  }
};

function loadBackground() {
  const area = () => {
    const data = {};
    return {
      data,
      get: async (k) => { const keys = typeof k === 'string' ? [k] : k; return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]])); },
      set: async (o) => { Object.assign(data, JSON.parse(JSON.stringify(o))); },
      remove: async (k) => { delete data[k]; }
    };
  };
  const fake = {
    meetingTabs: [],
    active: { focused: true, url: MEET },
    sent: [], injected: [],
    badge: { text: '', color: '', title: '' }, onMessage: null,
    storage: { local: area() }
  };
  const chrome = {
    storage: fake.storage,
    action: {
      setBadgeText: ({ text }) => { fake.badge.text = text; },
      setBadgeBackgroundColor: ({ color }) => { fake.badge.color = color; },
      setBadgeTextColor: () => {},
      setTitle: ({ title }) => { fake.badge.title = title; }
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    runtime: {
      onMessage: { addListener: (fn) => { fake.onMessage = fn; } }, onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} },
      onConnect: { addListener: (fn) => { fake.onConnect = fn; } },
      getURL: (p = '') => `chrome-extension://abcdef/${p}`
    },
    tabs: {
      query: async () => fake.meetingTabs,
      sendMessage: async (id, message, options) => { fake.sent.push({ id, message, options }); },
      onRemoved: { addListener: () => {} }
    },
    windows: { getLastFocused: async () => ({ focused: fake.active.focused, tabs: [{ id: 1, active: true, url: fake.active.url }, { id: 2, active: false, url: MEET }] }) },
    scripting: { executeScript: async (details) => { fake.injected.push(details); } }
  };
  const ctx = vm.createContext({
    chrome, WebSocket, console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, URL, fetch, AbortSignal, JSON, Math, Date
  });
  vm.runInContext('var self = globalThis;', ctx);
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // The toolbar popup: Chrome reports the browser window as unfocused while it is open, and it keeps a port to the worker.
  fake.openPopup = () => {
    const listeners = [];
    const port = { name: 'amp-popup', onDisconnect: { addListener: (fn) => listeners.push(fn) } };
    fake.onConnect(port);
    fake.active = { ...fake.active, focused: false };
    return () => { fake.active = { ...fake.active, focused: true }; listeners.forEach((fn) => fn()); };
  };
  fake.send = (msg, sender = {}) => new Promise((resolve) => fake.onMessage(msg, sender, resolve));
  return fake;
}

describe('extension background.js <-> server <-> educator (passwordless join)', () => {
  let server; let ioServer; let port; let klass; let join; let educatorSocket; let updates; let bg; let eduCookie;
  const page = { tab: { id: 1 }, frameId: 0 };
  const sfx = `${Date.now()}`;

  const row = () => { const last = updates[updates.length - 1]; return last && last.students.find((s) => s.name === 'Stu D'); };
  const sessionFor = (j, p = port) => ({ serverUrl: `http://localhost:${p}`, token: j.token, expiresAt: j.expiresAt, studentId: j.studentId, classId: j.classId, classCode: j.classCode, className: j.className, educatorName: j.educatorName, student: j.student });
  // What the content script would report every few seconds
  const signals = (o = {}) => bg.send({ type: 'signals', visible: true, hasFocus: true, idleMs: 1000, buckets: 6, scrolling: false, media: false, ...o }, page);

  beforeAll(async () => {
    await db.initDb();
    server = http.createServer(app);
    ioServer = new Server(server);
    ioServer.engine.use(sessionMiddleware);
    app.locals.realtime = socketHandler(ioServer);
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    const educator = request.agent(app);
    const reg = await educator.post('/api/auth/educator/register').send({ name: 'Prof E', email: `prof.${sfx}@pup.edu.ph`, password: 'securepassword123' });
    eduCookie = reg.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    klass = (await educator.post('/api/classes').send({ name: 'Net Admin 101' })).body.class;
    join = (await request(app).post('/api/extension/join').send({ name: 'Stu D', email: `stu.${sfx}@pup.edu.ph`, classCode: klass.classCode, consent: true })).body;

    updates = [];
    educatorSocket = ioClient(`http://localhost:${port}`, { transports: ['websocket'], extraHeaders: { cookie: eduCookie } });
    educatorSocket.on('class:update', (p) => updates.push(p));
    await new Promise((resolve, reject) => {
      educatorSocket.on('connect', () => educatorSocket.emit('educator:enterClass', { classId: klass.id }, (a) => (a.ok ? resolve() : reject(new Error(a.error)))));
      educatorSocket.on('connect_error', reject);
    });
  });

  afterAll(async () => {
    if (bg) await bg.send({ type: 'disconnect' });
    educatorSocket.close();
    ioServer.close();
    await new Promise((r) => server.close(r));
  });

  test('a forged token is refused, nothing is stored, and the popup is told to join again', async () => {
    const b = loadBackground();
    const res = await b.send({ type: 'connect', session: { ...sessionFor(join), token: 'forged.token' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/join the class again/i);
    expect(b.storage.local.data.session).toBeUndefined();
    expect(b.badge.text).toBe('');
  });

  test('content scripts can only send signals / chat / prompt-reply / status - never connect, disconnect or retry, and never see the token', async () => {
    const b = loadBackground();
    for (const type of ['connect', 'disconnect', 'retry', 'dismissNotice']) {
      expect(await b.send({ type, session: sessionFor(join) }, page)).toEqual({ ok: false, error: 'Not allowed.' });
    }
    expect(JSON.stringify(await b.send({ type: 'status' }, page))).not.toMatch(/token|email/i);
  });

  test('connect: joins the class, persists the session in chrome.storage.local and injects the content script', async () => {
    bg = loadBackground();
    bg.meetingTabs = [{ id: 1, windowId: 1, active: true, url: MEET }];
    expect(await bg.send({ type: 'connect', session: sessionFor(join) })).toEqual({ ok: true, degraded: false });
    expect(bg.storage.local.data.session).toMatchObject({ classId: klass.id, classCode: klass.classCode, className: 'Net Admin 101', token: join.token });
    expect(bg.injected).toEqual([{ target: { tabId: 1, allFrames: true }, files: ['content.js'] }]);
    const status = await bg.send({ type: 'status' });
    expect(status).toMatchObject({ joined: true, connected: true, health: 'connected', session: { className: 'Net Admin 101', student: { name: 'Stu D' } } });
  });

  test('Focused: active in the meeting tab shows the live score on the toolbar badge and on the educator dashboard', async () => {
    await signals();
    await waitFor(() => { signals(); return row() && row().attentionState === 'Focused'; });
    expect(row()).toMatchObject({ online: true, attentive: true, reasons: [] });
    await waitFor(() => /^\d+$/.test(bg.badge.text));
    expect(bg.badge.color).toBe('#15803d');
    const status = await bg.send({ type: 'status' });
    expect(status).toMatchObject({ state: 'Focused', scoreSource: 'server' });
    expect(Number(bg.badge.text)).toBe(status.score);
  }, 25000);

  test('Passive: watching a lecture video with no mouse for 10 minutes is not flagged as idle', async () => {
    await waitFor(() => { signals({ idleMs: 600000, buckets: 0, media: true }); return row().attentionState === 'Passive'; });
    expect(row()).toMatchObject({ attentive: true, reasons: [] });
    expect(row().idleSeconds).toBeGreaterThanOrEqual(599);
    expect(bg.badge.color).toBe('#7a5a00');
  }, 25000);

  test('Idle: nothing playing and no activity for 6 minutes is flagged', async () => {
    await waitFor(() => { signals({ idleMs: 360000, buckets: 0, media: false }); return row().attentionState === 'Idle'; });
    expect(row().attentive).toBe(false);
    expect(row().reasons.join(' ')).toMatch(/No activity in the meeting/);
    expect(bg.badge.color).toBe('#475569');
  }, 25000);

  test('Distracted: leaving to another app is shown at once, counted as a focus loss and turns the badge red', async () => {
    await signals();
    await waitFor(() => { signals(); return row().attentionState === 'Focused'; });
    const before = row().focusLossCount;
    bg.active = { focused: false, url: MEET };
    await waitFor(() => row().attentionState === 'Distracted');
    expect(row()).toMatchObject({ attentive: false, tabHidden: true });
    expect(row().focusLossCount).toBe(before + 1);
    expect(row().reasons.join(' ')).toMatch(/Meeting tab not in focus/);
    await waitFor(() => bg.badge.color === '#b91c1c');
  }, 30000);

  test('tab switches: once per trip away, not for the app page', async () => {
    bg.active = { focused: true, url: MEET };
    await waitFor(() => { signals(); return row() && !row().tabHidden; });
    const base = row().tabSwitchCount;
    bg.active = { focused: true, url: `http://localhost:${port}/student.html` };
    await sleep(5500);
    bg.active = { focused: true, url: MEET };
    await sleep(2500);
    expect(row().tabSwitchCount).toBe(base);
    bg.active = { focused: true, url: 'https://www.youtube.com/watch?v=x' };
    await waitFor(() => row().tabSwitchCount === base + 1);
    await sleep(5500);
    expect(row().tabSwitchCount).toBe(base + 1);
    bg.active = { focused: true, url: MEET };
  }, 45000);

  test('using the extension is not leaving class: the toolbar popup and the extension\'s own pages are never a tab switch or a focus loss', async () => {
    bg.active = { focused: true, url: MEET };
    await waitFor(() => { signals(); return row() && !row().tabHidden && row().attentionState === 'Focused'; });
    const base = row().tabSwitchCount;
    const lossBase = row().focusLossCount;
    const closePopup = bg.openPopup();            // Chrome now says: browser window not focused
    await sleep(6500);                             // well over the 2 ticks a real switch needs
    signals();
    expect(row()).toMatchObject({ tabHidden: false });
    expect(row().tabSwitchCount).toBe(base);
    closePopup();
    await sleep(2500);
    expect(row().tabSwitchCount).toBe(base);
    bg.active = { focused: true, url: 'chrome-extension://abcdef/popup.html' };   // popup.html opened in its own tab
    await sleep(6500);
    expect(row().tabSwitchCount).toBe(base);
    expect(row().tabHidden).toBe(false);
    expect(row().focusLossCount).toBe(lossBase);
    bg.active = { focused: true, url: MEET };
  }, 45000);

  test('server outage: the socket drops, readings are buffered (max 5), and delivery resumes after Socket.IO reconnects', async () => {
    await waitFor(() => { signals(); return row() && row().attentionState === 'Focused'; });
    for (const sock of ioServer.sockets.sockets.values()) if (sock.data.user && sock.data.user.role === 'student') sock.conn.close();   // network drop for the student only
    bg.active = { focused: false, url: MEET };               // something worth reporting happens while offline
    await waitFor(async () => (await bg.send({ type: 'status' })).buffered > 0 || row().attentionState === 'Distracted');
    expect((await bg.send({ type: 'status' })).buffered).toBeLessThanOrEqual(5);
    await waitFor(async () => (await bg.send({ type: 'status' })).connected, 20000);       // reconnected with backoff
    await waitFor(() => row().attentionState === 'Distracted', 20000);                      // the buffered reading arrived
    expect((await bg.send({ type: 'status' })).buffered).toBe(0);
    bg.active = { focused: true, url: MEET };
  }, 60000);

  test('educator question appears on the meeting tab; the on-page answer box counts as the reply', async () => {
    await waitFor(async () => (await bg.send({ type: 'status' })).connected);
    expect(await new Promise((r) => educatorSocket.emit('educator:sendPrompt', { classId: klass.id, text: 'What is a subnet mask?' }, r))).toEqual({ ok: true });
    await waitFor(() => bg.sent.length === 1);
    expect(bg.sent[0]).toEqual({ id: 1, message: { type: 'prompt', text: 'What is a subnet mask?' }, options: { frameId: 0 } });
    const before = row().chatResponses;
    expect(await bg.send({ type: 'promptReply', response: 'The network part of an address' }, page)).toEqual({ ok: true });
    await waitFor(() => row().chatResponses === before + 1);
  }, 30000);

  test('no Meet/Zoom tab open: nothing is invented or sent, the badge shows "--"', async () => {
    bg.meetingTabs = [];
    await waitFor(() => bg.badge.text === '--', 8000);
    const count = updates.length;
    await sleep(4500);
    const status = await bg.send({ type: 'status' });
    expect(status).toMatchObject({ meetingTabs: 0, score: null, state: null });
    expect(updates.slice(count).every((u) => u.students.find((s) => s.name === 'Stu D'))).toBe(true);   // only periodic refreshes, no new readings
    bg.meetingTabs = [{ id: 1, windowId: 1, active: true, url: MEET }];
  }, 30000);

  test('Disconnect: telemetry stops, the session is cleared, the token is revoked and the student leaves the dashboard', async () => {
    expect(await bg.send({ type: 'disconnect' })).toEqual({ ok: true });
    expect(bg.storage.local.data.session).toBeUndefined();
    expect(bg.badge.text).toBe('');
    expect(await bg.send({ type: 'status' })).toMatchObject({ joined: false, session: null, monitoring: null });
    await waitFor(() => row() && row().online === false);
    await sleep(300);
    expect((await request(app).get('/api/student/classes').set({ Authorization: `Bearer ${join.token}` })).status).toBe(401);   // revoked
  }, 20000);

  test('when the server revokes monitoring (consent withdrawn...) the extension stops for good and leaves a notice', async () => {
    const j = (await request(app).post('/api/extension/join').send({ name: 'Stu D', email: `stu.${sfx}@pup.edu.ph`, classCode: klass.classCode, consent: true })).body;
    bg = loadBackground();
    expect((await bg.send({ type: 'connect', session: sessionFor(j) })).ok).toBe(true);
    ioServer.emit('session:revoked', { reason: 'You withdrew your consent. Monitoring has stopped.' });
    await waitFor(() => bg.storage.local.data.session === undefined);
    expect(bg.badge.text).toBe('');
    expect((await bg.send({ type: 'status' })).notice.text).toMatch(/withdrew your consent/i);
    expect(await bg.send({ type: 'dismissNotice' })).toEqual({ ok: true });
    expect((await bg.send({ type: 'status' })).notice).toBeNull();
  }, 20000);

  describe('REST heartbeat (WebSocket blocked or down)', () => {
    let j; let auth;
    beforeAll(async () => {
      j = (await request(app).post('/api/extension/join').send({ name: 'Rest Only', email: `rest.${sfx}@pup.edu.ph`, classCode: klass.classCode, consent: true })).body;
      auth = { Authorization: `Bearer ${j.token}` };
    });
    const beat = (o = {}) => ({ score: 80, state: 'Passive', location: 'meeting', isFocused: true, idleSeconds: 90, ...o });
    const restRow = () => { const last = updates[updates.length - 1]; return last && last.students.find((s) => s.name === 'Rest Only'); };

    test('needs a student bearer token', async () => {
      expect((await request(app).post('/api/extension/heartbeat').send({ beats: [beat()] })).status).toBe(401);
      expect((await request(app).post('/api/extension/heartbeat').set({ Authorization: 'Bearer nope' }).send({ beats: [beat()] })).status).toBe(401);
    });

    test('validates the payload', async () => {
      const post = (b) => request(app).post('/api/extension/heartbeat').set(auth).send(b);
      expect((await post({})).status).toBe(400);
      expect((await post({ beats: [] })).status).toBe(400);
      expect((await post({ beats: Array(6).fill(beat()) })).status).toBe(400);
      expect((await post({ beats: [beat({ state: 'Sleeping' })] })).status).toBe(400);
      expect((await post({ beats: [beat({ score: 101 })] })).status).toBe(400);
    });

    test('accepted beats update the educator dashboard and answer with the row the student sees', async () => {
      const res = await request(app).post('/api/extension/heartbeat').set(auth).send({ beats: [beat({ ageMs: 4000, score: 60 }), beat({ ageMs: 0, score: 80 })] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, accepted: 2, status: { attentionState: 'Passive', online: true } });
      expect(res.body.status.studentId).toBeUndefined();
      const again = await request(app).post('/api/extension/heartbeat').set(auth).send({ beats: [beat({ ageMs: 30, score: 80 })] });
      expect(again.body.accepted).toBe(0);                       // the same sample re-sent (lost ack) is a duplicate
      await waitFor(() => restRow() && restRow().online && restRow().attentionState === 'Passive');
      expect(restRow().attentive).toBe(true);
    }, 20000);

    test('after consent is withdrawn the heartbeat is refused', async () => {
      await request(app).post('/api/student/consent').set(auth).send({ decision: 'decline' });
      const res = await request(app).post('/api/extension/heartbeat').set(auth).send({ beats: [beat({ ageMs: 0 })] });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Socket.IO telemetry: heartbeats become server-side scores and are broadcast to the right rooms', () => {
    let cls; let a; let b; let c; let eduSock; let sockA; let sockB; let sockC;
    const eduUpdates = []; const detailed = []; const selfA = []; const averagesA = []; const averagesB = [];
    const leaks = { classUpdate: 0, detailed: 0 };
    const url = () => `http://localhost:${port}`;
    const beat = (o = {}) => ({ score: 80, state: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 3, ...o });
    const ack = (sock, event, payload) => new Promise((resolve) => sock.emit(event, payload, resolve));
    const connected = (sock) => new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('connect_error', reject); });
    const row = (name) => { const last = eduUpdates[eduUpdates.length - 1]; return last && last.students.find((r) => r.name === name); };
    const joinAs = async (name) => (await request(app).post('/api/extension/join').send({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${sfx}@pup.edu.ph`, classCode: cls.classCode, consent: true })).body;
    const studentSock = (j) => ioClient(url(), { transports: ['websocket'], reconnection: false, auth: { token: j.token } });

    beforeAll(async () => {
      cls = (await request(app).post('/api/classes').set('Cookie', eduCookie).send({ name: 'Telemetry 101' })).body.class;
      a = await joinAs('Tel A');
      b = await joinAs('Tel B');
      c = await joinAs('Tel C'); // only ever sends malformed heartbeats (the server limits heartbeats per socket, valid or not)

      eduSock = ioClient(url(), { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: eduCookie } });
      eduSock.on('class:update', (p) => eduUpdates.push(p));
      eduSock.on('class_detailed_telemetry', (p) => detailed.push(p));
      await connected(eduSock);
      expect((await ack(eduSock, 'educator:enterClass', { classId: cls.id })).ok).toBe(true);

      sockA = studentSock(a);
      sockA.on('student:self', (p) => selfA.push(p));
      sockA.on('class_average_update', (p) => averagesA.push(p));
      sockA.on('class:update', () => { leaks.classUpdate += 1; });
      sockA.on('class_detailed_telemetry', () => { leaks.detailed += 1; });
      sockB = studentSock(b);
      sockB.on('class_average_update', (p) => averagesB.push(p));
      sockB.on('class:update', () => { leaks.classUpdate += 1; });
      sockB.on('class_detailed_telemetry', () => { leaks.detailed += 1; });
      sockC = studentSock(c);
      await Promise.all([connected(sockA), connected(sockB), connected(sockC)]);
    });

    afterAll(() => { [eduSock, sockA, sockB, sockC].forEach((sock) => sock && sock.close()); });

    test('a heartbeat before joining a class, or a malformed one, is refused with a code the client can act on', async () => {
      expect(await ack(sockA, 'attention:heartbeat', { beats: [beat()] })).toMatchObject({ ok: false, code: 'not_joined' });
      for (const sock of [sockA, sockB, sockC]) expect((await ack(sock, 'join_class', cls.id)).ok).toBe(true);

      for (const bad of [{}, { beats: [] }, { beats: Array(6).fill(beat()) }, { beats: [beat({ state: 'Sleeping' })] },
        { beats: [beat({ score: 101 })] }, { beats: [beat({ score: -1 })] }, { beats: [beat({ score: '80' })] }, { beats: [beat({ isFocused: 'yes' })] }]) {
        expect(await ack(sockC, 'attention:heartbeat', bad)).toMatchObject({ ok: false, code: 'invalid' });
      }
      await waitFor(() => row('Tel C'));
      expect(row('Tel C')).toMatchObject({ online: true, focusScore: null, attentionState: null }); // nothing malformed was recorded
    });

    test('the first heartbeat sets the score exactly; the educator sees the full row, the student only their own row without identity', async () => {
      const res = await ack(sockA, 'attention:heartbeat', { beats: [beat({ score: 80 })] });
      expect(res).toMatchObject({ ok: true, accepted: 1, status: { focusScore: 80, attentionState: 'Focused', online: true, attentive: true } });
      expect(res.status.studentId).toBeUndefined();
      expect(res.status.name).toBeUndefined();

      await waitFor(() => row('Tel A') && row('Tel A').focusScore === 80);
      expect(row('Tel A')).toMatchObject({
        studentId: a.studentId, online: true, attentive: true, attentionState: 'Focused', location: 'meeting', isFocused: true,
        reasons: [], tabHidden: false, focusLossCount: 0, distractionCount: 0, trend: [80]
      });

      await waitFor(() => selfA.some((p) => p.status.focusScore === 80));
      const mine = selfA.find((p) => p.status.focusScore === 80);
      expect(mine.classId).toBe(cls.id);
      expect(mine.status.name).toBeUndefined();
      expect(mine.status.studentId).toBeUndefined();
    });

    test('the class average goes to everyone in the class; the per-student telemetry goes to the educator only', async () => {
      await waitFor(() => averagesA.some((p) => p.averageScore === 80) && averagesB.some((p) => p.averageScore === 80));
      expect(averagesA.find((p) => p.averageScore === 80)).toMatchObject({ classId: cls.id });
      await waitFor(() => detailed.some((p) => p.details.some((d) => d.studentId === a.studentId && d.score === 80 && d.status === 'active')));
    });

    test('later heartbeats are smoothed with a time-weighted EMA: a buffered batch (90 then 30, 10 s apart) lands exactly where the formula says', async () => {
      await sleep(1100); // the class aggregates are throttled to one per second
      const res = await ack(sockB, 'attention:heartbeat', { beats: [
        beat({ score: 90, ageMs: 20000 }),
        beat({ score: 30, state: 'Distracted', location: 'away', isFocused: false, ageMs: 10000 })
      ] });
      const expected = Math.round(90 + (1 - Math.exp(-10000 / 10000)) * (30 - 90)); // tau = 10 s -> 52
      expect(expected).toBe(52);
      expect(res).toMatchObject({ ok: true, accepted: 2, status: { focusScore: expected, attentionState: 'Distracted', attentive: false, tabHidden: true } });

      await waitFor(() => row('Tel B') && row('Tel B').focusScore === expected);
      expect(row('Tel B')).toMatchObject({ studentId: b.studentId, online: true, attentive: false, tabHidden: true, attentionState: 'Distracted', focusLossCount: 1, distractionCount: 1, trend: [90, expected] });
      expect(row('Tel B').reasons.join(' ')).toMatch(/Meeting tab not in focus \(focus score 52%\)/);
    });

    test('the class average is recalculated from every active student and broadcast again', async () => {
      const expected = Math.round((80 + 52) / 2);
      await waitFor(() => averagesA.some((p) => p.averageScore === expected) && averagesB.some((p) => p.averageScore === expected));
      await waitFor(() => detailed.some((p) => p.details.some((d) => d.studentId === b.studentId && d.score === 52)
        && p.details.some((d) => d.studentId === a.studentId && d.score === 80)));
    });

    test('a score that drops is moved toward, not jumped to (smoothing), and the focus loss is counted once', async () => {
      await sleep(1100);
      const res = await ack(sockA, 'attention:heartbeat', { beats: [beat({ score: 20, state: 'Distracted', location: 'away', isFocused: false })] });
      expect(res.ok).toBe(true);
      expect(res.status.focusScore).toBeGreaterThan(20);
      expect(res.status.focusScore).toBeLessThan(80);
      expect(res.status).toMatchObject({ attentionState: 'Distracted', focusLossCount: 1, distractionCount: 1 });
      await waitFor(() => row('Tel A') && row('Tel A').focusScore === res.status.focusScore);
      expect(row('Tel A').trend.length).toBeGreaterThanOrEqual(1);
    });

    test('a re-sent beat (lost acknowledgement) is acknowledged but never counted twice', async () => {
      await sleep(1100);
      const first = await ack(sockB, 'attention:heartbeat', { beats: [beat({ score: 70 })] });
      const again = await ack(sockB, 'attention:heartbeat', { beats: [beat({ score: 5 })] }); // < 500 ms later: a duplicate
      expect(first.accepted).toBe(1);
      expect(again).toMatchObject({ ok: true, accepted: 0 });
      expect(again.status.focusScore).toBe(first.status.focusScore);
    });

    test('students never receive class:update (educator rows) or the per-student telemetry', () => {
      expect(leaks).toEqual({ classUpdate: 0, detailed: 0 });
    });

    test('a client that floods heartbeats is told to slow down', async () => {
      const results = [];
      for (let i = 0; i < 14; i += 1) results.push(await ack(sockA, 'attention:heartbeat', { beats: [beat({ score: 60 })] }));
      expect(results.some((r) => r.ok === false && /Too many heartbeats/.test(r.error))).toBe(true);
    });
  });
});
