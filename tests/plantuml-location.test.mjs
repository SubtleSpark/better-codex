import assert from 'node:assert/strict';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';
import { readProtocolDom, summarizeLocation } from '../scripts/plantuml-protocol-probe.mjs';

test('protocol：closed/open Shadow DOM、无 pre 的文本定位；不输出正文、URL 或属性值', { timeout: 20000 }, async t => {
  const b = await browser(); t.after(() => b.close());
  await b.evaluate(`
    document.body.innerHTML='<div id="SECRET_TITLE"></div><div id="open"></div><iframe srcdoc="SECRET_CHILD"></iframe>';
    window.root = document.querySelector('#SECRET_TITLE').attachShadow({mode:'closed'});
    root.innerHTML='<pre><code class="language-plantuml-svg">@startuml\\nAlice -> Bob: SECRET_SOURCE\\n@enduml</code></pre>';
    document.querySelector('#open').attachShadow({mode:'open'}).innerHTML='<div>puml</div><div>@startuml\\nPRIVATE_CODE\\n@enduml</div>';
    window.before = document.body.innerHTML; window.shadowBefore = root.innerHTML;
  `);
  assert.equal(await b.evaluate(`document.querySelector('#SECRET_TITLE').shadowRoot`), null);
  const result = await readProtocolDom(b.command);
  assert.ok(result.counts.closedRoots >= 1);
  assert.ok(result.counts.openRoots >= 1);
  assert.ok(result.hits.some(h => h.scope === 'closed-shadow-root' && h.language === 'plantuml-svg'));
  assert.ok(result.hits.some(h => h.scope === 'closed-shadow-root' && h.startDirective));
  assert.ok(result.hits.some(h => h.scope === 'open-shadow-root' && h.path.at(-1) === 'div' && h.startDirective));
  for (const secret of ['SECRET', 'PRIVATE_CODE', 'Alice', 'Bob']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await b.evaluate('document.body.innerHTML === before && root.innerHTML === shadowBefore'), true);
});

test('protocol：不遍历 child document；节点和 root 截断必须上报', async () => {
  const root = { nodeType: 9, children: [{ nodeType: 1, nodeName: 'IFRAME', contentDocument:
    { nodeType: 9, children: [{ nodeType: 3, nodeValue: 'plantuml-svg' }] } },
    { nodeType: 1, nodeName: 'DIV', shadowRoots: [{ backendNodeId: 7, shadowRootType: 'closed' }] }] };
  const calls = [];
  const call = async (method, params) => { calls.push({ method, params }); return { root }; };
  const result = await readProtocolDom(call, { maxRoots: 0 });
  assert.equal(result.hits.length, 0);
  assert.equal(result.counts.skippedDocuments, 1);
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'DOM.getDocument', params: { depth: -1, pierce: false } });
  assert.equal((await readProtocolDom(call, { maxNodes: 1 })).truncated, true);
});

test('protocol：超过旧诊断器的 8 个 root 仍可找到第 11 个 root', { timeout: 20000 }, async t => {
  const b = await browser(); t.after(() => b.close());
  await b.evaluate(`for(let i=0;i<11;i++){const h=document.createElement('div');document.body.append(h);h.attachShadow({mode:'open'}).textContent=i===10?'plantuml-svg':'NO_MATCH';}`);
  const result = await readProtocolDom(b.command);
  assert.equal(result.counts.openRoots, 11);
  assert.ok(result.hits.some(h => h.language === 'plantuml-svg'));
  assert.equal(result.truncated, false);
});

test('summary：子报告 truncated=true 不得汇总为 incomplete=false', () => {
  assert.equal(summarizeLocation([{ dom: { truncated: true }, protocol: { truncated: false } }]).incomplete, true);
  assert.equal(summarizeLocation([{ protocol: { truncated: true } }]).truncated, true);
  assert.equal(summarizeLocation([], 1).incomplete, true);
  assert.equal(summarizeLocation([{ protocol: { hits: [{ language: 'puml' }] } }]).plantumlEvidenceFound, true);
});
