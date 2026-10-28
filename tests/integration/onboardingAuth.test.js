/**
 * Onboarding end to end. Educators (the self-hosting professor) register with name + email + password and NO professor /
 * invite code; students never register at all (they join a class with name + email + class code). The retired entry
 * points (student sign-up, Google sign-in) answer clearly instead of crashing.
 */
// A leftover value from the old invite-code days must have no effect at all.
process.env.EDUCATOR_INVITE_CODE = 'test-invite';

const crypto = require('crypto');
const request = require('supertest');
const { JSDOM } = require('jsdom');
const { app } = require('../../src/app');
const db = require('../../src/config/db');

const PASSWORD = 'Tr1cky-Horse-Battery';
const uname = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}@example.com`;
const agent = () => request(app);

beforeAll(() => db.initDb());

describe('educator onboarding: name + email + password, no professor code', () => {
  test('a professor registers without any code, is signed in at once and can create a class', async () => {
    const email = uname('edu');
    const res = await agent().post('/api/auth/educator/register').send({ name: 'Prof Real', email, password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('educator');

    const cookie = res.headers['set-cookie'];
    expect((await agent().get('/api/me').set('Cookie', cookie)).body.user).toMatchObject({ role: 'educator', name: 'Prof Real' });
    const klass = await agent().post('/api/classes').set('Cookie', cookie).send({ name: 'Intro to Networks' });
    expect(klass.status).toBe(201);
    expect(klass.body.classCode).toMatch(/^[A-Z2-9]{6}$/);
  });

  test('a professorCode / inviteCode in the payload (even a wrong one) is not required, not checked and not stored; a `role` is ignored', async () => {
    const email = uname('stray');
    const res = await agent().post('/api/auth/educator/register').send({
      name: 'Stray Fields', email, password: PASSWORD, professorCode: 'guess', inviteCode: 'also-wrong', role: 'student'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('educator');

    const stored = (await db.readData('users')).find((u) => u.email === email);
    expect(stored.role).toBe('educator');
    expect(stored).not.toHaveProperty('professorCode');
    expect(stored).not.toHaveProperty('inviteCode');
  });

  test('an educator only ever sees the classes they created themselves', async () => {
    const register = async (name) => (await agent().post('/api/auth/educator/register').send({ name, email: uname('own'), password: PASSWORD })).headers['set-cookie'];
    const [a, b] = [await register('Prof A'), await register('Prof B')];
    await agent().post('/api/classes').set('Cookie', a).send({ name: 'Class of A' });
    await agent().post('/api/classes').set('Cookie', b).send({ name: 'Class of B' });

    expect((await agent().get('/api/educator/classes').set('Cookie', a)).body.classes.map((c) => c.name)).toEqual(['Class of A']);
    expect((await agent().get('/api/educator/classes').set('Cookie', b)).body.classes.map((c) => c.name)).toEqual(['Class of B']);
  });

  test('concurrent registrations of the same email yield exactly one 201 and one stored row', async () => {
    const email = uname('race');
    const results = await Promise.all(Array.from({ length: 4 }, () => agent().post('/api/auth/educator/register').send({ name: 'Racer', email, password: PASSWORD })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await db.readData('users')).filter((u) => u.email === email)).toHaveLength(1);
  });

  test('sign-up is throttled per IP (every attempt counts) with a clear 429', async () => {
    // A fresh app instance has its own, empty rate-limit window. Empty bodies fail validation, so nothing is written.
    jest.resetModules();
    const { app: freshApp } = require('../../src/app');
    let last;
    for (let i = 0; i < 11; i += 1) last = await request(freshApp).post('/api/auth/educator/register').send({});
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/Too many sign-up attempts/);
  });
});

describe('educator-signup.html as the real server delivers it', () => {
  let doc;
  beforeAll(async () => {
    const res = await agent().get('/educator-signup.html');
    expect(res.status).toBe(200);
    doc = new JSDOM(res.text).window.document;
  });

  test('has exactly the Full name, Email and Password inputs and no professor / invite code input', () => {
    expect([...doc.querySelectorAll('#educatorForm input')].map((i) => i.id)).toEqual(['eduName', 'eduEmail', 'eduPassword']);
    const everything = [...doc.querySelectorAll('input')].map((i) => [i.id, i.name, i.placeholder, i.getAttribute('aria-label')].join(' ')).join(' ');
    expect(everything).not.toMatch(/professor|invite|access.?code/i);
    expect(doc.body.textContent).not.toMatch(/professor code|invite code/i);
  });

  test('the sign-up script it loads never mentions a professor / invite code either', async () => {
    const js = await agent().get('/js/educator-signup.js');
    expect(js.status).toBe(200);
    expect(js.text).not.toMatch(/professorCode|inviteCode|eduInvite/);
  });
});

describe('retired student sign-up', () => {
  test('/api/register cannot create anyone, not even an educator "with the invite code"', async () => {
    const email = uname('sneak');
    for (const extra of [{}, { role: 'educator', inviteCode: 'test-invite' }, { role: 'educator', professorCode: 'test-invite' }]) {
      const res = await agent().post('/api/register').send({ username: email, password: PASSWORD, legalName: 'Sneaky', ...extra });
      expect(res.status).toBe(410);
    }
    expect((await db.readData('users')).some((u) => u.email === email || u.username === email)).toBe(false);
  });
});

describe('retired Google sign-in', () => {
  test('providers always reports Google as unavailable', async () => {
    expect((await agent().get('/api/auth/providers')).body).toEqual({ google: false });
  });

  test('the old start and callback links send the browser to the Join page instead of an error', async () => {
    for (const url of ['/api/auth/google', '/api/auth/google/callback?code=abc&state=x']) {
      const res = await agent().get(url);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/join.html');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('clean invite route', () => {
  test('/join serves the Join page (the query string is read client-side), and the old ?code= link still resolves', async () => {
    for (const url of ['/join?classCode=ABC234', '/join.html?code=ABC234']) {
      const res = await agent().get(url);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<title>Join a class/);
      expect(res.text).toMatch(/id="joinClassCode"/);
    }
  });

  test('/ is the educator sign-in page', async () => {
    const res = await agent().get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/id="loginForm"/);
  });
});
