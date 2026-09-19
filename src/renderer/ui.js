const SWATCHES = [
  '#7c3aed', '#2563eb', '#0891b2', '#059669',
  '#65a30d', '#ca8a04', '#ea580c', '#dc2626',
  '#db2777', '#64748b',
].join(';');

function isDarkSurface() {
  const candidates = [document.body, document.documentElement].filter(Boolean);

  for (const element of candidates) {
    const value = getComputedStyle(element).backgroundColor;
    const match = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!match) continue;

    const [, r, g, b] = match.map(Number);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (luminance < 0.35) return true;
    if (luminance > 0.75) return false;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function createColorPopover({ themeCss, paletteCss, onColor, onClear }) {
  const host = document.createElement('div');
  host.id = 'better-codex-ui';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${themeCss}\n${paletteCss}\n${customCss}`;
  shadow.appendChild(style);

  const shell = document.createElement('div');
  shell.className = 'bc-shell wa-theme-default wa-palette-default wa-brand-blue wa-neutral-gray wa-success-green wa-warning-yellow wa-danger-red';

  const anchor = document.createElement('button');
  anchor.id = 'bc-anchor';
  anchor.type = 'button';
  anchor.tabIndex = -1;
  anchor.setAttribute('aria-hidden', 'true');

  const popover = document.createElement('wa-popover');
  popover.setAttribute('for', anchor.id);
  popover.setAttribute('placement', 'right-start');
  popover.className = 'bc-popover';

  const panel = document.createElement('div');
  panel.className = 'bc-panel';

  const heading = document.createElement('div');
  heading.className = 'bc-heading';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'bc-eyebrow';
  eyebrow.textContent = '颜色标记';

  const title = document.createElement('div');
  title.className = 'bc-title';

  heading.append(eyebrow, title);

  const pickerRow = document.createElement('div');
  pickerRow.className = 'bc-picker-row';

  const picker = document.createElement('wa-color-picker');
  picker.setAttribute('label', '选择高亮颜色');
  picker.setAttribute('format', 'hex');
  picker.setAttribute('without-format-toggle', '');
  picker.setAttribute('size', 'm');
  picker.setAttribute('placement', 'right-start');
  picker.setAttribute('swatches', SWATCHES);

  const hint = document.createElement('div');
  hint.className = 'bc-hint';
  hint.textContent = '支持任意颜色，预设色仅用于快速选择。';

  pickerRow.append(picker, hint);

  const footer = document.createElement('div');
  footer.className = 'bc-footer';

  const clearButton = document.createElement('wa-button');
  clearButton.setAttribute('size', 's');
  clearButton.setAttribute('appearance', 'plain');
  clearButton.setAttribute('variant', 'neutral');
  clearButton.textContent = '清除';

  const doneButton = document.createElement('wa-button');
  doneButton.setAttribute('size', 's');
  doneButton.setAttribute('appearance', 'filled');
  doneButton.setAttribute('variant', 'neutral');
  doneButton.textContent = '完成';

  footer.append(clearButton, doneButton);

  const identityNote = document.createElement('div');
  identityNote.className = 'bc-identity-note';
  identityNote.textContent = '当前按标题关联，重命名后需要重新设置颜色。';

  panel.append(heading, pickerRow, identityNote, footer);
  popover.appendChild(panel);
  shell.append(anchor, popover);
  shadow.appendChild(shell);
  document.body.appendChild(host);

  let current = null;

  function syncTheme() {
    const dark = isDarkSurface();
    shell.classList.toggle('wa-dark', dark);
    shell.classList.toggle('wa-light', !dark);
  }

  function close() {
    popover.open = false;
    current = null;
  }

  function openAt(event, candidate, color) {
    current = candidate;
    syncTheme();

    anchor.style.left = `${Math.max(4, event.clientX)}px`;
    anchor.style.top = `${Math.max(4, event.clientY)}px`;

    title.textContent = candidate.label;
    title.title = candidate.label;
    identityNote.hidden = candidate.stable;
    picker.value = color || '#7c3aed';

    requestAnimationFrame(() => {
      popover.open = true;
    });
  }

  picker.addEventListener('input', () => {
    if (!current || !picker.value) return;
    onColor(current, picker.value);
  });

  clearButton.addEventListener('click', () => {
    if (!current) return;
    onClear(current);
    close();
  });

  doneButton.addEventListener('click', close);

  popover.addEventListener('wa-after-hide', () => {
    current = null;
  });

  return {
    openAt,
    close,
    destroy() {
      close();
      host.remove();
    },
  };
}

const customCss = `
  :host {
    all: initial;
  }

  .bc-shell {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    color: var(--wa-color-text-normal);
  }

  #bc-anchor {
    position: fixed;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }

  .bc-popover {
    pointer-events: auto;
    --max-width: 19rem;
  }

  .bc-popover::part(dialog) {
    border-radius: 14px;
  }

  .bc-popover::part(body) {
    padding: 0;
  }

  .bc-popover::part(popup__arrow) {
    display: none;
  }

  .bc-panel {
    width: 272px;
    padding: 14px;
    box-sizing: border-box;
  }

  .bc-heading {
    min-width: 0;
    margin-bottom: 12px;
  }

  .bc-eyebrow {
    margin-bottom: 3px;
    color: var(--wa-color-text-quiet);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .02em;
  }

  .bc-title {
    overflow: hidden;
    color: var(--wa-color-text-normal);
    font-size: 14px;
    font-weight: 650;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bc-picker-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--wa-color-surface-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--wa-color-surface-raised) 72%, transparent);
  }

  .bc-hint {
    color: var(--wa-color-text-quiet);
    font-size: 11px;
    line-height: 1.45;
  }

  .bc-identity-note {
    margin-top: 9px;
    color: var(--wa-color-text-quiet);
    font-size: 10px;
    line-height: 1.4;
  }

  .bc-identity-note[hidden] {
    display: none;
  }

  .bc-footer {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 12px;
  }
`;
