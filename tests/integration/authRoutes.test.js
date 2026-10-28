/**
 * Educator-only accounts. Educators self-register with name + email + password (no professor / invite code) and sign in
 * with a cookie session. Students have no account: the old student register / password-login paths answer 410.
 * (Passwordless student joining is covered in extensionRoutes.test.js.)
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../../src/app');
const db = require('../../src/config/db');

const PASSWORD = 'Tr1cky-Horse-Battery';
const sfx = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const mail = (tag) => `${tag}_${sfx}@pup.edu.ph`;
const agent = () => request(app);

describe('Educator registration (no professor code)', () => {
  const email = mail('prof.main');

  beforeAll(() => db.initDb());

  test('POST /api/auth/educator/register succeeds with only name, email and password, and signs the educator in', async () => {
    const res = await agent().post('/api/auth/educator/register').send({ name: 'Prof Main', email, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'educator', name: 'Prof Main', username: email });
    expect(res.body.user).toHaveProperty('id');
    expect(res.body.user).not.toHaveProperty('password'); // only the boolean `hasPassword` is exposed, never the hash
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);

    const me = await agent().get('/api/me').set('Cookie', res.headers['set-cookie']);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('educator');
  });

  test('the stored record is an educator with a bcrypt hash, and carries no professor / invite code', async () => {
    const stored = (await db.readData('users')).find((u) => u.email === email);
    expect(stored.role).toBe('educator');
    expect(stored.password).toMatch(/^\$2[aby]\$/);
    expect(stored.password).not.toBe(PASSWORD);
    expect(Object.keys(stored).filter((k) => /code/i.test(k))).toEqual([]);
  });

  test.each([
    ['name', { email: mail('noname'), password: PASSWORD }],
    ['email', { name: 'No Email', password: PASSWORD }],
    ['password', { name: 'No Password', email: mail('nopw') }]
  ])('a missing %s is a 400 Validation failed that names the field', async (field, body) => {
    const res = await agent().post('/api/auth/educator/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details[0].path[0]).toBe(field);
    expect(res.body.message).toMatch(new RegExp(`^${field}:`));
  });

  test('weak, over-long multi-byte and common passwords are refused and nothing is created', async () => {
    const weak = await agent().post('/api/auth/educator/register').send({ name: 'Weak Pw', email: mail('weak'), password: 'password123' });
    expect(weak.status).toBe(400);
    expect(weak.body.message).toMatch(/too common/i);
    const long = await agent().post('/api/auth/educator/register').send({ name: 'Long Pw', email: mail('long'), password: 'é'.repeat(40) });
    expect(long.status).toBe(400);
    expect((await db.readData('users')).some((u) => u.email === mail('weak') || u.email === mail('long'))).toBe(false);
  });

  test('a second registration with the same email (any letter case) is a 409 and the first account survives', async () => {
    const res = await agent().post('/api/auth/educator/register').send({ name: 'Copycat', email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect((await db.readData('users')).filter((u) => u.email === email)).toHaveLength(1);
  });
});

describe('Student accounts are gone', () => {
  test.each(['/api/register', '/api/auth/register'])('POST %s answers 410 and points at the passwordless join endpoint', async (url) => {
    const res = await agent().post(url).send({ username: mail('stu'), password: PASSWORD, role: 'student', legalName: 'Stu Dent' });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ redirect: '/join.html', joinEndpoint: '/api/extension/join' });
    expect((await db.readData('users')).some((u) => u.legalName === 'Stu Dent')).toBe(false);
  });

  test('a leftover student record: the right old password gets a 410 pointer to /join.html, a wrong one a generic 401', async () => {
    const email = mail('legacy.student');
    await db.insert('users', { email, username: email, name: 'Old Student', role: 'student', password: await bcrypt.hash(PASSWORD, 4) });

    const right = await agent().post('/api/auth/login').send({ email, password: PASSWORD });
    expect(right.status).toBe(410);
    expect(right.body.redirect).toBe('/join.html');
    expect(right.headers['set-cookie']).toBeUndefined();

    const wrong = await agent().post('/api/auth/login').send({ email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('Invalid credentials');
  });

  test('legacy records without a password field give 401, not 500', async () => {
    const email = mail('legacy.nopw');
    await db.insert('users', { email, name: 'Legacy', role: 'student' });
    const res = await agent().post('/api/auth/login').send({ email, password: 'whatever123' });
    expect(res.status).toBe(401);
  });
});

describe('Educator sign-in, session and erasure', () => {
  const email = mail('prof.login');
  let cookie;

  beforeAll(async () => {
    await db.initDb();
    await db.insert('users', { email, username: email, name: 'Prof Login', legalName: 'Prof Login', role: 'educator', password: await bcrypt.hash(PASSWORD, 4) });
  });

  test('POST /api/auth/login (and the /api/login alias) sign an educator in with email + password', async () => {
    for (const url of ['/api/auth/login', '/api/login']) {
      const res = await agent().post(url).send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ role: 'educator', name: 'Prof Login' });
      expect(res.headers['set-cookie'][0]).toMatch(/attention\.sid=.*HttpOnly/i);
      cookie = res.headers['set-cookie'];
    }
  });

  test('missing fields trigger Zod validation errors', async () => {
    const res = await agent().post('/api/auth/login').send({ email });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details[0].path[0]).toBe('password');
  });

  test('wrong password and unknown email get the same generic 401', async () => {
    const wrong = await agent().post('/api/auth/login').send({ email, password: 'not-the-password' });
    const unknown = await agent().post('/api/auth/login').send({ email: mail('nobody'), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test('an educator created before emails were required still signs in with their plain username', async () => {
    await db.insert('users', { username: 'oldprof', name: 'Old Prof', legalName: 'Old Prof', role: 'educator', password: await bcrypt.hash(PASSWORD, 4) });
    const res = await agent().post('/api/auth/login').send({ username: 'oldprof', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('educator');
  });

  test('GET /api/me needs the session; logout ends it', async () => {
    expect((await agent().get('/api/me')).status).toBe(401);
    expect((await agent().get('/api/me').set('Cookie', cookie)).status).toBe(200);
    expect((await agent().post('/api/logout').set('Cookie', cookie)).status).toBe(200);
    expect((await agent().get('/api/me').set('Cookie', cookie)).status).toBe(401);
  });

  test('DELETE /api/me needs the right password and then removes the educator and their classes', async () => {
    const login = await agent().post('/api/auth/login').send({ email, password: PASSWORD });
    const session = login.headers['set-cookie'];
    const klass = await agent().post('/api/classes').set('Cookie', session).send({ name: 'Doomed Class' });
    expect(klass.status).toBe(201);

    expect((await agent().delete('/api/me').set('Cookie', session).send({ password: 'not-the-password' })).status).toBe(401);
    expect((await agent().delete('/api/me').set('Cookie', session).send({ password: PASSWORD })).status).toBe(200);

    expect((await agent().post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await db.readData('classes')).some((c) => c.id === klass.body.classId)).toBe(false);
  });
});

describe('Auth hardening regressions', () => {
  test('unknown API route returns JSON 404 and malformed JSON returns JSON 400', async () => {
    const notFound = await agent().get('/api/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toBe('Not found');

    const bad = await agent().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Malformed JSON body');
  });

  test('CSP forbids inline scripts and third-party script hosts', async () => {
    const res = await agent().get('/login.html');
    const csp = res.headers['content-security-policy'];
    const scriptSrc = csp.split(';').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/jsdelivr/);
  });

  test('self-hosted Chart.js is served and compressed assets are cacheable', async () => {
    const res = await agent().get('/vendor/chart.umd.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toMatch(/max-age/);
  });

  test('API responses are never cached', async () => {
    const res = await agent().get('/api/me');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('cross-origin state-changing requests with a cookie session are rejected', async () => {
    const res = await agent().post('/api/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'b' });
    expect(res.status).toBe(403);
  });

  test('the extension popup (chrome-extension:// origin) may reach /api/extension/* but nothing else', async () => {
    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const join = await agent().post('/api/extension/join').set('Origin', ext)
      .send({ name: 'Ana Cruz', email: 'ana@pup.edu.ph', classCode: 'ZZZZZZ', consent: true });
    expect(join.status).toBe(404); // reached the route (unknown class code), not blocked by the origin guard
    const other = await agent().post('/api/login').set('Origin', ext).send({ email: 'a@b.co', password: 'b' });
    expect(other.status).toBe(403);
  });

  test('/healthz answers without authentication', async () => {
    const res = await agent().get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
