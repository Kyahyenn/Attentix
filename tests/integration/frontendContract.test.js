/** The exact requests the Phase 3 pages make, against the real Express app: if the pages and the API drift, this fails. */
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');
const engagement = require('../../src/state/engagementState');

describe('Phase 3 frontend <-> API contract', () => {
  beforeAll(() => db.initDb());
  const email = `prof_${Date.now()}@school.edu`;
  const agent = request.agent(app);
  let klass;
  let token;

  test('educator-signup.js: { name, email, password } (no invite code) creates an educator and signs in', async () => {
    const res = await agent.post('/api/auth/educator/register').send({ name: 'Prof Reyes', email, password: 'a-long-password-1' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('educator');
  });

  test('login.js: { email, password } signs the educator in; /api/me confirms the role', async () => {
    const login = await request(app).post('/api/login').send({ email, password: 'a-long-password-1' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('educator');
    expect((await agent.get('/api/me')).body.user.name).toBe('Prof Reyes');
  });

  test('educator.js: create class, list it with a permanent classCode, rotating is gone', async () => {
    const created = await agent.post('/api/classes').send({ name: 'Math 101', section: 'A' });
    expect(created.status).toBe(201);
    const list = await agent.get('/api/educator/classes');
    klass = list.body.classes[0];
    expect(klass).toEqual(expect.objectContaining({ id: expect.any(String), name: 'Math 101', section: 'A', educatorName: 'Prof Reyes', classCode: expect.stringMatching(/^[A-Z0-9]{6}$/), studentCount: 0, activeCount: 0 }));
    expect((await agent.post(`/api/classes/${klass.id}/rotate-code`)).status).toBe(410);
    expect((await agent.get('/api/educator/classes')).body.classes[0].classCode).toBe(klass.classCode);
  });

  test('join.js: { name, email, classCode, consent:true } returns a token and class details; wrong code is a 404', async () => {
    const bad = await request(app).post('/api/extension/join').send({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: 'ZZZZZZ', consent: true });
    expect(bad.status).toBe(404);
    const noConsent = await request(app).post('/api/extension/join').send({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: klass.classCode });
    expect(noConsent.status).toBe(400);
    const res = await request(app).post('/api/extension/join').send({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: klass.classCode.toLowerCase(), consent: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ token: expect.any(String), expiresAt: expect.any(Number), className: 'Math 101', educatorName: 'Prof Reyes', message: 'Joined class' }));
    token = res.body.token;
    // the token has the shape common.js accepts
    expect(token).toMatch(/^[A-Za-z0-9_-]{10,1000}\.[A-Za-z0-9_-]{10,200}$/);
  });

  test('student.js / privacy.js: lookup works with the bearer token AND with name+email+classCode, with the fields the page reads', async () => {
    const withToken = await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({});
    expect(withToken.status).toBe(200);
    expect(withToken.body).toEqual(expect.objectContaining({
      student: expect.objectContaining({ name: 'Ana Cruz' }),
      class: expect.objectContaining({ id: klass.id, className: 'Math 101', section: 'A', classCode: klass.classCode, educatorName: 'Prof Reyes' }),
      consent: expect.objectContaining({ accepted: true }),
      timestamp: expect.any(Number)
    }));
    expect(withToken.body.status).toBeNull(); // joined but the extension has not streamed yet -> "Extension Offline"

    const withCreds = await request(app).post('/api/student/lookup').send({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: klass.classCode });
    expect(withCreds.status).toBe(200);
    const unknown = await request(app).post('/api/student/lookup').send({ name: 'X Y', email: 'nobody@school.edu', classCode: klass.classCode });
    expect(unknown.status).toBe(404);
  });

  test('a streamed heartbeat appears in the lookup row the dashboard renders (score, state, focus losses, fresh timestamp)', async () => {
    // The REST heartbeat needs the socket layer (bound by src/index.js, not by app.js alone), so feed the same state it feeds.
    const me = (await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({})).body.student;
    expect(engagement.recordHeartbeats(klass.id, { id: me.id, name: me.name }, [{ score: 72, state: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 2 }], Date.now(), { rest: true })).toBe(1);
    const res = await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({});
    const s = res.body.status;
    expect(s).toEqual(expect.objectContaining({ online: true, focusScore: 72, attentionState: 'Focused', focusLossCount: 0 }));
    expect(res.body.timestamp - s.lastActivityAt).toBeLessThan(20000); // what student.js treats as "Active & Streaming"
    expect(s.studentId).toBeUndefined(); // students never see ids
  });

  test('privacy.js: consent decline / accept with a token or with email + classCode', async () => {
    const decline = await request(app).post('/api/student/consent').set('Authorization', `Bearer ${token}`).send({ decision: 'decline' });
    expect(decline.status).toBe(200);
    expect((await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({})).body.consent.accepted).toBe(false);
    const accept = await request(app).post('/api/student/consent').send({ email: 'ana@school.edu', classCode: klass.classCode, decision: 'accept' });
    expect(accept.status).toBe(200);
    expect((await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({})).body.consent.accepted).toBe(true);
  });

  test('educator class:update source: the row carries every field the roster uses', async () => {
    const students = engagement.snapshot(klass.id);
    expect(students[0]).toEqual(expect.objectContaining({ studentId: expect.any(String), name: 'Ana Cruz', online: true, attentive: true, focusScore: 72, attentionState: 'Focused', focusLossCount: 0, tabSwitchCount: 0, mouseIdleMs: expect.anything(), reasons: [] }));
  });

  test('student.js: leave class and delete data work with the token alone', async () => {
    expect((await request(app).post('/api/classes/leave').set('Authorization', `Bearer ${token}`).send({ classId: klass.id })).status).toBe(200);
    expect((await request(app).delete('/api/student/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).post('/api/student/lookup').set('Authorization', `Bearer ${token}`).send({})).status).toBe(401);
  });

  test('a student token never works as an educator, and educator login with a student email fails generically', async () => {
    const j = await request(app).post('/api/extension/join').send({ name: 'Ben Lim', email: 'ben@school.edu', classCode: klass.classCode, consent: true });
    const t = j.body.token;
    expect((await request(app).get('/api/educator/classes').set('Authorization', `Bearer ${t}`)).status).toBe(403);
    expect((await request(app).post('/api/login').send({ email: 'ben@school.edu', password: 'whatever-123' })).status).toBe(401);
  });
});
