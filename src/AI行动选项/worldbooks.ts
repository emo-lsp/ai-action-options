import type { WorldbookContextResult, WorldbookEntrySelections } from './types';
import { getAvailableWorldbookEntries, getEffectiveSelectedEntries } from './entry_selection';
import { readWorldbookEntries } from './worldbook_reader';

function formatEntryTitle(name: string, uid: number): string {
  const trimmed = String(name || '').trim();
  return trimmed || `UID ${uid}`;
}

export async function buildWorldbookContext(
  boundWorldbooks: string[],
  selections: WorldbookEntrySelections = {},
): Promise<WorldbookContextResult> {
  const uniqueNames = Array.from(new Set(boundWorldbooks.map(name => String(name || '').trim()).filter(Boolean)));
  const blocks: string[] = [];
  const loadedNames: string[] = [];
  const missingWorldbooks: string[] = [];
  let selectedEntryCount = 0;

  for (const name of uniqueNames) {
    try {
      const entries = await readWorldbookEntries(name);
      const availableEntries = getAvailableWorldbookEntries(entries);
      const selectedEntries = getEffectiveSelectedEntries(selections, name, availableEntries);
      if (!selectedEntries.length) continue;

      loadedNames.push(name);
      selectedEntryCount += selectedEntries.length;

      const lines = [`# 世界书：${name}`];
      for (const entry of selectedEntries) {
        lines.push(`## 条目：${formatEntryTitle(entry.name, entry.uid)}`);
        lines.push(String(entry.content || '').trim());
        lines.push('');
      }
      blocks.push(lines.join('\n').trim());
    } catch (error) {
      console.warn(`[AI行动选项] 读取世界书失败: ${name}`, error);
      missingWorldbooks.push(name);
    }
  }

  return {
    worldbookNames: loadedNames,
    worldbookText: blocks.join('\n\n').trim(),
    missingWorldbooks,
    selectedEntryCount,
  };
}
