; Custom NSIS include, auto-picked up by electron-builder (nsis.include defaults to
; build/installer.nsh — see electron-builder.yml's nsis: block, which sets no override).
;
; This used to grant regular Users write access to one subfolder of the install tree —
; resources/app.asar.unpacked/node_modules/.vite-temp — for an admin-elevated per-machine
; install (anyone who browses the installer to `C:\Program Files\...`; `nsis.perMachine` is
; false, but `allowToChangeInstallationDirectory` lets a user pick an elevation-requiring path
; anyway). Vite's default `bundle` config loader used to write its compiled config there on
; every `vite build`, and that directory is read-only to the running, unelevated app (bug
; vSlzfZLr7pIX5Yw0RSSe, docs/windows.md "Packaged-app bugs" #5).
;
; REMOVED (#326, 2026-08-27): the write itself is gone at the source — a packaged editor now
; ships an esbuild-bundled `engine/vite.config.cjs` (`engine/scripts/stage-vite-config.cjs`,
; `chooseViteConfig()`), and Vite's CJS config-loader branch compiles it in memory instead of
; writing to disk, so `.vite-temp` is never created. Measured on this exact scenario: a real
; Build press (`demos/forest-camp`, which has a rigged model — the case a wrong re-fix like
; `--configLoader runner` would break) from a packaged editor installed to `C:\Program Files\
; Modoki Editor` with this grant removed produced zero files under `.vite-temp` and no EPERM.
; See `engine/scripts/build-web.mjs`'s comment on the `vite build` call for the fuller history
; of what was tried and reverted before this.
;
; Left as an empty include (rather than deleted) because electron-builder's nsis.include
; defaults to this exact path with no config change needed — removing the file would be a
; second, easy-to-miss place this class of bug could quietly come back from if a future
; customInstall need is added here without re-reading this comment first.
!macro customInstall
!macroend
