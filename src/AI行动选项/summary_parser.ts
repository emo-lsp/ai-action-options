export type SummaryRule = {
  name: string;
  findRegex: string;
  replaceString: string;
  enabled: boolean;
  aiOutput: boolean;
  source: 'preset' | 'global' | 'character';
};

const COMMON_TAGS = ['summary', 'recap', '摘要', '小总结', '总结', '剧情摘要', '小结'];
const SUMMARY_HINT = /摘要|总结|小结|summary|recap/i;
const RESERVED_TAGS = new Set(['html', 'body', 'head', 'div', 'span', 'p', 'a', 'br', 'details', 'script', 'style', 'think', 'thinking', 'options', 'summary_format', 'updatevariable']);

export function normalizeSummaryTag(input: string): string | null {
  const text = String(input || '').trim();
  const value = (text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text).toLowerCase();
  return /^[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(value) && !RESERVED_TAGS.has(value) ? value : null;
}

function stripNonStoryBlocks(text: string): string {
  return String(text || '').replace(/<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, '');
}

type TagBlock = { tag: string; start: number; contentStart: number; contentEnd?: number; end?: number; parent?: TagBlock; children: TagBlock[] };

export function extractSummaries(text: string, tags: string[]): Array<{ tag: string; text: string }> {
  const wanted = new Set(tags.map(normalizeSummaryTag).filter((tag): tag is string => tag != null));
  if (!wanted.size) return [];
  const source = stripNonStoryBlocks(text);
  const excluded = new Set(['think', 'thinking', 'options', 'script', 'style', 'summary_format']);
  const stack: TagBlock[] = [];
  const blocks: TagBlock[] = [];
  // 只跟踪摘要标签与 details 的边界；不会把 HTML 折叠标题当作剧情摘要。
  const tokens = /<\s*(\/?)\s*([\p{L}_][\p{L}\p{N}_.:-]*)(?:\s[^<>]*?)?\s*(\/?)>/gu;
  for (const match of source.matchAll(tokens)) {
    const tag = match[2].toLowerCase();
    if (!wanted.has(tag) && !excluded.has(tag) && tag !== 'details' && tag !== 'summary') continue;
    if (match[1]) {
      const last = stack.at(-1);
      if (last?.tag === tag) {
        last.contentEnd = match.index;
        last.end = match.index + match[0].length;
        stack.pop();
      }
    } else if (!match[3]) {
      const block: TagBlock = { tag, start: match.index, contentStart: match.index + match[0].length, parent: stack.at(-1), children: [] };
      block.parent?.children.push(block);
      blocks.push(block);
      stack.push(block);
    }
  }
  const results: Array<{ start: number; tag: string; text: string }> = [];
  const accepted = new Set<TagBlock>();
  for (const block of blocks) {
    if (block.end == null || block.contentEnd == null || excluded.has(block.tag)) continue;
    let ancestor = block.parent;
    let skip = false;
    while (ancestor) {
      if (accepted.has(ancestor) || ancestor.end == null || ancestor.tag === 'details' || excluded.has(ancestor.tag)) skip = true;
      ancestor = ancestor.parent;
    }
    if (skip) continue;
    if (block.tag === 'details') {
      if (!wanted.has('summary')) continue;
      const title = block.children[0];
      if (title?.tag !== 'summary' || title.end == null || title.contentEnd == null) continue;
      const label = source.slice(title.contentStart, title.contentEnd).replace(/<[^>]*>/g, '').trim();
      if (!/^(?:(?:剧情)?(?:摘要|总结|小总结|小结)|summary|recap)$/i.test(label)) continue;
      const content = source.slice(title.end, block.contentEnd).trim();
      if (content) {
        results.push({ start: block.start, tag: 'summary', text: content });
        accepted.add(block);
      }
    } else if (wanted.has(block.tag)) {
      const content = source.slice(block.contentStart, block.contentEnd).trim();
      if (content && !/^(?:\$\d+|摘要|总结|小总结|小结|summary|recap)$/i.test(content)) {
        results.push({ start: block.start, tag: block.tag, text: content });
        accepted.add(block);
      }
    }
  }
  return results.sort((a, b) => a.start - b.start).map(({ tag, text: content }) => ({ tag, text: content }));
}

function tagCandidates(text: string): string[] {
  // 查找表达式只提供字面标签线索，绝不执行来自预设的任意正则。
  const unescaped = text.replace(/\\([<>/])/g, '$1');
  return Array.from(unescaped.matchAll(/<\/?([\p{L}_][\p{L}\p{N}_.:-]*)\s*>/gu))
    .map(match => normalizeSummaryTag(match[1])).filter((tag): tag is string => tag != null);
}

export function detectSummaryTags(texts: string[], rules: SummaryRule[], presetContents: string[]): { tags: string[]; ruleNames: string[] } {
  const candidates = new Set(COMMON_TAGS);
  const relevantRules = rules.filter(rule => rule.enabled && rule.aiOutput && SUMMARY_HINT.test(rule.name + ' ' + rule.findRegex));
  for (const rule of relevantRules) tagCandidates(rule.findRegex).forEach(tag => candidates.add(tag));
  for (const content of presetContents) {
    const formats = Array.from(content.matchAll(/<summary_format\b[^>]*>([\s\S]*?)<\/summary_format>/gi));
    const lines = content.split('\n');
    const fragments = formats.length ? formats.map(match => match[1]) : lines.flatMap((line, index) =>
      SUMMARY_HINT.test(line) ? [lines.slice(Math.max(0, index - 1), index + 4).join('\n')] : []);
    fragments.forEach(fragment => tagCandidates(fragment).forEach(tag => candidates.add(tag)));
  }
  const tags = Array.from(candidates).filter(tag => texts.some(text => extractSummaries(text, [tag]).length > 0)).sort();
  const ruleNames = relevantRules.filter(rule => tagCandidates(rule.findRegex).some(tag => tags.includes(tag)))
    .map(rule => rule.name).filter((name, index, names) => names.indexOf(name) === index);
  return { tags, ruleNames };
}
