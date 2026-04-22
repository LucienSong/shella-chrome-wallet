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

export interface ConnectedSitePermission {
  origin: string;
  accounts: `0x${string}`[];
  chainId: number;
  grantedAt: number;
  lastUsedAt: number;
}

export type WalletTxStatus = 'pending' | 'confirmed' | 'failed';

export interface WalletTxRecord {
  txHash: string;
  from: string;
  to: string;
  value: string;
  data?: string;
  nonce?: number;
  createdAt: number;
  updatedAt: number;
  status: WalletTxStatus;
  error?: string;
  blockNumber?: string | null;
  source: 'local' | 'remote';
}

export interface WalletState {
  accounts: StoredAccount[];
  network: Network;
  autoLockMinutes: number;
  connectedSites: ConnectedSitePermission[];
  txQueue: WalletTxRecord[];
}

export interface SessionState {
  unlockedPqAddress: string;
  unlockedAt: number;
}

export interface WalletSnapshot {
  locked: boolean;
  wallet: WalletState;
  primaryAccount: StoredAccount | null;
  balance: {
    raw: string;
    formatted: string;
  } | null;
  nonce: number | null;
  detectedChainId: number | null;
  nodeInfo?: WalletNodeInfo | null;
}

/**
 * Node connection info returned by background's `getNodeInfo` message.
 * Mirrors ShellNodeInfo from shell-sdk.
 */
export interface WalletNodeInfo {
  version: string;
  chain_id: string;
  block_height: number;
  peer_count: number;
  storage_profile?: 'archive' | 'full' | 'light';
}

export interface SendTransactionParams {
  to: string;
  value: string;
  data?: string;
  gasLimit?: number;
  maxFeePerGas?: number;
  maxPriorityFeePerGas?: number;
}

export interface DappRequestMessage {
  origin: string;
  method: string;
  params?: unknown[];
  interactive?: boolean;
}

export interface ApprovalRequest {
  id: string;
  kind: 'connect' | 'add-chain' | 'switch-chain' | 'send-transaction';
  origin: string;
  createdAt: number;
  payload: Record<string, unknown>;
}
