/**
 * Persistent store backed by chrome.storage.local.
 * Session state (unlocked key material) uses chrome.storage.session.
 */

export interface Network {
  name: string;
  chainId: number;
  rpcUrl: string;
}

export interface StoredAccount {
  pqAddress: string;
  hexAddress: string;
  keystoreJson: string;
}

export interface WalletState {
  accounts: StoredAccount[];
  network: Network;
  autoLockMinutes: number;
  connectedSites: string[];
}

export interface SessionState {
  unlockedPqAddress: string;
  secretKeyHex: string;
  publicKeyHex: string;
  signatureType: string;
}

export const KNOWN_NETWORKS: Record<string, Network> = {
  devnet: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
  testnet: { name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' },
  mainnet: { name: 'Shell Mainnet', chainId: 100000, rpcUrl: 'https://rpc.mainnet.shell.network' },
};

const DEFAULT_NETWORK = KNOWN_NETWORKS.devnet;

export async function initStore(): Promise<void> {
  const existing = await chrome.storage.local.get(['network', 'accounts']);
  if (!existing.accounts) {
    await chrome.storage.local.set({
      network: DEFAULT_NETWORK,
      accounts: [],
      autoLockMinutes: 15,
      connectedSites: [],
    });
  }
}

export async function getWalletState(): Promise<WalletState> {
  const data = await chrome.storage.local.get([
    'network',
    'accounts',
    'autoLockMinutes',
    'connectedSites',
  ]);
  return {
    network: data.network ?? DEFAULT_NETWORK,
    accounts: data.accounts ?? [],
    autoLockMinutes: data.autoLockMinutes ?? 15,
    connectedSites: data.connectedSites ?? [],
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

export async function getAutoLockMinutes(): Promise<number> {
  const { autoLockMinutes } = await chrome.storage.local.get('autoLockMinutes');
  return autoLockMinutes ?? 15;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  await chrome.storage.local.set({ autoLockMinutes: minutes });
}

// Session storage for unlocked key material (cleared when browser closes)
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

export async function isUnlocked(): Promise<boolean> {
  const session = await getSessionState();
  return session !== null;
}

export async function getConnectedSites(): Promise<string[]> {
  const { connectedSites } = await chrome.storage.local.get('connectedSites');
  return connectedSites ?? [];
}

export async function addConnectedSite(origin: string): Promise<void> {
  const sites = await getConnectedSites();
  if (!sites.includes(origin)) {
    sites.push(origin);
    await chrome.storage.local.set({ connectedSites: sites });
  }
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const sites = await getConnectedSites();
  await chrome.storage.local.set({
    connectedSites: sites.filter((s) => s !== origin),
  });
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await initStore();
}

