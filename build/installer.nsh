; Custom NSIS include, auto-picked up by electron-builder (nsis.include defaults to
; build/installer.nsh — see electron-builder.yml's nsis: block, which sets no override).
;
; Grants regular Users write access to ONE subfolder of the install tree:
; resources/app.asar.unpacked/node_modules/.vite-temp. Everything else under the install
; directory stays as restrictive as the OS/installer normally makes it — this is a scoped
; exception, not a blanket loosening.
;
; Why this exists (bug vSlzfZLr7pIX5Yw0RSSe, docs/windows.md "Packaged-app bugs" #5): Vite's
; default `bundle` config loader esbuild-bundles vite.config.ts and writes the result to
; `<nearest node_modules>/.vite-temp/<hash>.mjs` on every `vite build` — hardcoded, with no
; CLI flag or env var to redirect it (read straight from
; node_modules/vite/dist/node/chunks/node.js's loadConfigFromBundledFile). For an admin-
; elevated per-machine install (anyone who browses the installer to `C:\Program Files\...`
; — `nsis.perMachine` is false, but `allowToChangeInstallationDirectory` lets a user pick an
; elevation-requiring path anyway), that directory is read-only to the running, UNELEVATED
; app, so every `vite build` crashed with EPERM before the config even loaded — see the
; commit history around vSlzfZLr7pIX5Yw0RSSe for the two things that were tried and reverted
; (`--configLoader runner` breaks build-time dynamic imports; `--configLoader native` can't
; resolve this repo's extension-less imports).
;
; The INSTALLER runs elevated exactly when it needs to (UAC.nsh, already wired by
; electron-builder's nsis target) — that is the one moment with the rights to grant this.
; customInstall fires from installSection.nsh AFTER installApplicationFiles, so $INSTDIR is
; fully populated by the time this runs.
!macro customInstall
  CreateDirectory "$INSTDIR\resources\app.asar.unpacked\node_modules\.vite-temp"
  ; S-1-5-32-545 = BUILTIN\Users — the well-known SID, not the localized group name (avoids
  ; breaking on a non-English Windows install). (OI)(CI) = Object Inherit + Container
  ; Inherit, so files vite writes INSIDE this folder (a fresh timestamped .mjs per build)
  ; inherit the grant automatically. M = Modify (read/write/delete/execute) — enough for a
  ; scratch temp dir, short of Full Control.
  nsExec::ExecToLog 'icacls "$INSTDIR\resources\app.asar.unpacked\node_modules\.vite-temp" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend
