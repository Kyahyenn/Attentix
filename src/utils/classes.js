const crypto = require('crypto');
const db = require('../config/db');
const engagement = require('../state/engagementState');

// No 0/O/1/I/L: codes get read aloud and typed by students. 31^6 is ~887 million possible codes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6; // keep within the 6-8 range the join schema accepts
const makeClassCode = () => Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

// Inserts a class with a unique, permanent join code (retries on the rare collision). The code is checked for
// uniqueness inside the same lock as the insert, and db.js refuses any later write that would change it.
const insertClassWithCode = async (fields) => {
  // A caller-supplied classCode/id is never honoured: only the generated one is used.
  const { classCode: _ignoredCode, id: _ignoredId, ...safeFields } = fields;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const classCode = makeClassCode();
    try {
      return await db.insertUnique('classes', { ...safeFields, classCode }, (c) => c.classCode === classCode, 'Class code collision');
    } catch (err) {
      if (err.status !== 409) throw err;
    }
  }
  throw new Error('Could not generate a unique class code');
};

// Classes created before join codes existed get one the first time an educator lists them. This is the only way an
// existing class's classCode can be written, and only while it has none: once set it can never change (see db.js).
const ensureClassCodes = (classes) => {
  if (classes.every((c) => c.classCode)) return Promise.resolve(classes);
  return db.mutate('classes', (all) => {
    const taken = new Set(all.map((c) => c.classCode).filter(Boolean));
    for (const klass of all) {
      if (klass.classCode) continue;
      let code;
      do { code = makeClassCode(); } while (taken.has(code));
      taken.add(code);
      klass.classCode = code;
    }
    const byId = new Map(all.map((c) => [c.id, c]));
    return classes.map((c) => byId.get(c.id) || c);
  });
};

// `classCode` must already be upper-case (the validation schemas normalise it).
const findClassByCode = async (classCode) =>
  (await db.readData('classes')).find((c) => (c.classCode || '').toUpperCase() === classCode);

const classNameOf = (klass) => klass.className || klass.name;

/** The `class` object returned to a student (join and lookup responses): both name spellings are sent on purpose. */
const describeClass = (klass, educatorName) => ({
  id: klass.id,
  classId: klass.id,
  classCode: klass.classCode,
  name: classNameOf(klass),
  className: classNameOf(klass),
  section: klass.section || '',
  educatorName
});

const userDisplayName = async (userId) => {
  const user = await db.findById('users', userId);
  return (user && (user.legalName || user.name)) || 'Educator';
};

// Live numbers for one class, straight from the in-memory engagement state (nothing is stored). Same definitions as the
// class dashboard: the average is over online students that have a score, "below 60" is its "check-in" metric.
const CHECK_IN_BELOW = 60;
const liveStatsOf = (classId) => {
  const rows = engagement.snapshot(classId);
  const scored = rows.filter((r) => r.online && typeof r.focusScore === 'number' && Number.isFinite(r.focusScore));
  const lastActivityAt = rows.reduce((latest, r) => Math.max(latest, Number(r.lastActivityAt) || 0), 0);
  return {
    scoredCount: scored.length,
    averageScore: scored.length ? Math.round(scored.reduce((sum, r) => sum + r.focusScore, 0) / scored.length) : null,
    belowThresholdCount: scored.filter((r) => r.focusScore < CHECK_IN_BELOW).length,
    lastActivityAt: lastActivityAt || null
  };
};

// What an educator sees for their classes (GET /api/classes and GET /api/educator/classes).
const listEducatorClasses = async (educatorId) => {
  const [allClasses, enrollments, educatorName] = await Promise.all([
    db.readData('classes'), db.readData('enrollments'), userDisplayName(educatorId)
  ]);
  const mine = await ensureClassCodes(allClasses.filter((c) => c.educatorId === educatorId));
  return mine.map((c) => ({
    id: c.id,
    classId: c.id,
    name: classNameOf(c),
    className: classNameOf(c),
    section: c.section || '',
    schedule: c.schedule || '',
    classCode: c.classCode,
    educatorName,
    studentCount: enrollments.filter((e) => e.classId === c.id).length,
    createdAt: c.createdAt || null,
    activeCount: engagement.onlineCount(c.id),
    ...liveStatsOf(c.id)
  }));
};

module.exports = { insertClassWithCode, findClassByCode, listEducatorClasses, classNameOf, describeClass, userDisplayName };
