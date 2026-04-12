/**
 * Shella Wallet — background service worker.
 *
 * Handles wallet lifecycle: key generation, encryption/decryption,
 * lock/unlock, transaction signing, and RPC proxying.
 *
 * In-memory signer is cleared when the service worker restarts,
 * requiring the user to re-enter their password (wallet locks).
 */

import { MlDsa65Adapter, generateMlDsa65KeyPair } from 'shell-sdk/adapters';
import { ShellSigner } from 'shell-sdk/signer';
import { createShellProvider } from 'shell-sdk/provider';
import { buildTransferTransaction, buildTransaction, hashTransaction } from 'shell-sdk/transactions';
import { normalizeHexAddress } from 'shell-sdk/address';
import { defineChain, parseEther } from 'viem';
import { createKeystore, decryptKeystore } from './crypto.js';
import {
  initStore,
  getAccounts,
  addAccount,
  getNetwork,
  setNetwork,
  setSessionState,
  getSessionState,
  clearSessionState,
  isUnlocked,
  getAutoLockMinutes,
  setAutoLockMinutes,
  addConnectedSite,
  removeConnectedSite,
  getConnectedSites,
  clearAllData,
  type Network,
  type StoredAccount,
} from './store.js';

// In-memory signer (cleared on service worker restart)
let currentSigner: ShellSigner | null = null;

chrome.runtime.onInstalled.addListener(async () => {
  await initStore();
  console.warn('[Shella] wallet installed');
});

// Restore signer from session storage on service worker startup
chrome.runtime.onStartup.addListener(async () => {
  await restoreSignerFromSession();
});

// Also try to restore on first message if signer is null
async function restoreSignerFromSession(): Promise<void> {
  if (currentSigner) return;
  try {
    const session = await getSessionState();
    if (!session) return;
    const sk = hexToBytes(session.secretKeyHex);
    const pk = hexToBytes(session.publicKeyHex);
    const adapter = MlDsa65Adapter.fromKeyPair(pk, sk);
    currentSigner = new ShellSigner('MlDsa65', adapter);
    scheduleAutoLock();
  } catch {
    await clearSessionState();
  }
}

// Auto-lock via chrome.alarms
const AUTO_LOCK_ALARM = 'shella-auto-lock';

async function scheduleAutoLock(): Promise<void> {
  const minutes = await getAutoLockMinutes();
  if (minutes > 0) {
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    await lockWallet();
  }
});

async function lockWallet(): Promise<void> {
  currentSigner = null;
  await clearSessionState();
  chrome.alarms.clear(AUTO_LOCK_ALARM);
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error: message });
    });
  return true; // keep channel open for async response
});

async function handleMessage(msg: { type: string; [key: string]: unknown }): Promise<unknown> {
  // Restore signer from session if service worker restarted
  await restoreSignerFromSession();

  switch (msg.type) {
    case 'CREATE_WALLET':
      return createWallet(msg.password as string);

    case 'IMPORT_KEYSTORE':
      return importKeystore(msg.keystoreJson as string, msg.password as string);

    case 'UNLOCK_WALLET':
      return unlockWallet(msg.password as string);

    case 'LOCK_WALLET':
      await lockWallet();
      return { ok: true };

    case 'CHECK_LOCKED':
      return { locked: !(await isUnlocked()) };

    case 'GET_ACCOUNTS':
      return { accounts: await getAccounts() };

    case 'GET_BALANCE':
      return getBalance(msg.address as string);

    case 'SEND_TX':
      return sendTransaction({
        to: msg.to as string,
        value: msg.value as string,
        data: msg.data as string | undefined,
      });

    case 'GET_TX_HISTORY':
      return getTxHistory(msg.address as string, (msg.page as number) ?? 0);

    case 'GET_NETWORK':
      return { network: await getNetwork() };

    case 'SET_NETWORK':
      await setNetwork(msg.network as Network);
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
      await setAutoLockMinutes(msg.minutes as number);
      return { ok: true };

    case 'GET_CONNECTED_SITES':
      return { sites: await getConnectedSites() };

    case 'REMOVE_CONNECTED_SITE':
      await removeConnectedSite(msg.origin as string);
      return { ok: true };

    default:
      throw new Error('Unknown message type: ' + msg.type);
  }
}

async function createWallet(password: string): Promise<{ pqAddress: string; hexAddress: string }> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const { publicKey: pk, secretKey: sk } = generateMlDsa65KeyPair();
  const adapter = MlDsa65Adapter.fromKeyPair(pk, sk);
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();
  const hexAddress = signer.getHexAddress();

  const ks = await createKeystore(sk, pk, password, pqAddress, 'mldsa65');
  const keystoreJson = JSON.stringify(ks);

  const account: StoredAccount = { pqAddress, hexAddress, keystoreJson };
  await addAccount(account);

  // Unlock after creation
  currentSigner = signer;
  await setSessionState({
    unlockedPqAddress: pqAddress,
    secretKeyHex: bytesToHex(sk),
    publicKeyHex: bytesToHex(pk),
    signatureType: 'MlDsa65',
  });
  await scheduleAutoLock();

  return { pqAddress, hexAddress };
}

async function importKeystore(
  keystoreJson: string,
  password: string,
): Promise<{ pqAddress: string; hexAddress: string }> {
  const ks = JSON.parse(keystoreJson);
  const { secretKey, publicKey } = await decryptKeystore(ks, password);

  const adapter = MlDsa65Adapter.fromKeyPair(publicKey, secretKey);
  const signer = new ShellSigner('MlDsa65', adapter);
  const pqAddress = signer.getAddress();
  const hexAddress = signer.getHexAddress();

  const account: StoredAccount = { pqAddress, hexAddress, keystoreJson };
  await addAccount(account);

  currentSigner = signer;
  await setSessionState({
    unlockedPqAddress: pqAddress,
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
    signatureType: 'MlDsa65',
  });
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

  await setSessionState({
    unlockedPqAddress: account.pqAddress,
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
    signatureType: 'MlDsa65',
  });
  await scheduleAutoLock();
  secretKey.fill(0);

  return { ok: true, pqAddress: account.pqAddress };
}

async function getBalance(address: string): Promise<{ balance: string; formatted: string }> {
  const network = await getNetwork();
  const provider = buildProvider(network);
  const hexAddr = address.startsWith('0x') ? (address as `0x${string}`) : toHexAddress(address);
  const balance = await provider.client.getBalance({ address: hexAddr });
  const formatted = formatEther(balance);
  return { balance: balance.toString(), formatted };
}

async function sendTransaction(params: {
  to: string;
  value: string;
  data?: string;
}): Promise<{ txHash: string }> {
  if (!currentSigner) throw new Error('Wallet is locked');

  const network = await getNetwork();
  const provider = buildProvider(network);
  const hexAddr = currentSigner.getHexAddress();

  const nonce = await provider.client.getTransactionCount({ address: hexAddr });
  const valueBigInt = parseEtherValue(params.value);

  const tx = params.data && params.data !== '0x'
    ? buildTransaction({
        chainId: network.chainId,
        nonce,
        to: params.to,
        value: valueBigInt,
        data: params.data as `0x${string}`,
      })
    : buildTransferTransaction({
        chainId: network.chainId,
        nonce,
        to: params.to,
        value: valueBigInt,
      });

  const txHash = hashTransaction(tx);

  // Include public key for first tx (nonce === 0)
  const signed = await currentSigner.buildSignedTransaction({
    tx,
    txHash,
    includePublicKey: nonce === 0,
  });

  const hash = await provider.sendTransaction(signed);
  return { txHash: hash };
}

async function getTxHistory(
  address: string,
  page: number,
): Promise<{ txs: unknown[]; total: number }> {
  const network = await getNetwork();
  const provider = buildProvider(network);
  const result = (await provider.getTransactionsByAddress(address, {
    page,
    limit: 20,
  })) as { transactions: unknown[]; total: number } | null;
  if (!result) return { txs: [], total: 0 };
  return { txs: result.transactions ?? [], total: result.total ?? 0 };
}

// Helpers

function buildProvider(network: Network) {
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { decimals: 18, name: 'SHELL', symbol: 'SHELL' },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });
  return createShellProvider({ chain, rpcHttpUrl: network.rpcUrl });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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
  // Accept decimal SHELL amount like "1.5" or raw wei hex like "0x1..."
  if (value.startsWith('0x')) return BigInt(value);
  // Parse decimal
  return parseEther(value as `${number}`);
}

