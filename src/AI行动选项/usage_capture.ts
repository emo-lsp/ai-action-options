type CapturedUsageResponse = {
  model?: unknown;
  usage: unknown;
};

type PendingCapture = {
  matched: boolean;
  promise: Promise<CapturedUsageResponse | null>;
  resolve: (value: CapturedUsageResponse | null) => void;
};

type FetchHookState = {
  hostWindow: Window;
  originalFetch: Window['fetch'];
  wrappedFetch: Window['fetch'];
};

const CHAT_COMPLETION_ENDPOINT = '/api/backends/chat-completions/generate';
export const USAGE_CAPTURE_MARKER_FIELD = '__tlao_usage_capture_id';

const pendingCaptures = new Map<string, PendingCapture>();
let fetchHookState: FetchHookState | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getRequestUrl(input: Parameters<Window['fetch']>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return typeof input?.url === 'string' ? input.url : '';
}

function isChatCompletionRequest(input: Parameters<Window['fetch']>[0]): boolean {
  try {
    return new URL(getRequestUrl(input), window.parent.location.href).pathname === CHAT_COMPLETION_ENDPOINT;
  } catch {
    return false;
  }
}

async function getRequestBodyText(
  input: Parameters<Window['fetch']>[0],
  init?: Parameters<Window['fetch']>[1],
): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (typeof input !== 'string' && !(input instanceof URL) && typeof input?.clone === 'function') {
    try {
      return await input.clone().text();
    } catch {
      return '';
    }
  }
  return '';
}

function extractCaptureMarker(bodyText: string): string | null {
  try {
    const requestBody = asRecord(JSON.parse(bodyText));
    const includedBody = requestBody?.custom_include_body;
    if (typeof includedBody === 'string') {
      const match = includedBody.match(new RegExp(`(?:^|\\n)${USAGE_CAPTURE_MARKER_FIELD}:\\s*["']?([^\\s"']+)`, 'm'));
      return match?.[1] ?? null;
    }
    const includedBodyRecord = asRecord(includedBody);
    const marker = includedBodyRecord?.[USAGE_CAPTURE_MARKER_FIELD];
    return typeof marker === 'string' ? marker : null;
  } catch {
    return null;
  }
}

function extractUsageResponse(value: unknown): CapturedUsageResponse | null {
  const response = asRecord(value);
  if (!response || !('usage' in response) || response.usage == null) return null;
  return {
    model: response.model,
    usage: response.usage,
  };
}

function releaseFetchHookIfIdle(): void {
  if (pendingCaptures.size > 0 || !fetchHookState) return;
  const { hostWindow, originalFetch, wrappedFetch } = fetchHookState;
  if (hostWindow.fetch === wrappedFetch) {
    hostWindow.fetch = originalFetch;
  }
  fetchHookState = null;
}

function canInstallFetchHook(hostWindow: Window): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(hostWindow, 'fetch');
    // 已有 get/set 的 fetch 可能由其他请求监控器托管，不能再通过赋值叠加包装层。
    return !descriptor?.get && !descriptor?.set;
  } catch {
    return false;
  }
}

function ensureFetchHook(): boolean {
  const hostWindow = window.parent;
  if (fetchHookState?.hostWindow === hostWindow && hostWindow.fetch === fetchHookState.wrappedFetch) return true;
  if (!canInstallFetchHook(hostWindow)) return false;

  const originalFetch = hostWindow.fetch;
  const wrappedFetch: Window['fetch'] = async (input, init) => {
    const marker = isChatCompletionRequest(input) ? extractCaptureMarker(await getRequestBodyText(input, init)) : null;
    const pendingCapture = marker ? pendingCaptures.get(marker) : null;
    if (pendingCapture) pendingCapture.matched = true;

    try {
      const response = await originalFetch.call(hostWindow, input, init);
      if (pendingCapture) {
        void response
          .clone()
          .json()
          .then(extractUsageResponse)
          .then(pendingCapture.resolve)
          .catch(() => pendingCapture.resolve(null));
      }
      return response;
    } catch (error) {
      pendingCapture?.resolve(null);
      throw error;
    }
  };

  fetchHookState = { hostWindow, originalFetch, wrappedFetch };
  try {
    hostWindow.fetch = wrappedFetch;
    if (hostWindow.fetch !== wrappedFetch) {
      fetchHookState = null;
      return false;
    }
  } catch {
    fetchHookState = null;
    return false;
  }
  return true;
}

export type ChatCompletionUsageCaptureResult<T> = {
  result: T;
  capturedUsage: CapturedUsageResponse | null;
  fetchHookSkipped: boolean;
};

export async function captureChatCompletionUsage<T>(
  marker: string,
  request: () => Promise<T>,
): Promise<ChatCompletionUsageCaptureResult<T>> {
  let resolveCapture!: PendingCapture['resolve'];
  const capture: PendingCapture = {
    matched: false,
    promise: new Promise(resolve => {
      resolveCapture = resolve;
    }),
    resolve: value => resolveCapture(value),
  };

  pendingCaptures.set(marker, capture);
  const fetchHookSkipped = !ensureFetchHook();
  try {
    const result = await request();
    const capturedUsage = !fetchHookSkipped && capture.matched ? await capture.promise : null;
    return { result, capturedUsage, fetchHookSkipped };
  } finally {
    pendingCaptures.delete(marker);
    releaseFetchHookIfIdle();
  }
}
