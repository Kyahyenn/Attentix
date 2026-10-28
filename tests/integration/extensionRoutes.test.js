/**
 * POST /api/extension/join: the whole student onboarding in one passwordless call
 *   { name, email, classCode, consent: true } -> a signed bearer token, a roster entry and a recorded consent.
 * The returned token then authenticates the student on every other route, with no cookie.
 */
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');
const { issueToken, issueStudentToken, TOKEN_TTL_MS } = require('../../src/utils/extensionToken');

const PASSWORD = 'Tr1cky-Horse-Battery';
const uid = () => crypto.randomBytes(4).toString('hex');
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('Extension API: passwordless join + bearer token', () => {
  let educator; let klass; let otherClass;
  const emailOf = (tag) => `${tag}_${uid()}@pup.edu.ph`;
  const join = (over = {}) => request(app).post('/api/extension/join').send({ name: 'Ana Cruz', email: emailOf('ana'), classCode: klass.classCode, consent: true, ...over });
  const roster = async (classId = klass.id) => (await db.readData('enrollments')).filter((e) => e.classId === classId);

  beforeAll(async () => {
    await db.initDb();
    educator = request.agent(app);
    const reg = await educator.post('/api/auth/educator/register').send({ name: 'Prof Reyes', email: emailOf('prof'), password: PASSWORD });
    expect(reg.status).toBe(201);
    klass = (await educator.post('/api/classes').send({ name: 'Math 101', section: 'A' })).body.class;
    otherClass = (await educator.post('/api/classes').send({ name: 'Physics 201' })).body.class;
  });

  describe('a student joins with name, email, class code and consent: no password', () => {
    test('201, a bearer token, the class details and a recorded consent', async () => {
      const email = emailOf('first');
      const res = await join({ email });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        message: 'Joined class', classId: klass.id, classCode: klass.classCode, className: 'Math 101', educatorName: 'Prof Reyes',
        student: { name: 'Ana Cruz', email }, user: { name: 'Ana Cruz', role: 'student' },
        class: { id: klass.id, classCode: klass.classCode, name: 'Math 101', className: 'Math 101', section: 'A', educatorName: 'Prof Reyes' },
        consent: { accepted: true }
      });
      expect(res.body.studentId).toBe(res.body.student.id);
      expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{10,1000}\.[A-Za-z0-9_-]{10,200}$/);
      expect(res.body.expiresAt).toBeGreaterThan(Date.now() + TOKEN_TTL_MS - 60000);
      expect(res.body.expiresAt).toBeLessThanOrEqual(Date.now() + TOKEN_TTL_MS);
      expect(res.headers['set-cookie']).toBeUndefined(); // the token is the credential, not a cookie
      expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/i);
    });

    test('the student is stored with no password, on the roster of exactly that class, with consent on file', async () => {
      const email = emailOf('stored');
      const { body } = await join({ email });

      const row = (await db.readData('users')).find((u) => u.id === body.studentId);
      expect(row).toMatchObject({ role: 'student', email, name: 'Ana Cruz', classId: klass.id });
      expect(row.password).toBeUndefined();
      expect(row.passwordHash).toBeUndefined();
      expect((await roster()).filter((e) => e.studentId === body.studentId)).toHaveLength(1);
      expect((await roster(otherClass.id)).some((e) => e.studentId === body.studentId)).toBe(false);
      const consent = (await db.readData('consents')).find((c) => c.userId === body.studentId);
      expect(consent).toMatchObject({ agreedToMonitoring: true, version: body.consent.version });
    });

    test('the token works on student routes with NO cookie, and never creates a cookie session', async () => {
      const email = emailOf('token');
      const { body } = await join({ name: 'Token Tina', email });
      const auth = bearer(body.token);

      const me = await request(app).get('/api/me').set(auth);
      expect(me.status).toBe(200);
      expect(me.body.user).toMatchObject({ role: 'student', email, name: 'Token Tina', classId: klass.id, classCode: klass.classCode });
      expect(me.headers['set-cookie']).toBeUndefined();

      const consent = await request(app).get('/api/consent-status').set(auth);
      expect(consent.status).toBe(200);
      expect(consent.body.accepted).toBe(true);

      const mine = await request(app).get('/api/student/classes').set(auth);
      expect(mine.body.classes).toEqual([{ id: klass.id, name: 'Math 101', section: 'A', educatorName: 'Prof Reyes' }]);
    });

    test('the class code is case-insensitive and padded spaces are ignored; the email is lower-cased', async () => {
      const res = await join({ email: `  MiXeD_${uid()}@PUP.edu.ph `, classCode: ` ${klass.classCode.toLowerCase()} ` });
      expect(res.status).toBe(201);
      expect(res.body.classId).toBe(klass.id);
      expect(res.body.student.email).toBe(res.body.student.email.toLowerCase());
      expect(res.body.student.email).toMatch(/^mixed_[0-9a-f]{8}@pup\.edu\.ph$/);
    });

    test('names are cleaned: markup characters and control characters are stripped', async () => {
      const res = await join({ name: '  <b>Ana</b>\u0007   Cruz ' });
      expect(res.status).toBe(201);
      expect(res.body.student.name).toBe('bAna/b Cruz');
    });
  });

  describe('joining again with the same email and class code', () => {
    test('keeps the SAME student record and roster entry: 200 "Welcome back", same studentId, still one enrolment', async () => {
      const email = emailOf('again');
      const first = await join({ email });
      const before = (await roster()).length;
      const second = await join({ email });
      const third = await join({ email: email.toUpperCase() });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.message).toBe('Welcome back');
      expect(second.body.studentId).toBe(first.body.studentId);
      expect(third.body.studentId).toBe(first.body.studentId); // the email's letter case does not matter
      expect(await roster()).toHaveLength(before);
      expect((await roster()).filter((e) => e.studentId === first.body.studentId)).toHaveLength(1);
      expect((await db.readData('users')).filter((u) => u.role === 'student' && u.email === email && u.classId === klass.id)).toHaveLength(1);
    });

    test('only the display name can change; the old token and the new one both keep working', async () => {
      const email = emailOf('rename');
      const first = await join({ name: 'Ana Cruz', email });
      const second = await join({ name: 'Ana Maria Cruz', email });

      expect(second.body.student.name).toBe('Ana Maria Cruz');
      const stored = (await db.readData('users')).find((u) => u.id === first.body.studentId);
      expect(stored).toMatchObject({ name: 'Ana Maria Cruz', legalName: 'Ana Maria Cruz', email, classId: klass.id });
      for (const t of [first.body.token, second.body.token]) {
        const me = await request(app).get('/api/me').set(bearer(t));
        expect(me.status).toBe(200);
        expect(me.body.user.name).toBe('Ana Maria Cruz'); // the server re-reads the student on every request
      }
    });

    test('concurrent joins of the same student still make exactly one record and one enrolment', async () => {
      const email = emailOf('race');
      const results = [];
      for (let round = 0; round < 2; round += 1) results.push(...await Promise.all(Array.from({ length: 5 }, () => join({ email }))));
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(results.map((r) => r.body.studentId)).size).toBe(1);
      const id = results[0].body.studentId;
      expect((await roster()).filter((e) => e.studentId === id)).toHaveLength(1);
    });

    test('re-joining after withdrawing consent records the new "yes" and the student is monitored-ready again', async () => {
      const email = emailOf('consent');
      const first = await join({ email });
      const decline = await request(app).post('/api/student/consent').set(bearer(first.body.token)).send({ decision: 'decline' });
      expect(decline.status).toBe(200);
      expect((await request(app).get('/api/consent-status').set(bearer(first.body.token))).body.accepted).toBe(false);

      const back = await join({ email });
      expect(back.body.consent.accepted).toBe(true);
      expect((await request(app).get('/api/consent-status').set(bearer(back.body.token))).body.accepted).toBe(true);
    });

    test('the same person in a DIFFERENT class is a separate student record, so history never leaks between classes', async () => {
      const email = emailOf('two');
      const a = await join({ email });
      const b = await join({ email, classCode: otherClass.classCode });

      expect(b.status).toBe(201);
      expect(b.body.studentId).not.toBe(a.body.studentId);
      expect(b.body.classId).toBe(otherClass.id);
      expect((await roster(klass.id)).some((e) => e.studentId === b.body.studentId)).toBe(false);
      expect((await roster(otherClass.id)).some((e) => e.studentId === a.body.studentId)).toBe(false);
      // each token is bound to its own class
      expect((await request(app).get('/api/me').set(bearer(a.body.token))).body.user.classId).toBe(klass.id);
      expect((await request(app).get('/api/me').set(bearer(b.body.token))).body.user.classId).toBe(otherClass.id);
    });

    test('students who re-join are listed once on the educator roster', async () => {
      const email = emailOf('roster');
      await join({ name: 'Roster Rita', email });
      await join({ name: 'Roster Rita', email });
      const list = (await educator.get('/api/educator/classes')).body.classes.find((c) => c.id === klass.id);
      const enrolled = (await roster()).length;
      expect(list.studentCount).toBe(enrolled);
      expect((await db.readData('users')).filter((u) => u.email === email)).toHaveLength(1);
    });
  });

  describe('bad requests', () => {
    test('an unknown class code is a 404 that does not reveal anything else, and nobody is created', async () => {
      const email = emailOf('nocode');
      const res = await join({ email, classCode: 'ZZZZZZ' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No class found for that class code/);
      expect(res.body.token).toBeUndefined();
      expect((await db.readData('users')).some((u) => u.email === email)).toBe(false);
    });

    test.each([
      ['too short', 'AB'],
      ['too long', 'ABCDEFGHJ'],
      ['punctuation', 'AB-CD!'],
      ['empty', '']
    ])('a malformed class code (%s) is a 400 on the classCode field', async (_label, classCode) => {
      const res = await join({ classCode });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].path[0]).toBe('classCode');
    });

    test.each([
      ['missing', undefined],
      ['false', false],
      ['the string "true"', 'true'],
      ['1', 1]
    ])('consent that is not the boolean true (%s) is a 400 and nothing is created', async (_label, consent) => {
      const email = emailOf('noconsent');
      const body = { name: 'Ana Cruz', email, classCode: klass.classCode };
      if (consent !== undefined) body.consent = consent;
      const res = await request(app).post('/api/extension/join').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].path[0]).toBe('consent');
      expect(res.body.message).toMatch(/agree to the privacy agreement/i);
      expect((await db.readData('users')).some((u) => u.email === email)).toBe(false);
    });

    test.each([
      ['name', { name: undefined }],
      ['name (only markup)', { name: '<>' }],
      ['email', { email: undefined }],
      ['email (invalid)', { email: 'not-an-email' }],
      ['classCode', { classCode: undefined }]
    ])('a missing or invalid %s is a 400', async (_label, over) => {
      const res = await join(over);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    test('a password in the body is rejected outright rather than silently ignored', async () => {
      for (const field of ['password', 'passwd', 'passcode']) {
        const res = await join({ email: emailOf('pw'), [field]: 'something-secret' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/without a password/i);
      }
    });

    test('a wrong class code is throttled per IP so codes cannot be brute-forced (successful joins do not count)', async () => {
      // A fresh app instance has its own, empty rate-limit window. 404s write nothing.
      jest.resetModules();
      const { app: freshApp } = require('../../src/app');
      const statuses = [];
      for (let i = 0; i < 62; i += 1) {
        statuses.push((await request(freshApp).post('/api/extension/join').send({ name: 'Guesser', email: 'guess@pup.edu.ph', classCode: 'ZZZZZZ', consent: true })).status);
      }
      expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
      expect(statuses[61]).toBe(429);
    });

    test('the old password login answers 410 and points at /api/extension/join', async () => {
      const res = await request(app).post('/api/extension/login').send({ username: 'a@b.co', password: PASSWORD });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ redirect: '/join.html', joinEndpoint: '/api/extension/join' });
      expect(res.body.error).toMatch(/no longer uses passwords/);
    });
  });

  describe('bearer-token authentication', () => {
    test('forged, garbage and valid-but-unknown-user tokens are rejected', async () => {
      expect((await request(app).get('/api/me').set('Authorization', 'Bearer abc.def')).status).toBe(401);
      expect((await request(app).get('/api/me').set('Authorization', 'Bearer ')).status).toBe(401);
      const ghost = await request(app).get('/api/me').set(bearer(issueToken('00000000-0000-4000-8000-000000000000')));
      expect(ghost.status).toBe(401);
    });

    test('a tampered token (changed payload, original signature) is rejected', async () => {
      const { body } = await join();
      const [payload, sig] = body.token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const forged = Buffer.from(JSON.stringify({ ...claims, classId: otherClass.id })).toString('base64url');
      expect((await request(app).get('/api/me').set(bearer(`${forged}.${sig}`))).status).toBe(401);
    });

    test('an expired token is rejected, a fresh join issues a working one', async () => {
      const { body } = await join();
      const student = (await db.readData('users')).find((u) => u.id === body.studentId);
      const expired = issueStudentToken(student, klass, Date.now() - TOKEN_TTL_MS - 1000);
      expect((await request(app).get('/api/me').set(bearer(expired))).status).toBe(401);
      expect((await request(app).get('/api/me').set(bearer(body.token))).status).toBe(200);
    });

    test('a token from the old password login (it carries no class) no longer works', async () => {
      const { body } = await join();
      expect((await request(app).get('/api/me').set(bearer(issueToken(body.studentId)))).status).toBe(401);
    });

    test('a token stops working the moment its student or class is deleted', async () => {
      const gone = await join();
      await db.mutate('users', (rows) => { rows.splice(rows.findIndex((u) => u.id === gone.body.studentId), 1); });
      expect((await request(app).get('/api/me').set(bearer(gone.body.token))).status).toBe(401);

      const temp = (await educator.post('/api/classes').send({ name: 'Short-lived Class' })).body.class;
      const inTemp = await join({ classCode: temp.classCode });
      expect((await request(app).get('/api/me').set(bearer(inTemp.body.token))).status).toBe(200);
      await db.mutate('classes', (rows) => { rows.splice(rows.findIndex((c) => c.id === temp.id), 1); });
      expect((await request(app).get('/api/me').set(bearer(inTemp.body.token))).status).toBe(401);
    });

    test('a bearer token never unlocks educator-only routes', async () => {
      const { body } = await join();
      const auth = bearer(body.token);
      expect((await request(app).post('/api/classes/create').set(auth).send({ className: 'Sneaky class' })).status).toBe(403);
      expect((await request(app).post('/api/classes').set(auth).send({ name: 'Sneaky class' })).status).toBe(403);
      expect((await request(app).get('/api/educator/classes').set(auth)).status).toBe(403);
      expect((await request(app).delete('/api/me').set(auth).send({ password: PASSWORD })).status).toBe(403);
    });

    test('requests without a bearer header use the normal cookie session (educators only)', async () => {
      expect((await educator.get('/api/me')).body.user.role).toBe('educator');
      expect((await request(app).get('/api/me')).status).toBe(401);
    });

    test('a student cannot read or erase another student: every student route is scoped to the token\'s own record', async () => {
      const a = await join({ name: 'Student A' });
      const b = await join({ name: 'Student B' });
      const lookupA = await request(app).post('/api/student/lookup').set(bearer(a.body.token)).send({});
      expect(lookupA.body.student).toMatchObject({ id: a.body.studentId, name: 'Student A' });
      // sending someone else's credentials in the body is ignored once a token is present
      const sneaky = await request(app).post('/api/student/lookup').set(bearer(a.body.token)).send({ email: b.body.student.email, classCode: klass.classCode });
      expect(sneaky.body.student.id).toBe(a.body.studentId);

      expect((await request(app).delete('/api/student/me').set(bearer(a.body.token))).status).toBe(200);
      expect((await db.readData('users')).some((u) => u.id === b.body.studentId)).toBe(true);
      expect((await request(app).get('/api/me').set(bearer(b.body.token))).status).toBe(200);
    });
  });
});
