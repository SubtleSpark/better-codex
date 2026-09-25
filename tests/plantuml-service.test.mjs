import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSource } from '../src/plantuml/policy.mjs';
import { PlantUmlService } from '../src/plantuml/service.mjs';
const workerURL = new URL('./helpers/plantuml-worker.mjs', import.meta.url);

test('输入限制：外部资源、宏、环境读取、多个图、超大源码', () => {
  assert.equal(prepareSource('A -> B'), '@startuml\nA -> B\n@enduml');
  assert.equal(prepareSource('\uFEFF@startuml\r\nA -> B\r\n@enduml'), '@startuml\nA -> B\n@enduml');
  for (const source of ['', null, 'x'.repeat(65537), '!include https://example.com/a.puml',
    '  !include /private/a.puml', '!theme foo', '%getenv("HOME")', '<img:https://example.com/a.png>',
    '@startuml\nA->B\n@enduml\n@startuml\nA->C\n@enduml']) {
    assert.throws(() => prepareSource(source));
  }
});

test('调度：同源去重、缓存、队列上限', async t => {
  const service = new PlantUmlService({ workerURL, maxQueue: 2 });
  t.after(() => service.close());
  const a = service.render('A -> B');
  assert.equal(a, service.render('A -> B'));
  const b = service.render('B -> C');
  await assert.rejects(service.render('C -> D'), { code: 'QUEUE_FULL' });
  const first = await a; await b;
  assert.equal(await service.render('A -> B'), first);
  assert.equal(service.cache.size, 2);
});

test('worker 超时/崩溃后可继续处理下一张图', async t => {
  const service = new PlantUmlService({ workerURL, timeoutMs: 800 });
  t.after(() => service.close());
  await assert.rejects(service.render('A -> B: TEST_TIMEOUT'), { code: 'TIMEOUT' });
  assert.match((await service.render('A -> B: works')).svg, /<svg/);
  await assert.rejects(service.render('A -> B: TEST_CRASH'), { code: 'WORKER_EXIT' });
  assert.match((await service.render('A -> B: works again')).svg, /<svg/);
});

test('关闭服务取消队列，清理 worker；拒绝新任务', async () => {
  const service = new PlantUmlService({ workerURL });
  const jobs = [service.render('A -> B: TEST_TIMEOUT'), service.render('B -> C')].map(p => p.catch(e => e.code));
  await service.close();
  assert.deepEqual(await Promise.all(jobs), ['CLOSED', 'CLOSED']);
  assert.equal(service.worker, null);
  await assert.rejects(service.render('A -> B'), { code: 'CLOSED' });
});
