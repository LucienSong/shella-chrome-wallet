/**
 * Shella Wallet — popup entry point.
 * Multi-view SPA rendered into #app.
 */

import type {
  ApprovalRequest,
  ConnectedSitePermission,
  Network,
  WalletSnapshot,
  WalletTxRecord,
} from './types.js';

type View =
  | 'loading'
  | 'welcome'
  | 'create-password'
  | 'create-generating'
  | 'create-success'
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
  | 'approval-request';

interface AppState {
  view: View;
  pqAddress: string;
  hexAddress: string;
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
  // Temp fields for flows
  pendingKeystoreJson: string;
  sendTo: string;
  sendValue: string;
  sendData: string;
  sendGasLimit: string;
  sendMaxFeePerGas: string;
  sendMaxPriorityFeePerGas: string;
  approvalRequest: ApprovalRequest | null;
}

const state: AppState = {
  view: 'loading',
  pqAddress: '',
  hexAddress: '',
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
  pendingKeystoreJson: '',
  sendTo: '',
  sendValue: '',
  sendData: '0x',
  sendGasLimit: '',
  sendMaxFeePerGas: '',
  sendMaxPriorityFeePerGas: '',
  approvalRequest: null,
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
  return document.getElementById('app')!;
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
    'approval-request': renderApprovalRequest,
  };
  app().innerHTML = `
    <div id="toast" class="toast" style="display:none"></div>
    ${views[state.view]?.() ?? renderLoading()}
  `;
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
      <button id="btn-create" class="btn-primary">Create New Wallet</button>
      <button id="btn-import" class="btn-secondary">Import Keystore</button>
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
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
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
      <p class="hint">Signing and broadcasting to ${state.network.name}…</p>
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
        <span class="address monospace" id="addr-display">${truncate(state.pqAddress)}</span>
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
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
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
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-confirm-import" class="btn-primary">Import Wallet</button>
    </div>
  `;
}

function renderLocked(): string {
  return `
    <div class="view-form">
      <div class="logo">🔒</div>
      <h2>Wallet Locked</h2>
      <p class="hint">${truncate(state.pqAddress) || 'Enter your password to unlock.'}</p>
      <label>Password
        <input type="password" id="unlock-pwd" placeholder="Enter password" autocomplete="current-password" autofocus />
      </label>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
      <button id="btn-unlock" class="btn-primary">Unlock</button>
    </div>
  `;
}

function renderWallet(): string {
  const pendingTxs = state.txQueue.filter((tx) => tx.status === 'pending').slice(0, 3);
  const networkWarning = getNetworkWarning();
  const failedTx = getLatestFailedTx();
  const pendingHtml = pendingTxs.length > 0
    ? `
      <div class="pending-card">
        <div class="pending-title">Pending Transactions</div>
        ${pendingTxs.map((tx) => `
          <div class="pending-item">
            <span class="monospace">${truncate(tx.txHash, 8, 6)}</span>
            <span>${formatDisplayValue(tx.value)} SHELL</span>
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
          <span class="monospace">${truncate(failedTx.txHash, 8, 6)}</span>
          <span>${formatDisplayValue(failedTx.value)} SHELL</span>
        </div>
        <div class="status-card-detail">${failedTx.error ?? 'Transaction failed on-chain.'}</div>
      </div>
    `
    : '';
  return `
    <div class="wallet-view">
      <div class="wallet-header">
        <select id="quick-net-select" class="quick-net-select" title="Switch network">
          <option value="devnet" ${state.network.name === 'Shell Devnet' ? 'selected' : ''}>⬡ Devnet</option>
          <option value="testnet" ${state.network.name === 'Shell Testnet' ? 'selected' : ''}>⬡ Testnet</option>
          <option value="mainnet" ${state.network.name === 'Shell Mainnet' ? 'selected' : ''}>⬡ Mainnet</option>
        </select>
        <button class="btn-icon" id="btn-settings" title="Settings">⚙</button>
        <button class="btn-icon" id="btn-lock" title="Lock wallet">🔒</button>
      </div>
      <div class="address-box">
        <span class="monospace address-short">${truncate(state.pqAddress)}</span>
        <button class="btn-copy" id="btn-copy-addr" title="Copy address">⧉</button>
      </div>
      <div class="balance-section">
        <span class="balance-amount">${state.balanceFormatted}</span>
        <span class="balance-unit">SHELL</span>
        <button class="btn-refresh" id="btn-refresh" title="Refresh balance">↻</button>
      </div>
      <div class="wallet-meta">
        <span>Configured chain: ${state.network.chainId}</span>
        <span>${state.detectedChainId == null ? 'RPC unavailable' : `RPC chain: ${state.detectedChainId}`}</span>
        <span>${state.nonce == null ? 'Nonce unavailable' : `Nonce: ${state.nonce}`}</span>
      </div>
      ${networkWarning ? `<div class="status-card status-card-warning">${networkWarning}</div>` : ''}
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
      ${networkWarning ? `<div class="status-card status-card-warning">${networkWarning}</div>` : ''}
      <label>To Address (pq1… or 0x…)
        <input type="text" id="send-to" placeholder="pq1…" value="${state.sendTo}" />
      </label>
      <label>Amount (SHELL)
        <input type="number" id="send-value" placeholder="0.0" step="any" min="0" value="${state.sendValue}" />
      </label>
      <label>Calldata (optional 0x...)
        <input type="text" id="send-data" placeholder="0x" value="${state.sendData}" />
      </label>
      <label>Gas Limit (optional)
        <input type="number" id="send-gas-limit" placeholder="21000" min="21000" value="${state.sendGasLimit}" />
      </label>
      <label>Max Fee Per Gas (optional, wei)
        <input type="number" id="send-max-fee" placeholder="1000000000" min="0" value="${state.sendMaxFeePerGas}" />
      </label>
      <label>Priority Fee (optional, wei)
        <input type="number" id="send-priority-fee" placeholder="100000000" min="0" value="${state.sendMaxPriorityFeePerGas}" />
      </label>
      <div class="fee-info">
        <span class="label">Next nonce:</span>
        <span class="fee-amount">${state.nonce == null ? 'unknown' : state.nonce}</span>
      </div>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
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
      <div class="qr-placeholder">
        <div class="qr-icon">📲</div>
      </div>
      <div class="address-box">
        <span class="monospace address-full" id="full-addr">${state.pqAddress}</span>
      </div>
      <button id="btn-copy-full" class="btn-primary">Copy Address</button>
      <div class="divider"></div>
      <div class="address-box" style="margin-top:8px">
        <span class="label" style="font-size:11px">Hex address (0x)</span>
        <span class="monospace address-small">${truncate(state.hexAddress, 12, 10)}</span>
        <button class="btn-copy" id="btn-copy-hex" title="Copy hex address">⧉</button>
      </div>
    </div>
  `;
}

function renderHistory(): string {
  const txItems = state.txHistory.length > 0
    ? state.txHistory.map((tx) => {
        const dir = tx.from.toLowerCase() === state.hexAddress.toLowerCase() ? '↑ Sent' : '↓ Received';
        const val = formatDisplayValue(tx.value);
        const hash = tx.txHash ? truncate(tx.txHash, 8, 6) : '–';
        return `
          <div class="tx-item">
            <span class="tx-dir">${dir}</span>
            <span class="tx-hash monospace">${hash}</span>
            <span class="tx-value">${val} SHELL</span>
            <span class="tx-status ${tx.status}">${tx.status}</span>
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

function renderSettings(): string {
  const connectedSitesHtml = state.connectedSites.length > 0
    ? state.connectedSites.map((site) => `
        <div class="site-item">
          <div class="site-item-main">
            <div class="site-origin">${site.origin}</div>
            <div class="site-meta">
              <span>${site.accounts.length > 0 ? truncate(site.accounts[0], 8, 6) : 'No accounts'}</span>
              <span>Chain ${site.chainId}</span>
            </div>
          </div>
          <button class="btn-secondary btn-site-revoke" data-origin="${site.origin}">Revoke</button>
        </div>
      `).join('')
    : '<div class="empty-state compact-empty">No connected dApps yet</div>';
  return `
    <div class="view-form">
      <button class="btn-back" id="btn-back">← Back</button>
      <h2>Settings</h2>

      <div class="section-title">Network</div>
      <select id="network-select" class="select-input">
        <option value="devnet" ${state.network.name === 'Shell Devnet' ? 'selected' : ''}>Shell Devnet (424242)</option>
        <option value="testnet" ${state.network.name === 'Shell Testnet' ? 'selected' : ''}>Shell Testnet (12345)</option>
        <option value="mainnet" ${state.network.name === 'Shell Mainnet' ? 'selected' : ''}>Shell Mainnet (100000)</option>
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
        <input type="number" id="auto-lock-minutes" min="0" value="${state.autoLockMinutes}" />
      </label>
      <button id="btn-save-auto-lock" class="btn-secondary">Save Auto-lock</button>
      <button id="btn-export-ks" class="btn-secondary">Export Keystore</button>
      <button id="btn-reset" class="btn-danger">Reset Wallet</button>

      <div class="section-title" style="margin-top:16px">Connected dApps</div>
      <div class="site-list">${connectedSitesHtml}</div>
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

  const details = Object.entries(request.payload)
    .map(([key, value]) => `
      <div class="approval-row">
        <span class="approval-key">${key}</span>
        <span class="approval-value monospace">${String(value)}</span>
      </div>
    `)
    .join('');

  return `
    <div class="view-form">
      <div class="logo">🛡️</div>
      <h2>Approve Request</h2>
      <p class="hint">${request.origin}</p>
      <div class="status-card status-card-warning">This site is requesting: <strong>${request.kind}</strong></div>
      <div class="approval-card">${details}</div>
      ${state.error ? `<div class="error">${state.error}</div>` : ''}
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

  on('btn-import', 'click', () => {
    state.error = '';
    state.view = 'import-file';
    render();
  });

  on('btn-back', 'click', () => {
    state.error = '';
    const backMap: Partial<Record<View, View>> = {
      'create-password': 'welcome',
      'import-file': 'welcome',
      'import-password': 'import-file',
      send: 'wallet',
      receive: 'wallet',
      history: 'wallet',
      settings: 'wallet',
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
      const res = await send<{ pqAddress: string; hexAddress: string }>('CREATE_WALLET', {
        password: pwd1,
      });
      state.pqAddress = res.pqAddress;
      state.hexAddress = res.hexAddress;
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
      const res = await send<{ pqAddress: string; hexAddress: string }>('IMPORT_KEYSTORE', {
        keystoreJson: state.pendingKeystoreJson,
        password: pwd,
      });
      state.pqAddress = res.pqAddress;
      state.hexAddress = res.hexAddress;
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
    state.error = '';
    state.view = 'unlocking';
    render();
    try {
      await send('UNLOCK_WALLET', { password: pwd });
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

  // Quick network switcher in wallet header
  const quickNetSelect = document.getElementById('quick-net-select') as HTMLSelectElement | null;
  if (quickNetSelect) {
    quickNetSelect.addEventListener('change', async () => {
      const val = quickNetSelect.value;
      const quickNetworks: Record<string, { name: string; chainId: number; rpcUrl: string }> = {
        devnet: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
        testnet: { name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' },
        mainnet: { name: 'Shell Mainnet', chainId: 100000, rpcUrl: 'https://rpc.mainnet.shell.network' },
      };
      const net = quickNetworks[val];
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
    if (!/^pq1|^0x/.test(to)) {
      state.error = 'Recipient must be a pq1… or 0x… address';
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
  on('btn-copy-hex', 'click', () => copyText(state.hexAddress, 'Hex address copied'));

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
        hexAddress: '',
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
      const networks: Record<string, { name: string; chainId: number; rpcUrl: string }> = {
        devnet: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
        testnet: { name: 'Shell Testnet', chainId: 12345, rpcUrl: 'https://rpc.testnet.shell.network' },
        mainnet: { name: 'Shell Mainnet', chainId: 100000, rpcUrl: 'https://rpc.mainnet.shell.network' },
      };
      const net = networks[val];
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
    address: state.hexAddress || state.pqAddress,
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
  if (snapshot.primaryAccount) {
    state.pqAddress = snapshot.primaryAccount.pqAddress;
    state.hexAddress = snapshot.primaryAccount.hexAddress;
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

  if (!snapshot.primaryAccount) {
    state.view = 'welcome';
  } else if (snapshot.locked) {
    state.pqAddress = snapshot.primaryAccount.pqAddress;
    state.hexAddress = snapshot.primaryAccount.hexAddress;
    state.view = 'locked';
  } else {
    state.pqAddress = snapshot.primaryAccount.pqAddress;
    state.hexAddress = snapshot.primaryAccount.hexAddress;
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
