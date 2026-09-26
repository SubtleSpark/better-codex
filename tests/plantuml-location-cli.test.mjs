import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { main, parseArgs } from '../scripts/locate-plantuml.mjs';

test('定位 CLI：参数边界，无效参数不访问 CDP', async () => {
  assert.equal(parseArgs(['--delay', '0']).delay, 0);
  for (const args of [['--delay', '-1'], ['--delay', '61'], ['--port', '0'], ['--port'], ['--host', 'external']]) {
    assert.throws(() => parseArgs(args), /INVALID_ARGUMENT/);
    await assert.rejects(main(args), /INVALID_ARGUMENT/);
  }
});

test('定位 CLI：App/唯一关联 guest 才可读取，截图仅 App，报告脱敏且传播截断', async () => {
  const saved = { fetch: globalThis.fetch, ws: globalThis.WebSocket, log: console.log, exit: process.exitCode };
  const calls = [], output = [], dirs = [];
  const targets = [
    { type: 'page', url: 'app://-/index.html?PRIVATE', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/app' },
    { type: 'webview', url: 'https://SECRET.example/?PRIVATE', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/guest' },
    { type: 'webview', url: 'https://UNRELATED.example/', webSocketDebuggerUrl: 'ws://127.0.0.1:9347/devtools/page/other' },
  ];
  class MockSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(address) { super(); this.target = targets.find(t => t.webSocketDebuggerUrl === address); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const c = JSON.parse(text); calls.push({ ...c, target: this.target });
      queueMicrotask(() => {
        const send = data => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
        let result = {};
        if (c.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'top', url: this.target.url } } };
        if (c.method === 'Runtime.enable') send({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, auxData: { isDefault: true, frameId: 'top' } } } });
        if (c.method === 'Runtime.evaluate') result.result = { value: c.params.contextId
          ? { labels: [], truncated: true, embeds: [{ matchingTargets: [2] }] }
          : { focused: true, visibility: 'visible', plantumlInstalled: true, selectedPlantumlLabel: false } };
        if (c.method === 'DOM.getDocument') result.root = { nodeType: 9, children: [
          { nodeType: 1, nodeName: 'DIV', children: [{ nodeType: 3, nodeValue: 'plantuml-svg' }] },
          { nodeType: 1, nodeName: 'DIV', children: [{ nodeType: 3, nodeValue: 'SECRET_SOURCE' }] },
        ] };
        if (c.method === 'Page.captureScreenshot') result.data = Buffer.from('TEST_IMAGE_BYTES').toString('base64');
        send({ id: c.id, result });
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => targets });
  globalThis.WebSocket = MockSocket;
  console.log = value => output.push(JSON.parse(value.slice(value.indexOf('{'))));
  try {
    await main(['--delay', '0']);
    assert.ok(calls.every(c => c.target === targets[0]));
    assert.equal(calls.some(c => c.method === 'Page.captureScreenshot'), false);
    calls.length = 0; output.length = 0;
    await main(['--delay', '0', '--include-guests', '--screenshot']);
    const summary = output.find(x => x.event === 'done'); dirs.push(summary.screenshotDirectory);
    assert.equal(summary.incomplete, true); assert.equal(summary.truncated, true);
    assert.equal(summary.plantumlEvidenceFound, true);
    assert.ok(calls.some(c => c.target === targets[1]));
    assert.ok(calls.every(c => c.target !== targets[2]));
    assert.deepEqual(calls.filter(c => c.method === 'Page.captureScreenshot').map(c => c.target), [targets[0]]);
    const screenshot = output.find(x => x.screenshot)?.screenshot;
    assert.equal(await fs.readFile(screenshot, 'utf8'), 'TEST_IMAGE_BYTES');
    assert.equal((await fs.stat(screenshot)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(output).includes('SECRET'), false);
    assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(output).includes('UNRELATED'), false);
    const allowed = new Set(['Page.getFrameTree', 'Runtime.enable', 'Runtime.evaluate', 'DOM.getDocument', 'Page.captureScreenshot']);
    assert.ok(calls.every(c => allowed.has(c.method)));
  } finally {
    globalThis.fetch = saved.fetch; globalThis.WebSocket = saved.ws; console.log = saved.log; process.exitCode = saved.exit;
    await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
});
