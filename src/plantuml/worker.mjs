import { parentPort } from 'node:worker_threads';
import { MAX_SVG_BYTES, prepareSource } from './policy.mjs';

// 不启动 package 的 MCP server；只加载已锁定版本的 headless engine。
// 屏蔽引擎偶发日志，避免把架构源码写入终端。
for (const method of ['log', 'info', 'debug', 'warn', 'error']) console[method] = () => {};
const denyNetwork = () => { throw new Error('PlantUML network access is disabled'); };
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
globalThis.XMLHttpRequest = class { constructor() { denyNetwork(); } };
let enginePromise;
function loadEngine() {
  return enginePromise ??= (async () => {
    const viz = await import('@viz-js/viz');
    let instance;
    globalThis.Viz = { instance: () => instance ??= viz.instance() };
    const engine = await import('@plantuml/mcp-js/engine.js');
    if (typeof engine.renderSvg !== 'function') throw new Error('Unsupported PlantUML engine API');
    return engine;
  })();
}

parentPort.on('message', async ({ id, source }) => {
  try {
    const input = prepareSource(source);
    const engine = await loadEngine();
    const json = await new Promise(resolve => engine.renderSvg(input, resolve));
    const result = JSON.parse(json);
    if (result.valid !== true || typeof result.svg !== 'string') {
      parentPort.postMessage({ id, ok: false, code: 'SYNTAX_ERROR',
        message: 'PlantUML 语法不受支持或有误，请查看源码。',
        line: Number.isInteger(result.errorLineNumber) ? result.errorLineNumber : null });
      return;
    }
    if (Buffer.byteLength(result.svg, 'utf8') > MAX_SVG_BYTES) {
      parentPort.postMessage({ id, ok: false, code: 'OUTPUT_TOO_LARGE', message: '生成的 SVG 超过 2 MiB。' });
      return;
    }
    parentPort.postMessage({ id, ok: true, svg: result.svg, engineVersion: engine.version?.() || 'unknown' });
  } catch (error) {
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND';
    parentPort.postMessage({ id, ok: false, code: missing ? 'ENGINE_MISSING' : 'ENGINE_ERROR',
      message: missing ? '本地引擎未安装，请在 BetterCodex 目录执行 npm ci --ignore-scripts。' : '本地渲染失败；原始源码已保留。' });
  }
});
