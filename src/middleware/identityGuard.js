const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const settings = require('../config/settings');

// Guards for the credential-less student endpoints (POST /api/student/lookup and /api/student/consent), where
// "email + class code" is the only proof of identity. See docs of each export for what it does and does not stop.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_PER_IDENTITY = 12;
const MIN_RESPONSE_MS = 180;
const RESPONSE_JITTER_MS = 60;

// Domain-separated HMAC key: the limiter store and logs never hold a raw email address.
const FINGERPRINT_KEY = crypto
  .createHmac('sha256', settings.extensionTokenSecret || settings.sessionSecret)
  .update('attentix:identity-guard:v1')
  .digest();

// Stable, case-insensitive fingerprint of one (classCode, email) identity.
const identityFingerprint = (email, classCode) => crypto
  .createHmac('sha256', FINGERPRINT_KEY)
  .update(`${String(classCode).trim().toUpperCase()}\n${String(email).trim().toLowerCase()}`)
  .digest('hex');

const isBearer = (req) => Boolean(req.session && req.session.viaBearer);

// Per-IDENTITY limit on FAILED attempts. The per-IP joinLimiter cannot stop an attacker who rotates IPs, and a whole
// classroom shares one NAT IP, so this one is keyed by the identity being probed instead. Place it AFTER validate()
// so req.body is already normalised. Only 4xx/5xx responses count, so a student's own polling is never throttled.
// Trade-off: someone who knows a victim's email can lock that identity's lookups for the window (a nuisance, not a leak).
const identityFailureLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_FAILED_PER_IDENTITY,
  skipSuccessfulRequests: true,
  skip: isBearer,
  keyGenerator: (req) => `identity:${identityFingerprint(req.body.email, req.body.classCode)}`,
  message: { error: 'Too many failed attempts for these details. Please wait a few minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Resolves once a randomised minimum time has passed since `startedAt`, so "class not found", "student not found" and
// "found" cannot be told apart by how long the response took.
const settle = async (startedAt, { minMs = MIN_RESPONSE_MS, jitterMs = RESPONSE_JITTER_MS } = {}) => {
  const target = minMs + crypto.randomInt(0, jitterMs + 1);
  const remaining = target - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
};

// Bearer callers (the extension, the join flow) are already authenticated and poll often: no artificial delay for them.
const settleUnlessBearer = (req, startedAt) => (isBearer(req) ? Promise.resolve() : settle(startedAt));

module.exports = { identityFingerprint, identityFailureLimiter, settle, settleUnlessBearer, MAX_FAILED_PER_IDENTITY, WINDOW_MS };
