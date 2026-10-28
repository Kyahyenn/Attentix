const settings = require('../config/settings');

/** The educator's session user: the shape the dashboard pages read (they display `name`). */
const toSessionUser = (user) => ({
  id: user.id,
  username: user.username || user.email,
  role: user.role,
  legalName: user.legalName || user.name,
  name: user.legalName || user.name,
  // The UI uses this to pick the right "delete my account" confirmation (password vs. account email).
  hasPassword: typeof (user.password || user.passwordHash) === 'string'
});

// Regenerating the session id on login prevents session fixation.
const establishSession = (req, user) =>
  new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = user;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });

/** Clears the session cookie with the attributes it was set with; a browser ignores a clear that does not match. */
const clearSessionCookie = (res) =>
  res.clearCookie(settings.sessionCookieName, { httpOnly: true, sameSite: 'lax', secure: settings.cookieSecure });

module.exports = { toSessionUser, establishSession, clearSessionCookie };
