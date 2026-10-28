const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { validate, LoginSchema, DeleteAccountSchema } = require('../utils/validation');
const { authLimiter, accountLimiter } = require('../middleware/limiter');
const { requireAuth } = require('../middleware/auth');
const { retired } = require('../middleware/security');
const realtimeOf = require('../utils/realtime');
const { deleteAccountData, findEducatorByEmail } = require('../utils/accounts');
const { toSessionUser, establishSession, clearSessionCookie } = require('../utils/session');

const router = express.Router();

// Compared against when the user doesn't exist so "unknown user" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-password', 10);

const STUDENT_AUTH_GONE = 'Students no longer create accounts or sign in with a password. Join your class with its class code instead.';

// Student sign-up is gone: students join a class passwordlessly (POST /api/extension/join). Educators register at
// POST /api/auth/educator/register. Answered with 410 so old clients get a clear message rather than a crash.
router.post('/register', retired(STUDENT_AUTH_GONE));

// Educator sign-in (the only password login left). A correct password on a leftover student record is told where to
// go instead; every other failure is the same generic 401.
router.post('/login', authLimiter, accountLimiter, validate(LoginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const educator = await findEducatorByEmail(email);
    const storedHash = educator && typeof educator.password === 'string' ? educator.password : DUMMY_HASH;

    const isMatch = await bcrypt.compare(password, storedHash);
    if (!educator || !isMatch) {
      const legacy = !educator && (await db.readData('users')).find((u) => u.role === 'student' && (u.username || u.email || '').toLowerCase() === email);
      if (legacy && typeof (legacy.password || legacy.passwordHash) === 'string' && await bcrypt.compare(password, legacy.password || legacy.passwordHash)) {
        return res.status(410).json({ error: STUDENT_AUTH_GONE, redirect: '/join.html' });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userResponse = toSessionUser(educator);
    await establishSession(req, userResponse);
    res.json({ message: 'Login successful', user: userResponse });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', requireAuth, (req, res) => {
  const sessionId = req.sessionID;
  const realtime = realtimeOf(req);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Failed to logout' });
    // Destroying the cookie session is not enough: sockets opened with it would keep streaming until closed.
    realtime.disconnectSession(sessionId, 'You signed out.');
    clearSessionCookie(res);
    res.json({ message: 'Logout successful' });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// DELETE /api/me { password } - permanently deletes the signed-in educator account, its classes and their data.
// (Students erase their data with DELETE /api/student/me.)
router.delete('/me', requireAuth, validate(DeleteAccountSchema), async (req, res) => {
  try {
    if (req.session.viaBearer || req.session.user.role !== 'educator') {
      return res.status(403).json({ error: 'Students erase their data with DELETE /api/student/me.' });
    }
    const user = await db.findById('users', req.session.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    if (typeof user.password !== 'string' || !req.body.password || !(await bcrypt.compare(req.body.password, user.password))) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    const realtime = realtimeOf(req);
    const removedClassIds = await deleteAccountData(user);
    realtime.disconnectUser(user.id, 'This account was deleted.');
    removedClassIds.forEach((classId) => realtime.closeClass(classId, 'This class was deleted.'));
    realtime.forgetUser(user.id);

    const sessionId = req.sessionID;
    req.session.destroy(() => {
      realtime.disconnectSession(sessionId, 'This account was deleted.');
      clearSessionCookie(res);
      res.json({ message: 'Account deleted' });
    });
  } catch (err) {
    console.error('Delete account failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
