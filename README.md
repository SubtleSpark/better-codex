# BetterCodex

BetterCodex 是一个面向 Codex / ChatGPT Desktop 的本地 UI 增强工具。

当前先解决一个具体问题：项目和会话很多时，通过颜色标记帮助快速定位目标。

> BetterCodex 是非官方项目，与 OpenAI 无关联。

## 当前功能

- 给左侧栏中的项目或会话设置自定义颜色。
- 右键项目或会话打开颜色面板。
- 支持任意颜色，同时提供常用颜色 swatches。
- 颜色配置保存在本地 `localStorage`，不上传远端。
- 不修改官方 `.app` 或 `app.asar`。

高亮本身保持克制：左侧色条 + 很浅的渐变，不覆盖 Codex 自己的 selected / hover 样式。

## UI 技术方案

BetterCodex 的目标不是复制一套 Codex UI，而是尽量减少自己维护 UI component 的成本。

当前 UI 使用：

- [Web Awesome](https://webawesome.com/) `3.13.0`
- Shadow DOM
- esbuild `0.28.2`

Web Awesome 只负责 BetterCodex 自己创建的交互 UI，例如 `Color Picker`、`Button`、`Popover`。

Codex 原有 DOM 不会被替换。BetterCodex 对原页面只做两类最小修改：

1. 识别 sidebar 中的 project / conversation。
2. 给命中的元素增加 class 和 CSS variable，用于颜色标记。

BetterCodex 自己的浮层 UI 全部放在独立 Shadow DOM 中，避免双方 CSS 相互污染。

```text
Codex Desktop
    │
    ├── 原 sidebar DOM
    │      └── BetterCodex 只增加 class / CSS variable
    │
    └── BetterCodex Shadow DOM
           └── Web Awesome
                ├── wa-popover
                ├── wa-color-picker
                └── wa-button
```

Web Awesome 的 dependency 固定在 `package.json` 中，不使用 runtime CDN。

## 环境要求

当前版本：

- macOS
- Node.js 22+
- npm
- Codex / ChatGPT Desktop

## 运行

```bash
git clone https://github.com/SubtleSpark/better-codex.git
cd better-codex
./better-codex
```

第一次执行时，BetterCodex 会自动安装 UI dependencies 并生成本地 renderer bundle。后续启动仍然使用同一个命令。

如果 Codex / ChatGPT Desktop 已经启动，但没有开启 BetterCodex 使用的 CDP port，启动脚本会询问是否重启应用。

退出：

```text
Ctrl+C
```

退出时会清理 BetterCodex 注入的 UI。

## 使用方式

1. 启动 BetterCodex。
2. 在左侧栏找到项目或会话。
3. 右键对应项目或会话。
4. 使用 Color Picker 选择颜色。
5. 点击 **完成** 关闭浮层，或点击 **清除** 删除颜色标记。

颜色变化会实时应用。

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

## 构建结构

```text
better-codex
scripts/
  build.mjs
  start-macos.sh
src/
  injector.mjs
  vendor.js
  renderer/
    index.js
    sidebar.js
    store.js
    ui.js
dist/                 # 本地生成，不提交 Git
```

职责：

- `src/injector.mjs`：连接 CDP，识别 renderer，负责注入和重注入。
- `src/vendor.js`：集中声明 Web Awesome components。
- `src/renderer/sidebar.js`：只负责 sidebar 识别和颜色标记。
- `src/renderer/store.js`：只负责颜色配置持久化。
- `src/renderer/ui.js`：只负责 BetterCodex Shadow DOM / Web Awesome UI。
- `scripts/build.mjs`：将 vendor 和 renderer 分开打包。

vendor 与 renderer 分开是刻意设计：Web Components 注册在全局 `customElements` registry 中，不能重复注册。injector 会先检查 Web Awesome components 是否已经存在，只在首次需要时加载 vendor bundle；renderer bundle 可以独立重新注入。

## 开发

安装 dependency：

```bash
npm install
```

检查语法：

```bash
npm run check
```

构建：

```bash
npm run build
```

生成文件位于 `dist/`。

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
- Web Awesome custom elements 使用浏览器全局 registry；如果未来 Codex 自身引入同名但不完整的 Web Components，BetterCodex 会明确报 conflict，而不是继续不确定地注入。
- 当前只支持 macOS。

## License

MIT
