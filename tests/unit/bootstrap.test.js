/** src/utils/bootstrap.js: executable-safe paths, zero-config .env, LAN detection, browser launch rules, instance lock. */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const bootstrap = require('../../src/utils/bootstrap');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amp-bootstrap-'));
const parse = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const always = async () => true;
const HEX64 = /^[0-9a-f]{64}$/;

describe('resolvePaths: mutable files vs bundled assets', () => {
  test('packaged: .env and data/ sit next to the executable; assets come from the bundle location, not the executable folder', () => {
    const p = bootstrap.resolvePaths({ packaged: true, execPath: '/opt/prof/Attentix-linux', cwd: '/somewhere/else', srcDir: '/snapshot/app/src/utils' });
    expect(p.baseDir).toBe('/opt/prof');
    expect(p.envFile).toBe(path.join('/opt/prof', '.env'));
    expect(p.dataDir).toBe(path.join('/opt/prof', 'data'));
    expect(p.publicDir).toBe(path.join('/snapshot/app', 'public'));
    expect(p.extensionDir).toBe(path.join('/snapshot/app', 'extension'));
    expect(p.envTemplate).toBe(path.join('/snapshot/app', '.env.example'));
  });

  test('plain Node.js: .env and data/ are relative to the working directory; assets still come from the source tree', () => {
    const p = bootstrap.resolvePaths({ packaged: false, execPath: '/usr/bin/node', cwd: '/home/prof/attention' });
    expect(p.baseDir).toBe('/home/prof/attention');
    expect(p.envFile).toBe(path.join('/home/prof/attention', '.env'));
    expect(p.dataDir).toBe(path.join('/home/prof/attention', 'data'));
    expect(p.publicDir).toBe(path.resolve(__dirname, '../../public'));
    expect(p.extensionDir).toBe(path.resolve(__dirname, '../../extension'));
  });

  test('this test run is not "packaged"', () => {
    expect(bootstrap.isPackaged()).toBe(false);
  });
});

describe('ensureEnv: generates what is missing and never overwrites what is there', () => {
  const setup = (existing) => {
    const dir = tmp();
    const paths = bootstrap.resolvePaths({ packaged: false, cwd: dir });
    if (existing !== undefined) fs.writeFileSync(paths.envFile, existing);
    return { dir, paths };
  };

  test('no .env: created from .env.example with random 64-hex secrets, PORT, CORS_ORIGIN and data/; owner-only permissions', async () => {
    const { paths } = setup();
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(res).toMatchObject({ created: true, skipped: false, port: 3000 });
    const env = parse(paths.envFile);
    expect(env.SESSION_SECRET).toMatch(HEX64);
    expect(env.EXTENSION_TOKEN_SECRET).toMatch(HEX64);
    expect(env.SESSION_SECRET).not.toBe(env.EXTENSION_TOKEN_SECRET);
    expect(env).toMatchObject({ PORT: '3000', CORS_ORIGIN: 'http://localhost:3000', DATA_DIR: './data', COOKIE_SECURE: 'false' });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toMatch(/# Application Core/); // the template's comments survive
    expect(fs.statSync(paths.dataDir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.envFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.dataDir).mode & 0o777).toBe(0o700);
    }
  });

  test('every run generates different secrets', async () => {
    const a = setup(); const b = setup();
    await bootstrap.ensureEnv({ paths: a.paths, env: {}, isFree: always });
    await bootstrap.ensureEnv({ paths: b.paths, env: {}, isFree: always });
    expect(parse(a.paths.envFile).SESSION_SECRET).not.toBe(parse(b.paths.envFile).SESSION_SECRET);
  });

  test('a complete .env is left byte-for-byte alone (nothing is rewritten, not even the timestamp)', async () => {
    const own = `# mine\nSESSION_SECRET=${'a'.repeat(40)}\nEXTENSION_TOKEN_SECRET=${'b'.repeat(40)}\nPORT=4100\nCORS_ORIGIN=https://am.school.edu\n`;
    const { paths } = setup(own);
    const before = fs.statSync(paths.envFile).mtimeMs;
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(res).toMatchObject({ created: false, updated: [], port: 4100 });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(own);
    expect(fs.statSync(paths.envFile).mtimeMs).toBe(before);
  });

  test('an existing SESSION_SECRET (even a short one the professor chose), PORT, CORS_ORIGIN, comments and unknown keys are never overwritten; only gaps are filled', async () => {
    const { paths } = setup('# keep me\nSESSION_SECRET=my-own-short-secret\nPORT=4100\nCORS_ORIGIN=https://am.school.edu\nTRUST_PROXY=1\n');
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(res.updated).toEqual(['EXTENSION_TOKEN_SECRET']);
    const text = fs.readFileSync(paths.envFile, 'utf8');
    expect(text).toMatch(/^# keep me$/m);
    expect(parse(paths.envFile)).toMatchObject({ SESSION_SECRET: 'my-own-short-secret', PORT: '4100', CORS_ORIGIN: 'https://am.school.edu', TRUST_PROXY: '1' });
    expect(parse(paths.envFile).EXTENSION_TOKEN_SECRET).toMatch(HEX64);
  });

  test('blank values and the template placeholder count as missing; quoted real values and trailing comments do not', async () => {
    const real = 'q'.repeat(40);
    const { paths } = setup(`SESSION_SECRET=replace_with_a_secure_random_string_in_production\nEXTENSION_TOKEN_SECRET=\nPORT=3000 # keep\nCORS_ORIGIN="http://localhost:3000"\n`);
    await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    const env = parse(paths.envFile);
    expect(env.SESSION_SECRET).toMatch(HEX64);
    expect(env.EXTENSION_TOKEN_SECRET).toMatch(HEX64);
    expect(env.PORT).toBe('3000 # keep'); // untouched
    expect(env.CORS_ORIGIN).toBe('"http://localhost:3000"');

    const quoted = setup(`SESSION_SECRET="${real}"\nEXTENSION_TOKEN_SECRET='${real}'\n`);
    const res = await bootstrap.ensureEnv({ paths: quoted.paths, env: {}, isFree: always });
    expect(res.updated).not.toContain('SESSION_SECRET');
    expect(res.updated).not.toContain('EXTENSION_TOKEN_SECRET');
  });

  test('running it twice changes nothing the second time', async () => {
    const { paths } = setup();
    await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    const first = fs.readFileSync(paths.envFile, 'utf8');
    const second = await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(second).toMatchObject({ created: false, updated: [] });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(first);
  });

  test('a new .env picks the next free port when 3000 is taken, and CORS_ORIGIN follows it', async () => {
    const { paths } = setup();
    const taken = new Set([3000, 3001]);
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: async (port) => !taken.has(port) });
    expect(res.port).toBe(3002);
    expect(parse(paths.envFile)).toMatchObject({ PORT: '3002', CORS_ORIGIN: 'http://localhost:3002' });
  });

  test('an explicit PORT in an existing .env is respected even when it is busy (the professor asked for it)', async () => {
    const { paths } = setup(`SESSION_SECRET=${'a'.repeat(40)}\nEXTENSION_TOKEN_SECRET=${'b'.repeat(40)}\nPORT=3000\nCORS_ORIGIN=http://localhost:3000\n`);
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: async () => false });
    expect(res.updated).toEqual([]);
    expect(parse(paths.envFile).PORT).toBe('3000');
  });

  test('an existing .env with no PORT gets a free one added', async () => {
    const { paths } = setup(`SESSION_SECRET=${'a'.repeat(40)}\nEXTENSION_TOKEN_SECRET=${'b'.repeat(40)}\n`);
    await bootstrap.ensureEnv({ paths, env: {}, isFree: async (p) => p !== 3000 });
    expect(parse(paths.envFile).PORT).toBe('3001');
  });

  test('packaged builds default to NODE_ENV=production in a NEW file only', async () => {
    const dir = tmp();
    const paths = bootstrap.resolvePaths({ packaged: true, execPath: path.join(dir, 'Attentix'), cwd: '/elsewhere' });
    await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(paths.envFile).toBe(path.join(dir, '.env'));
    expect(parse(paths.envFile).NODE_ENV).toBe('production');

    const other = setup('NODE_ENV=development\n');
    await bootstrap.ensureEnv({ paths: { ...other.paths, packaged: true }, env: {}, isFree: always });
    expect(parse(other.paths.envFile).NODE_ENV).toBe('development'); // not ours to change
  });

  test('works without .env.example (falls back to a built-in template)', async () => {
    const { paths } = setup();
    await bootstrap.ensureEnv({ paths: { ...paths, envTemplate: path.join(paths.baseDir, 'missing.example') }, env: {}, isFree: always });
    expect(parse(paths.envFile).SESSION_SECRET).toMatch(HEX64);
  });

  test('does nothing when AUTO_ENV=false (Docker), or when the real environment already has a strong secret and there is no file', async () => {
    const a = setup();
    expect(await bootstrap.ensureEnv({ paths: a.paths, env: { AUTO_ENV: 'false' } })).toMatchObject({ skipped: true, reason: 'AUTO_ENV=false' });
    expect(fs.existsSync(a.paths.envFile)).toBe(false);
    expect(fs.existsSync(a.paths.dataDir)).toBe(false);

    const b = setup();
    expect(await bootstrap.ensureEnv({ paths: b.paths, env: { SESSION_SECRET: 'z'.repeat(40) } })).toMatchObject({ skipped: true });
    expect(fs.existsSync(b.paths.envFile)).toBe(false);
  });

  test('findFreePort really skips a port that is in use', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, r));
    const busy = blocker.address().port;
    try {
      expect(await bootstrap.isPortFree(busy)).toBe(false);
      expect(await bootstrap.findFreePort(busy)).toBeGreaterThan(busy);
    } finally { await new Promise((r) => blocker.close(r)); }
  });
});

describe('LAN address detection', () => {
  const nic = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

  test('returns active IPv4 addresses, best classroom candidate first; skips loopback, IPv6 and link-local', () => {
    const list = bootstrap.detectLanAddresses({
      lo: [nic('127.0.0.1', { internal: true })],
      eth0: [nic('10.0.4.7'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Wi-Fi': [nic('192.168.1.20')],
      'Ethernet 2': [nic('169.254.10.10')],
      vpn0: [nic('100.64.1.5')]
    });
    expect(list.map((l) => l.address)).toEqual(['192.168.1.20', '10.0.4.7', '100.64.1.5']);
    expect(list[0]).toEqual({ name: 'Wi-Fi', address: '192.168.1.20' });
  });

  test('virtual adapters (VirtualBox, Docker, WSL, VMware) rank below a real network even if their range is "nicer"', () => {
    const list = bootstrap.detectLanAddresses({
      'VirtualBox Host-Only Network': [nic('192.168.56.1')],
      'vEthernet (WSL)': [nic('172.20.64.1')],
      docker0: [nic('172.17.0.1')],
      'Wi-Fi': [nic('10.1.2.3')]
    });
    expect(list[0].address).toBe('10.1.2.3');
    expect(list).toHaveLength(4);
  });

  test('copes with older Node (numeric family) and with nothing at all', () => {
    expect(bootstrap.detectLanAddresses({ eth0: [{ address: '192.168.0.9', family: 4, internal: false }] })[0].address).toBe('192.168.0.9');
    expect(bootstrap.detectLanAddresses({})).toEqual([]);
    expect(bootstrap.detectLanAddresses(undefined).constructor).toBe(Array);
  });

  test('getServerInfo: localhost + LAN urls, preferred = LAN; PUBLIC_URL wins when set; no network = localhost and hasLan=false', () => {
    const ifaces = { 'Wi-Fi': [nic('192.168.1.20')] };
    expect(bootstrap.getServerInfo({ port: 3001, env: {}, interfaces: ifaces })).toEqual({
      port: 3001, localUrl: 'http://localhost:3001', lanUrl: 'http://192.168.1.20:3001', lanUrls: ['http://192.168.1.20:3001'],
      hasLan: true, publicUrl: null, preferredUrl: 'http://192.168.1.20:3001'
    });
    expect(bootstrap.getServerInfo({ port: 3000, env: { PUBLIC_URL: 'https://am.school.edu/some/path' }, interfaces: ifaces }))
      .toMatchObject({ publicUrl: 'https://am.school.edu', preferredUrl: 'https://am.school.edu' });
    expect(bootstrap.getServerInfo({ port: 3000, env: { PUBLIC_URL: 'javascript:alert(1)' }, interfaces: {} }))
      .toMatchObject({ publicUrl: null, hasLan: false, lanUrl: null, preferredUrl: 'http://localhost:3000' });
  });

  describe('serverUrlForStudents: which address is baked into a student\'s extension', () => {
    const ifaces = { 'Wi-Fi': [nic('192.168.1.20')] };
    const pick = (o) => bootstrap.serverUrlForStudents({ port: 3000, env: {}, interfaces: ifaces, ...o });

    test('professor browsing on localhost -> the LAN address (localhost would only work on the professor\'s own computer)', () => {
      expect(pick({ requestHost: 'localhost:3000' })).toBe('http://192.168.1.20:3000');
      expect(pick({ requestHost: '127.0.0.1:3000' })).toBe('http://192.168.1.20:3000');
      expect(pick({ requestHost: '[::1]:3000' })).toBe('http://192.168.1.20:3000');
    });
    test('professor already on a LAN name or domain -> exactly that address, with its scheme', () => {
      expect(pick({ requestHost: 'prof-laptop.local:3000' })).toBe('http://prof-laptop.local:3000');
      expect(pick({ requestHost: 'am.school.edu', requestProtocol: 'https' })).toBe('https://am.school.edu');
    });
    test('PUBLIC_URL always wins; a malformed Host header is never trusted; no network falls back to localhost', () => {
      expect(pick({ requestHost: 'x.local', env: { PUBLIC_URL: 'https://am.school.edu' } })).toBe('https://am.school.edu');
      expect(pick({ requestHost: 'evil.com/<script>' })).toBe('http://192.168.1.20:3000');
      expect(pick({ requestHost: 'localhost:3000', interfaces: {} })).toBe('http://localhost:3000');
    });
  });
});

describe('opening the browser', () => {
  const PROD = { NODE_ENV: 'production' };
  const fakeSpawn = () => { const calls = []; const fn = (...a) => { calls.push(a); return { on: jest.fn(), unref: jest.fn() }; }; fn.calls = calls; return fn; };

  test('NEVER under test: the real jest environment refuses, and nothing is spawned', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(bootstrap.shouldAutoOpen()).toBe(false);
    const spawnFn = fakeSpawn();
    expect(bootstrap.openBrowser('http://localhost:3000/educator-signup.html', { spawnFn })).toBe(false);
    expect(spawnFn.calls).toHaveLength(0);
  });

  test.each([
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['a jest worker', { NODE_ENV: 'production', JEST_WORKER_ID: '1' }],
    ['NO_AUTO_OPEN=true', { NODE_ENV: 'production', NO_AUTO_OPEN: 'true' }]
  ])('shouldAutoOpen is false for %s', (_l, env) => {
    expect(bootstrap.shouldAutoOpen(env)).toBe(false);
    const spawnFn = fakeSpawn();
    expect(bootstrap.openBrowser('http://localhost:3000/', { env, spawnFn })).toBe(false);
    expect(spawnFn.calls).toHaveLength(0);
  });

  test('shouldAutoOpen is true in a normal run, and NO_AUTO_OPEN=false does not disable it', () => {
    expect(bootstrap.shouldAutoOpen(PROD)).toBe(true);
    expect(bootstrap.shouldAutoOpen({})).toBe(true);
    expect(bootstrap.shouldAutoOpen({ NO_AUTO_OPEN: 'false' })).toBe(true);
  });

  test('uses each platform\'s native command, with the URL as plain data (no shell string for macOS / Linux)', () => {
    const url = 'http://localhost:3000/educator-signup.html';
    const mac = fakeSpawn(); expect(bootstrap.openBrowser(url, { platform: 'darwin', env: PROD, spawnFn: mac })).toBe(true);
    expect(mac.calls[0].slice(0, 2)).toEqual(['open', [url]]);
    const linux = fakeSpawn(); expect(bootstrap.openBrowser(url, { platform: 'linux', env: PROD, spawnFn: linux })).toBe(true);
    expect(linux.calls[0].slice(0, 2)).toEqual(['xdg-open', [url]]);
    const win = fakeSpawn(); expect(bootstrap.openBrowser(url, { platform: 'win32', env: PROD, spawnFn: win })).toBe(true);
    expect(win.calls[0][0]).toBe('cmd.exe');
    expect(win.calls[0][1]).toEqual(['/d', '/s', '/c', `start "" "${url}"`]);
    expect(win.calls[0][2]).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' });
  });

  test.each([
    'http://localhost:3000/x" & calc.exe & "',
    'http://localhost:3000/a b',
    'http://localhost:3000/%0Acalc',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://evil.example.com/',
    'http://localhost:3000/?q=1&r=2',
    'http://localhost:3000/a^b'
  ])('refuses anything that is not a plain URL on this machine: %s', (url) => {
    const spawnFn = fakeSpawn();
    expect(bootstrap.openBrowser(url, { platform: 'win32', env: PROD, spawnFn })).toBe(false);
    expect(spawnFn.calls).toHaveLength(0);
  });

  test('a missing browser (spawn throws or errors) never crashes the server', () => {
    expect(bootstrap.openBrowser('http://localhost:3000/', { platform: 'linux', env: PROD, spawnFn: () => { throw new Error('ENOENT'); } })).toBe(false);
    const child = { on: jest.fn(), unref: jest.fn() };
    expect(bootstrap.openBrowser('http://localhost:3000/', { platform: 'linux', env: PROD, spawnFn: () => child })).toBe(true);
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => child.on.mock.calls[0][1](new Error('spawn xdg-open ENOENT'))).not.toThrow();
  });

  test('first run opens sign-up; once an educator exists it opens the dashboard', () => {
    expect(bootstrap.startUrl({ port: 3001, hasEducator: false })).toBe('http://localhost:3001/educator-signup.html');
    expect(bootstrap.startUrl({ port: 3001, hasEducator: true })).toBe('http://localhost:3001/educator-dashboard.html');
  });
});

describe('acquireInstanceLock: one server per data directory', () => {
  const lockFile = () => path.join(tmp(), 'data', '.server.lock');
  const never = async () => false;

  test('the first server gets the lock, can record its real port, and releases it (only its own)', async () => {
    const file = lockFile();
    const lock = await bootstrap.acquireInstanceLock({ lockFile: file, port: 3000, pid: 111 });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: 111, port: 3000 });
    lock.update(3004);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).port).toBe(3004);
    lock.release();
    expect(fs.existsSync(file)).toBe(false);
    lock.release(); // idempotent
  });

  test('a second launch while the first is running is refused and told where it is', async () => {
    const file = lockFile();
    await bootstrap.acquireInstanceLock({ lockFile: file, port: 3000, pid: 111, now: () => 1000 });
    const second = await bootstrap.acquireInstanceLock({ lockFile: file, port: 3000, pid: 222, now: () => 1000 + 60000, isAlive: () => true, isHealthy: async (port) => port === 3000 });
    expect(second).toEqual({ acquired: false, existing: { pid: 111, port: 3000 } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(111); // untouched
  });

  test('a server that is still starting (alive, not answering yet, lock younger than 15 s) still counts as running', async () => {
    const file = lockFile();
    await bootstrap.acquireInstanceLock({ lockFile: file, port: 3000, pid: 111, now: () => 5000 });
    const second = await bootstrap.acquireInstanceLock({ lockFile: file, pid: 222, now: () => 9000, isAlive: () => true, isHealthy: never });
    expect(second.acquired).toBe(false);
  });

  test('a stale lock is taken over: dead process, a recycled pid that does not answer, or an unreadable file', async () => {
    const dead = lockFile();
    await bootstrap.acquireInstanceLock({ lockFile: dead, pid: 111, now: () => 0 });
    expect((await bootstrap.acquireInstanceLock({ lockFile: dead, pid: 222, now: () => 99999, isAlive: () => false })).acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(dead, 'utf8')).pid).toBe(222);

    const recycled = lockFile();
    await bootstrap.acquireInstanceLock({ lockFile: recycled, pid: 111, now: () => 0 });
    expect((await bootstrap.acquireInstanceLock({ lockFile: recycled, pid: 222, now: () => 99999, isAlive: () => true, isHealthy: never })).acquired).toBe(true);

    const junk = lockFile();
    fs.mkdirSync(path.dirname(junk), { recursive: true });
    fs.writeFileSync(junk, '{not json');
    expect((await bootstrap.acquireInstanceLock({ lockFile: junk, pid: 333 })).acquired).toBe(true);
  });

  test('release never deletes a lock that now belongs to someone else', async () => {
    const file = lockFile();
    const mine = await bootstrap.acquireInstanceLock({ lockFile: file, pid: 111 });
    fs.writeFileSync(file, JSON.stringify({ pid: 999, port: 3000, startedAt: Date.now() }));
    mine.release();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(999);
  });
});

describe('launcher: a second double-click', () => {
  test('resolveDataDir: DATA_DIR relative to the executable folder, else data/ next to it', () => {
    const paths = { baseDir: '/opt/prof', dataDir: '/opt/prof/data' };
    expect(bootstrap.resolveDataDir(paths, {})).toBe('/opt/prof/data');
    expect(bootstrap.resolveDataDir(paths, { DATA_DIR: './classes' })).toBe(path.resolve('/opt/prof', './classes'));
  });

  test('hasEducatorOnDisk reads users.json without the database layer', () => {
    const dir = tmp();
    expect(bootstrap.hasEducatorOnDisk(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ role: 'student' }]));
    expect(bootstrap.hasEducatorOnDisk(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ role: 'educator' }]));
    expect(bootstrap.hasEducatorOnDisk(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, 'users.json'), '{ broken');
    expect(bootstrap.hasEducatorOnDisk(dir)).toBe(false);
  });

  const lockWith = (obj) => { const f = path.join(tmp(), '.server.lock'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const clock = () => { let t = 0; return { now: () => t, wait: async (ms) => { t += ms; } }; };

  test('waits for a server that is still starting, then returns its port (no browser at a dead port)', async () => {
    const lockFile = lockWith({ pid: 1, port: 3000 });
    let calls = 0;
    const port = await bootstrap.waitForRunningServer({ lockFile, existing: { pid: 1, port: 3000 }, isHealthy: async () => { calls += 1; return calls >= 5; }, ...clock() });
    expect(port).toBe(3000);
    expect(calls).toBe(5);
  });

  test('follows the port when the server had to move to a free one', async () => {
    const lockFile = lockWith({ pid: 1, port: 3000 });
    const asked = [];
    const port = await bootstrap.waitForRunningServer({
      lockFile, existing: { pid: 1, port: 3000 },
      isHealthy: async (p) => { asked.push(p); if (asked.length === 1) fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, port: 3002 })); return p === 3002; },
      ...clock()
    });
    expect(port).toBe(3002);
  });

  test('gives up (null) when the lock disappears, another process owns it, or nothing answers in time', async () => {
    const gone = path.join(tmp(), '.server.lock');
    expect(await bootstrap.waitForRunningServer({ lockFile: gone, existing: { pid: 1, port: 3000 }, isHealthy: async () => false, ...clock() })).toBeNull();
    const other = lockWith({ pid: 2, port: 3000 });
    expect(await bootstrap.waitForRunningServer({ lockFile: other, existing: { pid: 1, port: 3000 }, isHealthy: async () => false, ...clock() })).toBeNull();
    const silent = lockWith({ pid: 1, port: 3000 });
    expect(await bootstrap.waitForRunningServer({ lockFile: silent, existing: { pid: 1, port: 3000 }, timeoutMs: 5000, isHealthy: async () => false, ...clock() })).toBeNull();
  });

  test('openBrowserAndWait resolves only after the launcher child has handed over, and reports a refused launch', async () => {
    const { EventEmitter } = require('events');
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const PROD = { NODE_ENV: 'production' };
    const pending = bootstrap.openBrowserAndWait('http://localhost:3000/', { platform: 'linux', env: PROD, spawnFn: () => child, settleMs: 0 });
    let done = false; pending.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    child.emit('exit', 0);
    expect(await pending).toBe(true);
    expect(await bootstrap.openBrowserAndWait('http://localhost:3000/', { platform: 'linux', env: { NODE_ENV: 'test' }, spawnFn: () => child })).toBe(false);
  });

  test('a too-short SESSION_SECRET in a production .env is replaced (it would stop the app from starting at all)', async () => {
    const dir = tmp();
    const paths = { ...bootstrap.resolvePaths({ packaged: true, execPath: path.join(dir, 'app.exe'), srcDir: dir }), envTemplate: path.join(dir, 'none') };
    fs.writeFileSync(paths.envFile, 'NODE_ENV=production\nPORT=3456\nSESSION_SECRET=short\n');
    const res = await bootstrap.ensureEnv({ paths, env: {}, isFree: always });
    expect(res.updated).toContain('SESSION_SECRET');
    expect(parse(paths.envFile).SESSION_SECRET).toMatch(HEX64);
    expect(parse(paths.envFile).PORT).toBe('3456');
  });
});
