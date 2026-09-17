import { teleportStyle } from '@util/script';
import './index.scss';
import { generateOptionsMarkup, MAX_FORMAT_RETRIES } from './api';
import { cleanupManagedGlobalRegexes, syncManagedGlobalRegexes } from './global_regex';
import { appendOptionsBlock, hasTrailingOptionsBlock, stripTrailingOptionsBlock } from './options';
import { openSettingsPopup } from './popup';
import { getResolvedOptionPreset } from './custom_presets';
import { loadSettings, normalizeSummarySettings, saveSettings } from './settings';
import { cleanAssistantReplyForContext, readActionContext, stripReasoningBlocks } from './context';
import { getApiUsageSnapshot } from './runtime';
import { syncSettingsWithCurrentCharacterKnowledgeSource } from './character_source';
import type { CurrentCharacterKnowledgeSource } from './character_source';
import type { ApiUsageSnapshot, SummarySettings } from './types';
import { buildWorldbookContext } from './worldbooks';
import { checkForUpdates, restoreCachedUpdateState } from './update';

type GenerateReason = 'message_received' | 'message_swiped' | 'generation_ended' | 'manual';
type ChatMessageLike = Record<string, any>;
type ProgressTone = 'running' | 'success' | 'warning' | 'error';
type ProgressUsageSummary = {
  hitTokens: number | null;
  missTokens: number | null;
  hitRateText: string;
  priceText: string;
  pricingPeriod: ApiUsageSnapshot['pricingPeriod'];
  showCacheStats: boolean;
};
type ProgressDomRefs = {
  root: JQuery<HTMLElement>;
  title: JQuery<HTMLElement>;
  elapsed: JQuery<HTMLElement>;
  detail: JQuery<HTMLElement>;
  summary: JQuery<HTMLElement>;
  priceCard: JQuery<HTMLElement>;
  price: JQuery<HTMLElement>;
  pricingPeriod: JQuery<HTMLElement>;
  usage: JQuery<HTMLElement>;
  usageHit: JQuery<HTMLElement>;
  usageMiss: JQuery<HTMLElement>;
  usageRate: JQuery<HTMLElement>;
};

const PRICING_PERIOD_LABELS: Record<Exclude<ApiUsageSnapshot['pricingPeriod'], null>, string> = {
  'off-peak': '北京时间空闲时段',
  peak: '北京时间高峰时段',
};

const SCRIPT_LABEL = 'AI行动选项';
const BUTTON_SETTINGS = '行动选项设置';
const BUTTON_REGENERATE = '重生成行动选项';
const NOTICE_COOLDOWN_MS = 12_000;
const CHARACTER_SYNC_NOTICE_DELAY_MS = 320;
const PROGRESS_HIDE_DELAY_MS = 1800;
const PROGRESS_ERROR_HIDE_DELAY_MS = 4200;
const PROGRESS_SUCCESS_WITHOUT_CACHE_HIDE_DELAY_MS = 5000;
const PROGRESS_SUCCESS_WITH_CACHE_HIDE_DELAY_MS = 5600;
const AUTO_GENERATION_WINDOW_MS = 120_000;
const AUTO_MESSAGE_TYPES = new Set(['normal', 'regenerate', 'continue', 'swipe', 'append', 'appendFinal']);
const DISPLAYED_OPTIONS_CLASS = 'tlao-displayed-options';

const pendingTimers = new Map<number, number>();
const activeMessageIds = new Map<number, AbortController>();
let automationEpoch = 0;
const messageRevisions = new Map<number, number>();
const processedBaseTexts = new Map<number, string>();
const noticeTimestamps = new Map<string, number>();
let progressDomRefs: ProgressDomRefs | null = null;
let $noticeRoot: JQuery<HTMLElement> | null = null;
let progressRunId = 0;
let progressElapsedTicker: number | null = null;
let progressHideTimer: number | null = null;
let progressStartedAt = 0;
let noticeHideTimer: number | null = null;
let lastAllowedGeneration: { chatId: string; startedAt: number } | null = null;
let characterKnowledgeSyncTimer: number | null = null;
let lastCharacterKnowledgeSourceKey = '';
let hasInitializedCharacterKnowledgeSource = false;

function getChatApi() {
  const helper = (globalThis as any).TavernHelper;
  return {
    getChatMessages:
      typeof getChatMessages === 'function'
        ? getChatMessages
        : typeof helper?.getChatMessages === 'function'
          ? helper.getChatMessages.bind(helper)
          : null,
    setChatMessages:
      typeof setChatMessages === 'function'
        ? setChatMessages
        : typeof helper?.setChatMessages === 'function'
          ? helper.setChatMessages.bind(helper)
          : null,
    refreshOneMessage:
      typeof refreshOneMessage === 'function'
        ? refreshOneMessage
        : typeof helper?.refreshOneMessage === 'function'
          ? helper.refreshOneMessage.bind(helper)
          : null,
    getLastMessageId:
      typeof getLastMessageId === 'function'
        ? getLastMessageId
        : typeof helper?.getLastMessageId === 'function'
          ? helper.getLastMessageId.bind(helper)
          : null,
  };
}

function getCurrentChatIdSafe(): string {
  try {
    if (typeof SillyTavern?.getCurrentChatId === 'function') {
      return String(SillyTavern.getCurrentChatId() || '');
    }
    return String(SillyTavern?.chatId || '');
  } catch {
    return '';
  }
}

function isProcessableAiMessage(message: any): boolean {
  if (!message) return false;
  if (message.is_hidden === true) return false;
  if (message.is_system === true) return false;
  if (message.extra?.type === 'narrator') return false;

  const role = String(message.role || '').trim();
  if (role === 'user') return false;
  if (role === 'assistant') return true;

  if (typeof message.is_user === 'boolean') {
    return message.is_user === false;
  }

  return false;
}

function getMessageId(message: ChatMessageLike): number | null {
  const id = Number(message.message_id ?? message.mes_id ?? message.index);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function getMessageText(message: ChatMessageLike): string {
  return String(message.message ?? message.mes ?? message.content ?? '');
}

function getRawChatMessages(): ChatMessageLike[] {
  const chat = (globalThis as any).SillyTavern?.chat;
  return Array.isArray(chat) ? chat : [];
}

async function readChatMessages(range: string | number, options?: GetChatMessagesOption): Promise<ChatMessageLike[]> {
  const { getChatMessages } = getChatApi();
  if (typeof getChatMessages !== 'function') {
    return [];
  }

  try {
    const messages = await Promise.resolve(getChatMessages(range, options as any));
    return Array.isArray(messages) ? messages : [];
  } catch (error) {
    console.warn(`[${SCRIPT_LABEL}] 读取聊天消息失败`, error);
    return [];
  }
}

async function readLastMessageId(): Promise<number | null> {
  const { getLastMessageId } = getChatApi();
  if (typeof getLastMessageId === 'function') {
    try {
      const id = Number(await Promise.resolve(getLastMessageId()));
      if (Number.isInteger(id) && id >= 0) {
        return id;
      }
    } catch (error) {
      console.warn(`[${SCRIPT_LABEL}] 读取最新楼层号失败`, error);
    }
  }

  const latestMessages = await readChatMessages(-1, { include_swipes: false });
  const latest = latestMessages.at(-1);
  return latest ? getMessageId(latest) : null;
}

function refreshButtons(): void {
  replaceScriptButtons([
    { name: BUTTON_SETTINGS, visible: true },
    { name: BUTTON_REGENERATE, visible: true },
  ]);
}

function notify(
  level: 'error' | 'warning' | 'info' | 'success',
  message: string,
  throttleKey?: string,
  title?: string,
): void {
  if (throttleKey) {
    const now = Date.now();
    const last = noticeTimestamps.get(throttleKey) ?? 0;
    if (now - last < NOTICE_COOLDOWN_MS) {
      return;
    }
    noticeTimestamps.set(throttleKey, now);
  }
  showNotice(level, message, title);
}

function clearNoticeHideTimer(): void {
  if (noticeHideTimer == null) return;
  window.clearTimeout(noticeHideTimer);
  noticeHideTimer = null;
}

function ensureNoticeRoot(): JQuery<HTMLElement> {
  if ($noticeRoot?.length) return $noticeRoot;

  $noticeRoot = $(`
    <div class="tlao-notice-root" role="status" aria-live="polite" aria-atomic="true">
      <div class="tlao-notice-head">
        <span class="tlao-notice-icon fa-solid fa-circle-info" aria-hidden="true"></span>
        <span class="tlao-notice-title">提示</span>
        <button type="button" class="tlao-notice-close" aria-label="关闭提示" title="关闭">
          <span class="fa-solid fa-xmark" aria-hidden="true"></span>
        </button>
      </div>
      <div class="tlao-notice-detail"></div>
    </div>
  `).appendTo('body');

  $noticeRoot.find('.tlao-notice-close').on('click', () => {
    dismissNotice();
  });

  return $noticeRoot;
}

function dismissNotice(): void {
  clearNoticeHideTimer();
  $noticeRoot?.removeClass('is-visible');
}

function showNotice(level: 'error' | 'warning' | 'info' | 'success', message: string, title?: string): void {
  const titleMap: Record<typeof level, string> = {
    error: '生成失败',
    warning: '注意',
    info: '提示',
    success: '已完成',
  };
  const iconMap: Record<typeof level, string> = {
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
    success: 'fa-circle-check',
  };
  const hideDelay = level === 'error' ? 9200 : 4800;
  const $root = ensureNoticeRoot();

  clearNoticeHideTimer();
  $root.removeClass('is-error is-warning is-info is-success').addClass(`is-${level}`).addClass('is-visible');
  $root.find('.tlao-notice-title').text(title || titleMap[level]);
  $root.find('.tlao-notice-icon').attr('class', `tlao-notice-icon fa-solid ${iconMap[level]}`);
  $root.find('.tlao-notice-detail').text(message);

  noticeHideTimer = window.setTimeout(() => {
    dismissNotice();
  }, hideDelay);
}

function appendDisplayedOptionsWithoutMessageRefresh(messageId: number, optionsMarkup: string): boolean {
  try {
    if (typeof retrieveDisplayedMessage !== 'function' || typeof formatAsDisplayedMessage !== 'function') {
      return false;
    }

    const $message = retrieveDisplayedMessage(messageId);
    if (!$message.length) {
      return true;
    }

    const renderedOptions = formatAsDisplayedMessage(optionsMarkup, { message_id: messageId });
    const $options = $('<div>').addClass(DISPLAYED_OPTIONS_CLASS).html(renderedOptions);
    $message.children(`.${DISPLAYED_OPTIONS_CLASS}`).remove();
    $message.append($options);
    return true;
  } catch (error) {
    console.warn(`[${SCRIPT_LABEL}] 增量更新行动选项显示失败，将回退到楼层刷新`, error);
    return false;
  }
}

async function refreshDisplayedMessageForRender(messageId: number): Promise<boolean> {
  const { refreshOneMessage } = getChatApi();
  if (typeof refreshOneMessage !== 'function') return false;

  try {
    await refreshOneMessage(messageId);
    return true;
  } catch (error) {
    console.warn(`[${SCRIPT_LABEL}] 单楼层刷新失败，将回退到 affected 刷新`, error);
    return false;
  }
}

async function collectRecentAssistantReplies(targetMessageId: number, count: number, summary?: SummarySettings) {
  return readActionContext(targetMessageId, count, normalizeSummarySettings(summary));
}

async function findLatestAssistantMessageId(): Promise<number | null> {
  const rawMessages = getRawChatMessages();
  for (let index = rawMessages.length - 1; index > 0; index -= 1) {
    if (isProcessableAiMessage(rawMessages[index])) {
      return index;
    }
  }

  const displayedMessageId = $('#chat .mes')
    .toArray()
    .reverse()
    .map(element => {
      const $message = $(element);
      const id = Number($message.attr('mesid') ?? $message.attr('data-message-id') ?? $message.data('messageId'));
      if (!Number.isInteger(id) || id <= 0) return null;
      if ($message.hasClass('is_user') || $message.hasClass('is_system') || $message.hasClass('system')) return null;
      return id;
    })
    .find((id): id is number => id != null);
  if (displayedMessageId != null) {
    return displayedMessageId;
  }

  let messages = await readChatMessages('0-{{lastMessageId}}', { include_swipes: false, hide_state: 'unhidden' });
  if (!messages.length) {
    const lastMessageId = await readLastMessageId();
    if (lastMessageId == null) return null;
    messages = await readChatMessages(`0-${lastMessageId}`, { include_swipes: false, hide_state: 'unhidden' });
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isProcessableAiMessage(message)) {
      const id = getMessageId(message);
      if (id != null && id > 0) return id;
    }
  }
  return null;
}

function clearProgressHideTimer(): void {
  if (progressHideTimer == null) return;
  window.clearTimeout(progressHideTimer);
  progressHideTimer = null;
}

function ensureProgressRoot(): ProgressDomRefs {
  if (progressDomRefs?.root.length) return progressDomRefs;

  const $root = $(`
    <div class="tlao-progress-root" role="status" aria-live="polite" aria-atomic="true">
      <div class="tlao-progress-head">
        <span class="tlao-progress-icon fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span>
        <span class="tlao-progress-title"></span>
        <span class="tlao-progress-elapsed">00:00.00</span>
        <button type="button" class="tlao-progress-close" aria-label="关闭进度提示" title="关闭">
          <span class="fa-solid fa-xmark" aria-hidden="true"></span>
        </button>
      </div>
      <div class="tlao-progress-summary">
        <div class="tlao-progress-detail"></div>
        <div class="tlao-progress-usage-card tlao-progress-usage-price-card" hidden>
          <div class="tlao-progress-price-meta">
            <span class="muted">价格估算（CNY）</span>
            <span class="tlao-progress-pricing-period">估算</span>
          </div>
          <strong class="tlao-progress-usage-price">--</strong>
        </div>
      </div>
      <div class="tlao-progress-usage" hidden>
        <div class="tlao-progress-usage-card">
          <span class="muted">命中 Tokens</span>
          <strong class="tlao-progress-usage-hit">--</strong>
        </div>
        <div class="tlao-progress-usage-card">
          <span class="muted">未命中 Tokens</span>
          <strong class="tlao-progress-usage-miss">--</strong>
        </div>
        <div class="tlao-progress-usage-card">
          <span class="muted">命中率</span>
          <strong class="tlao-progress-usage-rate">--</strong>
        </div>
      </div>
    </div>
  `).appendTo('body');
  const find = (selector: string): JQuery<HTMLElement> => $root.find<HTMLElement>(selector);
  progressDomRefs = {
    root: $root,
    title: find('.tlao-progress-title'),
    elapsed: find('.tlao-progress-elapsed'),
    detail: find('.tlao-progress-detail'),
    summary: find('.tlao-progress-summary'),
    priceCard: find('.tlao-progress-usage-price-card'),
    price: find('.tlao-progress-usage-price'),
    pricingPeriod: find('.tlao-progress-pricing-period'),
    usage: find('.tlao-progress-usage'),
    usageHit: find('.tlao-progress-usage-hit'),
    usageMiss: find('.tlao-progress-usage-miss'),
    usageRate: find('.tlao-progress-usage-rate'),
  };
  $root.find('.tlao-progress-close').on('click', () => {
    dismissProgress(true);
  });

  return progressDomRefs;
}

function formatElapsedTime(totalMilliseconds: number): string {
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((totalMilliseconds % 1000) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function stopProgressElapsedTicker(): void {
  if (progressElapsedTicker == null) return;
  window.clearInterval(progressElapsedTicker);
  progressElapsedTicker = null;
}

function startProgressElapsedTicker(): void {
  stopProgressElapsedTicker();
  progressStartedAt = Date.now();
  progressDomRefs?.elapsed.text('00:00.00');
  // 后台标签页跳过 DOM 写入；重新可见后会按真实开始时间自动追平。
  progressElapsedTicker = window.setInterval(() => {
    if (document.hidden) return;
    progressDomRefs?.elapsed.text(formatElapsedTime(Date.now() - progressStartedAt));
  }, 100);
}

function dismissProgress(cancelCurrent = false): void {
  clearProgressHideTimer();
  stopProgressElapsedTicker();
  if (cancelCurrent) {
    progressRunId += 1;
  }
  progressDomRefs?.root.removeClass('is-visible');
}

function isProgressVisible(): boolean {
  return progressDomRefs?.root.hasClass('is-visible') === true || $('.tlao-progress-root.is-visible').length > 0;
}

function notifySettingsSaved(): void {
  if (isProgressVisible()) return;
  notify('success', '脚本设置已自动保存');
}

function updateProgress(
  runId: number,
  value: number,
  title: string,
  detail = '',
  tone: ProgressTone = 'running',
  usageSummary?: ProgressUsageSummary | null,
): void {
  if (runId !== progressRunId) return;
  void value;

  const refs = ensureProgressRoot();
  refs.root
    .removeClass('is-success is-warning is-error')
    .toggleClass('is-success', tone === 'success')
    .toggleClass('is-warning', tone === 'warning')
    .toggleClass('is-error', tone === 'error')
    .addClass('is-visible');
  refs.title.text(title);
  refs.detail.text(detail);
  if (usageSummary) {
    refs.usage.prop('hidden', !usageSummary.showCacheStats).toggle(usageSummary.showCacheStats);
    refs.usageHit.text(usageSummary.hitTokens?.toLocaleString('zh-CN') ?? '--');
    refs.usageMiss.text(usageSummary.missTokens?.toLocaleString('zh-CN') ?? '--');
    refs.usageRate.text(usageSummary.hitRateText);
    refs.price.text(usageSummary.priceText);
    const hasPrice = usageSummary.priceText !== '--';
    const period = usageSummary.pricingPeriod;
    const periodLabel = period ? PRICING_PERIOD_LABELS[period] : null;
    refs.pricingPeriod
      .text(periodLabel ? `${periodLabel}•估算` : '估算')
      .removeClass('is-peak is-off-peak')
      .toggleClass('is-peak', period === 'peak')
      .toggleClass('is-off-peak', period === 'off-peak');
    refs.summary.toggleClass('has-price', hasPrice);
    refs.priceCard.prop('hidden', !hasPrice).toggle(hasPrice);
  } else {
    refs.usage.prop('hidden', true).hide();
    refs.summary.removeClass('has-price');
    refs.priceCard.prop('hidden', true).hide();
  }
}

function startProgress(title: string, detail = ''): number {
  dismissNotice();
  clearProgressHideTimer();
  stopProgressElapsedTicker();
  progressRunId += 1;
  updateProgress(progressRunId, 0, title, detail);
  startProgressElapsedTicker();
  return progressRunId;
}

function buildGenerationProgressDetail(
  optionPresetName: string,
  knowledgeSummary: string,
  configuredReplyCount: number,
  actualReplyCount: number,
): string {
  return `模板「${optionPresetName}」\n${knowledgeSummary} · AI 回复 ${actualReplyCount}/${configuredReplyCount} 层`;
}

function finishProgress(
  runId: number,
  tone: Exclude<ProgressTone, 'running'>,
  title: string,
  detail = '',
  usageSummary?: ProgressUsageSummary | null,
): void {
  if (runId !== progressRunId) return;
  stopProgressElapsedTicker();
  progressDomRefs?.elapsed.text(formatElapsedTime(Date.now() - progressStartedAt));
  updateProgress(runId, 0, title, detail, tone, usageSummary);
  const hideDelay =
    tone === 'error'
      ? PROGRESS_ERROR_HIDE_DELAY_MS
      : tone === 'success'
        ? usageSummary
          ? PROGRESS_SUCCESS_WITH_CACHE_HIDE_DELAY_MS
          : PROGRESS_SUCCESS_WITHOUT_CACHE_HIDE_DELAY_MS
        : PROGRESS_HIDE_DELAY_MS;
  progressHideTimer = window.setTimeout(() => {
    if (runId !== progressRunId) return;
    dismissProgress(false);
  }, hideDelay);
}

function getProgressUsageSummary(): ProgressUsageSummary | null {
  const snapshot = getApiUsageSnapshot();
  if (snapshot.status !== 'success') return null;
  if (snapshot.estimatedCostCny == null) return null;
  const roundedPrice = Math.round((snapshot.estimatedCostCny + Number.EPSILON) * 1000) / 1000;
  return {
    hitTokens: snapshot.promptCacheHitTokens,
    missTokens: snapshot.promptCacheMissTokens,
    hitRateText:
      snapshot.hitRate == null ? '--' : `${(snapshot.hitRate * 100).toFixed(snapshot.hitRate >= 0.1 ? 1 : 2)}%`,
    priceText: `¥${roundedPrice.toFixed(3)}`,
    pricingPeriod: snapshot.pricingPeriod,
    showCacheStats: snapshot.cacheStatsAvailable && !snapshot.cacheStatsSuppressed,
  };
}

function destroyProgressRoot(): void {
  stopProgressElapsedTicker();
  clearProgressHideTimer();
  progressDomRefs?.root.remove();
  progressDomRefs = null;
}

function destroyNoticeRoot(): void {
  clearNoticeHideTimer();
  $noticeRoot?.remove();
  $noticeRoot = null;
}

async function generateAndAppendOptions(...args: Parameters<typeof runGenerateAndAppendOptions>): Promise<void> {
  const epoch = automationEpoch;
  try {
    await runGenerateAndAppendOptions(...args);
  } catch (error) {
    console.error(`[${SCRIPT_LABEL}] 准备生成失败`, error);
    if (epoch === automationEpoch) {
      const progressId = args[2] ?? startProgress('生成行动选项', '');
      finishProgress(progressId, 'error', '生成行动选项失败', (error as Error)?.message || '未知错误');
    }
  }
}

async function runGenerateAndAppendOptions(
  messageId: number,
  reason: GenerateReason,
  existingProgressRunId?: number,
  expectedChatId = getCurrentChatIdSafe(),
): Promise<void> {
  const epoch = automationEpoch;
  const revision = messageRevisions.get(messageId) ?? 0;
  const loadedSettings = await loadSettings();
  if (epoch !== automationEpoch) return;
  const syncedSettingsResult = await syncSettingsWithCurrentCharacterKnowledgeSource(loadedSettings);
  if (epoch !== automationEpoch) return;
  let settings = syncedSettingsResult.settings;
  const characterKnowledgeSource = syncedSettingsResult.source;
  if (syncedSettingsResult.changed) {
    settings = await saveSettings(settings);
  }
  const isManual = reason === 'manual';
  if (!settings.enabled && !isManual) {
    return;
  }
  const isChatStillCurrent = (): boolean =>
    epoch === automationEpoch &&
    revision === (messageRevisions.get(messageId) ?? 0) &&
    (!expectedChatId || getCurrentChatIdSafe() === expectedChatId);
  if (!isChatStillCurrent()) {
    return;
  }

  const sourceMessage = (await readChatMessages(messageId, { include_swipes: false }))[0];
  if (!isProcessableAiMessage(sourceMessage) || getMessageId(sourceMessage) !== messageId) {
    if (isManual) {
      const progressId = existingProgressRunId ?? startProgress('重生成行动选项', `目标楼层：${messageId}`);
      finishProgress(progressId, 'warning', '未找到可处理楼层', '请确认当前聊天已有 AI 回复');
    }
    return;
  }

  if (!isChatStillCurrent()) return;
  const sourceSwipeId = sourceMessage.swipe_id;
  const sourceMessageText = getMessageText(sourceMessage);
  const latestReply = stripTrailingOptionsBlock(sourceMessageText);
  const trimmedReply = stripReasoningBlocks(latestReply).trim();
  if (!trimmedReply) {
    if (isManual) {
      const progressId = existingProgressRunId ?? startProgress('重生成行动选项', `目标楼层：${messageId}`);
      finishProgress(progressId, 'warning', '楼层正文为空', '最新 AI 楼层没有可用于生成的非思维链正文');
    }
    return;
  }

  if (!isManual && hasTrailingOptionsBlock(sourceMessageText)) {
    processedBaseTexts.set(messageId, trimmedReply);
    return;
  }

  if (!isManual && processedBaseTexts.get(messageId) === trimmedReply) {
    return;
  }

  if (activeMessageIds.has(messageId)) {
    const progressId =
      existingProgressRunId ?? (isManual ? startProgress('重生成行动选项', `目标楼层：${messageId}`) : null);
    if (progressId != null) {
      finishProgress(progressId, 'warning', '已有生成任务进行中', `楼层 ${messageId} 正在处理`);
    }
    return;
  }

  const progressId =
    existingProgressRunId ?? startProgress(isManual ? '重生成行动选项' : '自动生成行动选项', `目标楼层：${messageId}`);
  updateProgress(progressId, 10, '读取最新楼层', `目标楼层：${messageId}`);

  if ((!settings.api.baseUrl && settings.api.provider !== 'deepseek') || !settings.api.apiKey || !settings.api.model) {
    finishProgress(
      progressId,
      'warning',
      '缺少 API 配置',
      settings.api.provider === 'deepseek' ? '请先补全 API Key 和模型' : '请先补全 Base URL、API Key 和模型',
    );
    return;
  }

  const controller = new AbortController();
  activeMessageIds.set(messageId, controller);
  try {
    const optionPreset = getResolvedOptionPreset(settings.optionPresetId, settings.customOptionPresets);
    updateProgress(progressId, 28, '读取资料源', `正在整理内置模板「${optionPreset.name}」与附加世界书`);
    const worldbookContext = {
      worldbookNames: [optionPreset.name],
      worldbookText: optionPreset.prompt,
      missingWorldbooks: [],
      selectedEntryCount: 1,
    };
    const worldbookKnowledgeContext = await buildWorldbookContext(
      settings.boundKnowledgeWorldbooks,
      settings.knowledgeWorldbookEntrySelections,
    );
    const knowledgebookContext =
      worldbookKnowledgeContext.worldbookText || characterKnowledgeSource.mode !== 'description'
        ? worldbookKnowledgeContext
        : {
            worldbookNames: [
              characterKnowledgeSource.characterName
                ? `${characterKnowledgeSource.characterName}·角色描述`
                : '当前角色卡·角色描述',
            ],
            worldbookText: [
              `# 角色描述${characterKnowledgeSource.characterName ? `：${characterKnowledgeSource.characterName}` : ''}`,
              characterKnowledgeSource.description,
            ].join('\n'),
            missingWorldbooks: [],
            selectedEntryCount: 1,
          };
    if (knowledgebookContext.missingWorldbooks.length) {
      notify(
        'warning',
        `以下附加世界书读取失败：${knowledgebookContext.missingWorldbooks.join('、')}`,
        `missing-knowledgebook:${knowledgebookContext.missingWorldbooks.join('|')}`,
      );
    }

    if (!worldbookContext.worldbookText) {
      throw new Error('当前内置选项模板内容为空');
    }

    const recentRepliesContext = await collectRecentAssistantReplies(
      messageId,
      settings.assistantContextCount,
      settings.summary,
    );
    const fallbackLatestReply = cleanAssistantReplyForContext(latestReply) || trimmedReply;
    const effectiveRepliesContext =
      recentRepliesContext && recentRepliesContext.latestReply.trim()
        ? recentRepliesContext
        : {
            latestReply: fallbackLatestReply,
            recentAiRepliesText: `[AI 回复楼层 #${messageId}]\n${fallbackLatestReply}`,
            recentAiReplyCount: 1,
            earlierSummariesText: '',
            summary: { entries: [], missingIds: [], notes: [] },
          };

    const generationProgressBaseDetail = buildGenerationProgressDetail(
      optionPreset.name,
      characterKnowledgeSource.mode === 'worldbooks'
        ? `角色世界书 ${knowledgebookContext.selectedEntryCount} 条`
        : characterKnowledgeSource.mode === 'description'
          ? '角色描述'
          : '无额外角色资料',
      settings.assistantContextCount,
      effectiveRepliesContext.recentAiReplyCount,
    );
    const summaryCount = new Set(effectiveRepliesContext.summary.entries.map(item => item.id)).size;
    const summaryDetail =
      settings.summary?.mode && settings.summary.mode !== 'off'
        ? ` · 更早摘要 ${summaryCount} 层${effectiveRepliesContext.summary.missingIds.length ? `（缺少 ${effectiveRepliesContext.summary.missingIds.length} 层）` : ''}`
        : '';
    if (effectiveRepliesContext.summary.notes.length) {
      console.warn(`[${SCRIPT_LABEL}] 摘要读取提示:`, effectiveRepliesContext.summary.notes.join('；'));
    }
    const generationProgressDetail = `${generationProgressBaseDetail}${summaryDetail}\n等待外接 API 返回 · 格式重试 0/${MAX_FORMAT_RETRIES}`;
    updateProgress(progressId, 46, '模型生成中', generationProgressDetail);
    if (!isChatStillCurrent() || controller.signal.aborted) return;
    const generationResult = await generateOptionsMarkup(
      settings,
      {
        latestReply: effectiveRepliesContext.latestReply,
        recentAiRepliesText: effectiveRepliesContext.recentAiRepliesText,
        recentAiReplyCount: effectiveRepliesContext.recentAiReplyCount,
        earlierSummariesText: effectiveRepliesContext.earlierSummariesText,
        worldbookText: worldbookContext.worldbookText,
        worldbookNames: worldbookContext.worldbookNames,
        knowledgebookText: knowledgebookContext.worldbookText,
        knowledgebookNames: knowledgebookContext.worldbookNames,
      },
      ({ retryCount, maxRetries }) => {
        const retryDetail = `${generationProgressBaseDetail}${summaryDetail}\n等待外接 API 返回 · 格式重试 ${retryCount}/${maxRetries}`;
        updateProgress(progressId, 56, '模型生成中', retryDetail);
      },
      controller.signal,
    );
    const optionsMarkup = generationResult.markup;

    if (!isChatStillCurrent() || controller.signal.aborted) {
      finishProgress(progressId, 'warning', '聊天已切换', '已取消写入旧聊天楼层');
      return;
    }

    const { setChatMessages } = getChatApi();
    if (typeof setChatMessages !== 'function') {
      throw new Error('当前环境缺少聊天消息读写接口');
    }

    updateProgress(progressId, 90, '写入最新楼层', '正在替换楼层末尾 options');
    const currentMessage = (await readChatMessages(messageId, { include_swipes: false }))[0];
    if (getMessageId(currentMessage) !== messageId || !isProcessableAiMessage(currentMessage)) {
      finishProgress(progressId, 'warning', '楼层状态已变化', '目标楼层不再是可处理的 AI 回复');
      return;
    }

    const currentMessageText = getMessageText(currentMessage);
    // 楼层号不会区分 swipe；正文和任务代次也必须保持不变才能提交。
    if (
      !isChatStillCurrent() ||
      controller.signal.aborted ||
      currentMessage.swipe_id !== sourceSwipeId ||
      currentMessageText !== sourceMessageText
    ) {
      finishProgress(progressId, 'warning', '楼层状态已变化', '已取消写入');
      return;
    }
    const nextMessage = appendOptionsBlock(currentMessageText, optionsMarkup);
    const canIncrementallyRender = !isManual && !hasTrailingOptionsBlock(currentMessageText);

    if (canIncrementallyRender) {
      await setChatMessages([{ message_id: messageId, message: nextMessage }], { refresh: 'none' });
      if (!isChatStillCurrent() || controller.signal.aborted) return;
      const appendedToDisplayedMessage = appendDisplayedOptionsWithoutMessageRefresh(messageId, optionsMarkup);
      if (!appendedToDisplayedMessage || !(await refreshDisplayedMessageForRender(messageId))) {
        if (!isChatStillCurrent() || controller.signal.aborted) return;
        await setChatMessages([{ message_id: messageId }], { refresh: 'affected' });
      }
    } else {
      await setChatMessages([{ message_id: messageId, message: nextMessage }], { refresh: 'affected' });
    }

    if (!isChatStillCurrent() || controller.signal.aborted) return;
    processedBaseTexts.set(messageId, trimmedReply);
    const shouldShowCacheUsage = settings.showCacheUsageInSuccessPopup;
    const usageSnapshot = getApiUsageSnapshot();
    // 缓存统计被抑制时把原因并入成功详情，避免成功结果再弹出独立警告。
    const cacheUsageSuppressedNotice =
      shouldShowCacheUsage && usageSnapshot.cacheStatsSuppressed
        ? '缓存命中/未命中数据未显示：检测到外部请求监控，为避免请求拦截冲突，本次跳过临时用量捕获'
        : '';
    const successDetail = cacheUsageSuppressedNotice
      ? `已写入楼层 ${messageId} · 格式重试 ${generationResult.retryCount} 次 · ${cacheUsageSuppressedNotice}`
      : `已写入楼层 ${messageId} · 格式重试 ${generationResult.retryCount} 次`;
    finishProgress(
      progressId,
      'success',
      '行动选项已生成',
      successDetail,
      shouldShowCacheUsage ? getProgressUsageSummary() : null,
    );
  } catch (error) {
    if (controller.signal.aborted || !isChatStillCurrent()) return;
    finishProgress(progressId, 'error', '生成行动选项失败', (error as Error)?.message || '未知错误');
    console.error(`[${SCRIPT_LABEL}] 生成失败`, error);
  } finally {
    if (controller.signal.aborted && epoch === automationEpoch) {
      finishProgress(progressId, 'warning', '楼层状态已变化', '已取消写入');
    }
    // 旧任务结束不能移除同楼层后来启动的新任务。
    if (activeMessageIds.get(messageId) === controller) activeMessageIds.delete(messageId);
  }
}

function clearPendingTimer(messageId: number): void {
  const timer = pendingTimers.get(messageId);
  if (timer == null) return;
  window.clearTimeout(timer);
  pendingTimers.delete(messageId);
}

function scheduleGenerate(messageId: number, reason: Exclude<GenerateReason, 'manual'>): void {
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  clearPendingTimer(messageId);
  const expectedChatId = getCurrentChatIdSafe();

  const timer = window.setTimeout(() => {
    pendingTimers.delete(messageId);
    if (expectedChatId && getCurrentChatIdSafe() !== expectedChatId) return;
    void generateAndAppendOptions(messageId, reason, undefined, expectedChatId);
  }, 180);

  pendingTimers.set(messageId, timer);
}

function isAllowedAutoMessageType(type: unknown): boolean {
  return AUTO_MESSAGE_TYPES.has(String(type || ''));
}

function shouldHandleGenerationEnded(messageId: number): boolean {
  if (!Number.isFinite(messageId) || messageId <= 0) return false;
  if (!lastAllowedGeneration) return false;
  if (Date.now() - lastAllowedGeneration.startedAt > AUTO_GENERATION_WINDOW_MS) return false;
  return !lastAllowedGeneration.chatId || getCurrentChatIdSafe() === lastAllowedGeneration.chatId;
}

function cancelMessageGeneration(messageId: number): void {
  messageRevisions.set(messageId, (messageRevisions.get(messageId) ?? 0) + 1);
  clearPendingTimer(messageId);
  activeMessageIds.get(messageId)?.abort();
  activeMessageIds.delete(messageId);
  processedBaseTexts.delete(messageId);
}

function clearAutomationRuntime(): void {
  automationEpoch += 1;
  messageRevisions.clear();
  activeMessageIds.forEach(controller => controller.abort());
  pendingTimers.forEach(timer => window.clearTimeout(timer));
  pendingTimers.clear();
  activeMessageIds.clear();
  processedBaseTexts.clear();
  lastAllowedGeneration = null;
}

function clearCharacterKnowledgeSyncTimer(): void {
  if (characterKnowledgeSyncTimer == null) return;
  window.clearTimeout(characterKnowledgeSyncTimer);
  characterKnowledgeSyncTimer = null;
}

function buildCharacterKnowledgeSourceKey(source: CurrentCharacterKnowledgeSource): string {
  return JSON.stringify({
    characterName: source.characterName,
    mode: source.mode,
    worldbookNames: source.worldbookNames,
    description: source.mode === 'description' ? source.description : '',
  });
}

async function buildCharacterKnowledgeSyncNotice(
  source: CurrentCharacterKnowledgeSource,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<{ level: 'success' | 'error'; message: string }> {
  const characterLabel = source.characterName ? `角色卡「${source.characterName}」` : '当前角色卡';

  if (source.mode === 'worldbooks') {
    const context = await buildWorldbookContext(
      settings.boundKnowledgeWorldbooks,
      settings.knowledgeWorldbookEntrySelections,
    );

    if (context.missingWorldbooks.length) {
      const message =
        context.selectedEntryCount > 0
          ? `${characterLabel}已读取 ${context.selectedEntryCount} 条，但以下世界书读取失败：${context.missingWorldbooks.join('、')}。请打开设置手动检查并勾选需要的条目。`
          : `${characterLabel}的世界书读取失败：${context.missingWorldbooks.join('、')}。请打开设置手动检查并勾选需要的条目。`;
      return {
        level: 'error',
        message,
      };
    }

    if (!context.worldbookText || context.selectedEntryCount <= 0) {
      return {
        level: 'error',
        message: `${characterLabel}的世界书未读取到可用条目。请打开设置手动检查并勾选需要的条目。`,
      };
    }

    return {
      level: 'success',
      message: `行动选项脚本已同步 ${characterLabel}世界书：${context.worldbookNames.length} 本，${context.selectedEntryCount} 条。`,
    };
  }

  if (source.mode === 'description' && source.description.trim()) {
    return {
      level: 'success',
      message: `行动选项脚本检测到 ${characterLabel}未绑定世界书，已自动读取角色描述。`,
    };
  }

  return {
    level: 'error',
    message: `行动选项脚本未从 ${characterLabel}读取到世界书或角色描述。请打开设置手动检查并勾选需要的条目。`,
  };
}

async function syncCurrentCharacterKnowledgeSourceToStoredSettings(options?: {
  notifyOnCharacterSwitch?: boolean;
}): Promise<void> {
  const notifyOnCharacterSwitch = Boolean(options?.notifyOnCharacterSwitch);

  try {
    const loadedSettings = await loadSettings();
    const syncedSettingsResult = await syncSettingsWithCurrentCharacterKnowledgeSource(loadedSettings);
    const nextSourceKey = buildCharacterKnowledgeSourceKey(syncedSettingsResult.source);
    const shouldNotify =
      notifyOnCharacterSwitch &&
      hasInitializedCharacterKnowledgeSource &&
      lastCharacterKnowledgeSourceKey !== nextSourceKey;

    if (!syncedSettingsResult.changed) {
      lastCharacterKnowledgeSourceKey = nextSourceKey;
      hasInitializedCharacterKnowledgeSource = true;

      if (shouldNotify) {
        const resultNotice = await buildCharacterKnowledgeSyncNotice(
          syncedSettingsResult.source,
          syncedSettingsResult.settings,
        );
        notify(
          resultNotice.level,
          resultNotice.message,
          undefined,
          resultNotice.level === 'success' ? '行动选项脚本已同步角色资料' : '行动选项脚本同步角色资料失败',
        );
      }
      return;
    }

    await saveSettings(syncedSettingsResult.settings);
    lastCharacterKnowledgeSourceKey = nextSourceKey;
    hasInitializedCharacterKnowledgeSource = true;

    if (shouldNotify) {
      const resultNotice = await buildCharacterKnowledgeSyncNotice(
        syncedSettingsResult.source,
        syncedSettingsResult.settings,
      );
      notify(
        resultNotice.level,
        resultNotice.message,
        undefined,
        resultNotice.level === 'success' ? '行动选项脚本已同步角色资料' : '行动选项脚本同步角色资料失败',
      );
    }
  } catch (error) {
    console.warn(`[${SCRIPT_LABEL}] 同步当前角色卡补充资料失败`, error);

    if (notifyOnCharacterSwitch && hasInitializedCharacterKnowledgeSource) {
      notify(
        'error',
        `行动选项脚本同步当前角色卡补充资料失败：${(error as Error)?.message || '未知错误'}。请打开设置手动检查并勾选需要的条目。`,
        undefined,
        '行动选项脚本同步角色资料失败',
      );
    }
  }
}

function scheduleCurrentCharacterKnowledgeSourceSync(notifyOnCharacterSwitch: boolean): void {
  clearCharacterKnowledgeSyncTimer();
  characterKnowledgeSyncTimer = window.setTimeout(() => {
    characterKnowledgeSyncTimer = null;
    void syncCurrentCharacterKnowledgeSourceToStoredSettings({ notifyOnCharacterSwitch });
  }, CHARACTER_SYNC_NOTICE_DELAY_MS);
}

async function applyManagedGlobalRegexes(settings: Awaited<ReturnType<typeof loadSettings>>): Promise<void> {
  try {
    await syncManagedGlobalRegexes(settings);
  } catch (error) {
    console.error(`[${SCRIPT_LABEL}] 同步全局正则失败`, error);
    notify('error', `同步全局正则失败：${(error as Error)?.message || '未知错误'}`, 'managed-global-regex-sync-error');
  }
}

async function initializeManagedGlobalRegexes(): Promise<void> {
  try {
    const settings = await loadSettings();
    await syncManagedGlobalRegexes(settings);
  } catch (error) {
    console.error(`[${SCRIPT_LABEL}] 初始化全局正则失败`, error);
    notify(
      'error',
      `初始化全局正则失败：${(error as Error)?.message || '未知错误'}`,
      'managed-global-regex-init-error',
    );
  }
}

async function openSettings(): Promise<void> {
  try {
    const current = await loadSettings();
    const next = await openSettingsPopup(current, {
      onUpdateInstalled: version => {
        notify('success', `v${version} 已安装，正在自动刷新页面…`, undefined, '更新成功');
      },
    });
    if (!next) return;
    const saved = await saveSettings(next);
    await applyManagedGlobalRegexes(saved);
    notifySettingsSaved();
  } catch (error) {
    console.error(`[${SCRIPT_LABEL}] 保存设置失败`, error);
    notify('error', `保存设置失败：${(error as Error)?.message || '未知错误'}`);
  }
}

async function regenerateLatestAssistantOptions(): Promise<void> {
  const epoch = automationEpoch;
  const expectedChatId = getCurrentChatIdSafe();
  const progressId = startProgress('重生成行动选项', '正在查找最新 AI 楼层');
  const messageId = await findLatestAssistantMessageId();
  if (epoch !== automationEpoch || (expectedChatId && getCurrentChatIdSafe() !== expectedChatId)) {
    finishProgress(progressId, 'warning', '聊天已切换', '已取消写入旧聊天楼层');
    return;
  }
  if (messageId == null) {
    finishProgress(progressId, 'warning', '未找到 AI 楼层', '当前聊天中没有可处理的 AI 回复');
    return;
  }
  if (messageId <= 0) {
    finishProgress(progressId, 'warning', '已取消写入', '未能确认最新 AI 楼层，已保护 0 层不被改写');
    return;
  }
  processedBaseTexts.delete(messageId);
  await generateAndAppendOptions(messageId, 'manual', progressId, expectedChatId);
}

async function initializeAutomaticUpdateCheck(): Promise<void> {
  restoreCachedUpdateState();
  const settings = await loadSettings();
  if (!settings.updates.automaticCheck) return;
  await checkForUpdates({ endpoint: settings.updates.endpoint });
}

$(() => {
  const { destroy } = teleportStyle();

  refreshButtons();
  void initializeManagedGlobalRegexes();
  void syncCurrentCharacterKnowledgeSourceToStoredSettings();
  void initializeAutomaticUpdateCheck().catch(error => {
    console.warn(`[${SCRIPT_LABEL}] 自动检查更新失败`, error);
  });

  eventOn(tavern_events.GENERATION_STARTED, (type: string, _option: unknown, dryRun: boolean) => {
    if (dryRun || !isAllowedAutoMessageType(type)) {
      lastAllowedGeneration = null;
      return;
    }
    lastAllowedGeneration = {
      chatId: getCurrentChatIdSafe(),
      startedAt: Date.now(),
    };
  });

  eventOn(tavern_events.MESSAGE_RECEIVED, (messageId: number, type: string) => {
    if (!isAllowedAutoMessageType(type)) return;
    scheduleGenerate(messageId, 'message_received');
  });

  eventOn(tavern_events.MESSAGE_SWIPED, (messageId: number) => {
    cancelMessageGeneration(messageId);
    scheduleGenerate(messageId, 'message_swiped');
  });

  eventOn(tavern_events.MESSAGE_EDITED, cancelMessageGeneration);
  eventOn(tavern_events.MESSAGE_DELETED, clearAutomationRuntime);

  eventOn(tavern_events.GENERATION_ENDED, (messageId: number) => {
    if (!shouldHandleGenerationEnded(messageId)) return;
    lastAllowedGeneration = null;
    scheduleGenerate(messageId, 'generation_ended');
  });

  eventOn(tavern_events.CHAT_CHANGED, () => {
    clearAutomationRuntime();
    dismissProgress(true);
    scheduleCurrentCharacterKnowledgeSourceSync(true);
  });

  eventOn(tavern_events.CHARACTER_PAGE_LOADED, () => {
    scheduleCurrentCharacterKnowledgeSourceSync(true);
  });

  eventOn(getButtonEvent(BUTTON_SETTINGS), () => {
    void openSettings();
  });

  eventOn(getButtonEvent(BUTTON_REGENERATE), () => {
    void regenerateLatestAssistantOptions();
  });

  $(window).on('pagehide', () => {
    clearAutomationRuntime();
    clearCharacterKnowledgeSyncTimer();
    noticeTimestamps.clear();
    destroyProgressRoot();
    destroyNoticeRoot();
    void cleanupManagedGlobalRegexes().catch(error => {
      console.warn(`[${SCRIPT_LABEL}] 清理全局正则失败`, error);
    });
    destroy();
  });
});
