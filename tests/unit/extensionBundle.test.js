/** The pre-configured extension: ZIP writer, config.js generator and manifest patch. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createZip, crc32 } = require('../../src/utils/zip');
const { renderConfigJs, buildExtensionFiles, buildExtensionZip, toOrigin } = require('../../src/utils/extensionBundle');
const { readZip } = require('../helpers/zipReader');

const EXT_DIR = path.join(__dirname, '../../extension');
const evalConfig = (js) => { const sandbox = { globalThis: {} }; vm.runInNewContext(js, sandbox); return sandbox.globalThis.AMP_PRECONFIG; };

describe('createZip', () => {
  test('round-trips text, binary and empty files (deflate and store), with correct CRCs', () => {
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
    const zip = createZip([
      { name: 'a.txt', data: 'hello '.repeat(500) },
      { name: 'dir/b.bin', data: binary },
      { name: 'empty.txt', data: '' },
      { name: 'tiny.txt', data: 'x' }
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a.txt', 'dir/b.bin', 'empty.txt', 'tiny.txt']);
    expect(files.get('a.txt').toString()).toBe('hello '.repeat(500));
    expect(files.get('dir/b.bin').equals(binary)).toBe(true);
    expect(files.get('empty.txt').length).toBe(0);
    expect(files.get('tiny.txt').toString()).toBe('x');
    expect(zip.length).toBeLessThan(500 * 6 + 4096); // the repetitive text really was compressed
  });

  test('UTF-8 file names survive', () => {
    expect([...readZip(createZip([{ name: 'ñandú/日本.txt', data: 'ok' }])).keys()]).toEqual(['ñandú/日本.txt']);
  });

  test('crc32 matches the published check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  test.each(['../evil.txt', '/abs.txt', 'a/../../b.txt', '\\windows.txt'])('refuses an unsafe entry name: %s', (name) => {
    expect(() => createZip([{ name, data: 'x' }])).toThrow(/Unsafe zip entry name/);
  });

  test('the archive has no wrapping folder, so "Extract all" gives one folder with manifest.json inside it', () => {
    const names = [...readZip(buildExtensionZip({ extensionDir: EXT_DIR, serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' })).keys()];
    expect(names).toContain('manifest.json');
    expect(names.every((n) => !n.startsWith('extension/'))).toBe(true);
  });
});

describe('renderConfigJs', () => {
  test('produces JavaScript that sets AMP_PRECONFIG to exactly the two values', () => {
    expect(evalConfig(renderConfigJs({ serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' }))).toEqual({ serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' });
  });

  test('values are JSON-encoded: quotes, newlines and script-ish text cannot break out of the string', () => {
    const nasty = 'x";globalThis.pwned=1;//\n</script>\u2028';
    const sandbox = { globalThis: {} };
    vm.runInNewContext(renderConfigJs({ serverUrl: nasty, classCode: nasty }), sandbox);
    expect(sandbox.globalThis.AMP_PRECONFIG).toEqual({ serverUrl: nasty, classCode: nasty });
    expect(sandbox.globalThis.pwned).toBeUndefined();
  });

  test('the shipped extension/config.js is a valid blank default', () => {
    expect(evalConfig(fs.readFileSync(path.join(EXT_DIR, 'config.js'), 'utf8'))).toEqual({ serverUrl: '', classCode: '' });
  });
});

describe('buildExtensionFiles', () => {
  const build = (o = {}) => buildExtensionFiles({ extensionDir: EXT_DIR, serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234', ...o });
  const byName = (files) => new Map(files.map((f) => [f.name, f.data]));

  test('config.js is replaced with the server address and the class code; the source file on disk is not touched', () => {
    const before = fs.readFileSync(path.join(EXT_DIR, 'config.js'), 'utf8');
    const files = byName(build());
    expect(evalConfig(files.get('config.js').toString())).toEqual({ serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' });
    expect(fs.readFileSync(path.join(EXT_DIR, 'config.js'), 'utf8')).toBe(before);
  });

  test('the server URL is reduced to its origin (no path, query or credentials sneak in)', () => {
    expect(toOrigin('http://user:pw@192.168.1.20:3000/some/path?x=1')).toBe('http://192.168.1.20:3000');
    expect(evalConfig(byName(build({ serverUrl: 'https://am.school.edu/app/' })).get('config.js').toString()).serverUrl).toBe('https://am.school.edu');
  });

  test('the manifest may talk to the professor\'s server out of the box, without duplicating or dropping anything', () => {
    const original = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
    const patched = JSON.parse(byName(build()).get('manifest.json').toString());
    expect(patched.host_permissions).toEqual([...original.host_permissions, 'http://192.168.1.20:3000/*']);
    expect({ ...patched, host_permissions: null }).toEqual({ ...original, host_permissions: null }); // nothing else changed

    const local = JSON.parse(byName(build({ serverUrl: 'http://localhost:3000' })).get('manifest.json').toString());
    expect(local.host_permissions).toEqual(original.host_permissions); // already listed: not repeated
  });

  test('every other file is byte-for-byte the real extension; notes and dotfiles are left out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-ext-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"host_permissions":[]}');
    fs.writeFileSync(path.join(dir, 'popup.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'x');
    fs.writeFileSync(path.join(dir, 'README.md'), '# notes');
    fs.writeFileSync(path.join(dir, '.hidden'), 'secret');
    const files = byName(buildExtensionFiles({ extensionDir: dir, serverUrl: 'http://10.0.0.5:3000', classCode: 'ABC234' }));
    expect([...files.keys()].sort()).toEqual(['lib/x.js', 'manifest.json', 'popup.js']);
    expect(files.get('popup.js').toString()).toBe('console.log(1)');
  });

  test('the real extension folder: everything that is not config.js / manifest.json is identical, and nothing is missing', () => {
    const files = byName(build());
    const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]));
    const expected = walk(EXT_DIR).filter((n) => !/\.md$/i.test(n)).sort();
    expect([...files.keys()].sort()).toEqual(expected);
    for (const name of expected.filter((n) => !['config.js', 'manifest.json'].includes(n))) {
      expect(files.get(name).equals(fs.readFileSync(path.join(EXT_DIR, name)))).toBe(true);
    }
  });

  test.each(['javascript:alert(1)', 'file:///etc/passwd', 'not a url', ''])('refuses a server URL that is not http(s): %j', (serverUrl) => {
    expect(() => build({ serverUrl })).toThrow();
  });

  test('a complete zip of the real extension is readable and keeps the pre-filled config', () => {
    const files = readZip(buildExtensionZip({ extensionDir: EXT_DIR, serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' }));
    expect(evalConfig(files.get('config.js').toString())).toEqual({ serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' });
    expect(files.has('popup.html')).toBe(true);
    expect(files.has('lib/socket.io.min.js')).toBe(true);
  });
});
