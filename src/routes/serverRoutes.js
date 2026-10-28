'use strict';

const express = require('express');
const settings = require('../config/settings');
const bootstrap = require('../utils/bootstrap');
const { requireEducator } = require('../middleware/auth');
const realtimeOf = require('../utils/realtime');
const { clearSessionCookie } = require('../utils/session');
const { version } = require('../../package.json');

const router = express.Router();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * "Is the professor sitting at the computer that runs this server?" Educator sign-up is open, so being an educator is not
 * enough to stop a shared server. The request must come over loopback, carry no proxy headers (a local reverse proxy
 * would otherwise make every visitor look local) and use a localhost Host header (which also defeats DNS rebinding).
 */
const isLocalRequest = (req) => {
  const remote = req.socket && req.socket.remoteAddress;
  const proxied = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers['x-real-ip'];
  return LOOPBACK.has(remote) && !proxied && bootstrap.isLoopbackHost(req.headers.host || '');
};

const canShutdown = (req) => typeof req.app.locals.requestShutdown === 'function' && isLocalRequest(req);

// GET /api/server-info: the addresses students can use, shown on the educator dashboard.
router.get('/server-info', requireEducator, (req, res) => {
  res.json({
    ...bootstrap.getServerInfo({ port: settings.port }),
    version,
    packaged: settings.paths.packaged,
    canShutdown: canShutdown(req)
  });
});

// POST /api/server/shutdown: the "Shut Down Server" button, for a professor running without a terminal window.
// POST /api/server/shutdown: the "Shut Down Server" button. Only the launcher (src/index.js) installs `app.locals.requestShutdown`,
// so a test run can never stop anything.
router.post('/server/shutdown', requireEducator, (req, res) => {
  if (typeof req.app.locals.requestShutdown !== 'function') {
    return res.status(503).json({ error: 'Shutdown is only available when the server was started with the launcher.' });
  }
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'The server can only be shut down from the computer it runs on.' });
  }
  res.on('finish', () => setImmediate(() => req.app.locals.requestShutdown('dashboard')));
  return res.json({ ok: true, message: 'Shutting down. You can close this tab.' });
});

// POST /api/server/sign-out: "Log out". Also stops the server when the educator is at the computer that runs it (the launcher
// installs requestShutdown; Docker, proxies and tests never do). From any other computer it is an ordinary sign-out.
router.post('/server/sign-out', requireEducator, (req, res) => {
  const sessionId = req.sessionID;
  const realtime = realtimeOf(req);
  const stopping = canShutdown(req);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Failed to logout' });
    realtime.disconnectSession(sessionId, 'You signed out.');
    clearSessionCookie(res);
    if (stopping) res.on('finish', () => setImmediate(() => req.app.locals.requestShutdown('educator sign-out')));
    return res.json({ message: 'Logout successful', stopped: stopping });
  });
});

module.exports = router;
module.exports.isLocalRequest = isLocalRequest;
