# Sidebar 层级缩进

项目标题保持原位置；项目下的会话列表向内缩进一级（20px）。背景、左侧色条、文字和「展开显示」一起内收，右边界和行高保持不变。无颜色会话同样缩进，项目外的会话不变。不会继承或改写项目、会话各自的颜色。

## 实现范围

在 `src/renderer.js` 原有 style 中为 `[data-app-action-sidebar-project-list-id]` 设置 `padding-inline-start: 20px` 和 `box-sizing: border-box`。不改 DOM 结构、不逐行累加 margin，也不改变 React menu provider、自定义选色器或 localStorage key。销毁原有 style 时自动还原布局。

这里依赖 Codex 的项目会话列表属性；未知结构不做位置猜测。若更新后缩进失效，先检查这个属性，不要给所有 thread row 无差别添加缩进。图中的时间、计数、连接线和新图标不属于本次改动。

## 回归检查

```bash
npm run check
npm run test:layout
```

布局测试需要本机 Chrome / Chromium；可用 `BETTER_CODEX_TEST_BROWSER` 指定可执行文件路径，无需 npm dependency。测试使用临时浏览器 profile 和 HTML fixture，不连接真实 Codex、不访问用户会话。

`tests/sidebar-hierarchy.html` 加载实际 renderer，验证 34 个布局断言：20px 缩进、右边界、行高、独立会话、不继承颜色、选中背景、动态增加与移动、重复注入、窄侧栏以及退出还原。CI 运行该 fixture；这不是 macOS Codex 的端到端验证，首次仍需在真实 App 看一次。
