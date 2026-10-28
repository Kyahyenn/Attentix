/** GET /api/educator/classes: what the Home overview and the Classes page are built from. */
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/config/db');
const engagement = require('../../src/state/engagementState');

const uid = () => crypto.randomBytes(4).toString('hex');

describe('educator class list: live numbers for the overview', () => {
  let prof; let math; let empty;
  const learner = (name) => ({ id: `stu-${uid()}`, name, legalName: name });

  beforeAll(async () => {
    await db.initDb();
    prof = request.agent(app);
    const reg = await prof.post('/api/auth/educator/register').send({ name: 'Prof Stats', email: `stats_${uid()}@pup.edu.ph`, password: 'Tr1cky-Horse-Battery' });
    expect(reg.status).toBe(201);
    math = (await prof.post('/api/classes').send({ name: 'Stats Math' })).body.class;
    empty = (await prof.post('/api/classes').send({ name: 'Stats Empty' })).body.class;
  });

  const find = async (id) => (await prof.get('/api/educator/classes')).body.classes.find((c) => c.id === id);

  test('a class nobody has joined has no live numbers, but still has a creation time to sort by', async () => {
    const c = await find(empty.id);
    expect(c).toMatchObject({ studentCount: 0, activeCount: 0, scoredCount: 0, averageScore: null, belowThresholdCount: 0, lastActivityAt: null });
    expect(Number.isFinite(c.createdAt)).toBe(true);
  });

  test('average, below-60 count and last activity come from the online students that have a score', async () => {
    const [ana, ben, cy] = [learner('Ana'), learner('Ben'), learner('Cy')];
    const now = Date.now();
    [ana, ben, cy].forEach((s) => engagement.connect(math.id, s, now));
    engagement.recordScore(math.id, ana, 90, now);
    engagement.recordScore(math.id, ben, 40, now);
    engagement.recordActivity(math.id, cy, 'mouse', false, now); // online, but no score yet
    const c = await find(math.id);
    expect(c.activeCount).toBe(3);
    expect(c.scoredCount).toBe(2);
    expect(c.averageScore).toBe(65);
    expect(c.belowThresholdCount).toBe(1);
    expect(c.lastActivityAt).toBeGreaterThanOrEqual(now);
    expect((await find(empty.id)).averageScore).toBeNull(); // other classes are unaffected
  });

  test('no student names or identifiers are added to the list', async () => {
    const c = await find(math.id);
    expect(JSON.stringify(c)).not.toMatch(/Ana|Ben|Cy|stu-/);
  });

  test('educator only', async () => {
    expect((await request(app).get('/api/educator/classes')).status).toBe(401);
  });
});
