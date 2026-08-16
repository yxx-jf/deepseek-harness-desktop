# Agent Note：runtime manifest 拉取回退到镜像

Status: implemented

[English](2026-08-17-runtime-manifest-falls-back-to-mirror.md) | 中文

## 问题

启动偶尔失败，报 `runtime manifest fetch failed: HTTP 502`，第二次启动又成功。runtime 归档早就通过镜像前缀（`https://gh-proxy.com/`）下载，但 manifest——指明归档的那个小 JSON——仍直接从 GitHub Release URL 拉取。在不稳定的直连网络上，manifest 是第一个失败的字节，于是镜像还没来得及帮忙，整个启动就中止了。

## 决策

manifest 拉取现在复刻归档的健壮性。`fetchRuntimeManifestWithMirrors(url, fetchImpl, mirrors)` 先试主 URL，再试每个镜像前缀拼接的 URL，返回第一个有效 manifest。两个消费者都用它：

- `ensureRuntime` 通过配置的 `mirrorPrefixes` 拉取（与归档下载同一份列表）。
- `checkRuntimeForUpdates`（托盘的 runtime 通道）从 `DSH_RUNTIME_MIRRORS` 或默认前缀构造同一份镜像列表。

归档 SHA-256 校验不变；即便镜像提供了不同的 manifest，也无法通过无效归档的校验。`fetchRuntimeManifest` 仍作为单 URL 原语导出。

## 备选方案

- **把打包配置指向镜像 URL。** 更简单，但只修复配置已指向镜像的机器，对读取同一主 URL 的托盘检查毫无帮助；运行时回退修复所有调用方与所有部署。
- **让 manifest 走归档下载路径。** 归档下载器流式下载并哈希；manifest 很小且由 `validateManifest` 校验，因此更轻的抓取后校验循环才是正确的形态。

## 后果

不稳定的直连链路不再中止启动：manifest 像归档一样回退到镜像，因此第一次启动与第二次同样容易成功。改动仅限 manifest 抓取步骤；新 helper 与依旧严格的校验都由 `runtime-bootstrap.spec` 覆盖。
