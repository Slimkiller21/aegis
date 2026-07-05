; Guarded uninstall for Aegis.
;
; The uninstaller refuses to run unless the user first authorized removal from
; inside the app (Settings -> Allow uninstall, which requires the accountability
; partner's password). That in-app step writes the flag below and stops Aegis +
; its watchdog. A normal launch of Aegis deletes the flag, so it is valid only
; while the app is intentionally stopped for removal — no casual uninstalling.
;
; IMPORTANT: this same uninstaller code path also runs automatically whenever a
; newer Aegis installer is run over an existing install (electron-builder's NSIS
; template silently uninstalls the old version before laying down the new one —
; see installUtil.nsh's uninstallOldVersion, which always appends "--updated" to
; that internal call). That is a legitimate upgrade, not a removal, and must NOT
; be blocked — otherwise every future update (including the silent auto-updater)
; would hit this same wall. So we only enforce the authorization flag when this
; is a real standalone uninstall (Control Panel / running Uninstall.exe by hand).

!macro customUnInstall
  ; if "--updated" is present, this is the installer's own chained pre-upgrade
  ; removal step, not a user-initiated uninstall — let it proceed.
  ClearErrors
  ${GetParameters} $R6
  ${GetOptions} $R6 "--updated" $R7
  IfErrors aegis_check_lock aegis_upgrade

  aegis_check_lock:
    ; userData lives at %APPDATA%\nsfw-guard (package name kept across the rebrand)
    IfFileExists "$APPDATA\nsfw-guard\uninstall-allowed" aegis_allowed aegis_locked

  aegis_locked:
    MessageBox MB_ICONSTOP "Uninstalling Aegis is locked.$\n$\nOpen Aegis, go to Settings, and choose 'Allow uninstall' — your accountability partner's password is required. Then run this uninstaller again."
    Abort

  aegis_upgrade:
  aegis_allowed:
    ; stand the Lockdown scheduled task down (app-side removal is the primary
    ; path; this is belt-and-braces if it didn't run)
    nsExec::Exec 'schtasks /Delete /F /TN "AegisGuard"'
    ; make sure the app and its watchdog are fully stopped so files aren't locked
    nsExec::Exec 'taskkill /F /T /IM "Aegis.exe"'
    Sleep 1000
    Delete "$APPDATA\nsfw-guard\uninstall-allowed"
!macroend
