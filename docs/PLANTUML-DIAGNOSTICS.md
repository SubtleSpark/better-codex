# PlantUML Preview 现场诊断

诊断器与运行中的渲染器独立。不修改页面、文档、CSP 或渲染逻辑，不清空已有请求队列，不执行 PlantUML 引擎。

## 使用（reportVersion 2）

保持 BetterCodex 运行，让 Codex 停在出问题的 **Markdown 渲染预览**。另开终端，在仓库目录执行：

```bash
npm run diagnose:plantuml -- --include-guests 2>&1 | tee /tmp/better-codex-plantuml-diagnose.log
```

不需要重新安装 dependencies 或重启 Codex。使用非默认 CDP port 时追加 `--port 9450`。

不加 `--include-guests` 时，仍然只检查本地 `app://-` 文档。加上该参数后，先从 App 文档及 open Shadow Root 读取 iframe/WebView 的 src（或 WebView 的只读 getURL），再与 CDP target URL 做精确关联；只对关联到的 guest 顶层文档采集结构。不会读取无关联的其它 target、guest 的外部子页面；空白 URL、重复 URL 不作为可靠关联。不会向 guest 安装渲染模块，也不会把其它 target 的 URL 列表传入 guest。

## 本轮已知信息

用户 reportVersion 1 日志：主窗口中 PlantUML 0.10.1 已安装，1 个 pre / 1 个 code，无 semantic shell、无已识别语言标签、无预览面板；同时存在 2 个 WebView、2 个 iframe、4 个 open Shadow Root，3 个非 App target 被跳过。

这不证明 SVG 引擎失败，也不能直接证明 Markdown 一定在 WebView。旧诊断器已经遍历 open Shadow Root，但遗漏了未识别的代码块形状、CSS generated content，且没有关联 guest 文档。本次只补足现场证据，不做猜测性渲染修复。

## 如何看结果

- `start.reportVersion = 2`：新版诊断器。
- `target.type / scheme`：固定分类；不输出 URL、host、path、query、标题。
- `codeCandidates`：即使 `labels=[]`，仍记录最多 8 个代码块的标签、祖先/相邻节点形状，以及是否含起止指令的布尔值。无源码正文。
- `before / after`：CSS 伪元素是否存在；只有确认为四个 PlantUML alias 的 content 才记录语言 token。
- `languageEvidence`：识别其它语言属性；未知属性名用固定类别代替，不输出原值。
- `embeds.matchingTargets`：App iframe/WebView 对应的 target 序号。
- `linked-guest`：显式开启 guest 诊断后实际检查的 guest。
- `panels`：已有图片的加载/解码状态；仅返回布尔值。
- `truncated=true`：达到数量上限，不把缺失结果当作不存在。

请上传日志文件；不需要截图 DOM，也不要粘贴完整 HTML 或源码。结果只包含固定枚举、结构和数量，不输出文件名、图源码、SVG、CSS class/ID 原值或完整 URL。

## 验证边界

新增 5 个测试覆盖真实 Chromium 的 CSS 标签/代码结构、open Shadow Root、URL 关联与隐私过滤，以及 CDP guest 过滤、导航变化和 CLI 的两阶段只读流程。原有诊断测试保留。

自动测试只能验证诊断器行为；用户实际 App 的 Preview 位于何处，仍以本机 v2 日志为准。
