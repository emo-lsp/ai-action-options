import type { ManagedGlobalRegexConfig, ScriptSettings } from './types';

const MANAGED_GLOBAL_REGEX_IDS = [
  `${getScriptId()}::managed-global-regex::1`,
  `${getScriptId()}::managed-global-regex::2`,
] as const;

const DEFAULT_MANAGED_GLOBAL_REGEXES: ManagedGlobalRegexConfig[] = [
  {
    inject: true,
    enabled: true,
    scriptName: '1.[选项]简约主题',
    findRegex: '/<options>((?:(?!<options>).)*?)</options>/gs',
    replaceString:
      "```html\n<body>\n  <script>\n    $('body').load('https://testingcf.jsdelivr.net/gh/emo-lsp/SillyTavern@refs/heads/main/options/选项1.2.html')\n  </script>\n  </body>\n```",
    trimStrings: [],
    source: {
      userInput: false,
      aiOutput: true,
      slashCommand: false,
      worldInfo: false,
    },
    destination: {
      display: true,
      prompt: false,
    },
    runOnEdit: true,
    minDepth: null,
    maxDepth: 2,
  },
  {
    inject: true,
    enabled: true,
    scriptName: '2.[选项]对AI隐藏',
    findRegex: '/<options>(.*?)<\\/options>/s',
    replaceString: '',
    trimStrings: [],
    source: {
      userInput: false,
      aiOutput: true,
      slashCommand: false,
      worldInfo: false,
    },
    destination: {
      display: false,
      prompt: true,
    },
    runOnEdit: true,
    minDepth: null,
    maxDepth: null,
  },
];

let mutationQueue: Promise<unknown> = Promise.resolve();

function cloneManagedGlobalRegexConfig(config: ManagedGlobalRegexConfig): ManagedGlobalRegexConfig {
  return {
    inject: config.inject,
    enabled: config.enabled,
    scriptName: config.scriptName,
    findRegex: config.findRegex,
    replaceString: config.replaceString,
    trimStrings: [...config.trimStrings],
    source: { ...config.source },
    destination: { ...config.destination },
    runOnEdit: config.runOnEdit,
    minDepth: config.minDepth,
    maxDepth: config.maxDepth,
  };
}

export function createDefaultManagedGlobalRegexes(): ManagedGlobalRegexConfig[] {
  return DEFAULT_MANAGED_GLOBAL_REGEXES.map(cloneManagedGlobalRegexConfig);
}

function getManagedGlobalRegexId(slotIndex: number): string {
  return MANAGED_GLOBAL_REGEX_IDS[slotIndex] ?? `${getScriptId()}::managed-global-regex::${slotIndex + 1}`;
}

function isManagedGlobalRegex(regex: TavernRegex): boolean {
  return MANAGED_GLOBAL_REGEX_IDS.includes(regex.id as (typeof MANAGED_GLOBAL_REGEX_IDS)[number]);
}

function hasTavernRegexApi(): boolean {
  return typeof updateTavernRegexesWith === 'function';
}

function enqueueManagedRegexMutation<T>(job: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(job, job);
  mutationQueue = next.catch(() => undefined);
  return next;
}

function toTavernRegex(config: ManagedGlobalRegexConfig, slotIndex: number): TavernRegex {
  return {
    id: getManagedGlobalRegexId(slotIndex),
    script_name: String(config.scriptName || '').trim() || `全局正则 ${slotIndex + 1}`,
    enabled: config.enabled,
    find_regex: config.findRegex,
    replace_string: config.replaceString,
    trim_strings: [...config.trimStrings],
    source: {
      user_input: config.source.userInput,
      ai_output: config.source.aiOutput,
      slash_command: config.source.slashCommand,
      world_info: config.source.worldInfo,
    },
    destination: {
      display: config.destination.display,
      prompt: config.destination.prompt,
    },
    run_on_edit: config.runOnEdit,
    min_depth: config.minDepth,
    max_depth: config.maxDepth,
  };
}

function buildManagedGlobalRegexes(settings: ScriptSettings): TavernRegex[] {
  return settings.managedGlobalRegexes
    .map((config, slotIndex) => ({ config, slotIndex }))
    .filter(({ config }) => config.inject)
    .map(({ config, slotIndex }) => toTavernRegex(config, slotIndex));
}

export function validateManagedGlobalRegex(config: ManagedGlobalRegexConfig, slotIndex: number): string | null {
  if (!config.inject) {
    return null;
  }

  const slotLabel = `全局正则 ${slotIndex + 1}`;
  const name = String(config.scriptName || '').trim();
  const regexText = String(config.findRegex || '').trim();

  if (!name) {
    return `${slotLabel} 的名称不能为空`;
  }
  if (!regexText) {
    return `${slotLabel} 的匹配正则不能为空`;
  }

  try {
    if (typeof builtin?.parseRegexFromString === 'function' && !builtin.parseRegexFromString(regexText)) {
      return `${slotLabel} 的匹配正则格式无效，请使用 /pattern/flags 形式`;
    }
  } catch {
    return `${slotLabel} 的匹配正则格式无效`;
  }

  const hasAnySource =
    config.source.userInput || config.source.aiOutput || config.source.slashCommand || config.source.worldInfo;
  if (!hasAnySource) {
    return `${slotLabel} 至少要勾选一个作用来源`;
  }

  const hasAnyDestination = config.destination.display || config.destination.prompt;
  if (!hasAnyDestination) {
    return `${slotLabel} 至少要勾选一个作用目标`;
  }

  if (
    config.minDepth != null &&
    config.maxDepth != null &&
    Number.isFinite(config.minDepth) &&
    Number.isFinite(config.maxDepth) &&
    config.minDepth > config.maxDepth
  ) {
    return `${slotLabel} 的最小深度不能大于最大深度`;
  }

  return null;
}

export async function cleanupManagedGlobalRegexes(): Promise<void> {
  if (!hasTavernRegexApi()) {
    return;
  }

  await enqueueManagedRegexMutation(async () => {
    await updateTavernRegexesWith(
      regexes => regexes.filter(regex => !isManagedGlobalRegex(regex)),
      { type: 'global' },
    );
  });
}

export async function syncManagedGlobalRegexes(settings: ScriptSettings): Promise<number> {
  if (!hasTavernRegexApi()) {
    return 0;
  }

  return enqueueManagedRegexMutation(async () => {
    const managedRegexes = settings.manageGlobalRegexes ? buildManagedGlobalRegexes(settings) : [];
    await updateTavernRegexesWith(
      regexes => [
        ...regexes.filter(regex => !isManagedGlobalRegex(regex)),
        ...managedRegexes,
      ],
      { type: 'global' },
    );
    return managedRegexes.length;
  });
}
