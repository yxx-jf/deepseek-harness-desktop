# Agent Note：运行时下载中断——坏镜像与过短的停滞超时

Status: implemented

[English](2026-08-22-runtime-download-mirror-and-timeout.md) | 中文

## 问题

manifest 拉取修好之后，打包应用又卡在 `runtime archive download failed after 4 attempt(s): The operation was aborted`。在该机器上的实测：

| 路径 | 速度 |
|---|---|
| 直连 GitHub | ~8.6 KB/s（48.6 MB ≈ 1.6 小时） |
| `gh-proxy.com` 镜像 | ~1.4 MB/s（约 35 秒） |
| `ghfast.top` 镜像 | ~86 KB/s |
| `github.akams.cn`（原默认） | HTTP 404 |

两个叠加的缺陷：默认镜像 `github.akams.cn` 已经失效（每个代理请求都 404），主 URL 一旦失败 fallback 立刻也死；而且 20 秒的 `downloadStallTimeoutMs` 看门狗会在慢/不稳定链路上 20 秒没有新字节时中止 48 MB 的流。

## 决策

- 运行时两条路径的默认镜像从 `github.akams.cn` 改为 **`gh-proxy.com`**（已验证可用，约 1.4 MB/s）。
- 从 `githubMirrorPrefixes()` 回退列表中移除 `github.akams.cn`。
- 把 `ensureRuntime` 调用里的 `downloadStallTimeoutMs` 从 20 秒调到 **60 秒**。`downloadTimeoutMs`（总超时，默认 300 秒）保持不变。
- **两套镜像配置一起改**：manifest 拉取用 `DSH_RUNTIME_MIRRORS ?? 'https://gh-proxy.com/'`（单个默认），归档下载用 `githubMirrorPrefixes()` 列表——只改一处另一处还是旧的。

## 备选方案

- **只调大超时。** 留着坏镜像当 fallback，慢网用户在"主 URL 超时"后仍然注定中止。
- **把运行时打进安装包（离线）。** 能彻底免下载，但安装包会膨胀约 600 MB 且让更新变复杂；不作为默认方案。

## 后果

在测试网络上，运行时 zip 现在约 35 秒经镜像下载完，远在两个超时范围内。镜像都是第三方、可能随时失效——发布前用 `curl --max-time 15 -w "%{speed_download}" https://gh-proxy.com/<完整URL>` 验证默认镜像。