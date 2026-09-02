@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title DSH node-pty 修复诊断
color 0B

echo ============================================================
echo    DSH node-pty 修复诊断（在出问题的电脑上运行）
echo ============================================================
echo.

echo [1] runtime 里的 node-pty 是否存在
set "RUNTIME_PTY=%APPDATA%\@deepseek-ai\dsh-desktop\host\node_modules\node-pty"
if exist "%RUNTIME_PTY%\package.json" (
    echo     [OK] runtime node-pty 存在
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-Content -Raw '%RUNTIME_PTY%\package.json' | ConvertFrom-Json).version"') do set "RPTY_VER=%%i"
    echo     版本: !RPTY_VER!
    if exist "%RUNTIME_PTY%\prebuilds\win32-x64" (echo     prebuilds/win32-x64: 存在) else (echo     prebuilds/win32-x64: 不存在!)
) else (
    echo     [X] runtime node-pty 不存在! 路径: %RUNTIME_PTY%
)
echo.

echo [2] profile 的 pnpm-workspace.yaml 内容
set "PROFILE=%USERPROFILE%\.dsh\profiles\web"
set "WS=%PROFILE%\pnpm-workspace.yaml"
if exist "%WS%" (
    echo     --- pnpm-workspace.yaml ---
    type "%WS%"
    echo.
) else (
    echo     [X] 找不到 %WS%
)
echo.

echo [3] profile/vendor/node-pty 是否存在
set "VENDOR_PTY=%PROFILE%\vendor\node-pty"
if exist "%VENDOR_PTY%\package.json" (
    echo     [OK] vendor node-pty 存在
    for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-Content -Raw '%VENDOR_PTY%\package.json' | ConvertFrom-Json).version"') do set "VPTY_VER=%%i"
    echo     版本: !VPTY_VER!
    if exist "%VENDOR_PTY%\prebuilds\win32-x64" (echo     prebuilds/win32-x64: 存在) else (echo     prebuilds/win32-x64: 不存在!)
) else (
    echo     [X] vendor node-pty 不存在（说明修复函数可能没执行到复制这一步，或提前退出了）
)
echo.

echo [4] profiles 目录列表
if exist "%USERPROFILE%\.dsh\profiles" (
    dir /b "%USERPROFILE%\.dsh\profiles"
) else (
    echo     [X] %USERPROFILE%\.dsh\profiles 不存在
)
echo.

echo [5] 应用数据目录 userData 下的 host
if exist "%APPDATA%\@deepseek-ai\dsh-desktop\host" (
    echo     [OK] host 目录存在
) else (
    echo     [X] host 目录不存在! %APPDATA%\@deepseek-ai\dsh-desktop\host
    dir "%APPDATA%\@deepseek-ai\dsh-desktop" 2>nul
)
echo.

echo [6] 主进程可能写到的日志（如果存在）
set "MAINLOG=%APPDATA%\@deepseek-ai\dsh-desktop\logs"
if exist "%MAINLOG%" (
    echo     logs 目录:
    dir /b "%MAINLOG%"
) else (
    echo     无 logs 目录（主进程日志不在磁盘）
)
echo.

echo 请把以上完整输出复制发给开发者。
echo 关键判断点：
echo   - [1] runtime node-pty 不存在 -> 运行时未内置，需核实
echo   - [3] vendor 不存在 -> 修复函数复制/改写环节失败
echo   - [2] override 是否仍是 "node-pty: 1.2.0-beta.15" -> 说明还没被改成 file:./vendor
echo.
pause