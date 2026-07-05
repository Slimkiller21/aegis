; Guarded uninstall for Aegis.
;
; The uninstaller refuses to run unless the user first authorized removal from
; inside the app (Settings -> Allow uninstall, which requires the accountability
; partner's password). That in-app step writes the flag below and stops Aegis +
; its watchdog. A normal launch of Aegis deletes the flag, so it is valid only
; while the app is intentionally stopped for removal — no casual uninstalling.

!macro customUnInstall
  ; userData lives at %APPDATA%\nsfw-guard (package name kept across the rebrand)
  IfFileExists "$APPDATA\nsfw-guard\uninstall-allowed" aegis_allowed aegis_locked

  aegis_locked:
    MessageBox MB_ICONSTOP "Uninstalling Aegis is locked.$\n$\nOpen Aegis, go to Settings, and choose 'Allow uninstall' — your accountability partner's password is required. Then run this uninstaller again."
    Abort

  aegis_allowed:
    ; make sure the app and its watchdog are fully stopped so files aren't locked
    nsExec::Exec 'taskkill /F /T /IM "Aegis.exe"'
    Sleep 1000
    Delete "$APPDATA\nsfw-guard\uninstall-allowed"
!macroend
