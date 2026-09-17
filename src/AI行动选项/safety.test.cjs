/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Node.js 定向异步回归测试。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const lodash = require('lodash');

function load(name, globals = {}, imports = {}, appendix = '') {
  const source = fs.readFileSync(`${__dirname}/${name}.ts`, 'utf8') + appendix;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    console,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    _: lodash,
    getScriptId: () => 'test',
    window: { setTimeout, clearTimeout },
    require: id => {
      if (id in imports) return imports[id];
      if (id.endsWith('.scss')) return {};
      if (id.startsWith('./')) return load(id.slice(2), globals, imports);
      throw new Error(`未模拟依赖 ${id}`);
    },
    ...globals,
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return module.exports;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const effort of ['high', 'max']) {
  test(`${effort} 请求携带全部历史剧情且不强制压缩思考`, async () => {
    const settingsModule = load('settings');
    const requests = [];
    const api = load(
      'api',
      {
        substitudeMacros: text => text,
        TavernHelper: {
          generateRaw: async config => {
            requests.push(config);
            return '{"options":["一","二","三","四","五","六","七","八"]}';
          },
        },
      },
      {
        './runtime': { setApiUsageSnapshot: () => {} },
        './usage_capture': { captureChatCompletionUsage: async (_id, run) => ({ result: await run() }) },
        './pricing': {},
        './options': { validateOptionsJson: () => ({ ok: true, normalizedMarkup: '<options>测试</options>' }) },
      },
    );
    const settings = {
      ...settingsModule.DEFAULT_SETTINGS,
      assistantContextCount: 10,
      api: { ...settingsModule.DEFAULT_SETTINGS.api, apiKey: 'test', reasoningEffort: effort },
    };
    const replies = Array.from({ length: 10 }, (_, i) => `[AI 回复楼层 #${i + 1}]\n剧情标记_${i + 1}_结束`);
    await api.generateOptionsMarkup(settings, {
      latestReply: '剧情标记_10_结束',
      recentAiRepliesText: replies.join('\n\n'),
      recentAiReplyCount: 10,
      worldbookNames: [],
      knowledgebookNames: [],
      worldbookText: '模板',
      knowledgebookText: '世界书',
    });
    assert.equal(requests.length, 1);
    const request = requests[0];
    const prompt = request.ordered_prompts.map(message => message.content).join('\n');
    for (let i = 1; i <= 10; i++) assert.ok(prompt.includes(`剧情标记_${i}_结束`), `缺少第 ${i} 层剧情`);
    assert.equal((prompt.match(/剧情标记_10_结束/g) || []).length, 1, '最新楼层不应重复发送');
    assert.equal(request.custom_api.custom_include_body.reasoning_effort, effort);
    assert.equal(request.custom_api.custom_include_body.thinking.type, 'enabled');
    assert.doesNotMatch(prompt, /内部思考预算上限|尽量少思考|最短判断/);
  });
}

function generationHarness() {
  const completions = [];
  let called = 0;
  let signal;
  const writes = [];
  let message = { message_id: 1, role: 'assistant', message: '原正文', swipe_id: 0 };
  const settings = {
    enabled: true,
    api: { baseUrl: 'url', apiKey: 'test', model: 'model' },
    boundKnowledgeWorldbooks: [],
    assistantContextCount: 1,
  };
  const exports = load(
    'index',
    {
      $: () => {},
      SillyTavern: { getCurrentChatId: () => 'chat-a' },
      getChatMessages: () => [{ ...message }],
      setChatMessages: async value => writes.push(value),
    },
    {
      '@util/script': {},
      './popup': {},
      './global_regex': {},
      './runtime': { getApiUsageSnapshot: () => ({}) },
      './options': {
        stripAllOptionsBlocks: value => value,
        stripTrailingOptionsBlock: value => value,
        hasTrailingOptionsBlock: () => false,
        appendOptionsBlock: (a, b) => a + b,
      },
      './api': {
        MAX_FORMAT_RETRIES: 2,
        generateOptionsMarkup: (...args) => {
          called++;
          signal = args[3];
          return new Promise(resolve => {
            completions.push(resolve);
          });
        },
      },
      './settings': { loadSettings: async () => settings },
      './update': { checkForUpdates: async () => {}, restoreCachedUpdateState: () => {} },
      './character_source': {
        syncSettingsWithCurrentCharacterKnowledgeSource: async () => ({
          settings,
          changed: false,
          source: { mode: 'none' },
        }),
      },
      './custom_presets': { getResolvedOptionPreset: () => ({ name: 'test', prompt: 'test' }) },
      './worldbooks': {
        buildWorldbookContext: async () => ({ worldbookText: '', missingWorldbooks: [], selectedEntryCount: 0 }),
      },
    },
    `
startProgress = () => 1; updateProgress = () => {}; finishProgress = () => {};
collectRecentAssistantReplies = async () => null;
module.exports = { generateAndAppendOptions, clearAutomationRuntime, cancelMessageGeneration, hasTask: () => activeMessageIds.has(1) };
`,
  );
  return {
    exports,
    writes,
    change: patch => {
      message = { ...message, ...patch };
    },
    wait: async (count = 1) => {
      for (let i = 0; i < 20 && called < count; i++) await tick();
      assert.equal(called, count);
    },
    finish: (index = 0) => completions[index]({ markup: '<options>新选项</options>', retryCount: 0 }),
    signal: () => signal,
  };
}
for (const [name, patch] of [
  ['正文变化', { message: '改过的正文' }],
  ['相同正文切换 swipe', { swipe_id: 1 }],
]) {
  test(`${name}时旧结果不能写回`, async () => {
    const h = generationHarness();
    const task = h.exports.generateAndAppendOptions(1, 'manual');
    await h.wait();
    h.change(patch);
    h.finish();
    await task;
    assert.equal(h.writes.length, 0);
  });
}
test('切聊天再返回后，旧任务取消且不能写回', async () => {
  const h = generationHarness();
  const task = h.exports.generateAndAppendOptions(1, 'manual');
  await h.wait();
  h.exports.clearAutomationRuntime();
  h.finish();
  await task;
  assert.equal(h.writes.length, 0);
  assert.equal(h.signal()?.aborted, true);
});
test('读取失败阻止加载和保存，恢复后允许重试并保存', async () => {
  let writes = 0;
  let fail = true;
  let stored = { enabled: true, assistantContextCount: 9 };
  const settings = load(
    'settings',
    {
      console: { ...console, warn: () => {} },
      readTestValue: () => {
        if (fail) throw new Error('读取失败');
        return stored;
      },
      writeTestValue: value => {
        writes++;
        stored = value;
      },
      getVariables: () => ({}),
      replaceVariables: () => {},
    },
    {},
    `
readStorageValue = async () => globalThis.readTestValue();
writeStorageValue = async (_key, value) => { globalThis.writeTestValue(value); };
`,
  );
  await assert.rejects(settings.loadSettings(), /读取失败/);
  await assert.rejects(settings.saveSettings(settings.DEFAULT_SETTINGS), /读取失败/);
  await assert.rejects(settings.saveDraftSettings(settings.DEFAULT_SETTINGS), /读取失败/);
  assert.equal(writes, 0);
  fail = false;
  const loaded = await settings.loadSettings();
  assert.equal(loaded.assistantContextCount, 9);
  await settings.saveSettings({ ...loaded, assistantContextCount: 3 });
  assert.equal(stored.assistantContextCount, 3);
  assert.equal(writes, 1);
});

test('普通设置保存不再写脚本变量触发宿主重载', async () => {
  let legacyWrites = 0;
  const stored = { enabled: true, assistantContextCount: 2 };
  const settings = load(
    'settings',
    {
      readTestValue: () => stored,
      writeTestValue: () => {},
      getVariables: () => ({}),
      replaceVariables: () => {
        legacyWrites += 1;
      },
      localStorage: { getItem: () => null, removeItem: () => {} },
    },
    {},
    `
readStorageValue = async () => globalThis.readTestValue();
writeStorageValue = async (_key, value) => { globalThis.writeTestValue(value); };
`,
  );

  const loaded = await settings.loadSettings();
  await settings.saveSettings(loaded);
  assert.equal(legacyWrites, 0);
});

test('消息没有变化时正常写入一次', async () => {
  const h = generationHarness();
  const task = h.exports.generateAndAppendOptions(1, 'manual');
  await h.wait();
  h.finish();
  await task;
  assert.equal(h.writes.length, 1);
});

test('取消通知宿主停止对应请求，且不等待远端返回', async () => {
  let requestId;
  const stops = [];
  const api = load(
    'api',
    {
      TavernHelper: {
        generateRaw: config => {
          requestId = config.generation_id;
          return new Promise(() => {});
        },
        stopGenerationById: id => stops.push(id),
      },
    },
    {
      './runtime': { setApiUsageSnapshot: () => {} },
      './usage_capture': {},
      './options': {},
      './pricing': {},
    },
    '\nmodule.exports.requestChatCompletion = requestChatCompletion;',
  );
  const controller = new AbortController();
  const task = api.requestChatCompletion(
    { api: { provider: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test', timeoutMs: 5000 } },
    [],
    controller.signal,
  );
  await tick();
  assert.ok(requestId);
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  assert.deepEqual(stops, [requestId]);
});

test('旧任务返回不清掉同楼层新任务的锁', async () => {
  const h = generationHarness();
  const oldTask = h.exports.generateAndAppendOptions(1, 'manual');
  await h.wait();
  h.exports.cancelMessageGeneration(1);
  const newTask = h.exports.generateAndAppendOptions(1, 'manual');
  await h.wait(2);
  h.finish(0);
  await oldTask;
  assert.equal(h.exports.hasTask(), true);
  assert.equal(h.writes.length, 0);
  h.finish(1);
  await newTask;
  assert.equal(h.exports.hasTask(), false);
  assert.equal(h.writes.length, 1);
});

test('格式重试间取消后不再请求模型', async () => {
  let calls = 0;
  const controller = new AbortController();
  const api = load(
    'api',
    {
      substitudeMacros: text => text,
      TavernHelper: {
        generateRaw: async () => {
          calls++;
          return 'bad';
        },
      },
    },
    {
      './runtime': { setApiUsageSnapshot: () => {} },
      './usage_capture': {},
      './pricing': {},
      './options': { validateOptionsJson: () => ({ ok: false, reason: '格式错误' }) },
    },
  );
  const task = api.generateOptionsMarkup(
    {
      api: { provider: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test', model: 'test', timeoutMs: 5000 },
      promptMessages: [{ enabled: true, role: 'system', content: 'test' }],
    },
    { worldbookNames: [], knowledgebookNames: [] },
    () => controller.abort(),
    controller.signal,
  );
  await assert.rejects(task, error => error.name === 'AbortError');
  assert.equal(calls, 1);
});
