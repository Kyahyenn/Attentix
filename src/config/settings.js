const bootstrap = require('../utils/bootstrap');

// Mutable files sit next to the executable when packaged, in the working directory otherwise (see utils/bootstrap.js).
const paths = bootstrap.resolvePaths();
require('dotenv').config({ path: paths.envFile });
// On Render (and similar) the host reports the public address; fill PUBLIC_URL / CORS_ORIGIN / TRUST_PROXY from it.
bootstrap.applyHostedDefaults();

const nodeEnv = process.env.NODE_ENV || 'development';
const DEFAULT_SECRET = 'fallback_development_secret_key_123';
const sessionSecret = process.env.SESSION_SECRET || DEFAULT_SECRET;

// Fail fast instead of silently running production with a guessable secret.
if (nodeEnv === 'production') {
  if (sessionSecret === DEFAULT_SECRET || sessionSecret.startsWith('replace_with')) {
    throw new Error('SESSION_SECRET must be set to a strong random value when NODE_ENV=production');
  }
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters when NODE_ENV=production (try: openssl rand -hex 32)');
  }
}

// Optional second secret just for the extension's bearer tokens, so rotating the session secret does not sign every
// student out. Unset (or still the template placeholder) = tokens are keyed from SESSION_SECRET as before.
const rawTokenSecret = process.env.EXTENSION_TOKEN_SECRET;
const extensionTokenSecret = rawTokenSecret && !/^(replace[_-]?with|change[_-]?me|your[_-]|example)/i.test(rawTokenSecret) ? rawTokenSecret : null;
if (nodeEnv === 'production' && extensionTokenSecret && extensionTokenSecret.length < 32) {
  throw new Error('EXTENSION_TOKEN_SECRET must be at least 32 characters when NODE_ENV=production (try: openssl rand -hex 32)');
}

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
// CORS_ORIGIN may list several origins separated by commas.
const allowedOrigins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);

// The CSP `connect-src` needs the WebSocket form of the app's own origin (older Safari does not match ws: to 'self').
const toWsOrigin = (origin) => origin.replace(/^http/i, 'ws');

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv,
  sessionSecret,
  corsOrigin: allowedOrigins.length > 1 ? allowedOrigins : allowedOrigins[0],
  allowedOrigins,
  wsOrigins: allowedOrigins.map(toWsOrigin),
  extensionTokenSecret,
  // Service-account JSON (or its base64) for Firestore. Set = accounts and classes are stored there instead of data/*.json.
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || null,
  // Set when students reach the server through a domain / reverse proxy instead of a LAN address (e.g. https://am.school.edu).
  publicUrl: process.env.PUBLIC_URL || null,
  // A relative DATA_DIR (the .env.example default is ./data) is relative to the executable / working directory, never to
  // wherever the process happened to be started from inside a packaged build.
  dataDir: bootstrap.resolveDataDir(paths),
  paths,
  // Secure cookies are dropped by browsers on plain http://. Set COOKIE_SECURE=false for http-only deployments.
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : nodeEnv === 'production',
  sessionCookieName: 'attention.sid',
  // Idle timeout: every authenticated request pushes the expiry forward ("rolling" session).
  sessionIdleMs: (Number(process.env.SESSION_IDLE_HOURS) || 8) * 60 * 60 * 1000,
  // Number of reverse-proxy hops in front of the app (0/unset = none). Needed for correct client IPs and secure cookies.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
  // Bump when privacy.html changes in a way that needs students to agree again.
  consentVersion: '2026-10',
  maxSocketsPerUser: 5,
  revalidateIntervalMs: 60 * 1000, // live sockets are re-checked against enrolment/consent this often
  staleTimeoutMs: 30000, // 30 seconds
  cleanupIntervalMs: 15000, // 15 seconds
  metricRetentionMs: 10 * 60 * 1000 // drop a silent student's metric after 10 minutes
};
