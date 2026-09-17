import type { CustomOptionPresetConfig, CustomOptionPresetConfigs, CustomOptionPresetId } from './types';
import type { OptionPresetDefinition } from './presets';
import { OPTION_PRESETS } from './presets';

export const CUSTOM_OPTION_PRESET_SLOTS: Array<{
  id: CustomOptionPresetId;
  defaultName: string;
  basePresetId: string;
}> = [
  {
    id: 'custom_option_preset_1',
    defaultName: '自定义模板 1·用户视角',
    basePresetId: 'user_pov_imperative',
  },
  {
    id: 'custom_option_preset_2',
    defaultName: '自定义模板 2·导演视角',
    basePresetId: 'director_pov_narrative',
  },
];

const LEGACY_FIXED_PROMPT_HEADER =
  '在正文结尾生成8个选项，只能使用`<options></options>`包裹，选项间用|分隔，禁止换行。';
const LEGACY_FORMAT_REQUIREMENT = '  - 只能使用`<options></options>`标签包裹八个选项，禁止换行，禁止使用其他标签名';
const FIXED_PROMPT_HEADER = '根据正文结尾生成8个选项，只输出合法 JSON，不得使用 Markdown 代码块或附加解释。';
const FIXED_PROMPT_OUTPUT = [
  '输出格式:',
  '',
  '{"options":["选项1","选项2","选项3","选项4","选项5","选项6","选项7","选项8"]}',
].join('\n');

function extractEditablePromptBody(prompt: string): string {
  return String(prompt || '')
    .replace(/^在正文结尾生成8个选项，只能使用`<options><\/options>`包裹，选项间用\|分隔，禁止换行。\s*/u, '')
    .replace(`${LEGACY_FORMAT_REQUIREMENT}\n`, '')
    .replace(/\n*输出格式:\s*[\s\S]*$/u, '')
    .trim();
}

function buildCustomPresetPrompt(editableBody: string): string {
  const normalizedBody = String(editableBody || '')
    .trim()
    .replace(LEGACY_FIXED_PROMPT_HEADER, '')
    .replace(LEGACY_FORMAT_REQUIREMENT.trim(), '')
    .trim();
  return [FIXED_PROMPT_HEADER, '', normalizedBody, '', FIXED_PROMPT_OUTPUT].join('\n');
}

function getBasePreset(basePresetId: string): OptionPresetDefinition {
  return OPTION_PRESETS.find(item => item.id === basePresetId) ?? OPTION_PRESETS[0];
}

export function isCustomOptionPresetId(value: string): value is CustomOptionPresetId {
  return CUSTOM_OPTION_PRESET_SLOTS.some(item => item.id === value);
}

export function isKnownOptionPresetId(value: string): boolean {
  return OPTION_PRESETS.some(item => item.id === value) || isCustomOptionPresetId(value);
}

export function createDefaultCustomOptionPresetConfigs(): CustomOptionPresetConfigs {
  return CUSTOM_OPTION_PRESET_SLOTS.reduce((result, slot) => {
    result[slot.id] = {
      name: slot.defaultName,
      editableBody: extractEditablePromptBody(getBasePreset(slot.basePresetId).prompt),
    };
    return result;
  }, {} as CustomOptionPresetConfigs);
}

export function getDefaultCustomOptionPresetConfig(id: CustomOptionPresetId): CustomOptionPresetConfig {
  return { ...createDefaultCustomOptionPresetConfigs()[id] };
}

function resolveCustomOptionPresetConfig(
  id: CustomOptionPresetId,
  customOptionPresets?: Partial<CustomOptionPresetConfigs>,
): CustomOptionPresetConfig {
  const defaults = getDefaultCustomOptionPresetConfig(id);
  const raw = customOptionPresets?.[id];

  return {
    name: String(raw?.name ?? defaults.name).trim() || defaults.name,
    editableBody: String(raw?.editableBody ?? defaults.editableBody).trim() || defaults.editableBody,
  };
}

function buildCustomPresetDefinition(
  id: CustomOptionPresetId,
  customOptionPresets?: Partial<CustomOptionPresetConfigs>,
): OptionPresetDefinition {
  const slot = CUSTOM_OPTION_PRESET_SLOTS.find(item => item.id === id) ?? CUSTOM_OPTION_PRESET_SLOTS[0];
  const basePreset = getBasePreset(slot.basePresetId);
  const config = resolveCustomOptionPresetConfig(id, customOptionPresets);

  return {
    id,
    name: config.name,
    summary: `基于「${basePreset.name}」的自定义模板，仅编辑规则正文，输出格式固定。`,
    prompt: buildCustomPresetPrompt(config.editableBody),
  };
}

export function getResolvedOptionPreset(
  optionPresetId: string,
  customOptionPresets?: Partial<CustomOptionPresetConfigs>,
): OptionPresetDefinition {
  if (isCustomOptionPresetId(optionPresetId)) {
    return buildCustomPresetDefinition(optionPresetId, customOptionPresets);
  }
  return OPTION_PRESETS.find(item => item.id === optionPresetId) ?? OPTION_PRESETS[0];
}

export function getResolvedOptionPresets(
  customOptionPresets?: Partial<CustomOptionPresetConfigs>,
): OptionPresetDefinition[] {
  return [
    ...OPTION_PRESETS,
    ...CUSTOM_OPTION_PRESET_SLOTS.map(slot => buildCustomPresetDefinition(slot.id, customOptionPresets)),
  ];
}
