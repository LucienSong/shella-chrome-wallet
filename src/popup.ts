/**
 * Shella Wallet — popup entry point.
 * Multi-view SPA rendered into #app.
 */

import QRCode from 'qrcode';
import type {
  AaBatchInnerCall,
  ApprovalRequest,
  ConnectedSitePermission,
  Network,
  WalletNodeInfo,
  WalletSnapshot,
  WalletTxRecord,
} from './types.js';
import { KNOWN_NETWORKS } from './store.js';

type View =
  | 'loading'
  | 'welcome'
  | 'create-password'
  | 'create-generating'
  | 'create-success'
  | 'hd-show-phrase'
  | 'hd-confirm-phrase'
  | 'hd-create-password'
  | 'hd-creating'
  | 'hd-restore-phrase'
  | 'hd-restore-password'
  | 'hd-restoring'
  | 'reveal-phrase'
  | 'reveal-phrase-confirm'
  | 'import-file'
  | 'import-password'
  | 'locked'
  | 'unlocking'
  | 'sending'
  | 'wallet'
  | 'send'
  | 'receive'
  | 'history'
  | 'settings'
  | 'accounts'
  | 'add-account'
  | 'add-account-generating'
  | 'switch-account'
  | 'advanced-pq'
  | 'approval-request';

interface AppState {
  view: View;
  pqAddress: string;
  balance: string;
  balanceFormatted: string;
  network: Network;
  detectedChainId: number | null;
  nonce: number | null;
  autoLockMinutes: number;
  connectedSites: ConnectedSitePermission[];
  txHistory: WalletTxRecord[];
  txQueue: WalletTxRecord[];
  error: string;
  toast: string;
  nodeInfo: WalletNodeInfo | null;
  // Multi-account state
  accounts: Array<{ pqAddress: string }>;
  selectedTxHash: string;
  switchTargetAddress: string;
  // Temp fields for flows
  pendingKeystoreJson: string;
  pendingMnemonic: string;
  revealedMnemonic: string;
  sendTo: string;
  sendValue: string;
  sendData: string;
  sendGasLimit: string;
  sendMaxFeePerGas: string;
  sendMaxPriorityFeePerGas: string;
  sessionPassword: string;
  sessionIndex: string;
  sessionRootAccountIndex: string;
  sessionExpiryBlock: string;
  sessionValueCap: string;
  sessionTarget: string;
  sessionTxSigningHash: string;
  sessionAuthJson: string;
  rotatePassword: string;
  pendingRotationTxHash: string;
  approvalRequest: ApprovalRequest | null;
}

const state: AppState = {
  view: 'loading',
  pqAddress: '',
  balance: '0',
  balanceFormatted: '0.000000',
  network: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
  detectedChainId: null,
  nonce: null,
  autoLockMinutes: 15,
  connectedSites: [],
  txHistory: [],
  txQueue: [],
  error: '',
  toast: '',
  nodeInfo: null,
  pendingKeystoreJson: '',
  pendingMnemonic: '',
  revealedMnemonic: '',
  sendTo: '',
  sendValue: '',
  sendData: '0x',
  sendGasLimit: '',
  sendMaxFeePerGas: '',
  sendMaxPriorityFeePerGas: '',
  sessionPassword: '',
  sessionIndex: '0',
  sessionRootAccountIndex: '0',
  sessionExpiryBlock: '',
  sessionValueCap: '0',
  sessionTarget: '',
  sessionTxSigningHash: '',
  sessionAuthJson: '',
  rotatePassword: '',
  pendingRotationTxHash: '',
  approvalRequest: null,
  accounts: [],
  selectedTxHash: '',
  switchTargetAddress: '',
};

function send<T = unknown>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, (response: T & { error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

function app(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('#app element not found — popup DOM failed to load');
  return el;
}

function showToast(msg: string, isError = false): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' toast-error' : ' toast-ok');
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 3000);
}

export function truncate(addr: string, start = 10, end = 8): string {
  if (!addr || addr.length <= start + end + 3) return addr;
  return addr.slice(0, start) + '…' + addr.slice(-end);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

function renderError(): string {
  return state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : '';
}

function isRpcUnavailable(): boolean {
  return state.detectedChainId == null;
}

function isChainMismatch(): boolean {
  return state.detectedChainId != null && state.detectedChainId !== state.network.chainId;
}

function getNetworkWarning(): string {
  if (isRpcUnavailable()) {
    return `RPC unavailable for ${state.network.name}. Check the RPC URL or node status.`;
  }
  if (isChainMismatch()) {
    return `Chain mismatch: wallet expects ${state.network.chainId}, RPC returned ${state.detectedChainId}.`;
  }
  return '';
}

function getLatestFailedTx(): WalletTxRecord | null {
  const failed = state.txQueue.filter((tx) => tx.status === 'failed');
  if (failed.length === 0) return null;
  return [...failed].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

function render(): void {
  const views: Record<View, () => string> = {
    loading: renderLoading,
    welcome: renderWelcome,
    'create-password': renderCreatePassword,
    'create-generating': renderGenerating,
    'create-success': renderCreateSuccess,
    'hd-show-phrase': renderHdShowPhrase,
    'hd-confirm-phrase': renderHdConfirmPhrase,
    'hd-create-password': renderHdCreatePassword,
    'hd-creating': renderHdCreating,
    'hd-restore-phrase': renderHdRestorePhrase,
    'hd-restore-password': renderHdRestorePassword,
    'hd-restoring': renderHdRestoring,
    'reveal-phrase': renderRevealPhraseConfirm,
    'reveal-phrase-confirm': renderRevealPhrase,
    'import-file': renderImportFile,
    'import-password': renderImportPassword,
    locked: renderLocked,
    unlocking: renderUnlocking,
    sending: renderSending,
    wallet: renderWallet,
    send: renderSend,
    receive: renderReceive,
    history: renderHistory,
    settings: renderSettings,
    accounts: renderAccounts,
    'add-account': renderAddAccount,
    'add-account-generating': renderAddAccountGenerating,
    'switch-account': renderSwitchAccount,
    'advanced-pq': renderAdvancedPq,
    'approval-request': renderApprovalRequest,
  };
  
  const appElement = app();
  appElement.textContent = '';
  
  // Create toast element safely
  const toastDiv = document.createElement('div');
  toastDiv.id = 'toast';
  toastDiv.className = 'toast';
  toastDiv.style.display = 'none';
  appElement.appendChild(toastDiv);
  
  // Create container for view content
  const viewContainer = document.createElement('div');
  viewContainer.innerHTML = views[state.view]?.() ?? renderLoading();
  appElement.appendChild(viewContainer);
  
  attachHandlers();
}

function renderLoading(): string {
  return `<div class="center"><div class="spinner"></div><p>Loading…</p></div>`;
}

function renderWelcome(): string {
  return `
    <div class="welcome">
      <div class="logo">🔐</div>
      <h1>Shella Wallet</h1>
      <p class="subtitle">Post-quantum wallet for Shell Chain</p>
      <button id="btn-create-hd" class="btn-primary">Create New Wallet</button>
      <button id="btn-restore-hd" class="btn-secondary">Import Recovery Phrase</button>
      <button id="btn-import" class="btn-secondary" style="margin-top:4px">Import Keystore</button>
    </div>
  `;
}

function renderCreatePassword(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Set Password</h2>
      <p class="hint">Protects your wallet on this device. Minimum 8 characters.</p>
      <label>Password
        <input type="password" id="pwd1" placeholder="Enter password" autocomplete="new-password" />
      </label>
      <label>Confirm Password
        <input type="password" id="pwd2" placeholder="Confirm password" autocomplete="new-password" />
      </label>
      ${renderError()}
      <button id="btn-confirm-pwd" class="btn-primary">Create Wallet</button>
    </div>
  `;
}

function renderGenerating(): string {
  return `
    <div class="center">
      <div class="spinner"></div>
      <h2>Generating Key Pair</h2>
      <p class="hint">Using ML-DSA-65 post-quantum algorithm…</p>
    </div>
  `;
}

function renderUnlocking(): string {
  return `
    <div class="center">
      <div class="spinner"></div>
      <h2>Unlocking…</h2>
      <p class="hint">Decrypting your keystore, please wait.</p>
    </div>
  `;
}

function renderSending(): string {
  return `
    <div class="center">
      <div class="spinner"></div>
      <h2>Sending Transaction…</h2>
      <p class="hint">Signing and broadcasting to ${escapeHtml(state.network.name)}…</p>
    </div>
  `;
}

function renderCreateSuccess(): string {
  return `
    <div class="view-form success-view">
      <div class="success-icon">✅</div>
      <h2>Wallet Created!</h2>
      <p class="hint">Your post-quantum wallet is ready.</p>
      <div class="address-box">
        <span class="label">Address</span>
        <span class="address monospace" id="addr-display">${escapeHtml(truncate(state.pqAddress))}</span>
        <button class="btn-copy" id="btn-copy-addr" title="Copy address">⧉</button>
      </div>
      <div class="info-box">
        <strong>⚠️ Backup Reminder</strong>
        <p>Export your keystore file and store it safely. It's the only way to recover your wallet.</p>
      </div>
      <button id="btn-export-ks" class="btn-secondary">Export Keystore</button>
      <button id="btn-goto-wallet" class="btn-primary">Open Wallet</button>
    </div>
  `;
}

function renderHdShowPhrase(): string {
  const words = state.pendingMnemonic.split(' ');
  const grid = words.map((word, i) => `
    <div class="phrase-word">
      <span class="word-num">${i + 1}</span>
      <span class="word-val">${escapeHtml(word)}</span>
    </div>
  `).join('');
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Recovery Phrase</h2>
      <p class="hint">⚠️ Write down these 24 words in order. Anyone with these words can access your wallet.</p>
      <div class="phrase-grid">${grid}</div>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-hd-phrase-next" class="btn-primary" style="margin-top:16px">I've Written It Down</button>
    </div>
  `;
}

function renderHdConfirmPhrase(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Confirm Backup</h2>
      <p class="hint">Confirm you have securely backed up your recovery phrase. You will not be able to view it again.</p>
      <label class="checkbox-label">
        <input type="checkbox" id="hd-confirm-check" />
        I have securely backed up my 24-word recovery phrase.
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-hd-confirm-next" class="btn-primary" style="margin-top:16px">Continue</button>
    </div>
  `;
}

function renderHdCreatePassword(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Set Password</h2>
      <p class="hint">Protects your wallet on this device. Minimum 8 characters.</p>
      <label>Password
        <input type="password" id="hd-pwd1" placeholder="Enter password" autocomplete="new-password" />
      </label>
      <label>Confirm Password
        <input type="password" id="hd-pwd2" placeholder="Confirm password" autocomplete="new-password" />
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-hd-create-confirm" class="btn-primary">Create Wallet</button>
    </div>
  `;
}

function renderHdCreating(): string {
  return `
    <div class="center">
      <div class="spinner"></div>
      <h2>Creating HD Wallet</h2>
      <p class="hint">Deriving ML-DSA-65 keys from recovery phrase…</p>
    </div>
  `;
}

function renderHdRestorePhrase(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Import Recovery Phrase</h2>
      <p class="hint">Enter your 12 or 24-word BIP-39 recovery phrase, separated by spaces.</p>
      <label>Recovery Phrase
        <textarea id="hd-restore-phrase-input" rows="4" placeholder="word1 word2 word3 …" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-hd-restore-phrase-next" class="btn-primary">Continue</button>
    </div>
  `;
}

function renderHdRestorePassword(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Set Password</h2>
      <p class="hint">Protects your restored wallet on this device. Minimum 8 characters.</p>
      <label>Password
        <input type="password" id="hd-restore-pwd1" placeholder="Enter password" autocomplete="new-password" />
      </label>
      <label>Confirm Password
        <input type="password" id="hd-restore-pwd2" placeholder="Confirm password" autocomplete="new-password" />
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-hd-restore-confirm" class="btn-primary">Restore Wallet</button>
    </div>
  `;
}

function renderHdRestoring(): string {
  return `
    <div class="center">
      <div class="spinner"></div>
      <h2>Restoring Wallet</h2>
      <p class="hint">Deriving keys from recovery phrase…</p>
    </div>
  `;
}

function renderRevealPhraseConfirm(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Reveal Recovery Phrase</h2>
      <p class="hint">⚠️ Make sure nobody is watching your screen. Enter your password to reveal the recovery phrase.</p>
      <label>Password
        <input type="password" id="reveal-phrase-pwd" placeholder="Enter password" autocomplete="current-password" autofocus />
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-reveal-phrase-confirm" class="btn-primary">Reveal Phrase</button>
    </div>
  `;
}

function renderRevealPhrase(): string {
  const words = state.revealedMnemonic.split(' ');
  const grid = words.map((word, i) => `
    <div class="phrase-word">
      <span class="word-num">${i + 1}</span>
      <span class="word-val">${escapeHtml(word)}</span>
    </div>
  `).join('');
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Recovery Phrase</h2>
      <p class="hint">⚠️ Keep this phrase secret. Anyone with these words controls your wallet.</p>
      <div class="phrase-grid">${grid}</div>
      <button id="btn-back-from-phrase" class="btn-secondary" style="margin-top:16px">Done</button>
    </div>
  `;
}

function renderImportFile(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Import Keystore</h2>
      <p class="hint">Select a Shell CLI keystore JSON file.</p>
      <div class="file-drop" id="file-drop">
        <input type="file" id="ks-file" accept=".json,application/json" />
        <label for="ks-file">
          📄 Click to choose keystore file
        </label>
      </div>
      ${renderError()}
    </div>
  `;
}

function renderImportPassword(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Enter Keystore Password</h2>
      <p class="hint">Enter the password used to encrypt this keystore.</p>
      <label>Password
        <input type="password" id="import-pwd" placeholder="Keystore password" autocomplete="current-password" />
      </label>
      ${renderError()}
      <button id="btn-confirm-import" class="btn-primary">Import Wallet</button>
    </div>
  `;
}

function renderLocked(): string {
    const accountSelectorHtml = state.accounts.length > 1
    ? `<label>Account
        <select id="unlock-account-select">
          ${state.accounts.map(a =>
            `<option value="${escapeHtml(a.pqAddress)}" ${a.pqAddress === state.pqAddress ? 'selected' : ''}>
               ${truncate(a.pqAddress)}
             </option>`
          ).join('')}
        </select>
      </label>`
    : '';

  return `
    <div class="view-form">
      <div class="logo">🔒</div>
      <h2>Wallet Locked</h2>
      ${accountSelectorHtml}
      <p class="hint">${escapeHtml(truncate(state.pqAddress) || 'Enter your password to unlock.')}</p>
      <label>Password
        <input type="password" id="unlock-pwd" placeholder="Enter password" autocomplete="current-password" autofocus />
      </label>
      ${renderError()}
      <button id="btn-unlock" class="btn-primary">Unlock</button>
    </div>
  `;
}

function renderWallet(): string {
  const pendingTxs = state.txQueue.filter((tx) => tx.status === 'pending').slice(0, 3);
  const networkWarning = getNetworkWarning();
  const failedTx = getLatestFailedTx();

  // Storage profile badge (v0.18.0)
  const storageProfile = state.nodeInfo?.storage_profile;
  const storageProfileHtml = storageProfile
    ? `<span class="storage-badge storage-badge-${storageProfile}" title="Node storage mode">
        ${storageProfile === 'archive' ? '🗄' : storageProfile === 'full' ? '💾' : '🔍'} ${escapeHtml(storageProfile)}
       </span>`
    : '';

  // Node info panel — shown when shell_getNodeInfo succeeds.
  const nodeInfoHtml = state.nodeInfo
    ? `<div class="node-info-card">
        <span class="node-info-item" title="Node version">📦 ${state.nodeInfo.version}</span>
        <span class="node-info-item" title="Block height">🧱 #${state.nodeInfo.block_height.toLocaleString()}</span>
        <span class="node-info-item" title="Peer count">🔗 ${state.nodeInfo.peer_count} peer${state.nodeInfo.peer_count === 1 ? '' : 's'}</span>
      </div>`
    : '';

  const pendingHtml = pendingTxs.length > 0
    ? `
      <div class="pending-card">
        <div class="pending-title">Pending Transactions</div>
        ${pendingTxs.map((tx) => `
          <div class="pending-item">
            <span class="monospace">${escapeHtml(truncate(tx.txHash, 8, 6))}</span>
            <span>${escapeHtml(formatTxHistoryLabel(tx))}</span>
          </div>
        `).join('')}
      </div>
    `
    : '';
  const failedHtml = failedTx
    ? `
      <div class="status-card status-card-error">
        <div class="status-card-title">Latest failed transaction</div>
        <div class="status-card-row">
          <span class="monospace">${escapeHtml(truncate(failedTx.txHash, 8, 6))}</span>
          <span>${escapeHtml(formatDisplayValue(failedTx.value))} SHELL</span>
        </div>
        <div class="status-card-detail">${escapeHtml(failedTx.error ?? 'Transaction failed on-chain.')}</div>
      </div>
    `
    : '';
  return `
    <div class="wallet-view">
      <div class="wallet-header">
        <select id="quick-net-select" class="quick-net-select" title="Switch network">
          <option value="devnet" ${state.network.name === KNOWN_NETWORKS.devnet.name ? 'selected' : ''}>⬡ Devnet</option>
          <option value="localdev" ${state.network.name === KNOWN_NETWORKS.localdev.name ? 'selected' : ''}>⬡ Testnet (local)</option>
          <option value="testnet" ${state.network.name === KNOWN_NETWORKS.testnet.name ? 'selected' : ''}>⬡ Testnet</option>
          <option value="mainnet" ${state.network.name === KNOWN_NETWORKS.mainnet.name ? 'selected' : ''}>⬡ Mainnet</option>
        </select>
        ${storageProfileHtml}
        <button class="btn-icon" id="btn-accounts" title="Accounts (${state.accounts.length})">👤</button>
        <button class="btn-icon" id="btn-settings" title="Settings">⚙</button>
        <button class="btn-icon" id="btn-lock" title="Lock wallet">🔒</button>
      </div>
      <div class="address-box">
        <span class="monospace address-short">${escapeHtml(truncate(state.pqAddress))}</span>
        <button class="btn-copy" id="btn-copy-addr" title="Copy address">⧉</button>
      </div>
      <div class="balance-section">
        <span class="balance-amount">${escapeHtml(state.balanceFormatted)}</span>
        <span class="balance-unit">SHELL</span>
        <button class="btn-refresh" id="btn-refresh" title="Refresh balance">↻</button>
      </div>
      <div class="wallet-meta">
        <span>Configured chain: ${escapeHtml(state.network.chainId)}</span>
        <span>${state.detectedChainId == null ? 'RPC unavailable' : `RPC chain: ${escapeHtml(state.detectedChainId)}`}</span>
        <span>${state.nonce == null ? 'Nonce unavailable' : `Nonce: ${escapeHtml(state.nonce)}`}</span>
      </div>
      ${nodeInfoHtml}
      ${networkWarning ? `<div class="status-card status-card-warning">${escapeHtml(networkWarning)}</div>` : ''}
      <div class="action-row">
        <button class="btn-action" id="btn-send">
          <span>↑</span>Send
        </button>
        <button class="btn-action" id="btn-receive">
          <span>↓</span>Receive
        </button>
        <button class="btn-action" id="btn-history">
          <span>☰</span>History
        </button>
      </div>
      ${failedHtml}
      ${pendingHtml}
    </div>
  `;
}

function renderSend(): string {
  const networkWarning = getNetworkWarning();
  const sendDisabled = networkWarning !== '';
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Send SHELL</h2>
      ${networkWarning ? `<div class="status-card status-card-warning">${escapeHtml(networkWarning)}</div>` : ''}
      <label>To Address (0x… hex)
        <input type="text" id="send-to" placeholder="0x…" value="${escapeAttr(state.sendTo)}" />
      </label>
      <label>Amount (SHELL)
        <input type="number" id="send-value" placeholder="0.0" step="any" min="0" value="${escapeAttr(state.sendValue)}" />
      </label>
      <label>Calldata (optional 0x...)
        <input type="text" id="send-data" placeholder="0x" value="${escapeAttr(state.sendData)}" />
      </label>
      <label>Gas Limit (optional)
        <input type="number" id="send-gas-limit" placeholder="21000" min="21000" value="${escapeAttr(state.sendGasLimit)}" />
      </label>
      <label>Max Fee Per Gas (optional, wei)
        <input type="number" id="send-max-fee" placeholder="1000000000" min="0" value="${escapeAttr(state.sendMaxFeePerGas)}" />
      </label>
      <label>Priority Fee (optional, wei)
        <input type="number" id="send-priority-fee" placeholder="100000000" min="0" value="${escapeAttr(state.sendMaxPriorityFeePerGas)}" />
      </label>
      <div class="fee-info">
        <span class="label">Next nonce:</span>
        <span class="fee-amount">${state.nonce == null ? 'unknown' : escapeHtml(state.nonce)}</span>
      </div>
      ${renderError()}
      <button id="btn-send-confirm" class="btn-primary" ${sendDisabled ? 'disabled' : ''}>
        ${sendDisabled ? 'Fix network before sending' : 'Send'}
      </button>
    </div>
  `;
}

function renderReceive(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Receive SHELL</h2>
      <p class="hint">Share your address to receive funds.</p>
      <div class="qr-wrapper" style="display:flex;justify-content:center;margin:12px 0">
        <canvas id="qr-canvas"></canvas>
      </div>
      <div class="address-box">
        <span class="monospace address-full" id="full-addr">${escapeHtml(state.pqAddress)}</span>
      </div>
      <button id="btn-copy-full" class="btn-primary">Copy Address</button>
    </div>
  `;
}

function renderHistory(): string {
  const txItems = state.txHistory.length > 0
    ? state.txHistory.map((tx) => {
        const isOutgoing = tx.from.toLowerCase() === state.pqAddress.toLowerCase();
        const readableType = formatTxHistoryType(tx);
        const isBatch = isAaBatchTx(tx);
        const isSponsored = !!tx.paymaster;
        const dir = readableType !== 'Transfer' ? readableType : (isOutgoing ? '↑ Sent' : '↓ Received');
        const val = isBatch ? '' : formatDisplayValue(tx.value) + ' SHELL';
        const hash = tx.txHash ? truncate(tx.txHash, 8, 6) : '–';
        const isExpanded = state.selectedTxHash === tx.txHash;
        const sponsoredBadge = isSponsored
          ? `<span class="badge badge-sponsored" title="Gas sponsored by paymaster">⚡ Sponsored</span>`
          : '';
        const detail = isExpanded ? `
          <div class="tx-detail">
            <div class="tx-detail-row"><span>Hash</span><span class="monospace">${escapeHtml(tx.txHash ?? '–')}</span></div>
            <div class="tx-detail-row"><span>From</span><span class="monospace">${escapeHtml(truncate(tx.from, 10, 8))}</span></div>
            <div class="tx-detail-row"><span>To</span><span class="monospace">${escapeHtml(truncate(tx.to ?? '–', 10, 8))}</span></div>
            <div class="tx-detail-row"><span>Value</span><span>${escapeHtml(formatDisplayValue(tx.value))} SHELL</span></div>
            <div class="tx-detail-row"><span>Status</span><span>${escapeHtml(tx.status)}</span></div>
            ${tx.error ? `<div class="tx-detail-row tx-detail-error"><span>Error</span><span>${escapeHtml(tx.error)}</span></div>` : ''}
          </div>` : '';
        return `
          <div class="tx-item${isBatch ? ' tx-item-batch' : ''} tx-item-clickable" data-txhash="${escapeAttr(tx.txHash ?? '')}">
            <span class="tx-dir">${escapeHtml(dir)}</span>
            <span class="tx-hash monospace">${escapeHtml(hash)}</span>
            ${val ? `<span class="tx-value">${escapeHtml(val)}</span>` : ''}
            ${sponsoredBadge}
            <span class="tx-status ${escapeAttr(tx.status)}">${escapeHtml(tx.status)}</span>
            ${detail}
          </div>
        `;
      }).join('')
    : '<div class="empty-state">No transactions yet</div>';

  return `
    <div class="view-list">
      <div class="view-list-header">
        <button class="btn-back" id="btn-back">← Back</button>
        <h2>Transaction History</h2>
      </div>
      <div class="tx-list">${txItems}</div>
    </div>
  `;
}

function isAaBatchTx(tx: WalletTxRecord): boolean {
  return tx.shellType === 'aaBatch' || tx.txType === '0x7e';
}

export function formatTxHistoryType(tx: WalletTxRecord): string {
  const shellType = tx.shellType ?? tx.rewardKind;
  if (shellType === 'blockGasReward') return 'Block Reward';
  if (shellType === 'starkReward') return 'STARK Reward';
  if (isAaBatchTx(tx)) {
    return `⚡ Batch${tx.innerCallCount != null ? ` (${tx.innerCallCount} calls)` : ''}`;
  }
  if (shellType === 'contractCreate') return 'Contract Create';
  if (shellType === 'contractCall') return 'Contract Call';
  return 'Transfer';
}

export function formatTxHistoryLabel(tx: WalletTxRecord): string {
  const type = formatTxHistoryType(tx);
  if (type !== 'Transfer') return type;
  return `${formatDisplayValue(tx.value)} SHELL`;
}

function renderAccounts(): string {
  const accountsHtml = state.accounts.map((acct, i) => {
    const isActive = acct.pqAddress === state.pqAddress;
    return `
      <div class="account-item${isActive ? ' account-item-active' : ''}">
        <div class="account-item-info">
          <span class="account-label">Account ${i + 1}</span>
          <span class="monospace account-address">${truncate(acct.pqAddress)}</span>
          ${isActive ? '<span class="badge badge-active">Active</span>' : ''}
        </div>
        <div class="account-item-actions">
          ${!isActive
            ? `<button class="btn-secondary btn-switch-account" data-address="${escapeHtml(acct.pqAddress)}">Switch</button>`
            : ''}
          <button class="btn-secondary btn-copy-account" data-address="${escapeHtml(acct.pqAddress)}">Copy</button>
        </div>
      </div>
    `;
  }).join('');
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Accounts</h2>
      <div class="account-list">${accountsHtml}</div>
      <button id="btn-add-account" class="btn-secondary" style="margin-top:16px">+ Add Account</button>
      ${renderError()}
    </div>
  `;
}

function renderAddAccount(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Add Account</h2>
      <p class="hint">Set a password to protect this account's keystore. You will need it to switch to this account.</p>
      <label>Password
        <input type="password" id="add-account-pwd1" placeholder="Password (min 8 chars)" autocomplete="new-password" />
      </label>
      <label>Confirm Password
        <input type="password" id="add-account-pwd2" placeholder="Confirm password" autocomplete="new-password" />
      </label>
      ${renderError()}
      <button id="btn-add-account-confirm" class="btn-primary">Generate Account</button>
    </div>
  `;
}

function renderAddAccountGenerating(): string {
  return `<div class="center"><div class="spinner"></div><p>Generating new account…</p></div>`;
}

function renderSwitchAccount(): string {
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Switch Account</h2>
      <p class="hint">Enter the password for this account:</p>
      <div class="address-box" style="margin-bottom:12px">
        <span class="monospace">${escapeHtml(truncate(state.switchTargetAddress))}</span>
      </div>
      <label>Password
        <input type="password" id="switch-account-pwd" placeholder="Account password" autocomplete="current-password" autofocus />
      </label>
      ${renderError()}
      <button id="btn-switch-account-confirm" class="btn-primary">Switch</button>
    </div>
  `;
}

function renderSettings(): string {
  const connectedSitesHtml = state.connectedSites.length > 0
    ? state.connectedSites.map((site) => `
        <div class="site-item">
          <div class="site-item-main">
            <div class="site-origin">${escapeHtml(site.origin)}</div>
            <div class="site-meta">
              <span>${escapeHtml(site.accounts.length > 0 ? truncate(site.accounts[0], 8, 6) : 'No accounts')}</span>
              <span>Chain ${escapeHtml(site.chainId)}</span>
            </div>
          </div>
          <button class="btn-secondary btn-site-revoke" data-origin="${escapeAttr(site.origin)}">Revoke</button>
        </div>
      `).join('')
    : '<div class="empty-state compact-empty">No connected dApps yet</div>';
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Settings</h2>

      <div class="section-title">Network</div>
      <select id="network-select" class="select-input">
        <option value="devnet" ${state.network.name === KNOWN_NETWORKS.devnet.name ? 'selected' : ''}>Shell Devnet (${KNOWN_NETWORKS.devnet.chainId})</option>
        <option value="localdev" ${state.network.name === KNOWN_NETWORKS.localdev.name ? 'selected' : ''}>Shell Testnet — local (${KNOWN_NETWORKS.localdev.chainId}, localhost)</option>
        <option value="testnet" ${state.network.name === KNOWN_NETWORKS.testnet.name ? 'selected' : ''}>Shell Testnet (${KNOWN_NETWORKS.testnet.chainId})</option>
        <option value="mainnet" ${state.network.name === KNOWN_NETWORKS.mainnet.name ? 'selected' : ''}>Shell Mainnet (${KNOWN_NETWORKS.mainnet.chainId})</option>
        <option value="custom">Custom RPC…</option>
      </select>
      <div id="custom-rpc-section" style="display:none">
        <label>Chain ID
          <input type="number" id="custom-chain-id" placeholder="424242" />
        </label>
        <label>RPC URL
          <input type="text" id="custom-rpc-url" placeholder="http://127.0.0.1:8545" />
        </label>
        <label>Network Name
          <input type="text" id="custom-net-name" placeholder="My Network" />
        </label>
        <button id="btn-save-custom" class="btn-secondary">Save Custom RPC</button>
      </div>

      <div class="section-title" style="margin-top:16px">Security</div>
      <label>Auto-lock (minutes, 0 = disabled)
        <input type="number" id="auto-lock-minutes" min="0" value="${escapeAttr(state.autoLockMinutes)}" />
      </label>
      <button id="btn-save-auto-lock" class="btn-secondary">Save Auto-lock</button>
      <button id="btn-export-ks" class="btn-secondary">Export Keystore</button>
      <button id="btn-reveal-phrase" class="btn-secondary">Reveal Recovery Phrase</button>
      <button id="btn-advanced-pq" class="btn-secondary">Advanced PQ</button>
      <button id="btn-reset" class="btn-danger">Reset Wallet</button>

      <div class="section-title" style="margin-top:16px">Connected dApps</div>
      <div class="site-list">${connectedSitesHtml}</div>
    </div>
  `;
}

function renderAdvancedPq(): string {
  const resultHtml = state.sessionAuthJson
    ? `
      <div class="section-title" style="margin-top:16px">Session Authorization</div>
      <textarea id="session-auth-json" rows="10" readonly>${escapeHtml(state.sessionAuthJson)}</textarea>
      <button id="btn-copy-session-auth" class="btn-secondary">Copy Session Auth</button>
    `
    : '';
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Advanced PQ</h2>
      <p class="hint">Authorize a deterministic HD session key for bounded AA/paymaster workflows.</p>

      <div class="section-title">Session Key</div>
      <label>Password
        <input type="password" id="session-password" placeholder="Wallet password" autocomplete="current-password" value="${escapeHtml(state.sessionPassword)}" />
      </label>
      <label>Root Account Index
        <input type="number" id="session-root-index" min="0" step="1" value="${escapeHtml(state.sessionRootAccountIndex)}" />
      </label>
      <label>Session Index
        <input type="number" id="session-index" min="0" step="1" value="${escapeHtml(state.sessionIndex)}" />
      </label>
      <label>Expiry Block
        <input type="number" id="session-expiry" min="1" step="1" placeholder="e.g. 430000" value="${escapeHtml(state.sessionExpiryBlock)}" />
      </label>
      <label>Value Cap (wei)
        <input type="text" id="session-value-cap" inputmode="numeric" placeholder="0" value="${escapeHtml(state.sessionValueCap)}" />
      </label>
      <label>Target Address (optional)
        <input type="text" id="session-target" placeholder="0x… or empty" value="${escapeHtml(state.sessionTarget)}" />
      </label>
      <label>Transaction Signing Hash (optional)
        <input type="text" id="session-tx-hash" placeholder="0x + 32 bytes, optional" value="${escapeHtml(state.sessionTxSigningHash)}" />
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-authorize-session" class="btn-primary">Authorize Session Key</button>
      ${resultHtml}

      <div class="section-title" style="margin-top:16px">Key Rotation</div>
      <p class="hint">Submit an AccountManager key-rotation transaction. The wallet activates the new local keystore only after the transaction confirms.</p>
      <label>Password
        <input type="password" id="rotate-password" placeholder="Wallet password" autocomplete="current-password" value="${escapeHtml(state.rotatePassword)}" />
      </label>
      <button id="btn-rotate-key" class="btn-secondary">Rotate Active Key</button>
      ${state.pendingRotationTxHash
        ? `<div class="status-card status-card-warning">Pending rotation: <span class="monospace">${truncate(state.pendingRotationTxHash, 10, 8)}</span></div>`
        : ''}
    </div>
  `;
}

function renderApprovalRequest(): string {
  const request = state.approvalRequest;
  if (!request) {
    return `
      <div class="center">
        <h2>Approval not found</h2>
        <p class="hint">This approval request may have expired.</p>
      </div>
    `;
  }

  // Detect AA batch transaction (tx_type = 0x7e)
  const isBatchTx = request.kind === 'send-transaction' &&
    (request.payload.tx_type === '0x7e' || request.payload.tx_type === 126);

  let detailsHtml: string;

  if (isBatchTx) {
    const innerCalls = Array.isArray(request.payload.inner_calls)
      ? (request.payload.inner_calls as AaBatchInnerCall[])
      : [];
    const paymaster = request.payload.paymaster as string | null | undefined;
    const isSponsored = !!paymaster;

    const callsHtml = innerCalls.length > 0
      ? innerCalls.map((call, i) => `
          <div class="inner-call-item">
            <div class="inner-call-index">#${i + 1}</div>
            <div class="approval-row">
              <span class="approval-key">To</span>
              <span class="approval-value monospace">${escapeHtml(call.to)}</span>
            </div>
            <div class="approval-row">
              <span class="approval-key">Value</span>
              <span class="approval-value">${escapeHtml(formatDisplayValue(call.value || '0'))} SHELL</span>
            </div>
            <div class="approval-row">
              <span class="approval-key">Gas</span>
              <span class="approval-value">${escapeHtml(call.gas_limit)}</span>
            </div>
            ${call.data && call.data !== '0x'
              ? `<div class="approval-row"><span class="approval-key">Data</span><span class="approval-value monospace" style="word-break:break-all">${escapeHtml(call.data.slice(0, 32))}…</span></div>`
              : ''}
          </div>
        `).join('')
      : '<div class="hint">No inner calls</div>';

    detailsHtml = `
      <div class="approval-card">
        <div class="batch-header">
          <span class="badge badge-batch">⚡ AA Batch (${innerCalls.length} call${innerCalls.length !== 1 ? 's' : ''})</span>
          ${isSponsored ? `<span class="badge badge-sponsored">⚡ Sponsored</span>` : ''}
        </div>
        ${isSponsored ? `<div class="approval-row"><span class="approval-key">Paymaster</span><span class="approval-value monospace">${escapeHtml(paymaster)}</span></div>` : ''}
        <div class="inner-calls-list">${callsHtml}</div>
      </div>
    `;
  } else if (request.kind === 'add-chain' || request.kind === 'switch-chain') {
    // WALLET-H2: for chain operations, always show chain ID, network name, and
    // RPC URL host prominently so users can spot a malicious RPC endpoint.
    const rpcUrl = typeof request.payload.rpcUrl === 'string' ? request.payload.rpcUrl : '';
    let rpcHost = rpcUrl;
    try { rpcHost = new URL(rpcUrl).host; } catch { /* keep raw value */ }
    detailsHtml = `
      <div class="approval-card">
        <div class="approval-row">
          <span class="approval-key">Network</span>
          <span class="approval-value">${escapeHtml(String(request.payload.networkName ?? ''))}</span>
        </div>
        <div class="approval-row">
          <span class="approval-key">Chain ID</span>
          <span class="approval-value monospace">${escapeHtml(String(request.payload.chainId ?? ''))}</span>
        </div>
        <div class="approval-row">
          <span class="approval-key">RPC Host</span>
          <span class="approval-value monospace" style="font-weight:bold">${escapeHtml(rpcHost)}</span>
        </div>
        <div class="approval-row">
          <span class="approval-key">Requesting site</span>
          <span class="approval-value monospace">${escapeHtml(request.origin)}</span>
        </div>
      </div>
    `;
  } else {
    detailsHtml = `
      <div class="approval-card">
        ${Object.entries(request.payload)
          .map(([key, value]) => `
            <div class="approval-row">
              <span class="approval-key">${escapeHtml(key)}</span>
              <span class="approval-value monospace">${escapeHtml(String(value))}</span>
            </div>
          `)
          .join('')}
      </div>
    `;
  }

  return `
    <div class="view-form">
      <div class="logo">🛡️</div>
      <h2>Approve Request</h2>
      <p class="hint">${escapeHtml(request.origin)}</p>
      <div class="status-card status-card-warning">This site is requesting: <strong>${escapeHtml(request.kind)}</strong></div>
      ${detailsHtml}
      ${renderError()}
      <button id="btn-approval-approve" class="btn-primary">Approve</button>
      <button id="btn-approval-reject" class="btn-secondary">Reject</button>
    </div>
  `;
}

// ────────── Event handlers ──────────

function attachHandlers(): void {
  const on = (id: string, ev: string, fn: EventListener) => {
    document.getElementById(id)?.addEventListener(ev, fn);
  };

  on('btn-create', 'click', () => {
    state.error = '';
    state.view = 'create-password';
    render();
  });

  on('btn-create-hd', 'click', async () => {
    state.error = '';
    state.view = 'create-generating';
    render();
    try {
      const res = await send<{ mnemonic: string }>('GENERATE_MNEMONIC');
      state.pendingMnemonic = res.mnemonic;
      state.view = 'hd-show-phrase';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'welcome';
      render();
    }
  });

  on('btn-restore-hd', 'click', () => {
    state.error = '';
    state.pendingMnemonic = '';
    state.view = 'hd-restore-phrase';
    render();
  });

  on('btn-hd-phrase-next', 'click', () => {
    state.error = '';
    state.view = 'hd-confirm-phrase';
    render();
  });

  on('btn-hd-confirm-next', 'click', () => {
    const checked = (document.getElementById('hd-confirm-check') as HTMLInputElement)?.checked;
    if (!checked) {
      state.error = 'Please confirm you have backed up your recovery phrase.';
      render();
      return;
    }
    state.error = '';
    state.view = 'hd-create-password';
    render();
  });

  on('btn-hd-create-confirm', 'click', async () => {
    const pwd1 = (document.getElementById('hd-pwd1') as HTMLInputElement)?.value;
    const pwd2 = (document.getElementById('hd-pwd2') as HTMLInputElement)?.value;
    if (!pwd1 || pwd1.length < 8) {
      state.error = 'Password must be at least 8 characters';
      render();
      return;
    }
    if (pwd1 !== pwd2) {
      state.error = 'Passwords do not match';
      render();
      return;
    }
    state.error = '';
    state.view = 'hd-creating';
    render();
    try {
      const res = await send<{ pqAddress: string }>('CREATE_HD_WALLET', {
        mnemonic: state.pendingMnemonic,
        password: pwd1,
      });
      state.pendingMnemonic = '';
      state.pqAddress = res.pqAddress;
      state.view = 'create-success';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'hd-create-password';
      render();
    }
  });

  on('btn-hd-restore-phrase-next', 'click', () => {
    const phrase = ((document.getElementById('hd-restore-phrase-input') as HTMLTextAreaElement)?.value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const wordCount = phrase.split(' ').length;
    if (wordCount !== 12 && wordCount !== 24) {
      state.error = 'Recovery phrase must be 12 or 24 words.';
      render();
      return;
    }
    state.error = '';
    state.pendingMnemonic = phrase;
    state.view = 'hd-restore-password';
    render();
  });

  on('btn-hd-restore-confirm', 'click', async () => {
    const pwd1 = (document.getElementById('hd-restore-pwd1') as HTMLInputElement)?.value;
    const pwd2 = (document.getElementById('hd-restore-pwd2') as HTMLInputElement)?.value;
    if (!pwd1 || pwd1.length < 8) {
      state.error = 'Password must be at least 8 characters';
      render();
      return;
    }
    if (pwd1 !== pwd2) {
      state.error = 'Passwords do not match';
      render();
      return;
    }
    state.error = '';
    state.view = 'hd-restoring';
    render();
    try {
      const res = await send<{ pqAddress: string }>('RESTORE_HD_WALLET', {
        mnemonic: state.pendingMnemonic,
        password: pwd1,
      });
      state.pendingMnemonic = '';
      state.pqAddress = res.pqAddress;
      await refreshWalletData();
      state.view = 'wallet';
      render();
      showToast('Wallet restored successfully');
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'hd-restore-password';
      render();
    }
  });

  on('btn-reveal-phrase', 'click', () => {
    state.error = '';
    state.revealedMnemonic = '';
    state.view = 'reveal-phrase';
    render();
  });

  on('btn-reveal-phrase-confirm', 'click', async () => {
    const pwd = (document.getElementById('reveal-phrase-pwd') as HTMLInputElement)?.value;
    if (!pwd) return;
    state.error = '';
    try {
      const res = await send<{ mnemonic: string }>('REVEAL_MNEMONIC', { password: pwd });
      state.revealedMnemonic = res.mnemonic;
      state.view = 'reveal-phrase-confirm';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      render();
    }
  });

  on('btn-back-from-phrase', 'click', () => {
    state.revealedMnemonic = '';
    state.view = 'settings';
    render();
  });

  on('btn-import', 'click', () => {
    state.error = '';
    state.view = 'import-file';
    render();
  });

  on('btn-back', 'click', () => {
    state.error = '';
    const backMap: Partial<Record<View, View>> = {
      'create-password': 'welcome',
      'hd-show-phrase': 'welcome',
      'hd-confirm-phrase': 'hd-show-phrase',
      'hd-create-password': 'hd-confirm-phrase',
      'hd-restore-phrase': 'welcome',
      'hd-restore-password': 'hd-restore-phrase',
      'reveal-phrase': 'settings',
      'import-file': 'welcome',
      'import-password': 'import-file',
      send: 'wallet',
      receive: 'wallet',
      history: 'wallet',
      settings: 'wallet',
      accounts: 'wallet',
      'add-account': 'accounts',
      'switch-account': 'accounts',
      'advanced-pq': 'settings',
    };
    state.view = backMap[state.view] ?? 'wallet';
    render();
  });

  on('btn-confirm-pwd', 'click', async () => {
    const pwd1 = (document.getElementById('pwd1') as HTMLInputElement)?.value;
    const pwd2 = (document.getElementById('pwd2') as HTMLInputElement)?.value;
    if (!pwd1 || pwd1.length < 8) {
      state.error = 'Password must be at least 8 characters';
      render();
      return;
    }
    if (pwd1 !== pwd2) {
      state.error = 'Passwords do not match';
      render();
      return;
    }
    state.error = '';
    state.view = 'create-generating';
    render();
    try {
      const res = await send<{ pqAddress: string }>('CREATE_WALLET', {
        password: pwd1,
      });
      state.pqAddress = res.pqAddress;
      state.view = 'create-success';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'create-password';
      render();
    }
  });

  on('btn-goto-wallet', 'click', async () => {
    await refreshWalletData();
    state.view = 'wallet';
    render();
  });

  // File import
  const fileInput = document.getElementById('ks-file') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const json = e.target?.result as string;
          JSON.parse(json); // validate
          state.pendingKeystoreJson = json;
          state.error = '';
          state.view = 'import-password';
          render();
        } catch {
          state.error = 'Invalid keystore file';
          render();
        }
      };
      reader.readAsText(file);
    });
  }

  on('btn-confirm-import', 'click', async () => {
    const pwd = (document.getElementById('import-pwd') as HTMLInputElement)?.value;
    if (!pwd) {
      state.error = 'Enter the keystore password';
      render();
      return;
    }
    state.error = '';
    state.view = 'create-generating';
    render();
    try {
      const res = await send<{ pqAddress: string }>('IMPORT_KEYSTORE', {
        keystoreJson: state.pendingKeystoreJson,
        password: pwd,
      });
      state.pqAddress = res.pqAddress;
      await refreshWalletData();
      state.view = 'wallet';
      render();
      showToast('Wallet imported successfully');
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'import-password';
      render();
    }
  });

  on('btn-unlock', 'click', async () => {
    const pwd = (document.getElementById('unlock-pwd') as HTMLInputElement)?.value;
    if (!pwd) return;
    const selectedAddress = (document.getElementById('unlock-account-select') as HTMLSelectElement | null)?.value;
    state.error = '';
    state.view = 'unlocking';
    render();
    try {
      await send('UNLOCK_WALLET', { password: pwd, ...(selectedAddress ? { address: selectedAddress } : {}) });
      await refreshWalletData();
      state.view = 'wallet';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'locked';
      render();
    }
  });

  // Enter key on unlock password
  document.getElementById('unlock-pwd')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') document.getElementById('btn-unlock')?.click();
  });

  on('btn-lock', 'click', async () => {
    await send('LOCK_WALLET');
    state.view = 'locked';
    render();
  });

  on('btn-settings', 'click', () => {
    state.view = 'settings';
    render();
  });

  on('btn-advanced-pq', 'click', () => {
    state.error = '';
    state.view = 'advanced-pq';
    render();
  });

  on('btn-accounts', 'click', () => {
    state.error = '';
    state.view = 'accounts';
    render();
  });

  // Add account flow
  on('btn-add-account', 'click', () => {
    state.error = '';
    state.view = 'add-account';
    render();
  });

  on('btn-add-account-confirm', 'click', async () => {
    const pwd1 = (document.getElementById('add-account-pwd1') as HTMLInputElement)?.value;
    const pwd2 = (document.getElementById('add-account-pwd2') as HTMLInputElement)?.value;
    if (!pwd1 || pwd1.length < 8) {
      state.error = 'Password must be at least 8 characters';
      render();
      return;
    }
    if (pwd1 !== pwd2) {
      state.error = 'Passwords do not match';
      render();
      return;
    }
    state.error = '';
    state.view = 'add-account-generating';
    render();
    try {
      await send<{ pqAddress: string }>('ADD_ACCOUNT', { password: pwd1 });
      await refreshWalletData();
      state.view = 'accounts';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'add-account';
      render();
    }
  });

  // Switch account: clicking Switch on an account row
  document.querySelectorAll('.btn-switch-account').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.error = '';
      state.switchTargetAddress = (btn as HTMLElement).dataset.address ?? '';
      state.view = 'switch-account';
      render();
    });
  });

  // Copy address from accounts list
  document.querySelectorAll('.btn-copy-account').forEach((btn) => {
    btn.addEventListener('click', () => {
      const addr = (btn as HTMLElement).dataset.address ?? '';
      copyText(addr, 'Address copied');
    });
  });

  on('btn-switch-account-confirm', 'click', async () => {
    const pwd = (document.getElementById('switch-account-pwd') as HTMLInputElement)?.value;
    if (!pwd) return;
    state.error = '';
    try {
      await send('SWITCH_ACCOUNT', { password: pwd, address: state.switchTargetAddress });
      await refreshWalletData();
      state.view = 'wallet';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      render();
    }
  });

  // History tx click-to-expand detail
  document.querySelectorAll('.tx-item-clickable').forEach((item) => {
    item.addEventListener('click', () => {
      const hash = (item as HTMLElement).dataset.txhash ?? '';
      state.selectedTxHash = state.selectedTxHash === hash ? '' : hash;
      render();
    });
  });

  // QR code for receive view
  if (state.view === 'receive') {
    const canvas = document.getElementById('qr-canvas') as HTMLCanvasElement | null;
    if (canvas && state.pqAddress) {
      QRCode.toCanvas(canvas, state.pqAddress, { width: 180, margin: 2 }).catch(() => {
        // QR generation failed silently — address still shown as text
      });
    }
  }

  // Quick network switcher in wallet header
  const quickNetSelect = document.getElementById('quick-net-select') as HTMLSelectElement | null;
  if (quickNetSelect) {
    quickNetSelect.addEventListener('change', async () => {
      const val = quickNetSelect.value;
      const net = KNOWN_NETWORKS[val];
      if (net) {
        try {
          await send('SET_NETWORK', { network: net });
          state.network = net;
          await refreshWalletData();
          showToast('Switched to ' + net.name);
          render();
        } catch (err) {
          showToast((err as Error).message, true);
        }
      }
    });
  }

  on('btn-send', 'click', () => {
    state.sendTo = '';
    state.sendValue = '';
    state.sendData = '0x';
    state.sendGasLimit = '';
    state.sendMaxFeePerGas = '';
    state.sendMaxPriorityFeePerGas = '';
    state.error = '';
    state.view = 'send';
    render();
  });

  on('btn-receive', 'click', () => {
    state.view = 'receive';
    render();
  });

  on('btn-history', 'click', async () => {
    state.view = 'history';
    render();
    try {
      const res = await send<{ txs: WalletTxRecord[] }>('GET_TX_HISTORY', { address: state.pqAddress });
      state.txHistory = res.txs;
      render();
    } catch {
      // leave empty
    }
  });

  on('btn-refresh', 'click', async () => {
    try {
      await refreshBalance();
      render();
      showToast('Balance refreshed');
    } catch (err) {
      showToast((err as Error).message, true);
    }
  });

  on('btn-send-confirm', 'click', async () => {
    if (getNetworkWarning()) {
      state.error = getNetworkWarning();
      render();
      return;
    }
    const to = (document.getElementById('send-to') as HTMLInputElement)?.value?.trim();
    const value = (document.getElementById('send-value') as HTMLInputElement)?.value?.trim();
    const data = (document.getElementById('send-data') as HTMLInputElement)?.value?.trim() || '0x';
    const gasLimit = (document.getElementById('send-gas-limit') as HTMLInputElement)?.value?.trim();
    const maxFeePerGas = (document.getElementById('send-max-fee') as HTMLInputElement)?.value?.trim();
    const maxPriorityFeePerGas =
      (document.getElementById('send-priority-fee') as HTMLInputElement)?.value?.trim();

    if (!to || !value) {
      state.error = 'Enter recipient address and amount';
      render();
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(to)) {
      state.error = 'Recipient must be a 0x + 64-char hex Shell address';
      render();
      return;
    }
    if (Number(value) <= 0) {
      state.error = 'Amount must be greater than 0';
      render();
      return;
    }
    if (data !== '0x' && (!/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0)) {
      state.error = 'Calldata must be an even-length 0x-prefixed hex string';
      render();
      return;
    }
    state.error = '';
    state.sendTo = to;
    state.sendValue = value;
    state.sendData = data;
    state.sendGasLimit = gasLimit;
    state.sendMaxFeePerGas = maxFeePerGas;
    state.sendMaxPriorityFeePerGas = maxPriorityFeePerGas;
    state.view = 'sending';
    render();
    try {
      const res = await send<{ txHash: string }>('SEND_TX', {
        to,
        value,
        data,
        gasLimit: parseOptionalNumber(gasLimit),
        maxFeePerGas: parseOptionalNumber(maxFeePerGas),
        maxPriorityFeePerGas: parseOptionalNumber(maxPriorityFeePerGas),
      });
      showToast('Submitted: ' + truncate(res.txHash, 8, 6));
      await refreshWalletData();
      state.view = 'wallet';
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.view = 'send';
      render();
    }
  });

  on('btn-copy-addr', 'click', () => copyText(state.pqAddress, 'Address copied'));
  on('btn-copy-full', 'click', () => copyText(state.pqAddress, 'Address copied'));

  on('btn-export-ks', 'click', async () => {
    try {
      const res = await send<{ keystoreJson: string }>('EXPORT_KEYSTORE');
      downloadJson(res.keystoreJson, 'shella-keystore.json');
      showToast('Keystore exported');
    } catch (err) {
      showToast((err as Error).message, true);
    }
  });

  on('btn-reset', 'click', async () => {
    if (confirm('Reset wallet? This deletes all local data. Make sure you have exported your keystore!')) {
      await send('RESET_WALLET');
      Object.assign(state, {
        view: 'welcome',
        pqAddress: '',
        balance: '0',
        balanceFormatted: '0.000000',
        detectedChainId: null,
        nonce: null,
        txHistory: [],
        txQueue: [],
        error: '',
      });
      render();
    }
  });

  // Network switch
  const netSelect = document.getElementById('network-select') as HTMLSelectElement | null;
  if (netSelect) {
    netSelect.addEventListener('change', async () => {
      const val = netSelect.value;
      if (val === 'custom') {
        const sec = document.getElementById('custom-rpc-section');
        if (sec) sec.style.display = 'block';
        return;
      }
      const net = KNOWN_NETWORKS[val];
      if (net) {
        try {
          await send('SET_NETWORK', { network: net });
          state.network = net;
          await refreshWalletData();
          showToast('Network switched to ' + net.name);
          render();
        } catch (err) {
          showToast((err as Error).message, true);
        }
      }
    });
  }

  on('btn-save-custom', 'click', async () => {
    const chainId = parseInt((document.getElementById('custom-chain-id') as HTMLInputElement)?.value);
    const rpcUrl = (document.getElementById('custom-rpc-url') as HTMLInputElement)?.value?.trim();
    const name = (document.getElementById('custom-net-name') as HTMLInputElement)?.value?.trim() || 'Custom';
    if (!chainId || !rpcUrl) {
      showToast('Fill in Chain ID and RPC URL', true);
      return;
    }
    const net = { name, chainId, rpcUrl };
    try {
      await send('SET_NETWORK', { network: net });
      state.network = net;
      await refreshWalletData();
      showToast('Custom RPC saved');
      render();
    } catch (err) {
      showToast((err as Error).message, true);
    }
  });

  on('btn-save-auto-lock', 'click', async () => {
    const minutes = Number((document.getElementById('auto-lock-minutes') as HTMLInputElement)?.value);
    if (!Number.isFinite(minutes) || minutes < 0) {
      showToast('Auto-lock minutes must be 0 or greater', true);
      return;
    }
    await send('SET_AUTO_LOCK', { minutes });
    state.autoLockMinutes = minutes;
    showToast('Auto-lock updated');
  });

  on('btn-authorize-session', 'click', async () => {
    const password = (document.getElementById('session-password') as HTMLInputElement)?.value ?? '';
    const sessionIndex = (document.getElementById('session-index') as HTMLInputElement)?.value?.trim() ?? '0';
    const rootAccountIndex = (document.getElementById('session-root-index') as HTMLInputElement)?.value?.trim() ?? '0';
    const expiryBlock = (document.getElementById('session-expiry') as HTMLInputElement)?.value?.trim() ?? '';
    const valueCap = (document.getElementById('session-value-cap') as HTMLInputElement)?.value?.trim() ?? '0';
    const target = (document.getElementById('session-target') as HTMLInputElement)?.value?.trim() ?? '';
    const txSigningHash = (document.getElementById('session-tx-hash') as HTMLInputElement)?.value?.trim() ?? '';

    state.sessionPassword = password;
    state.sessionIndex = sessionIndex;
    state.sessionRootAccountIndex = rootAccountIndex;
    state.sessionExpiryBlock = expiryBlock;
    state.sessionValueCap = valueCap;
    state.sessionTarget = target;
    state.sessionTxSigningHash = txSigningHash;

    if (!password) {
      state.error = 'Enter wallet password';
      render();
      return;
    }
    if (!isNonNegativeIntegerString(sessionIndex) || !isNonNegativeIntegerString(rootAccountIndex)) {
      state.error = 'Account and session indices must be non-negative integers';
      render();
      return;
    }
    if (!isPositiveIntegerString(expiryBlock)) {
      state.error = 'Expiry block must be a positive integer';
      render();
      return;
    }
    if (!isQuantityString(valueCap)) {
      state.error = 'Value cap must be a hex or decimal quantity';
      render();
      return;
    }
    if (target && !/^0x[0-9a-fA-F]{64}$/.test(target)) {
      state.error = 'Target must be a 0x + 64-char Shell address';
      render();
      return;
    }
    if (txSigningHash && !/^0x[0-9a-fA-F]{64}$/.test(txSigningHash)) {
      state.error = 'Transaction signing hash must be 0x + 32 bytes';
      render();
      return;
    }

    state.error = '';
    try {
      const result = await send('AUTHORIZE_SESSION_KEY', {
        password,
        sessionIndex: Number(sessionIndex),
        rootAccountIndex: Number(rootAccountIndex),
        expiryBlock: Number(expiryBlock),
        valueCap,
        target: target || null,
        txSigningHash: txSigningHash || undefined,
      });
      state.sessionPassword = '';
      state.sessionAuthJson = JSON.stringify(result, null, 2);
      render();
      showToast('Session key authorized');
    } catch (err) {
      state.error = (err as Error).message;
      render();
    }
  });

  on('btn-copy-session-auth', 'click', () => {
    copyText(state.sessionAuthJson, 'Session auth copied');
  });

  on('btn-rotate-key', 'click', async () => {
    const password = (document.getElementById('rotate-password') as HTMLInputElement)?.value ?? '';
    state.rotatePassword = password;
    if (!password) {
      state.error = 'Enter wallet password';
      render();
      return;
    }
    state.error = '';
    try {
      const result = await send<{ txHash: string; pqAddress: string }>('ROTATE_KEY', { password });
      state.rotatePassword = '';
      state.pendingRotationTxHash = result.txHash;
      await refreshWalletData();
      render();
      showToast('Key rotation submitted');
    } catch (err) {
      state.error = (err as Error).message;
      render();
    }
  });

  on('btn-approval-approve', 'click', async () => {
    if (!state.approvalRequest) return;
    await send('RESOLVE_APPROVAL', { requestId: state.approvalRequest.id, approved: true });
    window.close();
  });

  on('btn-approval-reject', 'click', async () => {
    if (!state.approvalRequest) return;
    await send('RESOLVE_APPROVAL', { requestId: state.approvalRequest.id, approved: false });
    window.close();
  });

  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll<HTMLButtonElement>('.btn-site-revoke').forEach((button) => {
      button.addEventListener('click', async () => {
        const origin = button.dataset.origin;
        if (!origin) return;
        await send('REMOVE_CONNECTED_SITE', { origin });
        state.connectedSites = state.connectedSites.filter((site) => site.origin !== origin);
        render();
        showToast('dApp permission revoked');
      });
    });
  }
}

// ────────── Helpers ──────────

async function refreshBalance(): Promise<void> {
  if (!state.pqAddress) return;
  const res = await send<{ balance: string; formatted: string }>('GET_BALANCE', {
    address: state.pqAddress,
  });
  state.balance = res.balance;
  state.balanceFormatted = res.formatted;
}

async function refreshWalletData(): Promise<void> {
  const snapshot = await send<WalletSnapshot>('GET_WALLET_SNAPSHOT');
  state.network = snapshot.wallet.network;
  state.txQueue = snapshot.wallet.txQueue;
  state.autoLockMinutes = snapshot.wallet.autoLockMinutes;
  state.connectedSites = snapshot.wallet.connectedSites;
  state.detectedChainId = snapshot.detectedChainId;
  state.nonce = snapshot.nonce;
  state.nodeInfo = snapshot.nodeInfo ?? null;
  state.accounts = snapshot.wallet.accounts ?? [];
  if (snapshot.activeAddress) {
    state.pqAddress = snapshot.activeAddress;
  } else if (snapshot.primaryAccount) {
    state.pqAddress = snapshot.primaryAccount.pqAddress;
  }
  if (snapshot.balance) {
    state.balance = snapshot.balance.raw;
    state.balanceFormatted = snapshot.balance.formatted;
  } else {
    state.balance = '0';
    state.balanceFormatted = '0.000000';
  }
}

function copyText(text: string, msg: string): void {
  navigator.clipboard.writeText(text).then(() => showToast(msg)).catch(() => {
    // Fallback
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast(msg);
  });
}

function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseOptionalNumber(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNonNegativeIntegerString(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function isPositiveIntegerString(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function isQuantityString(value: string): boolean {
  return /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value);
}

export function formatDisplayValue(value: string): string {
  const normalized = value.startsWith('0x') ? BigInt(value) : BigInt(value);
  return (Number(normalized) / 1e18).toFixed(6);
}

// ────────── Boot ──────────

async function boot(): Promise<void> {
  const approvalId = new URLSearchParams(window.location.search).get('approvalId');
  if (approvalId) {
    state.approvalRequest = await send<ApprovalRequest>('GET_APPROVAL_REQUEST', { requestId: approvalId });
    state.view = 'approval-request';
    render();
    return;
  }

  const snapshot = await send<WalletSnapshot>('GET_WALLET_SNAPSHOT');
  state.network = snapshot.wallet.network;
  state.txQueue = snapshot.wallet.txQueue;
  state.autoLockMinutes = snapshot.wallet.autoLockMinutes;
  state.connectedSites = snapshot.wallet.connectedSites;
  state.detectedChainId = snapshot.detectedChainId;
  state.nonce = snapshot.nonce;
  state.nodeInfo = snapshot.nodeInfo ?? null;
  state.accounts = snapshot.wallet.accounts ?? [];

  if (!snapshot.primaryAccount) {
    state.view = 'welcome';
  } else if (snapshot.locked) {
    state.pqAddress = snapshot.activeAddress ?? snapshot.primaryAccount.pqAddress;
    state.view = 'locked';
  } else {
    state.pqAddress = snapshot.activeAddress ?? snapshot.primaryAccount.pqAddress;
    if (snapshot.balance) {
      state.balance = snapshot.balance.raw;
      state.balanceFormatted = snapshot.balance.formatted;
    } else {
      state.balance = '0';
      state.balanceFormatted = '0.000000';
    }
    state.view = 'wallet';
  }

  render();
}

boot().catch((err) => {
  state.view = 'locked';
  state.error = (err as Error).message;
  render();
});
