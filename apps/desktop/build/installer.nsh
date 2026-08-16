; Long-path-aware application file removal for the uninstaller.
;
; The default atomicRMDir/RMDir deletion fails on generated package paths
; longer than MAX_PATH (e.g. @mistralai/mistralai codegen file names), which
; aborts update uninstalls with errorlevel 2 and leaves "Failed to uninstall
; old application files" on screen. PowerShell's \\?\ prefix bypasses the path
; limit; errors stay silent so the uninstall still completes and the leftover
; files are simply overwritten by the next install.

!macro customRemoveFiles
  SetOutPath $TEMP
  DetailPrint "Removing application files (long path aware)"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '\\?\$INSTDIR' -Recurse -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend
