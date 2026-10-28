const express = require('express');
const db = require('../config/db');
const { z } = require('zod');
const { validate, ClassCreationSchema, ClassCreateSchema, ClassIdParamSchema } = require('../utils/validation');
const { insertClassWithCode, listEducatorClasses, classNameOf } = require('../utils/classes');
const { requireAuth, requireEducator, requireStudent } = require('../middleware/auth');
const { retired } = require('../middleware/security');
const realtimeOf = require('../utils/realtime');

const router = express.Router();

const classCreated = (res, klass) =>
  res.status(201).json({ message: 'Class created', classId: klass.id, classCode: klass.classCode, class: klass });

// POST /api/classes/create  { className, schedule? }
router.post('/create', requireEducator, validate(ClassCreationSchema), async (req, res) => {
  try {
    const newClass = await insertClassWithCode({
      className: req.body.className,
      schedule: req.body.schedule,
      educatorId: req.session.user.id
    });
    classCreated(res, newClass);
  } catch (err) {
    console.error('Create class failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/classes - the educator's classes, each with its permanent classCode.
router.get('/', requireEducator, async (req, res) => {
  try {
    res.json({ classes: await listEducatorClasses(req.session.user.id) });
  } catch (err) {
    console.error('List classes failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/classes  { name, section? }  - what the educator dashboard's "Create Class" form calls.
router.post('/', requireEducator, validate(ClassCreateSchema), async (req, res) => {
  try {
    const created = await insertClassWithCode({
      className: req.body.name,
      section: req.body.section || '',
      educatorId: req.session.user.id
    });
    classCreated(res, created);
  } catch (err) {
    console.error('Create class failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Students no longer sign in, so the session-based lookup/join/enroll steps are gone: one call does it all,
// POST /api/extension/join { name, email, classCode, consent }. (Left in place, /join would let a student token enrol
// the same student record in a second class, which would break the one-record-per-(email, class) rule.)
const JOIN_MOVED = 'Joining a class is now done with POST /api/extension/join { name, email, classCode, consent }.';
router.post('/lookup', retired(JOIN_MOVED));
router.post('/join', retired(JOIN_MOVED));
router.post('/enroll', retired(JOIN_MOVED));

// GET /api/classes/my-classes - an educator's classes, or the classes a student is enrolled in.
router.get('/my-classes', requireAuth, async (req, res) => {
  try {
    const { id: userId, role } = req.session.user;
    if (role === 'educator') return res.json({ classes: await listEducatorClasses(userId) });

    // Students get only what they need: no join code and no internal ids of other people.
    const [classes, enrollments] = await Promise.all([db.readData('classes'), db.readData('enrollments')]);
    const myClassIds = new Set(enrollments.filter((e) => e.studentId === userId).map((e) => e.classId));
    const myClasses = classes
      .filter((c) => myClassIds.has(c.id))
      .map((c) => ({ id: c.id, name: classNameOf(c), className: classNameOf(c), section: c.section || '', schedule: c.schedule || '' }));
    return res.json({ classes: myClasses });
  } catch (err) {
    console.error('My classes failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/classes/leave  { classId }  - a student unenrols themselves; monitoring in that class stops immediately
// and the live data held about them for that class is discarded.
router.post('/leave', requireStudent, validate(z.object({ classId: z.string().uuid() })), async (req, res) => {
  try {
    const { classId } = req.body;
    const studentId = req.session.user.id;
    await db.mutate('enrollments', (rows) => db.removeWhere(rows, (e) => e.classId === classId && e.studentId === studentId));
    const realtime = realtimeOf(req);
    realtime.disconnectUser(studentId, 'You left this class. Monitoring has stopped.', { classId });
    realtime.forgetUser(studentId, classId);
    res.json({ message: 'Left class' });
  } catch (err) {
    console.error('Leave class failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Class codes are permanent: a class keeps the classCode it was created with for its whole life (students and the
// extension store it), and db.js refuses any write that would change it. The old rotate endpoint stays as a clear 410.
router.post('/:classId/rotate-code', requireEducator, validate(ClassIdParamSchema, 'params'), (req, res) => {
  res.status(410).json({ error: 'Class codes are permanent and can no longer be rotated.' });
});

// DELETE /api/classes/:classId/students/:studentId  - educator removes a student; their monitoring stops at once.
router.delete('/:classId/students/:studentId', requireEducator,
  validate(z.object({ classId: z.string().uuid(), studentId: z.string().uuid() }), 'params'), async (req, res) => {
    try {
      const { classId, studentId } = req.params;
      const klass = await db.findById('classes', classId);
      if (!klass || klass.educatorId !== req.session.user.id) return res.status(404).json({ error: 'Class not found' });

      const removed = await db.mutate('enrollments', (rows) =>
        db.removeWhere(rows, (e) => e.classId === classId && e.studentId === studentId));
      if (!removed) return res.status(404).json({ error: 'That student is not enrolled in this class' });

      const realtime = realtimeOf(req);
      realtime.disconnectUser(studentId, 'You were removed from this class.', { classId });
      realtime.forgetUser(studentId, classId);
      res.json({ message: 'Student removed' });
    } catch (err) {
      console.error('Remove student failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

module.exports = router;
