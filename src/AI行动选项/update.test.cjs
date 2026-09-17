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
        if (id === './update_host')
          return {
            startHostUpdate:
              globals.startHostUpdate ??
              (() => {
                throw new Error('未模拟宿主安装');
              }),
          };
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

test('自动端点比较可用清单，同版本优先 CDN，24 小时内使用缓存', async () => {
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
  assert.equal(requests.length, 3);
  await update.checkForUpdates({ endpoint: 'auto' });
  assert.equal(requests.length, 3, '缓存期内不应重复请求');
});

test('CDN 成功返回三个旧版本时，立即检查应从原站取回四个版本', async () => {
  const makeManifest = count => ({
    schemaVersion: 1,
    latest: `1.6.2-testing.${count}`,
    versions: Array.from({ length: count }, (_, index) => ({
      ...manifest().versions[0],
      version: `1.6.2-testing.${index + 1}`,
      ref: `v1.6.2-testing.${index + 1}`,
      channel: 'beta',
    })),
  });
  let publishedCount = 3;
  const requests = [];
  const update = loadUpdate({
    fetch: async url => {
      requests.push(url);
      return {
        ok: true,
        json: async () => makeManifest(url.includes('raw.githubusercontent.com') ? publishedCount : 3),
      };
    },
  });
  await update.checkForUpdates({ endpoint: 'auto' });
  publishedCount = 4;
  const cached = await update.checkForUpdates({ endpoint: 'auto' });
  assert.equal(cached.manifest.versions.length, 3);
  const refreshed = await update.checkForUpdates({ endpoint: 'auto', force: true });
  assert.equal(refreshed.manifest.versions.length, 4);
  assert.equal(refreshed.manifest.latest, '1.6.2-testing.4');
  assert.equal(refreshed.endpointUsed, 'github');
  assert.equal(requests.length, 6);
});

test('固定端点仅请求所选端点；自动模式允许原站不可用', async () => {
  const requests = [];
  const update = loadUpdate({
    fetch: async url => {
      requests.push(url);
      if (url.includes('raw.githubusercontent.com')) throw new Error('原站不可达');
      return { ok: true, json: async () => manifest() };
    },
  });
  const selected = await update.checkForUpdates({ endpoint: 'testingcf', force: true });
  assert.equal(selected.endpointUsed, 'testingcf');
  assert.equal(requests.length, 1);
  const automatic = await update.checkForUpdates({ endpoint: 'auto', force: true });
  assert.equal(automatic.status, 'success');
  assert.equal(automatic.endpointUsed, 'testingcf');
});

test('安装前校验 SHA-256，通过后把完整内容和脚本 ID 交给宿主', async () => {
  const content = `/* release */\n${'x'.repeat(12_000)}`;
  const sha256 = createHash('sha256').update(content).digest('hex');
  let payload;
  let reloads = 0;
  const update = loadUpdate({
    startHostUpdate: value => {
      payload = value;
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
  assert.equal(payload.scriptId, 'current-script');
  assert.equal(payload.content, content);
  assert.equal(payload.version, '1.8.0');
  assert.equal(reloads, 0);
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
