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
