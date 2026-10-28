const crypto = require('crypto');
const db = require('../config/db');
const settings = require('../config/settings');

// A consent counts only if it is a "yes" to the CURRENT version of the privacy agreement.
// When privacy.html changes materially, bump settings.consentVersion and everyone is asked again.
const isConsentCurrent = (record) =>
  Boolean(record && record.agreedToMonitoring && record.version === settings.consentVersion);

const getConsent = async (userId) => (await db.readData('consents')).find((c) => c.userId === userId);

// Creates or updates the one consent record per user. The identity and the timestamp always come from the server.
const recordConsent = async (userId, agreedToMonitoring) => {
  const timestamp = new Date().toISOString();
  const version = settings.consentVersion;
  await db.mutate('consents', (consents) => {
    const index = consents.findIndex((c) => c.userId === userId);
    if (index >= 0) {
      consents[index] = { ...consents[index], agreedToMonitoring, timestamp, version };
    } else {
      consents.push({ id: crypto.randomUUID(), createdAt: Date.now(), userId, agreedToMonitoring, timestamp, version });
    }
  });
  return { accepted: agreedToMonitoring, version, timestamp };
};

module.exports = { isConsentCurrent, getConsent, recordConsent };
