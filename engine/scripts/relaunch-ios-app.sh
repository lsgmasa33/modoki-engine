#!/usr/bin/env bash
# Terminate + relaunch an app on a real iOS device via devicectl (Xcode 15+, iOS 17+).
# No Appium/WebDriverAgent needed — devicectl talks to the device directly over
# USB or Wi-Fi (whatever `xcrun devicectl list devices` already shows as "connected").
#
# Usage:
#   engine/scripts/relaunch-ios-app.sh [bundle-id] [device-name-or-id]
#
# Defaults: bundle-id = com.example.otatest (games/ota-test), device = "Masaki iPhone Air"

set -euo pipefail

BUNDLE_ID="${1:-com.example.otatest}"
DEVICE="${2:-Masaki iPhone Air}"

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
