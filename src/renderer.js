(() => {
  'use strict';

  const VERSION = '0.1.0';
  const GLOBAL_KEY = '__BETTER_CODEX__';
  const STORAGE_KEY = 'better-codex:v1:colors';
  const STYLE_ID = 'better-codex-style';
  const MENU_ID = 'better-codex-menu';
  const MARKER_ATTR = 'data-better-codex-key';

  const existing = window[GLOBAL_KEY];
  if (existing?.version === VERSION) {
    existing.scan?.();
    return { status: 'installed', version: VERSION, reused: true };
  }
  existing?.destroy?.();

  const blockedLabels = new Set([
    'new chat', 'new conversation', 'new thread', '新会话', '新对话',
    'code', '代码', 'plugins', '插件', 'automations', 'scheduled', '定时任务', '已安排',
    'sites', '站点', 'pull requests', 'settings', '设置', 'workspaces', '工作区',
  ]);

  const state = {
    version: VERSION,
    observer: null,
    scanTimer: null,
    menu: null,
    listeners: [],
    colors: loadColors(),
  };

  function loadColors() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveColors() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.colors));
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  function getLabel(element) {
    return normalizeText(
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.innerText ||
      element.textContent ||
      ''
    );
  }

  function stableKey(element, label) {
    const uniqueAttrs = [
      'data-thread-id',
      'data-conversation-id',
      'data-project-id',
      'data-workspace-id',
      'data-item-id',
    ];
    for (const name of uniqueAttrs) {
      const value = element.getAttribute(name) || element.closest(`[${name}]`)?.getAttribute(name);
      if (value) return `attr:${name}:${value}`;
    }

    const link = element.closest('a[href]');
    const href = link?.getAttribute('href');
    if (href && href !== '#' && !href.startsWith('javascript:')) {
      try {
        const url = new URL(href, location.href);
        return `href:${url.origin}${url.pathname}`;
      } catch {
        return `href:${href.split(/[?#]/, 1)[0]}`;
      }
    }

    const testId = element.getAttribute('data-testid') || element.closest('[data-testid]')?.getAttribute('data-testid');
    if (testId && /thread|conversation|project|workspace|item/i.test(testId)) {
      return `testid:${testId}:${label.toLowerCase()}`;
    }

    // MVP fallback. This is intentionally last because renaming the item changes the key.
    return label ? `title:${label.toLowerCase()}` : null;
  }

  function isBlocked(label) {
    const lower = label.toLowerCase();
    if (blockedLabels.has(lower)) return true;
    return lower.startsWith('pull request') || lower.startsWith('search ');
  }

  function candidateFromElement(element) {
    if (!(element instanceof Element)) return null;

    const clickTarget = element.closest('a[href], button, [role="button"], [role="link"]');
    if (!clickTarget) return null;

    const rect = clickTarget.getBoundingClientRect();
    const sidebarLimit = Math.min(500, Math.max(300, window.innerWidth * 0.34));
    if (rect.left < -2 || rect.right <= 0 || rect.left > sidebarLimit) return null;
    if (rect.top < 0 || rect.bottom > window.innerHeight + 2) return null;
    if (rect.width < 100 || rect.height < 22 || rect.height > 84) return null;

    const style = getComputedStyle(clickTarget);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return null;

    const label = getLabel(clickTarget);
    if (!label || label.length > 180 || isBlocked(label)) return null;

    const key = stableKey(clickTarget, label);
    if (!key) return null;

    return { element: clickTarget, key, label };
  }

  function allCandidates() {
    const seen = new Set();
    const result = [];
    const nodes = document.querySelectorAll('a[href], button, [role="button"], [role="link"]');
    for (const node of nodes) {
      const candidate = candidateFromElement(node);
      if (!candidate || seen.has(candidate.element)) continue;
      seen.add(candidate.element);
      result.push(candidate);
    }
    return result;
  }

  function applyCandidate(candidate) {
    const color = state.colors[candidate.key];
    candidate.element.setAttribute(MARKER_ATTR, candidate.key);
    if (color) {
      candidate.element.style.setProperty('--better-codex-color', color);
      candidate.element.classList.add('better-codex-colored');
      candidate.element.title = candidate.element.title || candidate.label;
    } else {
      candidate.element.style.removeProperty('--better-codex-color');
      candidate.element.classList.remove('better-codex-colored');
    }
  }

  function scan() {
    for (const candidate of allCandidates()) applyCandidate(candidate);
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = null;
      scan();
    }, 80);
  }

  function installStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .better-codex-colored {
        box-shadow: inset 3px 0 0 var(--better-codex-color) !important;
        background: color-mix(in srgb, var(--better-codex-color) 11%, transparent) !important;
        border-radius: 7px !important;
      }
      #${MENU_ID} {
        position: fixed;
        z-index: 2147483647;
        width: 224px;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        background: color-mix(in srgb, Canvas 96%, transparent);
        color: CanvasText;
        box-shadow: 0 14px 40px rgba(0, 0, 0, .22);
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(16px);
      }
      #${MENU_ID} * { box-sizing: border-box; }
      #${MENU_ID} .bc-title {
        font-weight: 650;
        margin-bottom: 2px;
      }
      #${MENU_ID} .bc-label {
        opacity: .64;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 10px;
      }
      #${MENU_ID} .bc-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${MENU_ID} input[type="color"] {
        width: 44px;
        height: 32px;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      #${MENU_ID} button {
        appearance: none;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        background: color-mix(in srgb, currentColor 7%, transparent);
        color: inherit;
        border-radius: 8px;
        height: 32px;
        padding: 0 10px;
        cursor: pointer;
      }
      #${MENU_ID} button:hover {
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      #${MENU_ID} .bc-clear { margin-left: auto; }
      #${MENU_ID} .bc-note {
        margin-top: 9px;
        opacity: .48;
        font-size: 11px;
      }
    `;
    document.head.appendChild(style);
  }

  function closeMenu() {
    state.menu?.remove();
    state.menu = null;
  }

  function setColor(candidate, color) {
    state.colors[candidate.key] = color;
    saveColors();
    applyCandidate(candidate);
    scheduleScan();
  }

  function clearColor(candidate) {
    delete state.colors[candidate.key];
    saveColors();
    applyCandidate(candidate);
    scheduleScan();
  }

  function showMenu(event, candidate) {
    closeMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    const current = state.colors[candidate.key] || '#7c3aed';

    const title = document.createElement('div');
    title.className = 'bc-title';
    title.textContent = 'BetterCodex color';

    const label = document.createElement('div');
    label.className = 'bc-label';
    label.textContent = candidate.label;
    label.title = candidate.label;

    const row = document.createElement('div');
    row.className = 'bc-row';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#7c3aed';
    picker.setAttribute('aria-label', 'Choose highlight color');

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'Apply';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'bc-clear';
    clear.textContent = 'Clear';

    const note = document.createElement('div');
    note.className = 'bc-note';
    note.textContent = candidate.key.startsWith('title:')
      ? 'MVP fallback: rename may lose this color.'
      : 'Stored locally in this app profile.';

    picker.addEventListener('input', () => setColor(candidate, picker.value));
    apply.addEventListener('click', () => {
      setColor(candidate, picker.value);
      closeMenu();
    });
    clear.addEventListener('click', () => {
      clearColor(candidate);
      closeMenu();
    });

    row.append(picker, apply, clear);
    menu.append(title, label, row, note);
    document.body.appendChild(menu);
    state.menu = menu;

    const width = 224;
    const height = menu.getBoundingClientRect().height || 120;
    const left = Math.min(event.clientX, window.innerWidth - width - 10);
    const top = Math.min(event.clientY, window.innerHeight - height - 10);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  function onContextMenu(event) {
    const candidate = candidateFromElement(event.target);
    if (!candidate) return;
    event.preventDefault();
    event.stopPropagation();
    showMenu(event, candidate);
  }

  function onPointerDown(event) {
    if (!state.menu) return;
    if (state.menu.contains(event.target)) return;
    closeMenu();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') closeMenu();
  }

  function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    state.listeners.push(() => target.removeEventListener(type, listener, options));
  }

  function destroy() {
    closeMenu();
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.observer?.disconnect();
    for (const remove of state.listeners.splice(0)) remove();
    document.getElementById(STYLE_ID)?.remove();
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((element) => {
      element.removeAttribute(MARKER_ATTR);
      element.classList.remove('better-codex-colored');
      element.style.removeProperty('--better-codex-color');
    });
    if (window[GLOBAL_KEY] === api) delete window[GLOBAL_KEY];
  }

  installStyle();
  addListener(document, 'contextmenu', onContextMenu, true);
  addListener(document, 'pointerdown', onPointerDown, true);
  addListener(document, 'keydown', onKeyDown, true);
  addListener(window, 'resize', scheduleScan, { passive: true });

  state.observer = new MutationObserver(scheduleScan);
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  const api = { version: VERSION, scan, destroy };
  window[GLOBAL_KEY] = api;
  return { status: 'installed', version: VERSION, reused: false };
})();
