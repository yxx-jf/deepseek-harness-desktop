# DeepSeek Harness Desktop

English | [中文](README.zh.md)

A desktop solution for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin ecosystem: bring the official Web UI into a native desktop window, with one-click install, system tray, two-step setup, and online updates.

## Download

- **Windows**: [Download the latest installer](https://github.com/yxx-jf/deepseek-harness-desktop/releases/latest)
- macOS: coming soon

![Preview](assets/desktop-preview.png)

## Features

| Feature | Description |
| --- | --- |
| Desktop shell | Brings the official DSH Web UI into a native window; no Node.js or shell commands needed |
| Two-step install | A small installer lands first; the runtime downloads on first launch |
| Runtime auto-update | Checks the remote runtime on every launch and swaps in newer versions silently |
| In-app upgrade | Checks GitHub Releases for the latest installer, downloads and upgrades on restart |
| System tray | Tray-resident, one-click show/hide of the main window |

## Online updates

Two update layers keep the app current:

1. **Runtime updates**: on launch, compare the remote `runtime-manifest.json`; download and atomically swap a newer runtime without reinstalling.
2. **App updates**: check GitHub Releases for the latest installer, download and install in one click.

## Relationship to the official project

This project is built on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

The official project provides the core agent capabilities, the plugin system, and the Web UI. This project is responsible for:

- Desktop application packaging
- Starting, stopping, and restoring the local service
- Desktop window and system tray integration
- Windows installer build and release
- A UI better suited to the desktop

> This is a community desktop build, not an official DeepSeek product. To run Harness from the command line, prefer the [official repository](https://github.com/deepseek-ai/deepseek-harness).

## Development

Sync the latest upstream and repackage:

```sh
git fetch origin && git merge origin/master
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop run dist:win:fast
```

The desktop shell lives in `apps/desktop/`. Publish the runtime with:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run publish:runtime --url <base> --write-config
```

See [apps/desktop/README.md](apps/desktop/README.md).

## License

[MIT](LICENSE)

This project is fully open source and free. If anyone tries to sell it to you, decline.
