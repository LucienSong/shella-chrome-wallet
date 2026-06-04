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
let shellTxHistoryResult = { transactions: [], total: 0 };

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
    shell_getTransactionsByAddress: shellTxHistoryResult,
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
  assert.match(created.pqAddress, /^0x[0-9a-f]{64}$/);

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
});

test('send transaction records local pending activity', async () => {
  txCounter = 0;
  shellTxHistoryResult = { transactions: [], total: 0 };
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const sent = await handleMessage({
    type: 'SEND_TX',
    to: created.pqAddress,
    value: '1.25',
    data: '0x',
  });
  const sentSecond = await handleMessage({
    type: 'SEND_TX',
    to: created.pqAddress,
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

test('remote transaction history preserves reward metadata', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  shellTxHistoryResult = {
    total: 1,
    transactions: [{
      hash: '0x' + 'a'.repeat(64),
      from: 'pq1prover',
      to: created.pqAddress,
      value: '50000000000000000000',
      input: '0x',
      timestamp: 1234,
      status: 'confirmed',
      blockNumber: '0x2a',
      type: '0x0',
      shellType: 'starkReward',
      rewardKind: 'starkReward',
      rewardLayer: '0x2',
      rewardSourceHash: '0x' + 'b'.repeat(64),
      originalSize: '0x2710',
      compressedSize: '0x80',
    }],
  };

  const history = await handleMessage({
    type: 'GET_TX_HISTORY',
    address: created.pqAddress,
    page: 0,
  });

  assert.equal(history.total, 1);
  assert.equal(history.txs.length, 1);
  assert.deepEqual({
    shellType: history.txs[0].shellType,
    rewardKind: history.txs[0].rewardKind,
    rewardLayer: history.txs[0].rewardLayer,
    rewardSourceHash: history.txs[0].rewardSourceHash,
    originalSize: history.txs[0].originalSize,
    compressedSize: history.txs[0].compressedSize,
  }, {
    shellType: 'starkReward',
    rewardKind: 'starkReward',
    rewardLayer: '0x2',
    rewardSourceHash: '0x' + 'b'.repeat(64),
    originalSize: '0x2710',
    compressedSize: '0x80',
  });
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
  assert.equal(tamperedResponse.error, 'Keystore address does not match public key');

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
  assert.deepEqual(accounts, [created.pqAddress]);

  const connected = await handleMessage({ type: 'GET_CONNECTED_SITES' });
  assert.equal(connected.sites.length, 1);
  assert.equal(connected.sites[0].origin, 'https://app.shell.org');
  assert.deepEqual(connected.sites[0].accounts, [created.pqAddress]);

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
      from: created.pqAddress,
      to: created.pqAddress,
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

test('WALLET-H1: signing works after create/unlock (key not zeroed inside adapter)', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });

  // Create wallet — H1 bug would zero the adapter key here
  const created = await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });
  assert.ok(created.pqAddress, 'CREATE_WALLET must return a pqAddress');

  // If the signer's key were zeroed, SEND_TX would produce a zero-key signature
  // that the RPC mock would reject or return a wrong txHash.
  const sent = await handleMessage({
    type: 'SEND_TX',
    to: created.pqAddress,
    value: '0.1',
    data: '0x',
  });
  assert.match(sent.txHash, /^0x[0-9a-f]+$/, 'SEND_TX after CREATE_WALLET should return a valid txHash');

  // Lock then re-unlock and sign again — H1 also affects unlockWallet path.
  await handleMessage({ type: 'LOCK_WALLET' });
  const unlocked = await handleMessage({ type: 'UNLOCK_WALLET', password: 'correct horse battery' });
  assert.equal(unlocked.ok, true);

  const sentAfterUnlock = await handleMessage({
    type: 'SEND_TX',
    to: created.pqAddress,
    value: '0.1',
    data: '0x',
  });
  assert.match(sentAfterUnlock.txHash, /^0x[0-9a-f]+$/, 'SEND_TX after UNLOCK_WALLET should return a valid txHash');
});

test('WALLET-H2: wallet_addEthereumChain rejects non-https and private IP RPC URLs', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  // Connect site first
  const approvalsBeforeConnect = createdWindows.length;
  const connectPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://evil.example',
    method: 'eth_requestAccounts',
    params: [],
  });
  await resolveLatestApproval(true, approvalsBeforeConnect);
  await connectPromise;

  const badUrls = [
    'http://192.168.1.1:8545',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'ftp://rpc.example',
    'javascript:alert(1)',
    'not-a-url',
  ];

  for (const rpcUrl of badUrls) {
    const response = await dispatchRuntimeMessage({
      type: 'DAPP_REQUEST',
      origin: 'https://evil.example',
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x9999', chainName: 'Evil Chain', rpcUrls: [rpcUrl] }],
    });
    assert.equal(response.ok, false, `Expected rejection for rpcUrl: ${rpcUrl}`);
  }
});

test('WALLET-H2: wallet_addEthereumChain accepts https and localhost http URLs', async () => {
  txCounter = 0;
  resetAlarmState();
  await handleMessage({ type: 'RESET_WALLET' });
  await handleMessage({ type: 'CREATE_WALLET', password: 'correct horse battery' });

  const approvalsBeforeConnect = createdWindows.length;
  const connectPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://good.example',
    method: 'eth_requestAccounts',
    params: [],
  });
  await resolveLatestApproval(true, approvalsBeforeConnect);
  await connectPromise;

  const approvalsBeforeAdd = createdWindows.length;
  const addPromise = handleMessage({
    type: 'DAPP_REQUEST',
    origin: 'https://good.example',
    method: 'wallet_addEthereumChain',
    params: [{ chainId: '0xabcd', chainName: 'Good Chain', rpcUrls: ['https://rpc.good.example'] }],
  });
  await resolveLatestApproval(true, approvalsBeforeAdd);
  const result = await addPromise;
  assert.equal(result, null);
});

test('WALLET-M2: privileged messages from content scripts are blocked', async () => {
  const privilegedTypes = ['EXPORT_KEYSTORE', 'SEND_TX', 'UNLOCK_WALLET', 'CREATE_WALLET',
    'IMPORT_KEYSTORE', 'RESET_WALLET'];

  for (const type of privilegedTypes) {
    const response = await new Promise((resolve) => {
      // Simulate a content script sender by providing a sender with .tab set
      listeners.onMessage[0]({ type }, { tab: { id: 1 } }, resolve);
    });
    assert.equal(response.ok, false, `${type} should be blocked from content scripts`);
    assert.equal(response.error, 'Unauthorized', `${type} should return Unauthorized`);
  }
});

}); // describe('background e2e')

// ──────── Multi-account tests ────────

describe('multi-account', () => {
  const PASSWORD = 'correct horse battery';
  const PASSWORD2 = 'different horse battery';

  async function resetAndCreate() {
    await handleMessage({ type: 'RESET_WALLET' });
    return handleMessage({ type: 'CREATE_WALLET', password: PASSWORD });
  }

  test('ADD_ACCOUNT creates a second account without changing active signer', async () => {
    const first = await resetAndCreate();
    const signerAddressBefore = (await handleMessage({ type: 'GET_WALLET_SNAPSHOT' })).activeAddress;

    const second = await handleMessage({ type: 'ADD_ACCOUNT', password: PASSWORD2 });
    assert.ok(second.pqAddress, 'ADD_ACCOUNT must return a pqAddress');
    assert.notEqual(second.pqAddress, first.pqAddress, 'Second account must have a different address');

    // Active signer must remain unchanged
    const snapshot = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
    assert.equal(snapshot.activeAddress, signerAddressBefore, 'Active account must not change after ADD_ACCOUNT');
    assert.equal(snapshot.wallet.accounts.length, 2, 'Wallet must now have two accounts');
  });

  test('SWITCH_ACCOUNT changes the active signer to the target account', async () => {
    const first = await resetAndCreate();
    const second = await handleMessage({ type: 'ADD_ACCOUNT', password: PASSWORD2 });

    const switched = await handleMessage({ type: 'SWITCH_ACCOUNT', password: PASSWORD2, address: second.pqAddress });
    assert.ok(switched.ok, 'SWITCH_ACCOUNT must return ok: true');
    assert.equal(switched.pqAddress, second.pqAddress, 'SWITCH_ACCOUNT must return the new address');

    const snapshot = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
    assert.equal(snapshot.activeAddress, second.pqAddress, 'Active address must be the switched-to account');
    assert.notEqual(snapshot.activeAddress, first.pqAddress, 'Must no longer be the first account');
  });

  test('SWITCH_ACCOUNT with wrong password throws and leaves signer unchanged', async () => {
    await resetAndCreate();
    const second = await handleMessage({ type: 'ADD_ACCOUNT', password: PASSWORD2 });

    const snapshotBefore = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
    let threw = false;
    try {
      await handleMessage({ type: 'SWITCH_ACCOUNT', password: 'wrongpassword', address: second.pqAddress });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'SWITCH_ACCOUNT with wrong password must throw');

    const snapshotAfter = await handleMessage({ type: 'GET_WALLET_SNAPSHOT' });
    assert.equal(snapshotAfter.activeAddress, snapshotBefore.activeAddress, 'Signer must be unchanged after failed switch');
  });

  test('SWITCH_ACCOUNT with unknown address throws', async () => {
    await resetAndCreate();

    let threw = false;
    try {
      await handleMessage({ type: 'SWITCH_ACCOUNT', password: PASSWORD, address: '0x' + 'ab'.repeat(32) });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'SWITCH_ACCOUNT with unknown address must throw');
  });

  test('EXPORT_KEYSTORE exports the currently active account', async () => {
    const first = await resetAndCreate();
    const second = await handleMessage({ type: 'ADD_ACCOUNT', password: PASSWORD2 });

    // Before switch — should export first account
    const exportedFirst = await handleMessage({ type: 'EXPORT_KEYSTORE' });
    const parsedFirst = JSON.parse(exportedFirst.keystoreJson);
    assert.equal(parsedFirst.address, first.pqAddress, 'EXPORT_KEYSTORE must export the active (first) account');

    // After switch — should export second account
    await handleMessage({ type: 'SWITCH_ACCOUNT', password: PASSWORD2, address: second.pqAddress });
    const exportedSecond = await handleMessage({ type: 'EXPORT_KEYSTORE' });
    const parsedSecond = JSON.parse(exportedSecond.keystoreJson);
    assert.equal(parsedSecond.address, second.pqAddress, 'EXPORT_KEYSTORE must export the switched-to account');
  });

  test('UNLOCK_WALLET with explicit address unlocks that specific account', async () => {
    await resetAndCreate();
    const second = await handleMessage({ type: 'ADD_ACCOUNT', password: PASSWORD2 });

    await handleMessage({ type: 'LOCK_WALLET' });

    const unlocked = await handleMessage({ type: 'UNLOCK_WALLET', password: PASSWORD2, address: second.pqAddress });
    assert.ok(unlocked.ok, 'UNLOCK_WALLET with address must return ok: true');
    assert.equal(unlocked.pqAddress, second.pqAddress, 'Must unlock the specified account');
  });
});
