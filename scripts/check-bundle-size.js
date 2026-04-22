#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundlePath = join(root, 'dist', 'background.js');
const maxBytes = Number(process.env.MAX_BACKGROUND_BUNDLE_BYTES ?? 1048576);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

if (!existsSync(bundlePath)) {
  console.error(`Missing bundle: ${bundlePath}. Run "npm run build:prod" first.`);
  process.exit(1);
}

const size = statSync(bundlePath).size;
console.log(`background.js size: ${formatBytes(size)} (limit ${formatBytes(maxBytes)})`);

if (size > maxBytes) {
  console.error(
    `background.js exceeds the allowed limit by ${formatBytes(size - maxBytes)}. ` +
      'Investigate new dependencies or split non-critical code paths before merging.',
  );
  process.exit(1);
}

console.log('✓ background.js is within the allowed production bundle budget');
