# shella-chrome-wallet

Post-quantum Chrome wallet extension for [Shell Chain](https://github.com/LucienSong/shell-chain).

## Features

- 🔐 **ML-DSA-65 key management** — generate or import post-quantum keypairs; addresses in `pq1...` bech32m format
- 🔑 **Password-protected keystore** — argon2id KDF + xchacha20-poly1305 encryption; compatible with Shell CLI keystore format
- 🔒 **Auto-lock** — configurable inactivity timeout via chrome.alarms; keys kept only in `chrome.storage.session`
- 💸 **Send transactions** — input recipient + amount → build → sign → broadcast via shell-sdk
- 📥 **Receive** — display full address with one-click copy
- 📜 **Transaction history** — query `shell_getTransactionsByAddress` and display recent activity
- 🌐 **Multi-network** — switch between devnet / testnet / mainnet or configure a custom RPC URL
- ⚡ **Manifest V3** — service worker background, strict CSP, no eval

## Project Structure

```
manifest.json          MV3 manifest (permissions: storage, alarms)
popup.html             Extension popup shell (360×600)
popup.css              Dark-theme styles
icons/                 Extension icons (16, 48, 128px)
src/
  popup.ts             Multi-view SPA entry point
  background.ts        Service worker — key lifecycle, signing, RPC
  store.ts             chrome.storage.local/session wrapper
  crypto.ts            Pure-JS keystore create/decrypt (no WASM)
scripts/
  bundle.js            esbuild bundler → dist/
dist/                  Built extension (load as unpacked)
```

## Development

```bash
# Requires shell-sdk to be checked out at ../shell-sdk (sibling directory)
npm install
npm run build        # esbuild → dist/popup.js + dist/background.js
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
```

Load the project root as an **unpacked extension** in `chrome://extensions` (enable Developer mode).

> **Note:** `dist/background.js` is ~3.7 MB due to bundled ML-DSA-65 + Argon2id crypto. This is expected.

## Dependencies

- [`shell-sdk`](https://github.com/LucienSong/shell-sdk) — ML-DSA-65 adapter, ShellSigner, provider, tx builders
- [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — Argon2id KDF (pure JS)
- [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) — XChaCha20-Poly1305 (pure JS)
- [`viem`](https://viem.sh) — Ethereum primitives (hex, encoding)
