import { mountCustomSelects } from './custom_select';
import { mountSummarySettings, renderSummarySettings, syncSummaryInputs } from './summary_ui';
import type { CustomOptionPresetConfig, CustomOptionPresetId, ScriptSettings, UpdateEndpoint } from './types';
import type { CurrentCharacterKnowledgeSource } from './character_source';
import { syncSettingsWithCurrentCharacterKnowledgeSource } from './character_source';
import { fetchAvailableModels } from './api';
import {
  compactEntrySelectionForStorage,
  getAvailableWorldbookEntries,
  getEffectiveSelectedEntries,
  getEffectiveSelectedEntryUids,
} from './entry_selection';
import {
  getDefaultCustomOptionPresetConfig,
  getResolvedOptionPreset,
  getResolvedOptionPresets,
  isCustomOptionPresetId,
} from './custom_presets';
import {
  clearDraftSettings as clearStoredDraftSettings,
  cloneSettings,
  getDefaultApiSettings,
  getDefaultPromptMessages,
  loadDraftSettings as loadStoredDraftSettings,
  normalizeSettings,
  saveSettings,
} from './settings';
import { readWorldbookEntries } from './worldbook_reader';
import {
  checkForUpdates,
  compareVersions,
  getUpdateState,
  installUpdate,
  subscribeUpdateState,
  type UpdateRuntimeState,
} from './update';
import { SCRIPT_VERSION } from './version';
import { gsap } from 'gsap';

const ROOT_CLASS = 'tlao-settings-root';
const KNOWLEDGEBOOK_TITLE = '附加世界书';
const POPUP_THEME_CLASS = 'tlao-theme-catalog';

type PopupMotionMedia = ReturnType<typeof gsap.matchMedia>;

type EntranceAnimationOptions = {
  duration?: number;
  delay?: number;
  ease?: string;
  stagger?: number;
  x?: number;
  y?: number;
  scale?: number;
};

// 设置界面挂在酒馆宿主页面，必须使用元素自身窗口的构造器判断，不能依赖脚本 iframe 的全局 HTMLElement。
function isHtmlElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false;
  const element = value as HTMLElement;
  if (element.nodeType !== 1 || !element.ownerDocument) return false;
  const ElementConstructor = element.ownerDocument.defaultView?.HTMLElement;
  return typeof ElementConstructor === 'function'
    ? element instanceof ElementConstructor
    : typeof element.style === 'object';
}

function isHtmlElementOfTag<K extends keyof HTMLElementTagNameMap>(
  value: unknown,
  tagName: K,
): value is HTMLElementTagNameMap[K] {
  return isHtmlElement(value) && value.tagName.toLowerCase() === tagName;
}

function getAnimationElements($elements: JQuery<HTMLElement>): HTMLElement[] {
  return $elements.get().filter(isHtmlElement);
}
function clearAnimationStyles(elements: HTMLElement[]): void {
  if (!elements.length) return;
  gsap.set(elements, { clearProps: 'opacity,visibility,transform' });
}

// 入场动效只使用透明度和 transform,不改变尺寸或位置布局,避免额外重排与 GPU 常驻合成。
function animateEntrance(
  motionMedia: PopupMotionMedia,
  $elements: JQuery<HTMLElement>,
  options: EntranceAnimationOptions = {},
): void {
  const elements = getAnimationElements($elements);
  if (!elements.length) return;

  gsap.killTweensOf(elements);
  motionMedia.add({ reduceMotion: '(prefers-reduced-motion: reduce)' }, context => {
    if (context.conditions?.reduceMotion) {
      clearAnimationStyles(elements);
      return;
    }

    gsap.fromTo(
      elements,
      {
        autoAlpha: 0,
        x: options.x ?? 0,
        y: options.y ?? 8,
        scale: options.scale ?? 1,
      },
      {
        autoAlpha: 1,
        x: 0,
        y: 0,
        scale: 1,
        delay: options.delay ?? 0,
        duration: options.duration ?? 0.26,
        stagger: options.stagger ?? 0.04,
        ease: options.ease ?? 'power1.out',
        overwrite: 'auto',
        clearProps: 'opacity,visibility,transform',
      },
    );
  });
}

function prefersReducedMotion(element: HTMLElement): boolean {
  return element.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

type PopupMicroInteractions = {
  showFeedback: () => void;
  hideFeedback: (onHidden: () => void) => void;
  animateNavigationSelection: (button: HTMLButtonElement, direction: number) => void;
  syncNavigationCursor: (button: HTMLButtonElement, animate?: boolean) => void;
  animateStateChange: (element: HTMLElement) => void;
  animateToggle: (input: HTMLInputElement) => void;
  destroy: () => void;
};

// 像素风控件使用短促按压和回弹，位移保持在 1px，避免破坏硬边框的稳定感。
function mountPopupMicroInteractions($root: JQuery<HTMLElement>): PopupMicroInteractions {
  const root = $root.get(0);
  const animatedElements = new Set<HTMLElement>();
  const noOp = () => {};
  if (!root) {
    return {
      showFeedback: noOp,
      hideFeedback: (onHidden: () => void) => onHidden(),
      animateNavigationSelection: noOp,
      syncNavigationCursor: noOp,
      animateStateChange: noOp,
      animateToggle: noOp,
      destroy: noOp,
    };
  }

  const track = (element: HTMLElement): HTMLElement => {
    animatedElements.add(element);
    return element;
  };

  const animatePress = (element: HTMLElement): void => {
    if (prefersReducedMotion(element)) return;
    track(element);
    gsap.killTweensOf(element);
    gsap
      .timeline({ defaults: { overwrite: 'auto' } })
      .to(element, { y: 1, scale: 0.99, duration: 0.055, ease: 'power1.out' })
      .to(element, {
        y: 0,
        scale: 1,
        duration: 0.14,
        ease: 'back.out(2)',
        clearProps: 'transform',
      });
  };

  const animateStateChange = (element: HTMLElement): void => {
    if (prefersReducedMotion(element)) return;
    track(element);
    gsap.killTweensOf(element);
    gsap.fromTo(
      element,
      { autoAlpha: 0.72, y: -2 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.18,
        ease: 'power1.out',
        overwrite: 'auto',
        clearProps: 'opacity,visibility,transform',
      },
    );
  };

  const animateNavigationSelection = (button: HTMLButtonElement, direction: number): void => {
    const icon = button.querySelector<HTMLElement>('.fa-solid');
    const label = button.querySelector<HTMLElement>('.tlao-nav-label');
    const elements = [icon, label].filter((element): element is HTMLElement => Boolean(element));
    if (!elements.length || prefersReducedMotion(button)) return;
    elements.forEach(track);
    gsap.killTweensOf(elements);
    const offset = direction >= 0 ? 1 : -1;
    const timeline = gsap.timeline({ defaults: { overwrite: 'auto' } });
    if (icon) {
      timeline.fromTo(
        icon,
        { autoAlpha: 0.45, x: offset * 6, scale: 0.72 },
        {
          autoAlpha: 1,
          x: 0,
          scale: 1,
          duration: 0.26,
          ease: 'back.out(2.2)',
          clearProps: 'opacity,visibility,transform',
        },
      );
    }
    if (label) {
      timeline.fromTo(
        label,
        { autoAlpha: 0.62, x: offset * 8 },
        {
          autoAlpha: 1,
          x: 0,
          duration: 0.24,
          ease: 'power2.out',
          clearProps: 'opacity,visibility,transform',
        },
        icon ? '<0.025' : 0,
      );
    }
  };

  let cursorWidth = 0;
  let cursorHeight = 0;
  const syncNavigationCursor = (button: HTMLButtonElement, animate = true): void => {
    const nav = button.closest<HTMLElement>('.tlao-nav');
    const cursor = nav?.querySelector<HTMLElement>('.tlao-nav-cursor');
    if (!nav || !cursor) return;

    const ready = cursor.classList.contains('is-ready');
    // 先集中读取布局；连续点击保留当前 transform，从当前位置继续移动。
    const x = button.offsetLeft;
    const y = button.offsetTop;
    const width = button.offsetWidth;
    const height = button.offsetHeight;
    track(cursor);
    gsap.killTweensOf(cursor);
    if (width !== cursorWidth || height !== cursorHeight) {
      cursor.style.width = `${width}px`;
      cursor.style.height = `${height}px`;
      cursorWidth = width;
      cursorHeight = height;
    }
    cursor.classList.add('is-ready');

    if (!ready || !animate || prefersReducedMotion(button)) {
      gsap.set(cursor, { x, y });
      return;
    }

    gsap.to(cursor, { x, y, duration: 0.26, ease: 'power2.out', overwrite: true });
  };

  const showFeedback = (): void => {
    const feedback = root.querySelector<HTMLElement>('.tlao-popup-feedback:not([hidden])');
    if (!feedback) return;
    track(feedback);
    gsap.killTweensOf(feedback);
    if (prefersReducedMotion(feedback)) {
      gsap.set(feedback, { clearProps: 'opacity,visibility,transform' });
      return;
    }
    gsap.fromTo(
      feedback,
      { autoAlpha: 0, y: -5, scale: 0.99 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: 0.2,
        ease: 'power1.out',
        overwrite: true,
        clearProps: 'opacity,visibility,transform',
      },
    );
  };

  const hideFeedback = (onHidden: () => void): void => {
    const feedback = root.querySelector<HTMLElement>('.tlao-popup-feedback:not([hidden])');
    if (!feedback || prefersReducedMotion(feedback)) {
      onHidden();
      return;
    }
    track(feedback);
    gsap.killTweensOf(feedback);
    gsap.to(feedback, {
      autoAlpha: 0,
      y: -4,
      duration: 0.12,
      ease: 'power1.in',
      overwrite: true,
      onComplete: onHidden,
    });
  };

  const handleClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const control = target?.closest<HTMLElement>(
      '.menu_button:not(:disabled), .tlao-nav-btn:not(:disabled), .tlao-provider-switch-btn:not(:disabled), .tlao-dropdown-trigger:not(:disabled), .tlao-explicit-popup-close, .tlao-editor-popup-close, .tlao-popup-feedback-close, .tlao-worldbook-book-open, .tlao-worldbook-book-row[data-worldbook-name], .tlao-model-option:not(:disabled)',
    );
    if (control && root.contains(control) && !control.matches('.tlao-nav-btn')) animatePress(control);
  };

  const animateToggle = (input: HTMLInputElement): void => {
    const indicator = input.closest('.tlao-switch')?.querySelector<HTMLElement>('.tlao-switch-track') ?? input;
    if (prefersReducedMotion(indicator)) return;
    track(indicator);
    gsap.killTweensOf(indicator);
    gsap.fromTo(
      indicator,
      { scale: 0.88 },
      {
        scale: 1,
        duration: 0.2,
        ease: 'back.out(2.6)',
        overwrite: 'auto',
        clearProps: 'transform',
      },
    );
  };

  const handleChange = (event: Event): void => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.('input[type="checkbox"]') || !root.contains(input)) return;
    animateToggle(input);
  };

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  const handleResize = (): void => {
    const activeButton = root.querySelector<HTMLButtonElement>('.tlao-nav-btn.is-active');
    if (activeButton) syncNavigationCursor(activeButton, false);
  };
  root.ownerDocument.defaultView?.addEventListener('resize', handleResize);

  return {
    showFeedback,
    hideFeedback,
    animateNavigationSelection,
    syncNavigationCursor,
    animateStateChange,
    animateToggle,
    destroy() {
      root.removeEventListener('click', handleClick);
      root.removeEventListener('change', handleChange);
      root.ownerDocument.defaultView?.removeEventListener('resize', handleResize);
      gsap.killTweensOf(Array.from(animatedElements));
      animatedElements.clear();
    },
  };
}

function animateSettingsEntrance(motionMedia: PopupMotionMedia, $root: JQuery<HTMLElement>): void {
  // 只淡入可视内容容器，避免打开时多个大区域分别位移、错峰合成。
  const panels = getAnimationElements($root.find('.tlao-panels'));
  if (!panels.length) return;

  gsap.killTweensOf(panels);
  motionMedia.add({ reduceMotion: '(prefers-reduced-motion: reduce)' }, context => {
    if (context.conditions?.reduceMotion) {
      clearAnimationStyles(panels);
      return;
    }

    gsap.fromTo(
      panels,
      { opacity: 0.75 },
      {
        opacity: 1,
        duration: 0.16,
        ease: 'power1.out',
        overwrite: 'auto',
        clearProps: 'opacity',
      },
    );
  });
}

function applyPopupTheme(...nodes: Array<JQuery<HTMLElement> | null | undefined>): void {
  for (const $node of nodes) $node?.addClass(POPUP_THEME_CLASS);
}

type PopupApi = ReturnType<typeof getPopupApi>;
type PopupFeedbackLevel = 'error' | 'warning' | 'info' | 'success';
type PopupFeedbackState = {
  level: PopupFeedbackLevel;
  message: string;
} | null;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPopupApi() {
  const ctx = (SillyTavern?.getContext?.() ?? SillyTavern) as {
    callGenericPopup?: (
      content: JQuery<HTMLElement> | string | Element,
      type: number,
      inputValue?: string,
      popupOptions?: SillyTavern.PopupOptions,
    ) => Promise<number | string | boolean | undefined>;
    POPUP_TYPE?: { DISPLAY?: number; TEXT?: number };
  };
  return ctx;
}

function getPopupFeedbackIcon(level: PopupFeedbackLevel): string {
  return level === 'success'
    ? 'fa-circle-check'
    : level === 'error'
      ? 'fa-circle-exclamation'
      : level === 'warning'
        ? 'fa-triangle-exclamation'
        : 'fa-circle-info';
}

function buildPopupFeedbackMarkup(feedback: NonNullable<PopupFeedbackState>): string {
  return [
    `<div id="tlao-popup-feedback" class="tlao-popup-feedback is-${feedback.level}">`,
    `<span class="tlao-popup-feedback-icon fa-solid ${getPopupFeedbackIcon(feedback.level)}" aria-hidden="true"></span>`,
    `<span class="tlao-popup-feedback-text">${escapeHtml(feedback.message)}</span>`,
    '<button type="button" class="tlao-popup-feedback-close fa-solid fa-xmark" aria-label="关闭提示" title="关闭提示"></button>',
    '</div>',
  ].join('');
}

function renderPopupFeedback(feedback: PopupFeedbackState): string {
  if (!feedback?.message) {
    return '<div id="tlao-popup-feedback" class="tlao-popup-feedback" hidden></div>';
  }

  return buildPopupFeedbackMarkup(feedback);
}

function applyPopupFeedback($root: JQuery<HTMLElement>, feedback: PopupFeedbackState): void {
  const $feedback = $root.find('#tlao-popup-feedback');
  if (!$feedback.length) return;

  if (!feedback?.message) {
    $feedback.attr('hidden', 'hidden').removeClass('is-error is-warning is-info is-success').empty();
    return;
  }

  $feedback
    .removeAttr('hidden')
    .removeClass('is-error is-warning is-info is-success')
    .addClass(`is-${feedback.level}`)
    .html(
      buildPopupFeedbackMarkup(feedback)
        .replace(/^<div[^>]*>/, '')
        .replace(/<\/div>$/, ''),
    );
}

function applyPopupChrome(
  $dialog: JQuery<HTMLElement>,
  popup?: { completeCancelled?: () => Promise<void> },
  mount?: JQuery<HTMLElement>,
): void {
  // cancelButton:false 时酒馆可能不创建原生关闭按钮,因此这里始终挂载一个明确的右上角关闭按钮。
  $dialog
    .find('.popup-button-close')
    .not('.tlao-explicit-popup-close')
    .addClass('tlao-native-close-hidden')
    .attr('hidden', 'hidden');

  $dialog.find('.tlao-explicit-popup-close').remove();
  const $close = $(
    '<button type="button" class="tlao-explicit-popup-close"><span class="fa-solid fa-xmark" aria-hidden="true"></span></button>',
  )
    .attr({
      role: 'button',
      'aria-label': '关闭弹窗',
      title: '关闭弹窗',
    })
    .on('click', () => {
      if (typeof popup?.completeCancelled === 'function') {
        void popup.completeCancelled();
        return;
      }

      const dialog = $dialog.get(0);
      if (isHtmlElementOfTag(dialog, 'dialog')) {
        dialog.close();
      }
    });

  (mount?.length ? mount : $dialog).append($close);
}

async function openReadonlyPreviewPopup(
  popupApi: PopupApi,
  title: string,
  subtitle: string,
  content: string,
): Promise<void> {
  const popupType = popupApi.POPUP_TYPE?.DISPLAY;
  const normalizedSubtitle = String(subtitle || '').trim();
  const normalizedContent = String(content || '').trim();
  const lineCount = normalizedContent ? normalizedContent.split(/\r?\n/).length : 0;
  const charCount = normalizedContent.length;
  if (typeof popupApi.callGenericPopup !== 'function' || typeof popupType !== 'number') {
    window.alert(`${title}${normalizedSubtitle ? `\n\n${normalizedSubtitle}` : ''}\n\n${normalizedContent}`);
    return;
  }

  const $content = $(`
    <div class="tlao-preview-popup ${POPUP_THEME_CLASS}">
      <div class="tlao-preview-hero">
        <h3>${escapeHtml(title)}</h3>
        ${normalizedSubtitle ? `<div class="muted">${escapeHtml(normalizedSubtitle)}</div>` : ''}
      </div>
      <div class="tlao-preview-meta">
        <span class="tlao-preview-chip">${lineCount} 行</span>
        <span class="tlao-preview-chip">${charCount} 字</span>
      </div>
      <div class="tlao-preview-surface">
        <pre class="tlao-preview-content"></pre>
      </div>
    </div>
  `);

  $content.find('.tlao-preview-content').text(normalizedContent || '暂无内容');
  const motionMedia = gsap.matchMedia();
  const interactions = mountPopupMicroInteractions($content);

  try {
    await popupApi.callGenericPopup($content, popupType, '', {
      okButton: false,
      cancelButton: false,
      wider: true,
      large: false,
      leftAlign: true,
      allowVerticalScrolling: false,
      // 预览内容已在调用前准备完成,禁用酒馆原生缩放动画避免小窗跳变。
      animation: 'none',
      onOpen: async popup => {
        const $dlg = $(popup.dlg);
        $dlg.addClass('tlao-preview-dialog');
        $dlg.find('.popup-controls, #dialogue_popup_controls').attr('hidden', 'hidden');
        applyPopupChrome($dlg, popup, $dlg.find('.tlao-preview-popup').first());
        applyPopupTheme($dlg);
        animateEntrance(motionMedia, $content.find('.tlao-preview-hero'), { y: -4, duration: 0.22 });
        animateEntrance(motionMedia, $content.find('.tlao-preview-meta'), { y: 4, duration: 0.22, delay: 0.04 });
        animateEntrance(motionMedia, $content.find('.tlao-preview-surface'), { y: 8, duration: 0.28, delay: 0.08 });
      },
    });
  } finally {
    interactions.destroy();
    motionMedia.revert();
  }
}

async function loadDraftSettings(): Promise<ScriptSettings | null> {
  return loadStoredDraftSettings();
}

function clearDraftSettings(): void {
  void clearStoredDraftSettings().catch(error => {
    console.warn('[AI行动选项] 清理设置草稿失败:', error);
  });
}

function summarizeEntryContent(content: string): string {
  const singleLine = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return '无正文';
  return singleLine.length > 86 ? `${singleLine.slice(0, 86)}...` : singleLine;
}

function formatEntryTitle(name: string, uid: number): string {
  const trimmed = String(name || '').trim();
  return trimmed || `UID ${uid}`;
}

function countSelectedKnowledgeEntries(settings: ScriptSettings, cache: Map<string, WorldbookEntry[]>): number {
  return settings.boundKnowledgeWorldbooks.reduce((sum, name) => {
    const cachedEntries = cache.get(name);
    if (!cachedEntries) return sum;
    const availableEntries = getAvailableWorldbookEntries(cachedEntries);
    return sum + getEffectiveSelectedEntries(settings.knowledgeWorldbookEntrySelections, name, availableEntries).length;
  }, 0);
}

function renderKnowledgeSummary(
  settings: ScriptSettings,
  cache: Map<string, WorldbookEntry[]>,
  characterSource: CurrentCharacterKnowledgeSource,
): string {
  const knowledgeEntries = countSelectedKnowledgeEntries(settings, cache);
  const preset = getResolvedOptionPreset(settings.optionPresetId, settings.customOptionPresets);
  if (characterSource.mode === 'worldbooks') {
    return `模板 ${preset.name} / 角色书 ${settings.boundKnowledgeWorldbooks.length} 本${knowledgeEntries ? ` · ${knowledgeEntries} 条` : ''}`;
  }
  if (characterSource.mode === 'description') {
    return `模板 ${preset.name} / 角色描述`;
  }
  return `模板 ${preset.name} / 无额外角色资料`;
}

function renderCharacterKnowledgeSourceCopy(characterSource: CurrentCharacterKnowledgeSource): string {
  const characterLabel = characterSource.characterName
    ? `当前角色卡「${characterSource.characterName}」`
    : '当前角色卡';
  if (characterSource.mode === 'worldbooks') {
    return `${characterLabel}的世界书会自动同步到这里，切换角色卡后会覆盖旧内容。MVU、变量、插图、文风类条目默认不勾选，可手动勾回。`;
  }
  if (characterSource.mode === 'description') {
    return `${characterLabel}没有绑定世界书，将自动读取角色描述；切换角色卡后会覆盖旧内容。`;
  }
  if (characterSource.mode === 'empty') {
    return `${characterLabel}没有可用的世界书或角色描述，生成时不会额外补角色资料。`;
  }
  return '当前没有激活角色卡，生成时不会额外补角色资料。';
}

function getCharacterKnowledgeModeLabel(characterSource: CurrentCharacterKnowledgeSource): string {
  if (characterSource.mode === 'worldbooks') {
    return `世界书 ${characterSource.worldbookNames.length} 本`;
  }
  if (characterSource.mode === 'description') {
    return '角色描述';
  }
  if (characterSource.mode === 'empty') {
    return '无角色资料';
  }
  return '未激活角色卡';
}

type StatTone = 'default' | 'success' | 'warning' | 'accent';

function renderStatCard(
  label: string,
  value: string,
  meta: string,
  tone: StatTone = 'default',
  icon = 'fa-circle-info',
): string {
  return [
    `<div class="tlao-stat ${tone === 'default' ? '' : `is-${tone}`}">`,
    '<div class="tlao-stat-top">',
    `<div class="tlao-stat-label">${escapeHtml(label)}</div>`,
    `<span class="tlao-stat-icon fa-solid ${icon}" aria-hidden="true"></span>`,
    '</div>',
    `<div class="tlao-stat-value">${escapeHtml(value)}</div>`,
    `<div class="tlao-stat-meta">${escapeHtml(meta)}</div>`,
    '</div>',
  ].join('');
}

function renderOverviewStats(settings: ScriptSettings, characterSource: CurrentCharacterKnowledgeSource): string {
  const providerLabel = settings.api.provider === 'deepseek' ? 'DeepSeek' : '自定义';
  const modelLabel = settings.api.model || '未填写模型';

  return [
    '<div class="tlao-stat-grid">',
    renderStatCard(
      '自动生成',
      settings.enabled ? '已开启' : '已关闭',
      settings.enabled ? '监听最新 AI 回复并自动追加' : '仅手动触发重生成',
      settings.enabled ? 'success' : 'warning',
      'fa-bolt',
    ),
    renderStatCard(
      '角色来源',
      getCharacterKnowledgeModeLabel(characterSource),
      characterSource.characterName ? characterSource.characterName : '当前没有角色卡',
      characterSource.mode === 'empty' || characterSource.mode === 'no_character' ? 'warning' : 'accent',
      'fa-book-open',
    ),
    renderStatCard(
      '上下文',
      `AI ${settings.assistantContextCount} 层`,
      '不会混入用户发送楼层',
      'default',
      'fa-layer-group',
    ),
    renderStatCard('当前模型', providerLabel, modelLabel, 'default', 'fa-microchip'),
    '</div>',
  ].join('');
}

function renderSidebarSnapshot(settings: ScriptSettings, characterSource: CurrentCharacterKnowledgeSource): string {
  const providerLabel = settings.api.provider === 'deepseek' ? 'DeepSeek 官方 API' : '自定义接口';
  const characterName = characterSource.characterName || '当前没有角色卡';
  const modelName = settings.api.model || '未填写';
  const preset = getResolvedOptionPreset(settings.optionPresetId, settings.customOptionPresets);

  return [
    '<div class="tlao-card">',
    '<div class="tlao-card-head">',
    '<div class="tlao-card-title">',
    '<h3>当前配置</h3>',
    '<div class="tlao-card-copy">保存后会以这里的配置生成行动选项。</div>',
    '</div>',
    `<span class="tlao-side-pill">${escapeHtml(getCharacterKnowledgeModeLabel(characterSource))}</span>`,
    '</div>',
    '<div class="tlao-snapshot-list">',
    `<div class="tlao-side-detail-row tlao-side-detail-row--preset"><span>模板</span><strong id="tlao-sidebar-preset-name">${escapeHtml(preset.name)}</strong></div>`,
    `<div class="tlao-side-detail-row"><span>角色卡</span><strong>${escapeHtml(characterName)}</strong></div>`,
    `<div class="tlao-side-detail-row"><span>服务商</span><strong>${escapeHtml(providerLabel)}</strong></div>`,
    `<div class="tlao-side-detail-row"><span>模型</span><strong>${escapeHtml(modelName)}</strong></div>`,
    `<div class="tlao-side-detail-row"><span>采样</span><strong>温度 ${escapeHtml(settings.api.temperature)} / 最大输出token ${escapeHtml(settings.api.maxTokens)}</strong></div>`,
    '</div>',
    '</div>',
  ].join('');
}

function renderKnowledgeBooks(
  settings: ScriptSettings,
  activeWorldbook: string,
  cache: Map<string, WorldbookEntry[]>,
  loading: Set<string>,
  characterSource: CurrentCharacterKnowledgeSource,
): string {
  if (characterSource.mode !== 'worldbooks') {
    return `<div class="tlao-empty muted">${escapeHtml(renderCharacterKnowledgeSourceCopy(characterSource))}</div>`;
  }

  const boundWorldbooks = settings.boundKnowledgeWorldbooks;
  const selections = settings.knowledgeWorldbookEntrySelections;
  const boundRows = boundWorldbooks.filter(Boolean).map(name => {
    const isActive = activeWorldbook === name;

    let rowMeta = '等待读取';
    const cachedEntries = cache.get(name);
    if (cachedEntries) {
      const availableEntries = getAvailableWorldbookEntries(cachedEntries);
      const selectedEntries = getEffectiveSelectedEntries(selections, name, availableEntries);
      rowMeta = availableEntries.length
        ? `已选 ${selectedEntries.length} / ${availableEntries.length} 条`
        : '无正文条目';
    } else if (loading.has(name)) {
      rowMeta = '读取中...';
    }

    return [
      `<div class="tlao-worldbook-book-row ${isActive ? 'is-active' : ''}" data-worldbook-row="${escapeHtml(name)}" data-worldbook-name="${escapeHtml(name)}">`,
      '<div class="tlao-worldbook-book-main">',
      `<button type="button" class="tlao-worldbook-book-open" data-worldbook-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`,
      '</div>',
      '<div class="tlao-worldbook-book-side">',
      `<span class="tlao-worldbook-book-meta muted">${escapeHtml(rowMeta)}</span>`,
      '</div>',
      '</div>',
    ].join('');
  });

  return [
    '<div class="tlao-worldbook-group">',
    '<div class="tlao-worldbook-group-title muted">当前角色卡世界书</div>',
    boundRows.length
      ? boundRows.join('')
      : `<div class="tlao-empty muted">${escapeHtml(renderCharacterKnowledgeSourceCopy(characterSource))}</div>`,
    '</div>',
  ].join('');
}

function renderKnowledgeEntryRows(
  settings: ScriptSettings,
  activeWorldbook: string,
  entryFilter: string,
  cache: Map<string, WorldbookEntry[]>,
): string {
  const entries = cache.get(activeWorldbook) ?? [];
  const availableEntries = getAvailableWorldbookEntries(entries);
  const selectedUidSet = new Set(
    getEffectiveSelectedEntryUids(settings.knowledgeWorldbookEntrySelections, activeWorldbook, availableEntries),
  );
  const normalizedFilter = entryFilter.trim().toLowerCase();
  const visibleEntries = availableEntries.filter(entry => {
    if (!normalizedFilter) return true;
    const haystack = `${entry.name || ''}\n${entry.content || ''}`.toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  if (!visibleEntries.length) {
    return '<div class="tlao-empty muted">没有匹配的正文条目，请换一个搜索词，或清空搜索查看全部内容。</div>';
  }

  return visibleEntries
    .map(entry => {
      const checked = selectedUidSet.has(entry.uid);
      return [
        `<label class="tlao-worldbook-entry-row" data-entry-uid="${entry.uid}">`,
        `<input type="checkbox" class="tlao-worldbook-entry-toggle" data-worldbook-name="${escapeHtml(activeWorldbook)}" data-entry-uid="${entry.uid}" ${checked ? 'checked' : ''}>`,
        '<span class="tlao-worldbook-entry-body">',
        `<span class="tlao-worldbook-entry-title">${escapeHtml(formatEntryTitle(entry.name, entry.uid))}</span>`,
        `<span class="tlao-worldbook-entry-preview muted">${escapeHtml(summarizeEntryContent(String(entry.content || '')))}</span>`,
        '</span>',
        '</label>',
      ].join('');
    })
    .join('');
}

async function openKnowledgeEntrySelectionPopup(
  popupApi: PopupApi,
  getSettings: () => ScriptSettings,
  worldbookName: string,
  cache: Map<string, WorldbookEntry[]>,
  errors: Map<string, string>,
  loadEntries: (worldbookName: string) => Promise<void>,
  updateWorldbookSelection: (worldbookName: string, selectedUids: number[]) => void,
): Promise<void> {
  const popupType = popupApi.POPUP_TYPE?.DISPLAY;
  if (typeof popupApi.callGenericPopup !== 'function' || typeof popupType !== 'number') {
    return;
  }

  let entryFilter = '';
  // 使用主设置页的实时主题,不要在子弹窗里重新按系统主题推断,避免刚切到浅色时回退深色。
  const $content = $('<div>').addClass(['tlao-knowledge-popup', POPUP_THEME_CLASS]);
  const motionMedia = gsap.matchMedia();
  const interactions = mountPopupMicroInteractions($content);
  let isPopupOpen = false;
  // 只在首次展示或异步读取完成时播放条目入场,勾选/搜索重绘保持稳定。
  let animateRowsOnNextRender = false;

  const renderPopupBody = (): string => {
    const error = errors.get(worldbookName);
    if (error) {
      return `<div class="tlao-empty muted">${escapeHtml(error)}</div>`;
    }

    const entries = cache.get(worldbookName);
    if (!entries) {
      return '<div class="tlao-empty muted">正在读取这本世界书的正文条目...</div>';
    }

    const availableEntries = getAvailableWorldbookEntries(entries);
    if (!availableEntries.length) {
      return '<div class="tlao-empty muted">这本世界书当前没有可供附加世界书使用的正文条目。</div>';
    }

    const currentSettings = getSettings();
    const selectedUidSet = new Set(
      getEffectiveSelectedEntryUids(currentSettings.knowledgeWorldbookEntrySelections, worldbookName, availableEntries),
    );

    return [
      `<div class="muted tlao-knowledge-popup-stats">共 ${availableEntries.length} 条正文条目，当前已选 ${selectedUidSet.size} 条。</div>`,
      '<div class="muted tlao-knowledge-popup-stats">默认会自动取消勾选 MVU / 变量 / 插图 / 文风类条目，你仍然可以手动勾回。</div>',
      `<div class="tlao-worldbook-entry-list">${renderKnowledgeEntryRows(currentSettings, worldbookName, entryFilter, cache)}</div>`,
    ].join('');
  };

  const render = (): void => {
    const previousScrollTop = $content.find('.tlao-worldbook-entry-list').scrollTop() ?? 0;
    const activeElement = document.activeElement as HTMLElement | null;
    const shouldRefocusFilter = activeElement?.id === 'tlao-knowledge-popup-entry-filter';
    const activeToggleUid =
      activeElement?.classList.contains('tlao-worldbook-entry-toggle') === true
        ? Number(activeElement.getAttribute('data-entry-uid'))
        : null;
    const shouldAnimateRows = isPopupOpen && animateRowsOnNextRender;
    if (isPopupOpen) animateRowsOnNextRender = false;
    // 酒馆部分版本会把关闭按钮放进内容容器,重绘条目时先暂存,但始终放回右上角。
    const detachedClose = $content.find('.tlao-explicit-popup-close').first().detach();
    $content.html(`
      <div class="tlao-knowledge-popup-head">
        <div>
          <h3>${escapeHtml(worldbookName)}</h3>
          <div class="muted">在这里勾选要发送给插件 AI 的附加世界书条目。</div>
        </div>
        <div class="tlao-worldbook-entry-buttons">
          <button type="button" class="menu_button tlao-mini-btn tlao-worldbook-select-all" data-worldbook-name="${escapeHtml(worldbookName)}">全选</button>
          <button type="button" class="menu_button tlao-mini-btn tlao-worldbook-clear-selection" data-worldbook-name="${escapeHtml(worldbookName)}">清空</button>
        </div>
      </div>
      <input id="tlao-knowledge-popup-entry-filter" class="text_pole wide100p" type="search" placeholder="搜索正文条目的标题或正文" value="${escapeHtml(entryFilter)}">
      <div class="tlao-knowledge-popup-body">
        ${renderPopupBody()}
      </div>
    `);

    if (detachedClose.length) {
      detachedClose
        .attr({
          role: 'button',
          'aria-label': '关闭弹窗',
          title: '关闭弹窗',
        })
        .prependTo($content);
    }

    const $entryList = $content.find('.tlao-worldbook-entry-list');
    if ($entryList.length) {
      $entryList.scrollTop(previousScrollTop);
    }

    if (shouldRefocusFilter) {
      const input = $content.find('#tlao-knowledge-popup-entry-filter').get(0);
      if (isHtmlElementOfTag(input, 'input')) {
        input.focus({ preventScroll: true });
        const caret = entryFilter.length;
        input.setSelectionRange(caret, caret);
      }
      return;
    }

    if (shouldAnimateRows) {
      animateEntrance(motionMedia, $content.find('.tlao-worldbook-entry-row'), {
        y: 6,
        duration: 0.22,
        stagger: 0.025,
      });
    }

    if (Number.isInteger(activeToggleUid)) {
      const toggle = $content.find(`.tlao-worldbook-entry-toggle[data-entry-uid="${activeToggleUid}"]`).get(0);
      if (isHtmlElementOfTag(toggle, 'input')) {
        toggle.focus({ preventScroll: true });
      }
    }
  };

  render();

  $content.on('input', '#tlao-knowledge-popup-entry-filter', event => {
    entryFilter = String((event.currentTarget as HTMLInputElement).value || '');
    render();
  });

  $content.on('change', '.tlao-worldbook-entry-toggle', event => {
    const entries = cache.get(worldbookName);
    if (!entries) return;

    const availableEntries = getAvailableWorldbookEntries(entries);
    const nextSelectedUids = new Set(
      getEffectiveSelectedEntryUids(getSettings().knowledgeWorldbookEntrySelections, worldbookName, availableEntries),
    );
    const uid = Number($(event.currentTarget).attr('data-entry-uid'));
    if (!Number.isInteger(uid)) return;

    if ((event.currentTarget as HTMLInputElement).checked) {
      nextSelectedUids.add(uid);
    } else {
      nextSelectedUids.delete(uid);
    }

    updateWorldbookSelection(worldbookName, Array.from(nextSelectedUids));
    render();
    const nextToggle = $content.find(`.tlao-worldbook-entry-toggle[data-entry-uid="${uid}"]`).get(0);
    if (isHtmlElementOfTag(nextToggle, 'input')) interactions.animateToggle(nextToggle);
  });

  $content.on('click', '.tlao-worldbook-select-all', () => {
    const entries = cache.get(worldbookName);
    if (!entries) return;
    const availableEntries = getAvailableWorldbookEntries(entries);
    updateWorldbookSelection(
      worldbookName,
      availableEntries.map(entry => entry.uid),
    );
    render();
  });

  $content.on('click', '.tlao-worldbook-clear-selection', () => {
    updateWorldbookSelection(worldbookName, []);
    render();
  });

  void loadEntries(worldbookName).then(() => {
    animateRowsOnNextRender = true;
    render();
  });

  try {
    await popupApi.callGenericPopup($content, popupType, '', {
      okButton: false,
      cancelButton: false,
      wider: true,
      large: false,
      leftAlign: true,
      allowVerticalScrolling: false,
      // 世界书选择弹窗同样直接呈现最终尺寸,避免先显示默认小窗。
      animation: 'none',
      onOpen: async popup => {
        const $dlg = $(popup.dlg);
        isPopupOpen = true;
        $dlg.removeClass('large_dialogue_popup vertical_scrolling_dialogue_popup');
        $dlg.addClass('tlao-preview-dialog tlao-knowledge-dialog');
        $dlg.find('.popup-controls, #dialogue_popup_controls').attr('hidden', 'hidden');
        applyPopupChrome($dlg, popup, $dlg.find('.tlao-knowledge-popup').first());
        applyPopupTheme($dlg);
        animateEntrance(motionMedia, $content.find('.tlao-knowledge-popup-head'), { y: -4, duration: 0.22 });
        animateEntrance(motionMedia, $content.find('#tlao-knowledge-popup-entry-filter'), {
          y: 5,
          duration: 0.22,
          delay: 0.04,
        });
        animateEntrance(motionMedia, $content.find('.tlao-knowledge-popup-stats'), {
          y: 5,
          duration: 0.22,
          delay: 0.06,
          stagger: 0.025,
        });
        animateEntrance(motionMedia, $content.find('.tlao-knowledge-popup-body'), {
          y: 8,
          duration: 0.28,
          delay: 0.08,
        });
        if (animateRowsOnNextRender) {
          animateRowsOnNextRender = false;
          animateEntrance(motionMedia, $content.find('.tlao-worldbook-entry-row'), {
            y: 6,
            duration: 0.22,
            delay: 0.12,
            stagger: 0.025,
          });
        }
      },
    });
  } finally {
    isPopupOpen = false;
    interactions.destroy();
    motionMedia.revert();
  }
}

type ModelFetchStatusTone = 'idle' | 'loading' | 'success' | 'warning' | 'error';

function getModelFetchButtonLabel(tone: ModelFetchStatusTone): string {
  switch (tone) {
    case 'loading':
      return '获取中...';
    case 'success':
      return '重新获取';
    case 'error':
      return '重试获取';
    default:
      return '获取模型';
  }
}

function parseModelFetchErrorMessage(message: string): string {
  const raw = String(message || '').trim();
  const statusCode = Number(raw.match(/模型列表请求失败\s*\((\d{3})\)/)?.[1] || 0) || null;
  const jsonStart = raw.indexOf('{');
  let detail = '';
  let errorType = '';
  let errorCode = '';

  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(raw.slice(jsonStart)) as Record<string, any>;
      detail = String(payload?.error?.message ?? payload?.message ?? '').trim();
      errorType = String(payload?.error?.type ?? payload?.type ?? '').trim();
      errorCode = String(payload?.error?.code ?? payload?.code ?? '').trim();
    } catch {
      detail = '';
    }
  }

  const merged = `${raw} ${detail} ${errorType} ${errorCode}`.toLowerCase();
  if (statusCode === 401 || /authentication_error|invalid_api_key|invalid/.test(merged)) {
    return 'API Key 无效或已失效，请检查后重试';
  }
  if (statusCode === 403) {
    return '当前 API Key 没有访问模型列表的权限';
  }
  if (statusCode === 404) {
    return '模型列表接口地址不可用，请检查服务商或 Base URL';
  }
  if (statusCode === 429) {
    return '请求过于频繁，请稍后重试';
  }
  if (statusCode != null && statusCode >= 500) {
    return '模型服务暂时不可用，请稍后重试';
  }
  if (/failed to fetch|networkerror|load failed|网络请求失败/i.test(raw)) {
    return '酒馆后端无法访问该接口，可能是网络、接口地址或代理配置限制；请检查 Base URL 和服务商状态';
  }
  if (/超时/.test(raw)) {
    return raw;
  }

  const normalizedDetail = detail || raw.replace(/^模型列表请求失败\s*\(\d{3}\):\s*/u, '').trim();
  if (!normalizedDetail) {
    return '未知错误，请稍后重试';
  }
  return normalizedDetail.length > 84 ? `${normalizedDetail.slice(0, 84)}...` : normalizedDetail;
}

function applyModelFetchUi($root: JQuery<HTMLElement>, tone: ModelFetchStatusTone, message = ''): void {
  const label = getModelFetchButtonLabel(tone);
  const $button = $root.find('#tlao-fetch-models');
  const $status = $root.find('#tlao-model-status');

  $button
    .prop('disabled', tone === 'loading')
    .toggleClass('is-loading', tone === 'loading')
    .attr('aria-label', label)
    .attr('title', label);

  $button.find('.tlao-model-fetch-label').text(label);
  $status.attr('data-tone', tone).text(message);
}

function renderModelPicker(models: string[], currentModel: string): string {
  if (!models.length) {
    return '<div id="tlao-model-select" class="tlao-model-picker" hidden></div>';
  }

  return [
    '<div id="tlao-model-select" class="tlao-model-picker" role="listbox" aria-label="已获取的模型列表">',
    models
      .map(model => {
        const active = model === currentModel;
        return `<button type="button" class="tlao-model-option ${active ? 'is-active' : ''}" data-model="${escapeHtml(model)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHtml(model)}</button>`;
      })
      .join(''),
    '</div>',
  ].join('');
}

function renderApiProviderSwitch(currentProvider: ScriptSettings['api']['provider']): string {
  return [
    `<input id="tlao-api-provider" type="hidden" value="${escapeHtml(currentProvider)}">`,
    '<div class="tlao-provider-switch" role="tablist" aria-label="选择 API 服务商">',
    `<button type="button" class="tlao-provider-switch-btn ${currentProvider === 'deepseek' ? 'is-active' : ''}" data-provider="deepseek" aria-pressed="${currentProvider === 'deepseek' ? 'true' : 'false'}">DeepSeek 官方 API</button>`,
    `<button type="button" class="tlao-provider-switch-btn ${currentProvider === 'openai' ? 'is-active' : ''}" data-provider="openai" aria-pressed="${currentProvider === 'openai' ? 'true' : 'false'}">自定义</button>`,
    '</div>',
  ].join('');
}

function renderPresetOptions(
  currentPresetId: string,
  customOptionPresets: ScriptSettings['customOptionPresets'],
): string {
  return getResolvedOptionPresets(customOptionPresets)
    .map(
      item =>
        `<option value="${escapeHtml(item.id)}" ${item.id === currentPresetId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`,
    )
    .join('');
}

async function openCustomOptionPresetEditorPopup(
  popupApi: PopupApi,
  presetId: CustomOptionPresetId,
  settings: ScriptSettings,
): Promise<CustomOptionPresetConfig | null> {
  const defaultConfig = getDefaultCustomOptionPresetConfig(presetId);
  const currentPreset = getResolvedOptionPreset(presetId, settings.customOptionPresets);
  let draftName = currentPreset.name;
  let draftBody = settings.customOptionPresets[presetId]?.editableBody ?? defaultConfig.editableBody;
  let feedback: PopupFeedbackState = null;

  return new Promise(resolve => {
    let settled = false;
    const motionMedia = gsap.matchMedia();

    const $modal = $(`
      <dialog class="tlao-editor-modal ${POPUP_THEME_CLASS}" aria-labelledby="tlao-custom-preset-editor-title">
        <div class="tlao-editor-popup tlao-editor-popup--standalone ${POPUP_THEME_CLASS}">
          <button type="button" class="tlao-editor-popup-close fa-solid fa-xmark" aria-label="关闭编辑自定义模板"></button>
          ${renderPopupFeedback(feedback)}
          <div class="tlao-editor-popup-head">
            <h3 id="tlao-custom-preset-editor-title">编辑自定义模板</h3>
            <div class="muted">只允许修改模板名称与规则正文，输出格式会保持固定。</div>
          </div>
          <label class="tlao-field">
            <span>模板名字</span>
            <input id="tlao-custom-preset-name" class="text_pole wide100p" type="text" maxlength="48" value="${escapeHtml(draftName)}">
          </label>
          <label class="tlao-field">
            <span>规则正文</span>
            <textarea id="tlao-custom-preset-body" class="text_pole wide100p tlao-editor-popup-textarea" rows="16">${escapeHtml(draftBody)}</textarea>
          </label>
          <div class="tlao-editor-popup-actions">
            <button type="button" id="tlao-preview-custom-preset" class="menu_button tlao-mini-btn">预览完整模板</button>
            <button type="button" id="tlao-reset-custom-preset" class="menu_button tlao-mini-btn">恢复默认</button>
            <button type="button" id="tlao-save-custom-preset" class="menu_button menu_button_primary tlao-editor-primary-btn">保存模板</button>
            <button type="button" id="tlao-cancel-custom-preset" class="menu_button tlao-editor-secondary-btn">取消</button>
          </div>
        </div>
      </dialog>
    `);
    const modalElement = $modal.get(0) as HTMLDialogElement | undefined;
    const interactions = mountPopupMicroInteractions($modal);

    const finish = (result: CustomOptionPresetConfig | null) => {
      if (settled) return;
      settled = true;
      motionMedia.revert();
      $(document).off('keydown.tlaoCustomPresetEditor', handleKeydown);
      $modal.removeClass('is-open');
      if (modalElement?.open && typeof modalElement.close === 'function') {
        modalElement.close();
      }
      window.setTimeout(() => {
        interactions.destroy();
        $modal.remove();
        resolve(result);
      }, 120);
    };

    const setFeedback = (nextFeedback: PopupFeedbackState) => {
      feedback = nextFeedback;
      if (!feedback) {
        interactions.hideFeedback(() => applyPopupFeedback($modal, null));
        return;
      }
      applyPopupFeedback($modal, feedback);
      interactions.showFeedback();
    };

    $modal.on('click', '.tlao-popup-feedback-close', () => {
      setFeedback(null);
    });

    const readDraft = () => {
      draftName = String($modal.find('#tlao-custom-preset-name').val() || '').trim();
      draftBody = String($modal.find('#tlao-custom-preset-body').val() || '').trim();
    };

    function handleKeydown(event: JQuery.KeyDownEvent): void {
      if ($modal.hasClass('is-previewing')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    }

    $modal.on('click', event => {
      if (event.target === $modal[0]) {
        finish(null);
      }
    });

    $modal.on('cancel', event => {
      event.preventDefault();
      if ($modal.hasClass('is-previewing')) return;
      finish(null);
    });

    $modal.on('click', '.tlao-editor-popup-close, #tlao-cancel-custom-preset', () => {
      finish(null);
    });

    $modal.on('click', '#tlao-reset-custom-preset', () => {
      draftName = defaultConfig.name;
      draftBody = defaultConfig.editableBody;
      $modal.find('#tlao-custom-preset-name').val(draftName);
      $modal.find('#tlao-custom-preset-body').val(draftBody);
      setFeedback({
        level: 'info',
        message: '已恢复该自定义模板的默认内容',
      });
    });

    $modal.on('click', '#tlao-preview-custom-preset', async () => {
      readDraft();
      const previewName = draftName || currentPreset.name;
      const previewBody = draftBody || defaultConfig.editableBody;
      const previewPreset = getResolvedOptionPreset(presetId, {
        ...settings.customOptionPresets,
        [presetId]: {
          name: previewName,
          editableBody: previewBody,
        },
      });
      $modal.addClass('is-previewing');
      try {
        await openReadonlyPreviewPopup(popupApi, `模板预览: ${previewPreset.name}`, '', previewPreset.prompt);
      } finally {
        $modal.removeClass('is-previewing');
      }
    });

    $modal.on('click', '#tlao-save-custom-preset', () => {
      readDraft();

      if (!draftName) {
        setFeedback({ level: 'warning', message: '请先填写模板名字' });
        return;
      }
      if (!draftBody) {
        setFeedback({ level: 'warning', message: '请先填写规则正文' });
        return;
      }

      finish({
        name: draftName,
        editableBody: draftBody,
      });
    });

    $modal.appendTo('body');
    if (modalElement && typeof modalElement.showModal === 'function') {
      modalElement.showModal();
    } else {
      $modal.attr('open', 'open');
    }
    $(document).on('keydown.tlaoCustomPresetEditor', handleKeydown);
    requestAnimationFrame(() => {
      $modal.addClass('is-open');
      animateEntrance(motionMedia, $modal.find('.tlao-editor-popup--standalone'), {
        y: 10,
        scale: 0.99,
        duration: 0.28,
      });
      interactions.showFeedback();
      $modal.find('#tlao-custom-preset-name').trigger('focus');
    });
  });
}

function renderApiProviderHint(provider: ScriptSettings['api']['provider']): string {
  if (provider !== 'deepseek') return '';
  return '<div class="muted tlao-api-provider-hint">DeepSeek 官方 API 使用内置接入地址，无需填写 Base URL。</div>';
}

function renderApiProviderExtra(settings: ScriptSettings): string {
  return `<label class="tlao-inline-checkbox" id="tlao-show-cache-usage-wrap">
    <input type="checkbox" id="tlao-show-cache-usage-in-success-popup" ${settings.showCacheUsageInSuccessPopup ? 'checked' : ''}>
    在成功弹窗显示价格估算（DeepSeek模型）
  </label>`;
}

function renderThinkingModeOptions(currentMode: ScriptSettings['api']['thinkingMode']): string {
  return [
    ['auto', '自动'],
    ['disabled', '关闭'],
    ['enabled', '开启'],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === currentMode ? 'selected' : ''}>${label}</option>`)
    .join('');
}

function renderReasoningEffortOptions(currentEffort: ScriptSettings['api']['reasoningEffort']): string {
  return [
    ['auto', '自动'],
    ['low', '低'],
    ['high', '高'],
    ['max', '最大'],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === currentEffort ? 'selected' : ''}>${label}</option>`)
    .join('');
}

function renderPromptMessages(settings: ScriptSettings): string {
  if (!settings.promptMessages.length) {
    return '<div class="tlao-empty muted">当前没有可预览的默认提示词。</div>';
  }

  return settings.promptMessages
    .map((message, index) => {
      return [
        `<div class="tlao-prompt-card" data-prompt-id="${escapeHtml(message.id)}">`,
        '<div class="tlao-prompt-toolbar">',
        '<div class="tlao-prompt-meta">',
        `<span class="tlao-prompt-index">消息 ${index + 1}</span>`,
        `<span class="tlao-role-select">${escapeHtml(message.role)}</span>`,
        '</div>',
        '<div class="tlao-prompt-actions">',
        `<span class="muted">${message.enabled ? '默认启用' : '默认停用'}</span>`,
        `<button type="button" class="menu_button tlao-mini-btn tlao-prompt-preview" data-prompt-id="${escapeHtml(message.id)}">打开预览</button>`,
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    })
    .join('');
}

const UPDATE_ENDPOINT_LABELS: Record<UpdateEndpoint, string> = {
  auto: '自动选择（推荐）',
  testingcf: 'testingcf.jsdelivr（国内优先）',
  jsdelivr: 'cdn.jsdelivr（可能需要代理）',
  github: 'GitHub Raw（可能需要代理）',
};

function renderUpdateEndpointOptions(current: UpdateEndpoint): string {
  return (Object.entries(UPDATE_ENDPOINT_LABELS) as Array<[UpdateEndpoint, string]>)
    .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`)
    .join('');
}

function formatUpdateTime(value: number | null): string {
  if (!value) return '尚未检查';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function renderUpdateReleases(state: UpdateRuntimeState): string {
  if (!state.manifest) return '';
  return `
    <div class="tlao-update-release-list" aria-label="可用版本">
      ${state.manifest.versions
        .map(release => {
          const comparison = compareVersions(release.version, SCRIPT_VERSION);
          const isLatest = release.version === state.manifest?.latest;
          const relation = comparison > 0 ? '新版本' : comparison === 0 ? '当前版本' : '旧版本';
          return `
            <details class="tlao-update-release ${isLatest ? 'is-latest' : ''}" ${isLatest ? 'open' : ''}>
              <summary>
                <span class="tlao-update-release-title">v${escapeHtml(release.version)}</span>
                <span class="tlao-update-release-meta">${escapeHtml(release.releasedAt)} · ${release.channel === 'beta' ? '测试版' : '正式版'} · ${relation}</span>
              </summary>
              <div class="tlao-update-release-body">
                <ul>${release.changes.map(change => `<li>${escapeHtml(change)}</li>`).join('')}</ul>
                <button type="button" class="menu_button tlao-update-install" data-version="${escapeHtml(release.version)}">
                  ${comparison === 0 ? '重新安装' : comparison > 0 ? '安装此版本' : '回退到此版本'}
                </button>
              </div>
            </details>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderUpdateRuntime(state: UpdateRuntimeState): string {
  const endpointLabel = state.endpointUsed ? UPDATE_ENDPOINT_LABELS[state.endpointUsed] : '';
  let title = '尚未检查更新';
  let detail = '点击“立即检查”获取版本清单。';
  let tone = 'idle';

  if (state.status === 'checking') {
    title = '正在检查更新…';
    detail = '正在连接更新端点。';
    tone = 'checking';
  } else if (state.status === 'error') {
    title = '检查失败';
    detail = state.error || '更新端点暂时不可用。';
    tone = 'error';
  } else if (state.manifest) {
    title = state.hasUpdate ? `发现新版本 v${state.manifest.latest}` : '当前已是最新版本';
    detail = `${endpointLabel} · ${formatUpdateTime(state.checkedAt)}`;
    tone = state.hasUpdate ? 'available' : 'success';
  }

  return `
    <div class="tlao-update-status is-${tone}" role="status" aria-live="polite">
      <span class="tlao-update-status-icon fa-solid ${state.status === 'checking' ? 'fa-rotate' : state.status === 'error' ? 'fa-triangle-exclamation' : state.hasUpdate ? 'fa-circle-arrow-up' : 'fa-circle-check'}" aria-hidden="true"></span>
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>
    </div>
    ${renderUpdateReleases(state)}
  `;
}

function renderUpdatePanel(settings: ScriptSettings, state: UpdateRuntimeState): string {
  return `
    <div class="tlao-card">
      <div class="tlao-card-head">
        <div class="tlao-card-title">
          <h3>检查更新</h3>
          <div class="tlao-card-copy">当前版本 v${escapeHtml(SCRIPT_VERSION)}</div>
        </div>
        <button type="button" id="tlao-check-updates" class="menu_button tlao-mini-btn" ${state.status === 'checking' ? 'disabled' : ''}>
          <span class="fa-solid fa-rotate" aria-hidden="true"></span>
          <span>${state.status === 'checking' ? '正在检查' : '立即检查'}</span>
        </button>
      </div>
      <div class="tlao-update-settings">
        <label class="tlao-switch">
          <input type="checkbox" id="tlao-update-automatic" ${settings.updates.automaticCheck ? 'checked' : ''}>
          <span class="tlao-switch-track" aria-hidden="true"></span>
          <span class="tlao-switch-label">自动检查更新</span>
        </label>
        <label class="tlao-field">
          <span>更新端点</span>
          <span class="tlao-select-control">
            <select id="tlao-update-endpoint" class="text_pole wide100p">
              ${renderUpdateEndpointOptions(settings.updates.endpoint)}
            </select>
          </span>
        </label>
      </div>
      <div class="tlao-card-copy">自动检查最多每 24 小时请求一次；发现新版本时只显示红点，不会自动安装。</div>
    </div>
    <div id="tlao-update-runtime">${renderUpdateRuntime(state)}</div>
  `;
}

function applyUpdateState($root: JQuery<HTMLElement>, state: UpdateRuntimeState): void {
  $root.find('#tlao-update-runtime').html(renderUpdateRuntime(state));
  $root
    .find('#tlao-check-updates')
    .prop('disabled', state.status === 'checking')
    .find('span:last-child')
    .text(state.status === 'checking' ? '正在检查' : '立即检查');
  $root.find('.tlao-update-dot').toggleClass('is-visible', state.hasUpdate);
  $root.find('[data-panel="updates"]').each((_index, element) => {
    const label = state.hasUpdate ? '更新（有新版本）' : '更新';
    $(element).attr({ 'aria-label': label, title: label });
  });
}

function renderPopupRoot(
  settings: ScriptSettings,
  activeWorldbook: string,
  cache: Map<string, WorldbookEntry[]>,
  errors: Map<string, string>,
  loading: Set<string>,
  modelOptions: string[],
  feedback: PopupFeedbackState,
  characterSource: CurrentCharacterKnowledgeSource,
): JQuery<HTMLElement> {
  const preset = getResolvedOptionPreset(settings.optionPresetId, settings.customOptionPresets);
  const isDeepSeekProvider = settings.api.provider === 'deepseek';
  const isCustomPreset = isCustomOptionPresetId(settings.optionPresetId);

  const $root = $('<div>').addClass(ROOT_CLASS).addClass(POPUP_THEME_CLASS);
  $root.html(`
    <header class="tlao-topbar">
      <div class="tlao-brand">
        <span class="tlao-brand-icon fa-solid fa-list-check" aria-hidden="true"></span>
        <div class="tlao-brand-copy">
          <div class="tlao-brand-name">AI 行动选项 <span class="tlao-brand-version">v${escapeHtml(SCRIPT_VERSION)}</span></div>
          <div class="tlao-brand-sub">管理自动生成、行动模板和外接模型，让最新回复保持可继续操作</div>
        </div>
      </div>
      <div class="tlao-topbar-actions">
        <span class="tlao-status-pill ${settings.enabled ? '' : 'is-off'}" id="tlao-topbar-status">${settings.enabled ? '自动生成已开启' : '自动生成已关闭'}</span>
      </div>
    </header>
    ${renderPopupFeedback(feedback)}
    <div class="tlao-layout">
      <nav class="tlao-nav" aria-label="设置分区导航">
        <span class="tlao-nav-cursor" aria-hidden="true"></span>
        <button type="button" class="tlao-nav-btn is-active" data-panel="overview"><span class="fa-solid fa-gauge-high" aria-hidden="true"></span><span class="tlao-nav-label">概览</span></button>
        <button type="button" class="tlao-nav-btn" data-panel="generation-template"><span class="fa-solid fa-sliders" aria-hidden="true"></span><span class="tlao-nav-label">生成与模板</span></button>
        <button type="button" class="tlao-nav-btn" data-panel="knowledge"><span class="fa-solid fa-book-open" aria-hidden="true"></span><span class="tlao-nav-label">附加世界书</span></button>
        <button type="button" class="tlao-nav-btn" data-panel="api"><span class="fa-solid fa-plug" aria-hidden="true"></span><span class="tlao-nav-label">外接 API</span></button>
        <button type="button" class="tlao-nav-btn tlao-update-desktop-entry" data-panel="updates" aria-label="更新">
          <span class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></span><span class="tlao-nav-label">更新</span><span class="tlao-update-dot ${getUpdateState().hasUpdate ? 'is-visible' : ''}" aria-hidden="true"></span>
        </button>
        <button type="button" class="tlao-nav-btn tlao-preview-feature-entry" disabled aria-disabled="true" title="功能预览，暂不可用">
          <span class="fa-solid fa-timeline" aria-hidden="true"></span><span class="tlao-nav-label">剧情时间线</span><span class="tlao-preview-feature-badge">预览</span>
        </button>
      </nav>
      <div class="tlao-panels">
        <section class="tlao-panel" data-panel-content="overview" aria-label="概览">
          ${renderOverviewStats(settings, characterSource)}
          ${renderSidebarSnapshot(settings, characterSource)}
        </section>

        <section class="tlao-panel tlao-panel--generation-template" data-panel-content="generation-template" hidden aria-label="生成与模板">
          <div class="tlao-card">
              <div class="tlao-card-head tlao-card-head--auto-generation">
                <div class="tlao-card-title">
                  <h3>自动生成</h3>
                <div class="tlao-card-copy">控制脚本何时读取最新 AI 回复，并把行动选项写回楼层末尾。</div>
              </div>
              <label class="tlao-switch">
                <input type="checkbox" id="tlao-enabled" ${settings.enabled ? 'checked' : ''}>
                <span class="tlao-switch-track" aria-hidden="true"></span>
                <span class="tlao-switch-label" id="tlao-enabled-state">${settings.enabled ? '已开启自动追加' : '当前仅手动触发'}</span>
              </label>
            </div>
            <div class="tlao-grid tlao-grid--single">
              <label class="tlao-field">
                <span>读取最近 AI 回复层数</span>
                <input id="tlao-assistant-context-count" class="text_pole wide100p" type="number" min="1" step="1" aria-describedby="tlao-context-cost-hint" value="${escapeHtml(settings.assistantContextCount)}">
              </label>
            </div>
            <div class="tlao-card-copy">生成时会把目标楼层往前最近 N 层 AI 回复一起发给模型，默认 2 层，不包含用户发送楼层。</div>
            <div id="tlao-context-cost-hint" class="tlao-context-cost-hint"><strong>读取层数越多，通常消耗更多 Token</strong>，也更有助于选项衔接前文；实际效果取决于模型与剧情内容。</div>
          </div>
          ${renderSummarySettings(settings)}
          <div class="tlao-card">
            <div class="tlao-card-head">
              <div class="tlao-card-title">
                <h3>内置选项模板</h3>
                <div class="tlao-card-copy">选择脚本生成行动选项时使用的固定模板。</div>
              </div>
              <div class="tlao-summary tlao-side-pill">${escapeHtml(renderKnowledgeSummary(settings, cache, characterSource))}</div>
            </div>
            <label class="tlao-field">
              <span>当前模板</span>
              <span class="tlao-select-control">
                <select id="tlao-option-preset-id" class="text_pole wide100p">
                  ${renderPresetOptions(settings.optionPresetId, settings.customOptionPresets)}
                </select>
              </span>
              <div id="tlao-option-preset-summary" class="tlao-card-copy">${escapeHtml(preset.summary)}</div>
            </label>
            <div class="tlao-preset-actions">
              <button type="button" id="tlao-preview-option-preset" class="menu_button tlao-mini-btn">预览模板内容</button>
              <button type="button" id="tlao-edit-custom-option-preset" class="menu_button tlao-mini-btn" ${isCustomPreset ? '' : 'disabled'}>${isCustomPreset ? '编辑自定义模板' : '仅自定义模板可编辑'}</button>
            </div>
          </div>
          <div class="tlao-card" hidden>
            <div class="tlao-card-head">
              <div class="tlao-card-title">
                <h3>默认提示词预览</h3>
              </div>
            </div>
            <div id="tlao-prompt-list" class="tlao-prompt-list">
              ${renderPromptMessages(settings)}
            </div>
          </div>
        </section>

        <section class="tlao-panel" data-panel-content="knowledge" hidden aria-label="附加世界书">
          <div class="tlao-card">
            <div class="tlao-card-head">
              <div class="tlao-card-title">
                <h3>${KNOWLEDGEBOOK_TITLE}</h3>
                <div class="tlao-card-copy">${escapeHtml(renderCharacterKnowledgeSourceCopy(characterSource))}</div>
              </div>
              <span class="tlao-side-pill">自动覆盖旧角色资料</span>
            </div>
            <div class="tlao-worldbook-layout">
              <div class="tlao-worldbook-pane">
                <div class="tlao-worldbook-pane-head">
                  <span>点书名后可调整默认勾选条目。</span>
                </div>
                <div id="tlao-worldbook-book-list">
                  ${renderKnowledgeBooks(settings, activeWorldbook, cache, loading, characterSource)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="tlao-panel" data-panel-content="api" hidden aria-label="外接 API">
          <div class="tlao-card">
            <div class="tlao-card-head">
              <div class="tlao-card-title">
                <h3>外接 API</h3>
                <div class="tlao-card-copy">支持 DeepSeek 官方 API，也支持自定义兼容接口。</div>
              </div>
            </div>
            <div class="tlao-grid tlao-grid--api">
              <div class="tlao-field tlao-api-field tlao-api-field--provider">
                <span>服务商</span>
                ${renderApiProviderSwitch(settings.api.provider)}
              </div>
              <label class="tlao-field tlao-api-field tlao-api-field--base-url" id="tlao-api-base-url-wrap" ${isDeepSeekProvider ? 'hidden' : ''}>
                <span>Base URL</span>
                <input id="tlao-api-base-url" class="text_pole wide100p" type="text" value="${escapeHtml(settings.api.baseUrl)}" placeholder="${escapeHtml(isDeepSeekProvider ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')}">
              </label>
              <div id="tlao-api-provider-hint-slot" class="tlao-api-provider-slot ${isDeepSeekProvider ? '' : 'hidden'}">
                ${renderApiProviderHint(settings.api.provider)}
              </div>
              <label class="tlao-field tlao-api-field tlao-api-field--key">
                <span>API Key</span>
                <input id="tlao-api-key" class="text_pole wide100p" type="password" value="${escapeHtml(settings.api.apiKey)}" placeholder="sk-...">
              </label>
              <div class="tlao-field tlao-api-field tlao-api-field--model">
                <span>模型</span>
                <div class="tlao-model-control">
                  <div class="tlao-model-row">
                    <input id="tlao-api-model" class="text_pole wide100p" type="text" value="${escapeHtml(settings.api.model)}" placeholder="${escapeHtml(isDeepSeekProvider ? 'deepseek-flash' : '自行填写或先获取模型列表')}" autocomplete="off">
                    <button type="button" id="tlao-fetch-models" class="menu_button tlao-icon-btn tlao-model-fetch-btn" aria-label="获取模型" title="获取模型" aria-controls="tlao-model-select" aria-expanded="${modelOptions.length ? 'true' : 'false'}">
                      <span class="fa-solid fa-rotate" aria-hidden="true"></span>
                      <span class="tlao-model-fetch-label">获取模型</span>
                    </button>
                  </div>
                  ${renderModelPicker(modelOptions, settings.api.model)}
                </div>
                <div id="tlao-model-status" class="tlao-model-status" data-tone="idle"></div>
              </div>
              <label class="tlao-field tlao-api-field tlao-api-field--temperature">
                <span>温度</span>
                <input id="tlao-api-temperature" class="text_pole wide100p" type="number" min="0" max="2" step="0.1" value="${escapeHtml(settings.api.temperature)}">
              </label>
              <label class="tlao-field tlao-api-field tlao-api-field--max-tokens">
                <span>最大输出token</span>
                <input id="tlao-api-max-tokens" class="text_pole wide100p" type="number" min="1" max="32768" step="1" value="${escapeHtml(settings.api.maxTokens)}">
              </label>
              <label class="tlao-field tlao-api-field tlao-api-field--timeout">
                <span>超时（毫秒）</span>
                <input id="tlao-api-timeout-ms" class="text_pole wide100p" type="number" min="3000" max="300000" step="1000" value="${escapeHtml(settings.api.timeoutMs)}">
              </label>
              <label class="tlao-field tlao-api-field tlao-api-field--thinking-mode">
                <span>思考模式</span>
                <span class="tlao-select-control">
                  <select id="tlao-api-thinking-mode" class="text_pole wide100p" ${isDeepSeekProvider ? '' : 'disabled'}>
                    ${renderThinkingModeOptions(settings.api.thinkingMode)}
                  </select>
                </span>
              </label>
              <label class="tlao-field tlao-api-field tlao-api-field--reasoning-effort">
                <span>思考强度</span>
                <span class="tlao-select-control">
                  <select id="tlao-api-reasoning-effort" class="text_pole wide100p">
                    ${renderReasoningEffortOptions(settings.api.reasoningEffort)}
                  </select>
                </span>
              </label>
              <div id="tlao-api-provider-extra-slot" class="tlao-api-provider-extra-slot">
                ${renderApiProviderExtra(settings)}
              </div>
            </div>
          </div>
        </section>

        <section class="tlao-panel tlao-panel--updates" data-panel-content="updates" hidden aria-label="更新">
          ${renderUpdatePanel(settings, getUpdateState())}
        </section>
      </div>
    </div>
    <footer class="tlao-footbar">
      <span class="tlao-footbar-credit">
        <span class="tlao-footbar-credit-label">作者</span>
        <strong class="tlao-footbar-credit-name">emo的lsp</strong>
      </span>
      <button type="button" class="tlao-update-mobile-entry" data-panel="updates" aria-label="更新" title="更新">
        <span class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></span>
        <span>更新</span>
        <span class="tlao-update-dot ${getUpdateState().hasUpdate ? 'is-visible' : ''}" aria-hidden="true"></span>
      </button>
      <span class="tlao-footbar-hint">修改会自动保存并立即生效</span>
    </footer>
  `);

  return $root;
}

function getApiConfigFromInputs(
  $root: JQuery<HTMLElement>,
  fallback: ScriptSettings['api'],
): ScriptSettings['apiProviderConfigs'][ScriptSettings['api']['provider']] {
  const baseUrlValue = $root.find('#tlao-api-base-url').val();
  const apiKeyValue = $root.find('#tlao-api-key').val();
  const modelValue = $root.find('#tlao-api-model').val();
  const temperatureValue = $root.find('#tlao-api-temperature').val();
  const maxTokensValue = $root.find('#tlao-api-max-tokens').val();
  const timeoutMsValue = $root.find('#tlao-api-timeout-ms').val();
  const thinkingModeValue = String($root.find('#tlao-api-thinking-mode').val() || '');
  const reasoningEffortValue = String($root.find('#tlao-api-reasoning-effort').val() || '');

  return {
    baseUrl: String(baseUrlValue ?? fallback.baseUrl).trim(),
    apiKey: String(apiKeyValue ?? fallback.apiKey).trim(),
    model: String(modelValue ?? fallback.model).trim(),
    temperature: temperatureValue === '' || temperatureValue == null ? fallback.temperature : Number(temperatureValue),
    maxTokens: maxTokensValue === '' || maxTokensValue == null ? fallback.maxTokens : Number(maxTokensValue),
    timeoutMs: timeoutMsValue === '' || timeoutMsValue == null ? fallback.timeoutMs : Number(timeoutMsValue),
    thinkingControlVersion: fallback.thinkingControlVersion,
    thinkingMode:
      thinkingModeValue === 'disabled' || thinkingModeValue === 'enabled' || thinkingModeValue === 'auto'
        ? thinkingModeValue
        : fallback.thinkingMode,
    reasoningEffort:
      reasoningEffortValue === 'low' ||
      reasoningEffortValue === 'high' ||
      reasoningEffortValue === 'max' ||
      reasoningEffortValue === 'auto'
        ? reasoningEffortValue
        : fallback.reasoningEffort,
  };
}

function syncActiveApiProviderConfig(
  $root: JQuery<HTMLElement>,
  draft: ScriptSettings,
  provider: ScriptSettings['api']['provider'] = draft.api.provider,
): void {
  const nextConfig = getApiConfigFromInputs($root, draft.api);
  draft.apiProviderConfigs[provider] = {
    ...draft.apiProviderConfigs[provider],
    ...nextConfig,
  };
  if (draft.api.provider === provider) {
    draft.api = {
      provider,
      ...draft.apiProviderConfigs[provider],
    };
  }
}

function applyStoredApiProviderConfig(draft: ScriptSettings, provider: ScriptSettings['api']['provider']): void {
  const fallback = getDefaultApiSettings(provider);
  const providerConfig = draft.apiProviderConfigs[provider] ?? {
    baseUrl: fallback.baseUrl,
    apiKey: fallback.apiKey,
    model: fallback.model,
    temperature: fallback.temperature,
    maxTokens: fallback.maxTokens,
    timeoutMs: fallback.timeoutMs,
    thinkingControlVersion: fallback.thinkingControlVersion,
    thinkingMode: fallback.thinkingMode,
    reasoningEffort: fallback.reasoningEffort,
  };

  draft.api.provider = provider;
  draft.api = {
    provider,
    ...providerConfig,
  };
  draft.apiProviderConfigs[provider] = { ...providerConfig };
}

function syncDraftFromInputs($root: JQuery<HTMLElement>, draft: ScriptSettings): void {
  draft.enabled = Boolean($root.find('#tlao-enabled').prop('checked'));
  draft.assistantContextCount = Number(
    $root.find('#tlao-assistant-context-count').val() || draft.assistantContextCount,
  );
  syncSummaryInputs($root, draft);
  draft.optionPresetId = String($root.find('#tlao-option-preset-id').val() || draft.optionPresetId).trim();
  draft.api.provider =
    String($root.find('#tlao-api-provider').val() || draft.api.provider).trim() === 'openai' ? 'openai' : 'deepseek';
  draft.showCacheUsageInSuccessPopup = Boolean($root.find('#tlao-show-cache-usage-in-success-popup').prop('checked'));
  draft.updates.automaticCheck = Boolean($root.find('#tlao-update-automatic').prop('checked'));
  const updateEndpoint = String($root.find('#tlao-update-endpoint').val() || draft.updates.endpoint);
  draft.updates.endpoint = ['auto', 'testingcf', 'jsdelivr', 'github'].includes(updateEndpoint)
    ? (updateEndpoint as UpdateEndpoint)
    : 'auto';
  syncActiveApiProviderConfig($root, draft, draft.api.provider);
  draft.promptMessages = getDefaultPromptMessages();
}

export async function openSettingsPopup(initialSettings: ScriptSettings): Promise<ScriptSettings | null> {
  const popupApi = getPopupApi();
  const popupType = popupApi.POPUP_TYPE?.DISPLAY ?? popupApi.POPUP_TYPE?.TEXT;
  if (typeof popupApi.callGenericPopup !== 'function' || typeof popupType !== 'number') {
    console.error('[AI行动选项] 当前酒馆环境不支持原生弹窗接口');
    return null;
  }

  const recoveredDraft = await loadDraftSettings();
  const initialSyncResult = await syncSettingsWithCurrentCharacterKnowledgeSource(
    cloneSettings(recoveredDraft ?? initialSettings),
  );
  let draft = initialSyncResult.settings;
  if (recoveredDraft) {
    try {
      // 旧版本使用草稿存储,首次打开时迁移到正式设置,之后统一即时保存。
      draft = await saveSettings(draft);
      clearDraftSettings();
    } catch (error) {
      console.warn('[AI行动选项] 迁移旧设置草稿失败:', error);
    }
  }
  let characterSource = initialSyncResult.source;
  let activeWorldbook = draft.boundKnowledgeWorldbooks[0] || '';
  let modelOptions: string[] = [];
  const worldbookCache = new Map<string, WorldbookEntry[]>();
  const worldbookErrors = new Map<string, string>();
  const loadingWorldbooks = new Set<string>();
  let popupFeedback: PopupFeedbackState = recoveredDraft
    ? {
        level: 'info',
        message: initialSyncResult.changed ? '已恢复设置草稿，并同步当前角色卡补充资料' : '已恢复上次未保存的设置草稿',
      }
    : null;

  while (true) {
    const motionMedia = gsap.matchMedia();
    let activePanelName = 'overview';
    let updateState = getUpdateState();
    const $root = renderPopupRoot(
      draft,
      activeWorldbook,
      worldbookCache,
      worldbookErrors,
      loadingWorldbooks,
      modelOptions,
      popupFeedback,
      characterSource,
    );
    const dropdowns = mountCustomSelects($root);
    const interactions = mountPopupMicroInteractions($root);
    const unsubscribeUpdateState = subscribeUpdateState(state => {
      updateState = state;
      applyUpdateState($root, state);
    });
    const summaryUi = mountSummarySettings(
      $root,
      () => {
        syncDraftFromInputs($root, draft);
        return normalizeSettings(draft);
      },
      (title, subtitle, content) => openReadonlyPreviewPopup(popupApi, title, subtitle, content),
    );
    let autosaveTimer: number | null = null;
    let panelTransition: gsap.core.Timeline | null = null;

    const setPopupFeedback = (level: PopupFeedbackLevel, message: string): void => {
      popupFeedback = { level, message };
      applyPopupFeedback($root, popupFeedback);
      interactions.showFeedback();
    };

    const ensureActiveWorldbook = (): void => {
      if (activeWorldbook && draft.boundKnowledgeWorldbooks.includes(activeWorldbook)) return;
      activeWorldbook = draft.boundKnowledgeWorldbooks[0] || '';
    };

    const refreshPresetUi = (): void => {
      const preset = getResolvedOptionPreset(draft.optionPresetId, draft.customOptionPresets);
      const isCustomPreset = isCustomOptionPresetId(draft.optionPresetId);
      $root
        .find('#tlao-option-preset-id')
        .html(renderPresetOptions(draft.optionPresetId, draft.customOptionPresets))
        .val(draft.optionPresetId);
      $root.find('#tlao-option-preset-summary').text(preset.summary);
      $root.find('#tlao-sidebar-preset-name').text(preset.name);
      $root
        .find('#tlao-edit-custom-option-preset')
        .prop('disabled', !isCustomPreset)
        .text(isCustomPreset ? '编辑自定义模板' : '仅自定义模板可编辑');
      dropdowns.refresh();
    };

    const renderSummary = (): void => {
      $root.find('.tlao-summary').text(renderKnowledgeSummary(draft, worldbookCache, characterSource));
      refreshPresetUi();
    };

    const applyApiProviderPreset = (provider: ScriptSettings['api']['provider']): void => {
      applyStoredApiProviderConfig(draft, provider);
      const isDeepSeek = provider === 'deepseek';
      const defaults = getDefaultApiSettings(provider);

      $root.find('#tlao-api-provider').val(provider);
      $root
        .find('.tlao-provider-switch-btn')
        .removeClass('is-active')
        .attr('aria-pressed', 'false')
        .filter(`[data-provider="${provider}"]`)
        .addClass('is-active')
        .attr('aria-pressed', 'true');
      $root.find('#tlao-api-base-url').attr('placeholder', defaults.baseUrl).val(draft.api.baseUrl);
      $root.find('#tlao-api-key').val(draft.api.apiKey);
      $root
        .find('#tlao-api-model')
        .attr('placeholder', isDeepSeek ? 'deepseek-flash' : '自行填写或先获取模型列表')
        .val(draft.api.model);
      $root
        .find('.tlao-model-option')
        .removeClass('is-active')
        .attr('aria-pressed', 'false')
        .each((_, element) => {
          const $element = $(element);
          if (String($element.attr('data-model') || '') !== draft.api.model) return;
          $element.addClass('is-active').attr('aria-pressed', 'true');
        });
      $root.find('#tlao-api-temperature').val(String(draft.api.temperature));
      $root.find('#tlao-api-max-tokens').val(String(draft.api.maxTokens));
      $root.find('#tlao-api-timeout-ms').val(String(draft.api.timeoutMs));
      $root.find('#tlao-api-thinking-mode').val(draft.api.thinkingMode).prop('disabled', !isDeepSeek);
      $root.find('#tlao-api-reasoning-effort').val(draft.api.reasoningEffort);

      $root.find('#tlao-api-base-url-wrap').prop('hidden', isDeepSeek).toggleClass('hidden', isDeepSeek);
      $root
        .find('#tlao-api-provider-hint-slot')
        .prop('hidden', !isDeepSeek)
        .toggleClass('hidden', !isDeepSeek)
        .html(renderApiProviderHint(provider));
      $root.find('#tlao-api-provider-extra-slot').html(renderApiProviderExtra(draft));
      dropdowns.refresh();
    };

    const renderWorldbookBookList = (): void => {
      $root
        .find('#tlao-worldbook-book-list')
        .html(renderKnowledgeBooks(draft, activeWorldbook, worldbookCache, loadingWorldbooks, characterSource));
    };

    const revealActiveWorldbookRow = (): void => {
      window.requestAnimationFrame(() => {
        const row = $root.find('.tlao-worldbook-book-row.is-active').get(0);
        if (isHtmlElement(row)) {
          row.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
          });
        }
      });
    };

    const updateWorldbookSelection = (worldbookName: string, selectedUids: number[]): void => {
      const entries = worldbookCache.get(worldbookName);
      if (!entries) return;

      const availableEntries = getAvailableWorldbookEntries(entries);
      const compacted = compactEntrySelectionForStorage(availableEntries, selectedUids);
      if (compacted == null) {
        delete draft.knowledgeWorldbookEntrySelections[worldbookName];
      } else {
        draft.knowledgeWorldbookEntrySelections[worldbookName] = compacted;
      }

      rerenderWorldbookUi();
      void persistSettingsNow().catch(error => {
        console.warn('[AI行动选项] 自动保存世界书条目选择失败:', error);
      });
    };

    const rerenderWorldbookUi = (): void => {
      ensureActiveWorldbook();
      renderSummary();
      renderWorldbookBookList();
      revealActiveWorldbookRow();
    };

    const openBoundWorldbookSelection = (worldbookName: string): void => {
      if (!worldbookName) return;
      activeWorldbook = worldbookName;
      rerenderWorldbookUi();
      void openKnowledgeEntrySelectionPopup(
        popupApi,
        () => draft,
        activeWorldbook,
        worldbookCache,
        worldbookErrors,
        loadWorldbookEntries,
        updateWorldbookSelection,
      );
    };

    const loadWorldbookEntries = async (worldbookName: string): Promise<void> => {
      if (
        !worldbookName ||
        worldbookCache.has(worldbookName) ||
        worldbookErrors.has(worldbookName) ||
        loadingWorldbooks.has(worldbookName)
      ) {
        renderWorldbookBookList();
        return;
      }

      loadingWorldbooks.add(worldbookName);
      renderWorldbookBookList();

      try {
        const entries = await readWorldbookEntries(worldbookName);
        worldbookCache.set(worldbookName, entries);
      } catch (error) {
        const message = (error as Error)?.message || '读取失败';
        worldbookErrors.set(worldbookName, message);
      } finally {
        loadingWorldbooks.delete(worldbookName);
      }

      renderSummary();
      renderWorldbookBookList();
    };

    const persistSettingsSoon = (): void => {
      if (autosaveTimer != null) {
        window.clearTimeout(autosaveTimer);
      }
      autosaveTimer = window.setTimeout(() => {
        autosaveTimer = null;
        syncDraftFromInputs($root, draft);
        draft = normalizeSettings(draft);
        renderSummary();
        void saveSettings(draft)
          .then(savedSettings => {
            draft = savedSettings;
            renderSummary();
          })
          .catch(error => {
            console.warn('[AI行动选项] 自动保存设置失败:', error);
            setPopupFeedback('error', `自动保存失败：${(error as Error)?.message || '未知错误'}`);
          });
      }, 320);
    };

    const persistSettingsNow = async (): Promise<void> => {
      if (autosaveTimer != null) {
        window.clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      syncDraftFromInputs($root, draft);
      draft = normalizeSettings(draft);
      draft = await saveSettings(draft);
      renderSummary();
    };

    $root.on('click', '.tlao-popup-feedback-close', () => {
      popupFeedback = null;
      interactions.hideFeedback(() => applyPopupFeedback($root, null));
    });

    $root.on('click', '.tlao-nav-btn, .tlao-update-mobile-entry', event => {
      const panelName = String($(event.currentTarget).attr('data-panel') || '');
      if (panelTransition) {
        const activeTransition = panelTransition;
        panelTransition = null;
        activeTransition.progress(1);
        activeTransition.kill();
      }
      if (!panelName || panelName === activePanelName) return;
      const panelOrder = ['overview', 'generation-template', 'knowledge', 'api', 'updates'];
      const direction = panelOrder.indexOf(panelName) >= panelOrder.indexOf(activePanelName) ? 1 : -1;
      const $activeButton = $root
        .find('.tlao-nav-btn')
        .removeClass('is-active')
        .filter(`[data-panel="${panelName}"]`)
        .addClass('is-active');
      $root.find('.tlao-update-mobile-entry').toggleClass('is-active', panelName === 'updates');
      const activeButton = $activeButton.get(0);
      if ($(event.currentTarget).hasClass('tlao-nav-btn') && isHtmlElementOfTag(activeButton, 'button')) {
        interactions.animateNavigationSelection(activeButton, direction);
        interactions.syncNavigationCursor(activeButton);
      } else {
        $root.find('.tlao-nav-cursor').removeClass('is-ready');
      }
      const $currentPanel = $root.find(`[data-panel-content="${activePanelName}"]`);
      const $nextPanel = $root.find(`[data-panel-content="${panelName}"]`);
      const currentPanel = $currentPanel.get(0);
      const nextPanel = $nextPanel.get(0);
      if (!isHtmlElement(currentPanel) || !isHtmlElement(nextPanel)) return;

      gsap.killTweensOf([currentPanel, nextPanel]);
      if (prefersReducedMotion(nextPanel)) {
        $currentPanel.prop('hidden', true);
        $nextPanel.prop('hidden', false);
        clearAnimationStyles([currentPanel, nextPanel]);
        activePanelName = panelName;
        return;
      }

      panelTransition = gsap.timeline({
        onComplete: () => {
          panelTransition = null;
        },
      });
      panelTransition
        .to(currentPanel, {
          autoAlpha: 0,
          x: direction * -14,
          scale: 0.99,
          duration: 0.13,
          ease: 'power1.in',
          overwrite: true,
          onComplete: () => {
            $currentPanel.prop('hidden', true);
            clearAnimationStyles([currentPanel]);
            $nextPanel.prop('hidden', false);
            activePanelName = panelName;
          },
        })
        .fromTo(
          nextPanel,
          {
            autoAlpha: 0.18,
            x: direction * 28,
            scale: 0.98,
          },
          {
            autoAlpha: 1,
            x: 0,
            scale: 1,
            duration: 0.34,
            ease: 'power3.out',
            overwrite: true,
            clearProps: 'opacity,visibility,transform',
          },
        );
    });

    $root.on('change', '#tlao-enabled', event => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      $root.find('#tlao-enabled-state').text(enabled ? '已开启自动追加' : '当前仅手动触发');
      $root
        .find('#tlao-topbar-status')
        .toggleClass('is-off', !enabled)
        .text(enabled ? '自动生成已开启' : '自动生成已关闭');
      const status = $root.find('#tlao-topbar-status').get(0);
      if (isHtmlElement(status)) interactions.animateStateChange(status);
    });

    $root.on('click', '#tlao-check-updates', async () => {
      syncDraftFromInputs($root, draft);
      draft = normalizeSettings(draft);
      try {
        await persistSettingsNow();
        await checkForUpdates({ endpoint: draft.updates.endpoint, force: true });
      } catch (error) {
        console.warn('[AI行动选项] 手动检查更新失败:', error);
        setPopupFeedback('error', `检查更新失败：${(error as Error)?.message || '未知错误'}`);
      }
    });

    $root.on('click', '.tlao-update-install', async event => {
      const version = String($(event.currentTarget).attr('data-version') || '');
      const release = updateState.manifest?.versions.find(item => item.version === version);
      if (!release) {
        setPopupFeedback('error', '未找到要安装的版本信息');
        return;
      }

      const comparison = compareVersions(release.version, SCRIPT_VERSION);
      const action = comparison < 0 ? '回退' : comparison === 0 ? '重新安装' : '更新';
      if (!window.confirm(`确定要${action}到 v${release.version} 吗？\n\n脚本将在校验通过后替换并重新加载。`)) return;

      const $button = $(event.currentTarget).prop('disabled', true).text('正在安装…');
      try {
        await persistSettingsNow();
        await installUpdate(release, draft.updates.endpoint);
      } catch (error) {
        console.error('[AI行动选项] 安装更新失败:', error);
        setPopupFeedback('error', `安装失败：${(error as Error)?.message || '未知错误'}`);
        $button
          .prop('disabled', false)
          .text(comparison < 0 ? '回退到此版本' : comparison === 0 ? '重新安装' : '安装此版本');
      }
    });

    $root.on('change', '#tlao-option-preset-id', event => {
      draft.optionPresetId = String((event.currentTarget as HTMLSelectElement).value || draft.optionPresetId);
      draft = normalizeSettings(draft);
      renderSummary();
      persistSettingsSoon();
    });

    $root.on('click', '.tlao-provider-switch-btn', event => {
      const previousProvider = draft.api.provider;
      syncActiveApiProviderConfig($root, draft, previousProvider);
      const provider =
        String($(event.currentTarget).attr('data-provider') || '').trim() === 'openai' ? 'openai' : 'deepseek';
      $root.find('#tlao-api-provider').val(provider);
      applyApiProviderPreset(provider);
      draft = normalizeSettings(draft);
      modelOptions = [];
      $root.find('#tlao-model-select').prop('hidden', true).empty();
      $root.find('#tlao-fetch-models').attr('aria-expanded', 'false');
      applyModelFetchUi($root, 'idle', '');
      animateEntrance(
        motionMedia,
        $root.find(
          '#tlao-api-base-url-wrap:not([hidden]), #tlao-api-provider-hint-slot:not([hidden]), #tlao-api-provider-extra-slot',
        ),
        {
          x: provider === 'openai' ? 8 : -8,
          y: 0,
          duration: 0.2,
          stagger: 0.025,
        },
      );
      void persistSettingsNow().catch(error => {
        console.warn('[AI行动选项] 自动保存 API 服务商失败:', error);
      });
    });

    $root.on('click', '#tlao-preview-option-preset', async () => {
      const preset = getResolvedOptionPreset(draft.optionPresetId, draft.customOptionPresets);
      await openReadonlyPreviewPopup(popupApi, `模板预览: ${preset.name}`, '', preset.prompt);
    });

    $root.on('click', '#tlao-edit-custom-option-preset', async () => {
      if (!isCustomOptionPresetId(draft.optionPresetId)) {
        setPopupFeedback('warning', '请先切换到一个自定义模板再编辑');
        return;
      }

      const edited = await openCustomOptionPresetEditorPopup(popupApi, draft.optionPresetId, draft);
      if (!edited) return;

      const presetId = draft.optionPresetId;
      draft.customOptionPresets[presetId] = edited;
      draft = normalizeSettings(draft);
      try {
        await persistSettingsNow();
        setPopupFeedback('success', `已自动保存自定义模板「${edited.name}」`);
      } catch (error) {
        console.warn('[AI行动选项] 保存自定义模板失败:', error);
        setPopupFeedback('error', `自定义模板保存失败：${(error as Error)?.message || '未知错误'}`);
      }
    });

    $root.on('input change', 'input, textarea, select', event => {
      const targetId = (event.currentTarget as HTMLElement).id;
      if (targetId === 'tlao-model-select') {
        return;
      }
      persistSettingsSoon();
    });

    $root.on('click', '#tlao-fetch-models', async () => {
      const $select = $root.find('#tlao-model-select');

      syncDraftFromInputs($root, draft);
      draft = normalizeSettings(draft);
      if (!draft.api.apiKey) {
        applyModelFetchUi($root, 'warning', '请先填写 API Key');
        setPopupFeedback('warning', '请先填写 API Key');
        return;
      }
      if (draft.api.provider !== 'deepseek' && !draft.api.baseUrl) {
        applyModelFetchUi($root, 'warning', '请先填写 Base URL');
        setPopupFeedback('warning', '请先填写 Base URL');
        return;
      }

      applyModelFetchUi($root, 'loading', '正在获取模型列表...');

      try {
        modelOptions = await fetchAvailableModels(draft);
        $select.replaceWith($(renderModelPicker(modelOptions, draft.api.model)));
        $root.find('#tlao-fetch-models').attr('aria-expanded', 'true');
        applyModelFetchUi($root, 'success', `已获取 ${modelOptions.length} 个模型`);
      } catch (error) {
        const message = (error as Error)?.message || '未知错误';
        const conciseMessage = parseModelFetchErrorMessage(message);
        applyModelFetchUi($root, 'error', `获取失败：${conciseMessage}`);
        setPopupFeedback('error', `获取模型列表失败：${conciseMessage}`);
      }
    });

    $root.on('click', '.tlao-model-option', event => {
      const model = String($(event.currentTarget).attr('data-model') || '').trim();
      if (!model) return;
      $root.find('#tlao-api-model').val(model);
      $root.find('.tlao-model-option').removeClass('is-active').attr('aria-pressed', 'false');
      $(event.currentTarget).addClass('is-active').attr('aria-pressed', 'true');
      $root.find('#tlao-model-select').prop('hidden', true);
      $root.find('#tlao-fetch-models').attr('aria-expanded', 'false');
      syncDraftFromInputs($root, draft);
      draft = normalizeSettings(draft);
      void persistSettingsNow().catch(error => {
        console.warn('[AI行动选项] 自动保存模型选择失败:', error);
      });
    });

    $root.on('click', '.tlao-worldbook-book-open', event => {
      openBoundWorldbookSelection(String($(event.currentTarget).attr('data-worldbook-name') || ''));
    });

    $root.on('click', '.tlao-worldbook-book-row[data-worldbook-name]', event => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.tlao-worldbook-book-open')) {
        return;
      }
      openBoundWorldbookSelection(String($(event.currentTarget).attr('data-worldbook-name') || ''));
    });

    $root.on('click', '.tlao-prompt-preview', async event => {
      const promptId = String($(event.currentTarget).data('promptId') || '');
      const message = draft.promptMessages.find(item => item.id === promptId);
      if (!message) return;

      await openReadonlyPreviewPopup(
        popupApi,
        `默认提示词预览: ${message.role}`,
        '当前为内置默认提示词，只允许预览，打开设置页时会静默恢复默认内容。',
        message.content,
      );
    });

    ensureActiveWorldbook();
    renderSummary();
    applyApiProviderPreset(draft.api.provider);

    try {
      await popupApi.callGenericPopup($root, popupType, '', {
        okButton: false,
        cancelButton: false,
        wider: true,
        // 由本地布局负责响应式尺寸,不启用酒馆的 large 弹窗预设,避免打开时先套用小窗尺寸。
        large: false,
        leftAlign: true,
        allowVerticalScrolling: true,
        animation: 'none',
        onOpen: async popup => {
          const $dlg = $(popup.dlg);
          $dlg.addClass('tlao-settings-popup');
          $dlg.find('.popup-controls, #dialogue_popup_controls').attr('hidden', 'hidden');
          applyPopupChrome($dlg, popup, $dlg.find('.tlao-topbar').first());
          applyPopupTheme($dlg);
          animateSettingsEntrance(motionMedia, $root);
          summaryUi.refresh();
          interactions.showFeedback();
          const activeButton = $root.find('.tlao-nav-btn.is-active').get(0);
          if (isHtmlElementOfTag(activeButton, 'button')) {
            window.requestAnimationFrame(() => interactions.syncNavigationCursor(activeButton, false));
          }
        },
      });
    } finally {
      panelTransition?.kill();
      gsap.killTweensOf($root.find('[data-panel-content]').get());
      unsubscribeUpdateState();
      dropdowns.destroy();
      summaryUi.destroy();
      interactions.destroy();
      motionMedia.revert();
    }

    let persisted = true;
    try {
      await persistSettingsNow();
    } catch (error) {
      persisted = false;
      console.warn('[AI行动选项] 关闭设置页前自动保存失败:', error);
    }

    const syncedDraftResult = await syncSettingsWithCurrentCharacterKnowledgeSource(draft);
    draft = syncedDraftResult.settings;
    characterSource = syncedDraftResult.source;
    if (syncedDraftResult.changed) {
      try {
        draft = await saveSettings(draft);
        persisted = true;
      } catch (error) {
        persisted = false;
        console.warn('[AI行动选项] 保存角色资料同步结果失败:', error);
      }
    }
    if (persisted) clearDraftSettings();
    return draft;
  }
}
