import assert from 'node:assert/strict';
import test from 'node:test';
import { PlantUmlBridge } from '../src/plantuml/bridge.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('bridge 异步、按 target/session 隔离，日志不带源码', async t => {
  const completed = [];
  const logs = [];
  const bridge = new PlantUmlBridge({ log: value => logs.push(value), service: {
    render: source => new Promise(resolve => completed.push({ source, resolve })), close: async () => {},
  } });
  t.after(() => bridge.close());
  let packet = { session: 'old', requests: [{ id: 'puml-1', revision: 1, source: 'A -> B: SECRET_TEXT' }], diagnostics: [] };
  const delivered = [];
  const evaluate = async expression => {
    if (expression.includes('?.drain')) return { result: { value: packet } };
    if (expression.startsWith('window.__BETTER_CODEX_PLANTUML__?.applyResults')) {
      delivered.push(JSON.parse(expression.slice(expression.indexOf('(') + 1, -2)));
    }
    return {};
  };
  await bridge.poll('target', evaluate);
  assert.equal(completed.length, 1); // poll 未被渲染 promise 阻塞。
  packet = { session: 'new', requests: [], diagnostics: [] };
  await bridge.poll('target', evaluate);
  completed[0].resolve({ svg: '<svg/>' }); await flush();
  await bridge.poll('target', evaluate);
  assert.equal(delivered.length, 0); // reload 前的结果不能进入新页面。
  packet.requests = [{ id: 'puml-2', revision: 1, source: 'A -> C' }];
  await bridge.poll('target', evaluate); packet.requests = [];
  completed[1].resolve({ svg: '<svg/>' }); await flush();
  await bridge.poll('target', evaluate);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].session, 'new');
  assert.equal(delivered[0].results[0].id, 'puml-2');
  assert.equal(logs.join('').includes('SECRET_TEXT'), false);
  bridge.retainTargets(new Set()); assert.equal(bridge.targets.size, 0);
});

test('关闭开关时仅销毁增强，不提交渲染任务', async () => {
  const calls = [];
  const bridge = new PlantUmlBridge({ enabled: false });
  await bridge.poll('x', async expr => calls.push(expr));
  assert.deepEqual(calls, ['window.__BETTER_CODEX_PLANTUML__?.destroy?.();']);
  await bridge.close();
});
