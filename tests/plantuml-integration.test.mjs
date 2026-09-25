import assert from 'node:assert/strict';
import test from 'node:test';
import { PlantUmlBridge } from '../src/plantuml/bridge.mjs';
import { browser } from './helpers/browser.mjs';

test('完整本地链路：DOM → CDP → Worker/真实 TeaVM/Viz → SVG img', { timeout: 45000 }, async t => {
  const page = await browser();
  const bridge = new PlantUmlBridge({ log: () => {} });
  t.after(async () => { await bridge.close(); await page.close(); });
  await page.evaluate(`document.body.innerHTML = '<pre><code class="language-plantuml"></code></pre>'; document.querySelector('code').textContent = ${JSON.stringify('@startuml\nclass "用户" as User\nclass Order\nUser --> Order\n@enduml')};`);
  const evaluate = async (expression, options = {}) => {
    const result = await page.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...options });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result;
  };
  const end = Date.now() + 25000;
  let loaded = false;
  while (Date.now() < end) {
    await bridge.poll('integration-page', evaluate);
    loaded = await page.evaluate('!!document.querySelector("section.bc-puml img")?.naturalWidth');
    if (loaded) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(loaded, true, await page.evaluate('document.body.innerText'));
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("pre")).display'), 'none');
  assert.equal(await page.evaluate('document.querySelector("section.bc-puml img").src.startsWith("blob:")'), true);
  await page.evaluate('document.querySelector("section.bc-puml button").click()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("pre")).display'), 'block');
  await page.evaluate('window.__BETTER_CODEX_PLANTUML__.destroy()');
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 0);
});

test('Codex CodeSnippet：div 外壳、语言 toolbar、原生 Copy 与 root 限定', { timeout: 45000 }, async t => {
  const page = await browser();
  const bridge = new PlantUmlBridge({ log: () => {}, rootSelector: '#file-preview' });
  t.after(async () => { await bridge.close(); await page.close(); });
  const code = '@startuml\nparticipant "用户" as User\nUser -> API: 提交请求\n@enduml';
  await page.evaluate(`document.body.innerHTML = '<article id="file-preview"><div id="shell" data-markdown-copy="code-block"><div id="toolbar" data-markdown-copy="exclude"><div>plantuml</div><button id="native-copy">Copy</button></div><div id="code-scroll"><code><span></span></code></div></div><div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>javascript</div></div><code>const puml = 1;</code></div></article><article id="chat"><pre><code class="language-puml">A -&gt; B</code></pre></article>'; document.querySelector('#shell code span').textContent = ${JSON.stringify(code)}; window.copied = false; document.querySelector('#native-copy').onclick = () => { window.copied = true; };`);
  const evaluate = async (expression, options = {}) => {
    const result = await page.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...options });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result;
  };
  const end = Date.now() + 25000;
  let loaded = false;
  while (Date.now() < end) {
    await bridge.poll('codex-shell', evaluate);
    loaded = await page.evaluate('!!document.querySelector("section.bc-puml img")?.naturalWidth');
    if (loaded) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(loaded, true, await page.evaluate('document.body.innerText'));
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 1);
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#code-scroll")).display'), 'none');
  assert.notEqual(await page.evaluate('getComputedStyle(document.querySelector("#toolbar")).display'), 'none');
  assert.equal(await page.evaluate('document.querySelector("#shell code").textContent'), code);
  await page.evaluate('document.querySelector("#native-copy").click()');
  assert.equal(await page.evaluate('window.copied'), true);
  assert.equal(await page.evaluate('document.querySelector("section.bc-puml").getAttribute("data-markdown-copy")'), 'exclude');
  await page.evaluate('document.querySelector("section.bc-puml button").click()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#code-scroll")).display'), 'block');
  // 同版本重新注入时也应用新 root 配置，不需要 reload Codex。
  bridge.rootSelector = '#chat';
  await bridge.poll('codex-shell', evaluate);
  assert.equal(await page.evaluate('document.querySelectorAll("#file-preview section.bc-puml").length'), 0);
  assert.equal(await page.evaluate('document.querySelectorAll("#chat section.bc-puml").length'), 1);
});
