/** GET /api/extension/preconfigured?classCode=...: the student extension with the server address and class code filled in. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');
const { readZip } = require('../helpers/zipReader');

const PASSWORD = 'Tr1cky-Horse-Battery';
const uid = () => crypto.randomBytes(4).toString('hex');
const LAN = { 'Wi-Fi': [{ address: '192.168.1.50', family: 'IPv4', internal: false }] };
const REAL_CONFIG = path.join(__dirname, '../../extension/config.js');
const configOf = (zip) => { const sandbox = { globalThis: {} }; vm.runInNewContext(readZip(zip).get('config.js').toString(), sandbox); return sandbox.globalThis.AMP_PRECONFIG; };
const binary = (res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); };

describe('pre-configured extension download', () => {
  let prof; let other; let klass; let otherKlass; let studentToken;
  const get = (agent, code, host) => {
    const r = agent.get('/api/extension/preconfigured').query(code === undefined ? {} : { classCode: code }).buffer(true).parse(binary);
    return host ? r.set('Host', host) : r;
  };

  beforeAll(async () => {
    await db.initDb();
    const mk = async (name) => {
      const a = request.agent(app);
      const r = await a.post('/api/auth/educator/register').send({ name, email: `${name.replace(/\W/g, '').toLowerCase()}_${uid()}@pup.edu.ph`, password: PASSWORD });
      expect(r.status).toBe(201);
      return a;
    };
    prof = await mk('Prof Bundle');
    other = await mk('Prof Other');
    klass = (await prof.post('/api/classes').send({ name: 'Bundle Class' })).body.class;
    otherKlass = (await other.post('/api/classes').send({ name: 'Not Yours' })).body.class;
    const join = await request(app).post('/api/extension/join').send({ name: 'Stu Dent', email: `stu_${uid()}@pup.edu.ph`, classCode: klass.classCode, consent: true });
    studentToken = join.body.token;
  });

  afterEach(() => { jest.restoreAllMocks(); delete process.env.PUBLIC_URL; delete app.locals.extensionConfigPath; });

  test('an educator gets a zip attachment named after the class code, and it is a valid archive', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    const res = await get(prof, klass.classCode);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/zip/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Attentix-Extension-${klass.classCode}.zip"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    const files = readZip(res.body);
    ['manifest.json', 'config.js', 'popup.html', 'popup.js', 'background.js', 'content.js', 'scoring.js'].forEach((n) => expect(files.has(n)).toBe(true));
  });

  test('config.js carries the permanent class code and the LAN address when the professor browses on localhost', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    const res = await get(prof, klass.classCode, 'localhost:3000');
    expect(res.headers['x-server-url']).toBe('http://192.168.1.50:3000');
    expect(configOf(res.body)).toEqual({ serverUrl: 'http://192.168.1.50:3000', classCode: klass.classCode });
  });

  test('the manifest in the zip already allows the server (no extra permission prompt for the student)', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    const manifest = JSON.parse(readZip((await get(prof, klass.classCode, 'localhost:3000')).body).get('manifest.json').toString());
    expect(manifest.host_permissions).toContain('http://192.168.1.50:3000/*');
    expect(manifest.manifest_version).toBe(3);
  });

  test('a professor already on a LAN name or domain gets exactly that address; PUBLIC_URL overrides both', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    expect(configOf((await get(prof, klass.classCode, 'prof-laptop.local:3000')).body).serverUrl).toBe('http://prof-laptop.local:3000');
    process.env.PUBLIC_URL = 'https://attention.school.edu';
    expect(configOf((await get(prof, klass.classCode, 'prof-laptop.local:3000')).body).serverUrl).toBe('https://attention.school.edu');
  });

  test('no network at all: falls back to localhost rather than failing', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
    expect(configOf((await get(prof, klass.classCode, 'localhost:3000')).body).serverUrl).toBe('http://localhost:3000');
  });

  test('the class code is matched in any letter case and is always the class\'s one permanent code', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    const res = await get(prof, klass.classCode.toLowerCase());
    expect(res.status).toBe(200);
    expect(configOf(res.body).classCode).toBe(klass.classCode);
    // asking for a new code is impossible, so a later download carries the same one
    expect((await prof.post(`/api/classes/${klass.id}/rotate-code`)).status).toBe(410);
    expect(configOf((await get(prof, klass.classCode)).body).classCode).toBe(klass.classCode);
  });

  test('another educator\'s class, and a class that does not exist, give the same 404 (a code is never confirmed)', async () => {
    const stranger = await get(prof, otherKlass.classCode);
    const nobody = await get(prof, 'ZZZZZZ');
    expect(stranger.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(stranger.body.toString()).toBe(nobody.body.toString());
    expect(JSON.parse(stranger.body.toString()).error).toBe('No class found for that class code');
  });

  test('needs an educator session: anonymous 401, a student token 403', async () => {
    expect((await get(request(app), klass.classCode)).status).toBe(401);
    const asStudent = await request(app).get('/api/extension/preconfigured').query({ classCode: klass.classCode }).set('Authorization', `Bearer ${studentToken}`);
    expect(asStudent.status).toBe(403);
  });

  test.each([[undefined], ['ab'], ['has space'], ['TOOLONGCODE1']])('a missing or malformed class code (%j) is a 400', async (code) => {
    const res = await get(prof, code);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).error).toBe('Validation failed');
  });

  test('the educator\'s own extension/config.js is updated too (here a temp file stands in), with the same content as the zip', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amp-cfg-')), 'config.js');
    app.locals.extensionConfigPath = target;
    const res = await get(prof, klass.classCode, 'localhost:3000');
    const onDisk = vm.runInNewContext(`${fs.readFileSync(target, 'utf8')}; globalThis.AMP_PRECONFIG`, { globalThis: {} });
    expect(onDisk).toEqual({ serverUrl: 'http://192.168.1.50:3000', classCode: klass.classCode });
    expect(onDisk).toEqual(configOf(res.body));
  });

  test('a failing local write never fails the download', async () => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(LAN);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app.locals.extensionConfigPath = path.join(os.tmpdir(), 'amp-does-not-exist', 'nested', 'config.js');
    expect((await get(prof, klass.classCode)).status).toBe(200);
    expect(console.warn).toHaveBeenCalled();
  });

  test('under npm test the repository\'s own extension/config.js is never modified', async () => {
    const before = fs.readFileSync(REAL_CONFIG, 'utf8');
    expect((await get(prof, klass.classCode)).status).toBe(200);
    expect(fs.readFileSync(REAL_CONFIG, 'utf8')).toBe(before);
    expect(before).toMatch(/serverUrl: ''/);
  });
});
