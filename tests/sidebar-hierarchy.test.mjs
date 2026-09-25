import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { browser } from './helpers/browser.mjs';

// 复用已用于 PlantUML 的浏览器启动器，避免 --version 探测误选 CI 包装脚本。
// 原 fixture 和 34 个布局断言不变，不连接真实 Codex。
test('project children: layout, colors, reinjection and cleanup', { timeout: 30000 }, async t => {
  const page = await browser();
  t.after(() => page.close());
  const source = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
  let html = await readFile(new URL('./sidebar-hierarchy.html', import.meta.url), 'utf8');
  html = html.replace('<script src="../src/renderer.js"></script>', () => `<script>${source}</script>`)
    .replace("script.src = '../src/renderer.js';", () => `script.text = ${JSON.stringify(source)};`)
    .replace('document.body.appendChild(script);', 'document.body.appendChild(script); resolve();');
  await page.evaluate(`(() => {
    // about:blank 没有持久化 origin，仅替换 storage；DOM/CSS 使用真实浏览器。
    const data = new Map();
    Object.defineProperty(window, 'localStorage', { value: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: key => data.delete(key),
    }});
    document.open(); document.write(${JSON.stringify(html)}); document.close();
  })()`);
  const result = await page.until(`(() => {
    const node = document.getElementById('result');
    return node && node.dataset.result !== 'pending'
      ? { status: node.dataset.result, text: node.textContent } : null;
  })()`);
  assert.equal(result.status, 'passed', result.text);
  console.log(result.text);
});
