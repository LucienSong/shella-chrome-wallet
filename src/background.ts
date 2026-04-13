/**
 * Shella Wallet — background service worker.
 *
 * Handles wallet lifecycle: key generation, encryption/decryption, lock/unlock,
 * transaction signing, receipt tracking, and RPC proxying.
 */

import { MlDsa65Adapter, generateMlDsa65KeyPair } from 'shell-sdk/adapters';
import { normalizeHexAddress } from 'shell-sdk/address';
import { createShellProvider } from 'shell-sdk/provider';
import { ShellSigner } from 'shell-sdk/signer';
import { buildTransaction, buildTransferTransaction, hashTransaction } from 'shell-sdk/transactions';
import type { ShellEncryptedKey } from 'shell-sdk/types';
import { defineChain, parseEther } from 'viem';
import { createKeystore, decryptKeystore } from './crypto.js';
import {
  addAccount,
  addConnectedSite,
  clearAllData,
  clearSessionState,
  getAccounts,
  getAutoLockMinutes,
  getConnectedSites,
  getNetwork,
  getTxQueue,
  getWalletState,
  initStore,
  removeConnectedSite,
  setAutoLockMinutes,
  setNetwork,
  setSessionState,
  setTxQueue,
  upsertTxRecord,
} from './store.js';
import type {
  Network,
  SendTransactionParams,
  StoredAccount,
  WalletSnapshot,
  WalletTxRecord,
} from './types.js';

const AUTO_LOCK_ALARM = 'shella-auto-lock';
const TX_POLL_ALARM = 'shella-tx-poll';

let currentSigner: ShellSigner | null = null;

chrome.runtime.onInstalled.addListener(async () => {
  await initStore();
  await pollPendingTransactions();
});

chrome.runtime.onStartup.addListener(async () => {
  currentSigner = null;
  await clearSessionState();
  await pollPendingTransactions();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    await lockWallet();
    return;
  }
  if (alarm.name === TX_POLL_ALARM) {
    await pollPendingTransactions();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg as { type: string; [key: string]: unknown })
    .then(sendResponse)
    .catch((err: unknown) => {
      sendResponse({ ok: false, error: toSafeErrorMessage(err) });
    });
  return true;
});

async function scheduleAutoLock(): Promise<void> {
  const minutes = await getAutoLockMinutes();
  if (minutes > 0) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
    return;
  }
  chrome.alarms.clear(AUTO_LOCK_ALARM);
}

async function scheduleTxPolling(): Promise<void> {
  const txQueue = await getTxQueue();
  if (txQueue.some((tx) => tx.status === 'pending')) {
    chrome.alarms.create(TX_POLL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } else {
    chrome.alarms.clear(TX_POLL_ALARM);
  }
}

async function lockWallet(): Promise<void> {
  currentSigner = null;
  await clearSessionState();
  chrome.alarms.clear(AUTO_LOCK_ALARM);
}

export async function handleMessage(msg: { type: string; [key: string]: unknown }): Promise<unknown> {
  switch (msg.type) {
    case 'CREATE_WALLET':
      return createWallet(requirePassword(msg.password));
    case 'IMPORT_KEYSTORE':
      return importKeystore(requireString(msg.keystoreJson, 'keystoreJson'), requirePassword(msg.password));
    case 'UNLOCK_WALLET':
      return unlockWallet(requirePassword(msg.password));
    case 'LOCK_WALLET':
      await lockWallet();
      return { ok: true };
    case 'CHECK_LOCKED':
      return { locked: currentSigner === null };
    case 'GET_WALLET_SNAPSHOT':
      return getWalletSnapshot();
    case 'GET_ACCOUNTS':
      return { accounts: await getAccounts() };
    case 'GET_BALANCE':
      return getBalance(requireString(msg.address, 'address'));
    case 'SEND_TX':
      return sendTransaction({
        to: requireString(msg.to, 'to'),
        value: requireString(msg.value, 'value'),
        data: optionalString(msg.data),
        gasLimit: optionalNumber(msg.gasLimit),
        maxFeePerGas: optionalNumber(msg.maxFeePerGas),
        maxPriorityFeePerGas: optionalNumber(msg.maxPriorityFeePerGas),
      });
    case 'GET_TX_HISTORY':
      return getTxHistory(requireString(msg.address, 'address'), optionalNumber(msg.page) ?? 0);
    case 'GET_NETWORK':
      return { network: await getNetwork() };
    case 'SET_NETWORK':
      await setNetwork(validateNetwork(msg.network));
      return { ok: true };
    case 'EXPORT_KEYSTORE': {
      const accounts = await getAccounts();
      if (accounts.length === 0) throw new Error('No wallet to export');
      return { keystoreJson: accounts[0].keystoreJson };
    }
    case 'RESET_WALLET':
      await lockWallet();
      await clearAllData();
      return { ok: true };
    case 'SET_AUTO_LOCK':
      await setAutoLockMinutes(requireNumber(msg.minutes, 'minutes'));
      await scheduleAutoLock();
      return { ok: true };
    case 'GET_CONNECTED_SITES':
      return { sites: await getConnectedSites() };
    case 'ADD_CONNECTED_SITE':
      await addConnectedSite(requireString(msg.origin, 'origin'));
      return { ok: true };
    case 'REMOVE_CONNECTED_SITE':
      await removeConnectedSite(requireString(msg.origin, 'origin'));
      return { ok: true };
    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

async function createWallet(password: string): Promise<{ pqAddress: string; hexAddress: string }> {
  const { publicKey: pk, secretKey: sk } = generateMlDsa65KeyPair();
  const adapter = MlDsa65Adapter.fromKeyPair(pk, sk);
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();
  const hexAddress = signer.getHexAddress();

  const keystore = await createKeystore(sk, pk, password, pqAddress, 'mldsa65');
  const account: StoredAccount = { pqAddress, hexAddress, keystoreJson: JSON.stringify(keystore) };
  await addAccount(account);

  currentSigner = signer;
  await setSessionState({
    unlockedPqAddress: pqAddress,
    unlockedAt: Date.now(),
  });
  await scheduleAutoLock();
  sk.fill(0);

  return { pqAddress, hexAddress };
}

async function importKeystore(
  keystoreJson: string,
  password: string,
): Promise<{ pqAddress: string; hexAddress: string }> {
  const parsed = parseKeystorePayload(keystoreJson);
  const { secretKey, publicKey } = await decryptKeystore(parsed, password);

  const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();
  const hexAddress = signer.getHexAddress();

  const account: StoredAccount = { pqAddress, hexAddress, keystoreJson: JSON.stringify(parsed) };
  await addAccount(account);

  currentSigner = signer;
  await setSessionState({ unlockedPqAddress: pqAddress, unlockedAt: Date.now() });
  await scheduleAutoLock();
  secretKey.fill(0);

  return { pqAddress, hexAddress };
}

async function unlockWallet(password: string): Promise<{ ok: boolean; pqAddress?: string }> {
  const accounts = await getAccounts();
  if (accounts.length === 0) throw new Error('No wallet found');

  const account = accounts[0];
  const { secretKey, publicKey } = await decryptKeystore(account.keystoreJson, password);

  const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
  currentSigner = new ShellSigner('MlDsa65', adapter);

  await setSessionState({ unlockedPqAddress: account.pqAddress, unlockedAt: Date.now() });
  await scheduleAutoLock();
  secretKey.fill(0);

  return { ok: true, pqAddress: account.pqAddress };
}

async function getWalletSnapshot(): Promise<WalletSnapshot> {
  const wallet = await getWalletState();
  const primaryAccount = wallet.accounts[0] ?? null;
  const locked = currentSigner === null;

  if (!primaryAccount) {
    return {
      locked,
      wallet,
      primaryAccount: null,
      balance: null,
      nonce: null,
      detectedChainId: null,
    };
  }

  try {
    const provider = buildProvider(wallet.network);
    const [balance, nonce, detectedChainId] = await Promise.all([
      provider.client.getBalance({ address: primaryAccount.hexAddress as `0x${string}` }),
      provider.client.getTransactionCount({ address: primaryAccount.hexAddress as `0x${string}` }),
      provider.client.getChainId(),
    ]);
    return {
      locked,
      wallet,
      primaryAccount,
      balance: {
        raw: balance.toString(),
        formatted: formatEther(balance),
      },
      nonce,
      detectedChainId,
    };
  } catch {
    return {
      locked,
      wallet,
      primaryAccount,
      balance: null,
      nonce: null,
      detectedChainId: null,
    };
  }
}

async function getBalance(address: string): Promise<{ balance: string; formatted: string }> {
  const network = await getNetwork();
  const provider = buildProvider(network);
  const hexAddr = address.startsWith('0x') ? (address as `0x${string}`) : toHexAddress(address);
  const balance = await provider.client.getBalance({ address: hexAddr });
  return { balance: balance.toString(), formatted: formatEther(balance) };
}

async function sendTransaction(params: SendTransactionParams): Promise<{ txHash: string }> {
  if (!currentSigner) throw new Error('Wallet is locked');

  const network = await getNetwork();
  const provider = buildProvider(network);
  const from = currentSigner.getHexAddress();
  const to = normalizeRecipient(params.to);
  const valueBigInt = parseEtherValue(params.value);
  const data = normalizeData(params.data);

  const onChainNonce = await provider.client.getTransactionCount({ address: from });
  const nonce = await allocateNextNonce(from, onChainNonce);
  const tx = data === '0x'
    ? buildTransferTransaction({
        chainId: network.chainId,
        nonce,
        to,
        value: valueBigInt,
        gasLimit: params.gasLimit,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      })
    : buildTransaction({
        chainId: network.chainId,
        nonce,
        to,
        value: valueBigInt,
        data,
        gasLimit: params.gasLimit,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      });

  const signed = await currentSigner.buildSignedTransaction({
    tx,
    txHash: hashTransaction(tx),
    includePublicKey: nonce === 0,
  });

  const txHash = await provider.sendTransaction(signed);
  await upsertTxRecord({
    txHash,
    from,
    to: to.startsWith('0x') ? to : normalizeHexAddress(to),
    value: valueBigInt.toString(),
    data,
    nonce,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'pending',
    source: 'local',
  });
  await scheduleTxPolling();

  return { txHash };
}

async function getTxHistory(
  address: string,
  page: number,
): Promise<{ txs: WalletTxRecord[]; total: number }> {
  const network = await getNetwork();
  const provider = buildProvider(network);
  const result = (await provider.getTransactionsByAddress(address, {
    page,
    limit: 20,
  })) as { transactions?: unknown[]; total?: number } | null;

  const remoteTxs = (result?.transactions ?? [])
    .map((tx) => normalizeRemoteTxRecord(tx))
    .filter((tx): tx is WalletTxRecord => tx !== null);

  const localTxs = (await getTxQueue()).filter((tx) => {
    const normalized = address.startsWith('0x') ? address.toLowerCase() : toHexAddress(address).toLowerCase();
    return tx.from.toLowerCase() === normalized || tx.to.toLowerCase() === normalized;
  });

  const merged = new Map<string, WalletTxRecord>();
  for (const tx of remoteTxs) merged.set(tx.txHash.toLowerCase(), tx);
  for (const tx of localTxs) merged.set(tx.txHash.toLowerCase(), tx);

  const txs = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  return { txs, total: Math.max(result?.total ?? 0, txs.length) };
}

async function pollPendingTransactions(): Promise<void> {
  const txQueue = await getTxQueue();
  const pending = txQueue.filter((tx) => tx.status === 'pending');
  if (pending.length === 0) {
    chrome.alarms.clear(TX_POLL_ALARM);
    return;
  }

  const network = await getNetwork();
  const provider = buildProvider(network);
  let changed = false;

  const next = await Promise.all(txQueue.map(async (tx) => {
    if (tx.status !== 'pending') return tx;
    try {
      const receipt = await provider.client.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
      changed = true;
      return {
        ...tx,
        blockNumber: receipt.blockNumber ? `0x${receipt.blockNumber.toString(16)}` : null,
        status: receipt.status === 'success' ? 'confirmed' : 'failed',
        error: receipt.status === 'reverted' ? 'Transaction reverted on-chain' : undefined,
        updatedAt: Date.now(),
      } satisfies WalletTxRecord;
    } catch {
      return tx;
    }
  }));

  if (changed) {
    await setTxQueue(next);
  }
  await scheduleTxPolling();
}

async function allocateNextNonce(from: `0x${string}`, onChainNonce: number): Promise<number> {
  const txQueue = await getTxQueue();
  const pendingNonces = txQueue
    .filter((tx) => tx.status === 'pending' && tx.from.toLowerCase() === from.toLowerCase())
    .map((tx) => tx.nonce)
    .filter((nonce): nonce is number => nonce != null)
    .sort((a, b) => b - a);

  if (pendingNonces.length === 0) {
    return onChainNonce;
  }
  return Math.max(onChainNonce, pendingNonces[0] + 1);
}

function buildProvider(network: Network) {
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { decimals: 18, name: 'SHELL', symbol: 'SHELL' },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });
  return createShellProvider({ chain, rpcHttpUrl: network.rpcUrl });
}

function parseKeystorePayload(keystoreJson: string): ShellEncryptedKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keystoreJson);
  } catch {
    throw new Error('Keystore JSON is invalid');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Keystore payload must be a JSON object');
  }

  const requiredFields = [
    'address',
    'key_type',
    'kdf',
    'kdf_params',
    'cipher',
    'cipher_params',
    'ciphertext',
    'public_key',
  ] as const;

  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Keystore is missing required field: ${field}`);
    }
  }

  return parsed as ShellEncryptedKey;
}

function normalizeRemoteTxRecord(value: unknown): WalletTxRecord | null {
  if (!value || typeof value !== 'object') return null;
  const tx = value as Record<string, unknown>;
  const txHash = optionalString(tx.hash);
  const from = optionalString(tx.from);
  const to = optionalString(tx.to);
  const storedValue = optionalString(tx.value);
  if (!txHash || !from || !to || !storedValue) return null;

  return {
    txHash,
    from,
    to,
    value: storedValue,
    data: optionalString(tx.input) ?? optionalString(tx.data) ?? '0x',
    createdAt: optionalNumber(tx.timestamp) ?? Date.now(),
    updatedAt: optionalNumber(tx.timestamp) ?? Date.now(),
    status: normalizeRemoteStatus(optionalString(tx.status)),
    blockNumber: optionalString(tx.blockNumber) ?? null,
    source: 'remote',
  };
}

function normalizeRemoteStatus(status: string | undefined): WalletTxRecord['status'] {
  if (status === 'failed' || status === 'reverted') return 'failed';
  if (status === 'pending') return 'pending';
  return 'confirmed';
}

function normalizeRecipient(address: string): string {
  if (!address) throw new Error('Recipient address is required');
  if (address.startsWith('0x')) return normalizeHexAddress(address);
  if (!address.startsWith('pq1')) throw new Error('Recipient must be a pq1… or 0x… address');
  return address;
}

function normalizeData(data?: string): `0x${string}` {
  if (!data || data.trim() === '') return '0x';
  const trimmed = data.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new Error('Calldata must be an even-length 0x-prefixed hex string');
  }
  return trimmed as `0x${string}`;
}

function validateNetwork(value: unknown): Network {
  if (!value || typeof value !== 'object') {
    throw new Error('Network payload is invalid');
  }
  const network = value as Record<string, unknown>;
  return {
    name: requireString(network.name, 'network.name'),
    chainId: requireNumber(network.chainId, 'network.chainId'),
    rpcUrl: requireString(network.rpcUrl, 'network.rpcUrl'),
  };
}

function requirePassword(value: unknown): string {
  const password = requireString(value, 'password');
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return password;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`${field} must be a valid number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toHexAddress(pqAddress: string): `0x${string}` {
  if (pqAddress.startsWith('0x')) return pqAddress as `0x${string}`;
  return normalizeHexAddress(pqAddress);
}

function formatEther(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6);
}

function parseEtherValue(value: string): bigint {
  if (value.startsWith('0x')) return BigInt(value);
  return parseEther(value as `${number}`);
}

function toSafeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Wallet operation failed';

  if (
    message === 'Password must be at least 8 characters' ||
    message === 'Incorrect password or corrupted keystore' ||
    message === 'Public key mismatch — wrong password or corrupt keystore' ||
    message === 'Keystore JSON is invalid' ||
    message === 'Keystore payload must be a JSON object' ||
    message.startsWith('Keystore is missing required field:') ||
    message === 'No wallet found' ||
    message === 'No wallet to export' ||
    message === 'Wallet is locked' ||
    message === 'Recipient address is required' ||
    message === 'Recipient must be a pq1… or 0x… address' ||
    message === 'Calldata must be an even-length 0x-prefixed hex string' ||
    message === 'Network payload is invalid' ||
    message.endsWith('is required') ||
    message.endsWith('must be a valid number')
  ) {
    return message;
  }

  if (message.startsWith('rpc request failed:') || message.startsWith('[')) {
    return 'RPC request failed. Check network settings and try again.';
  }

  return 'Wallet operation failed.';
}
