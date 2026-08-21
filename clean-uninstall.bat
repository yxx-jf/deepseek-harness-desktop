@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title DeepSeek Harness - 完全卸载清理工具

echo.
echo ============================================
echo   DeepSeek Harness 完全卸载清理工具
echo   本脚本将卸载应用并清除所有残留数据
echo ============================================
echo.

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  需要管理员权限才能彻底清理。正在请求提权...
    mshta "javascript:var s=new ActiveXObject('Shell.Application');s.ShellExecute('%~f0','','','runas',0);close();" 2>nul
    if !errorlevel! equ 0 exit /b
    echo.
    echo ❌ 提权失败，请右键 -^> 以管理员身份运行
    pause
    exit /b 1
)

echo [1/6] 关闭正在运行的 DeepSeek Harness 进程...
:kill_loop
tasklist /fi "imagename eq DeepSeek Harness.exe" /nh 2>nul | find /i "DeepSeek Harness" >nul
if !errorlevel! equ 0 (
    echo   ⏹️  发现运行中的进程，正在关闭...
    taskkill /f /im "DeepSeek Harness.exe" >nul 2>&1
    timeout /t 3 /nobreak >nul
    goto kill_loop
)
echo   [OK] 无残留进程

echo.
echo [2/6] 查找已安装的程序并卸载...
set UNINSTALL_CMD=
set INSTALL_DIR=

:: 搜索注册表 HKCU 和 HKLM 下的 Uninstall 键，找 DisplayName=DeepSeek Harness
for %%r in (HKCU HKLM) do (
    for /f "delims=" %%k in ('reg query "%%r\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" 2^>nul') do (
        for /f "skip=2 tokens=2*" %%a in ('reg query "%%k" /v DisplayName 2^>nul') do (
            if /i "%%b"=="DeepSeek Harness" (
                for /f "skip=2 tokens=2*" %%c in ('reg query "%%k" /v UninstallString 2^>nul') do set UNINSTALL_CMD=%%d
                for /f "skip=2 tokens=2*" %%e in ('reg query "%%k" /v InstallLocation 2^>nul') do set INSTALL_DIR=%%f
                if "!INSTALL_DIR!"=="" (
                    for %%x in ("!UNINSTALL_CMD!") do set INSTALL_DIR=%%~dpx
                )
            )
        )
    )
)

if "!UNINSTALL_CMD!"=="" (
    echo   [ - ] 未找到 DeepSeek Harness 安装信息（可能已卸载或未安装）
) else (
    echo   [OK] 找到卸载程序: !UNINSTALL_CMD!
    echo.
    echo [3/6] 正在卸载 DeepSeek Harness...
    for %%x in (!UNINSTALL_CMD!) do set UNINSTALL_EXE=%%x
    start /wait "" "!UNINSTALL_EXE!" /S
    if errorlevel 1 (echo   [WARN] 卸载可能未完全成功，继续清理残留...) else (echo   [OK] 卸载完成)
    echo.
    echo [4/6] 清理安装目录残留...
    if defined INSTALL_DIR if exist "!INSTALL_DIR!" (
        echo   [DIR] 删除: !INSTALL_DIR!
        rd /s /q "!INSTALL_DIR!" 2>nul
    )
    for %%d in (
        "%LOCALAPPDATA%\Programs\DeepSeek Harness"
        "%LOCALAPPDATA%\Programs\deepseek-harness-desktop"
        "%PROGRAMFILES%\DeepSeek Harness"
        "%PROGRAMFILES(X86)%\DeepSeek Harness"
    ) do (
        if exist "%%~d" (
            echo   [DIR] 删除: %%~d
            rd /s /q "%%~d" 2>nul
        )
    )
    echo   [OK] 安装目录清理完成
)

echo.
echo [5/6] 清理应用数据...
:: Electron userData（运行时下载、缓存、配置）
set USER_DATA_DIR=%APPDATA%\DeepSeek Harness
if exist "!USER_DATA_DIR!" (
    echo   [DIR] 删除: !USER_DATA_DIR!
    rd /s /q "!USER_DATA_DIR!" 2>nul
)
:: Electron 本地缓存
set LOCAL_DATA_DIR=%LOCALAPPDATA%\DeepSeek Harness
if exist "!LOCAL_DATA_DIR!" (
    echo   [DIR] 删除: !LOCAL_DATA_DIR!
    rd /s /q "!LOCAL_DATA_DIR!" 2>nul
)
:: DSH 用户数据
set DSH_HOME=%USERPROFILE%\.dsh
if exist "!DSH_HOME!" (
    echo   [DIR] 删除: !DSH_HOME!
    rd /s /q "!DSH_HOME!" 2>nul
)
echo   [OK] 应用数据清理完成

echo.
echo [6/6] 清理快捷方式...
set START_MENU_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness
if exist "!START_MENU_DIR!" (
    echo   [DIR] 删除: !START_MENU_DIR!
    rd /s /q "!START_MENU_DIR!" 2>nul
)
set DESKTOP_LNK=%USERPROFILE%\Desktop\DeepSeek Harness.lnk
if exist "!DESKTOP_LNK!" (
    echo   [FILE] 删除: !DESKTOP_LNK!
    del /f /q "!DESKTOP_LNK!" 2>nul
)
set PUBLIC_DESKTOP_LNK=%PUBLIC%\Desktop\DeepSeek Harness.lnk
if exist "!PUBLIC_DESKTOP_LNK!" (
    echo   [FILE] 删除: !PUBLIC_DESKTOP_LNK!
    del /f /q "!PUBLIC_DESKTOP_LNK!" 2>nul
)
echo   [OK] 快捷方式清理完成

echo.
echo ============================================
echo   [OK] 完全卸载清理完成！
echo   系统已恢复到未安装 DeepSeek Harness 的状态
echo ============================================
echo.
echo 如需重新安装，请运行 dist\DeepSeek-Harness-*.exe
echo.
pause