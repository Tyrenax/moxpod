#!/usr/bin/env node
// Copy the version from package.json into manifests/base.json.
//
// Wired into npm's `version` lifecycle, so `npm version patch` bumps both and
// commits them together. The release workflow refuses to publish when they
// disagree, which is what makes that safe to forget about.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const path = join(root, 'manifests', 'base.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));

if (manifest.version === version) {
  console.log(`manifest already at ${version}`);
} else {
  console.log(`manifest ${manifest.version} -> ${version}`);
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
