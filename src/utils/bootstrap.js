'use strict';

/**
 * Zero-config start-up helpers for a professor who double-clicks the app instead of using a terminal.
 *
 * This file must not require ../config/settings: settings reads the .env that ensureEnv() creates here.
 *
 * Sections: where files live (resolvePaths), .env generation (ensureEnv), network addresses (getServerInfo,
 * serverUrlForStudents), opening the browser (openBrowser), and the one-server-per-data-directory lock
 * (acquireInstanceLock, waitForRunningServer).
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---- where things live ----

const isSea = () => {
  try { return require('node:sea').isSea(); } catch { return false; }
};

// True inside a single-file executable (vercel/pkg + @yao-pkg/pkg set process.pkg; Node SEA has node:sea).
const isPackaged = () => Boolean(process.pkg) || isSea();

/**
 * Mutable files (.env, data/) sit next to the executable when packaged (the bundle itself is read-only) and in the
 * current working directory otherwise. Bundled read-only assets always resolve from this file's location, which is the
 * virtual snapshot inside a packaged build.
 */
const resolvePaths = ({ packaged = isPackaged(), execPath = process.execPath, cwd = process.cwd(), srcDir = __dirname } = {}) => {
  const baseDir = packaged ? path.dirname(execPath) : cwd;
  const assetRoot = path.resolve(srcDir, '..', '..');
  return {
    packaged,
    baseDir,
    envFile: path.join(baseDir, '.env'),
    dataDir: path.join(baseDir, 'data'),
    assetRoot,
    publicDir: path.join(assetRoot, 'public'),
    extensionDir: path.join(assetRoot, 'extension'),
    envTemplate: path.join(assetRoot, '.env.example')
  };
};

/** DATA_DIR from the environment (relative = next to the executable / working directory) or the default data/ folder. */
const resolveDataDir = (paths = resolvePaths(), env = process.env) => (env.DATA_DIR ? path.resolve(paths.baseDir, env.DATA_DIR) : paths.dataDir);

// ---- .env generation ----

const PLACEHOLDER = /^(replace[_-]?with|change[_-]?me|your[_-]|example|fallback_)/i;
const newSecret = () => crypto.randomBytes(32).toString('hex');
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
// `KEY=value # comment`: dotenv drops the comment of an unquoted value, so do the same before judging the value.
const cleanValue = (raw) => (/^\s*['"]/.test(raw) ? unquote(raw) : raw.replace(/\s+#.*$/, '').trim());

const isStrongSecret = (value) => typeof value === 'string' && value.length >= 32 && !PLACEHOLDER.test(value);
const needsValue = (value) => value === undefined || value === '' || PLACEHOLDER.test(value);

const FALLBACK_TEMPLATE = [
  '# Created automatically by Attentix on first start. Safe to edit.',
  'NODE_ENV=production',
  'PORT=3000',
  'SESSION_SECRET=',
  'CORS_ORIGIN=http://localhost:3000',
  'DATA_DIR=./data',
  'COOKIE_SECURE=false',
  ''
].join('\n');

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const parseEnvLines = (text) => {
  const lines = text.split(/\r?\n/);
  const index = new Map(); // key -> line number of its (last) active assignment
  lines.forEach((line, i) => {
    const m = ENV_LINE.exec(line);
    if (m) index.set(m[1], { line: i, value: cleanValue(m[2]) });
  });
  return { lines, index };
};

const isPortFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port);
});

// First free port at or after `start`.
const findFreePort = async (start = 3000, { tries = 50, isFree = isPortFree } = {}) => {
  for (let port = start; port < start + tries && port <= 65535; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + tries - 1}`);
};

/**
 * Makes sure a usable .env exists. Rules:
 *  - a missing file is created from .env.example (or a built-in fallback);
 *  - SESSION_SECRET and EXTENSION_TOKEN_SECRET are generated only when missing, blank or still the template placeholder;
 *  - PORT is chosen (first free from 3000) only for a new file or when the key is missing; an explicit PORT is respected;
 *  - nothing else the professor wrote is ever changed; the file is written atomically with owner-only permissions;
 *  - data/ is created;
 *  - AUTO_ENV=false (Docker) or a strong SESSION_SECRET in the real environment with no .env file means: do nothing.
 */
const ensureEnv = async ({ paths = resolvePaths(), env = process.env, isFree = isPortFree, secret = newSecret } = {}) => {
  const result = { skipped: false, reason: null, created: false, updated: [], port: null, envFile: paths.envFile };
  if (env.AUTO_ENV === 'false') return { ...result, skipped: true, reason: 'AUTO_ENV=false' };

  const exists = fs.existsSync(paths.envFile);
  if (!exists && isStrongSecret(env.SESSION_SECRET)) return { ...result, skipped: true, reason: 'configured through the environment' };

  let text;
  if (exists) text = fs.readFileSync(paths.envFile, 'utf8');
  else if (fs.existsSync(paths.envTemplate)) text = fs.readFileSync(paths.envTemplate, 'utf8');
  else text = FALLBACK_TEMPLATE;

  const { lines, index } = parseEnvLines(text);
  const set = (key, value) => {
    const found = index.get(key);
    if (found) lines[found.line] = `${key}=${value}`;
    else {
      // keep one trailing blank line out of the way
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${value}`, '');
      index.set(key, { line: lines.length - 2, value });
    }
    result.updated.push(key);
  };
  const current = (key) => (index.get(key) ? index.get(key).value : undefined);

  if (!exists) result.created = true;

  // A too-short secret under NODE_ENV=production makes the server refuse to start (and a double-clicked app just vanishes).
  const weakInProduction = current('NODE_ENV') === 'production' && !isStrongSecret(current('SESSION_SECRET'));
  if (needsValue(current('SESSION_SECRET')) || weakInProduction) set('SESSION_SECRET', secret());
  if (needsValue(current('EXTENSION_TOKEN_SECRET'))) set('EXTENSION_TOKEN_SECRET', secret());

  const existingPort = current('PORT');
  let port = Number(existingPort);
  if (!exists || !existingPort || !Number.isInteger(port)) {
    const wanted = Number.isInteger(port) && port > 0 ? port : 3000;
    port = await findFreePort(wanted, { isFree });
    if (String(port) !== existingPort) set('PORT', String(port));
  }
  result.port = port;

  const cors = current('CORS_ORIGIN');
  if (needsValue(cors) || (!exists && cors === 'http://localhost:3000' && port !== 3000)) set('CORS_ORIGIN', `http://localhost:${port}`);
  if (!exists && paths.packaged) set('NODE_ENV', 'production');

  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });

  if (result.created || result.updated.length) {
    fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
    const tmp = `${paths.envFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, paths.envFile);
  }
  return result;
};

// ---- network addresses ----

const VIRTUAL_NAME = /virtual|vbox|vmware|vmnet|hyper-v|vethernet|docker|wsl|bluetooth|loopback|tailscale|zerotier|utun|\bveth|\bbr-|virbr/i;

const privateRank = (address) => {
  const [a, b] = address.split('.').map(Number);
  if (a === 192 && b === 168) return 1;
  if (a === 10) return 2;
  if (a === 172 && b >= 16 && b <= 31) return 3;
  return 4; // public or CGNAT: usable, least likely to be the classroom network
};

/** Active, non-loopback IPv4 addresses, the most likely classroom-network address first. */
const detectLanAddresses = (interfaces = os.networkInterfaces()) => {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !a.address || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address, rank: (VIRTUAL_NAME.test(name) ? 10 : 0) + privateRank(a.address) });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map(({ name, address }) => ({ name, address }));
};

const HOST_OK = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;
const hostnameOf = (host) => String(host).replace(/:\d+$/, '');
const isLoopbackHost = (host) => /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(hostnameOf(host));

const cleanPublicUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
};

/** Everything the dashboard and the pre-configured extension need to know about this server's addresses. */
const getServerInfo = ({ port, env = process.env, interfaces = os.networkInterfaces() } = {}) => {
  const lan = detectLanAddresses(interfaces);
  const lanUrls = lan.map((l) => `http://${l.address}:${port}`);
  const publicUrl = cleanPublicUrl(env.PUBLIC_URL);
  const localUrl = `http://localhost:${port}`;
  return { port: Number(port), localUrl, lanUrl: lanUrls[0] || null, lanUrls, hasLan: lanUrls.length > 0, publicUrl, preferredUrl: publicUrl || lanUrls[0] || localUrl };
};

/**
 * The address to bake into a student's extension: PUBLIC_URL if the professor set one; else the address the professor
 * is browsing with when it is not loopback (so a domain or LAN name that works for them works for students); else the
 * detected LAN address; else localhost (works only on this computer).
 */
const serverUrlForStudents = ({ requestHost, requestProtocol = 'http', port, env = process.env, interfaces = os.networkInterfaces() }) => {
  const info = getServerInfo({ port, env, interfaces });
  if (info.publicUrl) return info.publicUrl;
  if (requestHost && HOST_OK.test(requestHost) && !isLoopbackHost(requestHost)) return `${requestProtocol === 'https' ? 'https' : 'http'}://${requestHost}`;
  return info.preferredUrl;
};

/**
 * Cloud hosts tell the app its own public address (Render sets RENDER_EXTERNAL_URL). Use it as the default PUBLIC_URL and
 * CORS_ORIGIN, and assume one reverse proxy, so a hosted deploy needs no address configuration. Values the owner set
 * themselves are never touched. Returns the keys it filled in.
 */
const applyHostedDefaults = (env = process.env) => {
  const filled = [];
  const external = cleanPublicUrl(env.RENDER_EXTERNAL_URL);
  if (!external) return filled;
  const setIfBlank = (key, value) => {
    if (env[key] === undefined || String(env[key]).trim() === '') { env[key] = value; filled.push(key); }
  };
  setIfBlank('PUBLIC_URL', external);
  setIfBlank('CORS_ORIGIN', external);
  setIfBlank('TRUST_PROXY', '1');
  return filled;
};

// ---- opening the browser ----

// Only our own http(s) pages on a plain host:port are ever opened, which is also what makes the Windows `start` command
// below safe: nothing in such a URL can be interpreted by cmd.exe (no quotes, &, ^, %, spaces).
const SAFE_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

/** Never during `npm test`, never when NO_AUTO_OPEN=true. */
const shouldAutoOpen = (env = process.env) => env.NODE_ENV !== 'test' && !env.JEST_WORKER_ID && env.NO_AUTO_OPEN !== 'true';

const startUrl = ({ port, hasEducator }) => `http://localhost:${port}/${hasEducator ? 'educator-dashboard.html' : 'educator-signup.html'}`;

const openBrowser = (url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) => {
  if (!shouldAutoOpen(env) || !SAFE_URL.test(url)) return false;
  let command; let args; let options = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
    options = { ...options, windowsVerbatimArguments: true, windowsHide: true };
  } else if (platform === 'darwin') {
    command = 'open'; args = [url];
  } else {
    command = 'xdg-open'; args = [url];
  }
  try {
    const child = spawnFn(command, args, options);
    if (child && typeof child.on === 'function') child.on('error', () => { /* no browser on this machine (headless server): fine */ });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
};

/** Like openBrowser, but resolves only once the launcher process has handed over (so a quick process.exit cannot cut it off). */
const openBrowserAndWait = (url, opts = {}) => new Promise((resolve) => {
  const spawnFn = opts.spawnFn || spawn;
  let child = null;
  const ok = openBrowser(url, { ...opts, spawnFn: (...args) => { child = spawnFn(...args); return child; } });
  if (!ok || !child || typeof child.once !== 'function') { resolve(ok); return; }
  // The launcher normally exits within a moment; if it does not, stop waiting after 3 s.
  const failsafe = setTimeout(() => resolve(true), 3000);
  const settle = (result) => { clearTimeout(failsafe); resolve(result); };
  child.once('exit', () => setTimeout(() => settle(true), opts.settleMs === undefined ? 400 : opts.settleMs));
  child.once('error', () => settle(false));
});

/** True when users.json already holds an educator (read straight from disk: the running server owns the files). */
const hasEducatorOnDisk = (dataDir) => {
  try {
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    return Array.isArray(users) && users.some((u) => u && u.role === 'educator');
  } catch { return false; }
};

// ---- one server per data directory ----

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

const healthy = (port, timeoutMs = 1500) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});

const STARTING_GRACE_MS = 15000; // a server that is still starting up has a lock but is not answering yet

/**
 * Two servers writing the same JSON files would corrupt them, and a silent launcher makes a second double-click easy.
 * Returns { acquired: true, update(port), release() } or { acquired: false, existing: { pid, port } }.
 */
const acquireInstanceLock = async ({ lockFile, port = 0, pid = process.pid, isAlive = pidAlive, isHealthy = healthy, now = Date.now } = {}) => {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const write = (data) => fs.writeFileSync(lockFile, JSON.stringify(data), { mode: 0o600 });
  const mine = { pid, port, startedAt: now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* unreadable lock = stale */ }
      const running = existing && existing.pid !== pid && isAlive(existing.pid)
        && ((now() - (existing.startedAt || 0)) < STARTING_GRACE_MS || await isHealthy(existing.port));
      if (running) return { acquired: false, existing: { pid: existing.pid, port: existing.port } };
      try { fs.unlinkSync(lockFile); } catch { /* raced with another cleanup */ }
      if (attempt === 1) throw new Error('Could not take the server lock');
    }
  }

  let released = false;
  return {
    acquired: true,
    update: (newPort) => { mine.port = newPort; if (!released) write(mine); },
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.pid === pid) fs.unlinkSync(lockFile);
      } catch { /* already gone */ }
    }
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A second double-click while the app runs (or is still starting). Waits until the running server answers, then returns
 * its port. Returns null when the lock vanished (that server quit) or nothing answered in time (a stale lock).
 */
const waitForRunningServer = async ({ lockFile, existing, timeoutMs = 60000, intervalMs = 300, isHealthy = healthy, onWait = () => {}, now = Date.now, wait = sleep }) => {
  const started = now();
  let port = existing.port;
  let announced = false;
  while (now() - started < timeoutMs) {
    if (await isHealthy(port)) return port;
    if (!announced && now() - started > 1500) { announced = true; onWait(); }
    await wait(intervalMs);
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock.pid !== existing.pid) return null;   // another owner took over
      port = lock.port;                              // the server moves it when its first port was busy
    } catch { return null; }                         // lock gone: the server stopped
  }
  return null;
};

module.exports = {
  resolveDataDir,
  openBrowserAndWait,
  hasEducatorOnDisk,
  waitForRunningServer,
  isPackaged,
  resolvePaths,
  ensureEnv,
  findFreePort,
  isPortFree,
  detectLanAddresses,
  getServerInfo,
  applyHostedDefaults,
  serverUrlForStudents,
  isLoopbackHost,
  shouldAutoOpen,
  startUrl,
  openBrowser,
  acquireInstanceLock
};
