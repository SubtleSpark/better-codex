import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(srcDir, '..');
const rendererPath = path.join(rootDir, 'dist/renderer.js');
const vendorPath = path.join(rootDir, 'dist/vendor.js');

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 9347, watch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--host') args.host = argv[++i];
    else if (token === '--port') args.port = Number(argv[++i]);
    else if (token === '--watch') args.watch = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`BetterCodex injector\n\nUsage:\n  node src/injector.mjs [--host 127.0.0.1] [--port 9347] [--watch]\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
  throw new Error(`Invalid port: ${args.port}`);
}
if (args.host !== '127.0.0.1' && args.host !== 'localhost') {
  throw new Error('For safety, BetterCodex only connects to loopback CDP (127.0.0.1/localhost).');
}

const [source, vendorSource] = await Promise.all([
  fs.readFile(rendererPath, 'utf8'),
  fs.readFile(vendorPath, 'utf8'),
]).catch(() => {
  throw new Error('dist bundle not found. Run npm install && npm run build first.');
});

const endpoint = `http://${args.host}:${args.port}`;
const injectedTargets = new Set();
let stopping = false;

async function listTargets() {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  return response.json();
}

function isRendererTarget(target) {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || '');
  const title = String(target.title || '');
  return (
    url.startsWith('app://') ||
    url.includes('index.html') ||
    /chatgpt|codex/i.test(title)
  );
}

async function withCdp(target, fn) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening CDP websocket')), 2500);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Failed to open CDP websocket'));
    }, { once: true });
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed'));
    else waiter.resolve(message.result);
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 3000);
    });
  }

  try {
    return await fn(call);
  } finally {
    try { ws.close(); } catch {}
  }
}

async function injectTarget(target) {
  const value = await withCdp(target, async (call) => {
    const existing = await call('Runtime.evaluate', {
      expression: 'window.__BETTER_CODEX__ ? { status: "installed", version: window.__BETTER_CODEX__.version } : null;',
      returnByValue: true,
    });

    if (existing?.result?.value) {
      await call('Runtime.evaluate', {
        expression: 'window.__BETTER_CODEX__?.scan?.(); true;',
        returnByValue: true,
      });
      return existing.result.value;
    }

    const vendorState = await call('Runtime.evaluate', {
      expression: `(() => {
        const tags = ['wa-button', 'wa-color-picker', 'wa-popover'];
        const present = tags.filter((tag) => customElements.get(tag));
        return { present, missing: tags.filter((tag) => !customElements.get(tag)) };
      })()`,
      returnByValue: true,
    });

    const state = vendorState?.result?.value || { present: [], missing: [] };
    if (state.missing.length > 0 && state.present.length > 0) {
      throw new Error(`Web Awesome custom-element conflict: present=${state.present.join(',')} missing=${state.missing.join(',')}`);
    }

    if (state.missing.length > 0) {
      await call('Runtime.evaluate', {
        expression: `${vendorSource}\n//# sourceURL=better-codex-vendor.js`,
        awaitPromise: true,
        returnByValue: false,
        userGesture: false,
      });
    }

    await call('Runtime.evaluate', {
      expression: `${source}\n//# sourceURL=better-codex-renderer.js`,
      awaitPromise: true,
      returnByValue: false,
      userGesture: false,
    });

    const probe = await call('Runtime.evaluate', {
      expression: 'window.__BETTER_CODEX__ ? { status: "installed", version: window.__BETTER_CODEX__.version } : null;',
      returnByValue: true,
    });

    return probe?.result?.value;
  });

  if (value?.status === 'installed') {
    const targetName = target.title || target.url || target.id;
    if (!injectedTargets.has(target.id)) {
      injectedTargets.add(target.id);
      console.log(`[BetterCodex] injected into: ${targetName} (${value.version})`);
    }
  }
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  try {
    const targets = (await listTargets()).filter(isRendererTarget);
    await Promise.allSettled(targets.map((target) => withCdp(target, (call) => call('Runtime.evaluate', {
      expression: 'window.__BETTER_CODEX__?.destroy?.(); true;',
      returnByValue: true,
    }))));
  } catch {}
  console.log('\n[BetterCodex] UI cleanup requested.');
  console.log('[BetterCodex] Note: CDP stays enabled until ChatGPT/Codex is fully quit and reopened normally.');
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

async function tick() {
  const targets = (await listTargets()).filter(isRendererTarget);
  if (targets.length === 0) {
    throw new Error('No Codex/ChatGPT renderer target found.');
  }
  await Promise.allSettled(targets.map(injectTarget));
}

console.log(`[BetterCodex] connected to ${endpoint}`);
console.log('[BetterCodex] Right-click a project or conversation in the left sidebar to set a color.');
console.log('[BetterCodex] Press Ctrl+C to remove the injected UI and stop the watcher.');

if (!args.watch) {
  await tick();
} else {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error(`[BetterCodex] ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
