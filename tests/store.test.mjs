/**
 * Tests for the store module (chrome.storage-backed persistence).
 * Mocks chrome.storage.local and chrome.storage.session with in-memory Maps.
 */
import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

function createStorageArea() {
  const store = new Map();
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(store);
      if (typeof keys === 'string') return { [keys]: store.get(keys) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return Object.fromEntries(
        Object.entries(keys).map(([k, fallback]) => [k, store.has(k) ? store.get(k) : fallback]),
      );
    },
    async set(value) {
      for (const [k, v] of Object.entries(value)) store.set(k, v);
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
    },
    async clear() { store.clear(); },
    _store: store,
  };
}

const localArea = createStorageArea();
const sessionArea = createStorageArea();

globalThis.chrome = {
  storage: { local: localArea, session: sessionArea },
};

const {
  initStore,
  getWalletState,
  getAccounts,
  addAccount,
  getNetwork,
  setNetwork,
  getTxQueue,
  setTxQueue,
  upsertTxRecord,
  getAutoLockMinutes,
  setAutoLockMinutes,
  getSessionState,
  setSessionState,
  clearSessionState,
  clearAllData,
  getConnectedSites,
  addConnectedSite,
  removeConnectedSite,
} = await import('../dist/store.js');

describe('store', () => {
  beforeEach(async () => {
    localArea._store.clear();
    sessionArea._store.clear();
    await initStore();
  });

  test('initStore creates default wallet state', async () => {
    const state = await getWalletState();
    assert.deepEqual(state.accounts, []);
    assert.equal(state.autoLockMinutes, 15);
    assert.equal(state.network.name, 'Shell Devnet');
    assert.equal(state.network.chainId, 424242);
    assert.deepEqual(state.connectedSites, []);
    assert.deepEqual(state.txQueue, []);
  });

  test('addAccount persists account and deduplicates by pqAddress', async () => {
    const account = { pqAddress: 'pq1abc', hexAddress: '0x123', keystoreJson: '{}' };
    await addAccount(account);
    await addAccount(account); // duplicate
    const accounts = await getAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].pqAddress, 'pq1abc');
  });

  test('setNetwork persists and getNetwork retrieves', async () => {
    const testnet = { name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' };
    await setNetwork(testnet);
    const net = await getNetwork();
    assert.deepEqual(net, testnet);
  });

  test('upsertTxRecord inserts new records at head', async () => {
    const tx = {
      txHash: '0x' + 'aa'.repeat(32),
      from: '0x1',
      to: '0x2',
      value: '1000',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'pending',
      source: 'local',
    };
    await upsertTxRecord(tx);
    const queue = await getTxQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].txHash, tx.txHash);
  });

  test('upsertTxRecord updates existing record by txHash (case-insensitive)', async () => {
    const hash = '0x' + 'bb'.repeat(32);
    await upsertTxRecord({ txHash: hash, from: '0x1', to: '0x2', value: '1', createdAt: 1, updatedAt: 1, status: 'pending', source: 'local' });
    await upsertTxRecord({ txHash: hash.toUpperCase(), from: '0x1', to: '0x2', value: '1', createdAt: 1, updatedAt: 2, status: 'confirmed', source: 'local' });
    const queue = await getTxQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].status, 'confirmed');
  });

  test('upsertTxRecord caps history at 50 records', async () => {
    for (let i = 0; i < 55; i++) {
      await upsertTxRecord({
        txHash: `0x${i.toString(16).padStart(64, '0')}`,
        from: '0x1', to: '0x2', value: '1',
        createdAt: i, updatedAt: i,
        status: 'confirmed', source: 'local',
      });
    }
    const queue = await getTxQueue();
    assert.ok(queue.length <= 50, `expected ≤50 records, got ${queue.length}`);
  });

  test('autoLockMinutes can be get and set', async () => {
    assert.equal(await getAutoLockMinutes(), 15);
    await setAutoLockMinutes(30);
    assert.equal(await getAutoLockMinutes(), 30);
  });

  test('session state can be set, retrieved, and cleared', async () => {
    await setSessionState({ unlockedPqAddress: 'pq1test', unlockedAt: 12345 });
    const s = await getSessionState();
    assert.equal(s.unlockedPqAddress, 'pq1test');
    assert.equal(s.unlockedAt, 12345);

    await clearSessionState();
    assert.equal(await getSessionState(), null);
  });

  test('connected sites can be added and removed', async () => {
    await addConnectedSite({
      origin: 'https://app.shell.network',
      accounts: ['0x123'],
      chainId: 424242,
      grantedAt: 1,
      lastUsedAt: 2,
    });
    await addConnectedSite({
      origin: 'https://dapp.example.com',
      accounts: ['0x456'],
      chainId: 12345,
      grantedAt: 3,
      lastUsedAt: 4,
    });
    await addConnectedSite({
      origin: 'https://app.shell.network',
      accounts: ['0x789'],
      chainId: 424242,
      grantedAt: 1,
      lastUsedAt: 5,
    }); // replace duplicate by origin
    const sites = await getConnectedSites();
    assert.equal(sites.length, 2);
    assert.equal(sites.find((site) => site.origin === 'https://app.shell.network').accounts[0], '0x789');

    await removeConnectedSite('https://dapp.example.com');
    assert.equal((await getConnectedSites()).length, 1);
  });

  test('clearAllData resets everything to defaults', async () => {
    await addAccount({ pqAddress: 'pq1x', hexAddress: '0x1', keystoreJson: '{}' });
    await setNetwork({ name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' });
    await clearAllData();
    const state = await getWalletState();
    assert.deepEqual(state.accounts, []);
    assert.equal(state.network.name, 'Shell Devnet');
  });

  test('initStore migrates legacy connectedSites strings into stable objects', async () => {
    localArea._store.clear();
    sessionArea._store.clear();
    await localArea.set({
      network: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
      accounts: [],
      autoLockMinutes: 15,
      connectedSites: ['https://legacy.example'],
      txQueue: [],
    });

    await initStore();
    const sites = await getConnectedSites();
    assert.equal(sites.length, 1);
    assert.equal(sites[0].origin, 'https://legacy.example');
    assert.equal(Array.isArray(sites[0].accounts), true);
    assert.equal(typeof sites[0].grantedAt, 'number');

    const stored = await localArea.get('connectedSites');
    assert.equal(typeof stored.connectedSites[0], 'object');
    assert.equal(stored.connectedSites[0].origin, 'https://legacy.example');
  });
});
