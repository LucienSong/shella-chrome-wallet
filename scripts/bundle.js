#!/usr/bin/env node
/**
 * esbuild bundler for Shella Wallet Chrome extension.
 * Compiles src/popup.ts and src/background.ts into dist/.
 */
import * as esbuild from 'esbuild';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

const isProd = process.argv.includes('--prod');

const sharedConfig = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022', 'chrome108'],
  minify: isProd,
  sourcemap: !isProd ? 'inline' : false,
  logLevel: 'info',
  // Silence "browser" field warnings for node-specific packages
  conditions: ['browser', 'import', 'default'],
};

try {
  await Promise.all([
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/popup.ts')],
      outfile: join(dist, 'popup.js'),
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/background.ts')],
      outfile: join(dist, 'background.js'),
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/crypto.ts')],
      outfile: join(dist, 'crypto.js'),
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/store.ts')],
      outfile: join(dist, 'store.js'),
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/content.ts')],
      outfile: join(dist, 'content.js'),
    }),
    esbuild.build({
      ...sharedConfig,
      entryPoints: [join(root, 'src/inpage.ts')],
      outfile: join(dist, 'inpage.js'),
    }),
  ]);
  console.log('✓ Build complete → dist/');
} catch (err) {
  console.error(err);
  process.exit(1);
}
