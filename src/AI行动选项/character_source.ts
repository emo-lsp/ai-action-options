import type { ScriptSettings, WorldbookEntrySelections } from './types';

export type CurrentCharacterKnowledgeSource = {
  characterName: string;
  worldbookNames: string[];
  description: string;
  mode: 'worldbooks' | 'description' | 'empty' | 'no_character';
};

function normalizeWorldbookNames(names: unknown[]): string[] {
  const result: string[] = [];

  for (const item of names) {
    const name = String(item || '').trim();
    if (!name || result.includes(name)) continue;
    result.push(name);
  }

  return result;
}

function filterSelectionsByWorldbooks(
  selections: WorldbookEntrySelections,
  worldbookNames: string[],
): WorldbookEntrySelections {
  const allowed = new Set(worldbookNames);
  const next: WorldbookEntrySelections = {};

  for (const [name, selectedUids] of Object.entries(selections)) {
    if (!allowed.has(name)) continue;
    if (!Array.isArray(selectedUids)) continue;
    next[name] = [...selectedUids];
  }

  return next;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function areSelectionsEqual(
  left: WorldbookEntrySelections,
  right: WorldbookEntrySelections,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!areStringArraysEqual(leftKeys, rightKeys)) return false;

  return leftKeys.every(key => {
    const leftValues = Array.isArray(left[key]) ? left[key] : [];
    const rightValues = Array.isArray(right[key]) ? right[key] : [];
    if (leftValues.length !== rightValues.length) return false;
    return leftValues.every((value, index) => value === rightValues[index]);
  });
}

export function getCurrentCharacterBoundWorldbooks(): string[] {
  try {
    const bound = getCharWorldbookNames('current');
    return normalizeWorldbookNames([
      bound?.primary,
      ...(Array.isArray(bound?.additional) ? bound.additional : []),
    ]);
  } catch (error) {
    console.warn('[AI行动选项] 读取当前角色卡绑定世界书失败:', error);
    return [];
  }
}

export async function readCurrentCharacterKnowledgeSource(): Promise<CurrentCharacterKnowledgeSource> {
  const characterName = String(getCurrentCharacterName?.() || '').trim();
  let description = '';
  let fallbackWorldbookName = '';

  try {
    const character = await getCharacter('current');
    description = String(character?.description || '').trim();
    fallbackWorldbookName = String(character?.worldbook || '').trim();
  } catch {
    // 当前没有角色卡时会直接走 no_character/empty 分支
  }

  const worldbookNames = normalizeWorldbookNames([
    fallbackWorldbookName,
    ...getCurrentCharacterBoundWorldbooks(),
  ]);

  if (worldbookNames.length) {
    return {
      characterName,
      worldbookNames,
      description,
      mode: 'worldbooks',
    };
  }

  if (description) {
    return {
      characterName,
      worldbookNames: [],
      description,
      mode: 'description',
    };
  }

  return {
    characterName,
    worldbookNames: [],
    description: '',
    mode: characterName ? 'empty' : 'no_character',
  };
}

export function syncSettingsToCurrentCharacterKnowledgeSource(
  settings: ScriptSettings,
  source: CurrentCharacterKnowledgeSource,
): { settings: ScriptSettings; changed: boolean } {
  const nextWorldbookNames = source.mode === 'worldbooks' ? [...source.worldbookNames] : [];
  const nextSelections = filterSelectionsByWorldbooks(
    settings.knowledgeWorldbookEntrySelections,
    nextWorldbookNames,
  );
  const changed =
    !areStringArraysEqual(settings.boundKnowledgeWorldbooks, nextWorldbookNames) ||
    !areSelectionsEqual(settings.knowledgeWorldbookEntrySelections, nextSelections);

  if (!changed) {
    return {
      settings,
      changed: false,
    };
  }

  return {
    settings: {
      ...settings,
      boundKnowledgeWorldbooks: nextWorldbookNames,
      knowledgeWorldbookEntrySelections: nextSelections,
    },
    changed: true,
  };
}

export async function syncSettingsWithCurrentCharacterKnowledgeSource(
  settings: ScriptSettings,
): Promise<{
  settings: ScriptSettings;
  source: CurrentCharacterKnowledgeSource;
  changed: boolean;
}> {
  const source = await readCurrentCharacterKnowledgeSource();
  const synced = syncSettingsToCurrentCharacterKnowledgeSource(settings, source);
  return {
    settings: synced.settings,
    source,
    changed: synced.changed,
  };
}
