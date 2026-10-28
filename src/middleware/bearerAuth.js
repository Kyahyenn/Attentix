const db = require('../config/db');
const { verifyTokenClaims } = require('../utils/extensionToken');

// The session user for a passwordless student. `classId` is part of the identity: one student record exists per
// (email, class), so the same person in two classes holds two separate tokens.
const studentSessionUser = (user, klass) => ({
  id: user.id,
  username: user.email,
  email: user.email,
  role: user.role,
  legalName: user.legalName || user.name,
  name: user.name || user.legalName,
  classId: klass.id,
  classCode: klass.classCode
});

// Resolves `Authorization: Bearer <token>` to a student, or null. Everything is re-checked against the database, so a
// token for a deleted student or a deleted class stops working at once, whatever its claims say.
const userFromToken = async (token) => {
  const claims = verifyTokenClaims(token);
  // Tokens from the retired password login carry no class: they must not outlive the switch to passwordless joining.
  if (!claims || !claims.classId) return null;
  const user = await db.findById('users', claims.uid);
  if (!user || user.role !== 'student' || user.classId !== claims.classId) return null;
  // "Sign out everywhere" bumps tokenVersion, which invalidates every token issued before it.
  if ((user.tokenVersion || 0) !== claims.tv) return null;
  const klass = await db.findById('classes', user.classId);
  if (!klass) return null;
  return studentSessionUser(user, klass);
};

const bearerFromHeader = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

// Wraps the cookie-session middleware. A valid bearer token gets a throwaway in-memory
// `req.session = { user }` (express-session skips itself when req.session already exists),
// so every existing route and requireAuth/requireStudent keeps working and no cookie is set.
// No bearer header -> normal cookie session, exactly as before (educators).
const sessionOrBearer = (sessionMiddleware) => async (req, res, next) => {
  const token = bearerFromHeader(req);
  if (!token) return sessionMiddleware(req, res, next);
  try {
    const user = await userFromToken(token);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.session = { user, viaBearer: true };
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { sessionOrBearer, userFromToken };
