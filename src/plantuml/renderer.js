(() => {
  'use strict';
  const KEY = '__BETTER_CODEX_PLANTUML__';
  const VERSION = '0.10.1';
  let options = window.__BETTER_CODEX_PLANTUML_OPTIONS__ || {};
  const previous = window[KEY];
  if (previous?.version === VERSION) { previous.configure?.(options); previous.scan(); return; }
  previous?.destroy?.();

  const LANGUAGES = new Set(['plantuml', 'puml', 'plantuml-svg', 'puml-svg']);
  const SHELL = '[data-markdown-copy="code-block"]';
  const OWN = 'data-better-codex-plantuml-ui';
  const HIDDEN = 'data-better-codex-plantuml-source-hidden';
  const session = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const states = new Map();
  const requests = [];
  const diagnostics = [];
  let nextId = 0;
  let timer;
  let destroyed = false;
  let dialog;
  let lastProbe = '';
  const style = document.createElement('style');
  style.setAttribute(OWN, '');
  style.textContent = `
    [${HIDDEN}="${session}"] { display: none !important; }
    .bc-puml { margin-block: 8px 16px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px; overflow: hidden; font-family: inherit; }
    .bc-puml-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; flex-wrap: wrap; }
    .bc-puml-status { flex: 1; opacity: .75; min-width: 100px; }
    .bc-puml button { appearance: none; font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 5px; padding: 3px 8px; cursor: pointer; }
    .bc-puml button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
    .bc-puml button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    .bc-puml img { display: block; max-width: 100%; max-height: 640px; width: auto; height: auto; margin-inline: auto; background: white; object-fit: contain; }
    .bc-puml [hidden] { display: none !important; }
    dialog.bc-puml { width: min(94vw, 1400px); max-width: 94vw; max-height: 90vh; color: CanvasText; background: Canvas; padding: 8px; }
    dialog.bc-puml::backdrop { background: rgb(0 0 0 / .45); }
    dialog.bc-puml .bc-puml-scroll { overflow: auto; max-height: 80vh; }
    dialog.bc-puml img { max-width: none; max-height: none; }
  `;
  document.head.appendChild(style);

  function diagnose(level, event, data = {}) {
    if (level === 'debug' && !options.debug) return;
    if (diagnostics.length >= 80) diagnostics.shift();
    diagnostics.push({ level, event, ...data });
  }
  function owned(node) {
    const el = node instanceof Element ? node : node?.parentElement;
    return Boolean(el?.closest(`[${OWN}]`));
  }
  function languageName(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return LANGUAGES.has(name) ? name : null;
  }
  function language(block, code) {
    // Obsidian 的 -svg fence 仍是 PlantUML 源码；复用同一个本地 SVG 引擎。
    for (const node of [code, code.closest('pre'), block, block.parentElement]) {
      if (!node) continue;
      for (const value of [node.getAttribute('data-language'), node.getAttribute('data-lang'),
        ...Array.from(node.classList).map(x => /^(?:language|lang)-(.+)$/i.exec(x)?.[1])]) {
        const name = languageName(value);
        if (name) return name;
      }
    }
    // 语言名可能是 toolbar 本身的文本，不一定包在子 span/div 中。
    const header = block.matches(SHELL)
      ? block.querySelector(':scope > [data-markdown-copy="exclude"]')
      : block.previousElementSibling;
    // 不从上一个代码块或 Copy 按钮里猜语言。
    if (!header || owned(header) || header.matches(`pre, code, button, ${SHELL}`) ||
        header.querySelector(`pre, code, ${SHELL}`)) return null;
    for (const node of [header, ...header.querySelectorAll('span, div')]) {
      if (node.closest('button') || node.querySelector('button')) continue;
      const name = languageName(node.textContent);
      if (name) return name;
    }
    return null;
  }
  function sourceNode(block, code) {
    // 保留原生 Copy / 换行 toolbar，只隐藏代码区，不移动 React 管理的节点。
    if (!block.matches(SHELL)) return block;
    return code.closest('pre') || (code.parentElement === block ? code : code.parentElement);
  }
  function excluded(pre) {
    return owned(pre) || Boolean(pre.closest('.monaco-editor, .cm-editor, [contenteditable="true"], .diff, [data-diff], [data-testid*="diff"], [data-app-action-review-file]'));
  }
  function readSource(code) {
    const clone = code.cloneNode(true);
    clone.querySelectorAll('[data-line-number], .line-number, [aria-hidden="true"]').forEach(x => x.remove());
    const lines = Array.from(clone.children);
    if (lines.length && lines.every(x => x.matches('span.line')) && !Array.from(clone.childNodes).some(n => n.nodeType === 3 && n.textContent.includes('\n'))) {
      return lines.map(x => x.textContent).join('\n');
    }
    return clone.textContent.replace(/\r\n?/g, '\n');
  }
  function sourceVisible(state, visible) {
    if (visible) {
      if (state.sourceNode.getAttribute(HIDDEN) === session) state.sourceNode.removeAttribute(HIDDEN);
    } else state.sourceNode.setAttribute(HIDDEN, session);
  }
  function revoke(state) {
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = null;
  }
  function remove(state) {
    sourceVisible(state, true); revoke(state); state.ui.remove(); states.delete(state.pre);
  }
  function current(state, revision) {
    return !destroyed && states.get(state.pre) === state && state.pre.isConnected &&
      state.revision === revision && readSource(state.code) === state.source;
  }
  function errorState(state, message, code = 'RENDER_ERROR') {
    state.pending = false; state.loaded = false;
    sourceVisible(state, true); revoke(state);
    state.img.hidden = true; state.sourceButton.hidden = true; state.expand.hidden = true;
    state.status.textContent = message;
    state.retry.hidden = false;
    // 不把图源码、路径或引擎原始错误内容放进日志。
    diagnose('warn', 'render-failed', { code });
  }
  function enqueue(state) {
    state.revision++;
    state.loaded = false; sourceVisible(state, true); revoke(state);
    state.img.hidden = true; state.retry.hidden = true; state.sourceButton.hidden = true; state.expand.hidden = true;
    if (new TextEncoder().encode(state.source).byteLength > 65536) {
      errorState(state, '源码超过 64 KiB，请拆分图。', 'SOURCE_TOO_LARGE'); return;
    }
    if (requests.length >= 32) { errorState(state, '渲染队列已满，请稍后重试。', 'QUEUE_FULL'); return; }
    state.pending = true; state.since = Date.now();
    state.status.textContent = 'PlantUML · 本地渲染中…';
    requests.push({ id: state.id, revision: state.revision, source: state.source });
  }
  function button(text, callback) {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
    node.addEventListener('click', callback); return node;
  }
  function expand(state) {
    if (!state.loaded || !state.url) return;
    dialog?.remove();
    dialog = document.createElement('dialog'); dialog.className = 'bc-puml'; dialog.setAttribute(OWN, '');
    const bar = document.createElement('div'); bar.className = 'bc-puml-bar';
    bar.append(button('关闭', () => dialog?.close()));
    const scroll = document.createElement('div'); scroll.className = 'bc-puml-scroll';
    const img = document.createElement('img'); img.alt = 'PlantUML 图（原尺寸）'; img.src = state.url;
    scroll.append(img); dialog.append(bar, scroll); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; }, { once: true });
    dialog.showModal();
  }
  function attach(pre, code, source) {
    const ui = document.createElement('section'); ui.className = 'bc-puml'; ui.setAttribute(OWN, '');
    ui.setAttribute('data-markdown-copy', 'exclude');
    const bar = document.createElement('div'); bar.className = 'bc-puml-bar';
    const status = document.createElement('span'); status.className = 'bc-puml-status'; status.setAttribute('role', 'status');
    const img = document.createElement('img'); img.alt = 'PlantUML 图'; img.hidden = true;
    const state = { id: `puml-${++nextId}`, pre, code, sourceNode: sourceNode(pre, code), source, ui, status, img, revision: 0 };
    state.sourceButton = button('源码', () => {
      const showingSource = state.sourceNode.getAttribute(HIDDEN) !== session;
      sourceVisible(state, !showingSource); img.hidden = !showingSource;
      state.sourceButton.textContent = showingSource ? '源码' : '预览';
    });
    state.expand = button('放大', () => expand(state));
    state.retry = button('重试', () => { state.source = readSource(state.code); enqueue(state); });
    bar.append(status, state.sourceButton, state.expand, state.retry); ui.append(bar, img);
    states.set(pre, state); pre.after(ui); enqueue(state);
    return state;
  }

  // SVG 从零构造允许的元素/属性，再以 <img> 显示；不向 Codex DOM 插入原始 SVG。
  function safeSvg(svg) {
    if (typeof svg !== 'string' || new TextEncoder().encode(svg).byteLength > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error('INVALID_SVG');
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('INVALID_SVG');
    const ns = 'http://www.w3.org/2000/svg';
    const tags = new Set('svg g defs path rect circle ellipse line polyline polygon text tspan title desc clipPath linearGradient radialGradient stop symbol use'.split(' '));
    const attrs = new Set('id x y x1 y1 x2 y2 dx dy width height viewBox preserveAspectRatio d points rx ry r cx cy transform fill stroke stroke-width stroke-dasharray stroke-linecap stroke-linejoin fill-opacity stroke-opacity opacity font-family font-size font-weight font-style text-anchor dominant-baseline textLength lengthAdjust clip-path offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod'.split(' '));
    const css = new Set('fill stroke stroke-width stroke-dasharray stroke-linecap stroke-linejoin fill-opacity stroke-opacity opacity font-family font-size font-weight font-style text-anchor dominant-baseline'.split(' '));
    let count = 0;
    function valueSafe(value) { return !/url\s*\(|expression\s*\(|@import|javascript:/i.test(value); }
    function copy(node, depth = 0) {
      if (++count > 20000 || depth > 80) throw new Error('SVG_TOO_COMPLEX');
      if (node.nodeType === 3) return document.createTextNode(node.textContent);
      if (node.nodeType !== 1 || node.namespaceURI !== ns) return null;
      // 链接只保留图形内容；不提供主动跳转。
      const tag = node.localName === 'a' ? 'g' : node.localName;
      if (!tags.has(tag)) return null;
      const out = document.createElementNS(ns, tag);
      for (const attr of node.attributes) {
        if (attrs.has(attr.name) && valueSafe(attr.value)) out.setAttribute(attr.name, attr.value);
        else if (['fill', 'stroke', 'clip-path'].includes(attr.name) && /^url\(#[\w.:-]+\)$/.test(attr.value)) out.setAttribute(attr.name, attr.value);
        else if (attr.localName === 'href' && /^#[\w.:-]+$/.test(attr.value)) out.setAttribute('href', attr.value);
      }
      for (const property of Array.from(node.style || [])) {
        const value = node.style.getPropertyValue(property);
        if (css.has(property) && valueSafe(value)) out.style.setProperty(property, value);
      }
      for (const child of node.childNodes) { const clean = copy(child, depth + 1); if (clean) out.append(clean); }
      return out;
    }
    return new XMLSerializer().serializeToString(copy(parsed.documentElement));
  }

  function applyResults(payload) {
    if (payload?.session !== session || !Array.isArray(payload.results)) return;
    for (const result of payload.results.slice(0, 4)) {
      const state = Array.from(states.values()).find(x => x.id === result.id);
      if (!state || !current(state, result.revision)) continue;
      if (!result.ok) {
        const line = Number.isInteger(result.line) && result.line > 0 ? `（引擎第 ${result.line} 行）` : '';
        errorState(state, (result.message || '渲染失败，原始源码已保留。') + line, result.code); continue;
      }
      try {
        const svg = safeSvg(result.svg);
        revoke(state);
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); state.url = url;
        state.img.onload = () => {
          if (!current(state, result.revision) || state.url !== url) return;
          state.pending = false; state.loaded = true; state.img.hidden = false;
          state.status.textContent = 'PlantUML · 本地';
          state.sourceButton.textContent = '源码'; state.sourceButton.hidden = false; state.expand.hidden = false;
          sourceVisible(state, false);
          diagnose('debug', 'image-loaded');
        };
        state.img.onerror = () => {
          if (current(state, result.revision) && state.url === url) errorState(state, '图片加载失败（可能被 CSP 限制），源码已保留。', 'IMAGE_LOAD_FAILED');
        };
        state.img.src = url;
      } catch { errorState(state, 'SVG 格式不安全或不受支持，源码已保留。', 'INVALID_SVG'); }
    }
  }

  function scan() {
    if (destroyed) return;
    let roots;
    try { roots = options.rootSelector ? document.querySelectorAll(options.rootSelector) : [document.body]; }
    catch { diagnose('warn', 'invalid-root-selector'); return; }
    const eligible = new Map();
    let preCount = 0;
    let excludedBlocks = 0;
    const languageCounts = Object.fromEntries([...LANGUAGES].map(name => [name, 0]));
    for (const root of roots) for (const pre of root.querySelectorAll(`pre, ${SHELL}`)) {
      // pre 嵌套在语义化 code-block 中时，外壳只处理一次。
      const shell = pre.closest(SHELL);
      if (shell && shell !== pre) continue;
      preCount++;
      const code = pre.querySelector('code') || (pre.matches('pre') ? pre : null);
      if (!code) continue;
      if (excluded(pre)) { excludedBlocks++; continue; }
      const name = language(pre, code);
      if (name && !eligible.has(pre)) { eligible.set(pre, code); languageCounts[name]++; }
    }
    for (const state of states.values()) {
      if (eligible.get(state.pre) !== state.code || sourceNode(state.pre, state.code) !== state.sourceNode) remove(state);
    }
    for (const [pre, code] of eligible) {
      const source = readSource(code);
      const state = states.get(pre);
      if (!state) { if (states.size < 64) attach(pre, code, source); }
      else {
        if (!state.ui.isConnected) pre.after(state.ui);
        if (state.source !== source) { state.source = source; enqueue(state); }
        else if (state.pending && Date.now() - state.since > 45000) errorState(state, '等待本地渲染超时，请确认 BetterCodex 正在运行后重试。', 'BRIDGE_TIMEOUT');
      }
    }
    // 日志只包含结构计数和固定语言白名单；不包含文件路径或代码文本。
    const summary = { rootCount: roots.length, preCount, plantumlBlocks: eligible.size, excludedBlocks, languageCounts };
    const probe = JSON.stringify(summary);
    if (probe !== lastProbe) { lastProbe = probe; diagnose('debug', 'block-scan', summary); }
  }
  function schedule(records) {
    if (records.every(r => owned(r.target) || (r.type === 'childList' &&
      [...r.addedNodes, ...r.removedNodes].length && [...r.addedNodes, ...r.removedNodes].every(owned)))) return;
    clearTimeout(timer); timer = setTimeout(scan, 120);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const watchdog = setInterval(scan, 2000);
  function destroy() {
    destroyed = true; clearTimeout(timer); clearInterval(watchdog); observer.disconnect();
    for (const state of states.values()) remove(state);
    requests.length = 0; diagnostics.length = 0; style.remove(); dialog?.remove();
    if (window[KEY]?.session === session) delete window[KEY];
  }
  window[KEY] = {
    version: VERSION, session, scan, destroy, applyResults,
    configure(next) {
      if (Boolean(next?.debug) !== Boolean(options.debug)) lastProbe = '';
      options = next || {};
    },
    drain() {
      // 在交给 Node 前丢弃已被重新渲染/移除的 block 请求。
      const valid = requests.splice(0).filter(r => Array.from(states.values()).some(s => s.id === r.id && s.revision === r.revision && s.pending));
      requests.push(...valid.slice(2));
      return { session, requests: valid.slice(0, 2), diagnostics: diagnostics.splice(0) };
    },
  };
  scan();
})();
