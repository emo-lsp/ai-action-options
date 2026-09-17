import type { ApiUsageSnapshot } from './types';

type DeepSeekPrice = {
  label: string;
  cacheHitPerMillion: number;
  cacheMissPerMillion: number;
  outputPerMillion: number;
};

type DeepSeekPricePeriod = 'off-peak' | 'peak';
type UsageRecord = Record<string, unknown>;

const BEIJING_UTC_OFFSET_MINUTES = 8 * 60;

// 官方公告：2026-08-23 00:00（北京时间）起，周末全天按空闲时段价格计费
const WEEKEND_OFF_PEAK_START_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

// 当前官方峰谷价（元 / 百万 tokens）；旧 Flash 名称仍按 V4.1 Flash 价格计费。

const DEEPSEEK_PRICING: Array<{
  pattern: RegExp;
  label: string;
  offPeak: DeepSeekPrice;
  peak: DeepSeekPrice;
}> = [
  {
    pattern: /^deepseek[-_/]?v4[-_/]?pro(?:[-_/].*)?$/i,
    label: 'DeepSeek-V4-Pro',
    offPeak: {
      label: 'DeepSeek-V4-Pro（空闲时段）',
      cacheHitPerMillion: 0.15,
      cacheMissPerMillion: 4.5,
      outputPerMillion: 13.5,
    },
    peak: {
      label: 'DeepSeek-V4-Pro（高峰时段）',
      cacheHitPerMillion: 0.3,
      cacheMissPerMillion: 9,
      outputPerMillion: 27,
    },
  },
  {
    pattern: /^deepseek[-_/]?(?:v4(?:\.1)?[-_/]?)?flash(?:[-_/].*)?$/i,
    label: 'DeepSeek-V4.1-Flash',
    offPeak: {
      label: 'DeepSeek-V4.1-Flash（空闲时段）',
      cacheHitPerMillion: 0.02,
      cacheMissPerMillion: 1,
      outputPerMillion: 4,
    },
    peak: {
      label: 'DeepSeek-V4.1-Flash（高峰时段）',
      cacheHitPerMillion: 0.04,
      cacheMissPerMillion: 2,
      outputPerMillion: 8,
    },
  },
  {
    pattern: /^deepseek[-_]?(?:chat|reasoner)$/i,
    label: 'DeepSeek-V4.1-Flash',
    offPeak: {
      label: 'DeepSeek-V4.1-Flash（旧模型名，空闲时段）',
      cacheHitPerMillion: 0.02,
      cacheMissPerMillion: 1,
      outputPerMillion: 4,
    },
    peak: {
      label: 'DeepSeek-V4.1-Flash（旧模型名，高峰时段）',
      cacheHitPerMillion: 0.04,
      cacheMissPerMillion: 2,
      outputPerMillion: 8,
    },
  },
];

function asRecord(value: unknown): UsageRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UsageRecord) : null;
}

function getRecordValue(record: UsageRecord | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  return undefined;
}

function toNullableInteger(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function getBeijingMinutes(timestamp: number): number {
  const date = new Date(timestamp);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMinutes + BEIJING_UTC_OFFSET_MINUTES) % (24 * 60);
}

function getPricePeriod(timestamp: number): DeepSeekPricePeriod {
  if (timestamp >= WEEKEND_OFF_PEAK_START_MS) {
    const beijingDay = new Date(timestamp + BEIJING_UTC_OFFSET_MINUTES * 60_000).getUTCDay();
    if (beijingDay === 0 || beijingDay === 6) return 'off-peak';
  }
  const beijingMinutes = getBeijingMinutes(timestamp);
  const isPeak =
    (beijingMinutes >= 9 * 60 && beijingMinutes < 12 * 60) || (beijingMinutes >= 14 * 60 && beijingMinutes < 18 * 60);
  return isPeak ? 'peak' : 'off-peak';
}

function getDeepSeekPrice(model: string, timestamp: number): DeepSeekPrice | null {
  const normalizedModel = String(model || '').trim();
  const entry = DEEPSEEK_PRICING.find(item => item.pattern.test(normalizedModel));
  if (!entry) return null;

  const period = getPricePeriod(timestamp);
  return period === 'peak' ? entry.peak : entry.offPeak;
}

function getPeriodLabel(timestamp: number): string {
  const period = getPricePeriod(timestamp);
  return period === 'peak' ? '北京时间高峰时段' : '北京时间空闲时段';
}

function calculateEstimatedCostCny(
  pricing: DeepSeekPrice,
  promptTokens: number | null,
  promptCacheHitTokens: number | null,
  promptCacheMissTokens: number | null,
  completionTokens: number | null,
): number | null {
  const inputHitTokens = promptCacheHitTokens ?? 0;
  const inputMissTokens =
    promptCacheMissTokens ?? (promptTokens != null ? Math.max(0, promptTokens - inputHitTokens) : null);
  if (inputMissTokens == null && completionTokens == null) return null;

  const inputCost =
    (inputHitTokens * pricing.cacheHitPerMillion + (inputMissTokens ?? 0) * pricing.cacheMissPerMillion) / 1_000_000;
  const outputCost = ((completionTokens ?? 0) * pricing.outputPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

export function buildDeepSeekUsageSnapshot(options: {
  model: string;
  usage: unknown;
  requestedAt: number;
  finishedAt: number;
  estimated?: boolean;
}): Partial<ApiUsageSnapshot> | null {
  const usage = asRecord(options.usage);
  const pricing = getDeepSeekPrice(options.model, options.requestedAt);
  if (!usage || !pricing) return null;

  const promptTokensDetails = asRecord(usage.prompt_tokens_details);
  let promptTokens = toNullableInteger(getRecordValue(usage, ['prompt_tokens', 'input_tokens', 'promptTokens']));
  let promptCacheHitTokens = toNullableInteger(
    getRecordValue(usage, [
      'prompt_cache_hit_tokens',
      'promptCacheHitTokens',
      'input_cache_hit_tokens',
      'cached_tokens',
      'cache_read_input_tokens',
    ]) ?? getRecordValue(promptTokensDetails, ['cached_tokens', 'cache_read_input_tokens']),
  );
  let promptCacheMissTokens = toNullableInteger(
    getRecordValue(usage, ['prompt_cache_miss_tokens', 'promptCacheMissTokens', 'input_cache_miss_tokens']) ??
      getRecordValue(promptTokensDetails, ['cache_miss_tokens', 'cache_write_input_tokens']),
  );
  const completionTokens = toNullableInteger(
    getRecordValue(usage, ['completion_tokens', 'output_tokens', 'completionTokens']),
  );
  let totalTokens = toNullableInteger(getRecordValue(usage, ['total_tokens', 'totalTokens']));

  if (promptTokens == null && promptCacheHitTokens != null && promptCacheMissTokens != null) {
    promptTokens = promptCacheHitTokens + promptCacheMissTokens;
  }
  const cacheStatsAvailable = promptCacheHitTokens != null || promptCacheMissTokens != null;
  if (cacheStatsAvailable && promptTokens != null) {
    if (promptCacheHitTokens == null && promptCacheMissTokens != null) {
      promptCacheHitTokens = Math.max(0, promptTokens - promptCacheMissTokens);
    }
    if (promptCacheMissTokens == null && promptCacheHitTokens != null) {
      promptCacheMissTokens = Math.max(0, promptTokens - promptCacheHitTokens);
    }
  }
  if (totalTokens == null && (promptTokens != null || completionTokens != null)) {
    totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }

  const hitRate =
    cacheStatsAvailable && promptTokens != null && promptTokens > 0 && promptCacheHitTokens != null
      ? Math.max(0, Math.min(1, promptCacheHitTokens / promptTokens))
      : null;
  const estimatedCostCny = calculateEstimatedCostCny(
    pricing,
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
  );

  let note = options.estimated
    ? '后端未返回 usage；按本地 tokenizer 估算输入/输出 Tokens，并按输入全部缓存未命中估算'
    : cacheStatsAvailable
      ? promptCacheHitTokens && promptCacheHitTokens > 0
        ? `已命中 ${promptCacheHitTokens} tokens`
        : '本次请求未命中缓存'
      : '接口未返回缓存统计字段；价格按输入全部缓存未命中估算';
  if (options.estimated) {
    note += '，思考模式下不包含未返回的隐藏思考 Tokens';
  }
  if (estimatedCostCny != null) {
    const roundedCostCny = Math.round((estimatedCostCny + Number.EPSILON) * 1000) / 1000;
    note += `；按${getPeriodLabel(options.requestedAt)}的${pricing.label}官方单价估算 ¥${roundedCostCny.toFixed(3)}`;
  }

  return {
    status: 'success',
    requestedAt: options.requestedAt,
    finishedAt: options.finishedAt,
    model: options.model,
    promptTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheStatsAvailable,
    completionTokens,
    totalTokens,
    hitRate,
    estimatedCostCny,
    pricingModel: pricing.label,
    pricingPeriod: getPricePeriod(options.requestedAt),
    note,
  };
}
