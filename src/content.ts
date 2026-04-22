export {};

const REQUEST_TARGET = 'shella-contentscript';
const RESPONSE_TARGET = 'shella-inpage';

interface ProviderRequestPayload {
  target: string;
  id: string;
  method: string;
  params?: unknown[];
}

function injectInpageScript(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('dist/inpage.js');
  script.type = 'module';
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

window.addEventListener('message', (event: MessageEvent<ProviderRequestPayload>) => {
  if (event.source !== window) return;
  if (!event.data || event.data.target !== REQUEST_TARGET || typeof event.data.id !== 'string') return;

  const { id, method, params } = event.data;
  chrome.runtime.sendMessage(
    {
      type: 'DAPP_REQUEST',
      origin: window.location.origin,
      method,
      params: Array.isArray(params) ? params : [],
    },
    (response: unknown & { error?: string }) => {
      const payload = response?.error
        ? { target: RESPONSE_TARGET, id, error: response.error }
        : { target: RESPONSE_TARGET, id, result: response };
      window.postMessage(payload, window.location.origin);
    },
  );
});

injectInpageScript();
