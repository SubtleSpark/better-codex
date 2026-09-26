import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyTarget, describeTarget, validateSocket, matchGuestFrame, inspectTarget } from './diagnose-plantuml.mjs';
import { readProtocolDom, summarizeLocation } from './plantuml-protocol-probe.mjs';

const PREFIX = '[BetterCodex:plantuml-locate]';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 单次只读连接；所有错误只输出固定代码，不转发可能含 URL/源码的 CDP 错误文本。
async function connect(address) {
  const ws = new WebSocket(address), pending = new Map();
  let serial = 0;
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP_CLOSED')); } pending.clear(); };
  ws.addEventListener('close', fail); ws.addEventListener('error', fail);
  ws.addEventListener('message', event => {
    const text = String(event.data);
    if (text.length > 32 * 1024 * 1024) { fail(); ws.close(); return; }
    let m; try { m = JSON.parse(text); } catch { return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error('CDP_COMMAND_FAILED')); else p.resolve(m.result);
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_OPEN_TIMEOUT')), 3000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_OPEN_FAILED')); }, { once: true });
    });
  } catch (error) { ws.close(); throw error; }
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error('CDP_CLOSED')); return; }
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_COMMAND_TIMEOUT')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('CDP_SEND_FAILED')); }
      });
    },
    close() { fail(); ws.close(); },
  };
}

export function parseArgs(argv) {
  const opts = { port: Number(process.env.BETTER_CODEX_PORT || 9347), delay: 8, guests: false, screenshot: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--include-guests') opts.guests = true;
    else if (argv[i] === '--screenshot') opts.screenshot = true;
    else if (argv[i] === '--delay' && argv[i + 1] !== undefined) opts.delay = Number(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1] !== undefined) opts.port = Number(argv[++i]);
    else throw new Error('INVALID_ARGUMENT');
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535 ||
      !Number.isInteger(opts.delay) || opts.delay < 0 || opts.delay > 60) throw new Error('INVALID_ARGUMENT');
  return opts;
}

async function probe(target, port, screenshotDir, ordinal) {
  const cdp = await connect(validateSocket(target.webSocketDebuggerUrl, port));
  try {
    const { frameTree } = await cdp.call('Page.getFrameTree');
    if (!frameTree?.frame || !matchGuestFrame(frameTree.frame, target.url).permitted) throw new Error('DOCUMENT_CHANGED');
    // 只在相同的顶层文档读取协议树。不依据界面标题或 business URL 猜测归属。
    const verify = async () => {
      const result = await cdp.call('Runtime.evaluate', { expression: `(() => {
        if (location.href !== ${JSON.stringify(target.url)}) return null;
        const selected = String(window.getSelection()?.toString() || '').trim().toLowerCase();
        return { focused: document.hasFocus(), visibility: document.visibilityState,
          selectedPlantumlLabel: ['plantuml', 'puml', 'plantuml-svg', 'puml-svg'].includes(selected),
          plantumlInstalled: Boolean(window.__BETTER_CODEX_PLANTUML__) };
      })()`, returnByValue: true, silent: true, timeout: 1000 });
      if (result.exceptionDetails || !result.result?.value) throw new Error('DOCUMENT_CHANGED');
      return result.result.value;
    };
    const view = await verify();
    const protocol = await readProtocolDom(cdp.call);
    await verify();
    let screenshot, screenshotError;
    // 只有用户显式指定才保存；仅主 App 页面，不截外部 WebView，不自动上传。
    if (screenshotDir && classifyTarget(target).injectorEligible) {
      try {
        const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await verify();
        if (typeof result.data !== 'string' || result.data.length > 24 * 1024 * 1024) throw new Error('SCREENSHOT_INVALID');
        screenshot = path.join(screenshotDir, `app-${ordinal}.png`);
        await fs.writeFile(screenshot, Buffer.from(result.data, 'base64'), { flag: 'wx', mode: 0o600 });
      } catch { screenshot = undefined; screenshotError = 'SCREENSHOT_UNAVAILABLE'; }
    }
    return { view, protocol, ...(screenshot ? { screenshot } : {}), ...(screenshotError ? { screenshotError } : {}) };
  } finally { cdp.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('用法：node scripts/locate-plantuml.mjs [--port 9347] [--delay 8] [--include-guests] [--screenshot]\n只读定位；可选截图只保存本机主 App 页面，分享前请检查敏感内容。');
    return;
  }
  const opts = parseArgs(argv);
  const emit = value => console.log(`${PREFIX} ${JSON.stringify(value)}`);
  emit({ event: 'prepare', delaySeconds: opts.delay, screenshots: opts.screenshot,
    instruction: '请切回 Codex，打开出问题的 Markdown 渲染预览；可选中 plantuml-svg 标签，保持该页面显示。截图仅保存到本机，请检查敏感内容后再分享。' });
  await delay(opts.delay * 1000);
  const response = await fetch(`http://127.0.0.1:${opts.port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw new Error('CDP_UNAVAILABLE');
  const all = await response.json();
  if (!Array.isArray(all)) throw new Error('INVALID_TARGET_LIST');
  const targets = all.slice(0, 32), linked = new Set(), reports = [];
  let failures = 0, attempts = 0;
  const dir = opts.screenshot ? await fs.mkdtemp(path.join(os.tmpdir(), 'better-codex-plantuml-view-')) : null;
  const hints = targets.map((t, i) => ({ target: i + 1, url: t.url }));
  emit({ event: 'start', captureVersion: 1, at: new Date().toISOString(), readOnly: true, includeGuests: opts.guests });
  async function inspect(target, ordinal, guest) {
    if (++attempts > 8) { failures++; return; }
    const docs = [];
    try {
      await inspectTarget(target, opts.port, packet => {
        if (packet.event === 'probe-failed') failures++;
        if (packet.event !== 'dom' || !packet.report) return;
        docs.push(packet.report);
        if (!guest) for (const embed of packet.report.embeds || []) for (const n of embed.matchingTargets || []) linked.add(n);
      }, { linkedGuest: guest, targetHints: guest ? [] : hints });
      if (!docs.length) { emit({ event: 'skipped', target: ordinal, code: 'NO_READABLE_DOCUMENT' }); return; }
      const result = await probe(target, opts.port, dir, ordinal);
      const entry = { dom: { labels: docs.flatMap(d => d.labels || []), truncated: docs.some(d => d.truncated) }, ...result };
      reports.push(entry);
      emit({ event: 'located', target: ordinal, ...describeTarget(target), runtimeDomTruncated: entry.dom.truncated, ...result });
    } catch (error) { failures++; emit({ event: 'failed', target: ordinal, code: /^[A-Z_]+$/.test(error.message) ? error.message : 'CAPTURE_FAILED' }); }
  }
  for (const [i, target] of targets.entries()) if (classifyTarget(target).inspect) await inspect(target, i + 1, false);
  if (opts.guests) for (const [i, target] of targets.entries()) {
    if (linked.has(i + 1) && !classifyTarget(target).inspect && ['page', 'webview', 'iframe'].includes(target.type)) await inspect(target, i + 1, true);
  }
  const summary = summarizeLocation(reports, failures);
  if (all.length > 32) { summary.truncated = true; summary.incomplete = true; }
  if (!reports.length) { summary.incomplete = true; summary.failures++; }
  emit({ event: 'done', ...summary, ...(dir ? { screenshotDirectory: dir } : {}) });
  if (summary.incomplete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error(`${PREFIX} {"event":"failed","code":"CAPTURE_FAILED"}`); process.exitCode = 1; });
}
