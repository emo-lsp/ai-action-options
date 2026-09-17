/* eslint-disable import-x/no-nodejs-modules, @typescript-eslint/no-require-imports -- Node.js 摘要提取定向测试。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const parsedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${__dirname}/summary_parser.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: parsedModule, exports: parsedModule.exports });
const { extractSummaries, detectSummaryTags, normalizeSummaryTag } = parsedModule.exports;
const extract = (text, tags = ['summary']) => JSON.parse(JSON.stringify(extractSummaries(text, tags)));
const rule = (name, findRegex, extra = {}) => ({ name, findRegex, replaceString: '', enabled: true, aiOutput: true, source: 'preset', ...extra });

test('原始摘要保留时间日期与事件，支持大小写和多段', () => {
  assert.deepEqual(extract('正文<SUMMARY>时间日期：2025/03/17 07:30\n摘要：已买吉他。</SUMMARY><summary>后来出门。</summary>'), [
    { tag: 'summary', text: '时间日期：2025/03/17 07:30\n摘要：已买吉他。' },
    { tag: 'summary', text: '后来出门。' },
  ]);
});

test('识别摘要折叠正文，不把摘要标题、思维折叠或其他折叠内容当成剧情', () => {
  assert.deepEqual(extract('<details><summary>摘要</summary>日期：今天\n事件：买琴</details>'), [{ tag: 'summary', text: '日期：今天\n事件：买琴' }]);
  assert.deepEqual(extract('<details><summary>思考了一会</summary><summary>猜测剧情</summary></details><summary>真实事件</summary>'), [{ tag: 'summary', text: '真实事件' }]);
  assert.deepEqual(extract('<details><summary>摘要生成规则</summary>示例内容</details>'), []);
});

test('排除代码、注释、格式示例、嵌套思考与行动选项中的伪摘要', () => {
  const text = [
    '```html\n<summary>代码示例</summary>\n```',
    '`<summary>行内示例</summary>`',
    '<!-- <summary>注释</summary> -->',
    '<summary_format><summary>格式示例</summary></summary_format>',
    '<think><think>内层</think><summary>猜测</summary></think>',
    '<options><summary>备选行动</summary></options>',
    '<summary>已发生事件</summary>',
  ].join('\n');
  assert.deepEqual(extract(text), [{ tag: 'summary', text: '已发生事件' }]);
});

test('空摘要、替换占位符和未闭合标签不冒充有效摘要；嵌套块不重复', () => {
  assert.deepEqual(extract('<summary></summary><summary>$1</summary><summary>未闭合'), []);
  assert.deepEqual(extract('<think><summary>未结束思考中的摘要</summary>'), []);
  assert.equal(extract('<summary>外层<summary>内层</summary></summary>').length, 1);
});

test('自定义标签允许中文与成对标签名，拒绝表达式和HTML容器', () => {
  assert.equal(normalizeSummaryTag(' <往事> '), '往事');
  assert.equal(normalizeSummaryTag('story_recap'), 'story_recap');
  for (const value of ['</summary>', '[summary]', 'summary.*', '<summary class="a">', 'details', 'think']) assert.equal(normalizeSummaryTag(value), null);
  assert.deepEqual(extract('<往事>昨天已搬家</往事>', ['往事']), [{ tag: '往事', text: '昨天已搬家' }]);
});

test('截图中的三类正则提供标签线索，替换模板里的思考折叠标题不会引入标签', () => {
  const rules = [
    rule('aether摘要三', '/[\\s\\S]*?(?<!<details>\\s*)<summary>([\\s\\S]*?)<\\/summary>[\\s\\S]*/gi'),
    rule('aether摘要二', '/(?<!<details>\\s*)<summary>([\\s\\S]*?)<\\/summary>/gi'),
    rule('aether摘要一', '/(?<!<details>\\s*)<summary>(((?!<summary>)[\\s\\S])*?)<\\/summary>/gi'),
    rule('思维链折叠', '/<thinking>([\\s\\S]*?)<\\/thinking>/g', { replaceString: '<details><summary>思考了一会</summary>$1</details>' }),
  ];
  const found = detectSummaryTags(['正文<summary>买了吉他</summary>'], rules, []);
  assert.deepEqual(Array.from(found.tags), ['summary']);
  assert.equal(found.ruleNames.length, 3);
});

test('启用的AI输出正则与预设格式可发现非标准标签，仍需消息中存在有效内容', () => {
  const rules = [rule('楼层摘要', '/<memory>(.*?)<\\/memory>/gs'), rule('停用摘要', '/<disabled>(.*?)<\\/disabled>/g', { enabled: false }), rule('用户摘要', '/<userlog>(.*?)<\\/userlog>/g', { aiOutput: false })];
  const found = detectSummaryTags(['<memory>事实</memory><往事>过去</往事><disabled>停用</disabled><userlog>用户</userlog>'], rules, ['<summary_format>摘要格式：<往事>记录</往事><unused>备用</unused></summary_format>']);
  assert.deepEqual(Array.from(found.tags), ['memory', '往事']);
  assert.deepEqual(Array.from(found.ruleNames), ['楼层摘要']);
});
