import type { ApiUsageSnapshot } from './types';

const RUNTIME_EVENT = 'tlao:api-usage-updated';

let apiUsageSnapshot: ApiUsageSnapshot = {
  status: 'idle',
  requestedAt: null,
  finishedAt: null,
  model: '',
  promptTokens: null,
  promptCacheHitTokens: null,
  promptCacheMissTokens: null,
  cacheStatsAvailable: false,
  cacheStatsSuppressed: false,
  completionTokens: null,
  totalTokens: null,
  hitRate: null,
  estimatedCostCny: null,
  pricingModel: null,
  pricingPeriod: null,
  note: '最近还没有调用记录',
};

function emitRuntimeUpdate(): void {
  $(document).trigger(RUNTIME_EVENT, [getApiUsageSnapshot()]);
}

export function getApiUsageSnapshot(): ApiUsageSnapshot {
  return {
    ...apiUsageSnapshot,
  };
}

export function setApiUsageSnapshot(next: Partial<ApiUsageSnapshot>): void {
  apiUsageSnapshot = {
    ...apiUsageSnapshot,
    ...next,
  };
  emitRuntimeUpdate();
}

export function onApiUsageSnapshotUpdated(handler: (snapshot: ApiUsageSnapshot) => void): () => void {
  const wrapped = (_event: JQuery.TriggeredEvent, snapshot?: ApiUsageSnapshot) => {
    handler(snapshot ?? getApiUsageSnapshot());
  };
  $(document).on(RUNTIME_EVENT, wrapped);
  return () => {
    $(document).off(RUNTIME_EVENT, wrapped);
  };
}
