/**
 * Replays what public/educator-dashboard.html and public/student.html do (same routes, same socket events) over real
 * HTTP + real sockets. The educator signs in with a cookie. Students have no account: they joined with name + email +
 * class code, and view their own dashboard either with the extension's bearer token or with name + email + class code.
 */
const http = require('http');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { Server } = require('socket.io');

const { app, sessionMiddleware } = require('../../src/app');
const db = require('../../src/config/db');
const socketHandler = require('../../src/socket/socketHandler');

const PASSWORD = 'Tr1cky-Horse-Battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('educator dashboard + passwordless student dashboard + extension, end to end', () => {
  let server, ioServer, port, educator, eduCookie, classInfo;
  const sockets = [];
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const connect = (opts) => {
    const s = ioClient(`http://localhost:${port}`, { transports: ['websocket'], ...opts });
    sockets.push(s);
    return s;
  };
  const emitAck = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
  const waitFor = async (fn, ms = 6000) => {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(50); }
  };
  // What join.html / the extension popup do: one passwordless call that returns a token.
  const joinStudent = async (name, classCode = classInfo.classCode) => {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${suffix}@pup.edu.ph`;
    const res = await request(app).post('/api/extension/join').send({ name, email, classCode, consent: true });
    expect(res.status).toBeLessThan(300);
    return { name, email, token: res.body.token, id: res.body.studentId };
  };
  // What student.js polls.
  const lookup = (s, how = 'token') => (how === 'token'
    ? request(app).post('/api/student/lookup').set(bearer(s.token)).send({})
    : request(app).post('/api/student/lookup').send({ name: s.name, email: s.email, classCode: classInfo.classCode }));

  beforeAll(async () => {
    await db.initDb();
    server = http.createServer(app);
    ioServer = new Server(server);
    ioServer.engine.use(sessionMiddleware);
    app.locals.realtime = socketHandler(ioServer);
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    educator = request.agent(app);
    const reg = await educator.post('/api/auth/educator/register').send({ name: 'Prof Eiyen', email: `edu_${suffix}@pup.edu.ph`, password: PASSWORD });
    expect(reg.status).toBe(201);
    eduCookie = cookieOf(reg);
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    ioServer.close();
    await new Promise((r) => server.close(r));
  });

  test('"Create Class" works and "Your Classes" lists it with its permanent class code', async () => {
    const created = await educator.post('/api/classes').send({ name: 'SAI 1', section: 'BSIT 3-5' });
    expect(created.status).toBe(201);
    expect(created.body.class.classCode).toMatch(/^[A-Z2-9]{6}$/);

    const list = await educator.get('/api/educator/classes');
    expect(list.status).toBe(200);
    classInfo = list.body.classes.find((c) => c.name === 'SAI 1');
    expect(classInfo).toMatchObject({ section: 'BSIT 3-5', educatorName: 'Prof Eiyen', classCode: created.body.class.classCode, studentCount: 0, activeCount: 0 });

    expect((await educator.post('/api/classes').send({ name: 'ab' })).status).toBe(400);
    expect((await request(app).post('/api/classes').send({ name: 'No Session' })).status).toBe(401);
  });

  test('classes created before class codes existed get a code when listed, and keep it', async () => {
    const me = await educator.get('/api/me');
    await db.insert('classes', { className: 'Legacy Class', educatorId: me.body.user.id });
    const list = await educator.get('/api/educator/classes');
    const legacy = list.body.classes.find((c) => c.name === 'Legacy Class');
    expect(legacy.classCode).toMatch(/^[A-Z2-9]{6}$/);
    expect((await educator.get('/api/educator/classes')).body.classes.find((c) => c.name === 'Legacy Class').classCode).toBe(legacy.classCode);
  });

  test('a student joins by code (any case, idempotent), appears in the educator count once, and sees their class', async () => {
    const email = `ana.${suffix}@pup.edu.ph`;
    for (let i = 0; i < 2; i += 1) {
      const join = await request(app).post('/api/extension/join').send({ name: 'Ana Cruz', email, classCode: classInfo.classCode.toLowerCase(), consent: true });
      expect(join.status).toBe(i === 0 ? 201 : 200);
      expect(join.body.classId).toBe(classInfo.id);
      if (i === 1) {
        const mine = await request(app).get('/api/student/classes').set(bearer(join.body.token));
        expect(mine.body.classes).toEqual([{ id: classInfo.id, name: 'SAI 1', section: 'BSIT 3-5', educatorName: 'Prof Eiyen' }]);
      }
    }
    expect((await educator.get('/api/educator/classes')).body.classes.find((c) => c.id === classInfo.id).studentCount).toBe(1);
  });

  describe('optional student web view (student.html): bearer token OR name + email + class code', () => {
    let s;
    beforeAll(async () => { s = await joinStudent('View Vera'); });

    test('with the extension\'s bearer token: their own student, class, consent and (before streaming) no live status', async () => {
      const res = await lookup(s, 'token');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        student: { id: s.id, name: 'View Vera', email: s.email },
        class: { id: classInfo.id, className: 'SAI 1', section: 'BSIT 3-5', classCode: classInfo.classCode, educatorName: 'Prof Eiyen' },
        consent: { accepted: true },
        status: null
      });
      expect(res.body.timestamp).toEqual(expect.any(Number));
    });

    test('with name + email + class code and no token: the very same view', async () => {
      const viaToken = (await lookup(s, 'token')).body;
      const viaCreds = await lookup(s, 'creds');
      expect(viaCreds.status).toBe(200);
      expect(viaCreds.body.student).toEqual(viaToken.student);
      expect(viaCreds.body.class).toEqual(viaToken.class);
      expect(viaCreds.body.consent.accepted).toBe(true);
    });

    test('email and class code are matched case-insensitively; the typed name is never used to match', async () => {
      const shouting = await request(app).post('/api/student/lookup').send({ name: 'Someone Else Entirely', email: s.email.toUpperCase(), classCode: classInfo.classCode.toLowerCase() });
      expect(shouting.status).toBe(200);
      expect(shouting.body.student.name).toBe('View Vera'); // the stored name, not the typed one
    });

    test('a wrong email, a wrong class code and another class\'s code all give the same 404 (nothing reveals who is enrolled)', async () => {
      const other = (await educator.post('/api/classes').send({ name: 'Other class' })).body.class;
      const attempts = await Promise.all([
        request(app).post('/api/student/lookup').send({ email: `nobody.${suffix}@pup.edu.ph`, classCode: classInfo.classCode }),
        request(app).post('/api/student/lookup').send({ email: s.email, classCode: 'ZZZZZZ' }),
        request(app).post('/api/student/lookup').send({ email: s.email, classCode: other.classCode })
      ]);
      attempts.forEach((r) => expect(r.status).toBe(404));
      expect(attempts[0].body).toEqual(attempts[1].body);
      expect(attempts[1].body).toEqual(attempts[2].body);
    });

    test('incomplete credentials are a 400 and no credentials at all are refused (the page asks for them)', async () => {
      expect((await request(app).post('/api/student/lookup').send({ email: s.email })).status).toBe(400);
      expect((await request(app).post('/api/student/lookup').send({ classCode: classInfo.classCode })).status).toBe(400);
      expect((await request(app).post('/api/student/lookup').send({})).status).toBe(400);
    });

    test('the lookup is read-only: it never creates a student, an enrolment or a consent', async () => {
      const email = `ghost.${suffix}@pup.edu.ph`;
      const before = { users: (await db.readData('users')).length, enrollments: (await db.readData('enrollments')).length, consents: (await db.readData('consents')).length };
      expect((await request(app).post('/api/student/lookup').send({ name: 'Ghost', email, classCode: classInfo.classCode })).status).toBe(404);
      expect({ users: (await db.readData('users')).length, enrollments: (await db.readData('enrollments')).length, consents: (await db.readData('consents')).length }).toEqual(before);
    });

    test('an educator cookie is not a student view: the lookup does not accept it as an identity', async () => {
      const res = await request(app).post('/api/student/lookup').set('Cookie', eduCookie).send({});
      expect(res.status).toBe(400);
    });

    test('GET /api/student/classes needs the student token; a cookie-less caller or an educator is refused', async () => {
      expect((await request(app).get('/api/student/classes')).status).toBe(401);
      expect((await request(app).get('/api/student/classes').set('Cookie', eduCookie)).status).toBe(403);
    });
  });

  test('live flow: a student (token socket) streams a heartbeat -> educator class:update row, the student\'s own row and the lookup agree', async () => {
    const s = await joinStudent('Beat Bea');
    const edu = connect({ extraHeaders: { cookie: eduCookie } });
    let latest = null;
    edu.on('class:update', (p) => { latest = p; });
    expect(await emitAck(edu, 'educator:enterClass', { classId: classInfo.id })).toEqual({ ok: true, classId: classInfo.id, className: 'SAI 1', educatorName: 'Prof Eiyen' });

    const ext = connect({ auth: { token: s.token } });
    const selfRows = [];
    ext.on('student:self', (p) => selfRows.push(p));
    expect(await emitAck(ext, 'join_class', classInfo.id)).toMatchObject({ ok: true, className: 'SAI 1', educatorName: 'Prof Eiyen' });
    const row = () => latest && latest.students.find((r) => r.name === 'Beat Bea');

    const ack = await emitAck(ext, 'attention:heartbeat', { beats: [{ score: 88, state: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 2 }] });
    expect(ack).toMatchObject({ ok: true, accepted: 1, status: { focusScore: 88, attentionState: 'Focused', online: true } });
    await waitFor(() => row() && row().focusScore === 88);
    expect(row()).toMatchObject({ online: true, attentive: true, attentionState: 'Focused', reasons: [], studentId: s.id });

    // the student sees exactly their own row, minus identifiers
    await waitFor(() => selfRows.some((p) => p.status.focusScore === 88));
    const mine = selfRows.find((p) => p.status.focusScore === 88).status;
    expect(mine.name).toBeUndefined();
    expect(mine.studentId).toBeUndefined();

    // and the page's polling lookup, by token or by name + email + class code, shows the same live row
    for (const how of ['token', 'creds']) {
      const res = await lookup(s, how);
      expect(res.body.status).toMatchObject({ online: true, focusScore: 88, attentionState: 'Focused' });
      expect(res.body.status.studentId).toBeUndefined();
      expect(res.body.status.name).toBeUndefined();
      expect(res.body.timestamp - res.body.status.lastActivityAt).toBeLessThan(20000); // "Active & Streaming"
    }
    expect((await educator.get('/api/educator/classes')).body.classes.find((c) => c.id === classInfo.id).activeCount).toBeGreaterThanOrEqual(1);

    ext.close();
    await waitFor(() => !row().online);
    expect(row()).toMatchObject({ online: false, attentive: false });
  }, 20000);

  test('live flow: student page activity -> educator class:update; prompt -> chat:prompt -> response', async () => {
    const s = await joinStudent('Chat Chloe');
    const edu = connect({ extraHeaders: { cookie: eduCookie } });
    let latest = null;
    edu.on('class:update', (p) => { latest = p; });
    await emitAck(edu, 'educator:enterClass', { classId: classInfo.id });

    const stu = connect({ auth: { token: s.token } });
    const prompts = [];
    stu.on('chat:prompt', (p) => prompts.push(p));
    expect(await emitAck(stu, 'student:enterClass', { classId: classInfo.id })).toMatchObject({ ok: true, className: 'SAI 1', educatorName: 'Prof Eiyen' });

    const row = () => latest && latest.students.find((r) => r.name === 'Chat Chloe');
    await waitFor(() => row() && row().online);
    expect(row()).toMatchObject({ online: true, attentive: true, reasons: [] });

    stu.emit('student:activity', { eventType: 'visibility-hidden', tabHidden: true });
    await waitFor(() => row().tabHidden);
    expect(row()).toMatchObject({ attentive: false, tabSwitchCount: 1 });
    expect(row().reasons.join(' ')).toMatch(/hidden or unfocused/);

    stu.emit('student:activity', { eventType: 'visibility-visible', tabHidden: false });
    await waitFor(() => !row().tabHidden);
    expect(row().attentive).toBe(true);

    expect(await emitAck(edu, 'educator:sendPrompt', { classId: classInfo.id, text: 'Are you still with me?' })).toEqual({ ok: true });
    await waitFor(() => prompts.length === 1);
    expect(prompts[0]).toEqual({ text: 'Are you still with me?' });
    expect(await emitAck(stu, 'student:chatResponse', { response: 'Yes!' })).toEqual({ ok: true });
    await waitFor(() => row().chatResponses === 1);

    stu.close();
    await waitFor(() => !row().online);
    expect(row()).toMatchObject({ online: false, attentive: false });
  }, 20000);

  test('students cannot use educator events, and strangers cannot open a class', async () => {
    const s = await joinStudent('Cat Cam');
    const stu = connect({ auth: { token: s.token } });
    expect((await emitAck(stu, 'educator:enterClass', { classId: classInfo.id })).ok).toBe(false);
    expect((await emitAck(stu, 'educator:sendPrompt', { classId: classInfo.id, text: 'hi' })).ok).toBe(false);

    const elsewhere = (await educator.post('/api/classes').send({ name: 'A class they never joined' })).body.class;
    expect((await emitAck(stu, 'student:enterClass', { classId: elsewhere.id })).error).toMatch(/not enrolled/i);

    const otherEducator = await request.agent(app).post('/api/auth/educator/register').send({ name: 'Other Prof', email: `edu2_${suffix}@pup.edu.ph`, password: PASSWORD });
    const edu2 = connect({ extraHeaders: { cookie: cookieOf(otherEducator) } });
    expect(await emitAck(edu2, 'educator:enterClass', { classId: classInfo.id })).toEqual({ ok: false, error: 'You do not teach this class' });
  });

  test('a Chrome-extension student (bearer token + focus scores) shows up in the same dashboard table', async () => {
    const s = await joinStudent('Student ext');
    const edu = connect({ extraHeaders: { cookie: eduCookie } });
    let latest = null;
    edu.on('class:update', (p) => { latest = p; });
    await emitAck(edu, 'educator:enterClass', { classId: classInfo.id });

    const ext = connect({ auth: { token: s.token } });
    expect((await emitAck(ext, 'join_class', classInfo.id)).ok).toBe(true);
    const row = () => latest && latest.students.find((r) => r.name === 'Student ext');

    ext.emit('attention_update', { focusScore: 95 });
    await waitFor(() => row() && row().focusScore === 95);
    expect(row()).toMatchObject({ online: true, attentive: true, tabHidden: false });

    await sleep(600);
    ext.emit('attention_update', { focusScore: 20 });
    await waitFor(() => row().focusScore === 20);
    expect(row()).toMatchObject({ attentive: false, tabHidden: true });
    expect(row().reasons.join(' ')).toMatch(/Meeting tab not in focus \(focus score 20%\)/);
  }, 20000);

  test('the educator removes a student: their token still identifies them but they can no longer enter the class', async () => {
    const s = await joinStudent('Removed Rex');
    expect((await educator.delete(`/api/classes/${classInfo.id}/students/${s.id}`)).status).toBe(200);
    const ext = connect({ auth: { token: s.token } });
    expect((await emitAck(ext, 'join_class', classInfo.id)).error).toMatch(/not enrolled/i);
    // they can come straight back by joining again: same record, same class code
    const back = await request(app).post('/api/extension/join').send({ name: 'Removed Rex', email: s.email, classCode: classInfo.classCode, consent: true });
    expect(back.body.studentId).toBe(s.id);
    const ext2 = connect({ auth: { token: back.body.token } });
    expect((await emitAck(ext2, 'join_class', classInfo.id)).ok).toBe(true);
  });
});
