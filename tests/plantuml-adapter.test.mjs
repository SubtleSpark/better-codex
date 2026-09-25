import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
const source = await fs.readFile(new URL('../src/plantuml/renderer.js', import.meta.url), 'utf8');

test('DOM adapter：空外壳不隐藏父区域；嵌套 pre 只处理一次', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`document.body.innerHTML = '<article><div id="empty" data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>plantuml</div></div></div><div id="nested" data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>puml</div><button>Copy</button></div><pre><code>A -&gt; B</code></pre></div></article>'`);
  await page.evaluate(source);
  const packet = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  assert.equal(packet.requests.length, 1);
  assert.equal(packet.requests[0].source, 'A -> B');
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 1);
  assert.notEqual(await page.evaluate('getComputedStyle(document.querySelector("article")).display'), 'none');
  await page.evaluate('window.__BETTER_CODEX_PLANTUML__.destroy()');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-better-codex-plantuml-ui]").length'), 0);
});
