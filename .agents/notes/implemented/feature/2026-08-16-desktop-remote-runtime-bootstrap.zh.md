# Agent Note: 桌面端远程运行时引导

Status: implemented

[English](2026-08-16-desktop-remote-runtime-bootstrap.md) | 中文

## 问题

打包后的桌面壳把 Host 运行时塞进安装包：electron-builder 将暂存的 `runtime-host/` 树（17,948 个文件、约 187 MB）作为 `resources/host` 嵌入。全新安装因此要解包全部负载（安装包约 139 MB，解包上万文件耗时数十秒），更新则原地替换。产品没有通往"两步分发"的路径——先装小安装器、首次启动再下载运行时——而这正是第三方重新打包者采用的形态。

## 决策

**安装器只携带 Electron 壳层；Host 运行时在首次启动时下载到用户数据目录。两步形态是默认。** dist 脚本先跑 `publish:runtime --write-config`，让安装器携带 `desktop-resources/runtime-config.json`；`verify-packaged-runtime.ts` 会拒绝既无捆绑 `resources/host` 又无远程 manifest URL 的打包壳层，因此不带远程配置就跑 dist 会在打包阶段失败，而不是发出一个坏安装器。把运行时重新塞进安装器（离线布局）是可选行为：把 `runtime-host/package.json` 和 `runtime-host/node_modules` 加回 `extraResources` 即可。启动时从 `DSH_RUNTIME_MANIFEST_URL` 或捆绑配置解析 manifest URL；失败即大声报错。

`src/runtime-bootstrap.ts` 拥有远程流程且不导入任何 Electron API：它拉取 manifest、比较版本、下载归档、校验 SHA-256、把 ZIP 流式解压到暂存目录、检查 Host CLI 入口、写入 `runtime-manifest.json` 标记，并把暂存目录换入 `userData/host`（在重命名落定前保留旧安装）。进度按阶段上报（`fetching-manifest`、`downloading`、`extracting`、`installing`、`ready`）。无边框启动画面（`src/splash.ts` + `resources/splash.html`）渲染进度，且只在真正开始下载后才出现。打包后的应用用 worker 池解压归档（`src/parallel-extract.ts` + `src/zip-index.ts` + `src/extract-worker.ts`）：先解析 ZIP 中央目录，把条目均衡分配到最多 16 个并发 inflate 与写盘的 worker，任何失败都回退到串行流式解压（`src/runtime-bootstrap.ts` 的 `extractZip`）。

`scripts/publish-runtime.ts` 从同一棵暂存树产出可下载的产物：它先重跑 `stage-runtime.ts`，用同步 `zipSync` 把 `runtime-host/` 打成 ZIP（DEFLATE 9 级、固定时间戳），写出内容寻址版本（`<应用版本>-<暂存哈希前缀>`）的 `runtime-manifest.json`，并可用 `--write-config` 写 `resources/runtime-config.json`，让下一次安装包构建时捆绑 manifest URL。之所以用 `zipSync`，是因为 fflate 0.8.3 的流式 Zip 写入器（`Zip`/`ZipDeflate`）会损坏某些输入——往返解压时 inflate 报 `invalid distance`——而同步路径能正确往返；暂存树约 500 MB，对一次性发布步骤可接受。两侧都用 `fflate` 作为归档库，并通过 `deps.alwaysBundle` 内联进壳层 bundle，因为打包后的壳层不携带 `node_modules`。

**运行时下载必须用 Chromium 网络栈，不能用 Node 内置 fetch。** 壳层把 Electron `net.fetch` 注入引导流程（`RuntimeBootstrapOptions.fetch`）；首次真实安装时，Node 自带 CA bundle 在装有本地根证书（拦截代理或安全套件）的机器上以 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 拒绝连接，而 Chromium 按操作系统证书库校验并遵循系统代理设置，`curl` 与系统证书库都能成功。bootstrap 仍保持纯 Node、可测试，因为 fetch 是默认为全局 fetch 的注入选项。

**下载在停滞链路上重试并回退到镜像，而不是一直挂着。** 一次真实的首次安装下载卡在 3%，数十秒没有任何字节到达——是不稳定的直连发布 CDN，不是代理（机器系统代理是关闭的）。每次下载尝试在没有字节到达 `downloadStallTimeoutMs`（默认 20s）或超过 `downloadTimeoutMs` 后被中断，每个 URL 按 `downloadRetries` 重试，然后依次尝试 `mirrorPrefixes`，每次尝试都由 manifest 的 SHA-256 把关。打包壳层默认用 `https://gh-proxy.com/` 镜像前缀应对 GitHub release 卡住的情况；`DSH_RUNTIME_MIRRORS`（逗号分隔的前缀）可覆盖。

## 备选方案

**使用 electron-builder 的 `nsis-web` 目标。** 已否决：下载发生在 NSIS 窗口内，用的是原生进度 UI 而非产品自己的启动画面；需要 `publish` 配置或 `appPackageUrl`；而且在本仓库 `compression: "store"` 的配置下，下载的包本来就不压缩。它也无法驱动后续向同一运行时目录安装的插件市场流程。

**始终捆绑运行时、从不下载。** 已否决：这会堵死本次打包工作要提供的两步安装。

**把启动画面放进 Web 前端自托管。** 已否决：Host（前端所在之处）恰恰是引导必须先下载才能启动的东西；因此启动画面是一张由主进程驱动的静态 HTML 页。

## 结果

打包必须有运行时来源：`verify-packaged-runtime.ts` 在存在捆绑的 `resources/host` 时验证它，否则要求 `desktop-resources/runtime-config.json` 带 `manifestUrl`，因此不带 `publish:runtime --write-config` 就跑 dist 会在打包阶段失败，而不是发出坏安装器。配置了远程路径后，manifest、校验和或解压出错都会大声失败，并清理暂存与下载目录；旧运行时在换入落定前一直保留。去掉捆绑运行时后，安装包从约 139 MB 降到约 96 MB，全新安装从解包 17,948 个文件缩短到约 8 秒。引导安装的运行时位于 `userData/host`，因此卸载器的"删除应用数据"语义对其生效。由于版本号来自暂存树的内容寻址，运行时更新变得独立于壳层发版。
