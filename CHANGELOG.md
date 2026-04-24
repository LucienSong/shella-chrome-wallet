# Changelog

## [0.18.0] — 2026-04-24

### Added
- **Storage profile badge** in wallet header: shows node's storage mode (`archive` / `full` / `light`) fetched via `shell_getNodeInfo`. Included in `GET_WALLET_SNAPSHOT` response.
- **AA batch transaction display** (v0.18.0): history items with `tx_type = 0x7e` show `⚡ Batch (N calls)` label and a blue left border.
- **Sponsored gas indicator**: transactions with a `paymaster` address show a `⚡ Sponsored` badge in transaction history.
- **AA batch approval UI**: when a dApp sends a `send-transaction` approval with `tx_type = 0x7e`, the approval screen shows each inner call with its destination, value, gas limit, and calldata.
- `AaBatchInnerCall` type in `types.ts` for structured inner call rendering.
- `WalletTxRecord` extended with `txType`, `paymaster`, and `innerCallCount` fields for AA-aware history.
- `normalizeRemoteTxRecord` now extracts `aa_bundle` fields (paymaster, inner call count) from chain RPC responses.
- CSS additions: `.storage-badge`, `.badge`, `.badge-batch`, `.badge-sponsored`, `.inner-calls-list`, `.tx-item-batch`.

### Changed
- `getWalletSnapshot` now fetches node info in parallel with balance/nonce/chainId.
- Wallet version aligned to `shell-chain v0.18.0` release track.
- sdk bumped to `0.4.0` (local file dependency).

## [0.3.0] — 2026-04-22

### Added
- Injected dApp provider bridge via `window.shella` and EIP-1193-compatible `window.ethereum`.
- Per-origin connected-site permissions with popup approval flow and revocation UI.
- GitHub Actions CI matrix on Node 20/22 with release metadata verification and production bundle-size guard.
- Deterministic release packaging (`npm run release:bundle`) that emits a zip and SHA-256 checksum in `dist/release/`.

### Changed
- Align `manifest.json` version with `package.json` for release/store consistency.
- Clarify in docs that the large development `background.js` size is caused by inline sourcemaps; production bundles are size-checked separately.
- Keep the wallet on its own release track instead of mirroring `shell-chain` version numbers.

## [0.2.0] — 2026-04-14

### Added
- **4 test suites, 27 tests** covering signing, keystore, provider, and UI components.
- UX improvements: spinner states during transaction submission, network quick-switch button in popup.
- Chrome Web Store preparation: `manifest.json` v3 compliant, store description, privacy policy draft.
- **SDK v0.2.0 integration**: upgraded to stable `ShellSigner` / `ShellProvider` APIs; ML-DSA-65 key generation in-extension.
- Account import/export via keystore JSON.
