; Per-user Open With discovery that never makes MCode a default handler.
; Windows picks an implicit default from OpenWithProgids candidates (even with
; AllowSilentDefaultTakeOver when MCode is the only one), so this installer only
; lists the executable through Applications\<exe>\SupportedTypes. It never
; writes UserChoice, extension defaults or Explorer MRU entries.
!include "file-associations.generated.nsh"
!define MCODE_DOCUMENT_PROGID "${APP_ID}.Document"
!define MCODE_APPLICATION_KEY "Software\Classes\Applications\${PRODUCT_NAME}.exe"

!macro MCodeRegisterSupportedType EXT
  WriteRegStr HKCU "${MCODE_APPLICATION_KEY}\SupportedTypes" ".${EXT}" ""
!macroend

!macro MCodeUnregisterExtension EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${MCODE_DOCUMENT_PROGID}"
  ; DeleteRegKey /ifempty only checks subkeys, so it would also drop other
  ; applications' candidates. Delete the key only when no value remains.
  Push $R9
  ClearErrors
  EnumRegValue $R9 HKCU "Software\Classes\.${EXT}\OpenWithProgids" 0
  ${If} ${Errors}
    DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  ${EndIf}
  ClearErrors
  Pop $R9
!macroend

!macro MCodeRegisterFileHandlers
  ; Remove candidates written by earlier versions on both install and upgrade:
  ; a lone candidate becomes the implicit default despite any opt-out marker.
  !insertmacro MCodeForEachFileType MCodeUnregisterExtension
  DeleteRegValue HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "AllowSilentDefaultTakeOver"
  ; Refresh the stable ProgID only for defaults the user already chose explicitly.
  ; Do not touch UserChoice or repair historical defaults.
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "" "${PRODUCT_NAME} Document"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}" "FriendlyTypeName" "${PRODUCT_NAME} Document"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\DefaultIcon" "" '"$INSTDIR\${PRODUCT_NAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\shell\open" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}\shell\open\command" "" '"$INSTDIR\${PRODUCT_NAME}.exe" --open-file "%1"'
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
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}" "MCodeAppId" "${APP_ID}"
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}" "FriendlyAppName" "${PRODUCT_NAME}"
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}\DefaultIcon" "" '"$INSTDIR\${PRODUCT_NAME}.exe",0'
    WriteRegStr HKCU "${MCODE_APPLICATION_KEY}\shell\open\command" "" '"$INSTDIR\${PRODUCT_NAME}.exe" --open-file "%1"'
    ; SupportedTypes lists MCode under "Choose another app" without joining
    ; implicit default selection. Rebuild it so removed extensions disappear.
    ; https://learn.microsoft.com/en-us/windows/win32/shell/app-registration
    DeleteRegKey HKCU "${MCODE_APPLICATION_KEY}\SupportedTypes"
    !insertmacro MCodeForEachFileType MCodeRegisterSupportedType
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro MCodeUnregisterFileTypes
  ; Keep handlers available while the updater replaces the application files.
  ${IfNot} ${isUpdated}
    !insertmacro MCodeForEachFileType MCodeUnregisterExtension
    DeleteRegKey HKCU "Software\Classes\${MCODE_DOCUMENT_PROGID}"
    ; A same-named executable from another installation may own this shared key.
    ; Deleting it also removes SupportedTypes.
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
