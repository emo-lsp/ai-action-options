const WORLD_BOOK_READ_TIMEOUT_MS = 4000;

function getRootWindow(): Window {
  return window;
}

function getSillyTavernRequestHeaders(): Record<string, string> {
  try {
    const headers = SillyTavern?.getRequestHeaders?.();
    if (!headers || typeof headers !== 'object') {
      return { 'Content-Type': 'application/json' };
    }
    return {
      ...headers,
      'Content-Type': 'application/json',
    };
  } catch {
    return { 'Content-Type': 'application/json' };
  }
}

function normalizeWorldbookEntries(payload: unknown): WorldbookEntry[] {
  if (Array.isArray(payload)) {
    return payload as WorldbookEntry[];
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    (record.worldBook as Record<string, unknown> | undefined)?.entries,
    record.entries,
    (record.worldbook as Record<string, unknown> | undefined)?.entries,
    (record.data as Record<string, unknown> | undefined)?.entries,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate as WorldbookEntry[];
    }
  }

  return [];
}

async function parseJsonOrText(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (!rawText) return '';

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`${label}超时（>${Math.round(WORLD_BOOK_READ_TIMEOUT_MS / 1000)} 秒）`));
      }, WORLD_BOOK_READ_TIMEOUT_MS);
    }),
  ]);
}

async function readViaStApi(name: string): Promise<WorldbookEntry[] | null> {
  const stApi = (globalThis as any).ST_API;
  if (!stApi?.worldbook?.get) return null;

  const label = `读取世界书「${name}」`;
  const results = await Promise.allSettled([
    withTimeout(Promise.resolve(stApi.worldbook.get({ name, scope: 'character' })), label),
    withTimeout(Promise.resolve(stApi.worldbook.get({ name, scope: 'global' })), label),
    withTimeout(Promise.resolve(stApi.worldbook.get({ name })), label),
  ]);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const entries = normalizeWorldbookEntries(result.value);
      if (entries.length) return entries;
    }
  }

  return null;
}

async function readViaTavernHelper(name: string): Promise<WorldbookEntry[] | null> {
  const helper = (globalThis as any).TavernHelper;
  if (typeof helper?.getWorldbook !== 'function') return null;

  try {
    const entries = await withTimeout(Promise.resolve(helper.getWorldbook(name)), `读取世界书「${name}」`);
    return Array.isArray(entries) && entries.length ? (entries as WorldbookEntry[]) : null;
  } catch {
    return null;
  }
}

async function readViaGlobal(name: string): Promise<WorldbookEntry[] | null> {
  const getter = (globalThis as any).getWorldbook;
  if (typeof getter !== 'function') return null;

  try {
    const entries = await withTimeout(Promise.resolve(getter(name)), `读取世界书「${name}」`);
    return Array.isArray(entries) && entries.length ? (entries as WorldbookEntry[]) : null;
  } catch {
    return null;
  }
}

async function readViaFetch(name: string): Promise<WorldbookEntry[] | null> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), WORLD_BOOK_READ_TIMEOUT_MS);
    try {
      const response = await getRootWindow().fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getSillyTavernRequestHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({ name }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`读取世界书失败 (${response.status})`);
      }
      const payload = await parseJsonOrText(response);
      const entries = normalizeWorldbookEntries(payload);
      return entries.length ? entries : null;
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function readWorldbookEntries(worldbookName: string): Promise<WorldbookEntry[]> {
  const name = String(worldbookName || '').trim();
  if (!name) return [];

  const readers = [readViaStApi, readViaTavernHelper, readViaGlobal, readViaFetch];
  let emptyResult: WorldbookEntry[] | null = null;
  let lastError: unknown = null;

  for (const reader of readers) {
    try {
      const entries = await reader(name);
      if (entries != null) {
        if (entries.length) return entries;
        emptyResult = [];
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError && emptyResult == null) throw lastError;
  return emptyResult ?? [];
}
