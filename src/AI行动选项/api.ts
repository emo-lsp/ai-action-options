import type {
  GenerationContext,
  ResolvedPromptMessage,
  ScriptSettings,
} from './types';
import { validateOptionsJson } from './options';
import { buildDeepSeekUsageSnapshot } from './pricing';
import { setApiUsageSnapshot } from './runtime';
import { captureChatCompletionUsage, USAGE_CAPTURE_MARKER_FIELD } from './usage_capture';

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
// generateRaw 对未指定的采样参数默认使用 same_as_preset；这些字段必须显式隔离，
// 否则 SillyTavern 主 API 中不适用于当前服务商的值会泄漏进行动选项请求。
const INHERITED_REQUEST_BODY_FIELDS = [
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'repetition_penalty',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'logit_bias',
  'n',
];
const THINKING_BUDGET_TARGETS = {
  auto: 512,
  low: 256,
};
const CACHE_STATS_SUPPRESSED_NOTE = '缓存命中/未命中统计未读取，以避免与外部请求监控冲突';
export const MAX_FORMAT_RETRIES = 2;
const JSON_OUTPUT_INSTRUCTION = [
  '[最终输出协议]',
  '本协议覆盖其他提示中任何旧版 `<options>` 标签或 `|` 分隔输出要求。',
  '只输出一个合法 JSON 对象，不得使用 Markdown 代码块或附加解释。',
  'JSON 必须且只能包含 `options` 字段，其值必须是正好 8 项的非空字符串数组。',
  '单个选项内容不得包含换行、`|` 或 `<options>` 标签。',
  '固定结构：`{"options":["选项1","选项2","选项3","选项4","选项5","选项6","选项7","选项8"]}`。',
  '除输出载体外，其他内容、视角和槽位规则仍须满足。',
].join('\n');
const LEGACY_OUTPUT_INSTRUCTION_LINES = new Set([
  '在正文结尾生成8个选项，只能使用`<options></options>`包裹，选项间用|分隔，禁止换行。',
  '- 只能使用`<options></options>`标签包裹八个选项，禁止换行，禁止使用其他标签名',
  '1. 只能有一组 `<options>...</options>`。',
  '2. 标签内必须正好 8 个选项。',
  '3. 8 个选项必须用 `|` 分隔。',
  '4. 标签内禁止换行。',
  '5. 若还有更细的要求，也必须同时满足。',
  '现在请输出一组合法的<options>...</options>相关内容，不要输出任何多余内容。',
]);

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function resolveBaseUrl(settings: ScriptSettings): string {
  if (settings.api.provider === 'deepseek') {
    return DEEPSEEK_API_BASE_URL;
  }
  return settings.api.baseUrl;
}

function isOfficialOpenAiEndpoint(baseUrl: string): boolean {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function resolveProxyApiUrl(baseUrl: string): string {
  const trimmed = normalizeBaseUrl(baseUrl);
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed.replace(/\/chat\/completions$/, '');
  if (/\/v1\b/.test(trimmed)) {
    return trimmed.replace(/\/v1\b.*$/, '/v1');
  }
  return `${trimmed}/v1`;
}

function resolveModelListApiUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/chat\/completions$/, '');
}

function extractModelIds(payload: unknown): string[] {
  const candidates: unknown[] = [];
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) candidates.push(...record.data);
    if (Array.isArray(record.models)) candidates.push(...record.models);
  }
  if (Array.isArray(payload)) candidates.push(...payload);

  const ids = candidates
    .map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return String(record.id ?? record.name ?? record.model ?? '');
    })
    .map(item => item.trim())
    .filter(Boolean);

  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

function getTavernProxyApi() {
  const helper = typeof TavernHelper === 'undefined' ? null : TavernHelper;
  return {
    generateRaw: typeof helper?.generateRaw === 'function' ? helper.generateRaw.bind(helper) : null,
    getModelList: typeof helper?.getModelList === 'function' ? helper.getModelList.bind(helper) : null,
    stopGenerationById:
      typeof helper?.stopGenerationById === 'function' ? helper.stopGenerationById.bind(helper) : null,
  };
}

function createGenerationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `tlao-options-${randomId}`;
}

function stripReasoningBlocks(text: string): string {
  let next = String(text || '');
  let previous = '';
  const closedReasoningBlockPattern = /<\s*(thinking|think)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

  while (previous !== next) {
    previous = next;
    next = next.replace(closedReasoningBlockPattern, '');
  }

  return next
    .replace(/<\s*(thinking|think)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\s*\/\s*(thinking|think)\s*>/gi, '')
    .trim();
}

function buildThinkingParameters(settings: ScriptSettings): Record<string, unknown> {
  const { thinkingMode, reasoningEffort } = settings.api;
  const parameters: Record<string, unknown> = {};

  if (settings.api.provider === 'deepseek') {
    if (thinkingMode === 'enabled' || thinkingMode === 'disabled') {
      parameters.thinking = { type: thinkingMode };
    }
    if (thinkingMode !== 'disabled' && reasoningEffort !== 'auto') {
      parameters.reasoning_effort = reasoningEffort;
    }
  } else if (isOfficialOpenAiEndpoint(settings.api.baseUrl) && reasoningEffort !== 'auto') {
    parameters.reasoning_effort = reasoningEffort;
  }

  return parameters;
}

function buildThinkingInstruction(settings: ScriptSettings): string {
  const { thinkingMode, reasoningEffort } = settings.api;
  if (thinkingMode === 'disabled') {
    return [
      '[运行时思考控制]',
      '当前思考模式为关闭：不要展开隐藏推理，不要输出思考过程，直接根据输入完成任务。',
      '在完全满足剧情、世界观和输出规则的前提下，尽量少思考，快速生成合法的 JSON 结果。',
    ].join('\n');
  }

  // 高与最大档由服务商控制推理强度，避免额外的短思考提示抵消用户选择。
  const preferThoroughThinking = reasoningEffort === 'high' || reasoningEffort === 'max';
  const effortInstruction = preferThoroughThinking
    ? '充分核对各选项与前文事实、当前状态和角色动机是否一致，发现冲突时修正后再输出。'
    : [
        `内部思考预算上限为 ${THINKING_BUDGET_TARGETS[reasoningEffort]} tokens，严格控制在该上限以内，不进行冗余复盘、重复改写或无关分析。`,
        '在完全满足剧情、世界观和输出规则的前提下，尽量少思考，只保留完成当前 8 个选项所需的最短判断。',
      ].join('\n');
  const effortLabel = reasoningEffort === 'auto' ? '自动' : reasoningEffort === 'low' ? '低' : reasoningEffort === 'high' ? '高' : '最大';
  return [
    '[运行时思考控制]',
    `当前思考模式为${thinkingMode === 'enabled' ? '开启' : '自动'}，思考强度为${effortLabel}。`,
    effortInstruction,
    '思考结束后只输出合法的 JSON 对象，不要输出思考过程。',
  ].join('\n');
}

type UsageResultLike = {
  content: string;
  usage: unknown;
  model?: unknown;
};

function extractUsageResult(value: unknown): UsageResultLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.content !== 'string' || !('usage' in record)) return null;
  return {
    content: record.content,
    usage: record.usage,
    model: record.model,
  };
}

async function estimateTokenCount(text: string): Promise<number | null> {
  try {
    const tokenCounter =
      typeof SillyTavern !== 'undefined' && typeof SillyTavern.getTokenCountAsync === 'function'
        ? SillyTavern.getTokenCountAsync.bind(SillyTavern)
        : null;
    if (typeof tokenCounter !== 'function') return null;
    return await tokenCounter(text);
  } catch (error) {
    console.warn('[AI行动选项] 本地 Tokens 估算失败', error);
    return null;
  }
}

async function estimateDeepSeekUsage(
  settings: ScriptSettings,
  messages: ResolvedPromptMessage[],
  outputText: string,
  requestedAt: number,
  finishedAt: number,
): Promise<ReturnType<typeof buildDeepSeekUsageSnapshot>> {
  if (settings.api.provider !== 'deepseek') return null;
  const promptText = messages.map(message => `${message.role}\n${message.content}`).join('\n\n');
  const [promptTokens, completionTokens] = await Promise.all([
    estimateTokenCount(promptText),
    estimateTokenCount(outputText),
  ]);
  if (promptTokens == null && completionTokens == null) return null;
  return buildDeepSeekUsageSnapshot({
    model: settings.api.model,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
    requestedAt,
    finishedAt,
    estimated: true,
  });
}

function applyPlaceholders(template: string, context: GenerationContext): string {
  const worldbookNames = context.worldbookNames.length ? context.worldbookNames.join(', ') : '（未绑定）';
  const knowledgebookNames = context.knowledgebookNames.length ? context.knowledgebookNames.join(', ') : '（未填写）';
  // 固定标题在前、旧摘要按时间追加；动态计数留在后面的正文区，保留缓存可复用的前缀。
  const replacements: Record<string, string> = {
    latest_reply: context.latestReply,
    recent_ai_replies: context.recentAiRepliesText,
    recent_ai_reply_count: String(context.recentAiReplyCount),
    earlier_summaries: context.earlierSummariesText
      ? `[更早剧情摘要]\n${context.earlierSummariesText}\n`
      : '',
    knowledgebooks: context.knowledgebookText,
    knowledgebook_names: knowledgebookNames,
    worldbook: context.worldbookText,
    worldbook_names: worldbookNames,
  };
  // 回调替换只执行一次，避免摘要中的 $& 或模板占位符被当成替换语法再次展开。
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key: string) => replacements[key] ?? match);
}

function stripLegacyOutputInstructions(content: string): string {
  return content
    .split('\n')
    .filter(line => !LEGACY_OUTPUT_INSTRUCTION_LINES.has(line.trim()))
    .join('\n');
}

export async function fetchAvailableModels(settings: ScriptSettings): Promise<string[]> {
  const api = getTavernProxyApi();
  const getModelList = api.getModelList;
  if (!getModelList) {
    throw new Error('当前酒馆助手版本不支持后端获取模型列表，请更新酒馆助手后重试');
  }

  const apiurl = resolveModelListApiUrl(resolveBaseUrl(settings));
  if (!apiurl) throw new Error('请先填写 Base URL');
  if (!settings.api.apiKey) throw new Error('请先填写 API Key');

  const timeoutMs = Math.max(3000, Number(settings.api.timeoutMs) || 60000);
  const timeoutError = new Error(`模型列表请求超时（>${Math.round(timeoutMs / 1000)} 秒）`);
  let timer: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(timeoutError), timeoutMs);
  });

  try {
    const models = extractModelIds(
      await Promise.race([getModelList({ apiurl, key: settings.api.apiKey }), timeoutPromise]),
    );
    if (!models.length) {
      throw new Error('后端返回了模型列表，但没有找到可用的模型 ID');
    }
    return models;
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : String(error || '').trim();
    throw new Error(`后端获取模型列表失败${detail ? `：${detail}` : ''}`, { cause: error });
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function resolvePromptMessages(
  settings: ScriptSettings,
  context: GenerationContext,
): ResolvedPromptMessage[] {
  const messages = settings.promptMessages
    .filter(item => item.enabled && item.content.trim())
    .map(item => {
      // 输出协议属于 API 适配层；内置模板继续只维护内容规则。
      const replaced = stripLegacyOutputInstructions(applyPlaceholders(item.content, context));
      return {
        role: item.role,
        content: substitudeMacros(replaced),
      };
    })
    .filter(item => item.content.trim());

  if (!messages.length) return [];
  const firstNonSystemIndex = messages.findIndex(item => item.role !== 'system');
  const insertIndex = firstNonSystemIndex < 0 ? messages.length : firstNonSystemIndex;
  return [
    ...messages.slice(0, insertIndex),
    { role: 'system', content: buildThinkingInstruction(settings) },
    ...messages.slice(insertIndex),
    // 独立追加最终协议，使已保存的旧版自定义提示也能平滑切换到 JSON 输出。
    { role: 'system', content: JSON_OUTPUT_INSTRUCTION },
  ];
}

async function requestChatCompletion(settings: ScriptSettings, messages: ResolvedPromptMessage[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const apiurl = resolveProxyApiUrl(resolveBaseUrl(settings));
  if (!apiurl) throw new Error('请先填写 Base URL');
  if (!settings.api.apiKey) throw new Error('请先填写 API Key');
  if (!settings.api.model) throw new Error('请先填写模型名称');

  const api = getTavernProxyApi();
  const requestedAt = Date.now();

  setApiUsageSnapshot({
    status: 'running',
    requestedAt,
    finishedAt: null,
    model: settings.api.model,
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
    note: '正在请求模型...',
  });

  if (!api.generateRaw) {
    const message = '当前酒馆助手版本不支持后端代理，请更新酒馆助手后重试';
    setApiUsageSnapshot({ status: 'error', finishedAt: Date.now(), note: message });
    throw new Error(message);
  }

  const generationId = createGenerationId();
  const timeoutError = new Error(`API 请求超时（>${Math.round(settings.api.timeoutMs / 1000)} 秒）`);
  let timer: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      try {
        api.stopGenerationById?.(generationId);
      } catch {
        // 停止请求失败时仍返回超时结果。
      }
      reject(timeoutError);
    }, settings.api.timeoutMs);
  });

  let rejectCancellation: (reason: unknown) => void = () => {};
  const cancellationPromise = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => {
    // 只停止本次请求；即使宿主停止失败，本地也立即结束等待。
    rejectCancellation(signal?.reason ?? new DOMException('任务已取消', 'AbortError'));
    try {
      api.stopGenerationById?.(generationId);
    } catch (error) {
      console.warn('[AI行动选项] 停止过期请求失败', error);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const shouldCaptureUsage = settings.api.provider === 'deepseek';
    const customIncludeBody = {
      ...buildThinkingParameters(settings),
      ...(shouldCaptureUsage ? { [USAGE_CAPTURE_MARKER_FIELD]: generationId } : {}),
    };
    const customExcludeBody = [
      ...INHERITED_REQUEST_BODY_FIELDS,
      ...(shouldCaptureUsage ? [USAGE_CAPTURE_MARKER_FIELD] : []),
    ];
    const requestConfig = {
      generation_id: generationId,
      ordered_prompts: messages,
      should_silence: true,
      should_stream: false,
      // 新版 Tavern Helper 若支持该字段会返回 usage；旧版会忽略它并继续返回文本。
      should_return_usage: true,
      custom_api: {
        apiurl,
        key: settings.api.apiKey,
        model: settings.api.model,
        source: 'custom',
        temperature: settings.api.temperature,
        max_tokens: settings.api.maxTokens,
        frequency_penalty: 'unset',
        presence_penalty: 'unset',
        top_p: 'unset',
        top_k: 'unset',
        custom_include_body: customIncludeBody,
        custom_exclude_body: customExcludeBody,
        // 覆盖主 API 的自定义请求头，只保留行动选项当前 API Key 对应的标准鉴权头。
        custom_include_headers: { Authorization: `Bearer ${settings.api.apiKey}` },
      },
    } as Parameters<Exclude<typeof api.generateRaw, null>>[0];
    const executeRequest = () => Promise.race([api.generateRaw!(requestConfig), timeoutPromise, cancellationPromise]);
    const { result, capturedUsage, fetchHookSkipped } = shouldCaptureUsage
      ? await captureChatCompletionUsage(generationId, executeRequest)
      : { result: await executeRequest(), capturedUsage: null, fetchHookSkipped: false };

    signal?.throwIfAborted();
    const usageResult = extractUsageResult(result);
    if (typeof result !== 'string' && !usageResult) {
      throw new Error('后端代理返回了工具调用，无法生成行动选项');
    }

    const text = stripReasoningBlocks(usageResult?.content ?? String(result));
    if (!text) {
      throw new Error('后端代理返回内容为空');
    }

    const finishedAt = Date.now();
    const exactUsage = usageResult ?? capturedUsage;
    const usageSnapshot =
      settings.api.provider === 'deepseek' && exactUsage
        ? buildDeepSeekUsageSnapshot({
            model: String(exactUsage.model || settings.api.model),
            usage: exactUsage.usage,
            requestedAt,
            finishedAt,
          })
        : await estimateDeepSeekUsage(settings, messages, text, requestedAt, finishedAt);
    signal?.throwIfAborted();
    const cacheStatsSuppressed = shouldCaptureUsage && fetchHookSkipped;
    const usageSnapshotWithVisibility = usageSnapshot
      ? {
          ...usageSnapshot,
          cacheStatsSuppressed,
          ...(cacheStatsSuppressed ? { note: `${usageSnapshot.note ?? ''}；${CACHE_STATS_SUPPRESSED_NOTE}` } : {}),
        }
      : null;
    setApiUsageSnapshot(
      usageSnapshotWithVisibility ?? {
        status: 'success',
        requestedAt,
        finishedAt,
        model: settings.api.model,
        promptTokens: null,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        cacheStatsAvailable: false,
        cacheStatsSuppressed,
        completionTokens: null,
        totalTokens: null,
        hitRate: null,
        estimatedCostCny: null,
        pricingModel: null,
        pricingPeriod: null,
        note: cacheStatsSuppressed
          ? `已通过酒馆后端代理完成；${CACHE_STATS_SUPPRESSED_NOTE}`
          : '已通过酒馆后端代理完成；当前环境无法取得 Tokens',
      },
    );
    return text;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const detail = error === timeoutError ? timeoutError.message : (error as Error)?.message || '未知错误';
    const message = error === timeoutError ? detail : `后端代理请求失败：${detail}`;
    setApiUsageSnapshot({
      status: 'error',
      requestedAt,
      finishedAt: Date.now(),
      model: settings.api.model,
      note: message,
    });
    throw new Error(message, { cause: error });
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export type OptionsGenerationResult = {
  markup: string;
  retryCount: number;
};

export type OptionsFormatRetryInfo = {
  retryCount: number;
  maxRetries: number;
  reason: string;
};

export async function generateOptionsMarkup(
  settings: ScriptSettings,
  context: GenerationContext,
  onFormatRetry?: (info: OptionsFormatRetryInfo) => void,
  signal?: AbortSignal,
): Promise<OptionsGenerationResult> {
  const baseMessages = resolvePromptMessages(settings, context);
  if (!baseMessages.length) {
    throw new Error('请至少启用一条提示词消息');
  }

  let messages = baseMessages;
  let lastReason = '未知格式错误';

  for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt += 1) {
    signal?.throwIfAborted();
    const text = await requestChatCompletion(settings, messages, signal);
    signal?.throwIfAborted();
    const validation = validateOptionsJson(text);
    if (validation.ok) {
      return {
        markup: validation.normalizedMarkup,
        retryCount: attempt,
      };
    }

    lastReason = validation.reason;
    if (attempt === MAX_FORMAT_RETRIES) break;

    const retryCount = attempt + 1;
    onFormatRetry?.({ retryCount, maxRetries: MAX_FORMAT_RETRIES, reason: lastReason });
    messages = [
      ...baseMessages,
      {
        role: 'system' as const,
        content: [
          `第 ${retryCount} 次格式重试：上一轮输出不合格。`,
          `错误原因：${lastReason}`,
          '请只输出 `{"options":["选项1","选项2","选项3","选项4","选项5","选项6","选项7","选项8"]}` 结构的合法 JSON，不得输出代码块或任何解释。',
        ].join('\n'),
      },
    ];
  }

  throw new Error(`模型返回格式不合规（已静默重试 ${MAX_FORMAT_RETRIES} 次）：${lastReason}`);
}

export async function testApiConnection(settings: ScriptSettings): Promise<string> {
  const text = await requestChatCompletion(
    {
      ...settings,
      api: {
        ...settings.api,
        temperature: 0,
        maxTokens: Math.max(settings.api.maxTokens, 64),
      },
    },
    [
      {
        role: 'system',
        content: '你是 API 连通性测试器。只输出 OK。',
      },
      {
        role: 'user',
        content: '请只输出 OK。',
      },
    ],
  );

  return text.slice(0, 80);
}
