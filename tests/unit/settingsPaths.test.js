/** settings.js: where .env and data/ live, and the optional EXTENSION_TOKEN_SECRET. */
const path = require('path');

const STRONG_A = 'a'.repeat(48);
const STRONG_B = 'b'.repeat(48);

// Loads a fresh copy of settings (and anything that depends on it) under a temporary environment.
const withEnv = (env, fn) => {
  const saved = { ...process.env };
  // `undefined` means "not set": blank is equivalent for settings, and process.env would store the text "undefined".
  Object.entries({ EXTENSION_TOKEN_SECRET: '', DATA_DIR: '', PUBLIC_URL: '', ...env }).forEach(([k, v]) => { process.env[k] = v === undefined ? '' : v; });
  try {
    let out;
    jest.isolateModules(() => { out = fn(); });
    return out;
  } finally {
    Object.keys(process.env).forEach((k) => { if (!(k in saved)) delete process.env[k]; });
    Object.assign(process.env, saved);
  }
};
const loadSettings = (env) => withEnv(env, () => require('../../src/config/settings'));

describe('data directory and paths', () => {
  test('default: data/ in the working directory; .env there too; bundled assets from the source tree', () => {
    const s = loadSettings({});
    expect(s.dataDir).toBe(path.join(process.cwd(), 'data'));
    expect(s.paths).toMatchObject({ packaged: false, envFile: path.join(process.cwd(), '.env'), publicDir: path.resolve(__dirname, '../../public'), extensionDir: path.resolve(__dirname, '../../extension') });
  });

  test('a relative DATA_DIR (the .env.example default is ./data) is relative to the working directory, an absolute one is used as given', () => {
    expect(loadSettings({ DATA_DIR: './data' }).dataDir).toBe(path.join(process.cwd(), 'data'));
    expect(loadSettings({ DATA_DIR: 'classroom-files' }).dataDir).toBe(path.join(process.cwd(), 'classroom-files'));
    const abs = path.join(path.parse(process.cwd()).root, 'tmp', 'amp-data');
    expect(loadSettings({ DATA_DIR: abs }).dataDir).toBe(abs);
  });

  test('the bundled assets really exist where settings says they are', () => {
    const fs = require('fs');
    const s = loadSettings({});
    expect(fs.existsSync(path.join(s.paths.publicDir, 'educator-dashboard.html'))).toBe(true);
    expect(fs.existsSync(path.join(s.paths.extensionDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(s.paths.envTemplate)).toBe(true);
  });
});

describe('EXTENSION_TOKEN_SECRET', () => {
  test.each([['unset', undefined], ['blank', ''], ['the template placeholder', 'replace_with_a_secure_random_string']])('%s -> not used (tokens are keyed from SESSION_SECRET as before)', (_l, value) => {
    expect(loadSettings({ EXTENSION_TOKEN_SECRET: value }).extensionTokenSecret).toBeNull();
  });

  test('a real value is picked up', () => {
    expect(loadSettings({ EXTENSION_TOKEN_SECRET: STRONG_B }).extensionTokenSecret).toBe(STRONG_B);
  });

  test('production rejects a short one (a weak token key would be a real hole), but only when one is actually set', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: STRONG_A, CORS_ORIGIN: 'http://localhost:3000' };
    expect(() => loadSettings({ ...prod, EXTENSION_TOKEN_SECRET: 'short' })).toThrow(/EXTENSION_TOKEN_SECRET must be at least 32/);
    expect(() => loadSettings({ ...prod, EXTENSION_TOKEN_SECRET: STRONG_B })).not.toThrow();
    expect(() => loadSettings({ ...prod, EXTENSION_TOKEN_SECRET: '' })).not.toThrow();
  });

  const tokenFor = (env, student) => withEnv(env, () => {
    const t = require('../../src/utils/extensionToken');
    return { token: t.issueStudentToken(student, { id: 'c1', classCode: 'ABC234' }), verify: t.verifyTokenClaims };
  });
  const student = { id: '11111111-1111-4111-8111-111111111111', name: 'Ana Cruz', email: 'ana@pup.edu.ph', tokenVersion: 0 };
  const verifyIn = (env, token) => withEnv(env, () => require('../../src/utils/extensionToken').verifyTokenClaims(token));

  test('with the secret set, rotating SESSION_SECRET does not sign students out; changing the token secret does', () => {
    const { token } = tokenFor({ SESSION_SECRET: STRONG_A, EXTENSION_TOKEN_SECRET: STRONG_B }, student);
    expect(verifyIn({ SESSION_SECRET: 'c'.repeat(48), EXTENSION_TOKEN_SECRET: STRONG_B }, token)).not.toBeNull();
    expect(verifyIn({ SESSION_SECRET: STRONG_A, EXTENSION_TOKEN_SECRET: 'd'.repeat(48) }, token)).toBeNull();
  });

  test('without it, tokens follow SESSION_SECRET exactly as before (existing deployments keep their students signed in)', () => {
    const { token } = tokenFor({ SESSION_SECRET: STRONG_A }, student);
    expect(verifyIn({ SESSION_SECRET: STRONG_A }, token)).not.toBeNull();
    expect(verifyIn({ SESSION_SECRET: STRONG_B }, token)).toBeNull();
  });

  test('a token signed with the dedicated secret is not accepted by a server that falls back to SESSION_SECRET', () => {
    const { token } = tokenFor({ SESSION_SECRET: STRONG_A, EXTENSION_TOKEN_SECRET: STRONG_B }, student);
    expect(verifyIn({ SESSION_SECRET: STRONG_A }, token)).toBeNull();
  });
});

describe('PUBLIC_URL', () => {
  test('is exposed when set and null otherwise', () => {
    expect(loadSettings({}).publicUrl).toBeNull();
    expect(loadSettings({ PUBLIC_URL: 'https://am.school.edu' }).publicUrl).toBe('https://am.school.edu');
  });
});
