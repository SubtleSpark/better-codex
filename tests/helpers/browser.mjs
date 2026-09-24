import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function browser() {
  const names = process.env.BETTER_CODEX_TEST_BROWSER ? [process.env.BETTER_CODEX_TEST_BROWSER]
    : [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  // 不用 --version 探测：并发 CI 下启动包装脚本可能阻塞，误报未安装浏览器。
  const paths = names.flatMap(name => name.includes(path.sep) ? [name]
    : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name)));
  const executable = paths.find(name => {
    try { accessSync(name, constants.X_OK); return true; } catch { return false; }
  });
  if (!executable) throw new Error('需要 Chrome/Chromium；可设置 BETTER_CODEX_TEST_BROWSER。');
  const profile = await mkdtemp(path.join(tmpdir(), 'better-codex-puml-test-'));
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  let spawnError;
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', error => { spawnError = error; resolve(); });
  });
  let ws;
  let closed = false;
  const waiters = new Map();
  function rejectPending() {
    for (const pending of waiters.values()) { clearTimeout(pending.timer); pending.reject(new Error('Test browser closed')); }
    waiters.clear();
  }
  async function close() {
    if (closed) return;
    closed = true; ws?.close(); rejectPending();
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exited; clearTimeout(timer);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  try {
    let port;
    for (let i = 0; i < 150; i++) {
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
      if (port) break;
      if (spawnError || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!port) throw new Error(`Chrome did not start (${executable}): ${spawnError?.message || stderr}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    ws = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), 3000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP error')); }, { once: true });
    });
    let next = 0;
    ws.addEventListener('close', rejectPending);
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)); const pending = waiters.get(message.id);
      if (!pending) return;
      waiters.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    function command(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
        waiters.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression, options = {}) {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...options });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    async function until(expression, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const result = await evaluate(expression); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Browser assertion timed out: ${expression}`);
    }
    return { command, evaluate, until, close };
  } catch (error) { await close(); throw error; }
}
