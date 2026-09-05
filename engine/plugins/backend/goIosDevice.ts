/**
 * WHICH iPhone a host-side go-ios op should talk to — asked of **go-ios itself**.
 *
 * ## Why not `resolveIosDevice`, which already answers this
 *
 * That resolver picks from `listIosDevicesForSelection()` — `xcrun devicectl` merged with `xcrun
 * xctrace`. It is the right oracle for a BUILD (xcodebuild targets a device from that listing) and
 * for WebDriverAgent. It is the wrong one here, and the failure is not theoretical: measured on
 * 2026-08-13, an iPhone 8 that `ios list` reported continuously vanished from the xctrace listing
 * for a stretch of minutes and came back, while go-ios talked to it the whole time. A syslog read
 * resolved through xctrace therefore failed with "matches none of this Mac's paired iOS devices"
 * about a device that was plugged in, awake, and answering.
 *
 * The rule that follows generalises past this bug: **resolve a device through the transport that
 * will be used.** go-ios speaks usbmuxd, which is a different pairing/visibility path from
 * CoreDevice and Instruments, so asking Apple's tools whether go-ios can reach something is asking
 * the wrong party. If `ios list` cannot see it, the op cannot work; if it can, the op should.
 *
 * ## Ambiguity is refused, never guessed
 *
 * Same rule as #149's adb serials and `resolveIosDevice`'s own: with several phones attached, pick
 * by the LEASE's hardware if it identifies one, else refuse and name the candidates. Reading logs
 * or crash reports off the wrong phone produces a confidently wrong answer that looks right.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Bounded like every other device shell-out here. `ios list` is a usbmuxd round trip (~100ms
 *  measured); the ceiling is for a wedged daemon, not for normal slowness. */
const LIST_TIMEOUT_MS = 10_000;

export interface GoIosDevice {
  udid: string;
  /** `ProductType` (`iPhone10,1`) — only fetched when it is needed to break a tie. */
  productType?: string;
  name?: string;
}

/** The UDIDs go-ios can currently reach. Returns [] rather than throwing when nothing is attached —
 *  "no device" is a state the caller reports, not an error it can act on. */
export async function listGoIosUdids(goIos: string): Promise<string[]> {
  const { stdout } = await execFileAsync(goIos, ['list'], { timeout: LIST_TIMEOUT_MS });
  for (const line of stdout.split('\n')) {
    try {
      const o = JSON.parse(line) as { deviceList?: unknown };
      if (Array.isArray(o.deviceList)) return o.deviceList.map(String);
    } catch { /* a go-ios status line — its own diagnostics share the stream */ }
  }
  return [];
}

/** `ProductType` + `DeviceName` for one device, or `{}` when the probe fails — an unreadable device
 *  must degrade to "unidentified", never abort a selection that other evidence can still settle. */
export async function goIosDeviceInfo(goIos: string, udid: string): Promise<{ productType?: string; name?: string }> {
  try {
    const { stdout } = await execFileAsync(goIos, ['info', `--udid=${udid}`], { timeout: LIST_TIMEOUT_MS });
    for (const line of stdout.split('\n')) {
      try {
        const o = JSON.parse(line) as { ProductType?: unknown; DeviceName?: unknown };
        if (typeof o.ProductType === 'string') {
          return { productType: o.ProductType, name: typeof o.DeviceName === 'string' ? o.DeviceName : undefined };
        }
      } catch { /* status line */ }
    }
  } catch { /* unreadable — see doc */ }
  return {};
}

/**
 * WHICH PLATFORM a host-side op reads, as a pure decision — the I/O (listing attached devices) is
 * the caller's, so this is testable without hardware, the same shape as `planIosInstall`.
 *
 * ⚠️ The refusal is the load-bearing part. MEASURED before it existed: with an iPhone and three
 * Androids attached and NO lease, `device_crash_reports` silently answered about the iPhone —
 * right-looking payload, wrong device, no hint a choice had been made. These ops exist for the case
 * where the app has died, which is exactly when the lease is gone and cannot say, so "fall back to
 * iOS" was a coin flip dressed as a default. #149 refuses an ambiguous adb SERIAL for the same
 * reason; this is that rule one level up, binding the platform.
 */
export function pickHostSidePlatform(o: {
  explicit?: string;
  /** The lease's platform, when there is a lease. */
  leased?: string | null;
  /** UDIDs go-ios can see. */ iphones: string[];
  /** Serials adb can see. */  androids: string[];
}): 'ios' | 'android' | { error: string } {
  if (o.explicit === 'ios' || o.explicit === 'android') return o.explicit;
  if (o.leased === 'ios' || o.leased === 'android') return o.leased;
  if (o.iphones.length && o.androids.length) {
    return { error: `both an iPhone (${o.iphones.join(', ')}) and an Android (${o.androids.join(', ')}) are attached and no lease says which — pass platform:'ios' or platform:'android'` };
  }
  if (o.iphones.length) return 'ios';
  if (o.androids.length) return 'android';
  return { error: 'no device is attached (go-ios sees no iPhone, adb sees no Android) — check the cable, and that the device is unlocked and trusted' };
}

export interface LeaseHardwareHint { deviceModel: string | null; osVersion: string | null }

/** Should a lease's hardware be handed to an iOS host-side op (system logs / crash reports)?
 *
 *  `deviceConnection.deviceHardware()` is platform-agnostic — it answers for whatever is leased,
 *  Android included. Passing an Android lease's `deviceModel` (e.g. `'SM-S901B'`) straight into
 *  `pickGoIosDevice` hands it a value that can never match any attached iPhone's `ProductType`, so
 *  a device that IS attached — just on the other platform — reads as a genuine mismatch: `confirmed
 *  = []`, and the refusal names the Android model as if it were the reason no iPhone qualifies
 *  (#670 finding 3). The honest answer when the lease isn't iOS is the same as having no lease at
 *  all: `undefined`, so `resolveGoIosDevice` takes its no-lease path instead of guessing across
 *  platforms. A null/unresolved platform is treated the same way — "not confirmed iOS" is never
 *  "assume iOS" (see `devicePlatform()`'s own doc). */
export function leaseForIosOps(platform: string | null | undefined, hardware: LeaseHardwareHint | undefined): LeaseHardwareHint | undefined {
  return platform === 'ios' ? hardware : undefined;
}

/** The chosen device, plus a warning when the choice could not be tied to the lease. */
export interface GoIosChoice { device: GoIosDevice; unverified?: string }

/** Names every candidate the same way, whatever info the probe returned. */
function describeGoIosDevices(devices: GoIosDevice[]): string {
  return devices.map((d) => `${d.name ?? d.productType ?? 'unidentified'} (${d.udid})`).join(', ');
}

/**
 * Pick the device a go-ios op should target, as a pure decision — the I/O (listing attached
 * devices, probing each one's `ProductType`) is the caller's, the same split as
 * `pickHostSidePlatform`.
 *
 * Order: an explicit `MODOKI_IOS_DEVICE_UDID` pin → the one whose `ProductType` confirms the
 * leased app's reported model → refuse if several/none confirm, unless exactly one candidate is
 * unidentifiable (degrade rather than refuse — see below) → with no lease at all, the only
 * attached device.
 *
 * ⚠️ **#670, the bug this replaces.** The old code took the single-attached-device shortcut
 * BEFORE ever looking at the lease, so with one iPhone plugged in and a DIFFERENT phone leased,
 * a syslog/crash-report read silently answered about the wrong one, labelled as if it were the
 * leased device. `resolveIosDevice` (wdaLauncher.ts) and `resolveHostSideAndroidSerial`
 * (editorBackendRouter.ts) both already gate their single-device shortcut on there being no lease
 * to contradict it; this one didn't.
 */
export function pickGoIosDevice(o: {
  pinned?: string;
  /** Every attached device. `productType`/`name` are present only when the info probe succeeded. */
  devices: GoIosDevice[];
  /** The lease's hardware — ABSENT when there is no lease at all (see the router). */
  lease?: LeaseHardwareHint;
}): GoIosChoice | { error: string } {
  if (o.pinned) {
    const hit = o.devices.find((d) => d.udid === o.pinned);
    return hit
      ? { device: hit }
      // Name what IS attached: "your pin matches nothing" plus an empty room is a dead end, and the
      // most common cause is a pin left over from a phone that has since been unplugged.
      : { error: `MODOKI_IOS_DEVICE_UDID=${o.pinned} is not attached (go-ios sees: ${o.devices.map((d) => d.udid).join(', ') || 'nothing'})` };
  }
  if (o.devices.length === 0) return { error: 'no iOS device is attached (go-ios sees none) — check the cable and that the device is unlocked and trusted' };

  if (o.lease?.deviceModel) {
    // The lease knows the app's MODEL (never a UDID — #146: a UDID is a fact no app is allowed to
    // assert), so match on that; it is the same evidence `resolveIosDevice` uses.
    const confirmed = o.devices.filter((d) => d.productType === o.lease?.deviceModel);
    if (confirmed.length === 1) return { device: confirmed[0] };
    if (confirmed.length > 1) {
      return { error: `several attached iPhones are a ${o.lease.deviceModel} — set MODOKI_IOS_DEVICE_UDID to one of: ${describeGoIosDevices(confirmed)}` };
    }
    // Zero confirmed. A device with no `productType` (the info probe failed, or a handset old
    // enough that go-ios can't identify it) can never be confirmed and must never be treated as
    // a contradiction either — mirrors `leaseMatch`'s `'unknown'` verdict in wdaLauncher.ts.
    const unknown = o.devices.filter((d) => !d.productType);
    if (unknown.length === 1) {
      return { device: unknown[0], unverified: `no attached iPhone reports the leased device's model (${o.lease.deviceModel}), so this device could not be confirmed as the leased one` };
    }
    if (unknown.length > 1) {
      return { error: `${unknown.length} attached iPhones could not be identified, and none confirms the leased ${o.lease.deviceModel} — set MODOKI_IOS_DEVICE_UDID to one of: ${describeGoIosDevices(unknown)}` };
    }
    // Every attached device WAS identified, and none of them is the leased model — a genuine
    // contradiction, not just missing evidence. Refuse rather than read logs off the wrong phone.
    return {
      error: `the leased device is a ${o.lease.deviceModel}, which matches none of the attached iPhones `
        + `(${describeGoIosDevices(o.devices)}). Refusing rather than reading the wrong phone — attach `
        + 'the leased device, or set MODOKI_IOS_DEVICE_UDID if one of these really is it.',
    };
  }

  if (o.lease) {
    // A lease exists but reports no hardware (a bridge older than #146). Guess from what's
    // attached — deliberately, same as `resolveIosDevice` step 5 — but SAY it is a guess.
    if (o.devices.length === 1) {
      return { device: o.devices[0], unverified: 'the leased device did not report its hardware, so this is a guess from what is attached, not from the lease' };
    }
    return { error: `${o.devices.length} iOS devices are attached and the lease reports no hardware to pick by — set MODOKI_IOS_DEVICE_UDID to one of: ${describeGoIosDevices(o.devices)}` };
  }

  // No lease at all: no wrong-phone risk to guard against, so the single-device case stays exactly
  // as quiet as it always was.
  if (o.devices.length === 1) return { device: o.devices[0] };
  return { error: `several iOS devices are attached and none is pinned — set MODOKI_IOS_DEVICE_UDID to one of: ${describeGoIosDevices(o.devices)}` };
}

/**
 * Pick the device a go-ios op should target — I/O only; the decision is `pickGoIosDevice`.
 */
export async function resolveGoIosDevice(opts: {
  goIos: string;
  env?: NodeJS.ProcessEnv;
  lease?: LeaseHardwareHint;
}): Promise<GoIosChoice | { error: string }> {
  const env = opts.env ?? process.env;
  let udids: string[];
  try {
    udids = await listGoIosUdids(opts.goIos);
  } catch (e) {
    return { error: `could not list iOS devices via go-ios (${e instanceof Error ? e.message : String(e)})` };
  }

  // Pay for the `info` probe when its result is worth having: a lease that names a model needs it
  // to confirm/contradict, or several attached devices need it to name/disambiguate them for the
  // caller. A PIN with a single attached device and no lease needs neither — the response then
  // names that device by its UDID, not by name — and that's the common case, so it stays as cheap
  // as it always was.
  const devices: GoIosDevice[] = (opts.lease?.deviceModel || udids.length > 1)
    ? await Promise.all(udids.map(async (u) => ({ udid: u, ...await goIosDeviceInfo(opts.goIos, u) })))
    : udids.map((u) => ({ udid: u }));

  return pickGoIosDevice({ pinned: env.MODOKI_IOS_DEVICE_UDID?.trim(), devices, lease: opts.lease });
}
