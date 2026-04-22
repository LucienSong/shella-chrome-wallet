export {};

const REQUEST_TARGET = 'shella-contentscript';
const RESPONSE_TARGET = 'shella-inpage';
const EIP6963_ANNOUNCE = 'eip6963:announceProvider';
const EIP6963_REQUEST = 'eip6963:requestProvider';

type ProviderEventName = 'connect' | 'disconnect' | 'accountsChanged' | 'chainChanged';

interface ProviderRequestArgs {
  method: string;
  params?: unknown[];
}

interface ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

declare global {
  interface Window {
    ethereum?: ShellaInpageProvider;
    shella?: ShellaInpageProvider;
  }
}

class ShellaInpageProvider {
  isShella = true;
  private readonly listeners = new Map<ProviderEventName, Set<(payload: unknown) => void>>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  private accounts: string[] = [];
  private chainId: string | null = null;

  constructor(readonly info: ProviderInfo) {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as { target?: string; id?: string; result?: unknown; error?: string };
      if (data?.target !== RESPONSE_TARGET || typeof data.id !== 'string') return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) {
        pending.reject(new Error(data.error));
        return;
      }
      pending.resolve(data.result);
    });

    window.addEventListener(EIP6963_REQUEST, this.announce.bind(this));
    queueMicrotask(() => this.announce());
  }

  async request({ method, params = [] }: ProviderRequestArgs): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage({ target: REQUEST_TARGET, id, method, params }, window.location.origin);
    });

    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      this.accounts = Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : [];
      this.emit('accountsChanged', [...this.accounts]);
    }

    if (method === 'eth_chainId' && typeof result === 'string') {
      this.chainId = result;
    }

    if ((method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') && Array.isArray(params)) {
      const [payload] = params;
      const nextChainId =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).chainId === 'string'
          ? (payload as Record<string, string>).chainId
          : null;
      if (nextChainId) {
        this.chainId = nextChainId;
        this.emit('chainChanged', nextChainId);
      }
    }

    return result;
  }

  on(event: ProviderEventName, listener: (payload: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  removeListener(event: ProviderEventName, listener: (payload: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: ProviderEventName, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  private announce(): void {
    window.dispatchEvent(
      new CustomEvent(EIP6963_ANNOUNCE, {
        detail: {
          info: this.info,
          provider: this,
        },
      }),
    );
  }
}

const info: ProviderInfo = {
  uuid: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'shella-wallet-provider',
  name: 'Shella Wallet',
  icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%231a6ef5%22/%3E%3Cpath d=%22M16 6l7 4v5c0 5.4-3.4 9.9-7 11-3.6-1.1-7-5.6-7-11v-5l7-4z%22 fill=%22white%22/%3E%3C/svg%3E',
  rdns: 'org.shell.shela',
};

const provider = new ShellaInpageProvider(info);
window.shella = provider;
if (!window.ethereum) {
  window.ethereum = provider;
}
