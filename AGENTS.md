# AGENTS.md — shella-chrome-wallet

Local single-source-of-truth for AI agents working inside this repository.
This file is fully self-contained; it does not reference any file outside
this submodule.

## What this repo is

Chrome browser wallet extension for **shell-chain** — a
post-quantum-native Layer 1. Provides PQ keystore management and an
Account Abstraction (AA) UX layer (batched calls, paymaster sponsorship,
session keys, guardian recovery).

## Quick commands

```bash
npm install
npm run build      # produces dist/ for chrome://extensions load-unpacked
npm run dev        # watch mode
npm run lint
```

## Cardinal rules

1. **PQ keystore format** is the canonical chain format:
   - JSON v1 schema
   - KDF: argon2id (default `t=3, m=64 MiB, p=1`)
   - AEAD: XChaCha20-Poly1305 with 24-byte nonce
   - Ciphertext contains the **secret key only** (public key is plaintext
     metadata)
   - Address binding: derive Bech32m `pq1...` from the public key and
     embed in the keystore; refuse to decrypt if address mismatches
   - Supported algorithms: Dilithium3, ML-DSA-65, SPHINCS+ (algorithm
     identifier in metadata; no algorithm agility inside ciphertext)
2. **AaBundle wire format** must match the chain exactly: tx type
   `0x7E`, RLP-encoded outer envelope, AaBundle inner structure with
   `inner_calls`, `paymaster_context`, `session_auth`. Never invent
   bundle fields client-side; if the chain spec doesn't define it, the
   wallet doesn't send it.
3. **Never log or persist** raw secret keys, mnemonic phrases, KDF
   passwords, or AEAD plaintext. Memory holding decrypted secrets must be
   zeroized as soon as the user-visible operation completes.
4. **Never bundle test/demo private keys** into release builds. The
   manifest must not include them; the popup must not autofill them.
5. **Origin isolation**: dapp pages get isolated permission grants;
   never allow cross-origin keystore reads.

## Quality gates

A change is mergeable when:

- `npm run lint` passes
- `npm run build` produces a clean `dist/`
- The keystore round-trip (encrypt → save → decrypt) test passes
- A signed AaBundle from this wallet is accepted by a running
  shell-chain node (manual or automated test)
- No new `console.log` calls leak secret material

## Commit / PR conventions

- **Conventional Commits**: `<type>(<scope>): <subject>` —
  `type ∈ {feat, fix, docs, test, refactor, chore, ci}`.
- Commit messages and code comments are **English**.
- AI-authored commits include a `Co-authored-by: Copilot
  <223556219+Copilot@users.noreply.github.com>` trailer; AI-authored
  PR/Issue bodies start with `🤖 本 [Issue/PR] 由 AI Agent 创建`
  (literal template — do not translate).

## Things to never commit

Private keys, mnemonics, keystore JSON files, test fixtures containing
real entropy, `.env`, build artifacts, `node_modules/`.

## Tool pointers (this file is the SSoT)

- `CLAUDE.md` → read this file
- `.cursor/rules/main.mdc` → read this file
- `.github/copilot-instructions.md` → read this file
