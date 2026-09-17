/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Node.js 定向上下文回归测试。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const lodash = require('lodash');

function load(name, globals = {}, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${__dirname}/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, console, _: lodash, getScriptId: () => 'test',
    setTimeout, clearTimeout, window: { setTimeout, clearTimeout },
    require: id => id in imports ? imports[id] : id.startsWith('./') ? load(id.slice(2), globals, imports) : id === 'zod' ? require('zod') : (() => { throw new Error(`未模拟依赖 ${id}`); })(),
    ...globals,
  });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const config = { mode: 'all', count: 2, tagMode: 'auto', customTag: 'summary' };
const replies = Array.from({ length: 5 }, (_, i) => ({ id: (i + 1) * 2, text: `正文${i + 1}\n<summary>事件${i + 1}</summary>` }));

test('正文清理不会把嵌套思考中的伪摘要暴露给后续提取', () => {
  const { cleanAssistantReplyForContext, buildActionContext } = load('context');
  const text = cleanAssistantReplyForContext('<think><think>内层</think><summary>猜测</summary></think>正文<summary>实际事件</summary>');
  assert.equal(text, '正文<summary>实际事件</summary>');
  assert.equal(buildActionContext([{ id: 2, text }, replies[4]], 1, config).summary.entries[0].text, '实际事件');
});

test('正文过滤变量更新、分析与补丁的整块内容，兼容嵌套、大小写及未闭合块', () => {
  const { cleanAssistantReplyForContext } = load('context');
  assert.equal(cleanAssistantReplyForContext('正文<UpdateVariable><Analysis>分析</Analysis><JSONPatch>[补丁]</JSONPatch>其他变量</UpdateVariable><summary>摘要</summary>'), '正文<summary>摘要</summary>');
  for (const tag of ['UpdateVariable', 'Analysis', 'JSONPatch']) {
    assert.equal(cleanAssistantReplyForContext(`前文<${tag.toLowerCase()} data-x="1">内部内容</${tag.toUpperCase()}>后文`), '前文后文');
    assert.equal(cleanAssistantReplyForContext(`前文<${tag}>未结束的内容`), '前文');
    assert.equal(cleanAssistantReplyForContext(`前文<${tag}/>后文`), '前文后文');
  }
  assert.equal(cleanAssistantReplyForContext('<AnalysisExtra>剧情</AnalysisExtra>'), '<AnalysisExtra>剧情</AnalysisExtra>');
});

test('发送上下文的最新正文、历史正文与更早摘要均排除变量标签内容', async () => {
  const { readActionContext } = load('context', {
    SillyTavern: { getCurrentChatId: () => 'a' },
    getChatMessages: () => [2, 4, 6].map(id => ({ message_id: id, role: 'assistant', message: `正文${id}<UpdateVariable><Analysis>不发送分析</Analysis><JSONPatch>不发送补丁</JSONPatch><summary>不发送伪摘要</summary></UpdateVariable><summary>事件${id}</summary>` })),
  });
  const context = await readActionContext(6, 2, { ...config, tagMode: 'custom' });
  for (const content of [context.latestReply, context.recentAiRepliesText, context.earlierSummariesText]) {
    assert.doesNotMatch(content, /UpdateVariable|Analysis|JSONPatch|不发送/);
  }
  assert.match(context.latestReply, /正文6/);
  assert.match(context.recentAiRepliesText, /正文4/);
  assert.match(context.earlierSummariesText, /事件2/);
});

test('自动读取当前预设与有效正则，停用的角色规则不参与检测', async () => {
  const scopes = [];
  const { readActionContext } = load('context', {
    SillyTavern: { getCurrentChatId: () => 'a' },
    getChatMessages: () => [{ message_id: 2, role: 'assistant', message: '<memory>过去</memory><往事>更早事件</往事>' }, { message_id: 4, role: 'assistant', message: '正文' }],
    isCharacterTavernRegexesEnabled: () => false,
    getTavernRegexes: ({ type }) => {
      scopes.push(type);
      return type === 'preset' ? [{ enabled: true, script_name: '摘要', source: { ai_output: true }, find_regex: '/<memory>(.*?)<\\/memory>/g', replace_string: '$1' }] : [];
    },
    getPreset: name => {
      assert.equal(name, 'in_use');
      return { prompts: [{ enabled: true, content: '<summary_format><往事>格式</往事></summary_format>' }] };
    },
  });
  const context = await readActionContext(4, 1, config);
  assert.deepEqual(scopes, ['preset', 'global']);
  assert.deepEqual(plain(context.summary.tags), ['memory', '往事']);
  assert.match(context.earlierSummariesText, /过去/);
  assert.match(context.earlierSummariesText, /更早事件/);
});

test('全部摘要与正文不重叠，新增楼层只向旧摘要末尾追加', () => {
  const { buildActionContext } = load('context');
  const before = buildActionContext(replies.slice(0, 4), 2, config);
  const after = buildActionContext(replies, 2, config);
  assert.deepEqual(plain(after.bodyIds), [8, 10]);
  assert.deepEqual(plain(after.summary.entries.map(e => e.id)), [2, 4, 6]);
  assert.ok(after.earlierSummariesText.startsWith(before.earlierSummariesText + '\n\n'));
  assert.doesNotMatch(after.earlierSummariesText, /正文|事件4|事件5/);
});

test('指定层数按正文之前的AI楼层窗口计算，不跳过缺失楼层向更早回填', () => {
  const { buildActionContext } = load('context');
  const withMissing = replies.map(r => r.id === 4 ? { ...r, text: '本层没有摘要' } : r);
  const result = buildActionContext(withMissing, 2, { ...config, mode: 'recent', count: 2 });
  assert.deepEqual(plain(result.summary.selectedIds), [4, 6]);
  assert.deepEqual(plain(result.summary.missingIds), [4]);
  assert.deepEqual(plain(result.summary.entries.map(e => e.id)), [6]);
});

test('开场白没有摘要不报缺失，有摘要仍读取，其他楼层缺失照常提示', () => {
  const { buildActionContext, formatSummaryPreview } = load('context');
  for (const mode of ['all', 'recent']) {
    const settings = { ...config, mode, count: 20 };
    const messages = [{ id: 0, text: '开场白' }, ...replies];
    const result = buildActionContext(messages, 2, settings);
    assert.deepEqual(plain(result.summary.missingIds), []);
    assert.doesNotMatch(formatSummaryPreview(result, settings), /缺少/);
    const withSummary = buildActionContext([{ id: 0, text: '开场白<summary>初始事件</summary>' }, ...replies], 2, settings);
    assert.equal(withSummary.summary.entries[0].id, 0);
    assert.match(withSummary.earlierSummariesText, /初始事件/);
    const missing = buildActionContext(messages.map(item => item.id === 2 ? { ...item, text: '没有摘要的回复' } : item), 2, settings);
    assert.deepEqual(plain(missing.summary.missingIds), [2]);
  }
});

test('关闭时不发送摘要，但可以预览提取结果；大正文窗口不会重复补摘要', () => {
  const { buildActionContext, formatSummaryPreview } = load('context');
  const disabled = { ...config, mode: 'off' };
  const result = buildActionContext(replies, 2, disabled, undefined, true);
  assert.equal(result.earlierSummariesText, '');
  assert.equal(result.summary.available.length, 5);
  const preview = formatSummaryPreview(result, disabled);
  assert.match(preview, /已关闭/);
  assert.match(preview, /楼层 #2 · summary · 不读取/);
  assert.match(preview, /楼层 #10 · summary · 正文已包含/);
  assert.equal(buildActionContext(replies, 99, config).summary.entries.length, 0);
});

test('自定义标签支持预览与请求相同内容，非法标签不回退到自动摘要', () => {
  const { buildActionContext, formatSummaryPreview } = load('context');
  const result = buildActionContext([{ id: 2, text: '<往事>一段往事</往事><summary>另一摘要</summary>' }, replies[4]], 1, { ...config, tagMode: 'custom', customTag: '<往事>' });
  assert.match(result.earlierSummariesText, /一段往事/);
  assert.doesNotMatch(result.earlierSummariesText, /另一摘要/);
  assert.match(formatSummaryPreview(result, config), /一段往事/);
  const invalid = buildActionContext(replies, 2, { ...config, tagMode: 'custom', customTag: '[' });
  assert.equal(invalid.earlierSummariesText, '');
  assert.match(invalid.summary.notes[0], /标签无效/);
});

test('真实读取保留缺少hidden字段的AI消息，只用当前swipe，并排除用户、旁白和明确隐藏楼层', async () => {
  let options;
  const context = load('context', {
    SillyTavern: { getCurrentChatId: () => 'chat-a' }, getLastMessageId: () => 10,
    getChatMessages: (_range, value) => {
      options = value;
      return [
        { message_id: 1, role: 'user', message: '<summary>不发送用户</summary>' },
        ...replies.map(r => ({ message_id: r.id, role: 'assistant', message: r.text, ...(r.id === 4 ? { is_hidden: true } : {}), ...(r.id === 6 ? { extra: { type: 'narrator' } } : {}) })),
      ];
    },
  });
  const result = await context.readActionContext(10, 1, { ...config, tagMode: 'custom' });
  assert.equal(options.include_swipes, false);
  assert.equal(options.hide_state, undefined);
  assert.deepEqual(plain(result.summary.entries.map(e => e.id)), [2, 8]);
  assert.deepEqual(plain(result.bodyIds), [10]);
});

test('切聊天时丢弃未完成的读取；编辑后重新读取，不残留旧摘要', async () => {
  let chat = 'a';
  let resolve;
  const context = load('context', {
    SillyTavern: { getCurrentChatId: () => chat },
    getChatMessages: () => new Promise(done => { resolve = done; }),
  });
  const task = context.readActionContext(2, 1, config);
  chat = 'b';
  resolve([{ message_id: 2, role: 'assistant', message: '正文' }]);
  await assert.rejects(task, /聊天已切换/);
  const next = context.readActionContext(4, 1, { ...config, tagMode: 'custom' });
  resolve([{ message_id: 2, role: 'assistant', message: '<summary>修改后</summary>' }, { message_id: 4, role: 'assistant', message: '正文' }]);
  assert.match((await next).earlierSummariesText, /修改后/);
});

test('DeepSeek请求的静态资料和旧摘要前缀稳定，不混入变化计数，保留字面量替换字符', () => {
  const settings = load('settings');
  const api = load('api', { substitudeMacros: text => text }, { './usage_capture': {}, './runtime': {}, './pricing': {} });
  const { buildActionContext } = load('context');
  const base = { worldbookNames: [], knowledgebookNames: [], worldbookText: '固定模板', knowledgebookText: '固定世界书' };
  const oldContext = buildActionContext(replies.slice(0, 4), 2, config);
  const oldMessages = api.resolvePromptMessages(settings.DEFAULT_SETTINGS, { ...base, ...oldContext });
  const newMessages = api.resolvePromptMessages(settings.DEFAULT_SETTINGS, { ...base, ...buildActionContext(replies, 2, config) });
  const before = oldMessages.find(m => m.role === 'user').content;
  const after = newMessages.find(m => m.role === 'user').content;
  const prefix = before.slice(0, before.indexOf(oldContext.earlierSummariesText) + oldContext.earlierSummariesText.length);
  assert.ok(after.startsWith(prefix));
  assert.deepEqual(plain(oldMessages.filter(m => m.role === 'system')), plain(newMessages.filter(m => m.role === 'system')));
  const literal = api.resolvePromptMessages(settings.DEFAULT_SETTINGS, { ...base, ...oldContext, earlierSummariesText: '$& $1 {{worldbook}}' });
  assert.match(literal.find(m => m.role === 'user').content, /\$& \$1 \{\{worldbook\}\}/);
});

test('旧设置迁移保持摘要关闭，自定义标签与范围可持久化归一', () => {
  const { normalizeSettings } = load('settings');
  const migrated = normalizeSettings({ assistantContextCount: 10 });
  assert.equal(migrated.summary.mode, 'off');
  assert.deepEqual(plain(migrated.updates), { automaticCheck: true, endpoint: 'auto' });
  const saved = normalizeSettings({ summary: { ...config, mode: 'recent', count: 7, tagMode: 'custom', customTag: '<往事>' } });
  assert.deepEqual(plain(normalizeSettings(JSON.parse(JSON.stringify(saved))).summary), plain(saved.summary));
});
