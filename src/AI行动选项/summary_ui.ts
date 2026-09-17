import { describeSummaryContext, formatSummaryPreview, readActionContext } from './context';
import type { ScriptSettings } from './types';

export function renderSummarySettings(settings: ScriptSettings): string {
  const config = settings.summary;
  return `
    <div class="tlao-card">
      <div class="tlao-card-head">
        <div class="tlao-card-title"><h3>更早剧情摘要</h3></div>
        <button type="button" id="tlao-preview-summaries" class="menu_button tlao-mini-btn">预览摘要</button>
      </div>
      <div class="tlao-grid">
        <label class="tlao-field">
          <span>摘要读取</span>
          <span class="tlao-select-control"><select id="tlao-summary-mode" class="text_pole wide100p">
            <option value="off" ${config.mode === 'off' ? 'selected' : ''}>关闭</option>
            <option value="recent" ${config.mode === 'recent' ? 'selected' : ''}>指定层数</option>
            <option value="all" ${config.mode === 'all' ? 'selected' : ''}>全部更早摘要</option>
          </select></span>
        </label>
        <label class="tlao-field" id="tlao-summary-count-wrap" ${config.mode === 'recent' ? '' : 'hidden'}>
          <span>向前读取 AI 回复层数</span>
          <input id="tlao-summary-count" class="text_pole wide100p" type="number" min="1" step="1" value="${config.count}">
        </label>
        <label class="tlao-field">
          <span>摘要标签</span>
          <span class="tlao-select-control"><select id="tlao-summary-tag-mode" class="text_pole wide100p">
            <option value="auto" ${config.tagMode === 'auto' ? 'selected' : ''}>自动识别</option>
            <option value="custom" ${config.tagMode === 'custom' ? 'selected' : ''}>自定义</option>
          </select></span>
        </label>
        <label class="tlao-field" id="tlao-summary-tag-wrap" ${config.tagMode === 'custom' ? '' : 'hidden'}>
          <span>自定义标签名</span>
          <input id="tlao-summary-custom-tag" class="text_pole wide100p" type="text" placeholder="summary 或 小总结" value="${_.escape(config.customTag)}">
        </label>
      </div>
      <div class="tlao-card-copy">从完整正文之前读取；已包含正文的楼层不重复追加摘要。全部模式随聊天增长，通常消耗更多 Token。</div>
      <div id="tlao-summary-status" class="tlao-summary-status" role="status">等待检测</div>
    </div>`;
}

export function syncSummaryInputs($root: JQuery<HTMLElement>, draft: ScriptSettings): void {
  draft.summary = {
    mode: String($root.find('#tlao-summary-mode').val()) as ScriptSettings['summary']['mode'],
    count: Number($root.find('#tlao-summary-count').val()),
    tagMode: String($root.find('#tlao-summary-tag-mode').val()) as ScriptSettings['summary']['tagMode'],
    customTag: String($root.find('#tlao-summary-custom-tag').val() ?? ''),
  };
}

export function mountSummarySettings(
  $root: JQuery<HTMLElement>,
  getSettings: () => ScriptSettings,
  openPreview: (title: string, subtitle: string, content: string) => Promise<void>,
): { refresh: () => void; destroy: () => void } {
  let timer: number | undefined;
  let revision = 0;
  let disposed = false;
  const $status = $root.find('#tlao-summary-status');
  const refresh = (): void => {
    window.clearTimeout(timer);
    const version = ++revision;
    const settings = getSettings();
    $root.find('#tlao-summary-count-wrap').prop('hidden', settings.summary.mode !== 'recent');
    $root.find('#tlao-summary-tag-wrap').prop('hidden', settings.summary.tagMode !== 'custom');
    $status.text('检测中…');
    timer = window.setTimeout(async () => {
      try {
        const context = await readActionContext(undefined, settings.assistantContextCount, settings.summary, true);
        if (disposed || revision !== version) return;
        $status.text(context
          ? [describeSummaryContext(context), ...context.summary.notes].join('；')
          : '当前没有可读取的 AI 回复');
      } catch (error) {
        if (!disposed && revision === version) $status.text(`检测失败：${(error as Error).message}`);
      }
    }, 240);
  };
  $root.on('input.tlaoSummary change.tlaoSummary', '#tlao-summary-mode, #tlao-summary-count, #tlao-summary-tag-mode, #tlao-summary-custom-tag, #tlao-assistant-context-count', refresh);
  $root.on('click.tlaoSummary', '#tlao-preview-summaries', async () => {
    const settings = getSettings();
    const $button = $root.find('#tlao-preview-summaries').prop('disabled', true);
    try {
      // 每次预览重新读取当前聊天，与生成共用读取函数，不使用上一次聊天的检测缓存。
      const context = await readActionContext(undefined, settings.assistantContextCount, settings.summary, true);
      if (disposed) return;
      if (!context) {
        $status.text('当前没有可读取的 AI 回复');
        return;
      }
      $status.text(describeSummaryContext(context));
      await openPreview('摘要预览', '逐层核对提取内容与读取范围', formatSummaryPreview(context, settings.summary));
    } catch (error) {
      if (!disposed) $status.text(`预览失败：${(error as Error).message}`);
    } finally {
      $button.prop('disabled', false);
    }
  });
  const listeners = [
    tavern_events.CHAT_CHANGED, tavern_events.MESSAGE_EDITED, tavern_events.MESSAGE_DELETED,
    tavern_events.MESSAGE_SWIPED, tavern_events.MESSAGE_RECEIVED, tavern_events.OAI_PRESET_CHANGED_AFTER,
  ].map(event => eventOn(event, refresh));
  return {
    refresh,
    destroy: () => {
      disposed = true;
      revision++;
      window.clearTimeout(timer);
      listeners.forEach(listener => listener.stop());
      $root.off('.tlaoSummary');
    },
  };
}
