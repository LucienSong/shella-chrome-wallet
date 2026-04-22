# Changelog

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
