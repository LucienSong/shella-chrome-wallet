/**
 * Tests for the crypto module (createKeystore / decryptKeystore).
 * Uses Node's built-in test runner and Web Crypto (available since Node 18).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createKeystore, decryptKeystore } = await import('../dist/crypto.js');

describe('crypto', () => {
  test('createKeystore returns a well-formed keystore object', async () => {
    const sk = new Uint8Array(32).fill(0x11);
    const pk = new Uint8Array(32).fill(0x22);
    const ks = await createKeystore(sk, pk, 'password12345', 'pq1testaddress', 'mldsa65');

    assert.equal(ks.version, 1);
    assert.equal(ks.address, 'pq1testaddress');
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

    const ks = await createKeystore(sk, pk, 'strongpassword1', 'pq1abc');
    const result = await decryptKeystore(ks, 'strongpassword1');

    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
    assert.deepEqual(Array.from(result.publicKey), Array.from(pk));
  });

  test('decryptKeystore rejects wrong password with safe error', async () => {
    const sk = new Uint8Array(16).fill(0xab);
    const pk = new Uint8Array(16).fill(0xcd);
    const ks = await createKeystore(sk, pk, 'correctpassword', 'pq1addr');

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
    const ks1 = await createKeystore(sk, pk, 'samepassword1', 'pq1x');
    const ks2 = await createKeystore(sk, pk, 'samepassword1', 'pq1x');
    assert.notEqual(ks1.ciphertext, ks2.ciphertext, 'each keystore should use a fresh nonce');
  });

  test('decryptKeystore accepts JSON string input', async () => {
    const sk = new Uint8Array(8).fill(5);
    const pk = new Uint8Array(8).fill(6);
    const ks = await createKeystore(sk, pk, 'pass12345678', 'pq1y');
    const result = await decryptKeystore(JSON.stringify(ks), 'pass12345678');
    assert.deepEqual(Array.from(result.secretKey), Array.from(sk));
  });
});
