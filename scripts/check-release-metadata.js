#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const version = pkg.version;
const versionHeading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}]`, 'm');

if (manifest.version !== version) {
  console.error(`Version mismatch: package.json=${version}, manifest.json=${manifest.version}`);
  process.exit(1);
}

if (!versionHeading.test(changelog)) {
  console.error(`CHANGELOG.md is missing a release heading for version ${version}`);
  process.exit(1);
}

console.log(`✓ Release metadata verified for v${version}`);
