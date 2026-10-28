/** The zero-terminal pieces that are configuration rather than code: package.json, launchers, Docker, .env.example. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('package.json', () => {
  test('bin points at the launcher, and index.js is runnable directly (shebang)', () => {
    expect(pkg.bin).toEqual({ attentix: 'src/index.js' });
    expect(read('src/index.js').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  test('pkg bundles public/, extension/ and the .env template, and targets Windows, macOS and Linux into dist/', () => {
    expect(pkg.pkg.assets).toEqual(expect.arrayContaining(['public/**/*', 'extension/**/*', '.env.example']));
    expect(pkg.pkg.outputPath).toBe('dist');
    expect(pkg.pkg.targets.map((t) => t.split('-').slice(1, 2)[0]).sort()).toEqual(['linux', 'macos', 'win']);
    for (const pattern of pkg.pkg.assets) {
      const dir = pattern.split('/')[0];
      expect(fs.existsSync(path.join(ROOT, dir))).toBe(true);
    }
  });

  test('npm run build:exe exists, the build tool is a devDependency, and the script produces the three documented file names', () => {
    expect(pkg.scripts['build:exe']).toBe('node scripts/build-exe.js');
    expect(pkg.devDependencies['@yao-pkg/pkg']).toBeDefined();
    expect(pkg.dependencies['@yao-pkg/pkg']).toBeUndefined(); // never shipped in production installs
    const script = read('scripts/build-exe.js');
    ['Attentix-win.exe', 'Attentix-macos', 'Attentix-linux'].forEach((n) => expect(script).toContain(n));
  });

  test('npm test and lint are unchanged and nothing runs the app on install', () => {
    expect(pkg.scripts.test).toMatch(/jest/);
    expect(pkg.scripts.lint).toMatch(/eslint/);
    expect(Object.keys(pkg.scripts).filter((k) => /^(pre|post)?install$/.test(k))).toEqual([]);
  });
});

describe('launchers', () => {
  test('Launch-Silent.vbs runs the server hidden without waiting, installs on first run, and warns when Node is missing', () => {
    const vbs = read('Launch-Silent.vbs');
    expect(vbs).toMatch(/shell\.Run "cmd \/c node src\\index\.js[^"]*", 0, False/);
    expect(vbs).toMatch(/node_modules/);
    expect(vbs).toMatch(/npm install --omit=dev/);
    expect(vbs).toMatch(/where node/);
    expect(vbs).toMatch(/server\.log/);
    expect(vbs).toMatch(/CurrentDirectory = dir/); // works from a shortcut / any folder
    expect(vbs).toMatch(/Option Explicit/);
  });

  test('Launch-App.bat installs on first run, starts the server and pauses so errors stay readable', () => {
    const bat = read('Launch-App.bat');
    expect(bat).toMatch(/cd \/d "%~dp0"/);
    expect(bat).toMatch(/if not exist node_modules/);
    expect(bat).toMatch(/npm install --omit=dev/);
    expect(bat).toMatch(/node src\\index\.js/);
    expect(bat).toMatch(/pause/);
  });

  test('the Windows scripts use CRLF line endings (cmd.exe and WScript can misparse bare LF)', () => {
    for (const f of ['Launch-App.bat', 'Launch-Silent.vbs']) expect(read(f)).toMatch(/\r\n/);
    for (const f of ['Launch-App.bat', 'Launch-Silent.vbs']) expect(read(f).replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  test('Launch-App.command is a bash script that is executable, changes to its own folder, installs on first run and starts the server', () => {
    const sh = read('Launch-App.command');
    expect(sh.startsWith('#!/bin/bash')).toBe(true);
    expect(sh).toMatch(/cd "\$\(dirname "\$0"\)"/);
    expect(sh).toMatch(/\[ ! -d node_modules \]/);
    expect(sh).toMatch(/exec node src\/index\.js/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(ROOT, 'Launch-App.command')).mode & 0o111).not.toBe(0);
  });

  test('none of the launchers hard-code a port, a path or a secret', () => {
    for (const f of ['Launch-App.bat', 'Launch-Silent.vbs', 'Launch-App.command']) expect(read(f)).not.toMatch(/\b3000\b|SESSION_SECRET|C:\\|\/Users\//);
  });
});

describe('Docker and environment template', () => {
  test('the image keeps strict, explicit configuration: no .env generation, no port fallback, no browser launch', () => {
    const docker = read('Dockerfile');
    expect(docker).toMatch(/ENV AUTO_ENV=false NO_AUTO_OPEN=true/);
    expect(docker).toMatch(/NODE_ENV=production/);
  });

  test('launchers, build scripts and build output are kept out of the image and out of git', () => {
    const ignore = read('.dockerignore');
    ['dist/', 'scripts/', 'Launch-*'].forEach((p) => expect(ignore).toContain(p));
    expect(read('.gitignore')).toContain('dist/');
  });

  test('.env.example documents the new optional settings without activating them', () => {
    const env = read('.env.example');
    ['EXTENSION_TOKEN_SECRET', 'PUBLIC_URL', 'AUTO_ENV', 'NO_AUTO_OPEN'].forEach((k) => {
      expect(env).toMatch(new RegExp(`^# ${k}=`, 'm'));
      expect(env).not.toMatch(new RegExp(`^${k}=`, 'm'));
    });
  });

  test('src/utils/bootstrap.js never pulls in settings (it must run before the .env it creates is read)', () => {
    expect(read('src/utils/bootstrap.js')).not.toMatch(/require\(['"]\.\.?\/config\/settings['"]\)/);
  });
});
