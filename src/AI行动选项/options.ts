import { z } from 'zod';
import type { OptionsValidationResult } from './types';

const OPTIONS_BLOCK_RE = /<options>([\s\S]*?)<\/options>/gi;
const TRAILING_OPTIONS_RE = /\s*<options>[\s\S]*?<\/options>\s*$/i;
const OptionsJsonSchema = z
  .object({
    options: z.array(z.string().trim().min(1)).length(8),
  })
  .strict();

export function hasTrailingOptionsBlock(text: string): boolean {
  return TRAILING_OPTIONS_RE.test(String(text || ''));
}

export function stripTrailingOptionsBlock(text: string): string {
  return String(text || '').replace(TRAILING_OPTIONS_RE, '').trimEnd();
}

export function stripAllOptionsBlocks(text: string): string {
  return String(text || '')
    .replace(OPTIONS_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendOptionsBlock(text: string, optionsMarkup: string): string {
  const base = stripTrailingOptionsBlock(text);
  if (!base) return optionsMarkup.trim();
  return `${base}\n\n${optionsMarkup.trim()}`;
}

export function validateOptionsJson(text: string): OptionsValidationResult {
  const input = String(text || '').trim();
  if (!input) {
    return { ok: false, reason: '模型未返回内容' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, reason: '返回内容必须是合法 JSON，且不能包含代码块或其他文字' };
  }

  const validation = OptionsJsonSchema.safeParse(parsed);
  if (!validation.success) {
    return { ok: false, reason: 'JSON 必须且只能包含 options 字段，且 options 必须是正好 8 项的非空字符串数组' };
  }

  const options = validation.data.options;
  if (options.some(item => /[\r\n]/.test(item))) {
    return { ok: false, reason: '单个选项内容中不能包含换行' };
  }

  if (options.some(item => item.includes('|'))) {
    return { ok: false, reason: '单个选项内容中不能包含 | 字符' };
  }

  if (options.some(item => /<\s*\/?\s*options\s*>/i.test(item))) {
    return { ok: false, reason: '单个选项内容中不能再次包含 <options> 标签' };
  }

  return {
    ok: true,
    normalizedMarkup: `<options>${options.join('|')}</options>`,
    options,
  };
}
