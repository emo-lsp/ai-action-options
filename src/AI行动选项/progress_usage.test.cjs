/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Node.js 定向回归测试。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadIndexWithUsageSnapshot(snapshot) {
  const source = `${fs.readFileSync(`${__dirname}/index.ts`, 'utf8')}\nmodule.exports = { getProgressUsageSummary };`;
  const module = { exports: {} };
  const imports = {
    '@util/script': {},
    './api': { MAX_FORMAT_RETRIES: 2 },
    './global_regex': {},
    './options': {},
    './popup': {},
    './custom_presets': {},
    './settings': {},
    './runtime': { getApiUsageSnapshot: () => snapshot },
    './context': {},
    './character_source': {},
    './worldbooks': {},
    './update': {},
  };
  const context = {
    module,
    exports: module.exports,
    console,
    $: () => {},
    require: id => {
      if (id.endsWith('.scss')) return {};
      if (id in imports) return imports[id];
      throw new Error(`未模拟依赖 ${id}`);
    },
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return module.exports;
}

function loadPricing() {
  const source = fs.readFileSync(`${__dirname}/pricing.ts`, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { module, exports: module.exports, console, require: () => ({}) },
  );
  return module.exports;
}

test('缓存统计被抑制时仍显示已计算出的价格估算', () => {
  const index = loadIndexWithUsageSnapshot({
    status: 'success',
    cacheStatsAvailable: false,
    cacheStatsSuppressed: true,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    hitRate: null,
    estimatedCostCny: 0.000123,
    pricingPeriod: 'off-peak',
  });

  const summary = index.getProgressUsageSummary();
  assert.ok(summary, '价格有效时不应因缓存统计被抑制而隐藏价格卡片');
  assert.equal(summary.priceText, '¥0.000');
  assert.equal(summary.showCacheStats, false);
});

test('成功弹窗价格保留三位小数并四舍五入', () => {
  const index = loadIndexWithUsageSnapshot({
    status: 'success',
    cacheStatsAvailable: false,
    cacheStatsSuppressed: false,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    hitRate: null,
    estimatedCostCny: 0.0015,
    pricingPeriod: 'off-peak',
  });

  assert.equal(index.getProgressUsageSummary().priceText, '¥0.002');
});

test('DeepSeek 当前官方模型 deepseek-flash 能计算价格', () => {
  const pricing = loadPricing();
  const requestedAt = Date.UTC(2026, 8, 13, 10, 0, 0);
  const snapshot = pricing.buildDeepSeekUsageSnapshot({
    model: 'deepseek-flash',
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
    requestedAt,
    finishedAt: requestedAt + 5000,
  });

  assert.ok(snapshot, 'deepseek-flash 应归入现有 Flash 计价档');
  assert.equal(snapshot.estimatedCostCny, 0.0014);
  assert.match(snapshot.note, /¥0\.001$/u, '计费说明也应按三位小数显示');
});

test('DeepSeek V4 Pro 使用当前官方独立单价', () => {
  const pricing = loadPricing();
  const requestedAt = Date.UTC(2026, 8, 13, 10, 0, 0);
  const snapshot = pricing.buildDeepSeekUsageSnapshot({
    model: 'deepseek-v4-pro',
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
    requestedAt,
    finishedAt: requestedAt + 5000,
  });

  assert.ok(snapshot);
  assert.ok(Math.abs(snapshot.estimatedCostCny - 0.00585) < 1e-12);
});
