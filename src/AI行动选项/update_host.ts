type HostUpdatePayload = {
  scriptId: string;
  content: string;
  version: string;
};

// 此函数会在宿主 realm 重新创建，不能引用模块变量、导入或 iframe 回调。
async function runHostUpdate(payload: HostUpdatePayload): Promise<void> {
  const host = window as Window &
    typeof globalThis & {
      TavernHelper: {
        getScriptTrees: typeof getScriptTrees;
      updateScriptTreesWith: typeof updateScriptTreesWith;
      builtin: { saveSettings: () => Promise<void> };
      };
    };
  const api = host.TavernHelper;
  const notice = host.document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.setAttribute('popover', 'manual');
  // 样式随宿主通知保留，旧脚本卸载时不会跟随 teleportStyle 一起消失。
  notice.style.cssText =
    'position:fixed;inset:auto;top:max(16px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);' +
    'box-sizing:border-box;width:min(520px,calc(100% - 32px));margin:0;padding:18px 22px;' +
    'border:4px solid #a99f8c;border-radius:0;background:#f8f2e6;color:#302d27;' +
    'box-shadow:inset 0 0 0 3px #fffaf0,0 4px 0 #6e685b;z-index:2147483647;' +
    'font:16px/1.5 sans-serif;letter-spacing:0;overflow-wrap:anywhere;';
  const title = host.document.createElement('strong');
  const detail = host.document.createElement('div');
  title.style.color = '#477447';
  notice.append(title, detail);
  const show = (heading: string, message: string, failed = false) => {
    title.textContent = heading;
    title.style.color = failed ? '#a52b25' : '#477447';
    detail.textContent = message;
    if (!notice.isConnected) host.document.body.append(notice);
    // 设置页是原生 dialog；使用 top layer，避免提示被模态弹窗遮挡。
    if (typeof notice.showPopover === 'function') notice.showPopover();
  };
  const findScript = (trees: ScriptTree[]) =>
    trees
      .flatMap(tree => (tree.type === 'script' ? [tree] : tree.scripts))
      .find(script => script.id === payload.scriptId);

  try {
    let scope: ScriptTreesOptions['type'] | undefined;
    for (const type of ['global', 'preset', 'character'] as const) {
      try {
        if (findScript(api.getScriptTrees({ type }))) {
          scope = type;
          break;
        }
      } catch {
        // 无角色卡或预设时，该作用域可能不可读取。
      }
    }
    if (!scope) throw new Error('未找到当前脚本');
    await api.updateScriptTreesWith(
      trees => {
        const script = findScript(trees);
        if (!script) throw new Error('当前脚本已移除');
        script.content = payload.content;
        return trees;
      },
      { type: scope },
    );
    if (findScript(api.getScriptTrees({ type: scope }))?.content !== payload.content) {
      throw new Error('脚本写入校验失败');
    }
    if (scope === 'global') await api.builtin.saveSettings();
    show('更新成功', `v${payload.version} 已安装，正在刷新页面…`);
    // 给宿主的设置/预设防抖保存留出时间；计时器和回调均属于宿主，不依赖旧 iframe。
    host.setTimeout(() => host.location.reload(), 3_000);
  } catch (error) {
    console.error('[AI行动选项] 宿主安装失败:', error);
    show('安装失败', error instanceof Error ? error.message : String(error), true);
    host.setTimeout(() => notice.remove(), 10_000);
    throw error;
  }
}

export function startHostUpdate(payload: HostUpdatePayload): Promise<void> {
  const host = window.top as Window & typeof globalThis;
  if (!host || host === window) throw new Error('无法访问酒馆主页面，已取消安装');
  // 只编译上方固定安装器；下载的脚本作为参数传入，不在这里 eval。
  // 使用宿主 Function 创建整个执行链，仅把 iframe 函数交给 top.setTimeout 仍不可靠。
  const execute = host.Function('payload', `return (${runHostUpdate.toString()})(payload);`) as (
    value: HostUpdatePayload,
  ) => Promise<void>;
  return execute(payload);
}
