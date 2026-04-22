import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

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
const createdAlarms = [];
const clearedAlarms = [];
const createdWindows = [];

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener(fn) { listeners.onInstalled.push(fn); } },
    onStartup: { addListener(fn) { listeners.onStartup.push(fn); } },
    onMessage: { addListener(fn) { listeners.onMessage.push(fn); } },
    getURL(path) { return `chrome-extension://test/${path}`; },
  },
  alarms: {
    create(name, options) {
      createdAlarms.push({ name, options });
    },
    clear(name) {
      clearedAlarms.push(name);
    },
    onAlarm: { addListener(fn) { listeners.onAlarm.push(fn); } },
  },
  windows: {
    create(options, callback) {
      createdWindows.push(options);
      callback?.({ id: createdWindows.length });
    },
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
    eth_blockNumber: '0x2a',
    eth_call: '0x',
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

function resetAlarmState() {
  createdAlarms.length = 0;
  clearedAlarms.length = 0;
  createdWindows.length = 0;
}

function dispatchRuntimeMessage(message) {
  return new Promise((resolve) => {
    listeners.onMessage[0](message, undefined, resolve);
  });
}

async function resolveLatestApproval(approved = true, previousCount = 0) {
  for (let i = 0; i < 10 && createdWindows.length <= previousCount; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(createdWindows.length > previousCount, 'expected an approval popup to be created');
  const latest = createdWindows[createdWindows.length - 1];
  const url = new URL(latest.url);
  const requestId = url.searchParams.get('approvalId');
  assert.ok(requestId, 'approval popup URL should contain requestId');
  const request = await handleMessage({ type: 'GET_APPROVAL_REQUEST', requestId });
  assert.equal(typeof request.kind, 'string');
  await handleMessage({ type: 'RESOLVE_APPROVAL', requestId, approved });
}

describe('background e2e', () => {

test('create wallet -> snapshot -> export -> reset -> import', async () => {
  txCounter = 0;
  resetAlarmState();
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
  resetAlarmState();
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

test('wrong password is reported safely and without internal details', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  const exported = await dispatchRuntimeMessage({
    type: 'CREATE_WALLET',
    password: 'correct horse battery',
  });
  assert.equal(exported.ok, undefined);

  await handleMessage({ type: 'LOCK_WALLET' });
  const response = await dispatchRuntimeMessage({
    type: 'UNLOCK_WALLET',
    password: 'wrong password',
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, 'Incorrect password or corrupted keystore');
  assert.equal(response.error.includes('ciphertext'), false);
  assert.equal(response.error.includes('kdf_params'), false);
});

test('tampered keystore and startup relock are enforced', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });

  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  const exported = await handleMessage({ type: 'EXPORT_KEYSTORE' });
  const tampered = JSON.parse(exported.keystoreJson);
  tampered.public_key = tampered.public_key.replace(/.$/, tampered.public_key.endsWith('0') ? '1' : '0');

  await handleMessage({ type: 'RESET_WALLET' });
  const tamperedResponse = await dispatchRuntimeMessage({
    type: 'IMPORT_KEYSTORE',
    keystoreJson: JSON.stringify(tampered),
    password: 'correct horse battery',
  });
  assert.equal(tamperedResponse.ok, false);
  assert.equal(tamperedResponse.error, 'Public key mismatch — wrong password or corrupt keystore');

  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  assert.equal((await handleMessage({ type: 'CHECK_LOCKED' })).locked, false);
  await listeners.onStartup[0]();
  assert.equal((await handleMessage({ type: 'CHECK_LOCKED' })).locked, true);
});

test('auto-lock can be configured and is triggered by alarm', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  await handleMessage({ type: 'SET_AUTO_LOCK', minutes: 3 });

  assert.equal(createdAlarms.some((alarm) => alarm.name === 'shella-auto-lock'), true);
  await listeners.onAlarm[0]({ name: 'shella-auto-lock' });
  assert.equal((await handleMessage({ type: 'CHECK_LOCKED' })).locked, true);
  assert.equal(clearedAlarms.includes('shella-auto-lock'), true);
});

test('disabling auto-lock clears any existing alarm', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  await handleMessage({ type: 'SET_AUTO_LOCK', minutes: 5 });
  await handleMessage({ type: 'SET_AUTO_LOCK', minutes: 0 });

  assert.equal(clearedAlarms.includes('shella-auto-lock'), true);
});

test('manifest permissions remain minimal', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
});

test('dapp provider grants site access and proxies read methods', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const approvalsBeforeConnect = createdWindows.length;
  const accountsPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://app.shell.org',
    method: 'eth_requestAccounts',
    params: [],
  });
  await resolveLatestApproval(true, approvalsBeforeConnect);
  const accounts = await accountsPromise;
  assert.deepEqual(accounts, [created.hexAddress]);

  const connected = await handleMessage({ type: 'GET_CONNECTED_SITES' });
  assert.equal(connected.sites.length, 1);
  assert.equal(connected.sites[0].origin, 'https://app.shell.org');
  assert.deepEqual(connected.sites[0].accounts, [created.hexAddress]);

  const chainId = await handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://app.shell.org',
    method: 'eth_chainId',
    params: [],
  });
  assert.equal(chainId, '0x67932');

  const blockNumber = await handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://app.shell.org',
    method: 'eth_blockNumber',
    params: [],
  });
  assert.equal(blockNumber, '0x2a');

  const pqAddress = await handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://app.shell.org',
    method: 'shella_getPqAddress',
    params: [],
  });
  assert.equal(pqAddress, created.pqAddress);

  await handleMessage({ type: 'REMOVE_CONNECTED_SITE', origin: 'https://app.shell.org' });
  const noAccounts = await handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://app.shell.org',
    method: 'eth_accounts',
    params: [],
  });
  assert.deepEqual(noAccounts, []);
});

test('dapp provider can send a transaction for a connected site', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const approvalsBeforeConnect = createdWindows.length;
  const connectPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://swap.example.com',
    method: 'eth_requestAccounts',
    params: [],
  });
  await resolveLatestApproval(true, approvalsBeforeConnect);
  await connectPromise;

  const approvalsBeforeSend = createdWindows.length;
  const sentPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://swap.example.com',
    method: 'eth_sendTransaction',
    params: [{
      from: created.hexAddress,
      to: '0x3333333333333333333333333333333333333333',
      value: '0xde0b6b3a7640000',
      data: '0x',
    }],
  });
  await resolveLatestApproval(true, approvalsBeforeSend);
  const sent = await sentPromise;

  assert.match(sent.txHash, /^0x[0-9a-f]+$/);
});

test('wallet_addEthereumChain requires an existing connection and approval', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const denied = await dispatchRuntimeMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://newchain.example',
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: '0x1234',
      chainName: 'Example Chain',
      rpcUrls: ['https://rpc.example'],
    }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'Site not connected: https://newchain.example');

  const approvalsBeforeConnect = createdWindows.length;
  const connectPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://newchain.example',
    method: 'eth_requestAccounts',
    params: [],
  });
  await resolveLatestApproval(true, approvalsBeforeConnect);
  await connectPromise;

  const approvalsBeforeAddChain = createdWindows.length;
  const addChainPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://newchain.example',
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: '0x1234',
      chainName: 'Example Chain',
      rpcUrls: ['https://rpc.example'],
    }],
  });
  await resolveLatestApproval(true, approvalsBeforeAddChain);
  await addChainPromise;

  const network = await handleMessage({ type: 'GET_NETWORK' });
  assert.equal(network.network.chainId, 0x1234);
});

}); // describe('background e2e')
