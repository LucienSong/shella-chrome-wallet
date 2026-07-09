/**
 * Tests for the crypto module (createKeystore / decryptKeystore).
 * Uses Node's built-in test runner and Web Crypto (available since Node 18).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createKeystore, decryptKeystore } = await import('../dist/crypto.js');
const { deriveShellAddressFromPublicKey } = await import('shell-sdk/address');

function addressFor(publicKey) {
  return deriveShellAddressFromPublicKey(publicKey, 1);
}

describe('crypto', () => {
  test('createKeystore returns a well-formed keystore object', async () => {
    const sk = new Uint8Array(32).fill(0x11);
    const pk = new Uint8Array(32).fill(0x22);
    const address = addressFor(pk);
    const ks = await createKeystore(sk, pk, 'password12345', address, 'mldsa65');

    assert.equal(ks.version, 1);
    assert.equal(ks.address, address);
    assert.equal(ks.key_type, 'mldsa65');
    assert.equal(ks.kdf, 'argon2id');
    assert.equal(ks.cipher, 'xchacha20-poly1305');
    assert.ok(typeof ks.kdf_params.salt === 'string' && ks.kdf_params.salt.length === 32, 'salt should be 16 bytes hex');
    assert.ok(typeof ks.cipher_params.nonce === 'string' && ks.cipher_params.nonce.length === 48, 'nonce should be 24 bytes hex');
    assert.ok(typeof ks.ciphertext === 'string' && ks.ciphertext.length > 0, 'ciphertext should be non-empty');
    assert.ok(typeof ks.public_key === 'string' && ks.public_key.length === 64, 'public_key should be 32 bytes hex');
  });

  test('decryptKeystore round-trips secret and public keys', async () => {
    const sk = new Uint8Array(32);
    const pk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) { sk[i] = i; pk[i] = 255 - i; }

    const ks = await createKeystore(sk, pk, 'strongpassword1', addressFor(pk));
    const result = await decryptKeystore(ks, 'strongpassword1');

    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
    assert.deepEqual(Array.from(result.publicKey), Array.from(pk));
  });

  test('decryptKeystore rejects wrong password with safe error', async () => {
    const sk = new Uint8Array(16).fill(0xab);
    const pk = new Uint8Array(16).fill(0xcd);
    const ks = await createKeystore(sk, pk, 'correctpassword', addressFor(pk));

    await assert.rejects(
      () => decryptKeystore(ks, 'wrongpassword!'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Incorrect password') || err.message.includes('mismatch'));
        assert.ok(!err.message.includes('kdf_params'), 'error must not leak internal keystore details');
        return true;
      },
    );
  });

  test('two keystores from same key have different ciphertexts (random nonce/salt)', async () => {
    const sk = new Uint8Array(8).fill(1);
    const pk = new Uint8Array(8).fill(2);
    const address = addressFor(pk);
    const ks1 = await createKeystore(sk, pk, 'samepassword1', address);
    const ks2 = await createKeystore(sk, pk, 'samepassword1', address);
    assert.notEqual(ks1.ciphertext, ks2.ciphertext, 'each keystore should use a fresh nonce');
  });

  test('decryptKeystore accepts JSON string input', async () => {
    const sk = new Uint8Array(8).fill(5);
    const pk = new Uint8Array(8).fill(6);
    const ks = await createKeystore(sk, pk, 'pass12345678', addressFor(pk));
    const result = await decryptKeystore(JSON.stringify(ks), 'pass12345678');
    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
  });

  test('decryptKeystore does not truncate canonical secret keys that end with the public key', async () => {
    const pk = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const sk = new Uint8Array([0x01, 0x02, 0x03, 0x04, ...pk]);
    const ks = await createKeystore(sk, pk, 'pass12345678', addressFor(pk));

    const result = await decryptKeystore(ks, 'pass12345678');

    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
  });

  test('decryptKeystore still imports unknown future key_type strings', async () => {
    const sk = new Uint8Array(8).fill(7);
    const pk = new Uint8Array(8).fill(8);
    const ks = await createKeystore(sk, pk, 'pass12345678', addressFor(pk));
    ks.key_type = 'future-pq-algorithm';

    const result = await decryptKeystore(ks, 'pass12345678');

    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
    assert.deepEqual(Array.from(result.publicKey), Array.from(pk));
  });
});
