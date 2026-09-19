import themeCss from '@awesome.me/webawesome/dist/styles/themes/default.css';
import paletteCss from '@awesome.me/webawesome/dist/styles/color/palettes/default.css';

import { createColorStore } from './store.js';
import { createSidebarAdapter, sidebarHighlightCss } from './sidebar.js';
import { createColorPopover } from './ui.js';

const VERSION = '0.2.0';
const GLOBAL_KEY = '__BETTER_CODEX__';
const STYLE_ID = 'better-codex-highlight-style';

const previous = window[GLOBAL_KEY];
if (previous?.version === VERSION) {
  previous.scan?.();
} else {
  previous?.destroy?.();
  install();
}

function install() {
  const store = createColorStore(localStorage);
  const sidebar = createSidebarAdapter({ getColor: (key) => store.get(key) });
  const listeners = [];
  let scanTimer = null;
  let observer = null;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = sidebarHighlightCss;
  document.head.appendChild(style);

  const ui = createColorPopover({
    themeCss,
    paletteCss,
    onColor(candidate, color) {
      store.set(candidate.key, color);
      sidebar.apply(candidate);
    },
    onClear(candidate) {
      store.remove(candidate.key);
      sidebar.apply(candidate);
    },
  });

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      sidebar.scan();
    }, 80);
  }

  function onContextMenu(event) {
    const candidate = sidebar.fromEventTarget(event.target);
    if (!candidate) return;

    event.preventDefault();
    event.stopPropagation();
    ui.openAt(event, candidate, store.get(candidate.key));
  }

  function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }

  function destroy() {
    ui.destroy();
    if (scanTimer) clearTimeout(scanTimer);
    observer?.disconnect();
    for (const remove of listeners.splice(0)) remove();
    document.getElementById(STYLE_ID)?.remove();
    sidebar.cleanup();
    if (window[GLOBAL_KEY] === api) delete window[GLOBAL_KEY];
  }

  addListener(document, 'contextmenu', onContextMenu, true);
  addListener(window, 'resize', scheduleScan, { passive: true });

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  sidebar.scan();

  const api = {
    version: VERSION,
    scan: sidebar.scan,
    destroy,
  };

  window[GLOBAL_KEY] = api;
}
