@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

title DeepSeek Harness - 卸载并保留密钥与工作区对话

echo.
echo ============================================
echo   DeepSeek Harness 卸载清理工具
echo   保留 API key 和工作区对话数据
echo ============================================
echo.
echo 将执行以下操作：
echo   - 卸载 DeepSeek Harness
echo   - 删除安装目录、缓存、插件、运行时和其他配置
set "DSH_HOME=%USERPROFILE%\.dsh"
echo   - 保留 !DSH_HOME!\.credentials.yaml - API key
echo   - 保留 !DSH_HOME!\sessions - 工作区对话数据
echo.
echo 注意：此操作不可撤销，且会删除 !DSH_HOME! 下除上述内容外的所有数据。
set "CONFIRM="
set /p "CONFIRM=继续吗？请输入 Y 或 N："
if /i not "!CONFIRM!"=="Y" (
    echo.
    echo 已取消操作。
    pause
    exit /b 0
)

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ⚠️  需要管理员权限，正在请求提权...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs" 2>nul
    if !errorlevel! equ 0 exit /b 0
    echo ❌ 提权失败，请右键此文件并选择“以管理员身份运行”。
    pause
    exit /b 1
)

echo.
echo [1/5] 关闭正在运行的 DeepSeek Harness 进程...
:kill_loop
tasklist /fi "imagename eq DeepSeek Harness.exe" /nh 2>nul | find /i "DeepSeek Harness" >nul
if !errorlevel! equ 0 (
    taskkill /f /im "DeepSeek Harness.exe" >nul 2>&1
    timeout /t 2 /nobreak >nul
    goto kill_loop
)
echo   [OK] 进程已关闭

echo.
echo [2/5] 查找并执行卸载程序...
set "UNINSTALL_CMD="
for %%r in (HKCU HKLM) do (
    for /f "delims=" %%k in ('reg query "%%r\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" 2^>nul') do (
        for /f "skip=2 tokens=2*" %%a in ('reg query "%%k" /v DisplayName 2^>nul') do (
            if /i "%%b"=="DeepSeek Harness" (
                for /f "skip=2 tokens=2*" %%c in ('reg query "%%k" /v UninstallString 2^>nul') do set "UNINSTALL_CMD=%%d"
            )
        )
    )
)
if defined UNINSTALL_CMD (
    echo   [INFO] 找到卸载命令：!UNINSTALL_CMD!
    start /wait "" !UNINSTALL_CMD! /S
    if errorlevel 1 (echo   [WARN] 卸载程序返回异常，继续清理...) else (echo   [OK] 应用已卸载)
) else (
    echo   [ - ] 未找到安装信息，跳过卸载
)

echo.
echo [3/5] 清理安装目录...
for %%d in (
    "%LOCALAPPDATA%\Programs\DeepSeek Harness"
    "%LOCALAPPDATA%\Programs\deepseek-harness-desktop"
    "%PROGRAMFILES%\DeepSeek Harness"
    "%PROGRAMFILES(X86)%\DeepSeek Harness"
) do (
    if exist "%%~d" (
        echo   [DIR] 删除：%%~d
        rd /s /q "%%~d" 2>nul
    )
)
echo   [OK] 安装目录清理完成

echo.
echo [4/5] 清理应用数据，但保留密钥和工作区对话...
for %%d in (
    "%APPDATA%\DeepSeek Harness"
    "%LOCALAPPDATA%\DeepSeek Harness"
) do (
    if exist "%%~d" (
        echo   [DEL] 删除：%%~d
        rd /s /q "%%~d" 2>nul
    )
)
if exist "!DSH_HOME!" (
    for /f "delims=" %%x in ('dir /b /a "!DSH_HOME!" 2^>nul') do (
        if /i not "%%x"==".credentials.yaml" if /i not "%%x"=="sessions" (
            echo   [DEL] 删除：!DSH_HOME!\%%x
            if exist "!DSH_HOME!\%%x\NUL" (rd /s /q "!DSH_HOME!\%%x" 2>nul) else (del /f /q "!DSH_HOME!\%%x" 2>nul)
        )
    )
    if exist "!DSH_HOME!\.credentials.yaml" (echo   [KEEP] 保留：!DSH_HOME!\.credentials.yaml) else (echo   [WARN] 未找到 credentials 文件)
    if exist "!DSH_HOME!\sessions\NUL" (echo   [KEEP] 保留：!DSH_HOME!\sessions) else (echo   [WARN] 未找到 sessions 目录)
) else (
    echo   [ - ] 未找到 DSH 用户目录
)

echo.
echo [5/5] 清理快捷方式...
set "START_MENU_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness"
if exist "!START_MENU_DIR!" rd /s /q "!START_MENU_DIR!" 2>nul
for %%f in (
    "%USERPROFILE%\Desktop\DeepSeek Harness.lnk"
    "%PUBLIC%\Desktop\DeepSeek Harness.lnk"
) do if exist "%%~f" del /f /q "%%~f" 2>nul
echo   [OK] 快捷方式清理完成

echo.
echo ============================================
echo   [OK] 卸载清理完成
echo   API key 和工作区对话数据已保留
echo ============================================
echo.
pause
