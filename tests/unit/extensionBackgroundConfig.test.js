/** extension/background.js reads the optional config.js written by the professor's server. Real worker code in a vm, fake chrome. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');

const EXT_DIR = path.join(__dirname, '../../extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configJs = (cfg) => `globalThis.AMP_PRECONFIG = ${JSON.stringify(cfg)};`;

// `config`: a config.js source string, or null for "the file does not exist".
function loadBackground({ config, prefs } = {}) {
  const data = {};
  if (prefs) data.prefs = prefs;
  const writes = [];
  const storage = {
    local: {
      data,
      get: async (k) => { const keys = typeof k === 'string' ? [k] : k; return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]])); },
      set: async (o) => { writes.push(o); Object.assign(data, JSON.parse(JSON.stringify(o))); },
      remove: async (k) => { delete data[k]; }
    }
  };
  const fake = { storage, writes, onInstalled: null, onMessage: null, injected: [] };
  const chrome = {
    storage,
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {}, setTitle() {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener: (fn) => { fake.onMessage = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener: (fn) => { fake.onInstalled = fn; } } },
    tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: { addListener() {} } },
    windows: { getLastFocused: async () => ({ focused: true, tabs: [] }) },
    scripting: { executeScript: async (d) => { fake.injected.push(d); } }
  };
  const ctx = vm.createContext({ chrome, WebSocket, console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, fetch, AbortSignal, JSON, Math, Date });
  vm.runInContext('var self = globalThis;', ctx);
  ctx.importScripts = (...files) => files.forEach((f) => {
    if (f === 'config.js') {
      if (config === null) throw new Error('NetworkError: Failed to execute \'importScripts\' (config.js not found)');
      return vm.runInContext(config !== undefined ? config : fs.readFileSync(path.join(EXT_DIR, f), 'utf8'), ctx, { filename: f });
    }
    return vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), 'utf8'), ctx, { filename: f });
  });
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  fake.install = async () => { fake.onInstalled(); await sleep(20); };
  fake.ctx = ctx;
  return fake;
}

describe('background.js and config.js', () => {
  test('installing a pre-configured extension remembers the educator\'s server address (reduced to its origin), keeping the other saved fields', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'http://192.168.1.20:3000/some/path', classCode: 'ABC234' }), prefs: { name: 'Ana Cruz', email: 'ana@pup.edu.ph' } });
    await bg.install();
    expect(bg.storage.local.data.prefs).toEqual({ name: 'Ana Cruz', email: 'ana@pup.edu.ph', serverUrl: 'http://192.168.1.20:3000' });
  });

  test('only the server is stored; the class code is left to the popup, which re-reads config.js each time', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'https://am.school.edu', classCode: 'ABC234' }) });
    await bg.install();
    expect(bg.storage.local.data.prefs).toEqual({ serverUrl: 'https://am.school.edu' });
    expect(JSON.stringify(bg.storage.local.data)).not.toContain('ABC234');
  });

  test('a newer copy of the extension (the professor\'s address changed) replaces a stale remembered address', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'http://192.168.1.99:3000', classCode: '' }), prefs: { serverUrl: 'http://192.168.1.20:3000' } });
    await bg.install();
    expect(bg.storage.local.data.prefs.serverUrl).toBe('http://192.168.1.99:3000');
  });

  test('nothing is written when the remembered address is already right', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'http://192.168.1.20:3000', classCode: '' }), prefs: { serverUrl: 'http://192.168.1.20:3000' } });
    await bg.install();
    expect(bg.writes).toEqual([]);
  });

  test.each([
    ['the shipped blank config.js', undefined],
    ['blank values', configJs({ serverUrl: '', classCode: '' })],
    ['a javascript: address', configJs({ serverUrl: 'javascript:alert(1)', classCode: '' })],
    ['a file: address', configJs({ serverUrl: 'file:///etc/passwd', classCode: '' })],
    ['a non-string address', configJs({ serverUrl: 42, classCode: '' })],
    ['no AMP_PRECONFIG at all', 'var unrelated = 1;']
  ])('does nothing for %s', async (_label, config) => {
    const bg = loadBackground({ config });
    await bg.install();
    expect(bg.writes).toEqual([]);
    expect(bg.storage.local.data.prefs).toBeUndefined();
  });

  test('a missing config.js (a plain copy of the extension, or a deleted file) never stops the worker from starting', async () => {
    const bg = loadBackground({ config: null });
    expect(typeof bg.onMessage).toBe('function'); // the rest of background.js still ran
    await expect(bg.install()).resolves.toBeUndefined();
    expect(bg.writes).toEqual([]);
    expect(bg.injected).toBeDefined();
  });

  test('a storage failure while remembering the address is swallowed (the popup reads config.js itself)', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'http://192.168.1.20:3000', classCode: '' }) });
    bg.storage.local.set = async () => { throw new Error('quota'); };
    await expect(bg.install()).resolves.toBeUndefined();
  });

  test('the worker still answers messages after a pre-configured install', async () => {
    const bg = loadBackground({ config: configJs({ serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' }) });
    await bg.install();
    const status = await new Promise((resolve) => bg.onMessage({ type: 'status' }, {}, resolve));
    expect(status).toMatchObject({ ok: true, joined: false });
  });
});
