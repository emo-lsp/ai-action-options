export type PromptRole = 'system' | 'user' | 'assistant';

export type PromptTemplateMessage = {
  id: string;
  role: PromptRole;
  content: string;
  enabled: boolean;
};

export type ApiProvider = 'deepseek' | 'openai';
export type ApiPricingPeriod = 'off-peak' | 'peak';

export type ThinkingMode = 'auto' | 'disabled' | 'enabled';
export type ReasoningEffort = 'auto' | 'low' | 'high' | 'max';

export type ApiProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  thinkingControlVersion: number;
  thinkingMode: ThinkingMode;
  reasoningEffort: ReasoningEffort;
};

export type ApiSettings = {
  provider: ApiProvider;
} & ApiProviderConfig;

export type ApiProviderConfigs = Record<ApiProvider, ApiProviderConfig>;

export type UpdateEndpoint = 'auto' | 'testingcf' | 'jsdelivr' | 'github';

export type UpdateSettings = {
  automaticCheck: boolean;
  endpoint: UpdateEndpoint;
};

export type CustomOptionPresetId = 'custom_option_preset_1' | 'custom_option_preset_2';

export type CustomOptionPresetConfig = {
  name: string;
  editableBody: string;
};

export type CustomOptionPresetConfigs = Record<CustomOptionPresetId, CustomOptionPresetConfig>;

export type WorldbookEntrySelections = Record<string, number[]>;
export type SourceKind = 'knowledgebook';

export type SummarySettings = {
  mode: 'off' | 'recent' | 'all';
  count: number;
  tagMode: 'auto' | 'custom';
  customTag: string;
};

export type ManagedGlobalRegexSource = {
  userInput: boolean;
  aiOutput: boolean;
  slashCommand: boolean;
  worldInfo: boolean;
};

export type ManagedGlobalRegexDestination = {
  display: boolean;
  prompt: boolean;
};

export type ManagedGlobalRegexConfig = {
  inject: boolean;
  enabled: boolean;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  source: ManagedGlobalRegexSource;
  destination: ManagedGlobalRegexDestination;
  runOnEdit: boolean;
  minDepth: number | null;
  maxDepth: number | null;
};

export type ScriptSettings = {
  enabled: boolean;
  boundKnowledgeWorldbooks: string[];
  knowledgeWorldbookEntrySelections: WorldbookEntrySelections;
  optionPresetId: string;
  customOptionPresets: CustomOptionPresetConfigs;
  assistantContextCount: number;
  summary: SummarySettings;
  manageGlobalRegexes: boolean;
  managedGlobalRegexes: ManagedGlobalRegexConfig[];
  showCacheUsageInSuccessPopup: boolean;
  api: ApiSettings;
  apiProviderConfigs: ApiProviderConfigs;
  updates: UpdateSettings;
  promptMessages: PromptTemplateMessage[];
  replaceMode: 'replace_trailing_options';
};

export type GenerationContext = {
  latestReply: string;
  recentAiRepliesText: string;
  recentAiReplyCount: number;
  earlierSummariesText?: string;
  worldbookText: string;
  worldbookNames: string[];
  knowledgebookText: string;
  knowledgebookNames: string[];
};

export type ResolvedPromptMessage = {
  role: PromptRole;
  content: string;
};

export type WorldbookContextResult = {
  worldbookNames: string[];
  worldbookText: string;
  missingWorldbooks: string[];
  selectedEntryCount: number;
};

export type OptionsValidationResult =
  | {
      ok: true;
      normalizedMarkup: string;
      options: string[];
    }
  | {
      ok: false;
      reason: string;
    };

export type ApiUsageSnapshot = {
  status: 'idle' | 'running' | 'success' | 'error';
  requestedAt: number | null;
  finishedAt: number | null;
  model: string;
  promptTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  cacheStatsAvailable: boolean;
  cacheStatsSuppressed: boolean;
  completionTokens: number | null;
  totalTokens: number | null;
  hitRate: number | null;
  estimatedCostCny: number | null;
  pricingModel: string | null;
  pricingPeriod: ApiPricingPeriod | null;
  note: string;
};
