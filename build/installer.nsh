; electron-builder NSIS 扩展：多一页「DeepSeek Key + 选择要部署技能的工具」
; 静默安装参数：/S /D=<目录> /KEY=<Key> /NOSKILLS /SKILLSROOT=<代替用户目录，测试用>
!ifndef BUILD_UNINSTALLER
!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; 「浏览」选完目录后 NSIS 会把这里的末级目录名补进输入框（实际路径仍由 electron-builder 运行时设定）
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

; 能装技能的工具：id、用户目录下的文件夹（技能放其下 skills\）、显示名。目录同 Skills Manager
!macro AipetTools M
  !insertmacro ${M} Claude ".claude" "Claude Code"
  !insertmacro ${M} Codex ".codex" "Codex"
  !insertmacro ${M} Dsh ".dsh" "DeepSeek Harness"
  !insertmacro ${M} Gemini ".gemini" "Gemini CLI"
  !insertmacro ${M} Cursor ".cursor" "Cursor"
  !insertmacro ${M} Copilot ".copilot" "GitHub Copilot"
  !insertmacro ${M} Qwen ".qwen" "Qwen Code"
  !insertmacro ${M} CodeBuddy ".codebuddy" "CodeBuddy"
  !insertmacro ${M} WorkBuddy ".workbuddy" "WorkBuddy"
  !insertmacro ${M} ZCode ".zcode" "ZCode"
  !insertmacro ${M} Trae ".trae-cn" "TRAE CN"
  !insertmacro ${M} Junie ".junie" "Junie"
  !insertmacro ${M} OpenClaw ".openclaw" "OpenClaw"
!macroend

Var AipetKey
Var AipetSkillsRoot
Var AipetKeyCtl
Var AipetKeyMsg
!macro AipetToolVars id dir label
  Var Aipet${id}
  Var Aipet${id}Ctl
!macroend
!insertmacro AipetTools AipetToolVars

!macro AipetToolOn id dir label
  StrCpy $Aipet${id} 1
!macroend
!macro AipetToolOff id dir label
  StrCpy $Aipet${id} 0
!macroend

!macro customInit
  !insertmacro AipetTools AipetToolOn
  ReadEnvStr $AipetSkillsRoot USERPROFILE
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEY=" $AipetKey
  ClearErrors
  ${GetOptions} $R0 "/NOSKILLS" $R1
  ${IfNot} ${Errors}
    !insertmacro AipetTools AipetToolOff
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/SKILLSROOT=" $R1
  ${IfNot} ${Errors}
    StrCpy $AipetSkillsRoot $R1
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom AipetPageCreate AipetPageLeave
!macroend

; 只列出本机检测到的工具，三列排开；$R8 是已放了几个
!macro AipetToolBox id dir label
  ${If} ${FileExists} "$AipetSkillsRoot\${dir}\*.*"
    IntOp $R6 $R8 % 3
    IntOp $R6 $R6 * 34
    IntOp $R7 $R8 / 3
    IntOp $R7 $R7 * 13
    IntOp $R7 $R7 + 66
    ${NSD_CreateCheckbox} $R6% $R7u 33% 12u "${label}"
    Pop $Aipet${id}Ctl
    ${If} $Aipet${id} == 1
      ${NSD_Check} $Aipet${id}Ctl
    ${EndIf}
    IntOp $R8 $R8 + 1
  ${EndIf}
!macroend

Function AipetPageCreate
  !insertmacro MUI_HEADER_TEXT "可选设置" "之后都能在桌宠「设置」里改"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 20u "DeepSeek API Key（用于生成台词、压缩超长会话；不填也能用）："
  Pop $0
  ${NSD_CreatePassword} 0 22u 80% 13u $AipetKey
  Pop $AipetKeyCtl
  ${NSD_CreateButton} 82% 21u 18% 15u "测试"
  Pop $0
  ${NSD_OnClick} $0 AipetTestKey
  ${NSD_CreateLabel} 0 38u 100% 10u ""
  Pop $AipetKeyMsg
  ${NSD_CreateLabel} 0 54u 100% 10u "部署 handoff / takeover 技能到（只列出本机检测到的 AI 工具）："
  Pop $0
  StrCpy $R8 0
  !insertmacro AipetTools AipetToolBox
  ${If} $R8 == 0
    ${NSD_CreateLabel} 0 66u 100% 10u "没检测到支持技能的 AI 工具，跳过。"
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

; 查余额顺便验 Key；Key 走环境变量传给 PowerShell，不进命令行
Function AipetTestKey
  ${NSD_GetText} $AipetKeyCtl $R0
  ${If} $R0 == ""
    ${NSD_SetText} $AipetKeyMsg "先填 Key"
    Return
  ${EndIf}
  ${NSD_SetText} $AipetKeyMsg "测试中…"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\keytest.ps1" "${BUILD_RESOURCES_DIR}\keytest.ps1"
  System::Call 'Kernel32::SetEnvironmentVariable(t "AIPET_KEY", t R0)'
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\keytest.ps1"'
  Pop $R1
  Pop $R2
  System::Call 'Kernel32::SetEnvironmentVariable(t "AIPET_KEY", p 0)'
  ${If} $R1 == 0
    ${NSD_SetText} $AipetKeyMsg "✓ 可用，余额 $R2"
  ${ElseIf} $R1 == 2
    ${NSD_SetText} $AipetKeyMsg "✗ Key 无效（DeepSeek 返回 401）"
  ${ElseIf} $R1 == 4
    ${NSD_SetText} $AipetKeyMsg "✗ 连不上 api.deepseek.com，检查网络"
  ${ElseIf} $R1 == 5
    ${NSD_SetText} $AipetKeyMsg "✗ 不像 DeepSeek Key（应以 sk- 开头）"
  ${Else}
    ${NSD_SetText} $AipetKeyMsg "✗ 测试失败（代码 $R1）"
  ${EndIf}
FunctionEnd

; 没列出来的工具没有控件，状态保持默认；安装时还会再查一次目录
!macro AipetToolRead id dir label
  ${If} $Aipet${id}Ctl != ""
    ${NSD_GetState} $Aipet${id}Ctl $Aipet${id}
  ${EndIf}
!macroend

Function AipetPageLeave
  ${NSD_GetText} $AipetKeyCtl $AipetKey
  !insertmacro AipetTools AipetToolRead
FunctionEnd

!macro AipetSkillsTo id dir label
  ${If} $Aipet${id} == ${BST_CHECKED}
  ${AndIf} ${FileExists} "$AipetSkillsRoot\${dir}\*.*"
    CreateDirectory "$AipetSkillsRoot\${dir}\skills"
    CopyFiles /SILENT "$INSTDIR\resources\skills\*.*" "$AipetSkillsRoot\${dir}\skills"
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
  !insertmacro AipetTools AipetSkillsTo
!macroend
!endif
