import { stripAllOptionsBlocks } from './options';
import { detectSummaryTags, extractSummaries, normalizeSummaryTag } from './summary_parser';
import type { SummaryRule } from './summary_parser';
import type { SummarySettings } from './types';

export type ContextReply = { id: number; text: string };
export type SummaryEntry = { id: number; tag: string; text: string };
export type SummaryHints = { rules: SummaryRule[]; presetContents: string[]; notes: string[] };
export type ActionContext = {
  latestReply: string;
  recentAiRepliesText: string;
  recentAiReplyCount: number;
  earlierSummariesText: string;
  bodyIds: number[];
  summary: {
    entries: SummaryEntry[];
    available: SummaryEntry[];
    selectedIds: number[];
    missingIds: number[];
    tags: string[];
    ruleNames: string[];
    notes: string[];
  };
};

function stripContextBlocks(text: string, tags: RegExp): string {
  const source = String(text || '');
  const stack: string[] = [];
  let cursor = 0;
  let result = '';
  // 按嵌套边界剔除整块内容；未闭合块丢弃尾部，避免内部分析泄漏到正文或摘要。
  for (const match of source.matchAll(tags)) {
    if (!stack.length) result += source.slice(cursor, match.index);
    if (match[1]) {
      if (stack.at(-1) === match[2].toLowerCase()) stack.pop();
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(match[2].toLowerCase());
    }
    cursor = match.index + match[0].length;
  }
  return result + (stack.length ? '' : source.slice(cursor));
}

export function stripReasoningBlocks(text: string): string {
  return stripContextBlocks(text, /<\s*(\/?)\s*(thinking|think)(?=\s|\/?>)[^>]*>/gi);
}

export function cleanAssistantReplyForContext(text: string): string {
  return stripContextBlocks(
    stripAllOptionsBlocks(text),
    /<\s*(\/?)\s*(thinking|think|UpdateVariable|Analysis|JSONPatch)(?=\s|\/?>)[^>]*>/gi,
  ).trim();
}

export function buildActionContext(
  replies: ContextReply[],
  bodyCount: number,
  config: SummarySettings,
  hints: SummaryHints = { rules: [], presetContents: [], notes: [] },
  inspectWhenOff = false,
): ActionContext {
  const ordered = replies.slice().sort((a, b) => a.id - b.id);
  const count = Number.isFinite(bodyCount) ? Math.max(1, Math.round(bodyCount)) : 1;
  const body = ordered.slice(-count);
  const older = ordered.slice(0, Math.max(0, ordered.length - count));
  const selected = config.mode === 'off' ? [] : config.mode === 'all' ? older : older.slice(-config.count);
  const notes = [...hints.notes];
  let tags: string[] = [];
  let ruleNames: string[] = [];
  if (config.mode !== 'off' || inspectWhenOff) {
    if (config.tagMode === 'custom') {
      const tag = normalizeSummaryTag(config.customTag);
      if (tag) tags = [tag];
      else notes.push('摘要标签无效，请填写标签名，例如 summary 或 小总结');
    } else {
      ({ tags, ruleNames } = detectSummaryTags(ordered.map(item => item.text), hints.rules, hints.presetContents));
      if (!tags.length) notes.push('未识别到摘要，可填写自定义标签');
    }
  }
  const available = ordered.flatMap(item => extractSummaries(item.text, tags).map(block => ({ id: item.id, ...block })));
  const selectedIds = selected.map(item => item.id);
  const selectedSet = new Set(selectedIds);
  const entries = available.filter(item => selectedSet.has(item.id));
  const foundIds = new Set(entries.map(item => item.id));
  // 第 0 层通常是角色卡开场白，不要求带摘要；若实际带有摘要，仍照常读取。
  const missingIds = selectedIds.filter(id => id !== 0 && !foundIds.has(id));
  return {
    latestReply: body.at(-1)?.text ?? '',
    recentAiRepliesText: body.map(item => `[AI 回复楼层 #${item.id}]\n${item.text}`).join('\n\n'),
    recentAiReplyCount: body.length,
    // 楼层编号是稳定标识，不按窗口重新编号，也不把检测统计混入请求前缀。
    earlierSummariesText: entries.map(item => `[剧情摘要楼层 #${item.id}]\n${item.text}`).join('\n\n'),
    bodyIds: body.map(item => item.id),
    summary: { entries, available, selectedIds, missingIds, tags, ruleNames, notes },
  };
}

function readSummaryHints(): SummaryHints {
  const hints: SummaryHints = { rules: [], presetContents: [], notes: [] };
  for (const source of ['preset', 'global', 'character'] as const) {
    try {
      if (source === 'character' && !isCharacterTavernRegexesEnabled()) continue;
      hints.rules.push(...getTavernRegexes({ type: source }).map(rule => ({
        source,
        name: rule.script_name,
        enabled: rule.enabled,
        aiOutput: rule.source.ai_output,
        findRegex: rule.find_regex,
        replaceString: rule.replace_string,
      })));
    } catch {
      hints.notes.push(`${{ preset: '预设', global: '全局', character: '角色卡' }[source]}正则读取失败，按楼层标签识别`);
    }
  }
  try {
    hints.presetContents = getPreset('in_use').prompts.filter(item => item.enabled).map(item => item.content || '');
  } catch {
    hints.notes.push('预设格式读取失败，按正则与楼层标签识别');
  }
  return hints;
}

export async function readActionContext(
  targetId: number | undefined,
  bodyCount: number,
  config: SummarySettings,
  inspectWhenOff = false,
): Promise<ActionContext | null> {
  const chatId = SillyTavern.getCurrentChatId();
  const lastId = targetId ?? getLastMessageId();
  if (!Number.isInteger(lastId) || lastId < 0) return null;
  // 某些历史消息没有 is_hidden 字段；hide_state: unhidden 会漏掉它们，所以读取后只排除明确隐藏的消息。
  const messages = await Promise.resolve(getChatMessages(`0-${lastId}`, { include_swipes: false }));
  if (SillyTavern.getCurrentChatId() !== chatId) throw new Error('聊天已切换，请重新预览或生成');
  const replies = messages
    .filter(item => item.message_id <= lastId && item.role === 'assistant' && item.is_hidden !== true && item.extra?.type !== 'narrator')
    .map(item => ({ id: item.message_id, text: cleanAssistantReplyForContext(item.message) }))
    .filter(item => item.text);
  if (!replies.length || (targetId != null && replies.at(-1)?.id !== targetId)) return null;
  const hints = config.tagMode === 'auto' && (config.mode !== 'off' || inspectWhenOff)
    ? readSummaryHints()
    : undefined;
  return buildActionContext(replies, bodyCount, config, hints, inspectWhenOff);
}

export function describeSummaryContext(context: ActionContext): string {
  const summary = context.summary;
  const availableCount = new Set(summary.available.map(item => item.id)).size;
  const selectedCount = new Set(summary.entries.map(item => item.id)).size;
  return `${summary.tags.length ? `标签 ${summary.tags.join('、')}` : '未识别到摘要'} · 可用 ${availableCount} 层 · 读取 ${selectedCount} 层${summary.missingIds.length ? ` · 缺少 ${summary.missingIds.length} 层` : ''}`;
}

export function formatSummaryPreview(context: ActionContext, config: SummarySettings): string {
  const summary = context.summary;
  const selectedIds = new Set(summary.entries.map(item => item.id));
  const bodyIds = new Set(context.bodyIds);
  const lines = [
    `正文楼层：${context.bodyIds.map(id => `#${id}`).join('、') || '无'}`,
    `摘要范围：${config.mode === 'off' ? '已关闭，以下仅供检查' : config.mode === 'all' ? '全部更早摘要' : `正文之前 ${config.count} 层 AI 回复`}`,
    describeSummaryContext(context),
    ...(summary.ruleNames.length ? [`参考规则：${summary.ruleNames.join('、')}`] : []),
    ...(summary.missingIds.length ? [`缺少摘要：${summary.missingIds.map(id => `#${id}`).join('、')}`] : []),
    ...summary.notes,
    '',
  ];
  for (const entry of summary.available) {
    const state = bodyIds.has(entry.id) ? '正文已包含' : selectedIds.has(entry.id) ? '将读取' : '不读取';
    lines.push(`[楼层 #${entry.id} · ${entry.tag} · ${state}]`, entry.text, '');
  }
  return lines.join('\n').trim();
}
