/** GET /api/server-info and POST /api/server/shutdown (the dashboard's "Shut down server" button). */
const os = require('os');
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');
const settings = require('../../src/config/settings');
const { version } = require('../../package.json');

const PASSWORD = 'Tr1cky-Horse-Battery';
const uid = () => crypto.randomBytes(4).toString('hex');
const LAN = { 'Wi-Fi': [{ address: '192.168.1.50', family: 'IPv4', internal: false }] };

describe('server info + shutdown', () => {
  let prof; let studentToken;

  beforeAll(async () => {
    await db.initDb();
    prof = request.agent(app);
    prof.email = `srv_${uid()}@pup.edu.ph`;
    const reg = await prof.post('/api/auth/educator/register').send({ name: 'Prof Server', email: prof.email, password: PASSWORD });
    expect(reg.status).toBe(201);
    const klass = (await prof.post('/api/classes').send({ name: 'Server Class' })).body.class;
    studentToken = (await request(app).post('/api/extension/join').send({ name: 'Stu Dent', email: `stu_${uid()}@pup.edu.ph`, classCode: klass.classCode, consent: true })).body.token;
  });

  afterEach(() => { jest.restoreAllMocks(); delete app.locals.requestShutdown; });

  describe('GET /api/server-info', () => {
    test('educators see the localhost and LAN addresses students can use', async () => {
      jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
      const res = await prof.get('/api/server-info');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        port: Number(settings.port), localUrl: `http://localhost:${settings.port}`, lanUrl: `http://192.168.1.50:${settings.port}`,
        lanUrls: [`http://192.168.1.50:${settings.port}`], hasLan: true, publicUrl: null, preferredUrl: `http://192.168.1.50:${settings.port}`,
        version, packaged: false, canShutdown: false
      });
    });

    test('with no network it says so and falls back to localhost; PUBLIC_URL is preferred when set', async () => {
      jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
      const none = await prof.get('/api/server-info');
      expect(none.body).toMatchObject({ hasLan: false, lanUrl: null, preferredUrl: `http://localhost:${settings.port}` });
      process.env.PUBLIC_URL = 'https://am.school.edu';
      try { expect((await prof.get('/api/server-info')).body).toMatchObject({ publicUrl: 'https://am.school.edu', preferredUrl: 'https://am.school.edu' }); } finally { delete process.env.PUBLIC_URL; }
    });

    test('is educator-only: anonymous 401, a student token 403 (a LAN address is not for everyone)', async () => {
      expect((await request(app).get('/api/server-info')).status).toBe(401);
      expect((await request(app).get('/api/server-info').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    });

    test('canShutdown is true only for a local request when the launcher installed the shutdown hook', async () => {
      app.locals.requestShutdown = jest.fn();
      expect((await prof.get('/api/server-info')).body.canShutdown).toBe(true);
      expect((await prof.get('/api/server-info').set('Host', 'prof-laptop.local:3000')).body.canShutdown).toBe(false);
      expect((await prof.get('/api/server-info').set('X-Forwarded-For', '203.0.113.9')).body.canShutdown).toBe(false);
    });
  });

  describe('POST /api/server/shutdown', () => {
    const tick = () => new Promise((r) => setTimeout(r, 30));

    test('NODE_ENV=test: nothing ever installs the hook, so a test run cannot stop anything (503, process.exit never called)', async () => {
      expect(process.env.NODE_ENV).toBe('test');
      expect(app.locals.requestShutdown).toBeUndefined();
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const res = await prof.post('/api/server/shutdown');
      await tick();
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/only available when the server was started with the launcher/);
      expect(exit).not.toHaveBeenCalled();
    });

    test('a local educator request is accepted: the response is sent first, then the hook runs once', async () => {
      app.locals.requestShutdown = jest.fn();
      const res = await prof.post('/api/server/shutdown');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
      await tick();
      expect(app.locals.requestShutdown).toHaveBeenCalledTimes(1);
      expect(app.locals.requestShutdown).toHaveBeenCalledWith('dashboard');
    });

    test('anonymous callers and students are refused and the hook is not called', async () => {
      app.locals.requestShutdown = jest.fn();
      expect((await request(app).post('/api/server/shutdown')).status).toBe(401);
      expect((await request(app).post('/api/server/shutdown').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
      await tick();
      expect(app.locals.requestShutdown).not.toHaveBeenCalled();
    });

    test('open educator sign-up must not let a stranger stop a shared server: non-local Host or proxy headers are refused', async () => {
      app.locals.requestShutdown = jest.fn();
      for (const headers of [{ Host: 'attention.school.edu' }, { Host: '192.168.1.50:3000' }, { 'X-Forwarded-For': '203.0.113.9' },
        { 'X-Forwarded-Host': 'attention.school.edu' }, { Forwarded: 'for=203.0.113.9' }, { 'X-Real-IP': '203.0.113.9' }]) {
        const res = await prof.post('/api/server/shutdown').set(headers);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/only be shut down from the computer it runs on/);
      }
      await tick();
      expect(app.locals.requestShutdown).not.toHaveBeenCalled();
    });

    test('a cross-site page cannot trigger it with the professor\'s cookie (origin guard)', async () => {
      app.locals.requestShutdown = jest.fn();
      const res = await prof.post('/api/server/shutdown').set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      await tick();
      expect(app.locals.requestShutdown).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/server/sign-out (the dashboard\'s Log out)', () => {
    const tick = () => new Promise((r) => setTimeout(r, 30));

    test('on the computer that runs the app: signs out, then stops the server', async () => {
      const own = request.agent(app);
      const login = await own.post('/api/login').send({ email: prof.email, password: PASSWORD });
      expect(login.status).toBe(200);
      app.locals.requestShutdown = jest.fn();
      const res = await own.post('/api/server/sign-out');
      await tick();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ stopped: true });
      expect(app.locals.requestShutdown).toHaveBeenCalledTimes(1);
      expect(app.locals.requestShutdown).toHaveBeenCalledWith('educator sign-out');
      expect((await own.get('/api/me')).status).toBe(401);          // really signed out
    });

    test('from another computer (or behind a proxy) it is only a sign-out: the server keeps running', async () => {
      const own = request.agent(app);
      await own.post('/api/login').send({ email: prof.email, password: PASSWORD });
      app.locals.requestShutdown = jest.fn();
      const res = await own.post('/api/server/sign-out').set('X-Forwarded-For', '203.0.113.9');
      await tick();
      expect(res.status).toBe(200);
      expect(res.body.stopped).toBe(false);
      expect(app.locals.requestShutdown).not.toHaveBeenCalled();
      expect((await own.get('/api/me')).status).toBe(401);
    });

    test('without the launcher hook (tests, Docker) it just signs out', async () => {
      const own = request.agent(app);
      await own.post('/api/login').send({ email: prof.email, password: PASSWORD });
      const res = await own.post('/api/server/sign-out');
      expect(res.body.stopped).toBe(false);
    });

    test('needs an educator session: anonymous 401, a student token 403, nothing stops', async () => {
      app.locals.requestShutdown = jest.fn();
      expect((await request(app).post('/api/server/sign-out')).status).toBe(401);
      expect((await request(app).post('/api/server/sign-out').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
      await tick();
      expect(app.locals.requestShutdown).not.toHaveBeenCalled();
    });
  });
});
