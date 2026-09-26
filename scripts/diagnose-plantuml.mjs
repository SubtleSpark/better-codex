import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PREFIX = '[BetterCodex:plantuml-diagnose]';

// 不打印 target URL、窗口标题或 initialRoute 中的业务数据。
export function classifyTarget(target) {
  let url;
  try { url = new URL(target.url); } catch { return { entry: 'invalid', inspect: false, injectorEligible: false }; }
  const local = url.protocol === 'app:' && url.hostname === '-';
  const entry = !local ? 'non-app' : url.pathname === '/index.html' ? 'index'
    : url.pathname === '/detached-window.html' ? 'detached-window' : 'other-app';
  return { entry, inspect: local && ['page', 'webview', 'iframe'].includes(target.type),
    injectorEligible: target.type === 'page' && entry === 'index' && url.searchParams.get('initialRoute') !== '/avatar-overlay' };
}

export function describeTarget(target) {
  let scheme = 'invalid';
  try {
    const protocol = new URL(target.url).protocol.slice(0, -1);
    scheme = ['app', 'codex-sandbox', 'http', 'https', 'file', 'blob', 'data', 'about'].includes(protocol) ? protocol : 'other';
  } catch {}
  return { type: ['page', 'webview', 'iframe', 'worker', 'service_worker'].includes(target.type) ? target.type : 'other', scheme };
}

export function validateSocket(address, port) {
  let url;
  try { url = new URL(address); } catch { throw new Error('INVALID_CDP_SOCKET'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      Number(url.port) !== port || url.username || url.password) throw new Error('NON_LOCAL_CDP_SOCKET');
  return url.href;
}

// 仅返回结构、固定枚举和布尔值；targetHints 只传给可信 App frame，用于精确关联 WebView。
export function collectPlantUmlDom(targetHints = []) {
  const names = new Set(['plantuml', 'puml', 'plantuml-svg', 'puml-svg']);
  const shell = '[data-markdown-copy="code-block"]';
  const own = '[data-better-codex-plantuml-ui]';
  const excluded = '.monaco-editor, .cm-editor, [contenteditable="true"], .diff, [data-diff], [data-testid*="diff"], [data-app-action-review-file]';
  function token(value) {
    if (typeof value !== 'string' || value.length > 80) return null;
    const raw = value.trim().toLowerCase();
    const normalized = raw.replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-').replace(/[\u200B-\u200D\uFEFF]/g, '');
    if (!names.has(normalized)) return null;
    return { language: normalized, exact: names.has(raw), codePoints: [...raw].map(c => c.codePointAt(0)) };
  }
  const nameOf = value => token(value)?.language || null;
  const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
  const opts = window.__BETTER_CODEX_PLANTUML_OPTIONS__ || {};
  let roots = [document.body];
  let invalidRoot = false;
  try { if (opts.rootSelector) roots = [...document.querySelectorAll(opts.rootSelector)]; }
  catch { roots = []; invalidRoot = true; }
  const inConfiguredRoot = el => roots.some(root => root === el || root?.contains(el));
  const limited = new Set(['data-markdown-copy', 'data-language', 'data-lang', 'data-code-language', 'data-code-lang', 'lang', 'language', 'data-testid', 'data-diff', 'contenteditable', 'role']);
  function markers(el) {
    const found = [];
    for (const attr of el.attributes) {
      if (!/^(?:data-|lang$|language$)/.test(attr.name)) continue;
      const value = token(attr.value);
      if (value) found.push({ attribute: limited.has(attr.name) ? attr.name : 'other-data-attribute', token: value });
    }
    for (const c of el.classList) {
      const value = token(/^(?:language|lang)-(.+)$/i.exec(c)?.[1]);
      if (value) found.push({ attribute: 'language-class', token: value });
    }
    return found.slice(0, 4);
  }
  function pseudo(el, position) {
    const content = getComputedStyle(el, position).content;
    const present = Boolean(content && !['none', 'normal', '""', "''"].includes(content));
    // CSS generated content 不在 textContent 中；只输出确认为语言名的值。
    let value = content;
    if (value?.length <= 256 && /^(["']).*\1$/s.test(value)) {
      value = value.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => {
        const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : '';
      });
    }
    return { present, token: token(value) };
  }
  function shape(el) {
    if (!(el instanceof Element)) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const hints = markers(el);
    return {
      tag: el.localName.includes('-') ? 'custom-element' : el.localName,
      attributes: el.getAttributeNames().filter(n => limited.has(n)),
      languageMarkers: [...new Set(hints.map(x => x.token.language))], languageEvidence: hints,
      before: pseudo(el, '::before'), after: pseudo(el, '::after'), semanticShell: el.matches(shell),
      toolbar: el.getAttribute('data-markdown-copy') === 'exclude',
      children: [...el.children].slice(0, 10).map(n => n.localName.includes('-') ? 'custom-element' : n.localName), childCount: el.childElementCount,
      containsCode: Boolean(el.querySelector('code')), containsPre: Boolean(el.querySelector('pre')),
      excluded: Boolean(el.closest(excluded)), own: Boolean(el.closest(own)), inConfiguredRoot: inConfiguredRoot(el),
      display: style.display, whiteSpace: style.whiteSpace,
      hasLayout: rect.width > 0 && rect.height > 0,
      inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    };
  }
  function location(el) {
    const ancestors = [];
    for (let n = el, depth = 0; n && depth < 6; n = n.parentElement || n.getRootNode()?.host, depth++) {
      ancestors.push({ node: shape(n), previous: shape(n.previousElementSibling), next: shape(n.nextElementSibling) });
    }
    return { insideCode: Boolean(el.closest('pre, code')), ancestors };
  }
  function safeScheme(value) {
    try {
      const s = new URL(value).protocol.slice(0, -1);
      return ['app', 'codex-sandbox', 'http', 'https', 'file', 'blob', 'data', 'about'].includes(s) ? s : 'other';
    } catch { return 'empty-or-relative'; }
  }
  const docs = [{ root: document, scope: 'document' }];
  const found = [], codeCandidates = [], embeds = [];
  const counts = { elements: 0, pre: 0, code: 0, semanticShell: 0, iframe: 0, webview: 0, openShadowRoots: 0 };
  const seen = new Set();
  const limit = 25000;
  let truncated = false;
  for (let i = 0; i < docs.length && i < 8; i++) {
    const { root, scope } = docs[i];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walk.nextNode())) {
      if (++counts.elements > limit) { truncated = true; break; }
      if (el.shadowRoot) {
        counts.openShadowRoots++;
        if (docs.length < 8) docs.push({ root: el.shadowRoot, scope: 'open-shadow-root' });
        else truncated = true;
      }
      if (el.matches(own) || el.closest(own)) continue;
      if (el.matches('pre')) counts.pre++;
      if (el.matches('code')) counts.code++;
      if (el.matches(shell)) counts.semanticShell++;
      if (el.matches('iframe')) counts.iframe++;
      if (el.matches('webview')) counts.webview++;
      if (el.matches('iframe, webview') && embeds.length < 16) {
        const addresses = [el.getAttribute('src'), el.src];
        // getURL 是 Electron 的只读查询；不调用 executeJavaScript / loadURL。
        try { if (el.matches('webview') && typeof el.getURL === 'function') addresses.push(el.getURL()); } catch {}
        const rect = el.getBoundingClientRect();
        embeds.push({ tag: el.localName, scope, scheme: safeScheme(addresses.find(Boolean)), srcdoc: el.hasAttribute('srcdoc'),
          hasLayout: rect.width > 0 && rect.height > 0,
          matchingTargets: targetHints.filter(h => typeof h.url === 'string' && !['', 'about:blank', 'about:srcdoc'].includes(h.url) &&
            addresses.includes(h.url) && targetHints.filter(other => other.url === h.url).length === 1).map(h => h.target).slice(0, 32) });
      }
      // 即使 labels=[]，也报告实际 pre/code 的结构，不再让识别失败变成诊断盲区。
      if (el.matches(`pre, code, ${shell}`)) {
        const block = el.closest(shell) || el.closest('pre') || el;
        if (!seen.has(block)) {
          seen.add(block);
          if (codeCandidates.length < 8) {
            const code = block.querySelector('code') || block;
            const text = code.textContent || '';
            codeCandidates.push({ scope, hasStartDirective: /^\s*@startuml\b/im.test(text),
              hasEndDirective: /^\s*@enduml\b/im.test(text), code: shape(code), ...location(block) });
          } else truncated = true;
        }
      }
      if (found.length >= 8) continue;
      const directText = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.length <= 80 ? n.textContent : '').join('').trim();
      const label = token(directText);
      const hints = markers(el);
      if (label || hints.length) found.push({ scope, language: label?.language || hints[0].token.language,
        evidence: label ? 'text-label' : 'language-attribute', token: label || hints[0].token, ...location(el) });
    }
    if (counts.elements > limit) break;
  }
  const panels = [...document.querySelectorAll('section.bc-puml')].slice(0, 8).map(el => {
    const img = el.querySelector('img');
    const buttons = [...el.querySelectorAll('button')];
    return { visible: Boolean(el.getBoundingClientRect().height), imagePresent: Boolean(img),
      imageHidden: img ? img.hidden : null, imageComplete: img ? img.complete : null,
      imageDecoded: Boolean(img?.naturalWidth), retryVisible: buttons.some(b => b.textContent === '重试' && !b.hidden) };
  });
  return {
    module: { installed: Boolean(window.__BETTER_CODEX_PLANTUML__), version: version(window.__BETTER_CODEX_PLANTUML__?.version),
      sidebarInstalled: Boolean(window.__BETTER_CODEX__), sidebarVersion: version(window.__BETTER_CODEX__?.version) },
    scanRoot: { configured: Boolean(opts.rootSelector), count: roots.length, invalid: invalidRoot },
    ready: document.readyState, focused: document.hasFocus(), visibility: document.visibilityState,
    counts, truncated, labels: found, codeCandidates, embeds, panels,
  };
}

async function connect(address) {
  const ws = new WebSocket(address);
  const pending = new Map();
  const contexts = new Map();
  let serial = 0;
  function failAll() {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP_CLOSED')); }
    pending.clear();
  }
  ws.addEventListener('close', failAll);
  ws.addEventListener('error', failAll);
  ws.addEventListener('message', event => {
    let m; try { m = JSON.parse(String(event.data)); } catch { return; }
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
    if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId);
    if (m.method === 'Runtime.executionContextsCleared') contexts.clear();
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error('CDP_COMMAND_ERROR')); else p.resolve(m.result);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_OPEN_TIMEOUT')), 3000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_OPEN_FAILED')); }, { once: true });
    });
  } catch (error) { ws.close(); throw error; }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('CDP_CLOSED')); return; }
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_COMMAND_TIMEOUT')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch { clearTimeout(timer); pending.delete(id); reject(new Error('CDP_SEND_FAILED')); }
  });
  return { call, contexts, close() { failAll(); ws.close(); } };
}

function allowedFrame(url, parentAllowed) {
  try { const u = new URL(url); if (u.protocol === 'app:' && u.hostname === '-') return true; } catch {}
  return parentAllowed && ['about:blank', 'about:srcdoc', ''].includes(url);
}

export function guestAllowed(target, number, linked, includeGuests) {
  return includeGuests && linked.has(number) && !classifyTarget(target).inspect &&
    ['page', 'webview', 'iframe'].includes(target.type);
}

// guest 只检查与可信 App embed 的 URL 精确关联的顶层文档；不递归读它的外部子页面。
export async function inspectTarget(target, port, emit, { targetHints = [], linkedGuest = false } = {}) {
  const cdp = await connect(validateSocket(target.webSocketDebuggerUrl, port));
  try {
    const frameTree = await cdp.call('Page.getFrameTree');
    const frames = new Map();
    function visit(node, parentAllowed = false, depth = 0) {
      if (!node || depth > 12 || frames.size >= 32) return;
      const inspect = linkedGuest
        ? depth === 0 && node.frame.url === target.url
        : allowedFrame(node.frame.url, parentAllowed);
      frames.set(node.frame.id, { inspect, frame: frames.size + 1, depth });
      for (const child of node.childFrames || []) visit(child, inspect, depth + 1);
    }
    visit(frameTree.frameTree);
    await cdp.call('Runtime.enable');
    const contexts = [...cdp.contexts.values()].filter(c => c.auxData?.isDefault);
    emit({ event: 'contexts', frameCount: frames.size, defaultContexts: contexts.length,
      skippedFrames: [...frames.values()].filter(f => !f.inspect).length });
    let inspected = 0;
    for (const context of contexts.slice(0, 16)) {
      const frame = frames.get(context.auxData?.frameId);
      if (!frame?.inspect) continue;
      // 绝不把其它 target 的 URL 列表交给非 App guest。
      const hints = linkedGuest ? [] : targetHints;
      const result = await cdp.call('Runtime.evaluate', { expression: `(${collectPlantUmlDom.toString()})(${JSON.stringify(hints)})`,
        contextId: context.id, returnByValue: true, silent: true, timeout: 2000 });
      if (result.exceptionDetails) { emit({ event: 'probe-failed', frame: frame.frame, code: 'DOM_PROBE_EXCEPTION' }); continue; }
      inspected++;
      emit({ event: 'dom', frame: frame.frame, frameDepth: frame.depth, report: result.result?.value ?? null });
    }
    if (!inspected) emit({ event: 'probe-failed', code: 'NO_ALLOWED_DEFAULT_CONTEXT' });
  } finally { cdp.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('用法：node scripts/diagnose-plantuml.mjs [--port 9347] [--include-guests]\n保持 BetterCodex 运行并打开出问题的 Markdown 预览。只读结构，不输出源码或路径。\n--include-guests 额外读取与 App iframe/WebView URL 精确匹配的 guest；不会安装渲染模块。');
    return;
  }
  let port = Number(process.env.BETTER_CODEX_PORT || 9347);
  let includeGuests = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--include-guests') { includeGuests = true; continue; }
    if (argv[i] !== '--port' || !argv[i + 1]) throw new Error('INVALID_ARGUMENT');
    port = Number(argv[++i]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  const emit = packet => console.log(`${PREFIX} ${JSON.stringify(packet)}`);
  const renderer = await fs.readFile(new URL('../src/plantuml/renderer.js', import.meta.url), 'utf8');
  emit({ event: 'start', reportVersion: 2, expectedModuleVersion: /const VERSION = '([\d.]+)'/.exec(renderer)?.[1] || null,
    port, readOnly: true, includeGuests });
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error('HTTP_ERROR');
    targets = await response.json();
  } catch { throw new Error('CDP_UNAVAILABLE'); }
  if (!Array.isArray(targets)) throw new Error('INVALID_TARGET_LIST');
  const bounded = targets.slice(0, 32);
  const targetHints = bounded.map((t, i) => ({ target: i + 1, url: t.url }));
  const linked = new Set();
  let inspected = 0, failures = 0, omitted = 0;
  async function inspect(target, number, linkedGuest) {
    if (inspected >= 8) { omitted++; return; }
    inspected++;
    try {
      await inspectTarget(target, port, packet => {
        if (!linkedGuest) for (const embed of packet.report?.embeds || []) {
          for (const n of embed.matchingTargets || []) if (Number.isInteger(n) && n >= 1 && n <= bounded.length) linked.add(n);
        }
        emit({ target: number, ...packet });
      }, { targetHints: linkedGuest ? [] : targetHints, linkedGuest });
    } catch (error) { failures++; emit({ event: 'target-failed', target: number,
      code: /^[A-Z_]+$/.test(error.message) ? error.message : 'DIAGNOSIS_FAILED' }); }
  }
  for (const [index, target] of bounded.entries()) {
    const info = classifyTarget(target);
    emit({ event: 'target', target: index + 1, ...info, ...describeTarget(target) });
    if (info.inspect) await inspect(target, index + 1, false);
  }
  for (const [index, target] of bounded.entries()) {
    if (!guestAllowed(target, index + 1, linked, includeGuests)) continue;
    emit({ event: 'linked-guest', target: index + 1, ...describeTarget(target), readOnly: true });
    await inspect(target, index + 1, true);
  }
  emit({ event: 'done', inspected, failures, linkedGuests: linked.size, truncated: targets.length > 32 || omitted > 0 });
  if (!inspected) emit({ event: 'hint', code: 'NO_APP_TARGET' });
  if (!inspected || failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'DIAGNOSIS_FAILED';
    console.error(`${PREFIX} ${JSON.stringify({ event: 'failed', code })}`);
    if (code === 'CDP_UNAVAILABLE') console.error('请先运行 ./better-codex，并确认此命令使用相同的 CDP port。');
    process.exitCode = 1;
  });
}
