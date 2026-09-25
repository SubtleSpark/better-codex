import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
import { PlantUmlBridge } from '../src/plantuml/bridge.mjs';

const source = await fs.readFile(new URL('../src/plantuml/renderer.js', import.meta.url), 'utf8');
const API = 'window.__BETTER_CODEX_PLANTUML__';
const aliases = ['plantuml-svg', 'puml-svg', 'plantuml', 'puml'];

// 复现明确语言标签，不依赖用户的文件名、路径或架构源码。
const markup = [
  name => `<pre><code class="language-${name}">A -&gt; B</code></pre>`,
  name => `<pre data-language="${name}"><code>A -&gt; B</code></pre>`,
  name => `<pre><code data-lang="${name}">A -&gt; B</code></pre>`,
  name => `<div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>${name}</div><button>Copy</button></div><div><code>A -&gt; B</code></div></div>`,
  name => `<span>${name}</span><pre><code>A -&gt; B</code></pre>`,
  name => `<div data-markdown-copy="code-block"><div data-markdown-copy="exclude">${name}</div><pre><code>A -&gt; B</code></pre></div>`,
];

test('SVG alias：class/data/toolbar 均识别；大小写、空白和原语言兼容', { timeout: 30000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  for (const name of aliases) for (const shape of markup) {
    await page.evaluate(`${API}?.destroy(); document.body.innerHTML = ${JSON.stringify(shape(name))};`);
    await page.evaluate(source);
    const packet = await page.evaluate(`${API}.drain()`);
    assert.equal(packet.requests.length, 1, `${name}: ${shape(name)}`);
    assert.equal(packet.requests[0].source, 'A -> B');
  }
  await page.evaluate(`${API}.destroy(); document.body.innerHTML = '<pre data-lang="  PLANTUML-SVG  "><code>A -&gt; B</code></pre>';`);
  await page.evaluate(source);
  assert.equal((await page.evaluate(`${API}.drain()`)).requests.length, 1);
});

test('只匹配明确语言；不把代码正文、Copy 标签、前一个代码块识别为语言', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  for (const name of ['plantuml-png', 'puml-ascii', 'plantuml-svg-extra', 'mermaid', 'java']) {
    await page.evaluate(`${API}?.destroy(); document.body.innerHTML = ${JSON.stringify(markup[0](name))};`);
    await page.evaluate(source);
    assert.equal((await page.evaluate(`${API}.drain()`)).requests.length, 0, name);
  }
  await page.evaluate(`${API}.destroy(); document.body.innerHTML = ${JSON.stringify(`
    <div><button><span>plantuml-svg</span></button></div><pre><code>A -&gt; B</code></pre>
    <pre><code>plantuml-svg</code></pre><pre><code>A -&gt; B</code></pre>
    <div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>plantuml-svg</div></div><code>A -&gt; B</code></div>
    <pre><code>A -&gt; C</code></pre>
    <div data-diff>${markup[0]('plantuml-svg')}</div>
    <div contenteditable="true">${markup[0]('puml-svg')}</div>
  `)};`);
  await page.evaluate(source);
  assert.equal((await page.evaluate(`${API}.drain()`)).requests.length, 1);
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 1);
});

test('SVG alias 真实链路：渲染、Copy/源码保留、日志、重复注入、卸载', { timeout: 30000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  const logs = [];
  const bridge = new PlantUmlBridge({ debug: true, log: value => logs.push(value) });
  t.after(() => bridge.close());
  const diagram = '@startuml\nhide footbox\nskinparam shadowing false\nbox "本机" #EAF2F8\nparticipant "本地仓库" as A\nparticipant "任务" as B\nend box\nA -> B: PRIVATE_TEST_TEXT\n@enduml';
  await page.evaluate(`document.body.innerHTML = ${JSON.stringify(markup[3]('plantuml-svg'))};
    document.querySelector('code').textContent = ${JSON.stringify(diagram)};
    document.querySelector('button').onclick = () => window.copyHit = true;`);
  const evaluate = async (expression, options) => ({ result: { value: await page.evaluate(expression, options) } });
  for (let i = 0; i < 200; i++) {
    await bridge.poll('test-target', evaluate);
    if (await page.evaluate('document.querySelector(".bc-puml img")?.naturalWidth > 0 && document.querySelector("[data-better-codex-plantuml-source-hidden]") !== null')) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(await page.evaluate('document.querySelector(".bc-puml img").naturalWidth > 0'), true);
  assert.equal(await page.evaluate('document.querySelector("code").textContent'), diagram);
  await page.evaluate('document.querySelector("button").click()');
  assert.equal(await page.evaluate('window.copyHit'), true);
  await bridge.poll('test-target', evaluate);
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 1);
  assert.match(logs.join('\n'), /"plantuml-svg":1/);
  assert.match(logs.join('\n'), /"event":"render-complete"/);
  assert.match(logs.join('\n'), /"event":"image-loaded"/);
  assert.doesNotMatch(logs.join('\n'), /PRIVATE_TEST_TEXT|本地仓库|@startuml/);
  await page.evaluate(`${API}.destroy()`);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-better-codex-plantuml-ui], [data-better-codex-plantuml-source-hidden]").length'), 0);
});
