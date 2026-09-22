import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 只需要本地 Chrome / Chromium；不新增 npm dependency，也不连接 Codex。
function findBrowser() {
  const candidates = process.env.BETTER_CODEX_TEST_BROWSER
    ? [process.env.BETTER_CODEX_TEST_BROWSER]
    : ['chromium', 'chromium-browser', 'google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const browser of candidates) {
    try {
      execFileSync(browser, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return browser;
    } catch {}
  }
  throw new Error('未找到 Chrome / Chromium，请设置 BETTER_CODEX_TEST_BROWSER 为浏览器可执行文件路径。');
}

test('project children: layout, colors, reinjection and cleanup', { timeout: 30000 }, () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'better-codex-layout-'));
  try {
    const html = execFileSync(findBrowser(), [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom',
      new URL('./sidebar-hierarchy.html', import.meta.url).href,
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = html.match(/<pre id="result"[^>]*>[\s\S]*?<\/pre>/)?.[0];
    assert.ok(result?.includes('data-result="passed"'), result || '浏览器没有返回测试结果');
    console.log(result.replace(/<[^>]+>/g, ''));
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
