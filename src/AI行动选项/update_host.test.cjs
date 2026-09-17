/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- 跨 realm 安装生命周期测试。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture({ failWrite = false, corrupt = false, saveSettings = async () => {} } = {}) {
  const content = '/* verified script */'.repeat(800);
  let trees = [
    {
      type: 'folder',
      scripts: [
        { id: 'current', content: 'old' },
        { id: 'other', content: 'untouched' },
      ],
    },
  ];
  const notices = [];
  const timers = [];
  let reloads = 0;
  let iframeWrites = 0;
  let detached = false;
  const host = vm.createContext({
    console,
    document: {
      createElement: () => ({
        style: {},
        children: [],
        isConnected: false,
        setAttribute() {},
        append(...children) {
          this.children.push(...children);
        },
        showPopover() {
          this.visible = true;
        },
        remove() {
          this.isConnected = false;
        },
      }),
      body: {
        append(node) {
          node.isConnected = true;
          notices.push(node);
        },
      },
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    location: {
      reload: () => {
        reloads++;
      },
    },
    TavernHelper: {
      builtin: { saveSettings },
      getScriptTrees: () => structuredClone(trees),
      updateScriptTreesWith: updater => {
        if (failWrite) throw new Error('模拟写入失败');
        trees = updater(structuredClone(trees));
        detached = true;
        return trees;
      },
    },
  });
  vm.runInContext('window = globalThis; Function = globalThis.Function', host);
  const hostWindow = vm.runInContext('globalThis', host);
  const modules = {};
  function load(name) {
    if (modules[name]) return modules[name].exports;
    const module = { exports: {} };
    modules[name] = module;
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync(`${__dirname}/${name}.ts`, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        module,
        exports: module.exports,
        console,
        AbortController,
        TextEncoder,
        crypto: webcrypto,
        window: { top: hostWindow, setTimeout, clearTimeout },
        getScriptId: () => 'current',
        getScriptTrees: () => structuredClone(trees),
        updateScriptTreesWith: updater => {
          iframeWrites++;
          trees = updater(trees);
          detached = true;
        },
        fetch: async () => ({ ok: true, text: async () => content }),
        require: id =>
          id === 'zod'
            ? require('zod')
            : id === './version'
              ? { SCRIPT_VERSION: '1.6.2', UPDATE_REPOSITORY: 'emo-lsp/ai-action-options' }
              : load(id.replace('./', '')),
      },
    );
    return module.exports;
  }
  return {
    update: load('update'),
    notices,
    timers,
    hostWindow,
    state: () => ({ trees, reloads, iframeWrites, detached }),
    release: {
      version: '1.6.2-testing.4',
      releasedAt: '2026-09-17',
      channel: 'beta',
      changes: ['测试'],
      ref: 'v1.6.2-testing.4',
      path: 'index.js',
      sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(content).digest('hex'),
    },
  };
}

test('安装导致旧 iframe 卸载后，宿主仍显示成功通知并刷新整页', async () => {
  const f = fixture();
  await f.update.installUpdate(f.release, 'github');
  assert.equal(f.state().iframeWrites, 0, '替换必须在宿主 realm 执行');
  assert.equal(f.state().detached, true);
  assert.equal(f.state().trees[0].scripts[1].content, 'untouched');
  assert.equal(f.notices[0].children[0].textContent, '更新成功');
  assert.equal(f.notices[0].visible, true);
  const timer = f.timers.find(item => item.delay === 3_000);
  assert.ok(timer.callback instanceof f.hostWindow.Function, '回调必须属于宿主，不能属于已销毁 iframe');
  timer.callback();
  assert.equal(f.state().reloads, 1);
});

test('宿主写入失败时显示失败通知且不刷新', async () => {
  const f = fixture({ failWrite: true });
  await assert.rejects(f.update.installUpdate(f.release, 'github'), /模拟写入失败/);
  assert.equal(f.notices[0].children[0].textContent, '安装失败');
  assert.equal(
    f.timers.some(item => item.delay === 3_000),
    false,
  );
  assert.equal(f.state().trees[0].scripts[0].content, 'old');
});

test('校验失败不交给宿主安装，也不显示成功或刷新', async () => {
  const f = fixture({ corrupt: true });
  await assert.rejects(f.update.installUpdate(f.release, 'github'), /SHA-256/);
  assert.equal(f.notices.length, 0);
  assert.equal(f.timers.length, 0);
  assert.equal(f.state().detached, false);
});

test('全局脚本等待保存确认后才显示成功并安排刷新', async () => {
  let completeSave;
  const saved = new Promise(resolve => {
    completeSave = resolve;
  });
  const f = fixture({ saveSettings: () => saved });
  const installation = f.update.installUpdate(f.release, 'github');
  // 下载摘要和写入先完成，保存仍处于挂起状态。
  for (let i = 0; i < 20 && !f.state().detached; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(f.state().detached, true);
  assert.equal(f.notices.length, 0);
  assert.equal(f.timers.length, 0);
  completeSave();
  await installation;
  assert.equal(f.notices[0].children[0].textContent, '更新成功');
  assert.equal(f.timers[0].delay, 3_000);
});

test('保存失败不报告成功、不刷新页面', async () => {
  const f = fixture({
    saveSettings: async () => {
      throw new Error('模拟保存失败');
    },
  });
  await assert.rejects(f.update.installUpdate(f.release, 'github'), /模拟保存失败/);
  assert.equal(f.notices[0].children[0].textContent, '安装失败');
  assert.equal(
    f.timers.some(item => item.delay === 3_000),
    false,
  );
});
