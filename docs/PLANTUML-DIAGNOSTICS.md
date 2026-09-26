# PlantUML Preview 现场诊断

诊断器与运行中的渲染器独立。不修改页面、文档、CSP 或渲染逻辑，不清空已有请求队列，不执行 PlantUML 引擎。

## 使用（reportVersion 3）

保持 BetterCodex 运行，让 Codex 停在出问题的 **Markdown 渲染预览**。另开终端，在仓库目录执行：

```bash
npm run diagnose:plantuml -- --include-guests 2>&1 | tee /tmp/better-codex-plantuml-diagnose.log
```

不需要重新安装 dependencies 或重启 Codex。使用非默认 CDP port 时追加 `--port 9450`。

不加 `--include-guests` 时，仍然只检查本地 `app://-` 文档。加上该参数后，先从 App 文档及 open Shadow Root 读取 iframe/WebView 的 src（或 WebView 的只读 getURL），再与 CDP target URL 做精确关联；只对关联到的 guest 顶层文档采集结构。不会读取无关联的其它 target、guest 的外部子页面；空白 URL、重复 URL 不作为可靠关联。不会向 guest 安装渲染模块，也不会把其它 target 的 URL 列表传入 guest。

## 已知信息与诊断修复

现场日志确认主窗口中 PlantUML 0.10.1 已安装，但没有识别到图。reportVersion 2 关联了两个 WebView，却都返回 `NO_ALLOWED_DEFAULT_CONTEXT`；所以不能据此断言图不在 WebView，更不能证明 SVG 引擎失败。

检查诊断器发现两个问题：

1. CDP 的 `Page.Frame.url` 不包含 `#fragment`，该部分由 `urlFragment` 单独返回；v2 直接把 `frame.url` 与 target 完整 URL 比较，导致带 fragment 的页面被误拒绝。v3 重组后比较，仍保留 host/path/query/hash 检查。如果 CDP 省略 fragment 字段，则只进入当前 `location.href` 复核；复核失败不读取 DOM。所有 guest 在读取时均再次检查当前 URL，防止中途导航。
2. `probe-failed` 原本未计入汇总的 `failures`。v3 单独统计连接尝试、成功目标、实际读到的文档；未读取或 probe 失败会标记 `incomplete` 并以非零状态退出。

这次修复的是诊断器；用户当前 Markdown 的真正渲染入口尚未确认，不声称渲染问题已解决。

协议依据：https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-Frame

## 如何看结果

- `start.reportVersion = 3`：新版诊断器；PlantUML 渲染模块仍为 0.10.1。
- `target.type / scheme`：固定分类；不输出 URL、host、path、query、标题。
- `codeCandidates`：即使 `labels=[]`，仍记录最多 8 个代码块的标签、祖先/相邻节点形状，以及是否含起止指令的布尔值。无源码正文。
- `before / after`：CSS 伪元素是否存在；只有确认为四个 PlantUML alias 的 content 才记录语言 token。
- `languageEvidence`：识别其它语言属性；未知属性名用固定类别代替，不输出原值。
- `embeds.matchingTargets`：App iframe/WebView 对应的 target 序号。
- `linked-guest`：开始检查已关联 guest，不等于已读取 DOM。
- `guest-frame-check`：`exact` / `fragment-reconstructed` / `location-check-required` 可继续复核；`document-mismatch` / `fragment-mismatch` 拒绝读取，只报告枚举和布尔值。
- `dom`：实际读到该文档的结构；`probe-failed` 是读取未完成，不是“没有 PlantUML”。
- `panels`：已有图片的加载/解码状态；仅返回布尔值。
- `done.inspected` 为目标尝试数，`successfulTargets` 为读到至少一份报告的目标数，`documentsRead` 为实际报告数，`failures` 为失败目标数。
- `incomplete=true` 或 `truncated=true`：报告不完整，不把缺失结果当作不存在。

请上传日志文件；不需要截图 DOM，也不要粘贴完整 HTML 或源码。结果只包含固定枚举、结构和数量，不输出文件名、图源码、SVG、CSS class/ID 原值或完整 URL。

## 验证边界

保留 v1/v2 的 10 个诊断测试。新增 4 个回归测试覆盖 fragment 重组、真实 Chromium 协议返回值、读取前 URL 复核、guest 子页面隔离以及 CLI 不完整汇总。

自动测试只能验证诊断器行为；用户实际 App 的 Preview 位于何处，仍需本机日志确认。
