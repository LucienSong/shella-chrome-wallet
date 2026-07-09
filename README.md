# shella-chrome-wallet

Chrome wallet for [Shell Chain](https://github.com/LucienSong/shell-chain) — quantum-safe key management built for the era before Q-Day.

## Features

- 🔐 **ML-DSA-65 key management** — generate or import post-quantum keypairs; addresses in canonical Shell format (`0x` + 64 lowercase hex, BLAKE3-derived)
- 🔑 **Password-protected keystore** — argon2id KDF + xchacha20-poly1305 encryption; compatible with Shell CLI keystore format
- 🔒 **Auto-lock** — configurable inactivity timeout via chrome.alarms; unlocked signer stays only in service-worker memory and browser restart re-locks the wallet
- 💸 **Send transactions** — input recipient + amount → build → sign → broadcast via shell-sdk
- 📥 **Receive** — display full address with one-click copy
- 📜 **Transaction history** — query `shell_getTransactionsByAddress`, display reward-aware Shell tx labels, and preserve STARK reward metadata from address history summaries
- 🌐 **Multi-network** — switch between devnet / testnet / mainnet or configure a custom RPC URL
- 🔌 **dApp connectivity foundation** — injected `window.shella` + EIP-1193-compatible `window.ethereum` bridge for connect / read-only RPC / chain switching
- ⚡ **Manifest V3** — service worker background, strict CSP, no eval

## Project Structure

```
manifest.json          MV3 manifest (minimal permissions: storage, alarms)
popup.html             Extension popup shell (360×600)
popup.css              Dark-theme styles
icons/                 Extension icons (16, 48, 128px)
src/
  popup.ts             Multi-view SPA entry point
  background.ts        Service worker — key lifecycle, signing, RPC
  content.ts           Content-script bridge between web pages and the extension
  inpage.ts            Injected provider (`window.shella` / `window.ethereum`)
  store.ts             chrome.storage.local/session wrapper
  crypto.ts            Pure-JS keystore create/decrypt (no WASM)
scripts/
  bundle.js            esbuild bundler → dist/
dist/                  Built extension (load as unpacked)
```

## Development

```bash
# Local development pulls shell-sdk via npm or a local file path; see package.json
npm install
npm run build        # esbuild → dist/popup.js + dist/background.js
npm run build:prod   # minified production bundle
npm run check:bundle-size
npm run check:release-metadata
npm run release:bundle
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # build + node --test tests/*.test.mjs
```

Load the project root as an **unpacked extension** in `chrome://extensions` (enable Developer mode).

> **Note:** the development build uses inline sourcemaps, so `dist/background.js` can look several MB locally. The production build (`npm run build:prod`) is the real release artifact and is kept under CI size guard.
> **Security note:** dApp connectivity now requires `http://*/*` + `https://*/*` host access so the provider bridge can be injected into web pages. No third-party analytics, remote scripts, or broad extension permissions were added beyond `storage` and `alarms`.

## Connecting to the Shell test node

The wallet ships with four preset networks:

| Key | Name | Chain ID | RPC |
|---|---|---|---|
| `devnet` | Shell Devnet | 424242 | `http://127.0.0.1:8545` |
| `localdev` | Shell Testnet (local) | 10 | `http://127.0.0.1:8545` |
| `testnet` | Shell Testnet | 10 | `https://rpc.testnet.shell.network` |
| `mainnet` | Shell Mainnet | 100000 | `https://rpc.mainnet.shell.network` |

### Connecting to SG3 testnet via SSH tunnel (recommended for development)

The SG3 testnet node exposes RPC on port 8545. Since the wallet only accepts
HTTP for `localhost`, forward the port locally before loading the extension:

```bash
# Keep this running in a separate terminal
ssh -N -L 8545:127.0.0.1:8545 root@47.237.195.95 \
  -i ~/.ssh/shell-testnet-sg-20260504035712.pem
```

Then in the wallet popup:

1. Open **Settings → Network** and select **Shell Testnet — local (10, localhost)**.
2. The wallet will probe `shell_getNodeInfo` on boot and display the node version,
   block height, and peer count in the wallet panel when connected.
3. Confirmed chain ID `10` should appear in the RPC chain row of the wallet meta section.

### Using a custom HTTPS RPC

If an HTTPS endpoint is available (e.g., behind a reverse proxy):

1. Go to **Settings → Network → Custom RPC…**
2. Set **Chain ID** to `10`, **RPC URL** to your HTTPS endpoint, and **Network Name**.
3. Click **Save Custom RPC**.

The wallet enforces HTTPS for all non-localhost RPC URLs.

### Verifying connectivity

When connected, the wallet header panel shows:

- 📦 Node version (e.g., `ShellChain/v0.23.0/rust`)
- 🧱 Current block height
- 🔗 Peer count

If the RPC is unreachable a yellow warning banner appears: _"RPC unavailable for …"_.
If chain IDs mismatch a different warning prompts you to switch networks.

## Release engineering

- CI runs on **Node 20 and 22**
- Release metadata is verified so `package.json`, `manifest.json`, and `CHANGELOG.md` stay in sync
- Production bundle size is enforced by `npm run check:bundle-size`
- `npm run release:bundle` creates a deterministic zip in `dist/release/` plus a `.sha256` file for verification

## Dependencies

- [`shell-sdk`](https://github.com/LucienSong/shell-sdk) — ML-DSA-65 adapter, ShellSigner, provider, tx builders
- [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — Argon2id KDF (pure JS)
- [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) — XChaCha20-Poly1305 (pure JS)
- [`viem`](https://viem.sh) — Ethereum primitives (hex, encoding)
