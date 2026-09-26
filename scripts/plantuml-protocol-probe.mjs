// 只读协议探针：与页面 JS 的 element.shadowRoot 扫描互补。
// 不读取 iframe 的 contentDocument；Shadow Root 单独展开，包含 closed root。
const NAMES = new Set(['plantuml', 'puml', 'plantuml-svg', 'puml-svg']);
const normalize = value => typeof value === 'string' && value.length < 100
  ? value.trim().toLowerCase().replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-').replace(/[\u200B-\u200D\uFEFF]/g, '') : '';
const language = value => NAMES.has(normalize(value)) ? normalize(value) : null;
const tagName = name => /^[a-z]+$/.test(name || '') ? name : 'custom-element';

export async function readProtocolDom(call, { maxNodes = 25000, maxRoots = 64 } = {}) {
  const { root } = await call('DOM.getDocument', { depth: -1, pierce: false });
  if (!root) throw new Error('PROTOCOL_DOM_UNAVAILABLE');
  const counts = { nodes: 0, pre: 0, code: 0, openRoots: 0, closedRoots: 0, userAgentRoots: 0, skippedDocuments: 0 };
  const hits = [], shadows = [], seen = new Set();
  let truncated = false;
  const deadline = Date.now() + 10000;
  function scan(start, scope, ancestors = []) {
    const stack = [{ node: start, ancestors }];
    while (stack.length) {
      const { node, ancestors: chain } = stack.pop();
      if (++counts.nodes > maxNodes) { truncated = true; return; }
      const name = (node.localName || node.nodeName || '').toLowerCase();
      if (['script', 'style', 'template'].includes(name)) continue;
      const element = node.nodeType === 1;
      const path = element ? [...chain, tagName(name)].slice(-6) : chain;
      if (name === 'pre') counts.pre++;
      if (name === 'code') counts.code++;
      // 即使代码区是 div、标签被拆分或只是源码，也输出指令存在的布尔证据。
      const direct = element ? (node.children || []).filter(x => x.nodeType === 3).map(x => x.nodeValue || '').join('') : '';
      const text = node.nodeType === 3 ? node.nodeValue || '' : direct;
      const alias = language(text);
      const startDirective = /^\s*@startuml\b/im.test(text);
      const endDirective = /^\s*@enduml\b/im.test(text);
      const markers = [];
      if (element) for (let i = 0; i < (node.attributes || []).length; i += 2) {
        const key = node.attributes[i], value = node.attributes[i + 1];
        if (key === 'class') {
          for (const c of value.split(/\s+/)) {
            const found = language(/^(?:language|lang)-(.+)$/i.exec(c)?.[1]);
            if (found) markers.push(found);
          }
        } else if (/^(?:data-|lang$|language$)/.test(key)) {
          const found = language(value); if (found) markers.push(found);
        }
      }
      if (alias || startDirective || endDirective || markers.length) {
        if (hits.length < 24) hits.push({ scope, path, language: alias || markers[0] || null, startDirective, endDirective });
        else truncated = true;
      }
      for (const shadow of node.shadowRoots || []) {
        if (seen.has(shadow.backendNodeId)) continue;
        seen.add(shadow.backendNodeId);
        const mode = shadow.shadowRootType;
        if (mode === 'open') counts.openRoots++;
        else if (mode === 'closed') counts.closedRoots++;
        else counts.userAgentRoots++;
        // UA 控件（input/video/webview 内部）不是 Markdown 内容，不展开。
        if (mode !== 'open' && mode !== 'closed') continue;
        if (shadows.length < maxRoots) shadows.push({ id: shadow.backendNodeId, scope: `${mode}-shadow-root`, path });
        else truncated = true;
      }
      if (node.contentDocument) counts.skippedDocuments++;
      // 不遍历 templateContent / contentDocument / distributedNodes，避免读外部 frame 或未显示模板。
      if (['script', 'style', 'template'].includes(name)) continue;
      for (const child of [...(node.children || [])].reverse()) stack.push({ node: child, ancestors: path });
    }
  }
  scan(root, 'document');
  for (let i = 0; i < shadows.length && counts.nodes <= maxNodes; i++) {
    if (Date.now() > deadline) { truncated = true; break; }
    const shadow = shadows[i];
    const { node } = await call('DOM.describeNode', { backendNodeId: shadow.id, depth: -1, pierce: false });
    if (!node) throw new Error('SHADOW_ROOT_UNAVAILABLE');
    scan(node, shadow.scope, shadow.path);
  }
  return { counts, hits, truncated, externalDocumentsInspected: false };
}

export function summarizeLocation(reports, failures = 0) {
  const truncated = reports.some(r => r.dom?.truncated || r.protocol?.truncated);
  return { documentsRead: reports.length, failures, truncated, incomplete: failures > 0 || truncated,
    plantumlEvidenceFound: reports.some(r => r.dom?.labels?.length || r.protocol?.hits?.length) };
}
