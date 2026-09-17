/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Node.js 定向更新模块测试。 */
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function loadUpdate(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(`${__dirname}/update.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module,
      exports: module.exports,
      console,
      AbortController,
      TextEncoder,
      crypto: webcrypto,
      localStorage: createStorage(),
      getScriptId: () => 'current-script',
      getScriptTrees: () => [],
      updateScriptTreesWith: () => [],
      fetch: async () => {
        throw new Error('未模拟 fetch');
      },
      window: { setTimeout, clearTimeout, location: { reload: () => {} } },
      require: id => {
        if (id === 'zod') return require('zod');
        if (id === './version') return { SCRIPT_VERSION: '1.6.2', UPDATE_REPOSITORY: 'emo-lsp/ai-action-options' };
        if (id === './types') return {};
        throw new Error(`未模拟依赖 ${id}`);
      },
      ...globals,
    },
  );
  return module.exports;
}

function manifest(latest = '1.8.0') {
  return {
    schemaVersion: 1,
    latest,
    versions: [
      {
        version: latest,
        releasedAt: '2026-09-17',
        channel: 'stable',
        changes: ['新增更新模块'],
        ref: `v${latest}`,
        path: 'index.js',
        sha256: 'a'.repeat(64),
      },
      {
        version: '1.7.0',
        releasedAt: '2026-09-16',
        channel: 'stable',
        changes: ['当前版本'],
        ref: 'v1.7.0',
        path: 'index.js',
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

test('版本比较兼容正式版和预发布版', () => {
  const { compareVersions } = loadUpdate();
  assert.ok(compareVersions('1.8.0', '1.7.9') > 0);
  assert.ok(compareVersions('1.8.0', '1.8.0-beta.2') > 0);
  assert.ok(compareVersions('1.8.0-beta.10', '1.8.0-beta.2') > 0);
  assert.equal(compareVersions('v1.7.0', '1.7.0'), 0);
});

test('更新清单校验仓库相对路径并按版本排序', () => {
  const { parseUpdateManifest } = loadUpdate();
  const parsed = parseUpdateManifest({ ...manifest(), versions: manifest().versions.reverse() });
  assert.equal(parsed.versions[0].version, '1.8.0');
  assert.throws(
    () => parseUpdateManifest({ ...manifest(), versions: [{ ...manifest().versions[0], path: '../index.js' }] }),
    /更新清单格式无效/,
  );
});

test('自动端点按 testingcf、jsDelivr、GitHub 回退，24 小时内使用缓存', async () => {
  const requests = [];
  const update = loadUpdate({
    fetch: async url => {
      requests.push(url);
      if (url.includes('testingcf')) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => manifest() };
    },
  });

  const first = await update.checkForUpdates({ endpoint: 'auto' });
  assert.equal(first.endpointUsed, 'jsdelivr');
  assert.equal(first.hasUpdate, true);
  assert.equal(requests.length, 2);
  await update.checkForUpdates({ endpoint: 'auto' });
  assert.equal(requests.length, 2, '缓存期内不应重复请求');
});

test('安装前校验 SHA-256，通过后只替换当前脚本内容，不重载脚本 iframe', async () => {
  const content = `/* release */\n${'x'.repeat(12_000)}`;
  const sha256 = createHash('sha256').update(content).digest('hex');
  let trees = [
    { type: 'script', id: 'other-script', name: '其他', content: 'other' },
    { type: 'script', id: 'current-script', name: 'AI行动选项', content: 'old' },
  ];
  let reloads = 0;
  const update = loadUpdate({
    getScriptTrees: ({ type }) => (type === 'global' ? trees : []),
    updateScriptTreesWith: (updater, { type }) => {
      assert.equal(type, 'global');
      trees = updater(trees);
      return trees;
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => content }),
    window: {
      setTimeout,
      clearTimeout,
      location: {
        reload: () => {
          reloads += 1;
        },
      },
    },
  });

  await update.installUpdate({ ...manifest().versions[0], sha256 }, 'github');
  assert.equal(trees[0].content, 'other');
  assert.equal(trees[1].content, content);
  assert.equal(reloads, 0);
});

test('安装成功提示后由宿主窗口定时刷新 SillyTavern 顶层页面', () => {
  let iframeReloads = 0;
  let hostReloads = 0;
  let scheduledDelay = 0;
  let scheduledCallback = null;
  const hostWindow = {
    location: {
      reload: () => {
        hostReloads += 1;
      },
    },
    setTimeout: (callback, delay) => {
      scheduledCallback = callback;
      scheduledDelay = delay;
      return 1;
    },
  };
  const update = loadUpdate({
    window: {
      top: hostWindow,
      setTimeout,
      clearTimeout,
      location: {
        reload: () => {
          iframeReloads += 1;
        },
      },
    },
  });

  update.scheduleSillyTavernPageReload(1_234);
  assert.equal(scheduledDelay, 1_234);
  assert.equal(typeof scheduledCallback, 'function');
  assert.equal(iframeReloads, 0);
  scheduledCallback();
  assert.equal(hostReloads, 1);
});

test('SHA-256 不一致时不替换脚本', async () => {
  const content = `/* tampered */\n${'x'.repeat(12_000)}`;
  let currentContent = 'old';
  let reloads = 0;
  const update = loadUpdate({
    getScriptTrees: () => [{ type: 'script', id: 'current-script', name: 'AI行动选项', content: currentContent }],
    updateScriptTreesWith: updater => {
      currentContent = updater([
        { type: 'script', id: 'current-script', name: 'AI行动选项', content: currentContent },
      ])[0].content;
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => content }),
    window: {
      setTimeout,
      clearTimeout,
      location: {
        reload: () => {
          reloads += 1;
        },
      },
    },
  });

  await assert.rejects(update.installUpdate(manifest().versions[0], 'github'), /SHA-256 校验失败/);
  assert.equal(currentContent, 'old');
  assert.equal(reloads, 0);
});
