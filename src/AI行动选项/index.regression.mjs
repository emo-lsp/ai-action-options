/* eslint-disable import-x/no-nodejs-modules -- 此文件只在 Node.js 中运行，不参与酒馆浏览器构建。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stylesheet = readFileSync(new URL('./index.scss', import.meta.url), 'utf8');
const catalogSkin = readFileSync(new URL('./catalog_skin.scss', import.meta.url), 'utf8');
const customSelectSource = readFileSync(new URL('./custom_select.ts', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('./popup.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
const pricingSource = readFileSync(new URL('./pricing.ts', import.meta.url), 'utf8');
const usageCaptureSource = readFileSync(new URL('./usage_capture.ts', import.meta.url), 'utf8');
const updateSource = readFileSync(new URL('./update.ts', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('./version.ts', import.meta.url), 'utf8');
const { validateOptionsJson } = await import('./options.ts');
const runningSelector = String.raw`\.tlao-progress-root\.is-visible:not\(\.is-success\):not\(\.is-warning\):not\(\.is-error\)::before`;
const navSwitchSource =
  popupSource.match(
    /\$root\.on\('click', '\.tlao-nav-btn, \.tlao-update-mobile-entry',[\s\S]*?\$root\.on\('change', '#tlao-enabled'/u,
  )?.[0] ?? '';
const startProgressSource =
  indexSource.match(/function startProgress\([\s\S]*?function buildGenerationProgressDetail/u)?.[0] ?? '';
const openSettingsSource =
  indexSource.match(/async function openSettings\([\s\S]*?async function regenerateLatestAssistantOptions/u)?.[0] ?? '';
const noticePrioritySource =
  indexSource.match(/function isProgressVisible\([\s\S]*?function updateProgress/u)?.[0] ?? '';
const catalogMobileStyles =
  catalogSkin.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}\n\n@media \(prefers-reduced-motion/u)?.[1] ?? '';
assert.match(versionSource, /SCRIPT_VERSION = '1\.6\.2'/u, '当前版本号应保持为 1.6.2');
assert.match(
  popupSource,
  /tlao-update-desktop-entry[\s\S]{0,220}?tlao-update-dot/u,
  '桌面端应在侧边导航显示更新入口与红点',
);
assert.match(popupSource, /tlao-update-mobile-entry[\s\S]{0,300}?tlao-update-dot/u, '移动端应在底栏显示更新入口与红点');
assert.match(
  indexSource,
  /initializeAutomaticUpdateCheck[\s\S]{0,320}?checkForUpdates/u,
  '脚本加载后应按用户设置自动检查更新',
);
assert.match(updateSource, /crypto\.subtle\.digest\('SHA-256'/u, '安装更新前应校验脚本 SHA-256');
assert.doesNotMatch(popupSource, /window\.confirm\(/u, '更新确认不得使用脱离主题的浏览器原生弹窗');
assert.match(popupSource, /openUpdateInstallConfirmation/u, '更新安装前应显示脚本主题内的确认界面');
assert.match(
  stylesheet,
  /\.tlao-update-status\.is-available\s*\{[\s\S]{0,220}?var\(--tlao-accent-soft\)/u,
  '可用更新状态应使用强调色而非错误红色',
);
assert.match(
  stylesheet,
  /\.tlao-update-confirm-actions \.menu_button\s*\{[\s\S]{0,100}?min-height:\s*44px/u,
  '更新确认弹窗的操作按钮应满足触控尺寸',
);
assert.match(
  updateSource,
  /window\.top[\s\S]{0,360}?hostWindow\.setTimeout\([\s\S]{0,100}?hostWindow\.location\.reload/u,
  '安装成功后应延迟刷新 SillyTavern 顶层页面，而不是只刷新脚本 iframe',
);
assert.match(indexSource, /onUpdateInstalled:[\s\S]{0,180}?更新成功/u, '安装成功后应先显示顶部更新提示');
assert.match(
  popupSource,
  /export async function openSettingsPopup[\s\S]{0,260}?POPUP_TYPE\?\.DISPLAY \?\? popupApi\.POPUP_TYPE\?\.TEXT/u,
  '主设置页应优先使用无原生底部控制区的 DISPLAY 弹窗',
);
assert.match(
  popupSource,
  /tlao-footbar-credit-label">作者<[\s\S]{0,160}?tlao-footbar-credit-name">emo的lsp</u,
  '底栏应拆分作者标签与作者姓名层级',
);
assert.match(
  catalogSkin,
  /\.tlao-footbar-credit\s*\{[\s\S]*?border:\s*2px solid var\(--tlao-hairline-strong\);[\s\S]*?var\(--tlao-pixel-raised\)/u,
  '作者署名应使用卡库风格凸起铭牌',
);
assert.match(settingsSource, /const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';/u, '新配置应使用当前官方 Flash 模型名');
assert.match(popupSource, /isDeepSeek \? 'deepseek-flash'/u, 'DeepSeek 模型输入框应提示当前官方模型名');
assert.doesNotMatch(
  popupSource,
  /tlao-theme-toggle|THEME_STORAGE_KEY|POPUP_THEME_DEFINITIONS/u,
  '固定卡库风格不应保留主题切换入口与存储',
);
assert.match(popupSource, /mountCustomSelects\(\$root\)/u, '设置页应挂载自定义下拉控件');
assert.match(popupSource, /mountPopupMicroInteractions/u, '设置页与子弹窗应统一挂载像素风微交互');
assert.match(popupSource, /animateNavigationSelection/u, '左侧导航切换应为图标和文字提供明确的方向动效');
assert.match(popupSource, /syncNavigationCursor/u, '左侧导航应使用可移动选中框衔接前后状态');
assert.match(popupSource, /x:\s*direction \* 28/u, '页签内容应按导航方向使用清晰可见的整页横移入场');
assert.match(popupSource, /x:\s*direction \* -14/u, '旧页签内容应先向反方向淡出，避免页面瞬切');
assert.match(popupSource, /activeTransition\.progress\(1\)/u, '连续切换时应先完成上一段页签动画，避免残留半透明状态');
assert.doesNotMatch(
  navSwitchSource,
  /instanceof\s+(?:HTMLElement|HTMLButtonElement)/u,
  '设置 DOM 位于宿主页面，页签切换不得使用 iframe 构造器做 instanceof 判断',
);
assert.doesNotMatch(
  popupSource,
  /function getAnimationElements[\s\S]{0,260}?instanceof HTMLElement/u,
  '通用动画元素过滤必须使用元素自身文档的构造器，避免宿主 DOM 被全部过滤',
);
assert.match(
  popupSource,
  /ownerDocument\.defaultView\?\.HTMLElement/u,
  '跨 iframe 元素判断应显式使用宿主文档窗口的 HTMLElement 构造器',
);
assert.match(customSelectSource, /gsap\.fromTo\([\s\S]*?control\.list/u, '自定义下拉应使用可中断的 GSAP 展开动画');
assert.match(customSelectSource, /close\(true\)/u, '滚动、缩放和销毁时应立即关闭下拉浮层');
assert.match(catalogSkin, /\.tlao-dropdown-trigger[\s\S]*?&\.is-open::after/u, '下拉箭头应随展开状态转向');
assert.match(
  catalogSkin,
  /\.tlao-nav-btn[\s\S]*?transform:\s*scaleX\(0\.08\)[\s\S]*?&\.is-active/u,
  '导航选中底板应平滑铺开',
);
assert.match(
  catalogSkin,
  /\.tlao-nav-cursor\s*\{[\s\S]*?border:\s*3px solid var\(--tlao-accent\)/u,
  '导航应绘制跨按钮移动的像素选中框',
);
assert.match(
  catalogSkin,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.tlao-dropdown-trigger::after/u,
  '减少动态效果模式应关闭像素控件的位移动画',
);
assert.match(
  apiSource,
  /custom_api:\s*\{[\s\S]{0,600}?top_p:\s*'unset'/u,
  '行动选项请求必须显式取消继承 SillyTavern 主 API 的 top_p',
);
assert.match(
  apiSource,
  /const customExcludeBody = \[[\s\S]{0,240}?INHERITED_REQUEST_BODY_FIELDS[\s\S]{0,240}?USAGE_CAPTURE_MARKER_FIELD/u,
  '行动选项必须用自己的排除列表覆盖主 API 设置，并继续移除内部 usage 标记',
);
assert.match(
  apiSource,
  /custom_include_headers:\s*\{\s*Authorization:\s*`Bearer \$\{settings\.api\.apiKey\}`\s*\}/u,
  '行动选项必须覆盖主 API 的自定义请求头，只使用当前 API Key',
);
assert.match(apiSource, /export const MAX_FORMAT_RETRIES = 2;/u, 'JSON 格式错误时最多应静默重试 2 次');
assert.match(
  usageCaptureSource,
  /Object\.getOwnPropertyDescriptor\(hostWindow, 'fetch'\)/u,
  '已有 fetch 访问器时应跳过临时用量捕获，避免与外部监控层叠加包装',
);
assert.match(apiSource, /cacheStatsSuppressed/u, '请求用量状态应记录缓存统计被主动隐藏的原因');
assert.match(
  apiSource,
  /stripLegacyOutputInstructions\(applyPlaceholders\(item\.content, context\)\)/u,
  'JSON 协议应由 API 适配层接管，无需修改 presets.ts',
);
assert.match(
  apiSource,
  /\.\.\.messages\.slice\(insertIndex\),[\s\S]{0,180}?JSON_OUTPUT_INSTRUCTION/u,
  '最终 JSON 系统协议应在内容模板之后追加并覆盖旧格式要求',
);
assert.match(indexSource, /格式重试 0\/\$\{MAX_FORMAT_RETRIES\}/u, '首次请求期间应显示格式重试 0/2');
assert.match(indexSource, /格式重试 \$\{retryCount\}\/\$\{maxRetries\}/u, '生成中的进度弹窗应显示当前格式重试次数');
assert.match(indexSource, /格式重试 \$\{generationResult\.retryCount\} 次/u, '完成弹窗应显示本次实际格式重试次数');
assert.match(
  indexSource,
  /showCacheStats:\s*snapshot\.cacheStatsAvailable\s*&&\s*!snapshot\.cacheStatsSuppressed/u,
  '价格估算与缓存卡片应独立控制，缓存统计被抑制时仍可显示价格',
);
assert.match(
  indexSource,
  /Math\.round\(\(snapshot\.estimatedCostCny \+ Number\.EPSILON\) \* 1000\) \/ 1000/u,
  '价格展示应按三位小数四舍五入',
);
assert.match(indexSource, /roundedPrice\.toFixed\(3\)/u, '价格展示应固定保留三位小数');
assert.match(pricingSource, /roundedCostCny\.toFixed\(3\)/u, '计费说明也应固定保留三位小数');
assert.doesNotMatch(pricingSource, /estimatedCostCny\.toFixed\(6\)/u, '计费展示不应残留六位小数');
assert.match(startProgressSource, /dismissNotice\(\);/u, '生成开始时应立刻隐藏普通通知');
assert.match(
  noticePrioritySource,
  /function notifySettingsSaved\(\)[\s\S]{0,140}?if \(isProgressVisible\(\)\) return;[\s\S]{0,100}?notify\('success', '脚本设置已自动保存'\)/u,
  '生成弹窗可见时不应再显示设置保存通知',
);
assert.match(openSettingsSource, /notifySettingsSaved\(\);/u, '设置保存完成后应通过通知优先级入口显示结果');
assert.doesNotMatch(openSettingsSource, /refreshButtons\(\)/u, '保存设置后不应重复刷新脚本按钮并触发宿主重载');
assert.doesNotMatch(
  settingsSource,
  /export async function saveSettings[\s\S]{0,420}?clearLegacyScriptSettings\(\)/u,
  '普通设置保存不应重复清理脚本变量并触发宿主重载',
);
assert.match(
  catalogMobileStyles,
  /\.tlao-footbar\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?block-size:\s*auto;/u,
  '移动端底栏应按内容高度从顶部紧凑排列',
);
assert.match(
  catalogMobileStyles,
  /\.tlao-footbar-hint\s*\{[\s\S]*?flex:\s*0 0 auto;/u,
  '移动端保存提示不得沿纵轴伸展并制造底部空白',
);
assert.match(
  stylesheet,
  /dialog\.tlao-settings-popup \.popup-controls,[\s\S]{0,520}?display:\s*none !important;[\s\S]{0,220}?block-size:\s*0 !important;/u,
  '设置弹窗的酒馆原生底部控制区应完全归零',
);
assert.match(
  stylesheet,
  /@media \(max-width: 560px\) \{[\s\S]*?\.tlao-settings-popup \.popup-body,[\s\S]*?height:\s*100% !important;[\s\S]*?\.tlao-settings-root\s*\{[\s\S]*?block-size:\s*100%;/u,
  '移动端酒馆外层容器与设置根节点应使用同一满高链路',
);
assert.match(
  stylesheet,
  /@media \(max-width: 560px\) \{[\s\S]*?dialog\.tlao-settings-popup \.popup-body,[\s\S]*?max-height:\s*none !important;[\s\S]*?max-block-size:\s*none !important;/u,
  '移动端主设置容器应解除酒馆默认 95dvh 上限，避免满高外框底部留白',
);
assert.doesNotMatch(
  indexSource,
  /progressTicker|startProgressTicker|stopProgressTicker/u,
  '生成中不得保留重复整弹窗刷新的定时器',
);
assert.match(indexSource, /type ProgressDomRefs = \{/u, '进度弹窗应缓存内部节点引用');
assert.match(
  indexSource,
  /if \(document\.hidden\) return;[\s\S]{0,180}?\}, 100\);/u,
  '计时器应以 100ms 刷新并在后台跳过 DOM 写入',
);
assert.match(indexSource, /缓存命中\/未命中数据未显示/u, '缓存统计被抑制时应向用户说明不显示原因');
assert.match(
  indexSource,
  /PROGRESS_SUCCESS_WITHOUT_CACHE_HIDE_DELAY_MS = 5000/u,
  '无缓存用量卡片的成功弹窗应显示 5 秒',
);
assert.doesNotMatch(
  indexSource,
  /notify\(\s*'warning',\s*'缓存命中\/未命中数据未显示/u,
  '缓存统计说明不应再单独触发黄色通知',
);

const validJsonResult = validateOptionsJson(
  '{"options":["选项1","选项2","选项3","选项4","选项5","选项6","选项7","选项8"]}',
);
assert.equal(validJsonResult.ok, true, '合法 JSON 行动选项应通过校验');
assert.equal(
  validJsonResult.ok ? validJsonResult.normalizedMarkup : '',
  '<options>选项1|选项2|选项3|选项4|选项5|选项6|选项7|选项8</options>',
  '合法 JSON 应转换为旧版 options 标记，保持现有前端渲染兼容',
);
assert.equal(
  validateOptionsJson('<options>选项1|选项2|选项3|选项4|选项5|选项6|选项7|选项8</options>').ok,
  false,
  '模型旧版 options 标记不应再被当作合法回复',
);
assert.equal(validateOptionsJson('{"options":["1","2","3","4","5","6","7"]}').ok, false, 'JSON 选项不足 8 项时应拒绝');
assert.equal(
  validateOptionsJson('{"options":["1|额外","2","3","4","5","6","7","8"]}').ok,
  false,
  '选项中的竖线会破坏旧版渲染分隔，必须拒绝',
);
assert.equal(
  validateOptionsJson('{"options":["1\\n额外","2","3","4","5","6","7","8"]}').ok,
  false,
  '选项中的换行不符合旧版渲染协议，必须拒绝',
);
assert.doesNotMatch(
  stylesheet,
  /(?:^|,)\s*dialog\.popup\s+\.popup-(?:body|content)\b|(?:^|,)\s*dialog\.popup\s+\.(?:popup_inner|dialogue_popup)\b/u,
  '行动选项样式不得用未限定的 dialog.popup 内层选择器污染宿主弹窗',
);
assert.match(
  stylesheet,
  /dialog\.popup\.tlao-settings-popup\s*,/u,
  '设置弹窗仍应保留带 tlao 作用域的 dialog.popup 样式',
);

assert.match(stylesheet, /@property\s+--tlao-flow-angle\s*\{/u, '应注册流光角度自定义属性');
assert.match(
  stylesheet,
  /\.tlao-progress-root::before\s*\{[\s\S]*?content:\s*'';[\s\S]*?conic-gradient\([\s\S]*?mask-composite:\s*exclude;/u,
  '进度弹窗伪元素应绘制只覆盖边框的锥形渐变',
);
assert.match(
  stylesheet,
  new RegExp(`${runningSelector}\\s*\\{[\\s\\S]*?animation:\\s*tlao-progress-border-flow 2\\.4s linear infinite;`, 'u'),
  '高帧率流光应仅在生成中的可见状态运行',
);
assert.match(
  stylesheet,
  /@keyframes\s+tlao-progress-border-flow\s*\{[\s\S]*?--tlao-flow-angle:\s*360deg;/u,
  '应保留流光旋转关键帧',
);
assert.match(
  stylesheet,
  /\.tlao-progress-root\s*\{[\s\S]*?--tlao-progress-bg:\s*#f8f2e6;[\s\S]*?border-radius:\s*0;[\s\S]*?4px 4px 0/u,
  '进度弹窗应使用不透明暖纸底和方角硬阴影',
);
assert.match(
  stylesheet,
  /\.tlao-notice-root\s*\{[\s\S]*?--tlao-notice-bg:\s*#f8f2e6;[\s\S]*?border-radius:\s*0;[\s\S]*?4px 4px 0/u,
  '通知弹窗应使用不透明暖纸底和方角硬阴影',
);
assert.match(
  stylesheet,
  /\.tlao-progress-root\.is-visible:is\(\.is-success, \.is-warning, \.is-error\)::before\s*\{[\s\S]*?animation:\s*tlao-status-border-stamp 280ms steps\(3, end\) 1;/u,
  '生成终态边框应只播放一次像素盖章反馈',
);
assert.match(
  stylesheet,
  /@keyframes\s+tlao-status-border-stamp\s*\{[\s\S]*?0%\s*\{\s*opacity:\s*0\.72;[\s\S]*?50%\s*\{\s*opacity:\s*1;/u,
  '终态边框应从首帧保持状态色，避免露出底层深色边框',
);
assert.doesNotMatch(
  stylesheet,
  /@keyframes\s+tlao-status-border-stamp\s*\{[\s\S]*?transform:\s*scaleX/u,
  '终态边框不得通过缩放露出底层边框',
);
assert.match(
  stylesheet,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.tlao-progress-root::before\s*\{[\s\S]*?animation:\s*none;/u,
  '减少动态效果模式应关闭流光动画',
);

console.info('AI行动选项回归检查通过');
