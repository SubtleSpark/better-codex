(() => {
  'use strict';

  const VERSION = '0.8.2';
  const GLOBAL_KEY = '__BETTER_CODEX__';
  const STORAGE_KEY = 'better-codex:v1:colors';
  const STYLE_ID = 'better-codex-highlight-style';
  const MARKER_ATTR = 'data-better-codex-key';
  const COLOR_CLASS = 'better-codex-colored';
  const DEFAULT_COLOR = '#7C3AED';

  const THREAD_ROW = '[data-app-action-sidebar-thread-row]';
  const PROJECT_ROW = '[data-app-action-sidebar-project-row]';
  const ROW_SELECTOR = `${THREAD_ROW}, ${PROJECT_ROW}`;

  const MENU_IDS = {
    thread: new Set([
      'rename-thread',
      'pin-thread',
      'unpin-thread',
      'mark-thread-unread',
      'archive-thread',
      'delete-thread',
      'move-thread-to-project',
      'share-thread',
      'copy-actions',
      'fork',
      'open-workspace-in',
      'open-in-new-window',
    ]),
    project: new Set([
      'pin-project',
      'unpin-project',
      'edit-project',
      'move-to-custom-section',
      'reveal-project-folder',
      'create-permanent-worktree',
      'archive-project-threads',
      'remove-project',
    ]),
  };

  const PRESETS = [
    ['紫色', '#7C3AED'],
    ['蓝色', '#3B82F6'],
    ['绿色', '#34D399'],
    ['黄色', '#FBBF24'],
    ['橙色', '#FB923C'],
    ['红色', '#F05252'],
    ['粉色', '#EC4899'],
  ];

  const previous = window[GLOBAL_KEY];
  if (previous?.version === VERSION) {
    previous.scan?.();
    return;
  }
  previous?.destroy?.();

  const listeners = [];
  const diagnostics = [];
  const store = createColorStore();

  let observer = null;
  let scanTimer = null;
  let bypassContextMenu = false;
  let pendingCustomColorCandidate = null;
  let api = null;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${COLOR_CLASS} {
      background-image: linear-gradient(
        color-mix(in srgb, var(--better-codex-color) 18%, transparent),
        color-mix(in srgb, var(--better-codex-color) 18%, transparent)
      ) !important;
      box-shadow: inset 3px 0 0 var(--better-codex-color) !important;
    }
  `;
  document.head.appendChild(style);

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.tabIndex = -1;
  colorInput.setAttribute('aria-hidden', 'true');
  colorInput.style.cssText =
    'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
  document.body.appendChild(colorInput);

  function debugEnabled() {
    return window.__BETTER_CODEX_DEBUG__ === true;
  }

  function diagnose(level, event, data = {}) {
    if (level === 'debug' && !debugEnabled()) return;

    diagnostics.push({
      at: new Date().toISOString(),
      level,
      event,
      ...data,
    });

    if (diagnostics.length > 100) {
      diagnostics.splice(0, diagnostics.length - 100);
    }
  }

  function drainDiagnostics() {
    return diagnostics.splice(0, diagnostics.length);
  }

  function createColorStore() {
    let colors = load();

    function load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    }

    return {
      get(key) {
        return colors[key] || null;
      },
      set(key, color) {
        colors[key] = color;
        persist();
      },
      remove(key) {
        delete colors[key];
        persist();
      },
    };
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  function candidateFromElement(element) {
    if (!(element instanceof Element)) return null;

    const row = element.closest(THREAD_ROW) || element.closest(PROJECT_ROW);
    if (!row) return null;

    const kind = row.matches(PROJECT_ROW) ? 'project' : 'thread';
    const label = normalizeText(
      row.getAttribute(
        kind === 'project'
          ? 'data-app-action-sidebar-project-label'
          : 'data-app-action-sidebar-thread-title',
      ) ||
        row.getAttribute('aria-label') ||
        row.textContent,
    );

    if (!label) return null;

    const idAttr =
      kind === 'project'
        ? 'data-app-action-sidebar-project-id'
        : 'data-app-action-sidebar-thread-id';
    const id = row.getAttribute(idAttr);

    return {
      element: row,
      kind,
      label,
      key: id
        ? `attr:${idAttr}:${id}`
        : `title:${kind}:${label.toLowerCase()}`,
    };
  }

  function applyCandidate(candidate) {
    const color = store.get(candidate.key);
    candidate.element.setAttribute(MARKER_ATTR, candidate.key);

    if (color) {
      candidate.element.style.setProperty('--better-codex-color', color);
      candidate.element.classList.add(COLOR_CLASS);
      return;
    }

    candidate.element.style.removeProperty('--better-codex-color');
    candidate.element.classList.remove(COLOR_CLASS);
  }

  function scan() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const candidate = candidateFromElement(row);
      if (candidate) applyCandidate(candidate);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scan();
    }, 80);
  }

  function findFiber(element) {
    const key = Object.getOwnPropertyNames(element).find(
      (name) =>
        name.startsWith('__reactFiber$') ||
        name.startsWith('__reactInternalInstance$'),
    );
    return key ? element[key] : null;
  }

  function fiberTypeName(fiber) {
    const type = fiber?.elementType ?? fiber?.type;
    return typeof type === 'string'
      ? type
      : type?.displayName || type?.name || null;
  }

  function matchesSidebarMenu(items, kind) {
    if (!Array.isArray(items) || items.length < 2) return false;

    const known = MENU_IDS[kind];
    let knownIds = 0;
    let callbacks = 0;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (known.has(item.id)) knownIds += 1;
      if (typeof item.onSelect === 'function') callbacks += 1;
    }

    return knownIds >= 2 && callbacks >= 1;
  }

  async function readMenuItems(props) {
    if (typeof props?.getItems === 'function') {
      return Promise.resolve(props.getItems());
    }
    if (Array.isArray(props?.items)) {
      return props.items;
    }
    return null;
  }

  function findIntl(startFiber) {
    const visited = new Set();

    for (
      let fiber = startFiber, depth = 0;
      fiber && depth < 64;
      fiber = fiber.return, depth += 1
    ) {
      let dependency = fiber.dependencies?.firstContext;

      while (dependency && !visited.has(dependency)) {
        visited.add(dependency);
        const value = dependency.memoizedValue;
        if (value && typeof value.formatMessage === 'function') return value;
        dependency = dependency.next;
      }
    }

    return null;
  }

  async function findMenuProvider(candidate) {
    const intl = findIntl(findFiber(candidate.element));
    const debugCandidates = [];

    for (
      let fiber = findFiber(candidate.element), depth = 0;
      fiber && depth < 64;
      fiber = fiber.return, depth += 1
    ) {
      for (const source of ['memoizedProps', 'pendingProps']) {
        const props = fiber?.[source];
        if (
          !props ||
          typeof props !== 'object' ||
          (typeof props.getItems !== 'function' && !Array.isArray(props.items))
        ) {
          continue;
        }

        try {
          if (typeof props.onBeforeOpen === 'function') {
            await props.onBeforeOpen();
          }

          const items = await readMenuItems(props);

          if (debugEnabled()) {
            debugCandidates.push({
              depth,
              source,
              type: fiberTypeName(fiber),
              ids: Array.isArray(items)
                ? items.slice(0, 24).map((item) => item?.id || item?.type || null)
                : [],
            });
          }

          if (matchesSidebarMenu(items, candidate.kind)) {
            return {
              items,
              intl,
              depth,
              source,
              type: fiberTypeName(fiber),
              debugCandidates,
            };
          }
        } catch (error) {
          if (debugEnabled()) {
            debugCandidates.push({
              depth,
              source,
              type: fiberTypeName(fiber),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    return { items: null, intl, debugCandidates };
  }

  function resolveItems(items, intl) {
    const formatMessage =
      typeof intl?.formatMessage === 'function'
        ? intl.formatMessage.bind(intl)
        : null;

    return items.map((item) => {
      if (item?.type === 'separator') {
        return { ...item, nativeLabel: '', submenu: undefined };
      }

      let nativeLabel = item?.nativeLabel;
      if (typeof nativeLabel !== 'string' && item?.message && formatMessage) {
        try {
          nativeLabel = formatMessage(item.message, item.messageValues);
        } catch {
          nativeLabel = null;
        }
      }

      if (typeof nativeLabel !== 'string') {
        nativeLabel =
          item?.message?.defaultMessage ||
          item?.label ||
          item?.id ||
          '';
      }

      let nativeTooltip = item?.nativeTooltip;
      if (
        typeof nativeTooltip !== 'string' &&
        item?.tooltipMessage &&
        formatMessage
      ) {
        try {
          nativeTooltip = formatMessage(
            item.tooltipMessage,
            item.tooltipMessageValues,
          );
        } catch {
          nativeTooltip = undefined;
        }
      }

      return {
        ...item,
        nativeLabel,
        nativeTooltip,
        submenu: Array.isArray(item?.submenu)
          ? resolveItems(item.submenu, intl)
          : undefined,
      };
    });
  }

  function currentColor(candidate) {
    return store.get(candidate.key);
  }

  function setColor(candidate, value) {
    const color = String(value || '').trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(color)) return;

    store.set(candidate.key, color);
    applyCandidate(candidate);
  }

  function clearColor(candidate) {
    store.remove(candidate.key);
    applyCandidate(candidate);
  }

  function openCustomColor(candidate) {
    pendingCustomColorCandidate = candidate;
    colorInput.value = currentColor(candidate) || DEFAULT_COLOR;
    colorInput.click();
  }

  function buildColorMenu(candidate) {
    const selected = currentColor(candidate)?.toUpperCase();

    const submenu = PRESETS.map(([label, color]) => ({
      id: `better-codex-color-${color.slice(1).toLowerCase()}`,
      type: 'checkbox',
      checked: selected === color,
      enabled: true,
      nativeLabel: label,
      onSelect: () => setColor(candidate, color),
    }));

    submenu.push(
      {
        id: 'better-codex-color-separator',
        type: 'separator',
        nativeLabel: '',
      },
      {
        id: 'better-codex-color-custom',
        enabled: true,
        nativeLabel: '自定义颜色…',
        onSelect: () => openCustomColor(candidate),
      },
    );

    if (selected) {
      submenu.push({
        id: 'better-codex-color-clear',
        enabled: true,
        nativeLabel: '清除颜色',
        onSelect: () => clearColor(candidate),
      });
    }

    return {
      id: 'better-codex-color',
      enabled: true,
      nativeLabel: '颜色标记',
      submenu,
    };
  }

  function insertColorMenu(items, candidate) {
    const next = [...items];
    const colorMenu = buildColorMenu(candidate);
    const existing = next.findIndex((item) => item?.id === colorMenu.id);

    if (existing >= 0) {
      next[existing] = colorMenu;
      return { items: next, insertAt: existing };
    }

    let insertAt = -1;

    for (let index = 0; index < next.length; index += 1) {
      const id = String(next[index]?.id || '').toLowerCase();
      if (/mark.*unread/.test(id)) insertAt = index + 1;
    }

    if (insertAt < 0) {
      for (let index = 0; index < next.length; index += 1) {
        const id = String(next[index]?.id || '').toLowerCase();
        if (/pin|rename|edit-project/.test(id)) insertAt = index + 1;
      }
    }

    if (insertAt < 0) {
      const separator = next.findIndex((item) => item?.type === 'separator');
      insertAt = separator >= 0 ? separator : Math.min(3, next.length);
    }

    next.splice(insertAt, 0, colorMenu);
    return { items: next, insertAt };
  }

  function toNativeItems(items) {
    return items.map((item) => ({
      id: item.id,
      type: item.type === 'separator' ? 'separator' : undefined,
      label:
        item.type === 'separator'
          ? ''
          : item.type === 'checkbox' && item.checked === true
            ? `✓ ${item.nativeLabel}`
            : String(item.nativeLabel || item.id || ''),
      icon: item.type === 'separator' ? undefined : item.icon,
      enabled: item.type === 'separator' ? true : item.enabled !== false,
      toolTip:
        item.type === 'separator' ? undefined : item.nativeTooltip,
      submenu:
        item.type === 'separator' || !Array.isArray(item.submenu)
          ? undefined
          : toNativeItems(item.submenu),
    }));
  }

  function findMenuItem(items, id) {
    for (const item of items) {
      if (!item || item.type === 'separator') continue;
      if (item.id === id) return item;

      if (Array.isArray(item.submenu)) {
        const found = findMenuItem(item.submenu, id);
        if (found) return found;
      }
    }

    return null;
  }

  function fallbackToCodex(candidate) {
    bypassContextMenu = true;

    try {
      candidate.element.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    } finally {
      queueMicrotask(() => {
        bypassContextMenu = false;
      });
    }
  }

  async function openNativeMenu(candidate) {
    const provider = await findMenuProvider(candidate);

    if (!provider.items) {
      diagnose('warn', 'provider-not-found', {
        kind: candidate.kind,
        candidates: provider.debugCandidates,
      });
      fallbackToCodex(candidate);
      return;
    }

    const resolved = resolveItems(provider.items, provider.intl);
    const augmented = insertColorMenu(resolved, candidate);

    diagnose('debug', 'native-menu-open', {
      kind: candidate.kind,
      provider: {
        depth: provider.depth,
        source: provider.source,
        type: provider.type,
        hasIntl: Boolean(provider.intl?.formatMessage),
      },
      insertAt: augmented.insertAt,
      ids: augmented.items
        .slice(0, 24)
        .map((item) => item?.id || item?.type || null),
    });

    document.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        composed: true,
      }),
    );

    const selection = await window.electronBridge?.showContextMenu?.(
      toNativeItems(augmented.items),
    );

    const selectedItem = selection?.id
      ? findMenuItem(augmented.items, selection.id)
      : null;

    selectedItem?.onSelect?.();
  }

  function onContextMenu(event) {
    if (bypassContextMenu) return;

    const candidate = candidateFromElement(event.target);
    if (!candidate) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    void openNativeMenu(candidate).catch((error) => {
      diagnose('warn', 'native-menu-error', {
        kind: candidate.kind,
        message: error instanceof Error ? error.message : String(error),
      });
      fallbackToCodex(candidate);
    });
  }

  function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() =>
      target.removeEventListener(type, listener, options),
    );
  }

  function destroy() {
    if (scanTimer) clearTimeout(scanTimer);
    observer?.disconnect();

    for (const remove of listeners.splice(0)) remove();

    document.getElementById(STYLE_ID)?.remove();
    colorInput.remove();

    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((element) => {
      element.removeAttribute(MARKER_ATTR);
      element.classList.remove(COLOR_CLASS);
      element.style.removeProperty('--better-codex-color');
    });

    if (window[GLOBAL_KEY] === api) delete window[GLOBAL_KEY];
  }

  colorInput.addEventListener('input', () => {
    if (!pendingCustomColorCandidate) return;

    if (colorInput.value) {
      setColor(pendingCustomColorCandidate, colorInput.value);
    }
    pendingCustomColorCandidate = null;
  });

  addListener(document, 'contextmenu', onContextMenu, true);
  addListener(window, 'resize', scheduleScan, { passive: true });
  addListener(document, 'scroll', scheduleScan, true);

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  scan();
  diagnose('debug', 'renderer-installed', { version: VERSION });

  api = {
    version: VERSION,
    scan,
    destroy,
    drainDiagnostics,
  };

  window[GLOBAL_KEY] = api;
})();
