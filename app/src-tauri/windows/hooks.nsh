; Optional components of the BIForge installer: the server (biforge-server.exe) and the command line (biforge-cli.exe).
; They are not installed unless asked for: tick the question at the end of a normal install, or pass /TOOLS=1 to a silent
; install (BIForge_x64-setup.exe /S /TOOLS=1). The files come from the folder named by the build variable BIFORGE_TOOLS_DIR.
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $R9 "0"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/TOOLS=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == "1"
      StrCpy $R9 "1"
    ${EndIf}
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also install the BIForge server (biforge-server.exe) and the command line (biforge-cli.exe)?$\r$\n$\r$\nThey are only needed to host a shared workspace or to refresh reports without the app. They go into the 'tools' folder of the installation." /SD IDNO IDYES +2
    Goto bf_skip_tools
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $R9 == "1"
    SetOutPath "$INSTDIR\tools"
    File "$%BIFORGE_TOOLS_DIR%\biforge-server.exe"
    File "$%BIFORGE_TOOLS_DIR%\biforge-cli.exe"
    SetOutPath "$INSTDIR"
  ${EndIf}
  bf_skip_tools:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\tools\biforge-server.exe"
  Delete "$INSTDIR\tools\biforge-cli.exe"
  RMDir "$INSTDIR\tools"
!macroend
