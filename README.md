# BetterCodex

BetterCodex 是一个面向 Codex / ChatGPT Desktop 的本地 UI 增强工具。

当前 MVP 先解决一个很具体的问题：当项目和会话很多时，通过颜色高亮帮助快速定位目标项目或会话。

> BetterCodex 是非官方项目，与 OpenAI 无关联。

## 当前功能

- 给左侧栏中的项目或会话设置自定义颜色。
- 右键项目或会话即可打开颜色选择器。
- 使用系统原生 color picker，不限制固定色板。
- 颜色配置保存在本地，不上传远端。
- 不修改官方 `.app` 或 `app.asar`。
- 运行时没有额外 npm dependencies。

当前高亮样式为：左侧窄色条 + 很浅的同色背景。

## 实现方式

BetterCodex 通过 Chrome DevTools Protocol（CDP）连接 Codex / ChatGPT Desktop 的 renderer，然后在运行时注入少量 DOM / CSS 增强代码。

整体流程：

```text
启动 ChatGPT / Codex Desktop
        ↓
开启仅监听 127.0.0.1 的 CDP port
        ↓
BetterCodex injector 连接 renderer
        ↓
注入 sidebar enhancer
        ↓
识别 project / conversation
        ↓
读取并应用本地颜色配置
```

BetterCodex 不会修改官方应用安装包。

## 环境要求

当前 MVP：

- macOS
- Node.js 22+
- Codex / ChatGPT Desktop

## 运行

```bash
git clone https://github.com/SubtleSpark/better-codex.git
cd better-codex
./better-codex
```

如果 Codex / ChatGPT Desktop 已经启动，但没有开启 BetterCodex 使用的 CDP port，启动脚本会询问是否重启应用。

BetterCodex 运行期间需要保持终端进程存在。

退出：

```text
Ctrl+C
```

退出时会尝试清理已注入的 UI。

也可以通过 npm script 启动：

```bash
npm run start
```

当前没有 npm dependencies，因此不需要执行 `npm install`。

## 使用方式

1. 启动 BetterCodex。
2. 在左侧栏中找到项目或会话。
3. 右键对应项目或会话。
4. 选择颜色。
5. 点击 **Apply** 保存。
6. 点击 **Clear** 可以移除颜色。

拖动 color picker 时，高亮会实时更新。

## 颜色持久化

颜色配置保存在 renderer 的 `localStorage`：

```text
better-codex:v1:colors
```

BetterCodex 会优先使用 UI 中可获得的稳定标识，例如：

- thread ID
- conversation ID
- project ID
- workspace ID
- link / href

如果当前 UI 没有暴露稳定 ID，则 MVP 会退化为使用可见标题作为 key。

这种情况下，如果项目或会话被重命名，原来的颜色关联可能失效。

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

## 开发

运行语法检查：

```bash
npm run check
```

主要文件：

```text
better-codex
scripts/start-macos.sh
src/injector.mjs
src/renderer.js
```

职责：

- `better-codex`：本地启动入口。
- `scripts/start-macos.sh`：启动或重启 Desktop App，并开启 loopback CDP。
- `src/injector.mjs`：发现 renderer target，负责注入和重新注入。
- `src/renderer.js`：负责 sidebar 识别、颜色选择、持久化和样式。

renderer 注入逻辑是 idempotent 的。injector 会持续检查 renderer，在页面 reload 或 renderer 重建后重新注入。

## Security

CDP 只绑定到：

```text
127.0.0.1
```

但 CDP 本身没有 authentication。

因此，在 Desktop App 以 remote debugging 模式运行期间，同一台机器上的其他本地进程理论上也可能连接该 CDP port。

停止 BetterCodex 只能移除 BetterCodex 注入的 UI，不能修改已经运行中的 Desktop App 启动参数。

如果需要完全关闭 CDP，请：

1. 完全退出 Codex / ChatGPT Desktop。
2. 不通过 BetterCodex，正常重新启动应用。

## MVP 限制

- 当前依赖 Codex / ChatGPT Desktop 的现有 DOM 结构，并不是官方 Extension API。
- Desktop App 更新后，sidebar selector / heuristic 可能需要调整。
- 当前主要识别左侧区域中的 clickable rows。
- 如果未来 project header 变成不可点击元素，需要增加专门的 selector。
- 暂时没有 sync、export、import 功能。
- 当前只支持 macOS。

## License

MIT
