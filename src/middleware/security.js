const settings = require('../config/settings');

// API responses contain personal data (names, attention state): never let a browser or proxy cache them.
const noStoreApi = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Defence in depth on top of SameSite=Lax: a state-changing request with a cookie session must come from this app's own
// origin. Requests with no Origin header (curl, tests) and bearer-token requests (the extension) are not checked.
const originGuard = (req, res, next) => {
  if (SAFE_METHODS.has(req.method) || req.headers.authorization) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  // The extension popup calls /api/extension/* from a chrome-extension:// origin. It sends no cookies, so there is no session to abuse.
  if (origin.startsWith('chrome-extension://') && req.originalUrl.startsWith('/api/extension/')) return next();
  const sameHost = `${req.protocol}://${req.get('host')}`;
  if (origin === sameHost || settings.allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ error: 'Cross-origin request blocked' });
};

// Same check for WebSocket handshakes (cross-site WebSocket hijacking). Browsers always send Origin; the extension's
// service worker sends chrome-extension://<id> and authenticates with a bearer token.
const isAllowedSocketOrigin = (origin, host) => {
  if (!origin) return true; // non-browser clients (tests, scripts) - they still need a session or token
  if (origin.startsWith('chrome-extension://')) return true;
  if (settings.allowedOrigins.includes(origin)) return true;
  try { return new URL(origin).host === host; } catch { return false; }
};

// For endpoints removed on purpose (student passwords, Google sign-in): API clients get `410 Gone` with a pointer;
// browser navigations (`redirect: true`) are sent to the join page.
const JOIN_PAGE = '/join.html';
const retired = (message, { redirect = false } = {}) => (req, res) => {
  if (redirect) return res.redirect(JOIN_PAGE);
  res.status(410).json({ error: message, redirect: JOIN_PAGE, joinEndpoint: '/api/extension/join' });
};

module.exports = { noStoreApi, originGuard, isAllowedSocketOrigin, retired };
