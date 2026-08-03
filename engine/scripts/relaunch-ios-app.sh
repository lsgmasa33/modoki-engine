#!/usr/bin/env bash
# Terminate + relaunch an app on a real iOS device via devicectl (Xcode 15+, iOS 17+).
# No Appium/WebDriverAgent needed — devicectl talks to the device directly over
# USB or Wi-Fi (whatever `xcrun devicectl list devices` already shows as "connected").
#
# Usage:
#   engine/scripts/relaunch-ios-app.sh [bundle-id] [device-name-or-id]
#
# Defaults: bundle-id = com.example.otatest (games/ota-test); device = this machine's
# project.user.json `device.iosDevicectlId` (then `iosDeviceId`). There is deliberately
# NO baked-in device default — this script ships in the public OSS snapshot, so a real
# device name here would leak the author's hardware AND silently aim a stranger's
# relaunch at it. Same defect as #103; see docs/engine-oss-publishing.md § "Device ids".

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_ID="${1:-com.example.otatest}"
DEVICE="${2:-}"

if [[ -z "$DEVICE" && -f "$HERE/project.user.json" ]]; then
  DEVICE="$(node -e '
    let j = {};
    try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
    const d = j.device ?? {};
    process.stdout.write(String(d.iosDevicectlId || d.iosDeviceId || "").trim());
  ' "$HERE/project.user.json" 2>/dev/null || true)"
fi

if [[ -z "$DEVICE" ]]; then
  echo "✖ no iOS device given and none found in project.user.json." >&2
  echo "  Pass one:  $0 $BUNDLE_ID \"My iPhone\"" >&2
  echo "  Or set device.iosDevicectlId in project.user.json (Project Settings → Build)." >&2
  echo "  List candidates with: xcrun devicectl list devices" >&2
  exit 1
fi

echo "Device: $DEVICE"
echo "Bundle: $BUNDLE_ID"

TMP_APPS="$(mktemp)"
TMP_PROCS="$(mktemp)"
trap 'rm -f "$TMP_APPS" "$TMP_PROCS"' EXIT

# `process terminate` needs a --pid (no --bundle-id support), so resolve it:
# apps info gives the bundle's install container UUID, then match that
# container path against the running process list.
xcrun devicectl device info apps --device "$DEVICE" --json-output "$TMP_APPS" >/dev/null
xcrun devicectl device info processes --device "$DEVICE" --json-output "$TMP_PROCS" >/dev/null

PID="$(python3 - "$TMP_APPS" "$TMP_PROCS" "$BUNDLE_ID" <<'PYEOF'
import json, sys
apps_path, procs_path, bundle_id = sys.argv[1:4]
apps = json.load(open(apps_path))["result"]["apps"]
app = next((a for a in apps if a.get("bundleIdentifier") == bundle_id), None)
if not app:
    sys.exit(0)
container = app["url"].split("/Bundle/Application/")[1].split("/")[0]
procs = json.load(open(procs_path))["result"]["runningProcesses"]
proc = next((p for p in procs if f"/Bundle/Application/{container}/" in (p.get("executable") or "")), None)
print(proc["processIdentifier"] if proc else "")
PYEOF
)"

if [[ -n "$PID" ]]; then
  echo "Terminating (pid $PID)..."
  xcrun devicectl device process terminate --device "$DEVICE" --pid "$PID"
else
  echo "Not currently running, skipping terminate."
fi

echo "Launching..."
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"

echo "Done."
