# Changelog

## [0.17.0] — 2026-04-21

### Added
- GitHub Actions CI matrix on Node 20/22 with release metadata verification and production bundle-size guard.
- Deterministic release packaging (`npm run release:bundle`) that emits a zip and SHA-256 checksum in `dist/release/`.

### Changed
- Bump version to align with shell-chain v0.17.0
- Align `manifest.json` version with `package.json` for release/store consistency.
- Clarify in docs that the large development `background.js` size is caused by inline sourcemaps; production bundles are size-checked separately.

## [0.2.0] — 2026-04-14

### Added
- **4 test suites, 27 tests** covering signing, keystore, provider, and UI components.
- UX improvements: spinner states during transaction submission, network quick-switch button in popup.
- Chrome Web Store preparation: `manifest.json` v3 compliant, store description, privacy policy draft.
- **SDK v0.2.0 integration**: upgraded to stable `ShellSigner` / `ShellProvider` APIs; ML-DSA-65 key generation in-extension.
- Account import/export via keystore JSON.
