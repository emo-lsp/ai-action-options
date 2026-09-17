import type { WorldbookEntrySelections } from './types';

const AUTO_UNSELECT_ENTRY_NAME_KEYWORDS = Array.from(
  new Set([
    '[mvu_update]',
    '变量更新规则',
    '变量列表',
    '变量输出格式',
    '[initvar]',
    'Initvar',
    'initvar',
    'EJS',
    'ejs',
    '变量初始化',
    'MVU',
    'mvu',
    '变量',
    '分阶段人设',
    '分阶段设定',
    '多阶段人设',
    '多阶段设定',
    '角色阶段',
    '插图',
    '文风',
    '选项',
    '选开',
    '特殊事件',
  ]),
);

export function getAvailableWorldbookEntries(entries: WorldbookEntry[]): WorldbookEntry[] {
  return entries.filter(entry => String(entry.content || '').trim());
}

export function shouldAutoUnselectWorldbookEntry(entry: WorldbookEntry): boolean {
  const entryName = String(entry.name || '').trim();
  if (!entryName) return false;
  return AUTO_UNSELECT_ENTRY_NAME_KEYWORDS.some(keyword => entryName.includes(keyword));
}

export function getDefaultSelectedEntryUids(availableEntries: WorldbookEntry[]): number[] {
  return availableEntries
    .filter(entry => !shouldAutoUnselectWorldbookEntry(entry))
    .map(entry => entry.uid);
}

export function getEffectiveSelectedEntryUids(
  selections: WorldbookEntrySelections,
  worldbookName: string,
  availableEntries: WorldbookEntry[],
): number[] {
  const availableUids = new Set(availableEntries.map(entry => entry.uid));
  if (!Object.prototype.hasOwnProperty.call(selections, worldbookName)) {
    return getDefaultSelectedEntryUids(availableEntries);
  }

  const selectedUids = Array.isArray(selections[worldbookName]) ? selections[worldbookName] : [];
  return selectedUids.filter(uid => availableUids.has(uid));
}

export function getEffectiveSelectedEntries(
  selections: WorldbookEntrySelections,
  worldbookName: string,
  availableEntries: WorldbookEntry[],
): WorldbookEntry[] {
  const selectedUidSet = new Set(getEffectiveSelectedEntryUids(selections, worldbookName, availableEntries));
  return availableEntries.filter(entry => selectedUidSet.has(entry.uid));
}

export function compactEntrySelectionForStorage(
  availableEntries: WorldbookEntry[],
  selectedUids: number[],
): number[] | undefined {
  const availableUidSet = new Set(availableEntries.map(entry => entry.uid));
  const normalized = Array.from(new Set(selectedUids.filter(uid => availableUidSet.has(uid))));
  const defaultSelectedUids = getDefaultSelectedEntryUids(availableEntries);
  const normalizedSet = new Set(normalized);
  const matchesDefaultSelection =
    normalized.length === defaultSelectedUids.length &&
    defaultSelectedUids.every(uid => normalizedSet.has(uid));

  if (matchesDefaultSelection) {
    return undefined;
  }

  return normalized;
}
