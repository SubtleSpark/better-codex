import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';

const source = await fs.readFile(new URL('../src/plantuml/renderer.js', import.meta.url), 'utf8');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="white"/><text x="8" y="30">用户 → 服务</text></svg>';

test('真实 Chromium：识别、源码保留、重复注入、陈旧结果、SVG 安全、CSP 回退、cleanup', { timeout: 30000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`document.body.innerHTML = ${JSON.stringify(`
    <article id="preview">
      <pre id="one"><code class="language-plantuml"><span>@startuml</span>\nA -&gt; B\n@enduml</code></pre>
      <pre id="two" data-language="puml"><code>A -&gt; C</code></pre>
      <pre id="plain"><code class="language-java">@startuml\nA -&gt; D\n@enduml</code></pre>
      <pre id="mermaid"><code class="language-mermaid">graph TD; A-->B</code></pre>
      <div class="monaco-editor"><pre><code class="language-plantuml">A -&gt; D</code></pre></div>
      <div data-diff><pre><code class="language-plantuml">A -&gt; E</code></pre></div>
    </article>`)};`);
  await page.evaluate(source);
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 2);
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'block');
  let packet = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  assert.equal(packet.requests.length, 2);
  assert.equal(packet.requests[0].source, '@startuml\nA -> B\n@enduml');
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: packet.session, results: packet.requests.map(r => ({ ...r, ok: true, svg })) })})`);
  await page.until('document.querySelector("#one").hasAttribute("data-better-codex-plantuml-source-hidden")');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'none');
  assert.equal(await page.evaluate('document.querySelector("#one code").textContent'), '@startuml\nA -> B\n@enduml');
  await page.evaluate('document.querySelector("#one").nextElementSibling.querySelector("button").click()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'block');
  await page.evaluate('document.querySelector("#one").nextElementSibling.querySelector("button").click()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'none');
  await page.evaluate(source);
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 2);
  assert.equal((await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()')).requests.length, 0);

  // 内容原地变更、language block 被 React 复用时，旧图片立即让位给源码。
  await page.evaluate('document.querySelector("#one code").textContent = "A -> B: changed"; window.__BETTER_CODEX_PLANTUML__.scan()');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'block');
  const changed = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: packet.session, results: [{ ...packet.requests[0], ok: true, svg }] })})`);
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#one")).display'), 'block');
  assert.equal(changed.requests[0].revision, 2);
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: changed.session, results: [{ ...changed.requests[0], ok: false, code: 'SYNTAX_ERROR', message: '语法错误' }] })})`);
  assert.equal(await page.evaluate('document.querySelector("#one").nextElementSibling.textContent.includes("语法错误")'), true);

  // 重试；SVG 的脚本、外部资源和事件属性不会进入最终图片。
  await page.evaluate('document.querySelector("#one").nextElementSibling.querySelectorAll("button")[2].click()');
  const retry = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  const hostile = svg.replace('</svg>', '<script>window.PWNED=true</script><image href="https://example.com/secret"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject><a href="javascript:alert(1)"><text onclick="alert(1)">safe text</text></a></svg>');
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: retry.session, results: [{ ...retry.requests[0], ok: true, svg: hostile }] })})`);
  await page.until('document.querySelector("#one").hasAttribute("data-better-codex-plantuml-source-hidden")');
  const sanitized = await page.evaluate('fetch(document.querySelector("#one").nextElementSibling.querySelector("img").src).then(r=>r.text())');
  assert.doesNotMatch(sanitized, /script|foreignObject|https:\/\/example|onclick|javascript:/);
  assert.match(sanitized, /safe text/);
  assert.equal(await page.evaluate('window.PWNED === undefined'), true);

  // src text, 行标记和 Copy 装饰分离；无需使用 innerText 丢失换行。
  await page.evaluate('document.querySelector("#preview").insertAdjacentHTML("beforeend", `<pre id="lines"><code class="language-puml"><span class="line"><span class="line-number">1</span>A -&gt; B</span><span class="line">B -&gt; C</span></code></pre>`); window.__BETTER_CODEX_PLANTUML__.scan()');
  const lines = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  assert.equal(lines.requests[0].source, 'A -> B\nB -> C');
  await page.evaluate('document.querySelector("#lines").remove(); window.__BETTER_CODEX_PLANTUML__.scan()');
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: lines.session, results: [{ ...lines.requests[0], ok: true, svg }] })})`);
  assert.equal(await page.evaluate('document.querySelectorAll("section.bc-puml").length'), 2);

  // 图片被宿主 CSP 拦截时，必须保留源码而不是空白。
  await page.evaluate(`const meta=document.createElement('meta'); meta.httpEquiv='Content-Security-Policy'; meta.content="img-src 'none'"; document.head.append(meta); document.querySelector('#two code').textContent='B -> C: CSP'; window.__BETTER_CODEX_PLANTUML__.scan();`);
  const blocked = await page.evaluate('window.__BETTER_CODEX_PLANTUML__.drain()');
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML__.applyResults(${JSON.stringify({ session: blocked.session, results: blocked.requests.map(r => ({ ...r, ok: true, svg })) })})`);
  await page.until('document.querySelector("#two").nextElementSibling.textContent.includes("CSP")');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#two")).display'), 'block');
  await page.evaluate('window.__BETTER_CODEX_PLANTUML__.destroy()');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-better-codex-plantuml-ui]").length'), 0);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-better-codex-plantuml-source-hidden]").length'), 0);
  assert.equal(await page.evaluate('document.querySelector("#mermaid code").textContent'), 'graph TD; A-->B');
});
