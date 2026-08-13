#!/usr/bin/env bash
# Terminate + relaunch an app on a real iOS device — a FULL process kill and cold start, which is
# what a webview reload cannot give you (OTA rollback watchdogs, boot-path bugs, first-launch state).
#
# Two transports, picked by what the device supports; neither needs Appium/WebDriverAgent:
#   • devicectl (Xcode 15+)  — iOS 17+ ONLY. `xcrun devicectl` is CoreDevice-only and cannot see an
#                              older device AT ALL, which is why this script used to be unusable on
#                              half the test fleet.
#   • go-ios                 — iOS 12–16, over usbmuxd. Provisioned by the editor (Build Support →
#                              go-ios), or `brew install go-ios`, or set MODOKI_GO_IOS.
#
# Usage:
#   engine/scripts/relaunch-ios-app.sh [bundle-id] [device-name-or-id]
#
# Defaults: bundle-id = com.example.otatest (games/ota-test); device = the `device.iosDevicectlId` /
# `device.iosDeviceId` in a project's gitignored project.user.json (MODOKI_PROJECT's, else the only
# project that has one). There is deliberately NO baked-in device default — this script ships in the
# public OSS snapshot, so a real device name here would leak the author's hardware AND silently aim
# a stranger's relaunch at it. Same defect as #103; see docs/engine-oss-publishing.md § "Device ids".

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_ID="${1:-com.example.otatest}"
DEVICE="${2:-}"

# ── Which project's per-machine config holds the device ids ──────────────────────────────────────
# ⚠️ This used to read `$HERE/project.user.json` — a path that HAS NOT EXISTED since #29 made every
# game self-contained. The editor writes `games/<id>/project.user.json`, so the default-device
# lookup silently found nothing and every run without an explicit device died on the error below.
# (Exactly the wrong-path bug the publish-safety scan had, recorded in iosInstallPlan.test.ts.)
# An AMBIGUOUS answer is refused rather than guessed: relaunching the wrong app on the wrong phone
# is the kind of quiet wrong that costs an hour of confused debugging.
read_ids() {
  # $1 = project.user.json path. Prints "<devicectlId>|<udid>".
  # ⚠️ NOT tab-separated: tab is IFS *whitespace*, so bash collapses runs of it and strips a leading
  # one — an empty devicectlId (every iOS <= 16 device) then shifted the UDID into that slot and the
  # script confidently ran `devicectl --device <hardware-udid>`, which fails with CoreDeviceError
  # 1000. A non-whitespace delimiter keeps the empty field empty. Neither id can contain `|`.
  node -e '
    let j = {};
    try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
    const d = j.device ?? {};
    process.stdout.write(`${String(d.iosDevicectlId || "").trim()}|${String(d.iosDeviceId || "").trim()}`);
  ' "$1" 2>/dev/null || true
}

DEVICECTL_ID=""
UDID=""
if [[ -n "$DEVICE" ]]; then
  # An explicitly passed device goes to devicectl, which accepts a name OR either id form. go-ios
  # needs the hardware UDID specifically, so it is only used when that is what we were handed.
  DEVICECTL_ID="$DEVICE"
  [[ "$DEVICE" =~ ^[0-9a-fA-F]{40}$|^[0-9A-F]{8}-[0-9A-F]{16}$ ]] && UDID="$DEVICE"
else
  CANDIDATES=()
  if [[ -n "${MODOKI_PROJECT:-}" ]]; then
    # MODOKI_PROJECT may be repo-relative (games/court) or absolute.
    [[ -f "$MODOKI_PROJECT/project.user.json" ]] && CANDIDATES+=("$MODOKI_PROJECT/project.user.json")
    [[ -f "$HERE/$MODOKI_PROJECT/project.user.json" ]] && CANDIDATES+=("$HERE/$MODOKI_PROJECT/project.user.json")
  else
    # Prefer the project that OWNS this bundle id — different projects legitimately target
    # different phones (here: most name the iPhone Air, Court names the iPhone 8), so scanning
    # them all would refuse as ambiguous for the one question that has an obvious right answer.
    for f in "$HERE"/games/*/project.user.json "$HERE"/demos/*/project.user.json; do
      [[ -f "$f" ]] || continue
      cfg="${f%/project.user.json}/project.config.json"
      [[ -f "$cfg" ]] || continue
      appId="$(node -e '
        let j = {};
        try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
        process.stdout.write(String(j.app?.appId ?? "").trim());
      ' "$cfg" 2>/dev/null || true)"
      [[ "$appId" == "$BUNDLE_ID" ]] && CANDIDATES+=("$f")
    done
    # No project claims that bundle id (an app installed from elsewhere) → fall back to every
    # project, and let the ambiguity check below refuse rather than guess.
    if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
      for f in "$HERE"/games/*/project.user.json "$HERE"/demos/*/project.user.json; do
        [[ -f "$f" ]] && CANDIDATES+=("$f")
      done
    fi
  fi
  SEEN=""
  for f in "${CANDIDATES[@]:-}"; do
    [[ -z "$f" ]] && continue
    IFS='|' read -r c u <<<"$(read_ids "$f")"
    [[ -z "$c$u" ]] && continue
    key="$c|$u"
    if [[ -z "$SEEN" ]]; then
      SEEN="$key"; DEVICECTL_ID="$c"; UDID="$u"; SRC="$f"
    elif [[ "$SEEN" != "$key" ]]; then
      echo "✖ several projects name DIFFERENT iOS devices — say which one you mean." >&2
      echo "  Pass it:  $0 $BUNDLE_ID <udid>" >&2
      echo "  Or set MODOKI_PROJECT=games/<id> to pick that project's configured device." >&2
      exit 1
    fi
  done
  [[ -n "${SRC:-}" ]] && echo "Device ids from: ${SRC#"$HERE"/}"
fi

if [[ -z "$DEVICECTL_ID$UDID" ]]; then
  echo "✖ no iOS device given and none found in any project.user.json." >&2
  echo "  Pass one:  $0 $BUNDLE_ID <udid-or-name>" >&2
  echo "  Or set device.iosDeviceId in the project (Project Settings → Build → This Machine)." >&2
  echo "  List candidates with: xcrun xctrace list devices   (devicectl cannot see iOS <= 16)" >&2
  exit 1
fi

# ── go-ios, if we have one ───────────────────────────────────────────────────────────────────────
# Same resolution order the editor toolchain uses: env override → the editor's provisioned copy →
# PATH. The toolchain path is version-scoped, so glob and take the newest rather than pinning a
# version here that would go stale the first time the editor bumps it.
find_go_ios() {
  if [[ -n "${MODOKI_GO_IOS:-}" && -x "$MODOKI_GO_IOS" ]]; then echo "$MODOKI_GO_IOS"; return; fi
  local newest=""
  for c in "$HOME/Library/Application Support/Modoki/toolchain/go-ios"/*/ios; do
    [[ -x "$c" ]] && { [[ -z "$newest" || "$c" -nt "$newest" ]] && newest="$c"; }
  done
  [[ -n "$newest" ]] && { echo "$newest"; return; }
  command -v ios 2>/dev/null || true
}
GO_IOS="$(find_go_ios)"

echo "Bundle: $BUNDLE_ID"

# devicectl only when the device HAS a devicectl id (a pre-iOS-17 device has none in existence —
# `xcrun devicectl list devices` reports it `unavailable`, with no hardwareProperties.udid at all).
if [[ -n "$DEVICECTL_ID" ]]; then
  echo "Device: $DEVICECTL_ID (devicectl)"
  TMP_APPS="$(mktemp)"
  TMP_PROCS="$(mktemp)"
  trap 'rm -f "$TMP_APPS" "$TMP_PROCS"' EXIT

  # `process terminate` needs a --pid (no --bundle-id support), so resolve it:
  # apps info gives the bundle's install container UUID, then match that
  # container path against the running process list.
  xcrun devicectl device info apps --device "$DEVICECTL_ID" --json-output "$TMP_APPS" >/dev/null
  xcrun devicectl device info processes --device "$DEVICECTL_ID" --json-output "$TMP_PROCS" >/dev/null

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
    xcrun devicectl device process terminate --device "$DEVICECTL_ID" --pid "$PID"
  else
    echo "Not currently running, skipping terminate."
  fi

  echo "Launching..."
  xcrun devicectl device process launch --device "$DEVICECTL_ID" "$BUNDLE_ID"

elif [[ -n "$GO_IOS" ]]; then
  echo "Device: $UDID (go-ios)"
  # No pid dance here — go-ios kills BY BUNDLE ID. `kill` exits non-zero when the app isn't running,
  # which is a normal state for a relaunch, so it must not trip `set -e`.
  echo "Terminating..."
  "$GO_IOS" kill "$BUNDLE_ID" --udid="$UDID" >/dev/null 2>&1 || echo "  (not running — skipping terminate)"
  echo "Launching..."
  # ⚠️ Verify the app is actually UP rather than trusting exit 0. `ios launch` reports the pid of an
  # ALREADY-RUNNING process just as happily as one it started, so a failed kill upstream would make
  # a no-op look like a successful cold restart — the exact false pass that cost this feature two
  # bogus "verified" runs. The process name is the executable's (`App` for a Capacitor game), so
  # match on the pid we were just given instead of guessing a name.
  LAUNCH_PID="$("$GO_IOS" launch "$BUNDLE_ID" --udid="$UDID" 2>&1 | sed -n 's/.*"msg":"Process launched","pid":\([0-9]*\).*/\1/p' | tail -1)"
  if [[ -z "$LAUNCH_PID" ]]; then
    echo "✖ go-ios did not report a launched pid — the device may be locked. Unlock it and retry." >&2
    exit 1
  fi
  if ! "$GO_IOS" ps --udid="$UDID" 2>/dev/null | grep -q "\"Pid\":$LAUNCH_PID,"; then
    echo "✖ launched pid $LAUNCH_PID is not in the process list — the app started and died." >&2
    exit 1
  fi
  echo "Running (pid $LAUNCH_PID)."

else
  echo "✖ this device has no devicectl id (so it is iOS <= 16), and go-ios was not found." >&2
  echo "  Install it from the editor's Build Support dialog, or \`brew install go-ios\`," >&2
  echo "  or point MODOKI_GO_IOS at the binary." >&2
  exit 1
fi

echo "Done."
