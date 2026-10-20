; Diagnostic-only hooks used by the pinned app-builder-lib template patch.
; Preserve registers, stack and NSIS error flag: logging must not decide whether
; an install/uninstall succeeds. No process queries, waits or retries are added.
!macro customInstallerLog MESSAGE
  Push "${MESSAGE}"
  !ifdef BUILD_UNINSTALLER
    Call un.MavisInstallerLog
  !else
    Call MavisInstallerLog
  !endif
!macroend

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !define MAVIS_LOG_FUNCTION "un.MavisInstallerLog"
  !else
    !define MAVIS_LOG_FUNCTION "MavisInstallerLog"
  !endif

  Function ${MAVIS_LOG_FUNCTION}
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    ; Save the incoming error flag before performing any filesystem operation.
    IfErrors 0 +3
      StrCpy $5 1
      Goto +2
    StrCpy $5 0
    ClearErrors

    ReadEnvStr $1 LOCALAPPDATA
    StrCmp $1 "" mavis_log_done
    StrCpy $1 "$1\MiniMax\installer-logs"
    CreateDirectory "$1"
    System::Call 'kernel32::GetCurrentProcessId() i.r3'
    ; FILETIME -> Unix milliseconds (avoid locale-specific timestamps).
    System::Call 'kernel32::GetSystemTimeAsFileTime(*l.r2)'
    System::Int64Op $2 / 10000
    Pop $2
    System::Int64Op $2 - 11644473600000
    Pop $2
    FileOpen $4 "$1\nsis-${APP_ID}-${VERSION}-$3.log" a
    IfErrors mavis_log_done
    ; FileOpen a preserves contents but starts at offset zero (NSIS semantics).
    FileSeek $4 0 END
    IfErrors mavis_log_close
    FileWrite $4 "ts_ms=$2 pid=$3 version=${VERSION} nsis_error=$5 $0$\r$\n"
    mavis_log_close:
    FileClose $4

    mavis_log_done:
    StrCmp $5 1 0 +3
      SetErrors
      Goto +2
    ClearErrors
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
  !undef MAVIS_LOG_FUNCTION
!macroend
