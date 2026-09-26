import assert from 'node:assert/strict';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
import { classifyTarget, describeTarget, collectPlantUmlDom, guestAllowed, inspectTarget, main } from '../scripts/diagnose-plantuml.mjs';

const expression = `(${collectPlantUmlDom.toString()})()`;

test('诊断 v2：labels 为空时仍读取代码结构和 CSS 语言名，不泄露正文、不触发渲染', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`
    document.head.innerHTML = '<style>pre::before{content:"plantuml-svg"} main::after{content:"SECRET_PSEUDO_PATH"}</style>';
    document.body.innerHTML = '<main id="SECRET_FILE"><pre><code>@startuml\\nA -&gt; B: SECRET_SOURCE\\n@enduml</code></pre></main>';
    window.calls = 0;
    window.__BETTER_CODEX_PLANTUML__ = { version: '0.10.1', drain() { window.calls++; }, scan() { window.calls++; } };
    window.before = document.documentElement.outerHTML;
  `);
  const report = await page.evaluate(expression);
  assert.equal(report.labels.length, 0);
  assert.equal(report.counts.pre, 1);
  assert.equal(report.codeCandidates.length, 1);
  const candidate = report.codeCandidates[0];
  assert.equal(candidate.hasStartDirective, true);
  assert.equal(candidate.hasEndDirective, true);
  assert.equal(candidate.ancestors[0].node.before.token.language, 'plantuml-svg');
  assert.equal(candidate.ancestors[1].node.after.present, true);
  assert.equal(candidate.ancestors[1].node.after.token, null);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  assert.equal(await page.evaluate('window.calls'), 0);
  assert.equal(await page.evaluate('document.documentElement.outerHTML === window.before'), true);
});

test('诊断 v2：新语言属性、open Shadow DOM 与 WebView 精确关联；不输出 URL', { timeout: 20000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  await page.evaluate(`
    document.body.innerHTML = '<div id="host"></div><webview src="codex-sandbox://PRIVATE_HOST/SECRET_PATH?token=SECRET_TOKEN"></webview><iframe src="about:blank"></iframe>';
    document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<pre data-private-syntax="puml-svg"><code>@startuml\\nA -&gt; B\\n@enduml</code></pre>';
    window.before = document.body.innerHTML;
  `);
  const hints = [
    { target: 3, url: 'codex-sandbox://PRIVATE_HOST/SECRET_PATH?token=SECRET_TOKEN' },
    { target: 6, url: 'https://unrelated.example/SECRET' },
    { target: 7, url: 'about:blank' },
  ];
  const report = await page.evaluate(`(${collectPlantUmlDom.toString()})(${JSON.stringify(hints)})`);
  assert.equal(report.counts.openShadowRoots, 1);
  assert.ok(report.labels.some(l => l.scope === 'open-shadow-root' && l.language === 'puml-svg'));
  assert.equal(report.codeCandidates[0].ancestors[0].node.languageEvidence[0].attribute, 'other-data-attribute');
  assert.deepEqual(report.embeds.find(e => e.tag === 'webview').matchingTargets, [3]);
  assert.deepEqual(report.embeds.find(e => e.tag === 'iframe').matchingTargets, []);
  for (const secret of ['PRIVATE_HOST', 'SECRET', 'data-private-syntax', 'unrelated.example']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(await page.evaluate('document.body.innerHTML === window.before'), true);
  const ambiguous = await page.evaluate(`(${collectPlantUmlDom.toString()})(${JSON.stringify([...hints, { ...hints[0], target: 8 }])})`);
  assert.deepEqual(ambiguous.embeds.find(e => e.tag === 'webview').matchingTargets, []);
});

test('诊断 v2：target 元数据脱敏，guest 必须显式开启且由 App 关联', () => {
  const guest = { type: 'webview', url: 'codex-sandbox://PRIVATE/SECRET' };
  assert.deepEqual(describeTarget(guest), { type: 'webview', scheme: 'codex-sandbox' });
  assert.equal(classifyTarget(guest).inspect, false);
  assert.equal(guestAllowed(guest, 1, new Set([1]), false), false);
  assert.equal(guestAllowed(guest, 1, new Set(), true), false);
  assert.equal(guestAllowed(guest, 1, new Set([1]), true), true);
  assert.equal(guestAllowed({ ...guest, type: 'service_worker' }, 1, new Set([1]), true), false);
  assert.deepEqual(describeTarget({ type: 'PRIVATE', url: 'private-company://SECRET' }), { type: 'other', scheme: 'other' });
});

function mockSockets(frameTree, report, calls) {
  return class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); this.url = url; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(value) {
      const command = JSON.parse(value); calls.push({ ...command, socket: this.url });
      queueMicrotask(() => {
        const send = data => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
        const tree = frameTree(this.url);
        let result = {};
        if (command.method === 'Page.getFrameTree') result.frameTree = tree;
        if (command.method === 'Runtime.enable') {
          [tree, ...(tree.childFrames || [])].forEach((node, index) => send({ method: 'Runtime.executionContextCreated',
            params: { context: { id: index + 1, auxData: { frameId: node.frame.id, isDefault: true } } } }));
        }
        if (command.method === 'Runtime.evaluate') result.result = { value: report(this.url) };
        send({ id: command.id, result });
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  };
}

test('诊断 v2：guest 只读已关联的顶层文档，导航变化不读取，不向 guest 传其它 URL', async () => {
  const saved = globalThis.WebSocket;
  const calls = [];
  const guestURL = 'codex-sandbox://PRIVATE/SECRET';
  globalThis.WebSocket = mockSockets(() => ({ frame: { id: 'guest', url: guestURL }, childFrames: [
    { frame: { id: 'external', url: 'https://SECRET.example/' } },
  ] }), () => ({ labels: [], codeCandidates: [] }), calls);
  try {
    const target = { type: 'webview', url: guestURL, webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/guest' };
    const output = [];
    await inspectTarget(target, 9347, p => output.push(p), { linkedGuest: true, targetHints: [{ target: 7, url: 'OTHER_SECRET_URL' }] });
    const evals = calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(evals.length, 1);
    assert.equal(evals[0].params.contextId, 1);
    assert.equal(evals[0].params.expression.includes('OTHER_SECRET_URL'), false);
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
    assert.equal(output[0].skippedFrames, 1);
    assert.deepEqual([...new Set(calls.map(c => c.method))], ['Page.getFrameTree', 'Runtime.enable', 'Runtime.evaluate']);
    calls.length = 0;
    await inspectTarget({ ...target, url: 'codex-sandbox://changed/' }, 9347, () => {}, { linkedGuest: true });
    assert.equal(calls.some(c => c.method === 'Runtime.evaluate'), false);
  } finally { globalThis.WebSocket = saved; }
});

test('诊断 v2：先关联再读 guest，不读取无关 target；默认仍只检查 App', async () => {
  const saved = { ws: globalThis.WebSocket, fetch: globalThis.fetch, log: console.log };
  const calls = [], output = [];
  const targets = [
    { type: 'webview', url: 'codex-sandbox://PRIVATE/guest', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/guest' },
    { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/app' },
    { type: 'webview', url: 'https://PRIVATE_UNRELATED/', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/unlinked' },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => targets });
  globalThis.WebSocket = mockSockets(address => ({ frame: { id: 'frame', url: targets.find(t => t.webSocketDebuggerUrl === address).url } }),
    address => ({ labels: [], embeds: address.endsWith('/app') ? [{ matchingTargets: [1] }] : [] }), calls);
  console.log = value => output.push(value);
  try {
    await main(['--port', '9347']);
    assert.ok(calls.every(c => c.socket.endsWith('/app')));
    calls.length = 0; output.length = 0;
    await main(['--port', '9347', '--include-guests']);
    assert.deepEqual([...new Set(calls.map(c => c.socket.split('/').pop()))], ['app', 'guest']);
    assert.ok(output.some(s => s.includes('"reportVersion":2')));
    assert.ok(output.some(s => s.includes('"event":"linked-guest"')));
    assert.equal(output.join('').includes('PRIVATE'), false);
  } finally { globalThis.WebSocket = saved.ws; globalThis.fetch = saved.fetch; console.log = saved.log; }
});
