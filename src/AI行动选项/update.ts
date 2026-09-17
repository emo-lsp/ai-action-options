import { z } from 'zod';
import type { UpdateEndpoint } from './types';
import { SCRIPT_VERSION, UPDATE_REPOSITORY } from './version';
import { startHostUpdate } from './update_host';

const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
const MANIFEST_FILE = 'manifest.json';

const ReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  releasedAt: z.string().min(1),
  channel: z.enum(['stable', 'beta']).default('stable'),
  changes: z.array(z.string().min(1)).min(1),
  ref: z
    .string()
    .regex(/^[0-9A-Za-z._/-]+$/)
    .refine(value => !value.includes('..'), '版本 ref 不能包含 ..'),
  path: z
    .string()
    .regex(/^[^?#\\]+$/)
    .refine(value => !value.startsWith('/') && !value.split('/').includes('..'), '更新文件必须是仓库内相对路径'),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    latest: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    versions: z.array(ReleaseSchema).min(1),
  })
  .superRefine((manifest, context) => {
    if (!manifest.versions.some(release => release.version === manifest.latest)) {
      context.addIssue({
        code: 'custom',
        path: ['latest'],
        message: 'latest 必须对应 versions 中的一个版本',
      });
    }
  });

export type UpdateRelease = z.infer<typeof ReleaseSchema>;
export type UpdateManifest = z.infer<typeof ManifestSchema>;
export type UpdateStatus = 'idle' | 'checking' | 'success' | 'error';
export type UpdateRuntimeState = {
  status: UpdateStatus;
  manifest: UpdateManifest | null;
  endpointUsed: Exclude<UpdateEndpoint, 'auto'> | null;
  checkedAt: number | null;
  hasUpdate: boolean;
  error: string | null;
};

type UpdateCache = {
  checkedAt: number;
  endpointUsed: Exclude<UpdateEndpoint, 'auto'>;
  manifest: UpdateManifest;
};

const listeners = new Set<(state: UpdateRuntimeState) => void>();
let runtimeState: UpdateRuntimeState = {
  status: 'idle',
  manifest: null,
  endpointUsed: null,
  checkedAt: null,
  hasUpdate: false,
  error: null,
};

function getCacheKey(): string {
  return `ai-action-options:update-cache:${getScriptId()}`;
}

function cloneState(state: UpdateRuntimeState): UpdateRuntimeState {
  return {
    ...state,
    manifest: state.manifest ? (JSON.parse(JSON.stringify(state.manifest)) as UpdateManifest) : null,
  };
}

function publishState(next: UpdateRuntimeState): UpdateRuntimeState {
  runtimeState = next;
  const snapshot = cloneState(runtimeState);
  for (const listener of listeners) listener(snapshot);
  return snapshot;
}

function readCache(): UpdateCache | null {
  try {
    const value = localStorage.getItem(getCacheKey());
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<UpdateCache>;
    const manifest = ManifestSchema.safeParse(parsed.manifest);
    if (
      !manifest.success ||
      typeof parsed.checkedAt !== 'number' ||
      !Number.isFinite(parsed.checkedAt) ||
      !parsed.endpointUsed
    )
      return null;
    if (!['testingcf', 'jsdelivr', 'github'].includes(parsed.endpointUsed)) return null;
    return {
      checkedAt: Number(parsed.checkedAt),
      endpointUsed: parsed.endpointUsed,
      manifest: manifest.data,
    };
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    localStorage.setItem(getCacheKey(), JSON.stringify(cache));
  } catch (error) {
    console.warn('[AI行动选项] 无法写入更新检查缓存', error);
  }
}

function parseIdentifier(identifier: string): Array<number | string> {
  return identifier.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
}

/** 返回正数表示 left 更新，负数表示 right 更新。 */
export function compareVersions(left: string, right: string): number {
  const [leftCore, leftPre] = left.trim().replace(/^v/i, '').split('-', 2);
  const [rightCore, rightPre] = right.trim().replace(/^v/i, '').split('-', 2);
  const leftParts = leftCore.split('.').map(Number);
  const rightParts = rightCore.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  if (!leftPre && !rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;

  const leftIdentifiers = parseIdentifier(leftPre);
  const rightIdentifiers = parseIdentifier(rightPre);
  const count = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < count; index += 1) {
    const leftValue = leftIdentifiers[index];
    const rightValue = rightIdentifiers[index];
    if (leftValue == null) return -1;
    if (rightValue == null) return 1;
    if (leftValue === rightValue) continue;
    if (typeof leftValue === 'number' && typeof rightValue === 'string') return -1;
    if (typeof leftValue === 'string' && typeof rightValue === 'number') return 1;
    return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

export function parseUpdateManifest(value: unknown): UpdateManifest {
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`更新清单格式无效：${z.prettifyError(parsed.error)}`);
  }
  return {
    ...parsed.data,
    versions: [...parsed.data.versions].sort((left, right) => compareVersions(right.version, left.version)),
  };
}

function getEndpointOrder(endpoint: UpdateEndpoint): Array<Exclude<UpdateEndpoint, 'auto'>> {
  return endpoint === 'auto' ? ['testingcf', 'jsdelivr', 'github'] : [endpoint as Exclude<UpdateEndpoint, 'auto'>];
}

function encodeRepositoryPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function buildRepositoryUrl(endpoint: Exclude<UpdateEndpoint, 'auto'>, ref: string, path: string): string {
  const encodedRef = encodeRepositoryPath(ref);
  const encodedPath = encodeRepositoryPath(path);
  if (endpoint === 'github') {
    return `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/${encodedRef}/${encodedPath}`;
  }
  const host = endpoint === 'testingcf' ? 'testingcf.jsdelivr.net' : 'cdn.jsdelivr.net';
  return `https://${host}/gh/${UPDATE_REPOSITORY}@${encodedRef}/${encodedPath}`;
}

export function buildManifestUrls(endpoint: UpdateEndpoint): Array<{
  endpoint: Exclude<UpdateEndpoint, 'auto'>;
  url: string;
}> {
  return getEndpointOrder(endpoint).map(item => ({
    endpoint: item,
    url: buildRepositoryUrl(item, 'main', MANIFEST_FILE),
  }));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchManifest(endpoint: UpdateEndpoint): Promise<{
  endpointUsed: Exclude<UpdateEndpoint, 'auto'>;
  manifest: UpdateManifest;
}> {
  const errors: string[] = [];
  // CDN 的 HTTP 200 可能仍是旧清单；自动模式并行比较版本，不能在首个成功响应处结束。
  const results = await Promise.all(
    buildManifestUrls(endpoint).map(async candidate => {
      try {
        const response = await fetchWithTimeout(candidate.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {
          endpointUsed: candidate.endpoint,
          manifest: parseUpdateManifest(await response.json()),
        };
      } catch (error) {
        errors.push(`${candidate.endpoint}: ${(error as Error)?.message || '请求失败'}`);
        return null;
      }
    }),
  );
  let newest: (typeof results)[number] = null;
  for (const result of results) {
    // 同版本保留原端点优先级，不把不同快照拼接成未经发布的清单。
    if (result && (!newest || compareVersions(result.manifest.latest, newest.manifest.latest) > 0)) {
      newest = result;
    }
  }
  if (newest) return newest;
  if (errors.length > 0 && errors.every(message => message.includes('HTTP 404'))) {
    throw new Error('更新清单尚未发布');
  }
  throw new Error(`所有更新端点均不可用（${errors.join('；')}）`);
}

function cacheMatchesEndpoint(cache: UpdateCache, endpoint: UpdateEndpoint): boolean {
  return endpoint === 'auto' || cache.endpointUsed === endpoint;
}

function stateFromCache(cache: UpdateCache, status: UpdateStatus = 'success'): UpdateRuntimeState {
  return {
    status,
    manifest: cache.manifest,
    endpointUsed: cache.endpointUsed,
    checkedAt: cache.checkedAt,
    hasUpdate: compareVersions(cache.manifest.latest, SCRIPT_VERSION) > 0,
    error: null,
  };
}

export function restoreCachedUpdateState(): UpdateRuntimeState {
  const cache = readCache();
  if (!cache) return getUpdateState();
  return publishState(stateFromCache(cache));
}

export function getUpdateState(): UpdateRuntimeState {
  return cloneState(runtimeState);
}

export function subscribeUpdateState(listener: (state: UpdateRuntimeState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function checkForUpdates(options: {
  endpoint: UpdateEndpoint;
  force?: boolean;
}): Promise<UpdateRuntimeState> {
  const cache = readCache();
  if (
    !options.force &&
    cache &&
    cacheMatchesEndpoint(cache, options.endpoint) &&
    Date.now() - cache.checkedAt < UPDATE_CACHE_TTL_MS
  ) {
    return publishState(stateFromCache(cache));
  }

  publishState({
    ...runtimeState,
    status: 'checking',
    error: null,
  });

  try {
    const result = await fetchManifest(options.endpoint);
    const nextCache: UpdateCache = {
      checkedAt: Date.now(),
      endpointUsed: result.endpointUsed,
      manifest: result.manifest,
    };
    writeCache(nextCache);
    return publishState(stateFromCache(nextCache));
  } catch (error) {
    const message = (error as Error)?.message || '更新检查失败';
    return publishState({
      status: 'error',
      manifest: cache?.manifest ?? runtimeState.manifest,
      endpointUsed: cache?.endpointUsed ?? runtimeState.endpointUsed,
      checkedAt: cache?.checkedAt ?? runtimeState.checkedAt,
      hasUpdate: cache ? compareVersions(cache.manifest.latest, SCRIPT_VERSION) > 0 : runtimeState.hasUpdate,
      error: message,
    });
  }
}

async function digestSha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function installUpdate(release: UpdateRelease, endpoint: UpdateEndpoint): Promise<void> {
  const parsedRelease = ReleaseSchema.parse(release);
  const candidates = getEndpointOrder(endpoint);
  const errors: string[] = [];
  let content = '';

  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(buildRepositoryUrl(candidate, parsedRelease.ref, parsedRelease.path));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const downloaded = await response.text();
      if (downloaded.length < 10_000) throw new Error('下载内容过短，不像完整脚本');
      const digest = await digestSha256(downloaded);
      if (digest.toLowerCase() !== parsedRelease.sha256.toLowerCase()) {
        throw new Error('SHA-256 校验失败');
      }
      content = downloaded;
      break;
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error)?.message || '下载失败'}`);
    }
  }

  if (!content) throw new Error(`更新文件下载失败（${errors.join('；')}）`);
  await startHostUpdate({ scriptId: getScriptId(), content, version: parsedRelease.version });
}
