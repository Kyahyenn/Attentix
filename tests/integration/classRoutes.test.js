/**
 * Classes: every class gets a unique class code when it is created, and that code is permanent. Nothing (no route, and
 * not even a direct write through the data layer) can change or regenerate it afterwards.
 */
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');

const PASSWORD = 'Tr1cky-Horse-Battery';
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/; // no 0/O/1/I/L: codes are read aloud and typed by students
const uid = () => crypto.randomBytes(4).toString('hex');

const registerEducator = async (name) => {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/educator/register').send({ name, email: `${name.replace(/\W/g, '').toLowerCase()}_${uid()}@pup.edu.ph`, password: PASSWORD });
  expect(res.status).toBe(201);
  return { agent, id: res.body.user.id };
};

beforeAll(() => db.initDb());

describe('Class API Integration', () => {
  test('POST /api/classes/create and POST /api/classes reject unauthenticated callers', async () => {
    const legacy = await request(app).post('/api/classes/create').send({ className: 'Advanced Mathematics', schedule: 'Mon/Wed 10AM' });
    expect(legacy.status).toBe(401);
    expect(legacy.body.error).toBe('Authentication required');
    expect((await request(app).post('/api/classes').send({ name: 'Advanced Mathematics' })).status).toBe(401);
    expect((await request(app).get('/api/classes')).status).toBe(401);
  });

  test('a student (bearer token) cannot create a class or list educator classes', async () => {
    const { agent } = await registerEducator('Prof Guard');
    const klass = (await agent.post('/api/classes').send({ name: 'Guarded Class' })).body.class;
    const join = await request(app).post('/api/extension/join').send({ name: 'Stu Dent', email: `stu_${uid()}@pup.edu.ph`, classCode: klass.classCode, consent: true });
    expect(join.status).toBe(201);
    const auth = { Authorization: `Bearer ${join.body.token}` };

    expect((await request(app).post('/api/classes').set(auth).send({ name: 'Sneaky Class' })).status).toBe(403);
    expect((await request(app).post('/api/classes/create').set(auth).send({ className: 'Sneaky Class' })).status).toBe(403);
    expect((await request(app).get('/api/classes').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/educator/classes').set(auth)).status).toBe(403);
  });

  test('class names are validated (3-100 characters) on both create endpoints', async () => {
    const { agent } = await registerEducator('Prof Valid');
    expect((await agent.post('/api/classes').send({ name: 'ab' })).status).toBe(400);
    expect((await agent.post('/api/classes/create').send({ className: 'ab' })).status).toBe(400);
    expect((await agent.post('/api/classes').send({ name: 'x'.repeat(101) })).status).toBe(400);
    expect((await agent.post('/api/classes').send({})).status).toBe(400);
  });
});

describe('creating a class generates a unique class code', () => {
  let edu;
  beforeAll(async () => { edu = await registerEducator('Prof Codes'); });

  test('POST /api/classes returns the new class with a 6-character classCode from the unambiguous alphabet', async () => {
    const res = await edu.agent.post('/api/classes').send({ name: 'Net Admin 101', section: 'BSIT 3-5' });
    expect(res.status).toBe(201);
    expect(res.body.classCode).toMatch(CODE);
    expect(res.body.class).toMatchObject({ id: res.body.classId, classCode: res.body.classCode, className: 'Net Admin 101', section: 'BSIT 3-5', educatorId: edu.id });
  });

  test('the legacy POST /api/classes/create generates one too', async () => {
    const res = await edu.agent.post('/api/classes/create').send({ className: 'Legacy Create', schedule: 'Mon/Wed 10AM' });
    expect(res.status).toBe(201);
    expect(res.body.classCode).toMatch(CODE);
    expect(res.body.class.classCode).toBe(res.body.classCode);
  });

  test('32 classes created in concurrent bursts all get different codes, and all are stored', async () => {
    const results = [];
    for (let round = 0; round < 4; round += 1) {
      results.push(...await Promise.all(Array.from({ length: 8 }, () => edu.agent.post('/api/classes').send({ name: 'Same Name' }))));
    }
    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.classCode);
    expect(new Set(codes).size).toBe(32);
    const stored = (await db.readData('classes')).map((c) => c.classCode);
    codes.forEach((code) => expect(stored.filter((c) => c === code)).toHaveLength(1));
  });

  test('a classCode (or id) supplied by the caller is never honoured', async () => {
    for (const [url, body] of [
      ['/api/classes', { name: 'Chosen Code', classCode: 'HACK99', id: 'attacker-chosen' }],
      ['/api/classes/create', { className: 'Chosen Code', classCode: 'HACK99', id: 'attacker-chosen' }]
    ]) {
      const res = await edu.agent.post(url).send(body);
      expect(res.status).toBe(201);
      expect(res.body.classCode).not.toBe('HACK99');
      expect(res.body.classCode).toMatch(CODE);
      expect(res.body.classId).not.toBe('attacker-chosen');
    }
  });

  test('a class that exists before codes existed gets exactly one the first time it is listed, and keeps it', async () => {
    await db.insert('classes', { className: 'Pre-code Class', educatorId: edu.id });
    const first = (await edu.agent.get('/api/classes')).body.classes.find((c) => c.name === 'Pre-code Class');
    expect(first.classCode).toMatch(CODE);
    const again = (await edu.agent.get('/api/classes')).body.classes.find((c) => c.name === 'Pre-code Class');
    expect(again.classCode).toBe(first.classCode);
  });
});

describe('the class code is immutable', () => {
  let edu; let other; let klass;
  beforeAll(async () => {
    edu = await registerEducator('Prof Fixed');
    other = await registerEducator('Prof Other');
    klass = (await edu.agent.post('/api/classes').send({ name: 'Fixed Code Class' })).body.class;
  });

  const codeNow = async () => (await edu.agent.get('/api/classes')).body.classes.find((c) => c.id === klass.id).classCode;

  test('every read endpoint keeps returning the code the class was created with', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await codeNow()).toBe(klass.classCode);
      expect((await edu.agent.get('/api/educator/classes')).body.classes.find((c) => c.id === klass.id).classCode).toBe(klass.classCode);
      expect((await edu.agent.get('/api/classes/my-classes')).body.classes.find((c) => c.id === klass.id).classCode).toBe(klass.classCode);
    }
  });

  test('the rotate endpoint is gone (410): for the owner, for another educator, and it needs a session at all', async () => {
    const owner = await edu.agent.post(`/api/classes/${klass.id}/rotate-code`);
    expect(owner.status).toBe(410);
    expect(owner.body.error).toMatch(/permanent/i);
    expect((await other.agent.post(`/api/classes/${klass.id}/rotate-code`)).status).toBe(410);
    expect((await request(app).post(`/api/classes/${klass.id}/rotate-code`)).status).toBe(401);
    expect(await codeNow()).toBe(klass.classCode);
  });

  test('no update / regenerate route exists: PUT, PATCH and POST attempts are 404 and change nothing', async () => {
    const url = `/api/classes/${klass.id}`;
    expect((await edu.agent.patch(url).send({ classCode: 'ZZZZZZ' })).status).toBe(404);
    expect((await edu.agent.put(url).send({ classCode: 'ZZZZZZ', name: 'Renamed' })).status).toBe(404);
    expect((await edu.agent.post(`${url}/regenerate-code`).send({})).status).toBe(404);
    expect((await edu.agent.post(`${url}/code`).send({ classCode: 'ZZZZZZ' })).status).toBe(404);
    expect(await codeNow()).toBe(klass.classCode);
  });

  test('the data layer itself refuses to change or swap a code, so no future code path can rotate one by accident', async () => {
    const second = (await edu.agent.post('/api/classes').send({ name: 'Second Class' })).body.class;
    const refuses = (fn) => expect(fn()).rejects.toMatchObject({ status: 409 });

    await refuses(() => db.mutate('classes', (rows) => { rows.find((c) => c.id === klass.id).classCode = 'ZZZZZZ'; }));
    await refuses(() => db.mutate('classes', (rows) => { delete rows.find((c) => c.id === klass.id).classCode; }));
    const current = await db.readData('classes');
    await refuses(() => db.writeData('classes', current.map((c) => (c.id === klass.id ? { ...c, classCode: 'ZZZZZZ' } : c))));
    // swapping the codes of two classes, and giving one class another class's code
    await refuses(() => db.mutate('classes', (rows) => {
      const a = rows.find((c) => c.id === klass.id); const b = rows.find((c) => c.id === second.id);
      [a.classCode, b.classCode] = [b.classCode, a.classCode];
    }));
    await refuses(() => db.mutate('classes', (rows) => { rows.find((c) => c.id === second.id).classCode = klass.classCode; }));
    // re-keying a class (new id, same code) is a change of identity as well
    await refuses(() => db.mutate('classes', (rows) => { rows.find((c) => c.id === klass.id).id = crypto.randomUUID(); }));

    const stored = await db.readData('classes');
    expect(stored.find((c) => c.id === klass.id).classCode).toBe(klass.classCode);
    expect(stored.find((c) => c.id === second.id).classCode).toBe(second.classCode);
    expect(await codeNow()).toBe(klass.classCode);
  });

  test('other class fields may change and a class may be deleted: only the identity is locked', async () => {
    const temp = (await edu.agent.post('/api/classes').send({ name: 'Temporary Class' })).body.class;
    await db.mutate('classes', (rows) => { rows.find((c) => c.id === temp.id).section = 'Renamed section'; });
    expect((await db.findById('classes', temp.id))).toMatchObject({ section: 'Renamed section', classCode: temp.classCode });
    await db.mutate('classes', (rows) => { rows.splice(rows.findIndex((c) => c.id === temp.id), 1); });
    expect(await db.findById('classes', temp.id)).toBeUndefined();
  });

  test('the permanent code keeps working for students: joining by it still lands in the same class later', async () => {
    await edu.agent.post('/api/classes').send({ name: 'Another Class' }); // other classes appearing must not disturb it
    const email = `late_${uid()}@pup.edu.ph`;
    const join = await request(app).post('/api/extension/join').send({ name: 'Late Joiner', email, classCode: klass.classCode.toLowerCase(), consent: true });
    expect(join.status).toBe(201);
    expect(join.body).toMatchObject({ classId: klass.id, classCode: klass.classCode, className: 'Fixed Code Class' });
  });
});

describe('class membership endpoints that moved to POST /api/extension/join', () => {
  test.each(['/api/classes/lookup', '/api/classes/join', '/api/classes/enroll'])('%s answers 410 and names the new endpoint', async (url) => {
    const res = await request(app).post(url).send({ classId: 'invalid-uuid-string', code: 'ABC234' });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/POST \/api\/extension\/join/);
    expect(res.body.joinEndpoint).toBe('/api/extension/join');
  });

  test('knowing a class id is not enough to get in', async () => {
    const { agent } = await registerEducator('Prof Id');
    const klass = (await agent.post('/api/classes').send({ name: 'Id Is Not A Key' })).body.class;
    expect((await request(app).post('/api/classes/enroll').send({ classId: klass.id })).status).toBe(410);
    expect((await db.readData('enrollments')).some((e) => e.classId === klass.id)).toBe(false);
  });
});
