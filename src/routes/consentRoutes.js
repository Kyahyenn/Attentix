const express = require('express');
const { validate, ConsentSchema, StudentConsentSchema } = require('../utils/validation');
const { requireAuth } = require('../middleware/auth');
const { joinLimiter } = require('../middleware/limiter');
const { identityFailureLimiter, settleUnlessBearer } = require('../middleware/identityGuard');
const settings = require('../config/settings');
const { isConsentCurrent, getConsent, recordConsent } = require('../utils/consent');
const { resolveStudent } = require('../utils/accounts');
const realtimeOf = require('../utils/realtime');

const router = express.Router();

// Stores the decision. Withdrawing consent must take effect NOW: stop every live connection and discard what was
// collected. Shared by the signed-in route and the passwordless student route.
const applyDecision = async (req, userId, decision) => {
  const accepted = decision === 'accept';
  const record = await recordConsent(userId, accepted);
  if (!accepted) {
    const realtime = realtimeOf(req);
    realtime.disconnectUser(userId, 'You withdrew your consent. Monitoring has stopped.');
    realtime.forgetUser(userId);
  }
  return record;
};

// Mounted at /api, so these are GET /api/consent-status and POST /api/consent (what the frontend calls).
router.get('/consent-status', requireAuth, async (req, res) => {
  try {
    const record = await getConsent(req.session.user.id);
    res.json({ accepted: isConsentCurrent(record), version: settings.consentVersion, timestamp: record ? record.timestamp : null });
  } catch (err) {
    console.error('Consent status failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/consent', requireAuth, validate(ConsentSchema), async (req, res) => {
  try {
    await applyDecision(req, req.session.user.id, req.body.decision);
    res.status(200).json({ message: 'Consent recorded successfully', accepted: req.body.decision === 'accept' });
  } catch (err) {
    console.error('Consent save failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/student/consent - passwordless students manage their consent. Either send `Authorization: Bearer <token>`
// with { decision }, or { name?, email, classCode, decision } when no token is at hand.
const pickConsentSchema = (req, res, next) =>
  validate(req.session && req.session.viaBearer ? ConsentSchema : StudentConsentSchema)(req, res, next);

router.post('/student/consent', joinLimiter, pickConsentSchema, identityFailureLimiter, async (req, res) => {
  const startedAt = Date.now();
  try {
    const found = await resolveStudent(req, req.body);
    if (!found) {
      await settleUnlessBearer(req, startedAt);
      return res.status(404).json({ error: 'No student found for that email and class code.' });
    }
    const record = await applyDecision(req, found.student.id, req.body.decision);
    await settleUnlessBearer(req, startedAt);
    res.json({ message: 'Consent recorded successfully', accepted: record.accepted, version: record.version, timestamp: record.timestamp });
  } catch (err) {
    console.error('Student consent failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
