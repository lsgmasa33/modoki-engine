/** Type sidecar for `deviceCommandTargets.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (meant to be requirable from a Claude
 *  Code hook script with no build step), matching the `projectRoots.mjs`/`.d.mts` pattern. */

export interface DeviceCommandTargets {
  /** Namespaced claim ids the command names — `'adb:<serial>'` or `'ios:<udid>'`. Deduped, order preserved. */
  ids: string[];
  /** True if ANY sub-command in the (possibly multi-segment) command could disturb a device. */
  destructive: boolean;
  /** True if a device-touching sub-command names no device (targets "whatever is attached"). */
  untargeted: boolean;
  /** Which device CLIs were seen, in first-seen order — a subset of `'adb'|'devicectl'|'xcodebuild'|'ideviceinstaller'|'go-ios'`. */
  tools: string[];
}

export declare function parseDeviceCommand(command: string): DeviceCommandTargets;
