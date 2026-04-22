#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');
const releaseDir = join(distDir, 'release');
const stageDir = join(releaseDir, 'stage');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = pkg.version;

if (manifest.version !== version) {
  console.error(`Version mismatch: package.json=${version}, manifest.json=${manifest.version}`);
  process.exit(1);
}

const releaseFiles = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'dist/background.js',
  'dist/content.js',
  'dist/inpage.js',
  'dist/popup.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? 946684800);
const fixedDate = new Date(sourceDateEpoch * 1000);

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function copyReleaseFile(relativePath) {
  const src = join(root, relativePath);
  const dest = join(stageDir, relativePath);
  if (!existsSync(src) || !statSync(src).isFile()) {
    console.error(`Missing release asset: ${relativePath}`);
    process.exit(1);
  }
  ensureParentDir(dest);
  copyFileSync(src, dest);
  utimesSync(dest, fixedDate, fixedDate);
}

function collectFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(absolutePath, relativePath);
      return [relativePath];
    });
}

execFileSync('npm', ['run', 'build:prod'], { cwd: root, stdio: 'inherit' });

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
utimesSync(stageDir, fixedDate, fixedDate);

for (const relativePath of releaseFiles) {
  copyReleaseFile(relativePath);
}

const archiveName = `shella-wallet-v${version}.zip`;
const archivePath = join(releaseDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
const archiveEntries = collectFiles(stageDir);

rmSync(archivePath, { force: true });
rmSync(checksumPath, { force: true });
mkdirSync(releaseDir, { recursive: true });

execFileSync('zip', ['-X', '-q', archivePath, ...archiveEntries], {
  cwd: stageDir,
  stdio: 'inherit',
});

const checksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
writeFileSync(checksumPath, `${checksum}  ${basename(archivePath)}\n`);

console.log(`✓ Release bundle created: ${archivePath}`);
console.log(`✓ SHA-256: ${checksum}`);
