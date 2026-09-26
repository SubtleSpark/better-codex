# PlantUML 同步定位（日志没有代码块时）

v3 现场报告已读到关联 WebView，但所有已读范围 pre/code/语言标签均为空。这只能说明采样范围内没找到目标，不足以认定引擎失败或预览必在 WebView。一个 guest 的 report.truncated 为 true，旧 done.incomplete 却为 false；旧汇总没有传播 DOM 内部截断。

本命令只补定位证据，不修改 renderer、Markdown、菜单、引擎或 CSP，不宣称渲染已经修好。

## 一次采集

保持已有 BetterCodex 运行，在另一个终端的仓库目录执行：

```bash
node scripts/locate-plantuml.mjs --delay 8 --include-guests --screenshot 2>&1 | tee /tmp/better-codex-plantuml-location.log
```

看到 prepare 后，在 8 秒内切回 Codex，打开有问题的 **Markdown 渲染预览**，让 plantuml-svg 标签和源码显示在屏幕内，保持不切换页面直到采集结束。可以选中 plantuml-svg 这几个字作为额外定位证据（不输出选中的其它文字）。

无需安装依赖或重启 App。`--port 9450` 可指定已有的 CDP port。`--delay` 允许 0–60 秒。

## 输出与隐私

- `[BetterCodex:plantuml-locate]`：协议树中的 pre/code 数、open/closed Shadow Root 数、有限的语言 token 和起止指令布尔值；输出标签层级，不输出源码、业务 URL、文件名或属性原值。
- `runtimeDomTruncated` 保留旧 JS 探针的截断状态；新汇总将任一子报告截断传播为 incomplete，不再把不完整报告当作完整检查。
- 协议探针通过 `DOM.getDocument(pierce:false)` 读取当前顶层 light DOM，再通过 `DOM.describeNode` 单独读取最多 64 个 open/closed Shadow Root。不会展开 iframe contentDocument 或 UA 控件树。协议中收到的 DOM 文本只在本机内存处理，不写日志。
- 只允许 App 页面和显式开启后、与 App embed URL 唯一关联的 guest；沿用 v3 的 fragment 匹配并在协议读取前后复核顶层 URL。遇到页面切换，丢弃结果。
- `--screenshot` 是显式选项：只截 injector 可选的主 App viewport，不截外部 WebView，不自动上传。文件写入新建的系统临时目录，PNG 权限为 0600，具体目录见末尾 screenshotDirectory。**截图可能包含正文或其它敏感内容，检查/打码后再分享。** 不希望保存图片时去掉该选项；也可手动截同一时刻的 Codex 页面。
- 截图不支持时报告 SCREENSHOT_UNAVAILABLE，仍保留结构结果。
- 提交日志和相关 app-N.png 后，可核对 CDP 实际读到的页面是否与用户看到的预览相同；不能仅凭 focused:false 推断用户操作错误（终端可能抢走焦点）。

## 验证

新增真实 Chromium closed/open Shadow DOM 测试、超过旧 8 root 上限的测试、非标准 div 源码定位、child document 不展开、截断汇总；CLI 测试验证显式截图、App/关联 guest 边界、参数和输出脱敏。它们验证诊断行为，不是用户实际 Codex 中的修复验收。

协议参考：https://chromedevtools.github.io/devtools-protocol/tot/DOM/
