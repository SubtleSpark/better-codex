import assert from 'node:assert/strict';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
import { matchGuestFrame, guestProbeExpression, inspectTarget, main } from '../scripts/diagnose-plantuml.mjs';

// 使用真实协议的 url + urlFragment 形态，而不是让 mock 的 frame.url 携带 hash。
test('guest URL：重组 fragment；不放宽 host/path/query/hash 校验', () => {
  for (const base of ['https://private.example/view?q=SECRET', 'codex-sandbox://PRIVATE/view?q=SECRET', 'blob:https://private.example/SECRET']) {
    const result = matchGuestFrame({ url: base, urlFragment: '#diagram' }, base + '#diagram');
    assert.equal(result.permitted, true);
    assert.equal(result.reason, 'fragment-reconstructed');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(matchGuestFrame({ url: base, urlFragment: '#other' }, base + '#diagram').permitted, false);
  }
  const url = 'https://private.example/view?q=SECRET#diagram';
  assert.equal(matchGuestFrame({ url: url.split('#')[0] }, url).reason, 'location-check-required');
  assert.equal(matchGuestFrame({ url: url.split('#')[0], urlFragment: '' }, url).permitted, false);
  for (const changed of ['https://other.example/view?q=SECRET', 'https://private.example/other?q=SECRET', 'https://private.example/view?q=OTHER']) {
    assert.equal(matchGuestFrame({ url: changed, urlFragment: '#diagram' }, url).permitted, false);
  }
  assert.equal(matchGuestFrame(undefined, url).permitted, false);
  assert.equal(matchGuestFrame({ url: 'invalid' }, url).permitted, false);
  assert.equal(matchGuestFrame({ url }, url).reason, 'exact');
});

test('真实 Chromium：复现 fragment 拆分，并验证 DOM 读取及导航后的原子拒绝', { timeout: 30000 }, async t => {
  const page = await browser(); t.after(() => page.close());
  const url = 'about:blank#SECRET_FRAGMENT';
  await page.command('Page.navigate', { url });
  await page.until('location.href === "about:blank#SECRET_FRAGMENT" && document.readyState === "complete"');
  await page.evaluate(`document.body.innerHTML = '<pre><code class="language-plantuml-svg">@startuml\\nA -&gt; B: SECRET_SOURCE\\n@enduml</code></pre>'`);
  const frame = (await page.command('Page.getFrameTree')).frameTree.frame;
  const target = (await page.command('Target.getTargetInfo')).targetInfo;
  // 旧代码在这个真实返回值上会拒绝，修复后允许；不是仅测我们自己编的 mock。
  assert.equal(target.url, url);
  assert.notEqual(frame.url, target.url);
  assert.equal(frame.url + frame.urlFragment, target.url);
  assert.equal(matchGuestFrame(frame, target.url).permitted, true);
  const before = await page.evaluate('document.documentElement.outerHTML');
  const report = await page.evaluate(guestProbeExpression(target.url));
  assert.equal(report.labels[0].language, 'plantuml-svg');
  assert.equal(report.codeCandidates[0].hasStartDirective, true);
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  assert.equal(await page.evaluate('document.documentElement.outerHTML'), before);
  await page.evaluate('history.replaceState(null, "", "#changed")');
  assert.deepEqual(await page.evaluate(guestProbeExpression(target.url)), { probeSkipped: 'GUEST_URL_CHANGED' });
  t.diagnostic('真实 TargetInfo.url 带 fragment；Page.Frame.url 不带，urlFragment 单独返回。');
});

function socketMock(frameFor, valueFor, calls) {
  return class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); this.url = url; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const command = JSON.parse(text); calls.push(command);
      queueMicrotask(() => {
        const send = data => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
        const tree = frameFor(this.url);
        let result = {};
        if (command.method === 'Page.getFrameTree') result.frameTree = tree;
        if (command.method === 'Runtime.enable') {
          [tree, ...(tree.childFrames || [])].forEach((node, i) => send({ method: 'Runtime.executionContextCreated', params: {
            context: { id: i + 1, auxData: { isDefault: true, frameId: node.frame.id } },
          } }));
        }
        if (command.method === 'Runtime.evaluate') result.result = { value: valueFor(this.url) };
        send({ id: command.id, result });
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  };
}

test('CDP guest：带 fragment 顶层进入 DOM；子页面和其它 target hints 仍排除', async () => {
  const original = globalThis.WebSocket, calls = [], output = [];
  const target = { type: 'webview', url: 'codex-sandbox://PRIVATE/view?token=SECRET#init',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/guest' };
  globalThis.WebSocket = socketMock(() => ({ frame: { id: 'root', url: target.url.split('#')[0], urlFragment: '#init' },
    childFrames: [{ frame: { id: 'child', url: 'https://OTHER_SECRET/' } }] }), () => ({ labels: [], counts: {} }), calls);
  try {
    await inspectTarget(target, 9347, p => output.push(p), { linkedGuest: true, targetHints: [{ target: 3, url: 'OTHER_SECRET' }] });
    assert.equal(output[0].skippedFrames, 1);
    assert.equal(output.find(x => x.event === 'guest-frame-check').reason, 'fragment-reconstructed');
    assert.equal(output.filter(x => x.event === 'dom').length, 1);
    const evals = calls.filter(x => x.method === 'Runtime.evaluate');
    assert.deepEqual(evals.map(x => x.params.contextId), [1]);
    assert.equal(evals[0].params.expression.includes('OTHER_SECRET'), false);
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
    assert.deepEqual([...new Set(calls.map(x => x.method))], ['Page.getFrameTree', 'Runtime.enable', 'Runtime.evaluate']);
    calls.length = 0;
    await inspectTarget({ ...target, url: target.url.replace('#init', '#changed') }, 9347, () => {}, { linkedGuest: true });
    assert.equal(calls.some(x => x.method === 'Runtime.evaluate'), false);
  } finally { globalThis.WebSocket = original; }
});

test('CLI：probe-failed 计入失败；不会把未读取的 guest 报告为 failures=0', async () => {
  const original = { ws: globalThis.WebSocket, fetch: globalThis.fetch, log: console.log, exitCode: process.exitCode };
  const targets = [
    { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/app' },
    { type: 'webview', url: 'https://PRIVATE/view#expected', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/guest' },
  ];
  const output = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => targets });
  globalThis.WebSocket = socketMock(address => ({ frame: { id: 'root', url: address.endsWith('/app') ? targets[0].url : 'https://PRIVATE/view' } }),
    address => address.endsWith('/app') ? { embeds: [{ matchingTargets: [2] }] } : { probeSkipped: 'GUEST_URL_CHANGED' }, []);
  console.log = text => output.push(JSON.parse(text.slice(text.indexOf('{'))));
  try {
    await main(['--include-guests']);
    const summary = output.find(x => x.event === 'done');
    assert.equal(summary.inspected, 2);
    assert.equal(summary.successfulTargets, 1);
    assert.equal(summary.documentsRead, 1);
    assert.equal(summary.failures, 1);
    assert.equal(summary.incomplete, true);
    assert.equal(process.exitCode, 1);
    assert.equal(output[0].reportVersion, 3);
    assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
  } finally {
    globalThis.WebSocket = original.ws; globalThis.fetch = original.fetch; console.log = original.log; process.exitCode = original.exitCode;
  }
});
