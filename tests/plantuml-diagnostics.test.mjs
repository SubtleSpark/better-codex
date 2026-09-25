import assert from 'node:assert/strict';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
import { classifyTarget, validateSocket, collectPlantUmlDom, inspectTarget, main } from '../scripts/diagnose-plantuml.mjs';

const expression = `(${collectPlantUmlDom.toString()})()`;

test('诊断：区分主窗口、独立窗口和非 App 页面，WebSocket 仅限同一 loopback port', () => {
  assert.equal(classifyTarget({ type: 'page', url: 'app://-/index.html' }).injectorEligible, true);
  const detached = classifyTarget({ type: 'page', url: 'app://-/detached-window.html?secret=PRIVATE' });
  assert.deepEqual(detached, { entry: 'detached-window', inspect: true, injectorEligible: false });
  assert.equal(classifyTarget({ type: 'webview', url: 'app://-/preview.html' }).inspect, true);
  assert.equal(classifyTarget({ type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }).injectorEligible, false);
  for (const url of ['https://chatgpt.com/', 'https://private.example/', 'app://elsewhere/index.html', 'file:///private/file.md']) {
    assert.equal(classifyTarget({ type: 'page', url }).inspect, false);
  }
  assert.equal(validateSocket('ws://127.0.0.1:9347/devtools/page/test', 9347), 'ws://127.0.0.1:9347/devtools/page/test');
  for (const url of ['ws://remote:9347/test', 'wss://127.0.0.1:9347/test', 'ws://127.0.0.1:9999/test', 'ws://u:p@127.0.0.1:9347/test']) {
    assert.throws(() => validateSocket(url, 9347), /NON_LOCAL_CDP_SOCKET/);
  }
});

test('诊断：真实 Chromium 读取内部/非相邻语言标签、Shadow root，不修改页面或泄露正文', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`
    window.drains = 0;
    window.__BETTER_CODEX_PLANTUML__ = { version: '0.10.1', drain() { window.drains++; } };
    window.__BETTER_CODEX__ = { version: '0.9.4' };
    window.__BETTER_CODEX_PLANTUML_OPTIONS__ = { rootSelector: '#preview' };
    document.body.innerHTML = '<main id="preview"><h1>PRIVATE_FILE_TITLE</h1><div id="PRIVATE_ID" data-testid="PRIVATE_PATH"><pre><div><span>plantuml-svg</span><button>PRIVATE_COPY</button></div><code>SECRET_SOURCE_TOKEN</code></pre></div><div><header><span>puml-svg</span></header><div><pre>SECRET_SECOND_SOURCE</pre></div></div><div id="shadow"></div></main><div class="monaco-editor"><pre><code class="language-plantuml">PRIVATE_EDITING_CONTENT</code></pre></div><iframe src="about:blank"></iframe>';
    document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML = '<pre><code data-language="puml">SECRET_SHADOW_SOURCE</code></pre>';
    window.beforeHtml = document.body.innerHTML;
  `);
  const result = await page.evaluate(expression);
  assert.equal(result.module.version, '0.10.1');
  assert.equal(result.module.sidebarVersion, '0.9.4');
  assert.deepEqual(result.scanRoot, { configured: true, count: 1, invalid: false });
  assert.equal(result.counts.openShadowRoots, 1);
  assert.equal(result.counts.iframe, 1);
  assert.equal(result.counts.pre, 4);
  assert.ok(result.labels.some(l => l.language === 'plantuml-svg' && l.insideCode));
  assert.ok(result.labels.some(l => l.scope === 'open-shadow-root'));
  assert.ok(result.labels.some(l => l.ancestors[0].node.excluded));
  const json = JSON.stringify(result);
  for (const secret of ['PRIVATE', 'SECRET', 'preview', 'shadow']) {
    // 固定 scope 枚举 open-shadow-root 是允许输出的，不含具体 host id。
    if (secret !== 'shadow') assert.equal(json.includes(secret), false, secret);
  }
  assert.equal(await page.evaluate('window.drains'), 0);
  assert.equal(await page.evaluate('document.body.innerHTML === window.beforeHtml'), true);
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML_OPTIONS__.rootSelector = '#not-found'`);
  assert.equal((await page.evaluate(expression)).scanRoot.count, 0);
  await page.evaluate(`window.__BETTER_CODEX_PLANTUML_OPTIONS__.rootSelector = '!'`);
  assert.equal((await page.evaluate(expression)).scanRoot.invalid, true);
});

test('诊断：识别易混淆的 Unicode 横线/零宽字符，但不自动修改语言', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`document.body.innerHTML = '<pre><span>plantuml–svg</span><code>SOURCE_PRIVATE</code></pre><pre><code class="language-puml\u200b-svg">SOURCE_PRIVATE_2</code></pre>'`);
  const result = await page.evaluate(expression);
  assert.equal(result.labels.length, 2);
  assert.equal(result.labels[0].token.exact, false);
  assert.ok(result.labels[0].token.codePoints.includes(0x2013));
  assert.ok(result.labels[1].token.codePoints.includes(0x200b));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('诊断：默认 context/frame 过滤、脱敏输出和只读 CDP 调用', async () => {
  const realSocket = globalThis.WebSocket;
  const calls = [];
  let closed = false;
  class MockSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const command = JSON.parse(text); calls.push(command);
      queueMicrotask(() => {
        const respond = data => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
        let result = {};
        if (command.method === 'Page.getFrameTree') result.frameTree = { frame: { id: 'a', url: 'app://-/index.html' }, childFrames: [
          { frame: { id: 'b', url: 'about:srcdoc' } }, { frame: { id: 'c', url: 'https://private.example/' } },
        ] };
        if (command.method === 'Runtime.enable') {
          for (const [id, frameId, isDefault] of [[1, 'a', true], [2, 'b', true], [3, 'c', true], [4, 'a', false]]) {
            respond({ method: 'Runtime.executionContextCreated', params: { context: { id, auxData: { frameId, isDefault } } } });
          }
        }
        if (command.method === 'Runtime.evaluate') result.result = { value: { counts: {}, labels: [] } };
        respond({ id: command.id, result });
      });
    }
    close() { closed = true; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = MockSocket;
  try {
    const output = [];
    await inspectTarget({ webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/test' }, 9347, x => output.push(x));
    assert.equal(output[0].skippedFrames, 1);
    assert.deepEqual(calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params.contextId), [1, 2]);
    assert.deepEqual([...new Set(calls.map(c => c.method))], ['Page.getFrameTree', 'Runtime.enable', 'Runtime.evaluate']);
    assert.equal(JSON.stringify(output).includes('private'), false);
    assert.equal(closed, true);
  } finally { globalThis.WebSocket = realSocket; }
});

test('诊断 CLI 拒绝非法参数，不访问网络', async () => {
  await assert.rejects(main(['--port', '0']), /INVALID_PORT/);
  await assert.rejects(main(['--host', 'example.com']), /INVALID_ARGUMENT/);
  await assert.rejects(main(['--port']), /INVALID_ARGUMENT/);
});
