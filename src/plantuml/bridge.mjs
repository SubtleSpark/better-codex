import fs from 'node:fs/promises';
import { PlantUmlService } from './service.mjs';

const source = await fs.readFile(new URL('./renderer.js', import.meta.url), 'utf8');
const API = 'window.__BETTER_CODEX_PLANTUML__';

export class PlantUmlBridge {
  constructor({ enabled = true, debug = false, rootSelector = null, service = new PlantUmlService(), log = console.log } = {}) {
    Object.assign(this, { enabled, debug, rootSelector, service, log });
    this.targets = new Map();
    this.closed = false;
  }
  async poll(targetId, evaluate) {
    if (this.closed) return;
    if (!this.enabled) { await evaluate(`${API}?.destroy?.();`); return; }
    await evaluate(`window.__BETTER_CODEX_PLANTUML_OPTIONS__ = ${JSON.stringify({ debug: this.debug, rootSelector: this.rootSelector })};\n${source}`, { returnByValue: false });
    const packet = (await evaluate(`${API}?.drain?.() ?? null;`))?.result?.value;
    if (!packet || typeof packet.session !== 'string' || packet.session.length > 100) return;
    let target = this.targets.get(targetId);
    if (!target || target.session !== packet.session) {
      target = { session: packet.session, ready: [], pending: new Set() };
      this.targets.set(targetId, target);
      this.log('[BetterCodex:plantuml] 本地 JavaScript 预览已启用（0.10.0）。');
    }
    if (target.ready.length) {
      const results = target.ready.slice(0, 2);
      await evaluate(`${API}?.applyResults?.(${JSON.stringify({ session: target.session, results })});`);
      target.ready.splice(0, results.length);
    }
    for (const d of (Array.isArray(packet.diagnostics) ? packet.diagnostics : []).slice(0, 80)) {
      // 不转发 renderer 任意字段，避免意外把源码/本地路径打印出来。
      if (d.level === 'warn' || this.debug) this.log(`[BetterCodex:plantuml] ${JSON.stringify({ event: String(d.event).slice(0, 64), code: d.code, preCount: d.preCount, plantumlBlocks: d.plantumlBlocks })}`);
    }
    for (const request of (Array.isArray(packet.requests) ? packet.requests : []).slice(0, 2)) {
      if (typeof request?.id !== 'string' || !/^puml-\d+$/.test(request.id) ||
          !Number.isSafeInteger(request.revision) || request.revision < 1 || typeof request.source !== 'string') continue;
      const key = `${request.id}:${request.revision}`;
      if (target.pending.has(key)) continue;
      if (target.pending.size + target.ready.length >= 32) continue;
      target.pending.add(key);
      const finish = result => {
        target.pending.delete(key);
        if (!this.closed && this.targets.get(targetId) === target) {
          target.ready.push({ id: request.id, revision: request.revision, ...result });
        }
      };
      // 不 await 渲染：图片处理不阻塞 sidebar / 自定义颜色 / CDP watcher。
      this.service.render(request.source).then(
        result => finish({ ok: true, svg: result.svg }),
        error => finish({ ok: false, code: error.code || 'RENDER_ERROR',
          message: error.message || '本地渲染失败。', line: error.line || null }),
      );
    }
  }
  retainTargets(ids) {
    for (const id of this.targets.keys()) if (!ids.has(id)) this.targets.delete(id);
  }
  async close() {
    this.closed = true; this.targets.clear(); await this.service.close();
  }
}
