const express = require('express');
const db = require('../config/db');
const { validate, StudentJoinSchema } = require('../utils/validation');
const { joinLimiter, heartbeatLimiter } = require('../middleware/limiter');
const { requireStudent } = require('../middleware/auth');
const { retired } = require('../middleware/security');
const { issueStudentToken, TOKEN_TTL_MS } = require('../utils/extensionToken');
const { findClassByCode, classNameOf, describeClass, userDisplayName } = require('../utils/classes');
const { upsertStudent, ensureEnrollment } = require('../utils/accounts');
const { recordConsent } = require('../utils/consent');
const realtimeOf = require('../utils/realtime');

const router = express.Router();

// Students have no password, so a body that carries one is a client bug (or someone probing): say so instead of
// silently ignoring it.
const rejectPasswords = (req, res, next) => {
  const body = req.body;
  if (body && typeof body === 'object' && Object.keys(body).some((k) => /pass(word|code|wd)?$/i.test(k))) {
    return res.status(400).json({ error: 'Validation failed', message: 'Students join without a password. Remove the password field.' });
  }
  next();
};

// POST /api/extension/join  { name, email, classCode, consent: true }
//   -> { token, expiresAt, studentId, classId, classCode, className, educatorName, student, class, user }
// The whole onboarding in one call, no account and no password: validate, find the class, create-or-update the student
// (keyed by email + class, so a returning student keeps their studentId and history and only the display name can
// change), enrol them, record the privacy consent and hand back a signed bearer token for the extension.
router.post('/join', joinLimiter, rejectPasswords, validate(StudentJoinSchema), async (req, res) => {
  try {
    const { name, email, classCode } = req.body;

    const klass = await findClassByCode(classCode);
    if (!klass) return res.status(404).json({ error: 'No class found for that class code. Check the code with your educator.' });

    const { student, created } = await upsertStudent({ name, email, klass });
    await ensureEnrollment(klass.id, student.id);
    const consent = await recordConsent(student.id, true);

    const educatorName = await userDisplayName(klass.educatorId);
    const className = classNameOf(klass);
    res.status(created ? 201 : 200).json({
      message: created ? 'Joined class' : 'Welcome back',
      token: issueStudentToken(student, klass),
      expiresAt: Date.now() + TOKEN_TTL_MS,
      studentId: student.id,
      classId: klass.id,
      classCode: klass.classCode,
      className,
      educatorName,
      student: { id: student.id, name: student.name, email: student.email },
      class: describeClass(klass, educatorName),
      consent: { accepted: true, version: consent.version, timestamp: consent.timestamp },
      user: { id: student.id, name: student.name, role: 'student' } // shape the extension popup already reads
    });
  } catch (err) {
    console.error('Extension join failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/extension/heartbeat  (Bearer token)  { beats: [ { score, state, location?, isFocused, idleSeconds?, ageMs? } x1-5 ] }
//   -> { ok, accepted, status }   `status` is the row the student sees about themself.
// REST twin of the `attention:heartbeat` socket event. The extension uses it when the WebSocket is blocked or down, and
// still delivers the (up to 5) beats it buffered. Telemetry only: educator questions need the socket.
// Uses its own limiter (see middleware/limiter.js), not the global one.
router.post('/heartbeat', requireStudent, heartbeatLimiter, async (req, res) => {
  try {
    const result = await realtimeOf(req).ingestHeartbeat(req.session.user, req.body);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, accepted: result.accepted, status: result.status });
  } catch (err) {
    console.error('Extension heartbeat failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The old password login. 410 so an extension build that still calls it learns to use /join.
router.post('/login', retired('The extension no longer uses passwords. Join with your name, email and class code.'));

// POST /api/extension/logout  (Bearer token) - revokes EVERY extension token issued to this student so far and
// disconnects the extension's live sockets. A stolen or forgotten token can no longer be used after this.
// (Joining again with the same email and class code issues a fresh token; the studentId and history are unchanged.)
router.post('/logout', requireStudent, async (req, res) => {
  try {
    const userId = req.session.user.id;
    await db.mutate('users', (rows) => {
      const user = rows.find((u) => u.id === userId);
      if (user) user.tokenVersion = (user.tokenVersion || 0) + 1;
    });
    realtimeOf(req).disconnectUser(userId, 'The browser extension was signed out.', { tokenOnly: true });
    res.json({ message: 'Extension signed out' });
  } catch (err) {
    console.error('Extension logout failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
