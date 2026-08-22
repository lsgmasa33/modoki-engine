/** Build → iOS/Android target picker (#170) — the PURE half.
 *
 *  The Build menu used to build for whatever device id was hand-typed into Project Settings, and
 *  said nothing about which one that was. These functions turn `/api/device/list` plus the current
 *  `user.device.*` ids into the rows the menu renders: what is attached, which one is selected, who
 *  else holds it, and what picking a row must write back.
 *
 *  Pure on purpose — the whole decision surface (which row is checked, what an empty listing says,
 *  what patch a pick produces) is testable without a phone, a backend, or a mounted editor. The
 *  wiring that fetches the listing and posts the patch stays in `setup.ts`.
 */

import type { DeviceListReply, IosDeviceRow, AndroidDeviceRow } from '@modoki/engine/editor';
import { androidRowLabel, androidRowNote } from '@modoki/engine/editor';

/** Why a build must not start right now, or null when it may. `null` state = the store has not
 *  reported yet, which is not a reason to refuse.
 *
 *  This is the CLIENT half of the guard, and it is still worth having: `runBuild` fires an SSE
 *  request per call, and a native OS menu is NOT blocked by the DOM progress modal — so the modal only
 *  *looks* like it is holding the door. Before #170 that took a deliberate second trip through the
 *  menu; now every device row is a build, so "wrong phone — click the right one" is the natural
 *  gesture and it would put two `xcodebuild`/gradle pipelines on the same project dir at once,
 *  interleaving `npm run build` output and `cap sync` into one `ios/`. Both would also report into
 *  the single shared `buildStatus`, so the progress modal would show a blend of the two.
 *
 *  Since #173 `/api/build` ALSO takes a server-side lock (this comment used to say it took none),
 *  so a request that gets past this menu — `modoki_build`, or a second editor window — is refused
 *  by the route instead of interleaving. Refusing here first is still better UX: the human gets a
 *  menu that does nothing rather than a failed build in a modal. */
export function buildRefusal(status: { active: boolean; failed: boolean } | null): string | null {
  if (!status?.active) return null;
  // A FAILED build is finished — its modal just hasn't been dismissed yet. Refusing there would
  // mean the fix for a broken build is "close a dialog first", which is a worse trap than the one
  // this guard exists to prevent.
  if (status.failed) return null;
  return 'A build is already running — wait for it to finish (nothing can cancel it) before starting another.';
}

/** Why a device pick must be refused right now, or null when it may proceed.
 *
 *  `user.device.*` has TWO writers since #170, and they write differently: this menu sends a
 *  PARTIAL patch, while the Project Settings dialog snapshots the whole config when it OPENS
 *  (`ProjectSettingsDialog`'s `draft`, loaded once) and posts that entire snapshot on Save. So a
 *  pick made while that dialog sits open is silently reverted the moment the user saves it —
 *  including when they only meant to edit the app name — and the Build menu then re-reads disk and
 *  quietly agrees with the stale value. A lost update nobody is told about is worse than a refusal
 *  that names the reason, and the fix is one click away (close the dialog). */
export function pickRefusal(projectSettingsOpen: boolean): string | null {
  return projectSettingsOpen
    ? 'Close Project Settings first — saving it would write back the device it had when it opened, silently undoing this pick.'
    : null;
}

/** The device ids the build actually reads (`project.user.json` → `user.device`). */
export interface DeviceTarget {
  iosDeviceId: string;
  iosDevicectlId: string;
  androidDeviceId: string;
}

/** A patch for `user.device` — only the keys a pick changes, ready to POST as
 *  `{user:{device:patch}}` to /api/project-settings (which deep-merges). */
export type DeviceTargetPatch = Partial<DeviceTarget>;

export interface TargetRow {
  label: string;
  /** This row IS the current target. Always present so the menu reserves the check gutter and the
   *  rows don't shift as the selection moves. */
  checked: boolean;
  /** Nothing to pick (an explanatory row on an empty listing). */
  disabled?: boolean;
  /** What to write when picked; absent on a disabled explanation row. */
  patch?: DeviceTargetPatch;
}

/** How an iOS row will be installed, spelled out in the row itself — this is the single most
 *  useful thing the old menu could not tell you. `devicectl` installs and launches hands-free on
 *  iOS 17+; everything below it (every pre-iPhone-X handset, which only `xctrace` can see) is
 *  hands-free through go-ios, which the build provisions on demand.
 *
 *  This row used to read "Xcode handoff, ⌘R", and that was the whole defect: a legacy device
 *  genuinely could not be installed to from the editor. Naming the TOOL rather than just saying
 *  "hands-free" keeps the two paths distinguishable when one of them misbehaves — they are
 *  different programs talking to the phone in different ways. The label describes the PLAN; if
 *  go-ios can't be provisioned the build still falls back to the handoff and says so in the log. */
const iosInstallNote = (d: IosDeviceRow): string => (d.devicectl ? 'hands-free install' : 'hands-free install (go-ios)');

/** Who holds a device, or null when nobody does. A claim is the DEBUG LEASE, not the hardware: a
 *  build can install to a phone another clone is debugging, so this annotates and never disables.
 *  Your own clone's claim is not worth reporting back at you (same rule as the AI panel's rows). */
function claimNote(claim: IosDeviceRow['claim'], selfClone?: string): string | null {
  if (!claim) return null;
  if (claim.clone === selfClone) return null;
  const parts = claim.clone.split(/[\\/]/).filter(Boolean);
  return `debugged by ${parts[parts.length - 1] ?? claim.clone}`;
}

const withNotes = (base: string, notes: (string | null)[]): string => {
  const kept = notes.filter((n): n is string => !!n);
  return kept.length ? `${base} — ${kept.join(', ')}` : base;
};

/** The iOS rows. A device the listing cannot see but that IS the configured target still gets a row
 *  (checked, marked not-attached) rather than vanishing: a hand-typed id, or a phone that is simply
 *  unplugged, is still what the next build would use, and a menu that showed nothing checked would
 *  be lying about that. */
export function iosTargetRows(list: DeviceListReply | null, target: DeviceTarget, platform?: string): TargetRow[] {
  // Same gate as the iOS build item itself: a KNOWN non-darwin host (from the Electron preload)
  // can never build iOS, while an unknown platform — the non-Electron web editor — is left alone
  // rather than told it is on the wrong OS.
  if (platform && platform !== 'darwin') {
    return [{ label: 'iOS builds need macOS', checked: false, disabled: true }];
  }
  // "Not read yet / could not be read" is NOT "no phone attached", and the fix is different for
  // each — a listing that never arrived sends the user to unplug and replug hardware that was
  // fine all along. The Android half already draws this distinction for a missing adb.
  if (!list) {
    return [
      { label: 'Device list not loaded yet — use Refresh devices', checked: false, disabled: true },
      // The configured target still gets its row: it is what the next build would use, and the
      // rule that a menu never shows nothing checked does not lapse just because the listing
      // failed.
      ...(target.iosDeviceId ? [{ label: `${target.iosDeviceId} — current target`, checked: true, disabled: true }] : []),
    ];
  }
  const devices = list.ios;
  const rows: TargetRow[] = devices.map((d) => ({
    label: withNotes(
      `${d.name}${d.osVersion ? ` (iOS ${d.osVersion})` : ''}`,
      [iosInstallNote(d), claimNote(d.claim, list?.self?.clone)],
    ),
    checked: d.udid === target.iosDeviceId,
    // Fill BOTH ids from one pick — `iosDevicectlId` is what flips the build from an Xcode handoff
    // to a hands-free install, and it must be CLEARED for a device devicectl cannot drive, or the
    // build plans an install that fails on the phone rather than at the point of choice.
    //
    // Both ids get the HARDWARE UDID, even though devicectl's own listing also carries a different
    // CoreDevice `identifier` (a `FACEFEED-…` GUID) that hand-written configs on this machine used.
    // Measured on real hardware (2026-08-08): `xcrun devicectl device info details --device <id>`
    // resolves the SAME phone for either form. The UDID is what `xcodebuild -destination` requires
    // and is the only id the parse keeps, so one id serves both fields.
    patch: { iosDeviceId: d.udid, iosDevicectlId: d.devicectl ? d.udid : '' },
  }));
  if (target.iosDeviceId && !devices.some((d) => d.udid === target.iosDeviceId)) {
    rows.push({ label: `${target.iosDeviceId} — not attached`, checked: true, disabled: true });
  }
  if (!rows.length) {
    return [{ label: 'No iOS device paired — plug one in and unlock it', checked: false, disabled: true }];
  }
  return rows;
}

/** The Android rows. The FIRST row is always "Default (first adb device)" — an empty
 *  `androidDeviceId` means "whatever adb picks" today, and a picker that could only ever set a
 *  concrete serial would quietly destroy that meaning for anyone relying on it. */
export function androidTargetRows(list: DeviceListReply | null, target: DeviceTarget): TargetRow[] {
  const rows: TargetRow[] = [
    { label: 'Default (first adb device)', checked: !target.androidDeviceId, patch: { androidDeviceId: '' } },
  ];
  if (!list) {
    // Same distinction as the iOS half: no listing is not the same claim as no devices.
    rows.push({ label: 'Device list not loaded yet — use Refresh devices', checked: false, disabled: true });
    if (target.androidDeviceId) rows.push({ label: `${target.androidDeviceId} — current target`, checked: true, disabled: true });
    return rows;
  }
  if (!list.adb.present) {
    // adb missing and "no phones attached" are different problems with different fixes — say which.
    rows.push({ label: list.note ?? 'adb is not installed — see Build Support', checked: false, disabled: true });
    return rows;
  }
  const devices: AndroidDeviceRow[] = list?.android ?? [];
  for (const d of devices) {
    rows.push({
      label: withNotes(androidRowLabel(d), [
        // `androidRowNote` reports its own claim wording; pass this backend's clone so the device
        // THIS editor is debugging doesn't read as a foreign collision.
        d.usable ? null : androidRowNote(d, list?.self?.clone),
        claimNote(d.claim, list?.self?.clone),
      ]),
      checked: d.serial === target.androidDeviceId,
      // An `unauthorized`/`offline` device is still selectable: the state is fixable ON THE PHONE
      // (trust this computer / re-plug), and refusing the pick would send the user back through
      // this menu after they fix it rather than letting them set the target now.
      patch: { androidDeviceId: d.serial },
    });
  }
  if (target.androidDeviceId && !devices.some((d) => d.serial === target.androidDeviceId)) {
    rows.push({ label: `${target.androidDeviceId} — not attached`, checked: true, disabled: true });
  }
  return rows;
}

/** The parent item's suffix — what the Build menu says it will do, without opening the submenu.
 *  Names the DEVICE when the listing knows it, falls back to the raw id (a hand-typed or unplugged
 *  one), and says "no device set" rather than showing an empty arrow. */
export function iosTargetSummary(list: DeviceListReply | null, target: DeviceTarget): string {
  if (!target.iosDeviceId) return 'no device set';
  const found = (list?.ios ?? []).find((d) => d.udid === target.iosDeviceId);
  return found ? found.name : target.iosDeviceId;
}

export function androidTargetSummary(list: DeviceListReply | null, target: DeviceTarget): string {
  if (!target.androidDeviceId) return 'default adb device';
  const found = (list?.android ?? []).find((d) => d.serial === target.androidDeviceId);
  return found?.name ?? found?.model ?? target.androidDeviceId;
}
