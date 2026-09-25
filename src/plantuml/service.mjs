import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ENGINE_PACKAGE_VERSION, MAX_SVG_BYTES, prepareSource, failure } from './policy.mjs';

// 单 worker 串行渲染；超时终止 worker，不在 injector 事件循环里执行 TeaVM。
export class PlantUmlService {
  constructor({ timeoutMs = 15000, maxQueue = 32, maxCacheBytes = 16 * 1024 * 1024,
    workerURL = new URL('./worker.mjs', import.meta.url) } = {}) {
    Object.assign(this, { timeoutMs, maxQueue, maxCacheBytes, workerURL });
    this.queue = [];
    this.inflight = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.serial = 0;
    this.closed = false;
  }

  render(value) {
    if (this.closed) return Promise.reject(failure('CLOSED', '渲染服务已停止。'));
    let source;
    try { source = prepareSource(value); } catch (error) { return Promise.reject(error); }
    const key = createHash('sha256').update(`${ENGINE_PACKAGE_VERSION}\nsvg\n${source}`).digest('hex');
    if (this.cache.has(key)) {
      const result = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, result);
      return Promise.resolve(result);
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.inflight.size >= this.maxQueue) return Promise.reject(failure('QUEUE_FULL', '渲染队列已满，请稍后重试。'));
    const promise = new Promise((resolve, reject) => this.queue.push({ key, source, resolve, reject }));
    this.inflight.set(key, promise);
    this.pump();
    return promise;
  }

  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    job.id = ++this.serial;
    try {
      if (!this.worker) {
        const worker = new Worker(this.workerURL, {
          env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 },
          stdout: true, stderr: true,
        });
        // 不转发引擎输出；resourceLimits 不覆盖 WASM 内存，不声称是完整内存沙箱。
        worker.stdout.resume(); worker.stderr.resume();
        this.worker = worker;
        worker.on('message', message => {
          if (this.worker !== worker || message?.id !== this.active?.id) return;
          if (!message.ok) {
            const error = Object.assign(failure(message.code || 'ENGINE_ERROR', message.message || '本地渲染失败。'), { line: message.line });
            // 初始化失败不能永久缓存 rejected import；安装依赖后可直接重试。
            if (['ENGINE_MISSING', 'ENGINE_ERROR'].includes(error.code)) this.restart(error);
            else this.finish(error);
          } else if (typeof message.svg !== 'string' || Buffer.byteLength(message.svg) > MAX_SVG_BYTES) {
            this.restart(failure('OUTPUT_TOO_LARGE', '生成的 SVG 无效或超过 2 MiB。'));
          } else {
            this.finish(null, { svg: message.svg, engineVersion: message.engineVersion });
          }
        });
        worker.on('error', () => { if (this.worker === worker) this.restart(failure('WORKER_ERROR', '渲染进程异常，重试将重新初始化。')); });
        worker.on('exit', () => { if (this.worker === worker) this.restart(failure('WORKER_EXIT', '渲染进程已退出，请重试。')); });
      }
      this.timer = setTimeout(() => this.restart(failure('TIMEOUT', '本地图渲染超时，请简化图后重试。')), this.timeoutMs);
      this.worker.postMessage({ id: job.id, source: job.source });
    } catch {
      this.restart(failure('WORKER_START', '无法启动本地渲染进程。'));
    }
  }

  finish(error, result) {
    clearTimeout(this.timer);
    const job = this.active;
    if (!job) return;
    this.active = null;
    this.inflight.delete(job.key);
    if (error) job.reject(error);
    else {
      const bytes = Buffer.byteLength(result.svg);
      if (bytes <= this.maxCacheBytes) {
        while (this.cache.size && (this.cache.size >= 32 || this.cacheBytes + bytes > this.maxCacheBytes)) {
          const oldest = this.cache.keys().next().value;
          this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest).svg);
          this.cache.delete(oldest);
        }
        this.cache.set(job.key, result); this.cacheBytes += bytes;
      }
      job.resolve(result);
    }
    queueMicrotask(() => this.pump());
  }

  restart(error) {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate().catch(() => {});
    this.finish(error);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    const error = failure('CLOSED', '渲染服务已停止。');
    for (const job of this.queue.splice(0)) { this.inflight.delete(job.key); job.reject(error); }
    this.finish(error);
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate();
    this.cache.clear(); this.cacheBytes = 0;
  }
}
