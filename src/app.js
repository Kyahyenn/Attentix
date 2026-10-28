const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const path = require('path');
const settings = require('./config/settings');
const { globalLimiter } = require('./middleware/limiter');
const { noStoreApi, originGuard } = require('./middleware/security');

const authRoutes = require('./routes/authRoutes');
const educatorAuthRoutes = require('./routes/educatorAuthRoutes');
const googleAuthRoutes = require('./routes/googleAuthRoutes');
const classRoutes = require('./routes/classRoutes');
const consentRoutes = require('./routes/consentRoutes');
const extensionRoutes = require('./routes/extensionRoutes');
const bundleRoutes = require('./routes/bundleRoutes');
const serverRoutes = require('./routes/serverRoutes');
const rosterRoutes = require('./routes/rosterRoutes');
const { sessionOrBearer } = require('./middleware/bearerAuth');

const app = express();

if (settings.trustProxy) app.set('trust proxy', settings.trustProxy);

// Scripts live in /js/*.js and Chart.js in /vendor: no inline script and no third-party host, so an injected <script> cannot run.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'connect-src': ["'self'", ...settings.wsOrigins],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      // Browsers would rewrite every http:// sub-resource to https:// and break plain-http (docker on localhost) setups.
      'upgrade-insecure-requests': settings.cookieSecure ? [] : null
    }
  }
}));
app.use(cors({
  origin: settings.corsOrigin,
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10kb' }));

// Unauthenticated liveness probe for Docker and uptime checks.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Static files first, so asset requests do not use the API rate limit. Pages are revalidated on every load, app
// scripts/styles are cached 5 minutes and the vendored Chart.js one day.
app.use(express.static(settings.paths.publicDir, {
  setHeaders: (res, filePath) => {
    let policy = 'public, max-age=300';
    if (filePath.endsWith('.html')) policy = 'no-cache';
    else if (filePath.includes(`${path.sep}vendor${path.sep}`)) policy = 'public, max-age=86400';
    res.setHeader('Cache-Control', policy);
  }
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(settings.paths.publicDir, 'login.html'));
});
// Clean invite URL: /join?classCode=ABC234 (the old /join.html?code=... links keep working).
app.get('/join', (req, res) => {
  res.sendFile(path.join(settings.paths.publicDir, 'join.html'));
});

app.use(globalLimiter);
app.use('/api', noStoreApi);
app.use('/api', originGuard);

const sessionMiddleware = session({
  name: settings.sessionCookieName,
  secret: settings.sessionSecret,
  // The default MemoryStore never evicts expired sessions (a slow memory leak); this one does.
  store: new MemoryStore({ checkPeriod: 60 * 60 * 1000, ttl: settings.sessionIdleMs }),
  resave: false,
  saveUninitialized: false,
  rolling: true, // idle timeout rather than a hard cut-off in the middle of a lecture
  cookie: {
    secure: settings.cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: settings.sessionIdleMs
  }
});

// Cookie session for EDUCATORS only. Students have no account: a valid `Authorization: Bearer` token from
// POST /api/extension/join bypasses it.
app.use(sessionOrBearer(sessionMiddleware));

app.use('/api/auth/educator', educatorAuthRoutes);
// Retired student Google sign-in: answers 410 / redirects to /join.html.
app.use('/api/auth', googleAuthRoutes);
app.use('/api/auth', authRoutes);
// Educator-only download of the student extension with the server address and class code already filled in.
app.use('/api/extension/preconfigured', bundleRoutes);
app.use('/api/extension', extensionRoutes);
app.use('/api/classes', classRoutes);
// Un-prefixed aliases used by the pages (/api/login, /api/me, /api/logout) plus the /api/student/* routes.
app.use('/api', authRoutes);
app.use('/api', consentRoutes);
app.use('/api', rosterRoutes);
// Server address + "Shut Down Server" for a professor running the app without a terminal.
app.use('/api', serverRoutes);

// Unknown API routes get JSON, not Express's default HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error('Unhandled request error:', err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

// Exported so src/index.js can bind the session to Socket.IO.
module.exports = { app, sessionMiddleware };
