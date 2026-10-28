const express = require('express');
const db = require('../config/db');
const settings = require('../config/settings');
const engagement = require('../state/engagementState');
const { requireEducator, requireStudent } = require('../middleware/auth');
const { joinLimiter } = require('../middleware/limiter');
const { validate, StudentLookupSchema } = require('../utils/validation');
const { listEducatorClasses, classNameOf, describeClass, userDisplayName } = require('../utils/classes');
const { resolveStudent, deleteAccountData } = require('../utils/accounts');
const { getConsent, isConsentCurrent } = require('../utils/consent');
const realtimeOf = require('../utils/realtime');

const router = express.Router();

// GET /api/educator/classes - the educator's classes with live counts for the dashboard cards.
router.get('/educator/classes', requireEducator, async (req, res) => {
  try {
    res.json({ classes: await listEducatorClasses(req.session.user.id) });
  } catch (err) {
    console.error('Educator classes failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/student/classes - the class this student joined (Bearer token).
router.get('/student/classes', requireStudent, async (req, res) => {
  try {
    const [classes, enrollments] = await Promise.all([db.readData('classes'), db.readData('enrollments')]);
    const mine = classes.filter((c) => enrollments.some((e) => e.classId === c.id && e.studentId === req.session.user.id));
    res.json({
      classes: await Promise.all(mine.map(async (c) => ({
        id: c.id, name: classNameOf(c), section: c.section || '', educatorName: await userDisplayName(c.educatorId)
      })))
    });
  } catch (err) {
    console.error('Student classes failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bearer-token holders send nothing; everyone else sends { name?, email, classCode }.
const pickLookupSchema = (req, res, next) =>
  (req.session && req.session.viaBearer ? next() : validate(StudentLookupSchema)(req, res, next));

// POST /api/student/lookup - READ-ONLY. A passwordless student sees their own class, consent and live engagement.
// Nothing is created or changed here (joining is POST /api/extension/join), and `name` is never used to match.
// A student can only ever see their own row: the live status is the same one the educator sees, minus identifiers.
router.post('/student/lookup', joinLimiter, pickLookupSchema, async (req, res) => {
  try {
    const found = await resolveStudent(req, req.body || {});
    if (!found) return res.status(404).json({ error: 'No student found for that email and class code.' });
    const { student, klass } = found;

    const [consent, educatorName] = await Promise.all([getConsent(student.id), userDisplayName(klass.educatorId)]);
    const row = engagement.snapshot(klass.id).find((r) => r.studentId === student.id);
    let status = null;
    if (row) {
      const { studentId, name, ...view } = row;
      status = view;
    }

    res.json({
      student: { id: student.id, name: student.name, email: student.email },
      class: describeClass(klass, educatorName),
      consent: { accepted: isConsentCurrent(consent), version: settings.consentVersion, timestamp: consent ? consent.timestamp : null },
      status,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Student lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/student/me  (Bearer token) - right to erasure for a passwordless student: their record, enrolment,
// consent and every live connection and in-memory metric are removed. They can join again later as a new student.
router.delete('/student/me', requireStudent, async (req, res) => {
  try {
    const user = await db.findById('users', req.session.user.id);
    if (!user) return res.status(404).json({ error: 'Student not found' });
    const realtime = realtimeOf(req);
    await deleteAccountData(user);
    realtime.disconnectUser(user.id, 'Your data was deleted.');
    realtime.forgetUser(user.id);
    res.json({ message: 'Your data was deleted' });
  } catch (err) {
    console.error('Student erase failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
