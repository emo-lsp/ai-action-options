/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- 此文件只在 Node.js 中运行，不参与酒馆浏览器构建。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'CommonJS',
  moduleResolution: 'Node',
});
require('ts-node/register/transpile-only');

const {
  cleanupCacheInspectorMonitorPatches,
  installCacheInspectorMonitor,
} = require('../世界书管理器/cache-inspector/monitor.ts');
const { captureChatCompletionUsage } = require('./usage_capture.ts');

const TARGET_API = '/api/backends/chat-completions/generate';
const originalGlobals = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  indexedDB: globalThis.indexedDB,
  CustomEvent: globalThis.CustomEvent,
  consoleInfo: console.info,
  consoleWarn: console.warn,
  consoleError: console.error,
  consoleLog: console.log,
};

function installTestEnvironment() {
  let targetFetchCalls = 0;
  const targetResponse = () =>
    new Response(
      JSON.stringify({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const targetFetch = async () => {
    targetFetchCalls += 1;
    return targetResponse();
  };
  const testWindow = {
    fetch: targetFetch,
    location: { href: 'http://localhost/' },
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    CustomEvent: globalThis.CustomEvent,
  };
  testWindow.parent = testWindow;
  testWindow.top = testWindow;

  globalThis.window = testWindow;
  globalThis.fetch = async url => {
    if (String(url).includes('frankfurter') || String(url).includes('open.er-api')) {
      return new Response(JSON.stringify({ rates: { CNY: 6.8032 } }));
    }
    return targetFetch(url);
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  testWindow.CustomEvent = globalThis.CustomEvent;
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};

  return {
    testWindow,
    getTargetFetchCalls: () => targetFetchCalls,
  };
}

function cleanupTestEnvironment() {
  try {
    cleanupCacheInspectorMonitorPatches();
  } catch {
    // 测试清理失败不能覆盖真正的断言结果。
  }
  globalThis.fetch = originalGlobals.fetch;
  if (originalGlobals.window === undefined) delete globalThis.window;
  else globalThis.window = originalGlobals.window;
  if (originalGlobals.indexedDB === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = originalGlobals.indexedDB;
  if (originalGlobals.CustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalGlobals.CustomEvent;
  console.info = originalGlobals.consoleInfo;
  console.warn = originalGlobals.consoleWarn;
  console.error = originalGlobals.consoleError;
  console.log = originalGlobals.consoleLog;
}

test('host fetch is already accessor-managed时不应与其形成递归', async () => {
  const { testWindow, getTargetFetchCalls } = installTestEnvironment();
  let monitorCaptureLogs = 0;
  console.info = (...args) => {
    if (String(args[0] ?? '').includes('fetch 捕获生成请求')) {
      monitorCaptureLogs += 1;
      if (monitorCaptureLogs >= 8) {
        throw new Error('bounded fetch recursion');
      }
    }
  };
  const handle = installCacheInspectorMonitor();

  try {
    await assert.doesNotReject(async () => {
      const result = await captureChatCompletionUsage('probe-marker', async () => {
        const response = await testWindow.fetch(TARGET_API, {
          method: 'POST',
          body: JSON.stringify({
            custom_include_body: { __tlao_usage_capture_id: 'probe-marker' },
          }),
        });
        return response.text();
      });
      assert.equal(result.result.includes('usage'), true);
      assert.equal(result.capturedUsage, null);
      assert.equal(result.fetchHookSkipped, true);
    });
    assert.equal(monitorCaptureLogs, 1);
    assert.equal(getTargetFetchCalls(), 1);
  } finally {
    handle.destroy();
    cleanupTestEnvironment();
  }
});

test('没有外部 fetch 访问器时仍应捕获返回的 usage', async () => {
  const { testWindow, getTargetFetchCalls } = installTestEnvironment();

  try {
    const result = await captureChatCompletionUsage('probe-marker', async () => {
      const response = await testWindow.fetch(TARGET_API, {
        method: 'POST',
        body: JSON.stringify({
          custom_include_body: { __tlao_usage_capture_id: 'probe-marker' },
        }),
      });
      return response.text();
    });
    assert.equal(result.fetchHookSkipped, false);
    assert.deepEqual(result.capturedUsage?.usage, {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
    assert.equal(getTargetFetchCalls(), 1);
    assert.equal(testWindow.fetch.name, 'targetFetch');
  } finally {
    cleanupTestEnvironment();
  }
});
