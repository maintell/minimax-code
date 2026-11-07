; Custom NSIS script for MiniMax Code
;
; Note: User data directory is NO LONGER deleted on uninstall
; Reason: Windows upgrade process runs uninstall first, which would cause user project data loss
; User data directory: %USERPROFILE%\.minimax (with .mavis as junction/symlink)

!include "file-associations.nsh"
!include "installer-diagnostics.nsh"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro preInit
  ; NSIS' built-in /S flag is case-sensitive. Accept lowercase /s as a
  ; compatibility alias for enterprise deployment scripts that normalize flags.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/s" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ClearErrors

  ; Fix: perMachine=false uses sanitizedName (@mmx-agentelectron)
  ; instead of productName. Override $INSTDIR to use productName.
  ; See: https://github.com/electron-userland/electron-builder/issues/4070
  ;
  ; Preserve user-chosen install location across auto-updates:
  ; read existing registry value first; only fall back to the default path
  ; when no previous installation is found (fresh install).
  ;
  ; /D= support (Lenovo silent install): NSIS sets $INSTDIR from /D= before
  ; .onInit runs. We must detect /D= and skip our override so the caller-
  ; specified path is honoured.  Command: app.exe /S /D=E:\SW
  SetRegView 64

  ; Save original $INSTDIR — already set by NSIS from /D= or InstallDir default
  StrCpy $R9 "$INSTDIR"

  ; Our standard per-user default
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"

  ; --- Detect "/D=" in $CMDLINE (3-char substring scan) ---
  ; NSIS /D= is officially case-sensitive (uppercase) but we accept both cases.
  StrCpy $R8 "0"
  StrLen $R4 $CMDLINE
  IntCmp $R4 3 _preInit_scanEnd _preInit_scanEnd 0
  IntOp $R4 $R4 - 3
  StrCpy $R2 0
  _preInit_scanLoop:
    StrCpy $R3 $CMDLINE 3 $R2
    StrCmp $R3 "/D=" _preInit_foundD 0
    StrCmp $R3 "/d=" _preInit_foundD 0
    IntOp $R2 $R2 + 1
    IntCmp $R2 $R4 _preInit_scanLoop _preInit_scanLoop _preInit_scanEnd
  _preInit_foundD:
    StrCpy $R8 "1"
  _preInit_scanEnd:

  ${If} $R8 == "1"
    ; /D= was specified — restore the NSIS-parsed path, skip registry override
    StrCpy $INSTDIR $R9
  ${Else}
    ; Normal flow: check registry for existing per-user install location
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ; No legacy migrations needed
!macroend

!macro customInstall
  !insertmacro MCodeRegisterFileHandlers
  ; Ensure registry reflects the final (possibly user-chosen) install directory.
  ; Moved from preInit so that $INSTDIR is already resolved — either from the
  ; directory picker (fresh install) or the /S silent-mode default (auto-update).
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser'
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser /S'

  ; --- Desktop shortcut ---
  ; Always create/overwrite the desktop shortcut after install or update.
  ; Electron-builder's silent update mode (isUpdated=true) does NOT recreate
  ; shortcuts, so stale or missing shortcuts would persist without this fix.
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"

  ; --- Windows Firewall rules (best-effort) ---
  ; Allow the Electron app to accept inbound TCP connections on localhost for
  ; the in-process local runtime endpoint used by CLI attach.
  ;
  ; Requires admin privileges — if the installer is not elevated, the commands
  ; fail silently and the Electron runtime fallback handles it on first launch.

  ; Delete-then-add pattern keeps rules idempotent across upgrades.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} - Core"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${PRODUCT_NAME} - Core" dir=in action=allow program="$INSTDIR\${PRODUCT_NAME}.exe" enable=yes profile=any protocol=tcp'

  ; --- Auto-launch after Lenovo quick-install only ---
  ; Only launch when: (1) silent mode, (2) the caller used /D=, and
  ; (3) this is NOT an auto-update (no --updated).
  ; Generic silent installs stay silent for store certification.
  IfSilent 0 _skip_autolaunch
    StrCmp $R8 "1" 0 _skip_autolaunch
    StrCpy $R8 "0"
    StrLen $R4 $CMDLINE
    IntCmp $R4 9 _autolaunch_scanEnd _autolaunch_scanEnd 0
    IntOp $R4 $R4 - 9
    StrCpy $R2 0
    _autolaunch_scanLoop:
      StrCpy $R3 $CMDLINE 9 $R2
      StrCmp $R3 "--updated" _autolaunch_foundUpdated 0
      IntOp $R2 $R2 + 1
      IntCmp $R2 $R4 _autolaunch_scanLoop _autolaunch_scanLoop _autolaunch_scanEnd
    _autolaunch_foundUpdated:
      StrCpy $R8 "1"
    _autolaunch_scanEnd:
    StrCmp $R8 "1" _skip_autolaunch
      Exec '"$INSTDIR\${PRODUCT_NAME}.exe"'
  _skip_autolaunch:
!macroend

!macro customUnInstall
  !insertmacro MCodeUnregisterFileTypes
  ; Remove sentinel files (current .minimax plus legacy compatibility path)
  Delete "$PROFILE\.minimax\.electron-installed"
  Delete "$PROFILE\.mavis\.electron-installed"
  ; Remove firewall rules
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${PRODUCT_NAME} - Core"'
  ; Remove ~/.minimax/bin and legacy ~/.mavis/bin from user PATH (handles both trailing semicolon and end-of-string)
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$p=[Environment]::GetEnvironmentVariable(\"Path\",\"User\"); if($$p){$$bins=@(\"$$env:USERPROFILE\.minimax\bin\",\"$$env:USERPROFILE\.mavis\bin\"); $$n=($$p.Split(\";\") | Where-Object {$$bins -notcontains $$_}) -join \";\"; if($$n -ne $$p){[Environment]::SetEnvironmentVariable(\"Path\",$$n,\"User\")}}"'
!macroend

; =============================================================================
; Directory path validation
; =============================================================================
; MUI_DIRECTORYPAGE_VERIFYONLEAVE makes .onVerifyInstDir fire only when the
; user clicks "Next" on the Directory page (not on every keystroke).
; .onVerifyInstDir is an NSIS built-in callback bound to the Directory page,
; so it works correctly regardless of MUI page insertion order.
!define MUI_DIRECTORYPAGE_VERIFYONLEAVE

Function .onVerifyInstDir
  ; Skip for silent installs (auto-updates don't show any pages)
  IfSilent _verify_done

  ; --- Check if $INSTDIR starts with known elevated paths ---

  ; Program Files (x64)
  StrLen $R2 "$PROGRAMFILES64"
  StrCpy $R1 "$INSTDIR" $R2
  StrCmp $R1 "$PROGRAMFILES64" _elevated_warning

  ; Program Files (x86)
  StrLen $R2 "$PROGRAMFILES"
  StrCpy $R1 "$INSTDIR" $R2
  StrCmp $R1 "$PROGRAMFILES" _elevated_warning

  ; Windows directory
  StrLen $R2 "$WINDIR"
  StrCpy $R1 "$INSTDIR" $R2
  StrCmp $R1 "$WINDIR" _elevated_warning

  ; ProgramData (typically C:\ProgramData — requires elevation for writes)
  ReadEnvStr $R3 ProgramData
  StrLen $R2 $R3
  StrCpy $R1 "$INSTDIR" $R2
  StrCmp $R1 $R3 _elevated_warning

  ; Path is fine — allow
  Goto _verify_done

  _elevated_warning:
    ; BUILD_LOCALE is defined by installer-zh.nsh / installer-en.nsh wrappers
    !if "${BUILD_LOCALE}" == "en"
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "The selected directory requires administrator privileges.$\n\
Installing here may fail and will prevent auto-updates from working.$\n$\n\
Please choose a different directory. Recommended:$\n\
$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    !else
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "您选择的安装目录需要管理员权限，安装到此目录可能会失败，并会导致后续自动更新无法正常进行。$\n$\n\
请选择其他安装目录，推荐：$\n\
$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    !endif
    ; Block installation to privileged directories — user must choose another path
    Abort

  _verify_done:
FunctionEnd
