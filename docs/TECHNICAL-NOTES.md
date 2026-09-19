# BetterCodex 技术记录

这份文档记录当前可用的实现方案和主要踩坑，方便 Codex Desktop 更新后快速定位问题。

## 最终方案

目标：给 sidebar 中的 project / conversation 增加颜色标记，同时完整保留 Codex 原有右键菜单和 macOS native menu 样式。

当前链路：

```text
右键 sidebar row
    ↓
BetterCodex capture-phase contextmenu
    ↓
从 row 的 React Fiber 向上找 ContextMenu provider
    ↓
读取 getItems() / items
    ↓
执行 Codex 的 onBeforeOpen（如果存在）
    ↓
使用 React Intl context 解析原菜单文案
    ↓
插入「颜色标记」submenu
    ↓
转换成 native menu item
    ↓
electronBridge.showContextMenu(...)
    ↓
macOS native menu
    ↓
根据返回的 item id 执行原始 onSelect
```

BetterCodex 不自己绘制 context menu。除了 sidebar 左侧色条之外，菜单 UI、submenu、hover、圆角、快捷键等都由 Codex / Electron / macOS 提供。

## 关键实现点

### Sidebar row

当前主要依赖：

```text
[data-app-action-sidebar-thread-row]
[data-app-action-sidebar-project-row]
```

颜色 key 优先使用：

```text
data-app-action-sidebar-thread-id
data-app-action-sidebar-project-id
```

取不到稳定 ID 时才退化为标题。

颜色保存在：

```text
localStorage["better-codex:v1:colors"]
```

### React ContextMenu provider

Codex 的 row 自身不一定直接保存菜单数据。BetterCodex 会从 row 的 React Fiber 向上寻找：

```text
memoizedProps.getItems
pendingProps.getItems
memoizedProps.items
pendingProps.items
```

当前可用版本主要命中 `getItems`。

为了避免拿错 provider，会用已知的 thread / project menu item id 做结构校验，例如：

```text
rename-thread
archive-thread
mark-thread-unread
edit-project
remove-project
```

### Native menu

`window.electronBridge.showContextMenu` 是 Codex preload 暴露的 bridge。BetterCodex 最终仍调用这个 bridge，因此显示出来的是 macOS native menu，而不是自定义 HTML menu。

原有菜单 item 的 `onSelect` callback 会保留下来。用户选择菜单项后，根据 bridge 返回的 item id 找回对应 item，再调用原 callback。

## 踩坑记录

### 1. 直接替换右键菜单

最早直接拦截 `contextmenu` 并显示 BetterCodex 自己的弹层。

问题：Codex 原来的 Rename / Pin / Archive / Share 等功能全部被覆盖。

结论：不能替换，只能增强原菜单。

### 2. 试图修改原生菜单 DOM

尝试等待 Codex 菜单出现后 clone DOM / class。

问题：当前线程菜单是 Electron / macOS native menu。菜单打开前后 Renderer 中都没有对应 `[role="menu"]` DOM。

结论：native menu 不能通过 DOM 注入。

### 3. 试图 monkey-patch electronBridge

`window.electronBridge` 和 `showContextMenu` 在当前 build 中是 frozen、sealed、non-writable、non-configurable。

结论：不能直接替换 bridge function。

### 4. 在 showContextMenu breakpoint 里改 resolved array

CDP `Debugger.setBreakpointOnFunctionCall` 可以成功停在 bridge 调用边界，也能找到 resolved menu array。

问题：这个时间点 native menu array 已经生成。修改 resolved array 虽然日志显示成功，但界面不会变化。

结论：注入点必须更早，最终选择 React ContextMenu provider。

### 5. 假设 menu items 一定在 props.items

当前菜单可能由 `getItems()` 动态生成，静态 `props.items` 不一定存在。

结论：优先调用 provider，而不是只读静态 props。

### 6. CDP target / renderer 启动时序

Desktop App 启动后，CDP endpoint 可能已经 ready，但主 renderer 还没有出现。

结论：injector 应持续 watch，不要第一次找不到 renderer 就退出。

### 7. Runtime.evaluate 静默异常

早期 injector 没有检查 `Runtime.evaluate.exceptionDetails`，导致 renderer JS 抛错时终端看起来像“什么都没发生”。

结论：所有 CDP evaluate 都必须检查 `exceptionDetails`。

## 调试

正常运行尽量保持安静。

需要排查 Codex 新版本兼容问题时：

```bash
BETTER_CODEX_DEBUG=1 ./better-codex
```

会额外打印：

```text
[BetterCodex:debug] ...
```

provider 找不到或 native menu 打开失败时，即使没有开启 debug，也会打印：

```text
[BetterCodex:warn] ...
```

## 维护时优先检查

Codex 更新后如果颜色菜单失效，按这个顺序排查：

1. sidebar row 的 `data-app-action-sidebar-*` 属性是否变化。
2. React Fiber property 是否仍能从 DOM element 获取。
3. ContextMenu 是否仍暴露 `getItems` / `items`。
4. menu item id 是否变化。
5. Intl context 中是否仍有 `formatMessage`。
6. `electronBridge.showContextMenu` 的入参 / 返回值是否变化。

除非这些路径都不可用，不建议重新回到自定义 UI 或修改 `app.asar`。
