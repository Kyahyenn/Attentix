const crypto = require('crypto');
const settings = require('../config/settings');

// Stateless HMAC-signed bearer token for the browser extension (and the optional student dashboard).
// Payload: { uid, exp, tv } plus, for students, { studentId, name, email, classId, classCode }. The token is SIGNED,
// not encrypted: its holder (the student) can read it, nobody can change it. The claims are a convenience for the
// client; the server never trusts them for authorisation: the student is re-loaded from the database on every use
// (so deleting a student takes effect immediately and a renamed student shows the new name), and `tv` (the user's
// tokenVersion) lets "sign out everywhere" revoke every token issued before it.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_TOKEN_LENGTH = 1024; // name (<=100) + email (<=254) + ids make a student token ~700 characters

// Domain-separated key so a token can never be confused with the session secret itself.
const key = () => crypto.createHmac('sha256', settings.extensionTokenSecret || settings.sessionSecret).update('attention-monitor:extension-token:v1').digest();

const b64 = (buf) => Buffer.from(buf).toString('base64url');

const sign = (body) => crypto.createHmac('sha256', key()).update(body).digest();

const STUDENT_CLAIMS = ['studentId', 'name', 'email', 'classId', 'classCode'];

const issueToken = (userId, now = Date.now(), tokenVersion = 0, claims = {}) => {
  // Only the known claim names are ever copied in, and they can never override uid/exp/tv.
  const extra = {};
  for (const claim of STUDENT_CLAIMS) if (typeof claims[claim] === 'string') extra[claim] = claims[claim];
  const body = b64(JSON.stringify({ ...extra, uid: userId, exp: now + TOKEN_TTL_MS, tv: tokenVersion }));
  return `${body}.${b64(sign(body))}`;
};

// Token for a passwordless student who joined `klass`. uid === studentId so the rest of the app keeps keying on uid.
const issueStudentToken = (student, klass, now = Date.now()) => issueToken(student.id, now, student.tokenVersion || 0, {
  studentId: student.id,
  name: student.name || student.legalName,
  email: student.email,
  classId: klass.id,
  classCode: klass.classCode
});

// Returns { uid, tv, ...studentClaims } or null for anything malformed, tampered with or expired.
const verifyTokenClaims = (token, now = Date.now()) => {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;

  const expected = sign(body);
  let provided;
  try { provided = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const { uid, exp, tv } = payload;
    if (typeof uid !== 'string' || typeof exp !== 'number' || exp <= now) return null;
    const claims = { uid, tv: Number.isInteger(tv) ? tv : 0 };
    for (const claim of STUDENT_CLAIMS) if (typeof payload[claim] === 'string') claims[claim] = payload[claim];
    return claims;
  } catch {
    return null;
  }
};

// Returns the user id, or null (kept for callers that do not care about revocation).
const verifyToken = (token, now = Date.now()) => {
  const claims = verifyTokenClaims(token, now);
  return claims ? claims.uid : null;
};

module.exports = { issueToken, issueStudentToken, verifyToken, verifyTokenClaims, TOKEN_TTL_MS };
