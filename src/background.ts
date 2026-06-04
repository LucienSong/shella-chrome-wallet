/**
 * Shella Wallet — background service worker.
 *
 * Handles wallet lifecycle: key generation, encryption/decryption, lock/unlock,
 * transaction signing, receipt tracking, and RPC proxying.
 */

import { MlDsa65Adapter, generateMlDsa65KeyPair } from 'shell-sdk/adapters';
import { createShellProvider } from 'shell-sdk/provider';
import { ShellSigner } from 'shell-sdk/signer';
import { buildTransaction, buildTransferTransaction, hashTransaction } from 'shell-sdk/transactions';
import type { ShellEncryptedKey } from 'shell-sdk/types';
import { defineChain, parseEther } from 'viem';
import { createKeystore, decryptKeystore } from './crypto.js';
import {
  KNOWN_NETWORKS,
  addAccount as addStoredAccount,
  addConnectedSite,
  clearAllData,
  clearSessionState,
  getAccounts,
  getAutoLockMinutes,
  getConnectedSites,
  getLastActiveAddress,
  getNetwork,
  getTxQueue,
  getWalletState,
  initStore,
  removeConnectedSite,
  setAutoLockMinutes,
  setLastActiveAddress,
  setNetwork,
  setSessionState,
  setTxQueue,
  upsertTxRecord,
} from './store.js';
import type {
  ConnectedSitePermission,
  DappRequestMessage,
  Network,
  ApprovalRequest,
  SendTransactionParams,
  StoredAccount,
  WalletNodeInfo,
  WalletSnapshot,
  WalletTxRecord,
} from './types.js';

const AUTO_LOCK_ALARM = 'shella-auto-lock';
const TX_POLL_ALARM = 'shella-tx-poll';
// Approval requests expire after this many ms to prevent stale popup resolution.
const APPROVAL_TTL_MS = 10 * 60 * 1000;

let currentSigner: ShellSigner | null = null;
const pendingApprovals = new Map<
  string,
  {
    request: ApprovalRequest;
    resolve: (approved: boolean) => void;
  }
>();

// In-memory nonce tracker: prevents concurrent sendTransaction calls from
// allocating the same nonce before the first is committed to txQueue storage.
// Maps normalised-lowercase address → highest nonce already allocated this session.
const allocatedNonces = new Map<string, number>();

chrome.runtime.onInstalled.addListener(async () => {
  await initStore();
  await pollPendingTransactions();
});

chrome.runtime.onStartup.addListener(async () => {
  disposeCurrentSigner();
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

// WALLET-M2: Privileged operations must only be invoked from extension pages (popup/options),
// not from content scripts. Content scripts always have sender.tab set.
const PRIVILEGED_MESSAGE_TYPES = new Set([
  'CREATE_WALLET', 'IMPORT_KEYSTORE', 'UNLOCK_WALLET', 'LOCK_WALLET', 'RESET_WALLET',
  'EXPORT_KEYSTORE', 'SEND_TX', 'SIGN',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = (msg as { type?: string }).type ?? '';
  // sender may be undefined in test environments; treat undefined as extension page
  const fromExtensionPage = !sender?.tab; // content scripts always have sender.tab

  if (PRIVILEGED_MESSAGE_TYPES.has(type) && !fromExtensionPage) {
    sendResponse({ ok: false, error: 'Unauthorized' });
    return true;
  }

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
  disposeCurrentSigner();
  await clearSessionState();
  chrome.alarms.clear(AUTO_LOCK_ALARM);
}

function disposeCurrentSigner(): void {
  currentSigner?.dispose();
  currentSigner = null;
}

function replaceCurrentSigner(signer: ShellSigner): void {
  disposeCurrentSigner();
  currentSigner = signer;
}

export async function handleMessage(msg: { type: string; [key: string]: unknown }): Promise<unknown> {
  switch (msg.type) {
    case 'CREATE_WALLET':
      return createWallet(requirePassword(msg.password));
    case 'IMPORT_KEYSTORE':
      return importKeystore(requireString(msg.keystoreJson, 'keystoreJson'), requirePassword(msg.password));
    case 'UNLOCK_WALLET':
      return unlockWallet(requirePassword(msg.password), typeof msg.address === 'string' ? msg.address : undefined);
    case 'ADD_ACCOUNT':
      return createAdditionalAccount(requirePassword(msg.password));
    case 'SWITCH_ACCOUNT':
      return unlockWallet(requirePassword(msg.password), requireString(msg.address, 'address'));
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
      const active = await getActiveAccount();
      if (!active) throw new Error('No wallet to export');
      return { keystoreJson: active.keystoreJson };
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
      await addConnectedSite({
        origin: normalizeOrigin(requireString(msg.origin, 'origin')),
        accounts: [],
        chainId: (await getNetwork()).chainId,
        grantedAt: Date.now(),
        lastUsedAt: Date.now(),
      });
      return { ok: true };
    case 'REMOVE_CONNECTED_SITE':
      await removeConnectedSite(normalizeOrigin(requireString(msg.origin, 'origin')));
      return { ok: true };
    case 'GET_NODE_INFO':
      return getNodeInfoFromNode((await getNetwork()).rpcUrl);
    case 'DAPP_REQUEST':
      return handleDappRequest({
        origin: requireString(msg.origin, 'origin'),
        method: requireString(msg.method, 'method'),
        params: Array.isArray(msg.params) ? msg.params : [],
        interactive: Boolean(msg.interactive),
      });
    case 'GET_APPROVAL_REQUEST':
      return getApprovalRequest(requireString(msg.requestId, 'requestId'));
    case 'RESOLVE_APPROVAL':
      return resolveApprovalRequest(requireString(msg.requestId, 'requestId'), Boolean(msg.approved));
    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

async function createWallet(password: string): Promise<{ pqAddress: string }> {
  const { publicKey: pk, secretKey: sk } = generateMlDsa65KeyPair();
  // WALLET-H1: pass an owned copy into the adapter so that zeroing sk below
  // does not corrupt the live signer's key buffer.
  const adapter = MlDsa65Adapter.fromKeyPair(pk, sk.slice());
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();

  const keystore = await createKeystore(sk, pk, password, pqAddress, 'mldsa65');
  const account: StoredAccount = { pqAddress, keystoreJson: JSON.stringify(keystore) };
  await addStoredAccount(account);

  replaceCurrentSigner(signer);
  await setSessionState({
    unlockedPqAddress: pqAddress,
    unlockedAt: Date.now(),
  });
  await setLastActiveAddress(pqAddress);
  await scheduleAutoLock();
  sk.fill(0); // zero ephemeral local copy; adapter holds its own copy

  return { pqAddress };
}

async function importKeystore(
  keystoreJson: string,
  password: string,
): Promise<{ pqAddress: string }> {
  const parsed = parseKeystorePayload(keystoreJson);
  const { secretKey, publicKey } = await decryptKeystore(parsed, password);

  // WALLET-H1: pass an owned copy into the adapter so that zeroing secretKey below
  // does not corrupt the live signer's key buffer.
  const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey.slice());
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();

  const account: StoredAccount = { pqAddress, keystoreJson: JSON.stringify(parsed) };
  await addStoredAccount(account);

  replaceCurrentSigner(signer);
  await setSessionState({ unlockedPqAddress: pqAddress, unlockedAt: Date.now() });
  await setLastActiveAddress(pqAddress);
  await scheduleAutoLock();
  secretKey.fill(0); // zero ephemeral local copy; adapter holds its own copy

  return { pqAddress };
}

async function createAdditionalAccount(password: string): Promise<{ pqAddress: string }> {
  const { publicKey: pk, secretKey: sk } = generateMlDsa65KeyPair();
  const adapter = MlDsa65Adapter.fromKeyPair(pk, sk.slice());
  const pqAddress = new ShellSigner('MlDsa65', adapter).getAddress();

  const keystore = await createKeystore(sk, pk, password, pqAddress, 'mldsa65');
  await addStoredAccount({ pqAddress, keystoreJson: JSON.stringify(keystore) });
  sk.fill(0);

  return { pqAddress };
}

async function getActiveAccount(): Promise<StoredAccount | null> {
  const accounts = await getAccounts();
  if (accounts.length === 0) return null;

  // When unlocked, the signer address is authoritative.
  if (currentSigner) {
    const addr = currentSigner.getAddress();
    const match = accounts.find(a => a.pqAddress === addr);
    if (match) return match;
  }

  // Fall back to last persisted active address (survives lock).
  const lastAddr = await getLastActiveAddress();
  if (lastAddr) {
    const match = accounts.find(a => a.pqAddress === lastAddr);
    if (match) return match;
  }

  return accounts[0];
}

async function unlockWallet(password: string, address?: string): Promise<{ ok: boolean; pqAddress?: string }> {
  const accounts = await getAccounts();
  if (accounts.length === 0) throw new Error('No wallet found');

  const account = address != null
    ? accounts.find(a => a.pqAddress === address)
    : accounts[0];
  if (!account) throw new Error('Account not found');

  const { secretKey, publicKey } = await decryptKeystore(account.keystoreJson, password);

  // WALLET-H1: pass an owned copy into the adapter so that zeroing secretKey below
  // does not corrupt the live signer's key buffer.
  const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey.slice());
  replaceCurrentSigner(new ShellSigner('MlDsa65', adapter));

  await setSessionState({ unlockedPqAddress: account.pqAddress, unlockedAt: Date.now() });
  await setLastActiveAddress(account.pqAddress);
  await scheduleAutoLock();
  secretKey.fill(0); // zero ephemeral local copy; adapter holds its own copy

  return { ok: true, pqAddress: account.pqAddress };
}

async function getWalletSnapshot(): Promise<WalletSnapshot> {
  const wallet = await getWalletState();
  const activeAccount = await getActiveAccount();
  const primaryAccount = wallet.accounts[0] ?? null;
  const locked = currentSigner === null;

  if (!primaryAccount) {
    return {
      locked,
      wallet,
      primaryAccount: null,
      activeAddress: null,
      balance: null,
      nonce: null,
      detectedChainId: null,
      nodeInfo: null,
    };
  }

  try {
    const provider = buildProvider(wallet.network);
    const queryAddress = activeAccount?.pqAddress ?? primaryAccount.pqAddress;
    const [balance, nonce, detectedChainId, nodeInfo] = await Promise.all([
      provider.client.getBalance({ address: asPqAddress(queryAddress, 'getBalance') }),
      provider.client.getTransactionCount({ address: asPqAddress(queryAddress, 'getTransactionCount') }),
      provider.client.getChainId(),
      getNodeInfoFromNode(wallet.network.rpcUrl).catch(() => null),
    ]);
    return {
      locked,
      wallet,
      primaryAccount,
      activeAddress: activeAccount?.pqAddress ?? null,
      balance: {
        raw: balance.toString(),
        formatted: formatEther(balance),
      },
      nonce,
      detectedChainId,
      nodeInfo,
    };
  } catch {
    return {
      locked,
      wallet,
      primaryAccount,
      activeAddress: activeAccount?.pqAddress ?? null,
      balance: null,
      nonce: null,
      detectedChainId: null,
      nodeInfo: null,
    };
  }
}

async function getBalance(address: string): Promise<{ balance: string; formatted: string }> {
  const network = await getNetwork();
  const provider = buildProvider(network);
  const balance = await provider.client.getBalance({ address: asPqAddress(address, 'getBalance') });
  return { balance: balance.toString(), formatted: formatEther(balance) };
}

async function sendTransaction(params: SendTransactionParams): Promise<{ txHash: string }> {
  if (!currentSigner) throw new Error('Wallet is locked');

  const network = await getNetwork();
  if (params.expectedChainId !== undefined && params.expectedChainId !== network.chainId) {
    throw new Error(`Network changed during approval: expected ${params.expectedChainId}, got ${network.chainId}`);
  }
  const provider = buildProvider(network);
  const from = currentSigner.getAddress();
  const to = normalizeRecipient(params.to);
  const valueBigInt = parseEtherValue(params.value);
  const data = normalizeData(params.data);

  const onChainNonce = await provider.client.getTransactionCount({ address: asPqAddress(from, 'getTransactionCount') });
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
    to,
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
    return tx.from.toLowerCase() === address.toLowerCase() || tx.to.toLowerCase() === address.toLowerCase();
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

async function allocateNextNonce(from: string, onChainNonce: number): Promise<number> {
  const key = from.toLowerCase();
  const txQueue = await getTxQueue();
  const pendingNonces = txQueue
    .filter((tx) => tx.status === 'pending' && tx.from.toLowerCase() === key)
    .map((tx) => tx.nonce)
    .filter((nonce): nonce is number => nonce != null)
    .sort((a, b) => b - a);

  // Also consider nonces already handed out this session but not yet in the queue
  // (covers the race window between allocateNextNonce returning and upsertTxRecord writing).
  const inFlight = allocatedNonces.get(key) ?? -1;
  const queueMax = pendingNonces.length > 0 ? pendingNonces[0] : -1;
  const next = Math.max(onChainNonce, queueMax + 1, inFlight + 1);
  allocatedNonces.set(key, next);
  return next;
}

async function getNodeInfoFromNode(rpcUrl: string): Promise<WalletNodeInfo | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shell_getNodeInfo', params: [] }),
    });
    const data = await res.json() as { result?: WalletNodeInfo; error?: unknown };
    if (data.error || !data.result) return null;
    return data.result;
  } catch {
    return null;
  }
}

async function handleDappRequest(message: DappRequestMessage): Promise<unknown> {
  const origin = normalizeOrigin(message.origin);
  const network = await getNetwork();
  const activeAccount = await getActiveAccount();
  const permission = await getConnectedPermission(origin);
  const provider = buildProvider(network);

  switch (message.method) {
    case 'eth_requestAccounts': {
      if (!activeAccount) throw new Error('No wallet found');
      if (!currentSigner) throw new Error('Wallet is locked');
      if (permission?.accounts.length) {
        await addConnectedSite(buildConnectedSite(origin, permission.accounts[0], network.chainId, permission.grantedAt));
        return permission.accounts;
      }
      const approved = await requestUserApproval({
        kind: 'connect',
        origin,
        createdAt: Date.now(),
        payload: {
          pqAddress: activeAccount.pqAddress,
          chainId: network.chainId,
          networkName: network.name,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      const granted = buildConnectedSite(origin, activeAccount.pqAddress, network.chainId, permission?.grantedAt);
      await addConnectedSite(granted);
      return granted.accounts;
    }
    case 'eth_accounts':
      return permission?.accounts ?? [];
    case 'eth_chainId':
      return `0x${network.chainId.toString(16)}`;
    case 'eth_blockNumber': {
      const blockNumber = await provider.client.getBlockNumber();
      return `0x${blockNumber.toString(16)}`;
    }
    case 'eth_getBalance': {
      const [address] = normalizeArrayParams(message.params);
      if (typeof address !== 'string') throw new Error('eth_getBalance requires an address');
      if (!/^0x[0-9a-fA-F]{64}$/.test(address)) throw new Error('eth_getBalance: address must be 0x + 64-char hex');
      const balance = await provider.client.getBalance({ address: asPqAddress(address, 'eth_getBalance') });
      return `0x${balance.toString(16)}`;
    }
    case 'eth_sendTransaction': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('eth_sendTransaction requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const from = optionalString(candidate.from);
      if (from && from !== permission.accounts[0]) {
        throw new Error('Requested from account is not permitted for this site');
      }
      const request = {
        to: requireString(candidate.to, 'to'),
        value: normalizeRpcValue(optionalString(candidate.value)),
        data: optionalString(candidate.data) ?? optionalString(candidate.input),
        gasLimit: optionalRpcNumber(candidate.gas) ?? optionalRpcNumber(candidate.gasLimit),
        maxFeePerGas: optionalRpcNumber(candidate.maxFeePerGas),
        maxPriorityFeePerGas: optionalRpcNumber(candidate.maxPriorityFeePerGas),
      };
      const approved = await requestUserApproval({
        kind: 'send-transaction',
        origin,
        createdAt: Date.now(),
        payload: {
          account: permission.accounts[0],
          to: request.to,
          value: request.value,
          data: request.data ?? '0x',
          chainId: network.chainId,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      return sendTransaction({ ...request, expectedChainId: network.chainId });
    }
    case 'eth_call': {
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('eth_call requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const to = requireString(candidate.to, 'to');
      const data = normalizeData(optionalString(candidate.data) ?? optionalString(candidate.input));
      const value = normalizeOptionalRpcBigInt(optionalString(candidate.value), 'eth_call.value');
      return provider.client.call({
        to: asPqAddress(normalizeRecipient(to), 'eth_call.to'),
        data,
        value,
      });
    }
    case 'wallet_switchEthereumChain': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [chainPayload] = normalizeArrayParams(message.params);
      if (!chainPayload || typeof chainPayload !== 'object') {
        throw new Error('wallet_switchEthereumChain requires a chain payload');
      }
      const chainIdHex = requireString((chainPayload as Record<string, unknown>).chainId, 'chainId');
      const chainId = Number(BigInt(chainIdHex));
      const nextNetwork = findKnownNetwork(chainId);
      if (!nextNetwork) {
        throw new Error('Unknown chain. Use wallet_addEthereumChain first.');
      }
      const approved = await requestUserApproval({
        kind: 'switch-chain',
        origin,
        createdAt: Date.now(),
        payload: {
          chainId: nextNetwork.chainId,
          networkName: nextNetwork.name,
          rpcUrl: nextNetwork.rpcUrl,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      await setNetwork(nextNetwork);
      await addConnectedSite(buildConnectedSite(origin, activeAccount?.pqAddress ?? permission.accounts[0], nextNetwork.chainId, permission.grantedAt));
      return null;
    }
    case 'wallet_addEthereumChain': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [chainPayload] = normalizeArrayParams(message.params);
      if (!chainPayload || typeof chainPayload !== 'object') {
        throw new Error('wallet_addEthereumChain requires a chain payload');
      }
      const candidate = chainPayload as Record<string, unknown>;
      const chainId = Number(BigInt(requireString(candidate.chainId, 'chainId')));
      const rpcUrls = candidate.rpcUrls;
      if (!Array.isArray(rpcUrls) || typeof rpcUrls[0] !== 'string') {
        throw new Error('wallet_addEthereumChain requires rpcUrls[0]');
      }
      const nextNetwork: Network = {
        name: optionalString(candidate.chainName) ?? `Chain ${chainId}`,
        chainId,
        // WALLET-H2: validate scheme and host before storing or using the URL.
        rpcUrl: validateRpcUrl(rpcUrls[0], 'rpcUrls[0]'),
      };
      const approved = await requestUserApproval({
        kind: 'add-chain',
        origin,
        createdAt: Date.now(),
        payload: {
          chainId: nextNetwork.chainId,
          networkName: nextNetwork.name,
          rpcUrl: nextNetwork.rpcUrl,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      await setNetwork(nextNetwork);
      if (activeAccount) {
        await addConnectedSite(buildConnectedSite(origin, activeAccount.pqAddress, nextNetwork.chainId, permission?.grantedAt));
      }
      return null;
    }
    case 'shella_getPqAddress':
      ensureConnected(permission, origin);
      return activeAccount?.pqAddress ?? null;
    case 'shella_sendPqTransaction': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('shella_sendPqTransaction requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const from = optionalString(candidate.from);
      if (from && from !== activeAccount?.pqAddress) {
        throw new Error('Requested pq sender does not match the unlocked wallet');
      }
      const request = {
        to: requireString(candidate.to, 'to'),
        value: normalizeRpcValue(optionalString(candidate.value)),
        data: optionalString(candidate.data),
        gasLimit: optionalRpcNumber(candidate.gasLimit),
        maxFeePerGas: optionalRpcNumber(candidate.maxFeePerGas),
        maxPriorityFeePerGas: optionalRpcNumber(candidate.maxPriorityFeePerGas),
      };
      const approved = await requestUserApproval({
        kind: 'send-transaction',
        origin,
        createdAt: Date.now(),
        payload: {
          account: activeAccount?.pqAddress ?? null,
          to: request.to,
          value: request.value,
          data: request.data ?? '0x',
          chainId: network.chainId,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      return sendTransaction({ ...request, expectedChainId: network.chainId });
    }
    default:
      throw new Error(`Unsupported dApp method: ${message.method}`);
  }
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

function buildConnectedSite(
  origin: string,
  pqAddress: string,
  chainId: number,
  grantedAt: number = Date.now(),
): ConnectedSitePermission {
  const now = Date.now();
  return {
    origin,
    accounts: [pqAddress],
    chainId,
    grantedAt,
    lastUsedAt: now,
  };
}

async function getConnectedPermission(origin: string): Promise<ConnectedSitePermission | null> {
  const sites = await getConnectedSites();
  return sites.find((site) => site.origin === origin) ?? null;
}

// WALLET-L1: use cryptographically secure RNG for all request/approval IDs.
function generateRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function requestUserApproval(
  input: Omit<ApprovalRequest, 'id'>,
): Promise<boolean> {
  const requestId = generateRequestId();

  const request: ApprovalRequest = { id: requestId, ...input };

  return new Promise<boolean>((resolve, reject) => {
    pendingApprovals.set(requestId, { request, resolve });

    chrome.windows.create(
      {
        url: chrome.runtime.getURL(`popup.html?approvalId=${encodeURIComponent(requestId)}`),
        type: 'popup',
        width: 420,
        height: 680,
      },
      () => {
        if (chrome.runtime.lastError) {
          pendingApprovals.delete(requestId);
          reject(new Error(chrome.runtime.lastError.message));
        }
      },
    );
  });
}

function getApprovalRequest(requestId: string): ApprovalRequest {
  const pending = pendingApprovals.get(requestId);
  if (!pending) throw new Error('Approval request not found');
  return pending.request;
}

function resolveApprovalRequest(requestId: string, approved: boolean): { ok: true } {
  const pending = pendingApprovals.get(requestId);
  if (!pending) throw new Error('Approval request not found');
  if (Date.now() - pending.request.createdAt > APPROVAL_TTL_MS) {
    pendingApprovals.delete(requestId);
    throw new Error('Approval request has expired');
  }
  pendingApprovals.delete(requestId);
  pending.resolve(approved);
  return { ok: true };
}

function ensureConnected(
  permission: ConnectedSitePermission | null,
  origin: string,
): asserts permission is ConnectedSitePermission {
  if (!permission) {
    throw new Error(`Site not connected: ${origin}`);
  }
}

function normalizeOrigin(origin: string): string {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https origins are supported');
    }
    return parsed.origin;
  } catch {
    throw new Error('Origin must be a valid http(s) URL');
  }
}

function normalizeArrayParams(params: unknown[] | undefined): unknown[] {
  return Array.isArray(params) ? params : [];
}

function normalizeRpcValue(value: string | undefined): string {
  if (!value) return '0';
  return value;
}

function optionalRpcNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(BigInt(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function findKnownNetwork(chainId: number): Network | null {
  return Object.values(KNOWN_NETWORKS).find((network) => network.chainId === chainId) ?? null;
}

function normalizeOptionalRpcBigInt(value: string | undefined, field: string): bigint | undefined {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${field} must be a valid hex or decimal quantity`);
  }
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

  // AA bundle info
  const txType = optionalString(tx.type);
  const shellType = optionalString(tx.shellType);
  const rewardKind = optionalString(tx.rewardKind);
  const bundle = tx.aa_bundle as Record<string, unknown> | null | undefined;
  const innerCalls = Array.isArray(bundle?.inner_calls) ? bundle!.inner_calls : null;
  const paymaster = bundle?.paymaster ? optionalString(bundle.paymaster as unknown) : null;

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
    txType: txType ?? undefined,
    shellType: shellType ?? null,
    rewardKind: rewardKind ?? null,
    rewardLayer: optionalString(tx.rewardLayer) ?? null,
    rewardSourceHash: optionalString(tx.rewardSourceHash) ?? null,
    originalSize: optionalString(tx.originalSize) ?? null,
    compressedSize: optionalString(tx.compressedSize) ?? null,
    decodedInput: typeof tx.decodedInput === 'object' && tx.decodedInput !== null
      ? tx.decodedInput as WalletTxRecord['decodedInput']
      : null,
    paymaster: paymaster ?? null,
    innerCallCount: innerCalls != null ? innerCalls.length : null,
  };
}

function normalizeRemoteStatus(status: string | undefined): WalletTxRecord['status'] {
  if (status === 'failed' || status === 'reverted') return 'failed';
  if (status === 'pending') return 'pending';
  return 'confirmed';
}

function normalizeRecipient(address: string): string {
  if (!address) throw new Error('Recipient address is required');
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) throw new Error('Recipient must be a 0x + 64-char hex Shell address');
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
    rpcUrl: validateRpcUrl(requireString(network.rpcUrl, 'network.rpcUrl'), 'network.rpcUrl'),
  };
}

// WALLET-H2: Validate that an RPC URL uses an approved scheme and is not a
// private/loopback address (except localhost which is permitted for dev use).
function validateRpcUrl(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  const { protocol, hostname } = parsed;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

  if (protocol !== 'https:' && !(protocol === 'http:' && isLocalhost)) {
    throw new Error(`${field} must use https (or http for localhost only)`);
  }

  // Reject private IP ranges that are not localhost.
  if (!isLocalhost) {
    const privateRangePattern =
      /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/;
    if (privateRangePattern.test(hostname)) {
      throw new Error(`${field} must not point to a private IP address`);
    }
  }

  return url;
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

function formatEther(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6);
}

function parseEtherValue(value: string): bigint {
  if (value.startsWith('0x')) return BigInt(value);
  return parseEther(value as `${number}`);
}

/**
 * Assert that an address is a valid 0x Shell address before the cast to `0x${string}` needed by viem.
 * The Shell provider handles 0x hex addresses natively; the cast only satisfies TypeScript types.
 */
function asPqAddress(address: string, context: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
    throw new Error(`${context}: expected 0x + 64-char hex Shell address, got "${address.slice(0, 12)}…"`);
  }
  return address as unknown as `0x${string}`;
}

function toSafeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Wallet operation failed';

  if (
    message === 'Password must be at least 8 characters' ||
    message === 'Incorrect password or corrupted keystore' ||
    message === 'Public key mismatch — wrong password or corrupt keystore' ||
    message === 'Keystore address does not match public key' ||
    message === 'Keystore JSON is invalid' ||
    message === 'Keystore payload must be a JSON object' ||
    message.startsWith('Keystore is missing required field:') ||
    message === 'No wallet found' ||
    message === 'No wallet to export' ||
    message === 'Wallet is locked' ||
    message === 'Interactive approval required' ||
    message === 'Request rejected by user' ||
    message === 'Recipient address is required' ||
    message === 'Recipient must be a 0x + 64-char hex Shell address' ||
    message === 'Calldata must be an even-length 0x-prefixed hex string' ||
    message === 'Network payload is invalid' ||
    message === 'Approval request not found' ||
    message === 'Approval request has expired' ||
    message === 'Unknown chain. Use wallet_addEthereumChain first.' ||
    message.startsWith('Site not connected:') ||
    message.startsWith('Unsupported dApp method:') ||
    message === 'Origin must be a valid http(s) URL' ||
    message === 'Requested from account is not permitted for this site' ||
    message === 'Requested pq sender does not match the unlocked wallet' ||
    message.endsWith('must be a valid hex or decimal quantity') ||
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
