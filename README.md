# BetterCodex

A small, local UI enhancement layer for the Codex/ChatGPT desktop app.

## MVP feature

Color-highlight projects and conversations in the left sidebar so large project/thread lists are easier to scan.

- Right-click a project or conversation.
- Pick any color with the native color picker.
- The color is stored locally in the desktop app profile.
- No modification of the official `.app` or `app.asar`.
- No runtime npm dependencies.

> This is an unofficial experiment and is not affiliated with OpenAI.

## Current scope

- macOS only for the MVP.
- Node.js 22+.
- Tested design: launch the official app with a loopback-only Chrome DevTools Protocol (CDP) port, then inject a small DOM enhancer.

## Run

```bash
git clone https://github.com/SubtleSpark/better-codex.git
cd better-codex
./better-codex
```

If ChatGPT/Codex is already open without CDP enabled, the launcher asks whether it may restart the app.

Keep the terminal process running while using BetterCodex. Press `Ctrl+C` to remove the injected UI and stop the watcher.

You can also run:

```bash
npm run start
```

No `npm install` is required because the MVP has no dependencies.

## How to use

1. Start BetterCodex.
2. In the desktop app's left sidebar, right-click a project or conversation row.
3. Choose a color and press **Apply**. Moving the color picker updates the highlight immediately.
4. Use **Clear** to remove that item's color.

The MVP applies a narrow color strip plus a very light tinted background.

## Persistence

Colors are saved in the app renderer's `localStorage` under:

```text
better-codex:v1:colors
```

BetterCodex prefers stable IDs or links when the UI exposes them. If the app does not expose a stable ID/link for a row, the MVP falls back to its visible title. In that fallback case, renaming the project/conversation can make the old color association disappear.

## Configuration

Default CDP port:

```text
9347
```

Override it:

```bash
BETTER_CODEX_PORT=9450 ./better-codex
```

If your desktop app is installed somewhere else:

```bash
BETTER_CODEX_APP="/path/to/ChatGPT.app" ./better-codex
```

## Development

Syntax checks:

```bash
npm run check
```

Main files:

```text
scripts/start-macos.sh  # launch/restart app with loopback CDP
src/injector.mjs        # discover renderer targets and inject/re-inject
src/renderer.js         # sidebar detection, color picker, persistence and styles
```

The renderer code is idempotent. The injector polls for renderer reloads and re-injects after app navigation/reload.

## Security note

The CDP port is bound only to `127.0.0.1`, but CDP itself has no authentication. Another process running under your local user account could potentially connect while the app was launched with remote debugging enabled.

Stopping BetterCodex removes its UI, but it does **not** remove the remote-debugging flag from an already running app process. To close the CDP exposure window, fully quit ChatGPT/Codex and reopen it normally.

## Known MVP limitations

- This relies on the current desktop UI/DOM and is not an official extension API.
- A desktop app UI update may require adjusting the sidebar heuristics.
- The context menu is intentionally limited to clickable rows in the left portion of the window. If a future UI makes project headers non-clickable, those headers may need a dedicated selector.
- There is no sync/export/import UI yet.

## License

MIT
