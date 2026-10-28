'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const settings = require('../config/settings');
const bootstrap = require('../utils/bootstrap');
const { requireEducator } = require('../middleware/auth');
const { validate, ClassCodeQuerySchema } = require('../utils/validation');
const { findClassByCode } = require('../utils/classes');
const { buildExtensionZip, renderConfigJs } = require('../utils/extensionBundle');

const router = express.Router();

// Keeps the educator's own unpacked extension folder in step with the class they last downloaded for. Skipped inside a
// packaged executable (its extension/ is a read-only snapshot) and under `npm test` unless a test names a target file.
const localConfigTarget = (req) => {
  if (req.app.locals.extensionConfigPath) return req.app.locals.extensionConfigPath;
  if (settings.paths.packaged || settings.nodeEnv === 'test') return null;
  return path.join(settings.paths.extensionDir, 'config.js');
};

// GET /api/extension/preconfigured?classCode=ABC234  ->  Attentix-Extension-ABC234.zip
router.get('/', requireEducator, validate(ClassCodeQuerySchema, 'query'), async (req, res, next) => {
  try {
    const klass = await findClassByCode(req.query.classCode);
    // Same answer for "no such class" and "someone else's class": a class code is never confirmed to a stranger.
    if (!klass || klass.educatorId !== req.session.user.id) return res.status(404).json({ error: 'No class found for that class code' });

    const serverUrl = bootstrap.serverUrlForStudents({ requestHost: req.get('host'), requestProtocol: req.protocol, port: settings.port });
    const now = new Date();
    const zip = buildExtensionZip({ extensionDir: settings.paths.extensionDir, serverUrl, classCode: klass.classCode, now });

    const target = localConfigTarget(req);
    if (target) {
      try {
        await fs.promises.writeFile(target, renderConfigJs({ serverUrl: new URL(serverUrl).origin, classCode: klass.classCode, generatedAt: now }));
      } catch (err) {
        console.warn(`Could not update ${target}: ${err.message}`);
      }
    }

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="Attentix-Extension-${klass.classCode}.zip"`,
      'Content-Length': String(zip.length),
      'X-Server-Url': serverUrl
    });
    return res.send(zip);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
