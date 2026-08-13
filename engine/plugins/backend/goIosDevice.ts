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

/**
 * Pick the device a go-ios op should target.
 *
 * Order: an explicit `MODOKI_IOS_DEVICE_UDID` pin → the only attached device → the one whose
 * `ProductType` matches the leased app's reported model → refuse, naming every candidate.
 */
export async function resolveGoIosDevice(opts: {
  goIos: string;
  env?: NodeJS.ProcessEnv;
  lease?: LeaseHardwareHint;
}): Promise<{ device: GoIosDevice } | { error: string }> {
  const env = opts.env ?? process.env;
  let udids: string[];
  try {
    udids = await listGoIosUdids(opts.goIos);
  } catch (e) {
    return { error: `could not list iOS devices via go-ios (${e instanceof Error ? e.message : String(e)})` };
  }

  const pinned = env.MODOKI_IOS_DEVICE_UDID?.trim();
  if (pinned) {
    return udids.includes(pinned)
      ? { device: { udid: pinned } }
      // Name what IS attached: "your pin matches nothing" plus an empty room is a dead end, and the
      // most common cause is a pin left over from a phone that has since been unplugged.
      : { error: `MODOKI_IOS_DEVICE_UDID=${pinned} is not attached (go-ios sees: ${udids.join(', ') || 'nothing'})` };
  }
  if (udids.length === 0) return { error: 'no iOS device is attached (go-ios sees none) — check the cable and that the device is unlocked and trusted' };
  if (udids.length === 1) return { device: { udid: udids[0] } };

  // Several attached. The lease knows the app's MODEL (never a UDID — #146: a UDID is a fact no app
  // is allowed to assert), so match on that; it is the same evidence `resolveIosDevice` uses.
  const infos = await Promise.all(udids.map(async (u) => ({ udid: u, ...await goIosDeviceInfo(opts.goIos, u) })));
  if (opts.lease?.deviceModel) {
    const hits = infos.filter((d) => d.productType === opts.lease?.deviceModel);
    if (hits.length === 1) return { device: hits[0] };
  }
  const described = infos.map((d) => `${d.name ?? d.productType ?? 'unidentified'} (${d.udid})`).join(', ');
  return { error: `several iOS devices are attached and none is pinned — set MODOKI_IOS_DEVICE_UDID to one of: ${described}` };
}
