; Per-user Open With candidates, excluded from implicit default-handler selection.
; Keep the stable ProgID and never change the user's explicit default choice.
!include "file-associations.generated.nsh"
!define MCODE_DOCUMENT_PROGID "${APP_ID}.Document"
!define MCODE_APPLICATION_KEY "Software\Classes\Applications\${PRODUCT_NAME}.exe"

!macro MCodeRegisterExtension EXT
  WriteRegNone HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${MCODE_DOCUMENT_PROGID}"
!macroend

!macro MCodeUnregisterExtension EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${MCODE_DOCUMENT_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro MCodeRegisterFileHandlers
  ; Register the opt-out before exposing candidates, on both install and upgrade.
  ; Despite its name, this REG_NONE keeps Open With visibility without implicit defaults.
  ; https://learn.microsoft.com/en-us/windows/win32/shell/fa-progids
  WriteRegNone HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "AllowSilentDefaultTakeOver"
  ; Refresh the stable handler. Do not touch UserChoice or repair historical defaults.
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "" "${PRODUCT_NAME} Document"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "FriendlyTypeName" "${PRODUCT_NAME} Document"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\DefaultIcon" "" '"$INSTDIR\${PRODUCT_NAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\shell\open" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\shell\open\command" "" '"$INSTDIR\${PRODUCT_NAME}.exe" --open-file "%1"'
  ; Supply the marker when the user explicitly chooses the executable in Open With.
  ; Same-named executables share this key: preserve another installation's handler.
  Push $R0
  Push $R1
  Push $R2
  ReadRegStr $R0 HKCU "${MCODE_APPLICATION_KEY}\shell\open\command" ""
  ReadRegStr $R1 HKCU "${MCODE_APPLICATION_KEY}" "MCodeAppId"
  ; A legacy manual Open With entry may point to this exact install but omit
  ; --open-file and the ownership marker. Adopt only that unambiguous case;
  ; preserve unmarked commands pointing elsewhere.
  StrCpy $R2 '"$INSTDIR\${PRODUCT_NAME}.exe" "%1"'
  ${If} $R1 == ""
  ${AndIf} $R0 == $R2
    StrCpy $R1 "${APP_ID}"
  ${EndIf}
  ${If} $R0 == ""
  ${OrIf} $R1 == "${APP_ID}"
    ; Type-specific discovery uses the protected ProgID, not SupportedTypes.
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}" "MCodeAppId" "${APP_ID}"
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}" "FriendlyAppName" "${PRODUCT_NAME}"
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}\DefaultIcon" "" '"$INSTDIR\${PRODUCT_NAME}.exe",0'
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}\shell\open\command" "" '"$INSTDIR\${PRODUCT_NAME}.exe" --open-file "%1"'
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
  !insertmacro MCodeForEachFileType MCodeRegisterExtension
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro MCodeUnregisterFileTypes
  ; Keep handlers available while the updater replaces the application files.
  ${IfNot} ${isUpdated}
    !insertmacro MCodeForEachFileType MCodeUnregisterExtension
    DeleteRegKey HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}"
    ; A same-named executable from another installation may own this shared key.
    Push $R0
    Push $R1
    ReadRegStr $R0 HKCU "${MCODE_APPLICATION_KEY}\shell\open\command" ""
    ReadRegStr $R1 HKCU "${MCODE_APPLICATION_KEY}" "MCodeAppId"
    ${If} $R0 == '"$INSTDIR\${PRODUCT_NAME}.exe" --open-file "%1"'
    ${AndIf} $R1 == "${APP_ID}"
      DeleteRegKey HKCU "${MCODE_APPLICATION_KEY}"
    ${EndIf}
    Pop $R1
    Pop $R0
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
