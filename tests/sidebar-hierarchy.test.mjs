import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 只使用本机 Chrome / Chromium，不新增 npm dependency，也不连接真实 Codex。
function findBrowser() {
  const candidates = process.env.BETTER_CODEX_TEST_BROWSER
    ? [process.env.BETTER_CODEX_TEST_BROWSER]
    : ['google-chrome', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const browser of candidates) {
    try {
      execFileSync(browser, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return browser;
    } catch {}
  }
  throw new Error('未找到 Chrome / Chromium，请设置 BETTER_CODEX_TEST_BROWSER 为浏览器可执行文件路径。');
}

async function connect(profile, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('测试浏览器提前退出');
    try {
      const [port, endpoint] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('测试 CDP 连接超时')), 3000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('测试 CDP 连接失败')); }, { once: true });
      });
      return ws;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await sleep(50);
    }
  }
  throw new Error('测试浏览器未启动 CDP');
}

function makeClient(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('测试 CDP 已关闭'));
    }
    pending.clear();
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`测试 CDP 超时: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

test('project children: layout, colors, reinjection and cleanup', { timeout: 30000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'better-codex-layout-'));
  const child = spawn(findBrowser(), [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let ws;
  try {
    ws = await connect(profile, child);
    const call = makeClient(ws);
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const source = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8');
    let html = await readFile(new URL('./sidebar-hierarchy.html', import.meta.url), 'utf8');
    // 内联本地文件，避免浏览器的 file:// / 网络导航策略干扰布局测试。
    html = html.replace('<script src="../src/renderer.js"></script>', () => `<script>${source}</script>`)
      .replace("script.src = '../src/renderer.js';", () => `script.text = ${JSON.stringify(source)};`)
      .replace('document.body.appendChild(script);', 'document.body.appendChild(script); resolve();');
    const result = await call('Runtime.evaluate', {
      expression: `(() => {
        // about:blank 没有持久化 origin，仅替换 storage；DOM/CSS 使用真实浏览器。
        const data = new Map();
        Object.defineProperty(window, 'localStorage', { value: {
          getItem: key => data.get(key) ?? null,
          setItem: (key, value) => data.set(key, String(value)),
          removeItem: key => data.delete(key),
        }});
        document.open(); document.write(${JSON.stringify(html)}); document.close();
        return new Promise(resolve => {
          const timer = setInterval(() => {
            const node = document.getElementById('result');
            if (node?.dataset.result === 'pending') return;
            clearInterval(timer);
            resolve({ status: node?.dataset.result, text: node?.textContent });
          }, 20);
        });
      })()`,
      returnByValue: true, awaitPromise: true,
    }, sessionId);
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value?.status, 'passed', result.result.value?.text);
    console.log(result.result.value.text);
    await call('Browser.close');
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    ws?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.race([exited, sleep(1000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
