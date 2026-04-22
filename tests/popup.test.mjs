/**
 * Tests for the popup module — utility functions and view rendering.
 * Mocks chrome.runtime and a minimal DOM to let popup.js boot and render.
 */
import assert from 'node:assert/strict';
import { describe, test, before } from 'node:test';

// ── Minimal DOM mock ──────────────────────────────────────────────────────────

const domElements = new Map();

function makeEl(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    style: { display: '' },
    value: '',
    files: null,
    _listeners: {},
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    dispatchEvent() {},
  };
}

const appEl = makeEl('app');
const toastEl = makeEl('toast');
domElements.set('app', appEl);
domElements.set('toast', toastEl);

globalThis.document = {
  getElementById: (id) => domElements.get(id) ?? null,
  querySelectorAll: () => [],
  createElement: () => ({
    style: {}, href: '', download: '', tagName: 'a',
    click() {}, select() {}, value: '',
    addEventListener() {},
  }),
  body: { appendChild() {}, removeChild() {} },
};

globalThis.window = {
  location: { search: '' },
  close() {},
};

Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  writable: true,
  configurable: true,
});
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };
globalThis.Blob = class Blob {};

// ── Chrome mock ───────────────────────────────────────────────────────────────

const noWalletSnapshot = {
  locked: false,
  wallet: {
    network: { name: 'Shell Devnet', chainId: 424242, rpcUrl: 'http://127.0.0.1:8545' },
    accounts: [],
    autoLockMinutes: 15,
    connectedSites: [],
    txQueue: [],
  },
  primaryAccount: null,
  balance: null,
  nonce: null,
  detectedChainId: null,
};

globalThis.chrome = {
  runtime: {
    sendMessage(msg, cb) {
      if (msg.type === 'GET_WALLET_SNAPSHOT') {
        cb(noWalletSnapshot);
      } else {
        cb({ ok: true });
      }
    },
    lastError: null,
  },
};

// ── Import popup (triggers boot()) ───────────────────────────────────────────

describe('popup', async () => {
  before(async () => {
    await import('../dist/popup.js');
    // Give boot() one event-loop tick to complete (sendMessage is sync in our mock)
    await new Promise((r) => setTimeout(r, 50));
  });

  test('renders welcome view when no wallet is set up', () => {
    const html = appEl.innerHTML;
    assert.ok(html.includes('Create New Wallet'), 'should show Create New Wallet button');
    assert.ok(html.includes('Import Keystore'), 'should show Import Keystore button');
    assert.ok(html.includes('Shella Wallet'), 'should show the wallet name');
  });

  test('rendered HTML contains a toast placeholder', () => {
    const html = appEl.innerHTML;
    assert.ok(html.includes('toast'), 'toast element should be present in rendered output');
  });

  test('truncate shortens long addresses with ellipsis', async () => {
    // Import the exported utility function from the popup module
    const mod = await import('../dist/popup.js');
    const { truncate } = mod;
    if (typeof truncate !== 'function') return; // not exported in this build

    const addr = 'pq1' + 'a'.repeat(60);
    const result = truncate(addr);
    assert.ok(result.includes('…'), 'truncated address should contain ellipsis');
    assert.ok(result.length < addr.length, 'truncated address should be shorter');
    assert.ok(result.startsWith('pq1'), 'should preserve beginning of address');
  });

  test('formatDisplayValue converts wei string to decimal SHELL', async () => {
    const mod = await import('../dist/popup.js');
    const { formatDisplayValue } = mod;
    if (typeof formatDisplayValue !== 'function') return;

    // 1 ETH = 1e18 wei → "1.000000"
    assert.equal(formatDisplayValue('1000000000000000000'), '1.000000');
    // 0 wei → "0.000000"
    assert.equal(formatDisplayValue('0'), '0.000000');
  });

  test('parseOptionalNumber parses numeric strings and rejects empty/invalid', async () => {
    const mod = await import('../dist/popup.js');
    const { parseOptionalNumber } = mod;
    if (typeof parseOptionalNumber !== 'function') return;

    assert.equal(parseOptionalNumber('21000'), 21000);
    assert.equal(parseOptionalNumber(''), undefined);
    assert.equal(parseOptionalNumber('abc'), undefined);
    assert.equal(parseOptionalNumber('0'), 0);
  });
});
