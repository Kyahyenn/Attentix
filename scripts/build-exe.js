#!/usr/bin/env node
'use strict';

/**
 * npm run build:exe  ->  dist/Attentix-win.exe, dist/Attentix-macos, dist/Attentix-linux
 *
 * Single-file executables that bundle Node.js, the server, public/ and extension/ (see the "pkg" block in package.json), so
 * the professor needs no Node install and no terminal. Uses @yao-pkg/pkg (the maintained fork of vercel/pkg).
 *
 *   npm run build:exe                 all three
 *   npm run build:exe -- win linux    only some
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// The Node.js bundled into the executable. pkg downloads a prebuilt base binary for it; if a brand-new patch release
// has none yet the download 404s, in which case set PKG_NODE (e.g. PKG_NODE=node20) to another major that has one.
const NODE = process.env.PKG_NODE || 'node22';
const TARGETS = {
  win: { target: `${NODE}-win-x64`, output: 'Attentix-win.exe' },
  macos: { target: `${NODE}-macos-x64`, output: 'Attentix-macos' },
  linux: { target: `${NODE}-linux-x64`, output: 'Attentix-linux' }
};

(async () => {
  let pkg;
  try { ({ exec: pkg } = require('@yao-pkg/pkg')); } catch {
    console.error('The build tool is missing. Run "npm install" (it is a devDependency) and try again.');
    process.exit(1);
  }

  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = wanted.length ? wanted : Object.keys(TARGETS);
  const unknown = names.filter((n) => !TARGETS[n]);
  if (unknown.length) { console.error(`Unknown target(s): ${unknown.join(', ')}. Choose from: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }

  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });

  let failed = false;
  for (const name of names) {
    const { target, output } = TARGETS[name];
    const outFile = path.join(dist, output);
    console.log(`\n== Building ${output} (${target}) ==`);
    try {
      // Uncompressed by default: the app is read straight from the file at start-up, and decompressing every module made
      // slow school laptops slower still. PKG_COMPRESS=GZip trades that for a smaller download.
      const compress = process.env.PKG_COMPRESS ? ['--compress', process.env.PKG_COMPRESS] : [];
      await pkg([ROOT, '--target', target, '--output', outFile, ...compress]);
      console.log(`   ok  ${path.relative(ROOT, outFile)}  ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB`);
    } catch (err) {
      failed = true;
      console.error(`   FAILED ${output}: ${err.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
