# PlantUML 未显示：只读现场诊断

`block-scan` 只能说明已知选择器命中了多少节点，不能证明文件 Preview 使用了同一 DOM 结构。这个命令采集实际页面结构，不修改选择器、不触发渲染、不清空运行中的请求/日志队列。

## 使用

保持 `./better-codex` 在原终端运行，在 Codex 中打开有问题的 **Markdown 渲染预览**，然后在另一个终端、仓库目录执行：

```bash
npm run diagnose:plantuml 2>&1 | tee /tmp/better-codex-plantuml-diagnose.log
```

不需要重新安装 dependencies，不需要重启 Codex。非默认 CDP port：

```bash
npm run diagnose:plantuml -- --port 9450
```

也可以使用已有 `BETTER_CODEX_PORT` 环境变量。命令只连接 `127.0.0.1`；不接受远程 host。出现 `CDP_UNAVAILABLE` 时，先确认原 BetterCodex 正在运行，并使用相同端口。

## 报告内容

- `start.expectedModuleVersion`：当前 checkout 的 PlantUML 模块版本。与 `dom.report.module.version` 对照，区分更新了文件但仍运行旧进程的情况。
- `target`：主窗口、独立窗口、其他 App 页面；`injectorEligible` 表示当前 injector 是否会选中该 target。不会打印窗口标题、原始 URL 或 query。
- `contexts` / `dom.frameDepth`：同源 App iframe 的默认执行上下文。第三方页面跳过；不扩大运行时注入范围。
- `scanRoot`：运行中 root selector 是否配置、是否有效、命中几个节点；不打印 selector 原值。
- `counts`：`pre`、`code`、Codex semantic shell、iframe、webview 和 open Shadow root 数量。
- `labels`：明确的 PlantUML 标签位置、祖先和相邻节点的结构，以及是否在编辑器/已知排除区域或扫描区域内。
- `labels[].token`：标签的 Unicode code points；可区分 ASCII `-`、外观相似的横线与零宽字符。仅诊断，不自动改 Markdown 或接受新语言。
- `panels`：BetterCodex 预览面板、图片是否已解码、重试入口是否可见。不返回图内容。

报告只输出固定枚举、版本、计数和 DOM 结构；不返回源码、SVG、文件名、路径、任意 CSS class/ID 或属性值。仍建议发送前自行检查日志。

一次最多检查 8 个本地 App target，每个 target 最多 16 个默认 context，每个 document 最多 25,000 个元素 / 8 个 open Shadow root / 8 处标签。`truncated` 为 true 表示报告不完整。closed Shadow DOM 无法通过本脚本读取；非 App 的 iframe/webview 只报告跳过，不读取内容。限时失败会打印状态码，不能把它解释为页面里没有 PlantUML。

## 如何判断

没有安装模块、安装版本与 checkout 不一致、标签在独立窗口/iframe、标签落在内部 toolbar 而非已知语言属性、root selector 未命中、图片未加载，是不同问题。只有结合现场报告才能确定改哪一层；不要再通过替换 `~~~` / 三个反引号或扩大 DOM 选择器盲试。

本次只增加诊断工具与测试，不修改现有 PlantUML / Sidebar 运行时代码，也不声称已修复用户 App 中的渲染问题。
