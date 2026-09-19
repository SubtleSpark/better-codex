# BetterCodex

BetterCodex 是一个面向 Codex / ChatGPT Desktop 的本地 UI 增强工具。

当前先解决一个具体问题：项目和会话很多时，通过颜色标记帮助快速定位目标。

> BetterCodex 是非官方项目，与 OpenAI 无关联。

## 当前功能

- 给左侧栏中的项目或会话设置自定义颜色。
- Codex 原有右键菜单完整保留。
- 在原生右键菜单中增加「颜色标记」入口。
- 颜色子菜单提供常用 preset、自定义颜色和清除颜色。
- 颜色配置保存在本地 `localStorage`，不上传远端。
- 不修改官方 `.app` 或 `app.asar`。

高亮样式保持克制：只增加左侧色条，不覆盖 Codex 自己的 selected / hover 背景。

## UI 技术方案

BetterCodex 不自己绘制右键菜单。

当前实现会复用 Codex 自己的 React `ContextMenu` provider 和原生 `electronBridge.showContextMenu`：

1. 右键 sidebar 的 project / conversation row。
2. BetterCodex 从对应 React Fiber 向上找到 `getItems` / `getNativeItems` / `items` provider。
3. 调用 Codex 自己的 provider 获取原始菜单定义。
4. 使用 Codex 当前 React Intl context 解析原有菜单文案。
5. 在原菜单定义中追加 `颜色标记` submenu。
6. 用 Codex 同样的 native menu 结构调用 `electronBridge.showContextMenu`。
7. 用户选择原有菜单项时，继续执行 Codex 原来的 `onSelect` callback。

因此：

- 原有菜单项和功能保留。
- 菜单外观、submenu、快捷键和 native macOS 风格仍由 Codex / Electron 提供。
- BetterCodex 不维护独立 context-menu DOM / CSS。
- 只有 sidebar 左侧颜色条使用少量 CSS。

如果无法定位当前 Codex build 的 menu provider，会自动回退到 Codex 原生右键处理，并在终端输出诊断。

## 环境要求

当前版本：

- macOS
- Node.js 22+
- Codex / ChatGPT Desktop

没有 npm runtime dependencies，也不需要本地 build step。

## 运行

```bash
git clone https://github.com/SubtleSpark/better-codex.git
cd better-codex
./better-codex
```

如果 Codex / ChatGPT Desktop 已经启动，但没有开启 BetterCodex 使用的 CDP port，启动脚本会询问是否重启应用。

退出：

```text
Ctrl+C
```

退出时会清理 BetterCodex 注入的 UI。

## 使用方式

1. 启动 BetterCodex。
2. 在左侧栏找到项目或会话。
3. 正常右键对应项目或会话。
4. 在 Codex 原生菜单中进入 **颜色标记**。
5. 选择 preset color、**自定义颜色…**，或者 **清除颜色**。

Codex 原有右键功能不会被替换。

## 颜色持久化

颜色保存在 renderer 的 `localStorage`：

```text
better-codex:v1:colors
```

BetterCodex 会优先使用 UI 中可获得的稳定标识，例如：

- thread ID
- conversation ID
- project ID
- workspace ID
- link / href

如果当前 UI 没有暴露稳定 ID，则退化为使用标题作为 key。这种情况下，重命名后可能需要重新设置颜色。

## 代码结构

```text
better-codex
scripts/
  start-macos.sh
src/
  injector.mjs
  renderer.js
```

职责：

- `src/injector.mjs`：连接 CDP，识别 renderer，负责注入和重新注入。
- `src/renderer.js`：sidebar detection、颜色持久化、React menu provider 发现以及 native menu augmentation。
- `scripts/start-macos.sh`：启动或重启 Desktop App，并开启 loopback CDP。

这个结构刻意保持简单：项目很小，不引入 bundler、framework 或 UI runtime dependency。

## 开发

检查语法：

```bash
npm run check
```

需要排查 Codex 新版本兼容问题时，可以开启 debug 日志：

```bash
BETTER_CODEX_DEBUG=1 ./better-codex
```

实现原理和踩坑记录见 [docs/TECHNICAL-NOTES.md](docs/TECHNICAL-NOTES.md)。

## 配置

默认 CDP port：

```text
9347
```

自定义 port：

```bash
BETTER_CODEX_PORT=9450 ./better-codex
```

如果 Desktop App 安装在其他位置：

```bash
BETTER_CODEX_APP="/path/to/ChatGPT.app" ./better-codex
```

## Security

CDP 只绑定到：

```text
127.0.0.1
```

但 CDP 本身没有 authentication。同一台机器上的其他本地进程理论上仍可能连接该 port。

停止 BetterCodex 只能移除注入 UI，不能修改已经运行中的 Desktop App 启动参数。需要完全关闭 CDP 时，请完全退出 Codex / ChatGPT Desktop，再正常重新启动。

## 当前限制

- 依赖 Codex / ChatGPT Desktop 的现有 DOM，并不是官方 Extension API。
- Desktop App 更新后，sidebar detection heuristic 可能需要调整。
- BetterCodex 会依赖 Codex 当前 React Fiber / ContextMenu provider 结构；Desktop App 更新后可能需要重新适配。
- 当前只支持 macOS。

## License

MIT