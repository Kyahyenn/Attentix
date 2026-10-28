// Routes talk to the live socket layer through app.locals.realtime (set in src/index.js).
// Without it (unit tests, scripts) every call is a harmless no-op.
const NOOP = {
  disconnectUser: () => 0,
  disconnectSession: () => 0,
  forgetUser: () => {},
  closeClass: () => 0,
  revalidate: async () => {},
  refreshEducatorViews: () => {},
  ingestHeartbeat: async () => ({ ok: false, status: 503, error: 'Live monitoring is not running on this server' })
};

module.exports = (req) => ({ ...NOOP, ...((req.app && req.app.locals && req.app.locals.realtime) || {}) });
