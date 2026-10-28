/**
 * Proves the privacy/security protections end to end (real HTTP + real WebSockets) for the extension-first model:
 * educators use a cookie session, students hold only a revocable bearer token from the passwordless join.
 * Consent withdrawal, token revocation, removal, erasure and educator sign-out cut live sockets at once, class codes
 * cannot be bypassed, cross-site WebSockets are refused and flooding is capped.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');

const { app } = require('../../src/app');
const { sessionMiddleware } = require('../../src/app');
const settings = require('../../src/config/settings');
const db = require('../../src/config/db');
const createIo = require('../../src/socket/createIo');
const socketHandler = require('../../src/socket/socketHandler');
const engagement = require('../../src/state/engagementState');

const PASSWORD = 'Tr1cky-Horse-Battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('security & privacy controls, end to end', () => {
  let server, ioServer, port, educator, eduCookie, eduEmail, classInfo;
  const sockets = [];
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const connect = (opts) => {
    const s = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false, ...opts });
    sockets.push(s);
    return s;
  };
  const emitAck = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(40); }
  };
  const opened = (s) => new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });

  // A passwordless student: one call to /api/extension/join (consent included) returns the token everything else uses.
  const makeStudent = async (tag, { classCode } = {}) => {
    const email = `stu.${tag}.${suffix}@pup.edu.ph`;
    const res = await request(app).post('/api/extension/join').send({ name: `Student ${tag}`, email, classCode: classCode || classInfo.classCode, consent: true });
    expect(res.status).toBeLessThan(300);
    return { tag, name: `Student ${tag}`, email, id: res.body.studentId, token: res.body.token, auth: bearer(res.body.token) };
  };
  const tokenSocket = async (stu) => { const s = connect({ auth: { token: stu.token } }); await opened(s); return s; };
  const studentSocket = async (stu) => {
    const s = await tokenSocket(stu);
    const ack = await emitAck(s, 'student:enterClass', { classId: classInfo.id });
    expect(ack.ok).toBe(true);
    return s;
  };
  const decline = (stu) => request(app).post('/api/student/consent').set(stu.auth).send({ decision: 'decline' });

  beforeAll(async () => {
    await db.initDb();
    server = http.createServer(app);
    ioServer = createIo(server);
    ioServer.engine.use(sessionMiddleware);
    app.locals.realtime = socketHandler(ioServer);
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    educator = request.agent(app);
    eduEmail = `edu_${suffix}@pup.edu.ph`;
    const reg = await educator.post('/api/auth/educator/register').send({ name: 'Prof Sec', email: eduEmail, password: PASSWORD });
    eduCookie = cookieOf(reg);
    classInfo = (await educator.post('/api/classes').send({ name: 'Security 101' })).body.class;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    ioServer.close();
    await new Promise((r) => server.close(r));
  });

  describe('consent', () => {
    test('withdrawing consent disconnects the live socket immediately and removes the student from the dashboard', async () => {
      const stu = await makeStudent('withdraw');
      const edu = connect({ extraHeaders: { cookie: eduCookie } });
      await opened(edu);
      let latest = [];
      edu.on('class:update', (u) => { latest = u.students; });
      expect((await emitAck(edu, 'educator:enterClass', { classId: classInfo.id })).ok).toBe(true);

      const s = await studentSocket(stu);
      let reason = null;
      s.on('session:revoked', (p) => { reason = p.reason; });
      await waitFor(() => latest.some((r) => r.name === 'Student withdraw' && r.online));

      expect((await decline(stu)).status).toBe(200);

      await waitFor(() => s.disconnected);
      expect(reason).toMatch(/withdrew/i);
      await waitFor(() => !latest.some((r) => r.name === 'Student withdraw'));

      // ...and the server refuses to let them back in without a fresh "accept" (joining again is that accept).
      const s2 = await tokenSocket(stu);
      expect((await emitAck(s2, 'student:enterClass', { classId: classInfo.id })).error).toMatch(/consent/i);
      const again = await request(app).post('/api/extension/join').send({ name: stu.name, email: stu.email, classCode: classInfo.classCode, consent: true });
      expect(again.body.studentId).toBe(stu.id);
      const s3 = await tokenSocket({ token: again.body.token });
      expect((await emitAck(s3, 'student:enterClass', { classId: classInfo.id })).ok).toBe(true);
    });

    test('a student with no token can withdraw with email + class code, which also cuts the live sockets; a wrong email is a 404', async () => {
      const stu = await makeStudent('nocookie');
      const s = await studentSocket(stu);
      const bad = await request(app).post('/api/student/consent').send({ email: `nobody.${suffix}@pup.edu.ph`, classCode: classInfo.classCode, decision: 'decline' });
      expect(bad.status).toBe(404);
      expect(s.connected).toBe(true);

      const res = await request(app).post('/api/student/consent').send({ email: stu.email.toUpperCase(), classCode: classInfo.classCode.toLowerCase(), decision: 'decline' });
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(false);
      await waitFor(() => s.disconnected);
      expect((await request(app).get('/api/consent-status').set(stu.auth)).body.accepted).toBe(false);
    });

    test('an old consent record without the current version no longer counts (privacy text changed => ask again)', async () => {
      const stu = await makeStudent('oldconsent');
      await db.mutate('consents', (rows) => {
        const i = rows.findIndex((c) => c.userId === stu.id);
        rows.splice(i, 1, { id: 'legacy-1', userId: stu.id, agreedToMonitoring: true, timestamp: 1 }); // no `version`
      });
      expect((await request(app).get('/api/consent-status').set(stu.auth)).body.accepted).toBe(false);
      expect((await request(app).post('/api/student/lookup').set(stu.auth).send({})).body.consent.accepted).toBe(false);
      const s = await tokenSocket(stu);
      expect((await emitAck(s, 'student:enterClass', { classId: classInfo.id })).error).toMatch(/consent/i);
    });
  });

  describe('tokens and sign-out', () => {
    test('extension token revocation: logout invalidates every token and cuts the extension socket; joining again gives a working one', async () => {
      const stu = await makeStudent('ext');
      const token2 = (await request(app).post('/api/extension/join').send({ name: stu.name, email: stu.email, classCode: classInfo.classCode, consent: true })).body.token;
      expect((await request(app).get('/api/consent-status').set(stu.auth)).status).toBe(200);

      const s = await tokenSocket(stu);
      expect((await emitAck(s, 'join_class', classInfo.id)).ok).toBe(true);

      expect((await request(app).post('/api/extension/logout').set(stu.auth)).status).toBe(200);
      await waitFor(() => s.disconnected);
      expect((await request(app).get('/api/consent-status').set(stu.auth)).status).toBe(401);
      expect((await request(app).get('/api/consent-status').set(bearer(token2))).status).toBe(401); // every earlier token, not just this one

      // A fresh join gets a fresh, working token for the SAME student.
      const again = await request(app).post('/api/extension/join').send({ name: stu.name, email: stu.email, classCode: classInfo.classCode, consent: true });
      expect(again.body.studentId).toBe(stu.id);
      expect((await request(app).get('/api/consent-status').set(bearer(again.body.token))).status).toBe(200);
    });

    test('signing an educator out ends the sockets opened with that session, and the session cookie stops working', async () => {
      const login = await request(app).post('/api/auth/login').send({ email: eduEmail, password: PASSWORD });
      const cookie = cookieOf(login);
      const s = connect({ extraHeaders: { cookie } });
      await opened(s);
      expect((await emitAck(s, 'educator:enterClass', { classId: classInfo.id })).ok).toBe(true);
      expect((await request(app).post('/api/logout').set('Cookie', cookie)).status).toBe(200);
      await waitFor(() => s.disconnected);
      expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(401);
    });

    test('a student token is never an educator: no educator routes and no educator socket events', async () => {
      const stu = await makeStudent('notedu');
      expect((await request(app).get('/api/educator/classes').set(stu.auth)).status).toBe(403);
      expect((await request(app).delete('/api/me').set(stu.auth).send({ password: PASSWORD })).status).toBe(403);
      const s = await tokenSocket(stu);
      expect((await emitAck(s, 'educator:enterClass', { classId: classInfo.id })).ok).toBe(false);
      expect((await emitAck(s, 'educator:sendPrompt', { classId: classInfo.id, text: 'hi' })).ok).toBe(false);
    });

    // Known bug found while writing these tests (src/routes/authRoutes.js): a bearer "session" is a plain object with no
    // destroy(), so POST /api/logout with a student token throws and answers 500. No shipped page calls it that way
    // (students sign out with POST /api/extension/logout), so it is recorded here instead of being asserted as correct.
    test.todo('POST /api/logout with a student bearer token should not answer 500');
  });

  describe('class access', () => {
    test('students are shown exactly their own row, live (student:self), never other students', async () => {
      const stu = await makeStudent('self');
      const other = await makeStudent('self.other');
      const s = await tokenSocket(stu);
      const seen = [];
      s.on('student:self', (p) => seen.push(p));
      await emitAck(s, 'student:enterClass', { classId: classInfo.id });
      const o = await studentSocket(other);
      await waitFor(() => seen.length > 0);
      await waitFor(() => engagement.snapshot(classInfo.id).filter((r) => r.online).length >= 2);
      seen.forEach((p) => {
        expect(p.status).toEqual(expect.objectContaining({ online: true }));
        expect(p.status.name).toBeUndefined();
        expect(p.status.studentId).toBeUndefined();
        expect(p).not.toHaveProperty('students');
      });
      o.close();
    });

    test('a student token only opens the class it joined: knowing another class id (or its listing) is not enough', async () => {
      const stu = await makeStudent('enroll');
      const second = (await educator.post('/api/classes').send({ name: 'Second Security Class' })).body.class;
      const s = await tokenSocket(stu);
      expect((await emitAck(s, 'join_class', second.id)).error).toMatch(/not enrolled/i);
      expect((await emitAck(s, 'student:enterClass', { classId: second.id })).error).toMatch(/not enrolled/i);
      expect((await request(app).post('/api/classes/enroll').set(stu.auth).send({ classId: second.id, code: second.classCode })).status).toBe(410);
      expect((await request(app).post('/api/classes/join').set(stu.auth).send({ code: second.classCode })).status).toBe(410);
      expect((await db.readData('enrollments')).some((e) => e.classId === second.id && e.studentId === stu.id)).toBe(false);
    });

    test('students never receive other people\'s ids or other classes from my-classes', async () => {
      const stu = await makeStudent('myclasses');
      const res = await request(app).get('/api/classes/my-classes').set(stu.auth);
      expect(res.status).toBe(200);
      expect(res.body.classes.map((c) => c.id)).toEqual([classInfo.id]);
      expect(res.body.classes[0].educatorId).toBeUndefined();
      expect(res.body.classes[0].classCode).toBeUndefined();
    });

    test('the class code is permanent: the rotate endpoint is gone, so the code students hold never stops working', async () => {
      const other = request.agent(app);
      await other.post('/api/auth/educator/register').send({ name: 'Other', email: `edu2_${suffix}@pup.edu.ph`, password: PASSWORD });
      expect((await other.post(`/api/classes/${classInfo.id}/rotate-code`)).status).toBe(410);
      expect((await educator.post(`/api/classes/${classInfo.id}/rotate-code`)).status).toBe(410);

      const stu = await makeStudent('afterrotate');
      expect((await request(app).post('/api/student/lookup').send({ email: stu.email, classCode: classInfo.classCode })).status).toBe(200);
      expect((await educator.get('/api/educator/classes')).body.classes.find((c) => c.id === classInfo.id).classCode).toBe(classInfo.classCode);
    });

    test('an educator can remove a student, which stops their monitoring at once; a student can also leave', async () => {
      const a = await makeStudent('removeme');
      const sa = await studentSocket(a);
      const removal = await educator.delete(`/api/classes/${classInfo.id}/students/${a.id}`);
      expect(removal.status).toBe(200);
      await waitFor(() => sa.disconnected);
      expect((await emitAck(await tokenSocket(a), 'student:enterClass', { classId: classInfo.id })).error).toMatch(/not enrolled/i);

      const b = await makeStudent('leaver');
      const sb = await studentSocket(b);
      expect((await request(app).post('/api/classes/leave').set(b.auth).send({ classId: classInfo.id })).status).toBe(200);
      await waitFor(() => sb.disconnected);
    });

    test('only the educator who owns a class can remove its students', async () => {
      const stu = await makeStudent('protected');
      const other = request.agent(app);
      await other.post('/api/auth/educator/register').send({ name: 'Intruder', email: `edu3_${suffix}@pup.edu.ph`, password: PASSWORD });
      expect((await other.delete(`/api/classes/${classInfo.id}/students/${stu.id}`)).status).toBe(404);
      expect((await request(app).delete(`/api/classes/${classInfo.id}/students/${stu.id}`).set(stu.auth)).status).toBe(403);
      expect((await db.readData('enrollments')).some((e) => e.classId === classInfo.id && e.studentId === stu.id)).toBe(true);
    });
  });

  describe('erasure', () => {
    test('a student erases their data: record, enrolment and consent go, sockets are cut, the token dies, and they may join again as new', async () => {
      const stu = await makeStudent('erase');
      const s = await studentSocket(stu);

      expect((await request(app).delete('/api/student/me')).status).toBe(401);
      expect((await request(app).delete('/api/student/me').set('Cookie', eduCookie)).status).toBe(403); // an educator session is not a student
      expect(s.connected).toBe(true);

      expect((await request(app).delete('/api/student/me').set(stu.auth)).status).toBe(200);
      await waitFor(() => s.disconnected);
      expect((await request(app).get('/api/me').set(stu.auth)).status).toBe(401);
      expect((await db.readData('users')).some((u) => u.id === stu.id)).toBe(false);
      expect((await db.readData('consents')).some((c) => c.userId === stu.id)).toBe(false);
      expect((await db.readData('enrollments')).some((e) => e.studentId === stu.id)).toBe(false);
      expect(engagement.snapshot(classInfo.id).some((r) => r.studentId === stu.id)).toBe(false);

      const back = await request(app).post('/api/extension/join').send({ name: stu.name, email: stu.email, classCode: classInfo.classCode, consent: true });
      expect(back.status).toBe(201);
      expect(back.body.studentId).not.toBe(stu.id);
    });

    test('an educator deleting their account needs the password, then erases their classes, students and sockets', async () => {
      const prof = request.agent(app);
      const email = `edu_del_${suffix}@pup.edu.ph`;
      await prof.post('/api/auth/educator/register').send({ name: 'Prof Delete', email, password: PASSWORD });
      const doomed = (await prof.post('/api/classes').send({ name: 'Doomed Class' })).body.class;
      const stu = await makeStudent('doomed', { classCode: doomed.classCode });
      const s = connect({ auth: { token: stu.token } });
      await opened(s);
      expect((await emitAck(s, 'student:enterClass', { classId: doomed.id })).ok).toBe(true);

      expect((await prof.delete('/api/me').send({ password: 'not-the-password' })).status).toBe(401);
      expect(s.connected).toBe(true);
      expect((await prof.delete('/api/me').send({ password: PASSWORD })).status).toBe(200);

      await waitFor(() => s.disconnected);
      expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
      expect((await request(app).get('/api/me').set(stu.auth)).status).toBe(401); // the class is gone, so the token is too
      expect((await db.readData('classes')).some((c) => c.id === doomed.id)).toBe(false);
      expect((await db.readData('users')).some((u) => u.id === stu.id)).toBe(false);
      expect((await db.readData('consents')).some((c) => c.userId === stu.id)).toBe(false);
      expect((await db.readData('enrollments')).some((e) => e.classId === doomed.id)).toBe(false);
    });
  });

  describe('socket hardening', () => {
    test('cross-site WebSocket handshakes are refused, the extension origin and same origin are allowed', async () => {
      const stu = await makeStudent('origin');
      const evil = connect({ auth: { token: stu.token }, extraHeaders: { origin: 'https://evil.example' } });
      await expect(opened(evil)).rejects.toBeTruthy();

      const ext = connect({ auth: { token: stu.token }, extraHeaders: { origin: 'chrome-extension://abcdefghijklmnop' } });
      await opened(ext);
      const same = connect({ auth: { token: stu.token }, extraHeaders: { origin: `http://localhost:${port}` } });
      await opened(same);
    });

    test('a socket with no token and no session, or a bad token, is refused at the handshake', async () => {
      await expect(opened(connect({}))).rejects.toThrow(/Authentication required/i);
      await expect(opened(connect({ auth: { token: 'forged.token' } }))).rejects.toThrow(/Authentication required/i);
    });

    test('a user cannot hold more than the allowed number of sockets', async () => {
      const stu = await makeStudent('cap');
      for (let i = 0; i < settings.maxSocketsPerUser; i += 1) await opened(connect({ auth: { token: stu.token } }));
      await expect(opened(connect({ auth: { token: stu.token } }))).rejects.toThrow(/Too many/i);
    });

    test('activity events outside the allow-list are ignored (only the valid one is recorded)', async () => {
      const stu = await makeStudent('badevent');
      const s = await studentSocket(stu);
      const spy = jest.spyOn(engagement, 'recordActivity');
      s.emit('student:activity', { eventType: 'x'.repeat(30), tabHidden: false });
      s.emit('student:activity', { eventType: '<script>', tabHidden: false });
      s.emit('student:activity', { eventType: 'keydown', tabHidden: false });
      await waitFor(() => spy.mock.calls.length >= 1);
      await sleep(100);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toBe('keydown');
      spy.mockRestore();
    });

    test('oversized socket messages are rejected by the transport (16 KB cap)', async () => {
      const stu = await makeStudent('big');
      const s = await studentSocket(stu);
      s.emit('student:activity', { eventType: 'keydown', tabHidden: false, junk: 'x'.repeat(40 * 1024) });
      await waitFor(() => s.disconnected);
    });

    test('educator can reset live class data without disconnecting students; a student cannot call it', async () => {
      const stu = await makeStudent('reset');
      const s = await studentSocket(stu);
      const edu = connect({ extraHeaders: { cookie: eduCookie } });
      await opened(edu);
      await emitAck(edu, 'educator:enterClass', { classId: classInfo.id });
      s.emit('extension:event', { type: 'tab-switch' });
      expect((await emitAck(edu, 'educator:resetClass', { classId: classInfo.id })).ok).toBe(true);
      expect(s.connected).toBe(true);
      expect((await emitAck(s, 'educator:resetClass', { classId: classInfo.id })).ok).toBe(false);
    });
  });

  describe('accounts and data at rest', () => {
    test('educator passwords: weak and over-long multi-byte ones are refused', async () => {
      const weak = await request(app).post('/api/auth/educator/register').send({ name: 'Weak', email: `weak_${suffix}@pup.edu.ph`, password: 'password123' });
      expect(weak.status).toBe(400);
      const long = await request(app).post('/api/auth/educator/register').send({ name: 'Long', email: `long_${suffix}@pup.edu.ph`, password: 'é'.repeat(40) });
      expect(long.status).toBe(400);
    });

    test('repeated wrong passwords for ONE educator account are throttled even though the IP limit is not reached', async () => {
      const email = `victim_${suffix}@pup.edu.ph`;
      await request(app).post('/api/auth/educator/register').send({ name: 'Victim', email, password: PASSWORD });
      let last;
      for (let i = 0; i < 21; i += 1) last = await request(app).post('/api/login').send({ email, password: 'wrong-password-1' });
      expect(last.status).toBe(429);
    });

    test('students have no password anywhere: the stored student rows carry no credential of any kind', async () => {
      const users = (await db.readData('users')).filter((u) => u.role === 'student' && u.classId === classInfo.id);
      expect(users.length).toBeGreaterThan(5);
      users.forEach((u) => expect(Object.keys(u).filter((k) => /pass|hash|secret|token(?!Version)/i.test(k))).toEqual([]));
    });

    test('database: a failed write leaves memory and disk untouched; data files are owner-only', async () => {
      const before = JSON.stringify(await db.readData('classes'));
      await expect(db.mutate('classes', (rows) => { rows.length = 0; throw new Error('boom'); })).rejects.toThrow('boom');
      expect(JSON.stringify(await db.readData('classes'))).toBe(before);

      const inserted = await db.insert('classes', { id: 'attacker-chosen', createdAt: 1, className: 'x', educatorId: 'e' });
      expect(inserted.id).not.toBe('attacker-chosen'); // callers cannot choose the id
      if (process.platform !== 'win32') {
        const mode = fs.statSync(path.join(settings.dataDir, 'users.json')).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });
});
