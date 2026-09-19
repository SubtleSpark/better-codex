const MARKER_ATTR = 'data-better-codex-key';
const COLOR_CLASS = 'better-codex-colored';

const blockedLabels = new Set([
  'new chat', 'new conversation', 'new thread', '新会话', '新对话',
  'code', '代码', 'plugins', '插件', 'automations', 'scheduled', '定时任务', '已安排',
  'sites', '站点', 'pull requests', 'settings', '设置', 'workspaces', '工作区',
]);

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
    if (value) return { key: `attr:${name}:${value}`, stable: true };
  }

  const link = element.closest('a[href]');
  const href = link?.getAttribute('href');
  if (href && href !== '#' && !href.startsWith('javascript:')) {
    try {
      const url = new URL(href, location.href);
      return { key: `href:${url.origin}${url.pathname}`, stable: true };
    } catch {
      return { key: `href:${href.split(/[?#]/, 1)[0]}`, stable: true };
    }
  }

  const testId = element.getAttribute('data-testid') || element.closest('[data-testid]')?.getAttribute('data-testid');
  if (testId && /thread|conversation|project|workspace|item/i.test(testId)) {
    return { key: `testid:${testId}:${label.toLowerCase()}`, stable: false };
  }

  return label ? { key: `title:${label.toLowerCase()}`, stable: false } : null;
}

function isBlocked(label) {
  const lower = label.toLowerCase();
  if (blockedLabels.has(lower)) return true;
  return lower.startsWith('pull request') || lower.startsWith('search ');
}

export function createSidebarAdapter({ getColor }) {
  function candidateFromElement(element) {
    if (!(element instanceof Element)) return null;

    const clickTarget = element.closest('a[href], button, [role="button"], [role="link"]');
    if (!clickTarget) return null;

    const rect = clickTarget.getBoundingClientRect();
    const sidebarLimit = Math.min(520, Math.max(300, window.innerWidth * 0.36));
    if (rect.left < -2 || rect.right <= 0 || rect.left > sidebarLimit) return null;
    if (rect.top < 0 || rect.bottom > window.innerHeight + 2) return null;
    if (rect.width < 100 || rect.height < 22 || rect.height > 88) return null;

    const style = getComputedStyle(clickTarget);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return null;

    const label = getLabel(clickTarget);
    if (!label || label.length > 180 || isBlocked(label)) return null;

    const identity = stableKey(clickTarget, label);
    if (!identity) return null;

    return {
      element: clickTarget,
      key: identity.key,
      stable: identity.stable,
      label,
    };
  }

  function candidates() {
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

  function apply(candidate) {
    const color = getColor(candidate.key);
    candidate.element.setAttribute(MARKER_ATTR, candidate.key);

    if (color) {
      candidate.element.style.setProperty('--better-codex-color', color);
      candidate.element.classList.add(COLOR_CLASS);
    } else {
      candidate.element.style.removeProperty('--better-codex-color');
      candidate.element.classList.remove(COLOR_CLASS);
    }
  }

  function scan() {
    for (const candidate of candidates()) apply(candidate);
  }

  function cleanup() {
    document.querySelectorAll(`[${MARKER_ATTR}]`).forEach((element) => {
      element.removeAttribute(MARKER_ATTR);
      element.classList.remove(COLOR_CLASS);
      element.style.removeProperty('--better-codex-color');
    });
  }

  return {
    fromEventTarget: candidateFromElement,
    apply,
    scan,
    cleanup,
  };
}

export const sidebarHighlightCss = `
  .better-codex-colored {
    box-shadow: inset 3px 0 0 var(--better-codex-color) !important;
    background-image: linear-gradient(
      90deg,
      color-mix(in srgb, var(--better-codex-color) 10%, transparent) 0%,
      transparent 52%
    ) !important;
  }
`;
