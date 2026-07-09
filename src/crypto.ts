/**
 * Pure-JS keystore creation and decryption for Shell Chain.
 *
 * Uses @noble/hashes (argon2id, pure JS) and @noble/ciphers (xchacha20-poly1305)
 * to avoid any WASM dependencies in the Chrome extension context.
 *
 * Output format is fully compatible with Shell CLI keystores.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { deriveShellAddressFromPublicKey } from 'shell-sdk/address';
import { SIGNATURE_TYPE_IDS, signatureTypeFromKeyType } from 'shell-sdk/signer';
import type { ShellEncryptedKey } from 'shell-sdk/types';

// Default argon2id parameters (balanced security/performance for browser context)
const DEFAULT_KDF_PARAMS = {
  m_cost: 65536, // 64 MB
  t_cost: 2,     // 2 iterations
  p_cost: 1,     // 1 parallelism
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error('invalid hex string');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  params: { m_cost: number; t_cost: number; p_cost: number },
): Promise<Uint8Array> {
  return argon2idAsync(new TextEncoder().encode(password), salt, {
    m: params.m_cost,
    t: params.t_cost,
    p: params.p_cost,
    dkLen: 32,
  });
}

function algorithmIdFromKeyType(keyType: string): number {
  return SIGNATURE_TYPE_IDS[signatureTypeFromKeyType(keyType)];
}

function validateKeystoreAddress(ek: ShellEncryptedKey, publicKey: Uint8Array): void {
  let algorithmId: number;
  try {
    algorithmId = algorithmIdFromKeyType(ek.key_type);
  } catch {
    return;
  }
  const expected = deriveShellAddressFromPublicKey(publicKey, algorithmId);
  if (ek.address.toLowerCase() !== expected) {
    throw new Error('Keystore address does not match public key');
  }
}

function expectedLegacySecretKeyLength(keyType: string): number | null {
  try {
    const algorithmId = algorithmIdFromKeyType(keyType);
    switch (algorithmId) {
      case 0:
      case 1:
        return 4032;
      case 2:
        return 128;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Encrypt a PQ key pair as a Shell-compatible keystore JSON.
 *
 * @param secretKey - Raw secret key bytes.
 * @param publicKey - Raw public key bytes.
 * @param password  - User password for encryption.
 * @param address   - 0x… hex address.
 * @param keyType   - Key type string, e.g. "mldsa65".
 */
export async function createKeystore(
  secretKey: Uint8Array,
  publicKey: Uint8Array,
  password: string,
  address: string,
  keyType: string = 'mldsa65',
): Promise<ShellEncryptedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const params = DEFAULT_KDF_PARAMS;

  const derivedKey = await deriveKey(password, salt, params);

  const expectedAddress = deriveShellAddressFromPublicKey(publicKey, algorithmIdFromKeyType(keyType));
  if (address.toLowerCase() !== expectedAddress) {
    throw new Error('Keystore address does not match public key');
  }

  // Canonical Shell keystore ciphertext contains only the secret key.
  const plaintext = secretKey.slice();

  const cipher = xchacha20poly1305(derivedKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  // Zero out sensitive material
  plaintext.fill(0);
  derivedKey.fill(0);

  return {
    version: 1,
    address,
    key_type: keyType,
    kdf: 'argon2id',
    kdf_params: {
      m_cost: params.m_cost,
      t_cost: params.t_cost,
      p_cost: params.p_cost,
      salt: bytesToHex(salt),
    },
    cipher: 'xchacha20-poly1305',
    cipher_params: { nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ciphertext),
    public_key: bytesToHex(publicKey),
  };
}

/**
 * Encrypt an HD seed (64 bytes) as a Shell-compatible keystore JSON.
 *
 * @param seed     - 64-byte BIP-39 seed.
 * @param password - User password.
 * @param address  - Default ML-DSA-65 account 0 address (used as label).
 */
export async function encryptHdSeed(
  seed: Uint8Array,
  password: string,
  address: string,
): Promise<ShellEncryptedKey> {
  if (seed.length !== 64) throw new Error('HD seed must be exactly 64 bytes');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const params = DEFAULT_KDF_PARAMS;

  const derivedKey = await deriveKey(password, salt, params);
  const plaintext = seed.slice();
  const cipher = xchacha20poly1305(derivedKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  plaintext.fill(0);
  derivedKey.fill(0);

  return {
    version: 1,
    address,
    key_type: 'hd-seed',
    kdf: 'argon2id',
    kdf_params: { m_cost: params.m_cost, t_cost: params.t_cost, p_cost: params.p_cost, salt: bytesToHex(salt) },
    cipher: 'xchacha20-poly1305',
    cipher_params: { nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ciphertext),
    public_key: '',
  };
}

/**
 * Decrypt an HD seed keystore and return the 64-byte seed.
 */
export async function decryptHdSeed(
  input: string | ShellEncryptedKey,
  password: string,
): Promise<Uint8Array> {
  const ek: ShellEncryptedKey = typeof input === 'string' ? JSON.parse(input) : input;
  if (ek.key_type !== 'hd-seed') throw new Error('Not an hd-seed keystore');
  if (ek.kdf !== 'argon2id') throw new Error('Unsupported KDF: ' + ek.kdf);
  if (ek.cipher !== 'xchacha20-poly1305') throw new Error('Unsupported cipher: ' + ek.cipher);

  const salt = hexToBytes(ek.kdf_params.salt);
  const nonce = hexToBytes(ek.cipher_params.nonce);
  const ciphertext = hexToBytes(ek.ciphertext);

  const derivedKey = await deriveKey(password, salt, {
    m_cost: ek.kdf_params.m_cost,
    t_cost: ek.kdf_params.t_cost,
    p_cost: ek.kdf_params.p_cost,
  });

  let plaintext: Uint8Array;
  try {
    const cipher = xchacha20poly1305(derivedKey, nonce);
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    derivedKey.fill(0);
    throw new Error('Incorrect password or corrupted HD seed keystore');
  } finally {
    derivedKey.fill(0);
  }

  if (plaintext.length !== 64) {
    plaintext.fill(0);
    throw new Error('HD seed must be exactly 64 bytes');
  }
  return plaintext;
}

/**
 * Encrypt a BIP-39 mnemonic string for secure storage.
 * The mnemonic is UTF-8-encoded and treated as the secret payload.
 */
export async function encryptMnemonic(
  mnemonic: string,
  password: string,
): Promise<ShellEncryptedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const params = DEFAULT_KDF_PARAMS;

  const derivedKey = await deriveKey(password, salt, params);
  const plaintext = new TextEncoder().encode(mnemonic);
  const cipher = xchacha20poly1305(derivedKey, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  derivedKey.fill(0);

  return {
    version: 1,
    address: '',
    key_type: 'hd-mnemonic',
    kdf: 'argon2id',
    kdf_params: { m_cost: params.m_cost, t_cost: params.t_cost, p_cost: params.p_cost, salt: bytesToHex(salt) },
    cipher: 'xchacha20-poly1305',
    cipher_params: { nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ciphertext),
    public_key: '',
  };
}

/**
 * Decrypt a mnemonic keystore and return the BIP-39 phrase.
 */
export async function decryptMnemonic(
  input: string | ShellEncryptedKey,
  password: string,
): Promise<string> {
  const ek: ShellEncryptedKey = typeof input === 'string' ? JSON.parse(input) : input;
  if (ek.key_type !== 'hd-mnemonic') throw new Error('Not an hd-mnemonic keystore');
  if (ek.kdf !== 'argon2id') throw new Error('Unsupported KDF: ' + ek.kdf);
  if (ek.cipher !== 'xchacha20-poly1305') throw new Error('Unsupported cipher: ' + ek.cipher);

  const salt = hexToBytes(ek.kdf_params.salt);
  const nonce = hexToBytes(ek.cipher_params.nonce);
  const ciphertext = hexToBytes(ek.ciphertext);

  const derivedKey = await deriveKey(password, salt, {
    m_cost: ek.kdf_params.m_cost,
    t_cost: ek.kdf_params.t_cost,
    p_cost: ek.kdf_params.p_cost,
  });

  let plaintext: Uint8Array;
  try {
    const cipher = xchacha20poly1305(derivedKey, nonce);
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    derivedKey.fill(0);
    throw new Error('Incorrect password or corrupted mnemonic keystore');
  } finally {
    derivedKey.fill(0);
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Decrypt a Shell keystore and return the raw key pair bytes.
 * Compatible with Shell CLI keystores (argon2id + xchacha20-poly1305).
 */
export async function decryptKeystore(
  input: string | ShellEncryptedKey,
  password: string,
): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array }> {
  const ek: ShellEncryptedKey = typeof input === 'string' ? JSON.parse(input) : input;

  if (ek.kdf !== 'argon2id') throw new Error('Unsupported KDF: ' + ek.kdf);
  if (ek.cipher !== 'xchacha20-poly1305')
    throw new Error('Unsupported cipher: ' + ek.cipher);

  const salt = hexToBytes(ek.kdf_params.salt);
  const nonce = hexToBytes(ek.cipher_params.nonce);
  const ciphertext = hexToBytes(ek.ciphertext);
  const storedPubkey = hexToBytes(ek.public_key);

  const derivedKey = await deriveKey(password, salt, {
    m_cost: ek.kdf_params.m_cost,
    t_cost: ek.kdf_params.t_cost,
    p_cost: ek.kdf_params.p_cost,
  });

  let plaintext: Uint8Array;
  try {
    const cipher = xchacha20poly1305(derivedKey, nonce);
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    derivedKey.fill(0);
    throw new Error('Incorrect password or corrupted keystore');
  } finally {
    derivedKey.fill(0);
  }

  if (plaintext.length === 0) {
    plaintext.fill(0);
    throw new Error('Keystore payload too short');
  }

  let secretKey: Uint8Array;
  const legacySecretKeyLength = expectedLegacySecretKeyLength(ek.key_type);
  if (
    legacySecretKeyLength !== null &&
    plaintext.length === legacySecretKeyLength + storedPubkey.length &&
    plaintext.slice(legacySecretKeyLength).every((b, i) => b === storedPubkey[i])
  ) {
    // Backward compatibility for older wallet exports that encrypted [sk || pk].
    secretKey = plaintext.slice(0, plaintext.length - storedPubkey.length);
  } else {
    secretKey = plaintext.slice();
  }
  plaintext.fill(0);

  try {
    validateKeystoreAddress(ek, storedPubkey);
  } catch (err) {
    secretKey.fill(0);
    throw err;
  }

  return { secretKey, publicKey: storedPubkey };
}
