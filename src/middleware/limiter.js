const rateLimit = require('express-rate-limit');

// A whole classroom often shares one NAT IP, so limits must be generous per IP.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  skipSuccessfulRequests: true, // only failed attempts count, so 40 students logging in at once don't lock each other out
  message: { error: 'Too many failed authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Per-ACCOUNT limit on failed logins. The per-IP limit above does nothing against an attacker who rotates IPs
// while guessing one educator's password. Generous enough (20 / 15 min) that a typo-prone user is never locked out.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `acct:${String((req.body && (req.body.email || req.body.username)) || 'none').toLowerCase().slice(0, 100)}`,
  message: { error: 'Too many failed attempts for this account, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Class codes are short, so guessing is throttled (failed lookups/joins only). Students have no account to key on, so
// the key is the client IP. A whole classroom often shares one NAT IP and typos are common, hence the generous
// ceiling: 60 misses per 15 minutes is still ~6,000 guesses a day against ~887 million possible codes.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  skipSuccessfulRequests: true,
  message: { error: 'Too many wrong class codes. Please wait a few minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Educator sign-up is open (the self-hosting professor creates the first account), so it is throttled per IP and
// EVERY attempt counts, successful or not: nobody needs to create more than a handful of educator accounts an hour.
const educatorSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many sign-up attempts. Please wait a while and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Extension heartbeats: one every 5 s is 180 per 15 minutes for a single student, so the global limit would starve them.
// Keyed by student (bearer token), falling back to the IP.
const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `hb:${(req.session && req.session.user && req.session.user.id) || req.ip}`,
  message: { error: 'Too many heartbeats. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { globalLimiter, authLimiter, accountLimiter, joinLimiter, educatorSignupLimiter, heartbeatLimiter };
