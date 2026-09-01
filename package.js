#!/usr/bin/env node
// Package the built extension into distributable zips.
//
// Produces release/moxpod-chrome-vX.Y.Z.zip and the Firefox equivalent, using
// nothing but Node so it behaves the same on Windows and on a CI runner.
//
//   node package.js          # build first, then zip
//   node package.js --skip-build
//
// Chrome cannot install a raw .zip or .crx from outside the Web Store, so the
// zip is meant to be extracted and loaded via "Load unpacked". The install
// steps live in README.md.

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = import.meta.dirname;
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'release');
const BROWSERS = ['chrome', 'firefox'];

const skipBuild = process.argv.includes('--skip-build');

if (!skipBuild) {
  execFileSync(process.execPath, [join(ROOT, 'build.js')], { stdio: 'inherit' });
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const browser of BROWSERS) {
  const source = join(DIST, browser);
  if (!existsSync(source)) {
    console.error(`missing ${source} -- run the build first`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) {
    console.error(`version mismatch: package.json ${version}, manifest ${manifest.version}`);
    process.exit(1);
  }

  const target = join(OUT, `moxpod-${browser}-v${version}.zip`);
  const files = walk(source).sort();
  writeZip(target, source, files);
  const size = statSync(target).size;
  console.log(`  ${relative(ROOT, target)}  (${files.length} files, ${(size / 1024).toFixed(0)} KB)`);
}

console.log(`\nPackaged MoxPod v${version}`);

// ── Helpers ─────────────────────────────────────────────────────────

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/**
 * Minimal ZIP writer (deflate, no dependencies). Enough for a browser
 * extension: no encryption, no zip64, forward slashes in entry names.
 */
function writeZip(target, base, files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = relative(base, file).split(sep).join('/');
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const useStore = compressed.length >= data.length;
    const payload = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data) >>> 0;
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (fixed, for reproducibility)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);          // extra
    entry.writeUInt16LE(0, 32);          // comment
    entry.writeUInt16LE(0, 34);          // disk
    entry.writeUInt16LE(0, 36);          // internal attrs
    entry.writeUInt32LE(0, 38);          // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  // Synchronous: the caller stats the file immediately afterwards.
  writeFileSync(target, Buffer.concat([...chunks, centralBuffer, end]));
}
