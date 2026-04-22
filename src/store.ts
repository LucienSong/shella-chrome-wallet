/**
 * Persistent store backed by chrome.storage.local.
 * Session state (unlocked key material) uses chrome.storage.session.
 */

import type {
  ConnectedSitePermission,
  Network,
  SessionState,
  StoredAccount,
  WalletState,
  WalletTxRecord,
} from './types.js';

export const KNOWN_NETWORKS: Record<string, Network> = {
  devnet: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
  testnet: { name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' },
  mainnet: { name: 'Shell Mainnet', chainId: 100000, rpcUrl: 'https://rpc.mainnet.shell.network' },
};

const DEFAULT_NETWORK = KNOWN_NETWORKS.devnet;

function normalizeConnectedSites(value: unknown): { sites: ConnectedSitePermission[]; migrated: boolean } {
  if (!Array.isArray(value)) return { sites: [], migrated: false };

  let migrated = false;

  const sites = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const now = Date.now();
      migrated = true;
      return [{
        origin: entry,
        accounts: [],
        chainId: DEFAULT_NETWORK.chainId,
        grantedAt: now,
        lastUsedAt: now,
      }];
    }

    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<ConnectedSitePermission>;
    if (typeof candidate.origin !== 'string') return [];
    const hasMissingFields =
      !Array.isArray(candidate.accounts) ||
      typeof candidate.chainId !== 'number' ||
      typeof candidate.grantedAt !== 'number' ||
      typeof candidate.lastUsedAt !== 'number';
    if (hasMissingFields) migrated = true;

    return [{
      origin: candidate.origin,
      accounts: Array.isArray(candidate.accounts)
        ? candidate.accounts.filter((item): item is `0x${string}` => typeof item === 'string' && item.startsWith('0x'))
        : [],
      chainId: typeof candidate.chainId === 'number' ? candidate.chainId : DEFAULT_NETWORK.chainId,
      grantedAt: typeof candidate.grantedAt === 'number' ? candidate.grantedAt : Date.now(),
      lastUsedAt: typeof candidate.lastUsedAt === 'number' ? candidate.lastUsedAt : Date.now(),
    }];
  });

  return { sites, migrated };
}

export async function initStore(): Promise<void> {
  const existing = await chrome.storage.local.get([
    'network',
    'accounts',
    'autoLockMinutes',
    'connectedSites',
    'txQueue',
  ]);
  if (!existing.accounts) {
    const { sites: connectedSites } = normalizeConnectedSites(existing.connectedSites);
    await chrome.storage.local.set({
      network: DEFAULT_NETWORK,
      accounts: [],
      autoLockMinutes: 15,
      connectedSites,
      txQueue: [],
    });
    return;
  }

  const { sites: connectedSites, migrated } = normalizeConnectedSites(existing.connectedSites);

  if (
    !existing.network ||
    existing.autoLockMinutes == null ||
    !existing.connectedSites ||
    !existing.txQueue ||
    connectedSites.length !== (Array.isArray(existing.connectedSites) ? existing.connectedSites.length : 0) ||
    migrated
  ) {
    await chrome.storage.local.set({
      network: existing.network ?? DEFAULT_NETWORK,
      autoLockMinutes: existing.autoLockMinutes ?? 15,
      connectedSites,
      txQueue: existing.txQueue ?? [],
    });
  }
}

export async function getWalletState(): Promise<WalletState> {
  const data = await chrome.storage.local.get([
    'network',
    'accounts',
    'autoLockMinutes',
    'connectedSites',
    'txQueue',
  ]);
  return {
    network: data.network ?? DEFAULT_NETWORK,
    accounts: data.accounts ?? [],
    autoLockMinutes: data.autoLockMinutes ?? 15,
    connectedSites: normalizeConnectedSites(data.connectedSites).sites,
    txQueue: data.txQueue ?? [],
  };
}

export async function getAccounts(): Promise<StoredAccount[]> {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts ?? [];
}

export async function addAccount(account: StoredAccount): Promise<void> {
  const accounts = await getAccounts();
  const exists = accounts.some((a) => a.pqAddress === account.pqAddress);
  if (!exists) {
    accounts.push(account);
    await chrome.storage.local.set({ accounts });
  }
}

export async function getNetwork(): Promise<Network> {
  const { network } = await chrome.storage.local.get('network');
  return network ?? DEFAULT_NETWORK;
}

export async function setNetwork(n: Network): Promise<void> {
  await chrome.storage.local.set({ network: n });
}

export async function getTxQueue(): Promise<WalletTxRecord[]> {
  const { txQueue } = await chrome.storage.local.get('txQueue');
  return txQueue ?? [];
}

export async function setTxQueue(txQueue: WalletTxRecord[]): Promise<void> {
  await chrome.storage.local.set({ txQueue });
}

export async function upsertTxRecord(record: WalletTxRecord): Promise<void> {
  const txQueue = await getTxQueue();
  const next = [...txQueue];
  const index = next.findIndex((item) => item.txHash.toLowerCase() === record.txHash.toLowerCase());
  if (index === -1) {
    next.unshift(record);
  } else {
    next[index] = record;
  }
  await setTxQueue(next.slice(0, 50));
}

export async function getAutoLockMinutes(): Promise<number> {
  const { autoLockMinutes } = await chrome.storage.local.get('autoLockMinutes');
  return autoLockMinutes ?? 15;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  await chrome.storage.local.set({ autoLockMinutes: minutes });
}

// Session storage tracks unlock state only. Secret key material stays in memory.
export async function setSessionState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ walletSession: state });
}

export async function getSessionState(): Promise<SessionState | null> {
  const { walletSession } = await chrome.storage.session.get('walletSession');
  return walletSession ?? null;
}

export async function clearSessionState(): Promise<void> {
  await chrome.storage.session.remove('walletSession');
}

export async function getConnectedSites(): Promise<ConnectedSitePermission[]> {
  const { connectedSites } = await chrome.storage.local.get('connectedSites');
  return normalizeConnectedSites(connectedSites).sites;
}

export async function addConnectedSite(site: ConnectedSitePermission): Promise<void> {
  const sites = await getConnectedSites();
  const next = sites.filter((entry) => entry.origin !== site.origin);
  next.push(site);
  await chrome.storage.local.set({ connectedSites: next });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const sites = await getConnectedSites();
  await chrome.storage.local.set({
    connectedSites: sites.filter((site) => site.origin !== origin),
  });
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await initStore();
}
