import assert from 'node:assert/strict';
import test from 'node:test';
import { PlantUmlService } from '../src/plantuml/service.mjs';

test('真实 TeaVM + Viz.js：时序、中文、类图、组件图、活动图、状态图', { timeout: 90000 }, async t => {
  const service = new PlantUmlService(); t.after(() => service.close());
  const diagrams = [
    'Alice -> Bob: Hello\nBob --> Alice: OK',
    'participant "用户" as User\nparticipant "服务" as Server\nUser -> Server: 提交请求',
    'class User\nclass Order\nUser "1" --> "*" Order',
    'component Web\ncomponent Service\ndatabase DB\nWeb --> Service\nService --> DB',
    'start\n:提交申请;\nif (校验通过?) then (是)\n:保存;\nelse (否)\n:返回错误;\nendif\nstop',
    '[*] --> Idle\nIdle --> Active: run\nActive --> [*]',
  ];
  for (const diagram of diagrams) {
    const result = await service.render(diagram);
    assert.match(result.svg, /<svg\b/);
    assert.match(result.svg, /<text\b/);
    assert.ok(result.svg.length > 100);
    console.log(`actual engine ${result.engineVersion}; SVG ${Buffer.byteLength(result.svg)} bytes`);
  }
  await assert.rejects(service.render('@startuml\nthis is ??? definitely not valid???\n@enduml'), { code: 'SYNTAX_ERROR' });
  assert.match((await service.render('A -> B: after error')).svg, /<svg/);
});
