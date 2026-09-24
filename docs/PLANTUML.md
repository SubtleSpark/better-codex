# 本地 JavaScript PlantUML 预览（MVP）

## 使用

```bash
npm ci --ignore-scripts
./better-codex
```

然后在 Codex 中打开 `docs/PLANTUML-DEMO.md`，切换到 Markdown 的渲染预览。`plantuml` / `puml` fenced code block 旁会生成图片；图片加载成功后才隐藏源码。工具栏提供「源码 / 预览」「放大」「重试」。关闭 BetterCodex 时恢复原代码块，Markdown 文件不会被修改。

首次安装 npm dependencies 需要联网；渲染不调用远程服务，不需要 Java、Graphviz binary、MCP server 或额外端口。原有颜色标记、缩进、原生右键菜单和系统 Color Picker 的逻辑不变。

```bash
# 完全禁用 PlantUML，只运行原有功能
BETTER_CODEX_PLANTUML=0 ./better-codex

# 诊断：只记录数量/状态码，不打印源码、图内容或路径
BETTER_CODEX_DEBUG=1 ./better-codex

# 可选：限制扫描区域。填写本机已确认的 Markdown Preview root CSS selector。
BETTER_CODEX_PLANTUML_ROOT='#your-confirmed-preview-root' ./better-codex
```

PlantUML 需要 injector 的 `--watch` 模式；`./better-codex` 已默认开启。启动日志显示工具版本 0.10.0，原 sidebar renderer 的内部版本可以仍为 0.9.4，这是独立模块，不是未更新。

## 架构

```text
Codex 已渲染的只读 Markdown 代码块
  → plantuml/renderer.js：识别语言、读取文本、提交有版本号的任务
  → 现有 loopback CDP
  → plantuml/bridge.mjs：非阻塞收发，按 target / session 隔离
  → plantuml/service.mjs：串行队列、去重、内存 LRU、超时
  → Node Worker：官方 TeaVM headless engine + Viz.js / WASM
  → SVG 经 CDP 返回
  → 元素/属性白名单重建 SVG → Blob URL → <img>
```

Node 才执行引擎；不把 WASM 注入 Codex，不改 CSP、Electron main process 或 app.asar。`@plantuml/mcp-js` 只使用其 `engine.js` 子路径，**不 import server.js，不启动 MCP**。这个子路径不是稳定 library API，因此固定 package 和 Viz 版本，并用真实引擎回归测试检查升级。

文件职责：

- `src/plantuml/policy.mjs`：输入边界。
- `src/plantuml/worker.mjs`：初始化、实际渲染；抑制引擎日志。
- `src/plantuml/service.mjs`：调度及生命周期。
- `src/plantuml/bridge.mjs`：对接现有 CDP polling，不等待耗时渲染。
- `src/plantuml/renderer.js`：独立 DOM 增强；不重排 React 子树。

## 识别与更新

同时识别标准 `pre > code` 和 Codex 的 `[data-markdown-copy="code-block"]` 外壳（后者可以完全没有 `pre`）；只接受 `plantuml` / `puml`：`code/pre` 的 `language-*` / `lang-*` class、`data-language` / `data-lang`，以及代码块自身 toolbar 中明确的语言名。Codex 外壳保留原生 Copy / 换行 toolbar，只隐藏代码视口。**不会因为普通代码中包含 `@startuml` 就自动渲染。** 编辑器、contenteditable 和可识别的 Diff 区域排除。

默认扫描只读代码块，不假定 Codex 有公开 Markdown Extension API；聊天中的同形只读代码块也可能命中。需要只作用于某个文件 Preview 时，使用上述 root selector 限定。未知 DOM 结构不猜测、不替换；debug 中 `preCount > 0` 但 `plantumlBlocks = 0` 时优先检查语言标记适配。

通过 `textContent` 保留转义字符；对无换行的 Shiki `.line` 子节点补换行，并排除行号装饰。只插入自有 sibling，不移动/删除原 code block，不改其 Copy handler。MutationObserver 忽略自有 UI；内容变化使用新 revision，reload 使用新 session，旧异步结果不能覆盖新文件。卸载时移除 UI、还原源码、释放 Blob URL 和 worker。

## MVP 限制与安全

- 每块一张 `@startuml` 图；省略起止标签时自动包装。暂不支持 `.puml` 独立文件 viewer。
- 暂禁用所有 `!` 预处理指令（包括 include / theme / 宏）、`%` 函数和 `<img>`。这会保守地拒绝部分无害语法，目的是首版只处理自包含图，不能读取工作区文件或环境变量。
- 不提供远程 fallback；失败只显示原因、重试入口和原始源码。
- Worker 中禁用浏览器式网络 API，使用空环境变量；输出不写终端/磁盘。Worker 是性能隔离，不是 OS 安全 sandbox；不要把它当成任意不可信代码执行环境。
- 单图源码上限 64 KiB、SVG 2 MiB、15 秒超时、1 个 worker、最多 32 个排队/执行任务。超时终止 worker，下一次任务重新启动。V8 heap 限额 256 MiB 不包括 WASM/ArrayBuffer 内存，不能声称完整内存限制。
- 内存缓存最多 32 张 / 16 MiB；不落盘。key 包含引擎包版本和规范化源码。首次图按需加载引擎。
- SVG 不使用原始 `innerHTML`；只保留绘图元素、文字和白名单属性，去掉脚本、事件、foreignObject、外部图片和可点击链接，再以 `<img>` 展示。宿主不允许 `blob:` 图片时保留源码，不去放宽 CSP。
- 图片浅色底保持黑色文字可读；不自动修改图源码的主题。JavaScript 字体度量与 Java 版不保证完全一致。

## 验证边界

```bash
npm run check
npm run test:layout
npm run test:plantuml
```

测试覆盖输入限制、去重/缓存/队列、worker 崩溃/超时恢复、真实引擎（时序/中文/类/组件/活动/状态图）、真实 Chromium DOM、SVG 清理、图片加载失败回退，以及完整 DOM → CDP → Worker → SVG 图片链路。Chrome/Chromium 路径可通过 `BETTER_CODEX_TEST_BROWSER` 指定。

浏览器 fixture 和真实引擎测试不等于在 macOS Codex 中完成端到端验收；当前用户 build 的 Preview 语言标记与 Blob CSP 仍需首次本机确认。

## 参考与依赖

实现参考官方 headless 初始化方式，不复制或启动它的 MCP server：

- https://github.com/plantuml/plantuml/blob/master/plantuml-mcp-js/server.js
- https://github.com/plantuml/plantuml/blob/master/plantuml-mcp-js/README.md
- https://github.com/joethei/obsidian-plantuml/tree/1.8.0/src/processors

`@plantuml/mcp-js@0.2.0` 和 `@viz-js/viz@3.28.0` 是固定直接依赖，完整依赖树由 `package-lock.json` 锁定。这个发布包实测内置 PlantUML `1.2026.7beta3 / 819db0b`，不等于最新 Java JAR；六类基础图的测试已跑过，但不是完整语法兼容承诺。npm 安装包保留其 LICENSE；BetterCodex 的 MIT license 不替代第三方依赖及其附带引擎的许可声明。

DOM adapter 的参考是社区恢复的 CodeSnippet 实现，不视为官方稳定 API：

- https://github.com/JimLiu/decode-codex/blob/6fd43d66ccad32c9c1ab83b9704e0bbbbf2d4c7b/restored/ui/code-snippet/index.tsx

该结构已加入真实浏览器 + 真实引擎的集成测试，用户当前 Codex build 仍需首次确认。
