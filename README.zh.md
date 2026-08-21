# DeepSeek Harness Desktop

[English](README.md) | 中文

面向回环 `dsh web` Host 的 Electron 桌面壳：一个原生窗口加一个掌管应用生命周期的系统托盘，而 Host 进程在窗口关闭后仍继续运行会话与后台工作。

壳是**仓库的纯新增部分**，只通过稳定的契约触达产品，因此除非上游改动这些接口，否则上游更新不可能破坏打包：

- `apps/cli/lib/bin.js`（构建后的 `dsh` CLI 入口）
- `dsh web` 就绪行（`dsh web: http://127.0.0.1:<port>`）
- `@deepseek-ai/dsh-web-frontend/dist`（构建后的浏览器 UI）

## 命令

```sh
pnpm run dev:desktop       # 完整构建，然后启动 Electron 窗口
pnpm run package:desktop   # 构建 + 暂存 Host 运行时（不打包安装器）
pnpm run dist:desktop      # 构建 + 暂存 Host 运行时 + 平台安装器
pnpm run dist:win          # Windows NSIS 安装器（完整 workspace 构建）
pnpm run dist:win:fast     # NSIS 安装器（仅壳层改动）
```

只改桌面壳（`src/`、图标、`resources/`）时用 `dist:win:fast`：只重建壳层，上游无变化时复用已暂存的 Host 运行时。`scripts/stage-runtime.ts` 会为暂存运行时的每个输入做指纹，指纹不变就复用 `runtime-host/` 并跳过完整 `pnpm deploy`（传 `--force` 可重建）。安装包约 600 MB / 3.2 万文件，全新安装需几分钟。

## 打包后的应用如何运行

`electron-builder` 嵌入：

1. **壳层**（`apps/desktop`）——窗口、托盘、Host 监督器。
2. **Host 运行时**（`runtime-host/` → `resources/host/`）——含构建后 CLI、全部产品包与 Web 前端的扁平 `node_modules`。

打包后的壳用 **Electron 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`）在独立进程运行 Host，无需附带第二个 Node。窗口加载 Host 发出的回环 URL，导航锁定在该源上。

## 远程运行时引导

安装器只携带壳层；Host 运行时在首次启动时从远程 manifest 下载到 `userData/host`。`afterPack` 钩子（`scripts/verify-packaged-runtime.ts`）会拒绝既无捆绑 `resources/host` 又无 `manifestUrl` 配置的壳层，因此 dist 前必须先跑 `publish:runtime --write-config`。已是最新安装会跳过下载；manifest、校验和或解压失败会大声中止启动。

### 发布运行时

```sh
pnpm run publish:runtime --url <base-url> --write-config
```

重跑 `stage-runtime`，把 `runtime-host/` 打成 `dsh-runtime-<version>-<stage-hash>.zip`，并写出 `runtime-manifest.json`（版本、URL、SHA-256、大小）。把两个文件托管到同一 base URL 下。`--write-config` 还会写 `resources/runtime-config.json`，下次构建安装包时会捆绑它，让壳层知道 manifest URL。base URL 也可来自 `DSH_RUNTIME_PUBLISH_URL`，`--out` 可覆盖输出目录（默认 `dist/runtime`）。

打包后的应用从 `DSH_RUNTIME_MANIFEST_URL` 或捆绑的 `runtime-config.json` 引导；只有两者都没配置时才用捆绑的 `resources/host`（可选离线安装器——把 `runtime-host/*` 加回 `extraResources`）。下载使用 Chromium 网络栈（信任系统证书、遵循系统代理），并对不稳定链路有韧性：停滞/超时会重试并回退镜像（`DSH_RUNTIME_MIRRORS`，默认 GitHub 代理镜像），每次尝试都由 manifest 的 SHA-256 把关。解压在最多 16 个并行 worker 中进行，失败回退串行。

## 应用自更新

安装包内置 `electron-updater`，指向 `build.publish` 声明的 GitHub Releases 源（`yxx-jf/deepseek-harness-desktop`）。托盘"检查更新…"与启动静默检查会寻找更新的安装包并在重启时安装（`src/updater.ts`）。发布时把更新三件套——`.exe`、`latest.yml`、`.exe.blockmap`——上传到同一个 release：

```sh
gh release create v<ver> dist/DeepSeek-Harness-*.exe dist/latest.yml dist/DeepSeek-Harness-*.exe.blockmap -R yxx-jf/deepseek-harness-desktop
```

**版本通道规则**：更新只发生在同一预发布通道内——`0.1.0-rc.5` 只能看到更新的 `*-rc.*`。面向客户请用稳定版本号（`0.1.0`、`0.2.0`、…）。

## 一键发布

构建壳层、生成运行时包、打 NSIS 安装包、上传全部产物到 GitHub Release，一条命令完成：

```sh
$env:GH_TOKEN = "..."   # 或在 .env 里写 GH_TOKEN=...（需 repo scope）
pnpm run release
```

## 上游拉取后的更新

```sh
git pull
pnpm install
pnpm run build
pnpm run dist:desktop        # 或 package:desktop 做免安装测试构建
```

## 屏蔽 GitHub releases 的网络

构建期拉 Electron 二进制失败（TLS 错误、超时）时，先指向 npmmirror 再构建：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:NODE_OPTIONS = "--use-system-ca"
pnpm run dist:desktop
```

这些环境变量只影响构建期工具；打包应用的运行时下载已用 Chromium 网络栈。API key 在 **Settings → Models** 输入，存在 `~/.dsh`；打包后的应用不读取仓库 `.env`。

## 图标

应用图标使用了 **DeepSeek Whale Girl**（深海鲸娘）形象，原作者为 [fornarwhal](https://github.com/fornarwhal)，素材来自 [fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)（`improved-1.png`，984×984）。缩放为 `build/icon.ico`、`icon.icns`、`icon.png` 及 `resources/` 下的托盘图标。

## 布局

```text
src/             Electron 主进程（窗口、托盘、Host 监督器）
scripts/         暂存、manifest 生成、图标生成、afterPack 门禁
runtime/         仅依赖部署根目录（@deepseek-ai/dsh-desktop-runtime）
build/           应用图标（icon.ico, icon.icns, icon.png）
resources/       托盘图标、运行时配置、启动画面 UI
runtime-host/    暂存 Host 运行时（生成文件，git 忽略）
dist/            electron-builder 输出（生成文件，git 忽略）
```

## 许可证

[MIT](LICENSE)
