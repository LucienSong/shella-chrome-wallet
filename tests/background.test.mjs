import assert from 'node:assert/strict';
import test from 'node:test';

function createStorageArea() {
  const store = new Map();
  return {
    async get(keys) {
      if (keys == null) {
        return Object.fromEntries(store);
      }
      if (typeof keys === 'string') {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, store.has(key) ? store.get(key) : fallback]),
      );
    },
    async set(value) {
      for (const [key, entry] of Object.entries(value)) {
        store.set(key, entry);
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        store.delete(key);
      }
    },
    async clear() {
      store.clear();
    },
  };
}

const listeners = {
  onInstalled: [],
  onStartup: [],
  onMessage: [],
  onAlarm: [],
};
let txCounter = 0;

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener(fn) { listeners.onInstalled.push(fn); } },
    onStartup: { addListener(fn) { listeners.onStartup.push(fn); } },
    onMessage: { addListener(fn) { listeners.onMessage.push(fn); } },
  },
  alarms: {
    create() {},
    clear() {},
    onAlarm: { addListener(fn) { listeners.onAlarm.push(fn); } },
  },
  storage: {
    local: createStorageArea(),
    session: createStorageArea(),
  },
};

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const resultByMethod = {
    eth_getBalance: '0xde0b6b3a7640000',
    eth_getTransactionCount: '0x0',
    eth_chainId: '0x67932',
    shell_getTransactionsByAddress: { transactions: [], total: 0 },
  };

  if (body.method === 'shell_sendTransaction') {
    txCounter += 1;
    resultByMethod.shell_sendTransaction = `0x${txCounter.toString(16).padStart(64, '0')}`;
  }

  if (!(body.method in resultByMethod)) {
    throw new Error(`Unexpected RPC method: ${body.method} (${url})`);
  }

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: resultByMethod[body.method],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

const { handleMessage } = await import('../dist/background.js');

test('create wallet -> snapshot -> export -> reset -> import', async () => {
  txCounter = 0;
  await handleMessage({ type: 'RESET_WALLET' });

  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  assert.match(created.pqAddress, /^pq1/);
  assert.match(created.hexAddress, /^0x[0-9a-f]+$/);

  const snapshot = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
  assert.equal(snapshot.locked, false);
  assert.equal(snapshot.primaryAccount.pqAddress, created.pqAddress);
  assert.equal(snapshot.balance.raw, '1000000000000000000');
  assert.equal(snapshot.nonce, 0);
  assert.equal(snapshot.detectedChainId, 424242);

  const exported = await handleMessage({ type: 'EXPORT_KEYSTORE' });
  assert.match(exported.keystoreJson, /"cipher":"xchacha20-poly1305"/);

  await handleMessage({ type: 'RESET_WALLET' });
  const afterReset = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
  assert.equal(afterReset.primaryAccount, null);

  const imported = await handleMessage({
    type: 'IMPORT_KEYSTORE',
    keystoreJson: exported.keystoreJson,
    password: 'correct horse battery',
  });
  assert.equal(imported.pqAddress, created.pqAddress);
  assert.equal(imported.hexAddress, created.hexAddress);
});

test('send transaction records local pending activity', async () => {
  txCounter = 0;
  await handleMessage({ type: 'RESET_WALLET' });
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const sent = await handleMessage({
    type: 'SEND_TX',
    to: '0x1111111111111111111111111111111111111111',
    value: '1.25',
    data: '0x',
  });
  const sentSecond = await handleMessage({
    type: 'SEND_TX',
    to: '0x2222222222222222222222222222222222222222',
    value: '0.5',
    data: '0x',
  });

  assert.match(sent.txHash, /^0x[0-9a-f]+$/);
  assert.match(sentSecond.txHash, /^0x[0-9a-f]+$/);

  const history = await handleMessage({
    type: 'GET_TX_HISTORY',
    address: created.pqAddress,
    page: 0,
  });

  assert.equal(history.txs.length, 2);
  assert.equal(history.txs[0].status, 'pending');
  assert.equal(history.txs[0].source, 'local');
  assert.equal(history.txs[1].source, 'local');
  assert.deepEqual(history.txs.map((tx) => tx.nonce).sort((a, b) => a - b), [0, 1]);
});
