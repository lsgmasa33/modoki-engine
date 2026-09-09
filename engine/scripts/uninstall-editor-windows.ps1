<#
.SYNOPSIS
  Clean-uninstall the packaged "Modoki Editor" (Windows) for a fresh install test.

.DESCRIPTION
  The Windows analog of wiping the mac .app + its ~/Library data before re-installing.
  Removes, in order:
    1. any running "Modoki Editor" process (only with -KillRunning),
    2. the installed app via its silent NSIS uninstaller (+ its HKCU Uninstall entry),
    3. leftover install dir  %LOCALAPPDATA%\Programs\Modoki Editor,
    4. packaged userData     %APPDATA%\Modoki Editor,
    5. (with -IncludeDevData) the DEV-editor userData %APPDATA%\modoki-app,
       which `npm run dev` writes (last project, panel layout, prefs).
  Idempotent: safe to run when nothing is installed. PowerShell 5.1+ or pwsh.
  ASCII-only on purpose: Windows PowerShell 5.1 misreads non-ASCII in a UTF-8
  (no-BOM) .ps1 and fails to parse.

.PARAMETER IncludeDevData
  Also delete %APPDATA%\modoki-app (the dev editor's state). Off by default so a
  clean packaged-install test does not nuke your working dev editor.

.PARAMETER KillRunning
  Force-stop a running "Modoki Editor" before uninstalling (else it warns and continues).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File engine/scripts/uninstall-editor-windows.ps1
  powershell -ExecutionPolicy Bypass -File engine/scripts/uninstall-editor-windows.ps1 -IncludeDevData -KillRunning
#>
param(
  [switch]$IncludeDevData,
  [switch]$KillRunning
)

$ErrorActionPreference = 'Stop'

# Identity - matches electron-builder.yml (productName) + package.json (name).
$productName  = 'Modoki Editor'
$installDir   = Join-Path $env:LOCALAPPDATA "Programs\$productName"
$packagedData = Join-Path $env:APPDATA $productName
$devData      = Join-Path $env:APPDATA 'modoki-app'
$uninstallKeyRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'

function Info($m) { Write-Host "[uninstall] $m" }
function DelPath($p, $label) {
  if (Test-Path -LiteralPath $p) {
    Info "removing $label -> $p"
    Remove-Item -LiteralPath $p -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
}

# 1. Running process?
#
# !! THE PATH HALF IS BROKEN HERE, and the name clause is MASKING it - this is a latent defect,
# not a clean site (#958, corrected by close-out review 2026-09-09).
#
# Measured on `win`: launching through a junction with $installDir spelled as the real path,
# `.Path.StartsWith($installDir)` is FALSE. Windows reports the spelling a process was LAUNCHED
# with and normalises nothing. So the path clause contributes nothing under a junction, and what
# actually finds the process is `$_.ProcessName -eq $productName`.
#
# !! That clause is machine-wide by construction, and this repo has already been burned by it.
# `packagedAppPaths.killPackaged`'s comment records 2026-08-02: an image-name match killed the
# editor the owner was actively using. With -KillRunning, the Stop-Process below hits EVERY
# "Modoki Editor" on the machine - the owner's installed copy, a sibling clone's packaged smoke,
# and every Electron helper (they share the exe name). An earlier version of this comment called
# the site "NOT a defect" and told the reader not to narrow it. That was wrong, and it would have
# frozen the masking in place as though it were a design decision.
#
# The fix is SYMMETRIC with killPackaged's: OR in $installDir's second spelling, so the path
# clause works under a junction and the name clause can stop being load-bearing.
#
# !! AN EARLIER VERSION OF THIS COMMENT NAMED `Resolve-Path` FOR THAT, AND IT DOES NOT WORK.
# Measured here on Windows PowerShell 5.1.26100, against a real junction:
#
#   Resolve-Path -LiteralPath <junction>              -> the JUNCTION, unchanged  (no resolution)
#   [System.IO.Path]::GetFullPath(<junction>)         -> the JUNCTION, unchanged  (no resolution)
#   (Get-Item -LiteralPath <junction> -Force).Target  -> the TARGET               (resolves)
#   (Get-Item ... -Force).LinkType                    -> 'Junction'
#   (Get-Item ... -Force).ResolvedTarget              -> empty on 5.1 (.NET Framework)
#
# So the prescription as written would have produced a "second spelling" identical to the first -
# a no-op wearing a fix's clothes, whose width guard could never even fire. `Get-Item -Force`.Target
# is the one that resolves. That is the correct translation of the JS twin, altPathSpelling.
#
# !! AND .Target SEES A LINK ONLY AT THE FINAL COMPONENT, which is not where the realistic case
# puts it. The "C: is small" move junctions %LOCALAPPDATA%Programs - an ANCESTOR of $installDir -
# so $installDir is not itself a reparse point and .Target returns nothing. A correct fix walks the
# ancestors and substitutes the first reparse point it finds: a real loop, in a script that
# force-kills processes, with no test coverage and no installed app on this machine to drive it.
#
# NOT done here, deliberately; row 2 of #958 carries these measurements and the remaining work.
# The direction a fix CAN close is $installDir spelled through the link with the process launched
# via the target. The reverse is structurally unfixable - you cannot enumerate the aliases pointing
# at a directory (docs/windows.md, "the spelling set is OPEN"; #961, needs-owner).
#
# !! The rule this site taught, stated correctly: a path test that NARROWS a match (an -and, or a
# Where-Object after a Name filter) FAILS CLOSED - it silently drops the target. One that WIDENS
# (an -or) fails OPEN - it does not lose the target, it keeps too many. Neither is safe; they fail
# in opposite directions, and an -or is only "harmless" when the other clause is itself correctly
# scoped. Here it is not.
#
# (ASCII-only, per this file's header. An earlier revision of this comment carried em-dashes and
# emoji. Measured: it still parsed clean on 5.1 - the header's "fails to parse" is stronger than
# what non-ASCII in a COMMENT actually does - but the convention is restored rather than leaned on,
# because the next edit may move this text into a string, where the decoding does matter.)
$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -eq $productName -or ($_.Path -and $_.Path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) }
if ($proc) {
  if ($KillRunning) {
    Info "stopping running $productName (PID $($proc.Id -join ', ')) ..."
    $proc | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  } else {
    Info "WARNING: $productName is running (PID $($proc.Id -join ', ')). Close it, or re-run with -KillRunning."
  }
}

# 2. Silent uninstall - resolve the uninstaller from the registry, fall back to the known path.
$reg = Get-ItemProperty $uninstallKeyRoot -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match [regex]::Escape($productName) } | Select-Object -First 1
$uninst = if ($reg -and $reg.UninstallString) {
  if ($reg.UninstallString -match '^"([^"]+)"') { $Matches[1] } else { ($reg.UninstallString -split '\s+')[0] }
} else {
  Join-Path $installDir "Uninstall $productName.exe"
}
if (Test-Path -LiteralPath $uninst) {
  Info "running silent uninstaller: $uninst"
  Start-Process -FilePath $uninst -ArgumentList '/currentuser', '/S' -Wait
  # NSIS copies itself to %TEMP% and finishes the delete async - wait for the install dir to vanish.
  for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $installDir); $i++) { Start-Sleep -Milliseconds 700 }
} else {
  Info "no installed $productName found (nothing to uninstall)."
}

# 3-5. Belt-and-suspenders removals.
DelPath $installDir   'install dir'
DelPath $packagedData 'packaged userData'
if ($IncludeDevData) { DelPath $devData 'dev-editor userData' } else { Info "keeping dev-editor data ($devData); pass -IncludeDevData to remove it." }

# 6. Report.
Info '=== result ==='
$rows = @(@{p=$installDir;l='install dir'}, @{p=$packagedData;l='packaged userData'})
if ($IncludeDevData) { $rows += @{p=$devData;l='dev-editor userData'} }
foreach ($r in $rows) { Write-Host ("  {0,-20} {1}" -f ($r.l + ':'), $(if (Test-Path -LiteralPath $r.p) { 'STILL EXISTS' } else { 'gone' })) }
$regAfter = Get-ItemProperty $uninstallKeyRoot -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match [regex]::Escape($productName) }
Write-Host ("  {0,-20} {1}" -f 'registry entry:', $(if ($regAfter) { 'STILL PRESENT' } else { 'gone' }))
Info 'done. Now run release\Modoki-Editor-*.exe for a clean install.'
