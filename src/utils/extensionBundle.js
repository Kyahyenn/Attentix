'use strict';

const fs = require('fs');
const path = require('path');
const { createZip } = require('./zip');

// Files that are not part of the extension itself.
const SKIP = (name) => name.startsWith('.') || name === 'node_modules' || /\.md$/i.test(name);

const walk = (dir, base = '') => {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP(dirent.name)) continue;
    const rel = base ? `${base}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) out.push(...walk(path.join(dir, dirent.name), rel));
    else if (dirent.isFile()) out.push(rel);
  }
  return out.sort();
};

const toOrigin = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server URL must be http(s)');
  return url.origin;
};

/** The text of extension/config.js: what the popup (and the background worker) read as their defaults. */
const renderConfigJs = ({ serverUrl = '', classCode = '', generatedAt = new Date() } = {}) => `// Auto-populated by the Professor's Host Server (Attentix) on ${generatedAt.toISOString()}.
// The popup pre-fills the Server address and Class code from here. Safe to edit by hand; leave blank to type them in.
globalThis.AMP_PRECONFIG = {
  serverUrl: ${JSON.stringify(serverUrl)},
  classCode: ${JSON.stringify(classCode)}
};
`;

/**
 * The extension folder as a list of { name, data }, with config.js pre-filled and the manifest allowed to talk to the
 * professor's server out of the box (host_permissions is granted when the unpacked extension is loaded, so the student
 * is not asked for a separate permission).
 */
const buildExtensionFiles = ({ extensionDir, serverUrl, classCode, now = new Date() }) => {
  const origin = toOrigin(serverUrl);
  return walk(extensionDir).map((name) => {
    let data = fs.readFileSync(path.join(extensionDir, name));
    if (name === 'config.js') data = Buffer.from(renderConfigJs({ serverUrl: origin, classCode, generatedAt: now }), 'utf8');
    if (name === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      const pattern = `${origin}/*`;
      manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions || []), pattern]));
      data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    return { name, data };
  });
};

const buildExtensionZip = (options) => {
  const files = buildExtensionFiles(options);
  if (!files.some((f) => f.name === 'config.js')) {
    files.push({ name: 'config.js', data: Buffer.from(renderConfigJs({ serverUrl: toOrigin(options.serverUrl), classCode: options.classCode, generatedAt: options.now }), 'utf8') });
  }
  return createZip(files, { date: options.now || new Date() });
};

module.exports = { renderConfigJs, buildExtensionFiles, buildExtensionZip, toOrigin };
