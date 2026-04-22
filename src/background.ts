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
  KNOWN_NETWORKS,
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

let currentSigner: ShellSigner | null = null;
const pendingApprovals = new Map<
  string,
  {
    request: ApprovalRequest;
    resolve: (approved: boolean) => void;
  }
>();

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
  const accounts = await getAccounts();
  const primaryAccount = accounts[0] ?? null;
  const permission = await getConnectedPermission(origin);
  const provider = buildProvider(network);

  switch (message.method) {
    case 'eth_requestAccounts': {
      if (!primaryAccount) throw new Error('No wallet found');
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
          account: primaryAccount.hexAddress,
          pqAddress: primaryAccount.pqAddress,
          chainId: network.chainId,
          networkName: network.name,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      const granted = buildConnectedSite(origin, primaryAccount.hexAddress, network.chainId, permission?.grantedAt);
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
      const hexAddress = address.startsWith('0x') ? normalizeHexAddress(address) : toHexAddress(address);
      const balance = await provider.client.getBalance({ address: hexAddress });
      return `0x${balance.toString(16)}`;
    }
    case 'eth_sendTransaction': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('eth_sendTransaction requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const from = optionalString(candidate.from);
      if (from && normalizeHexAddress(from) !== permission.accounts[0]) {
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
      return sendTransaction(request);
    }
    case 'eth_call': {
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('eth_call requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const to = requireString(candidate.to, 'to');
      const data = normalizeData(optionalString(candidate.data) ?? optionalString(candidate.input));
      const value = normalizeOptionalRpcBigInt(optionalString(candidate.value), 'eth_call.value');
      return provider.client.call({
        to: normalizeHexAddress(to),
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
      await addConnectedSite(buildConnectedSite(origin, permission.accounts[0], nextNetwork.chainId, permission.grantedAt));
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
        rpcUrl: rpcUrls[0],
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
      if (primaryAccount) {
        await addConnectedSite(buildConnectedSite(origin, primaryAccount.hexAddress, nextNetwork.chainId, permission?.grantedAt));
      }
      return null;
    }
    case 'shella_getPqAddress':
      return primaryAccount?.pqAddress ?? null;
    case 'shella_sendPqTransaction': {
      ensureConnected(permission, origin);
      if (!currentSigner) throw new Error('Wallet is locked');
      const [tx] = normalizeArrayParams(message.params);
      if (!tx || typeof tx !== 'object') throw new Error('shella_sendPqTransaction requires a transaction object');
      const candidate = tx as Record<string, unknown>;
      const from = optionalString(candidate.from);
      if (from && from !== primaryAccount?.pqAddress) {
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
          account: primaryAccount?.pqAddress ?? null,
          to: request.to,
          value: request.value,
          data: request.data ?? '0x',
          chainId: network.chainId,
        },
      });
      if (!approved) throw new Error('Request rejected by user');
      return sendTransaction(request);
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
  hexAddress: string,
  chainId: number,
  grantedAt: number = Date.now(),
): ConnectedSitePermission {
  const now = Date.now();
  return {
    origin,
    accounts: [normalizeHexAddress(hexAddress)],
    chainId,
    grantedAt,
    lastUsedAt: now,
  };
}

async function getConnectedPermission(origin: string): Promise<ConnectedSitePermission | null> {
  const sites = await getConnectedSites();
  return sites.find((site) => site.origin === origin) ?? null;
}

async function requestUserApproval(
  input: Omit<ApprovalRequest, 'id'>,
): Promise<boolean> {
  const requestId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `approval-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    message === 'Interactive approval required' ||
    message === 'Request rejected by user' ||
    message === 'Recipient address is required' ||
    message === 'Recipient must be a pq1… or 0x… address' ||
    message === 'Calldata must be an even-length 0x-prefixed hex string' ||
    message === 'Network payload is invalid' ||
    message === 'Approval request not found' ||
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
