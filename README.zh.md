# DeepSeek Harness Desktop

[English](README.md) | 中文

面向回环 `dsh web` Host 的 Electron 桌面壳：一个原生窗口加一个掌管应用生命周期的系统托盘，而 Host 进程在窗口关闭后仍继续运行会话与后台工作。

壳是**仓库的纯新增部分**。它不加入 host 或 client 编译聚合，不改变 `apps/web`，只通过稳定的契约触达产品：

- `apps/cli/lib/bin.js`（构建后的 `dsh` CLI 入口）
- `dsh web` 就绪行（`dsh web: http://127.0.0.1:<port>`）
- `@deepseek-ai/dsh-web-frontend/dist`（构建后的浏览器 UI）

因此，除非上游改动这些接口之一，否则上游更新不可能破坏打包。

## 命令

```sh
pnpm run dev:desktop       # build everything, then launch the Electron window
pnpm run package:desktop   # build + stage Host runtime + unpacked app (no installer)
pnpm run dist:desktop      # build + stage Host runtime + platform installer
pnpm run dist:win          # explicit Windows NSIS installer (full build)
pnpm run dist:win:fast     # NSIS installer for shell-only changes (see below)
```

### 构建速度

`dist:win` 会先跑完整的 workspace 构建，因此它是上游拉取后使用的路径。只改桌面壳（`src/`、图标、`resources/`）时用 `dist:win:fast`：它只重建壳层，上游无变化时复用已暂存的 Host 运行时，打包时间大致等于 electron-builder 单独所需的时间。

`scripts/stage-runtime.ts` 会为暂存 Host 运行时的每个输入做指纹（lockfile、重新生成的运行时 manifest，以及每个纳入 workspace 包的文件戳）。指纹不变就复用 `apps/desktop/runtime-host/` 并跳过完整的 `pnpm deploy` 加符号链接实体化；传 `--force` 可无条件重建。

安装包负载约 600 MB、跨约 3.2 万个文件（Electron 运行时加扁平 Host `node_modules`），因此全新安装在普通磁盘上要花几分钟；更新复用同一版本并原地替换文件。

## 打包后的应用如何运行

`electron-builder` 嵌入两样东西：

1. **壳层**（`apps/desktop`）——窗口、托盘和 Host 监督器。
2. **Host 运行时**（`runtime-host/` → `resources/host/`）——一个扁平 `node_modules`，含构建后的 CLI、每个产品 workspace 包和构建后的 Web 前端。

启动时，打包后的壳用 **Electron 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`）在独立进程里运行 Host，因此安装器不附带第二个 Node 可执行文件。窗口加载 Host 发出的回环 URL；导航被锁定在该源上，外部链接用系统浏览器打开。

## Windows 安装器行为

NSIS 安装器在替换文件前会先停止正在运行的应用。因为应用关闭到托盘，普通的窗口关闭会让进程继续存活，所以桌面壳把**托盘隐藏**窗口的关闭视为外部请求（安装器/卸载器优雅关闭、Windows 会话结束、关机）而退出应用，而不是重新隐藏它。从进程内部退出在安装器强制结束会被拒绝时也能成功——未提权的安装器杀不掉提权后的应用（`allowElevation: false`、`perMachine: false`），这是安装器可能要求手动关闭应用的唯一剩余场景：如果应用是以**管理员**身份启动的，先关掉它的窗口（或从托盘退出）再运行安装器。

在 Windows 上，打包后的应用还会监视正在运行的 `DeepSeek-Harness-*.exe` 安装器进程，并在其启动后一秒内自行退出，因此更新安装完全不需要杀掉正在运行的应用——即使是提权后的应用也一样。

暂存 Host 运行时在打包前会剔除 `*.d.ts` 和 `*.map` 文件（Node 运行时从不加载它们；最深生成的声明名在安装后会超过 MAX_PATH），`build/installer.nsh` 安装一个长路径感知的 `customRemoveFiles` 卸载宏，因此更新安装不会因超长包路径而以 "Failed to uninstall old application files" 中止。

## 暂存 Host 运行时

`scripts/stage-runtime.ts` 产出 `apps/desktop/runtime-host/`：

1. 从当前 workspace 重新生成 `apps/desktop/runtime/package.json`（`scripts/generate-runtime-manifest.ts`），让每个产品包都能作为裸 Cordis 插件解析。
2. 对该 manifest 运行仓库的 `verify-runtime-closure` 门禁。
3. `pnpm deploy --legacy --prod` 实体化一个扁平 `node_modules`，然后把符号链接替换为真实字节。
4. 扫描组合后的 web profile 的 cordis yml 文件，若引用的 `@deepseek-ai/*` 插件缺失则拒绝构建。
5. `electron-builder` 的 `afterPack` 钩子在完成的 app 内复查 CLI 入口与前端 dist。

## 远程运行时引导

安装器只携带 Electron 壳层；Host 运行时及其依赖在首次启动时从远程 manifest 下载到用户数据目录（`userData/host`）。会在打包阶段就拒绝损坏的壳层：`afterPack` 钩子（`scripts/verify-packaged-runtime.ts`）在存在捆绑的 `resources/host` 时验证它，否则要求 `desktop-resources/runtime-config.json` 带 `manifestUrl`，因此 dist 脚本必须先跑 `publish:runtime --write-config`。

### 发布运行时

`publish-runtime` 复用暂存树并产出需要托管的产物：

```sh
pnpm run publish:runtime --url https://cdn.example.com/dsh --write-config
```

它会重跑 `stage-runtime`，把 `apps/desktop/runtime-host/` 打成 `dsh-runtime-<version>-<stage-hash-prefix>.zip`，并在其旁写一个 `runtime-manifest.json`（版本、URL、SHA-256、大小）。把两个文件都上传到该基础 URL。`--write-config` 还会写 `apps/desktop/resources/runtime-config.json`，下一次安装包构建会把它作为 `desktop-resources/runtime-config.json` 捆绑，让壳层知道 manifest URL。基础 URL 也可来自 `DSH_RUNTIME_PUBLISH_URL`，`--out` 可覆盖输出目录（默认 `apps/desktop/dist/runtime`）。

### 激活远程路径

打包后的应用从 `DSH_RUNTIME_MANIFEST_URL` 或捆绑的 `runtime-config.json` 引导远程运行时；只有当两者都没配置时才使用捆绑的 `resources/host`（可选离线安装器——把 `runtime-host/package.json` 和 `runtime-host/node_modules` 加回 `extraResources` 即可）。下载期间，一个深色启动窗口报告进度（`src/splash.ts`、`resources/splash.html`）。运行时安装在 `userData/host` 下，带 `runtime-manifest.json` 标记，因此更新原地替换，且最新安装会完全跳过下载。manifest、校验和或解压失败会大声中止启动并清理各自的暂存目录。

解压在 worker 池中进行（`src/parallel-extract.ts`）：先解析 ZIP 中央目录（`src/zip-index.ts`），把条目均衡分配到最多 16 个并发 inflate 与写盘的 worker（`src/extract-worker.ts`），任何失败都回退到串行流式解压（`src/runtime-bootstrap.ts` 的 `extractZip`）。小文件磁盘写入是硬性下限，因此并行主要节省 CPU 时间；在开发机 NVMe 上，17,948 文件的运行时解压约 7s，而串行约 9s。

运行时下载使用 Electron 的 `net.fetch`（Chromium 网络栈），注入到引导流程，而不是 Node 内置的 `fetch`：Chromium 按操作系统证书库校验证书并遵循系统代理设置，而 Node 自带的 CA bundle 会以 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 拒绝装有本地根证书（拦截代理、安全套件）的机器。引导流程仍是纯 Node、可测试，因为 fetch 是注入选项（`RuntimeBootstrapOptions.fetch`），默认为全局 fetch。

下载对发布 CDN 的不稳定链路有韧性：某次尝试在 `downloadStallTimeoutMs`（20s）内没有字节到达，或在整体 `downloadTimeoutMs` 超时后会被中断，每个 URL 按 `downloadRetries` 重试，然后依次尝试 `mirrorPrefixes` 镜像前缀，每次尝试都由 manifest 的 SHA-256 把关。打包壳层默认使用 `https://gh-proxy.com/` 镜像应对 GitHub release 卡住的情况；可用 `DSH_RUNTIME_MIRRORS`（逗号分隔的前缀）覆盖。

## 应用自更新（应用内在线更新）

安装包内置 [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater)，指向 `build.publish` 声明的 GitHub Releases 源（`yxx-jf/deepseek-harness-desktop`）。托盘"检查更新…"与启动静默检查会寻找更新的安装包；发现更新后下载并在重启时安装（`src/updater.ts`）。这与运行时引导相互独立，运行时仍会在每次启动时自动替换。

发布应用更新需要把安装包更新三件套——`.exe`、`latest.yml`、`.exe.blockmap`（均由 electron-builder 生成）——上传到同一个 release：

```sh
gh release create v0.1.0-rc.6 apps/desktop/dist/DeepSeek-Harness-*.exe apps/desktop/dist/latest.yml apps/desktop/dist/DeepSeek-Harness-*.exe.blockmap -R yxx-jf/deepseek-harness-desktop
```

**版本通道规则**：electron-updater 只在同一预发布通道内更新——构建为 `0.1.0-rc.5` 的应用只会检测更新的 `*-rc.*`，忽略稳定版。面向客户请使用稳定版本号（`0.1.0`、`0.2.0`、…），以便跟踪所有后续发布。

## 上游拉取后的更新

```sh
git pull
pnpm install
pnpm run build
pnpm run dist:desktop        # or package:desktop for an unpacked test build
```

如果上游新增了 web profile 组合的产品包，第 4 步的暂存 profile 扫描会以缺失的包名失败；重新生成运行时 manifest（stage-runtime 会自动做）并在有变化时提交更新后的 `apps/desktop/runtime/package.json`。

## 屏蔽 GitHub releases 的网络

Electron 二进制和 electron-builder 的签名工具从 GitHub releases 下载。在其失败（TLS 错误、超时）的网络上，先在这两个下载上指向 npmmirror，再运行 `dist:desktop`：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:NODE_OPTIONS = "--use-system-ca"   # when a proxy CA is not trusted
pnpm run dist:desktop
```

这些环境变量只影响构建期工具。打包后应用的运行时下载已经使用 Chromium 网络栈，它信任操作系统证书库并读取系统代理设置，因此应用本身无需按用户设置 `NODE_OPTIONS`。

API key 在应用的 **Settings → Models** 中输入，存在用户主目录下（`~/.dsh`）；打包后的应用不读取仓库的 `.env`。

## 图标

应用使用 [deepseek-whale-girl-icon-main](https://github.com/yxx-jf/deepseek-whale-girl-icon-main) 图标集。主源图为 `improved-1.png`（984×984，RGBA），缩放至各平台所需尺寸：

| 文件 | 来源 | 用途 |
|---|---|---|
| `build/icon.ico` | `DeepSeekHarness-WhaleGirl.ico` (16/24/32/48/64/128/256) | Windows app, taskbar, shortcuts |
| `build/icon.icns` | 从 `improved-1.png` 组装 (16–1024) | macOS app |
| `build/icon.png` | 从 `improved-1.png` 缩放 (256×256) | Linux AppImage + fallback |
| `resources/trayTemplate.png` | 从 `improved-1.png` 缩放 (32×32) | tray |
| `resources/tray.png` | 从 `improved-1.png` 缩放 (32×32) | tray |

要刷新，从主源图重新生成 PNG 并重新组装 `icon.ico` 和 `icon.icns`。

## 布局

```text
apps/desktop/
  src/             Electron main process (window, tray, Host supervisor)
  scripts/         staging, manifest generation, icon generation, afterPack gate
  runtime/         dependency-only deploy root (@deepseek-ai/dsh-desktop-runtime)
  build/icon.png   application icon
  resources/       tray icon
  runtime-host/    staged Host runtime (generated, git-ignored)
  dist/            electron-builder output (generated, git-ignored)
```
