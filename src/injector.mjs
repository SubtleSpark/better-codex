import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlantUmlBridge } from './plantuml/bridge.mjs';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(srcDir, 'renderer.js');

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
  console.log(
    `BetterCodex injector\n\nUsage:\n  node src/injector.mjs [--host 127.0.0.1] [--port 9347] [--watch]\n`,
  );
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
  throw new Error(
    'For safety, BetterCodex only connects to loopback CDP (127.0.0.1/localhost).',
  );
}

const source = await fs.readFile(rendererPath, 'utf8');
const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const endpoint = `http://${args.host}:${args.port}`;
const debug = process.env.BETTER_CODEX_DEBUG === '1';
const injectedTargets = new Set();
const plantuml = new PlantUmlBridge({
  enabled: args.watch && process.env.BETTER_CODEX_PLANTUML !== '0',
  debug,
  rootSelector: process.env.BETTER_CODEX_PLANTUML_ROOT || null,
});
const plantumlFailures = new Set();

let stopping = false;
let waitingLogged = false;
let lastTargetSignature = '';

async function listTargets() {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });

  if (!response.ok) {
    throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  }

  return response.json();
}

function isRendererTarget(target) {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;

  const rawUrl = String(target.url || '');
  if (!rawUrl.startsWith('app://-/index.html')) return false;

  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get('initialRoute') === '/avatar-overlay') {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

async function withCdp(target, fn) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out opening CDP websocket')),
      2500,
    );

    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );

    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Failed to open CDP websocket'));
      },
      { once: true },
    );
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

    if (message.error) {
      waiter.reject(new Error(message.error.message || 'CDP command failed'));
    } else {
      waiter.resolve(message.result);
    }
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 3000);
    });
  }

  try {
    return await fn(call);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

function runtimeError(result, fallback) {
  const details = result?.exceptionDetails;
  if (!details) return null;

  const description =
    details.exception?.description ||
    details.exception?.value ||
    details.text ||
    fallback;

  return new Error(String(description || fallback));
}

async function evaluate(call, expression, options = {}) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
    ...options,
  });

  const error = runtimeError(result, 'Renderer evaluation failed');
  if (error) throw error;

  return result;
}

async function injectTarget(target) {
  const state = await withCdp(target, async (call) => {
    await evaluate(
      call,
      `window.__BETTER_CODEX_DEBUG__ = ${debug ? 'true' : 'false'}; true;`,
    );

    await evaluate(
      call,
      `${source}\n//# sourceURL=better-codex-renderer.js`,
      { returnByValue: false },
    );

    const probe = await evaluate(
      call,
      'window.__BETTER_CODEX__ ? { status: "installed", version: window.__BETTER_CODEX__.version } : null;',
    );

    const diagnostics = await evaluate(
      call,
      'window.__BETTER_CODEX__?.drainDiagnostics?.() ?? [];',
    );

    const diagnosticValues = Array.isArray(diagnostics?.result?.value)
      ? diagnostics.result.value
      : [];

    if (
      diagnosticValues.some(
        (item) => item?.event === 'custom-color-picker-request',
      )
    ) {
      const picker = await evaluate(
        call,
        'window.__BETTER_CODEX__?.showPendingCustomColorPicker?.() ?? { ok: false, reason: "api-unavailable" };',
        { userGesture: true },
      );

      diagnosticValues.push({
        at: new Date().toISOString(),
        level: picker?.result?.value?.ok ? 'debug' : 'warn',
        event: 'custom-color-picker-cdp',
        ...(picker?.result?.value || {
          ok: false,
          reason: 'no-result',
        }),
      });
    }

    try {
      await plantuml.poll(target.id, (expression, options) => evaluate(call, expression, options));
      plantumlFailures.delete(target.id);
    } catch {
      if (!plantumlFailures.has(target.id)) {
        plantumlFailures.add(target.id);
        console.warn('[BetterCodex:plantuml] 预览注入/通信失败，颜色功能不受影响；可开启 BETTER_CODEX_DEBUG=1 排查。');
      }
    }

    return {
      value: probe?.result?.value,
      diagnostics: diagnosticValues,
    };
  });

  if (!state.value?.status) {
    throw new Error('Renderer script finished without installing BetterCodex');
  }

  if (!injectedTargets.has(target.id)) {
    injectedTargets.add(target.id);
    console.log(
      `[BetterCodex] injected into Codex renderer (${state.value.version})`,
    );
  }

  for (const diagnostic of state.diagnostics) {
    const prefix =
      diagnostic?.level === 'warn'
        ? '[BetterCodex:warn]'
        : '[BetterCodex:debug]';
    console.log(`${prefix} ${JSON.stringify(diagnostic)}`);
  }
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await plantuml.close();

  try {
    const targets = (await listTargets()).filter(isRendererTarget);

    await Promise.allSettled(
      targets.map((target) =>
        withCdp(target, (call) =>
          call('Runtime.evaluate', {
            expression: 'window.__BETTER_CODEX_PLANTUML__?.destroy?.(); window.__BETTER_CODEX__?.destroy?.(); true;',
            returnByValue: true,
          }),
        ),
      ),
    );
  } catch {}

  console.log('\n[BetterCodex] UI cleanup requested.');
  console.log(
    '[BetterCodex] Note: CDP stays enabled until ChatGPT/Codex is fully quit and reopened normally.',
  );
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
  const allTargets = await listTargets();
  const targets = allTargets.filter(isRendererTarget);
  plantuml.retainTargets(new Set(targets.map(target => target.id)));

  if (targets.length === 0) {
    if (!waitingLogged) {
      console.log('[BetterCodex] waiting for Codex main renderer...');
      waitingLogged = true;
    }

    const signature = allTargets
      .map((target) => `${target.type} ${String(target.url || '')}`)
      .sort()
      .join(' | ');

    if (debug && signature && signature !== lastTargetSignature) {
      lastTargetSignature = signature;
      console.log(`[BetterCodex:debug] current CDP targets: ${signature}`);
    }

    return false;
  }

  waitingLogged = false;

  const results = await Promise.allSettled(targets.map(injectTarget));
  let succeeded = false;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      succeeded = true;
      continue;
    }

    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);

    console.error(`[BetterCodex] injection failed: ${message}`);
  }

  return succeeded;
}

console.log(`[BetterCodex] v${version} connected to ${endpoint}`);

if (debug) {
  console.log('[BetterCodex] debug logging enabled.');
}

console.log('[BetterCodex] Press Ctrl+C to stop.');

if (!args.watch) {
  const found = await tick();
  if (!found) process.exitCode = 1;
} else {
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error(
        `[BetterCodex] ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
