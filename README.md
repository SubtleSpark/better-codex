# BetterCodex

BetterCodex 是一个面向 Codex / ChatGPT Desktop 的本地 UI 增强工具。

提供 Sidebar 颜色标记与层级缩进，以及 Markdown 中 PlantUML 的本地 JavaScript 预览。

> BetterCodex 是非官方项目，与 OpenAI 无关联。

## 当前功能

- 给左侧栏中的项目或会话设置自定义颜色。
- Codex 原有右键菜单完整保留。
- 在原生右键菜单中增加「颜色」入口。
- 7 个 preset 以彩色圆点显示，不显示颜色名称。
- 提供自定义颜色和清除颜色。
- 颜色配置保存在本地 `localStorage`，不上传远端。
- 不修改官方 `.app` 或 `app.asar`。
- 项目下的会话缩进一级。
- `plantuml` / `puml` 代码块本地渲染为 SVG，支持源码切换、放大、失败回退。

高亮样式保持克制：整行使用对应颜色的轻量透明背景，并保留左侧色条；文字颜色不变。

## UI 技术方案

BetterCodex 不自己绘制右键菜单。

当前实现会复用 Codex 自己的 React `ContextMenu` provider 和原生 `electronBridge.showContextMenu`：

1. 右键 sidebar 的 project / conversation row。
2. BetterCodex 从对应 React Fiber 向上找到 `getItems` / `items` provider。
3. 调用 Codex 自己的 provider 获取原始菜单定义。
4. 使用 Codex 当前 React Intl context 解析原有菜单文案。
5. 在原菜单定义中追加 `颜色` submenu。
6. 用 Codex 同样的 native menu 结构调用 `electronBridge.showContextMenu`。
7. 用户选择原有菜单项时，继续执行 Codex 原来的 `onSelect` callback。

因此：

- 原有菜单项和功能保留。
- 菜单外观、submenu、快捷键和 native macOS 风格仍由 Codex / Electron 提供。
- BetterCodex 不维护独立 context-menu DOM / CSS。
- Sidebar 颜色背景、色条和层级缩进使用少量 CSS。

如果无法定位当前 Codex build 的 menu provider，会自动回退到 Codex 原生右键处理，并在终端输出诊断。

## 环境要求

当前版本：

- macOS
- Node.js 22+
- Codex / ChatGPT Desktop

不需要本地 build step。PlantUML 使用已锁定版本的 JavaScript 引擎与 Viz.js，首次需要安装 npm dependencies；不需要 Java 或远程渲染服务。

## 运行

```bash
git clone https://github.com/SubtleSpark/better-codex.git
cd better-codex
npm ci --ignore-scripts
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
4. 在 Codex 原生菜单中进入 **颜色**。
5. 在原生子菜单中选择颜色圆点；末尾还提供自定义颜色和清除。

Codex 原有右键功能不会被替换。

## PlantUML 预览

启动后，在 Codex 中打开 [docs/PLANTUML-DEMO.md](docs/PLANTUML-DEMO.md)，切换到 **Rendered Markdown Preview**。已识别的 PlantUML 代码块会显示图片；图片加载成功后才隐藏源码，仍可随时切回。渲染只在本机 Node Worker 内完成。

首版只支持自包含图，不支持 `!include`、预处理宏、`!theme`、外部图片和独立 `.puml` 文件预览。默认处理带明确语言标记的只读代码块，聊天中的同类代码块也可能命中；可以用环境变量限定 Preview root。详见 [实现与限制](docs/PLANTUML.md)。

```bash
# 禁用此功能，保留已有 Sidebar 功能
BETTER_CODEX_PLANTUML=0 ./better-codex
```

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
  plantuml/
    bridge.mjs
    renderer.js
    service.mjs
    worker.mjs
    policy.mjs
```

职责：

- `src/injector.mjs`：连接 renderer CDP，识别 renderer，负责注入和重新注入；自定义颜色需要打开系统 picker 时，也通过这里补一次 `userGesture`。
- `src/renderer.js`：sidebar detection、颜色持久化、React menu provider 发现、swatch icon 生成以及 native menu augmentation。
- `scripts/start-macos.sh`：启动或重启 Desktop App，并开启 loopback renderer CDP。

PlantUML 模块独立于原 Sidebar renderer：通过现有 CDP 交换任务和结果，不新增端口或修改 Electron main process。不引入 bundler 或 UI framework。

## 开发

检查语法：

```bash
npm run check
npm run test:layout
npm run test:plantuml
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

CDP 本身没有 authentication。同一台机器上的其他本地进程理论上仍可能连接该 port。

停止 BetterCodex 会移除 renderer 注入，但启动参数仍然存在。需要完全关闭 CDP 时，请完全退出 Codex / ChatGPT Desktop，再正常重新启动。

## 当前限制

- 依赖 Codex / ChatGPT Desktop 的现有 DOM，并不是官方 Extension API。
- Desktop App 更新后，sidebar detection heuristic 可能需要调整。
- BetterCodex 会依赖 Codex 当前 React Fiber / ContextMenu provider 结构；Desktop App 更新后可能需要重新适配。
- 当前只支持 macOS。

## License

MIT