; electron-builder NSIS 扩展：安装器只负责落盘，功能选择放在桌宠首次启动的向导里（设置里随时可改）。
; 静默安装参数：/S /D=<目录> /KEY=<DeepSeek Key> /NOHANDOFF
; /NOHANDOFF 仅给自动化用：写入 install-features.txt（handoff=0），桌宠下次启动并入配置。
!include LogicLib.nsh
!include FileFunc.nsh

; 升级/卸载前先关掉正在运行的旧版本。
; 默认实现按安装目录用 PowerShell + WMI 找进程，机器上 WMI 慢或被策略限制时会长时间没有反馈，
; 杀不掉时还会弹「无法关闭」重试框，安装看起来就卡在「正在关闭旧版本」。
; 这里按可执行文件名直接 taskkill（不碰 WMI），再确认一次；仍杀不掉通常是旧版本以管理员身份启动，
; 直接给出明确提示并退出，避免装到一半留下坏文件。
!macro customCheckAppRunning
  DetailPrint "正在关闭已运行的 ${PRODUCT_NAME}…"
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  Sleep 700
  nsExec::Exec '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""'
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "旧版 ${PRODUCT_NAME} 还在运行（可能以管理员身份启动）。请从托盘菜单退出后重新运行安装。" /SD IDOK
    Quit
  ${EndIf}

  ; 1.2.x 的卸载器会先跑 PowerShell/WMI 查进程，部分机器上这条命令长时间不返回，
  ; 覆盖安装就会一直停在等它的那几个步骤上。目标目录里已经有旧程序时跳过它的卸载器：
  ; 新安装会覆盖同名文件，并重建快捷方式和卸载项。
  !ifndef BUILD_UNINSTALLER
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $R1 != ""
        DetailPrint "跳过旧版卸载器（直接覆盖安装）"
        DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
        !ifdef UNINSTALL_REGISTRY_KEY_2
          DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
        !endif
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Var AipetKey
Var AipetHandoff

!macro customInit
  StrCpy $AipetHandoff 1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEY=" $AipetKey
  ClearErrors
  ${GetOptions} $R0 "/NOHANDOFF" $R1
  ${IfNot} ${Errors}
    StrCpy $AipetHandoff 0
  ${EndIf}
!macroend

!macro customInstall
  ; 桌宠首次启动读走并删除；用环境变量是为了不受「所有用户」安装的 ShellVarContext 影响
  ${If} $AipetKey != ""
    ReadEnvStr $R2 APPDATA
    CreateDirectory "$R2\${PRODUCT_NAME}"
    FileOpen $0 "$R2\${PRODUCT_NAME}\install-key.txt" w
    FileWrite $0 $AipetKey
    FileClose $0
  ${EndIf}
  ; 只在明确带 /NOHANDOFF 时写；否则留给桌宠首启向导，重装不会覆盖用户已有选择
  ${If} $AipetHandoff == 0
    ReadEnvStr $R2 APPDATA
    CreateDirectory "$R2\${PRODUCT_NAME}"
    FileOpen $0 "$R2\${PRODUCT_NAME}\install-features.txt" w
    FileWrite $0 "handoff=0"
    FileClose $0
  ${EndIf}
!macroend
!endif
