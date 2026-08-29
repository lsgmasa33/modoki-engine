/**
 * Which Android? — listing the attached devices and resolving ONE serial for `adb -s` (#149).
 *
 * Every adb call on the device surface used to be un-targeted, which is fine with one phone and
 * fails outright with two: adb answers `adb: more than one device/emulator` and refuses. Measured
 * on this Mac with two handsets on USB, that took out `device_connect {useAdb:true}`, the CDP
 * discovery behind TRUSTED Android input, and `device_screenshot` — the whole Android surface, with
 * no way to say which phone was meant. Failing loudly beat driving the wrong one, but the only
 * escape was to unplug the other device.
 *
 * So the serial is resolved ONCE, at the point the lease is opened, and then carried on the lease
 * (`DeviceConnectStatus.target.serial`) for every later adb call to reuse. That ordering is the
 * load-bearing part: a screenshot or a CDP forward must NEVER re-resolve a serial of its own, or a
 * second phone plugged in mid-session could make two calls in the same session target two different
 * devices while both report success. Same reasoning as #142, where CDP discovery — which knows
 * nothing about the lease — dispatched input into an Android while the lease held an iPhone.
 *
 * PURE parse + PURE rule, with the one `execFileSync` behind an overridable seam, so the selection
 * behaviour is testable without hardware (matching `wdaLauncher.ts`, whose `resolveIosDevice` is
 * this module's iOS sibling and whose precedence order this one deliberately mirrors).
 */

import { execFileSync } from 'child_process';
import { detectAdb } from '../../toolchain';

/** Resolve the adb binary the editor PROVISIONS (Android SDK platform-tools), NOT a bare `adb` on
 *  PATH: the packaged editor's adb lives under its toolchain dir and is NOT on the system PATH, so
 *  `execFileSync('adb', …)` ENOENTs there (this is why USB failed while WiFi — a direct TCP connect
 *  needing no adb — worked). `detectAdb()` derives `<sdk>/platform-tools/adb(.exe)` from the resolved
 *  Android SDK (env → provisioned userData SDK).
 *
 *  Lives HERE, with the device selection, rather than in `deviceConnection.ts` where it started:
 *  once the serial resolution needs to run adb itself, keeping it there would make this module
 *  import the lease manager and the lease manager import this one. One module owns "how to talk to
 *  adb"; `deviceConnection.ts` and `deviceCdp.ts` both import it from here. */
export function adbBinary(): string {
  const d = detectAdb();
  if (!d.present || !d.path) {
    throw new Error(
      'adb not found. USB tunneling needs the Android SDK platform-tools — install the Android SDK ' +
      'from Build Support (or set ANDROID_HOME), then reconnect. WiFi (device IP) works without adb.',
    );
  }
  return d.path;
}

/** One device in `adb devices -l`.
 *
 *  `state` is adb's own word, kept RAW rather than reduced to a boolean: `unauthorized` (the phone
 *  has not accepted this Mac's RSA key) and `offline` are the two failures a human can actually fix
 *  from the message, and collapsing them into "not usable" is exactly the detail that turns an
 *  actionable refusal into "device busy". Only `device` is usable. */
export interface AndroidDevice {
  serial: string;
  state: string;
  /** `model:` from the `-l` long listing, e.g. `SC_56C`. Absent on an `unauthorized` device — adb
   *  cannot read properties off a phone that has not trusted it yet. */
  model?: string;
  /** A human-recognisable name the PHONE reports for itself ("Galaxy A23 5G"), when it answered —
   *  see `friendlyName`. Absent on `listAndroidDevices()`, which stays a single cheap `adb devices`;
   *  added by `withFriendlyNames`, which is what the surfaces a human reads call. */
  name?: string;
  /** adb's `transport_id:`, carried for display only. Deliberately NOT used to target: it is
   *  reassigned on every reconnect, which is the same trap as addressing an entity by runtime id. */
  transportId?: string;
}

/** One line of `adb forward --list`: `<serial> tcp:<local> <remote>`, where remote is `tcp:<port>`
 *  for the debug bridge and `localabstract:webview_devtools_remote_<pid>` for a CDP tunnel. */
export interface ForwardRule { serial: string; local: string; remote: string }

/** Parse `adb forward --list`. PURE.
 *
 *  Format:
 *    RFDEADBEEF1 tcp:9095 tcp:9095
 *    RFDEADBEEF2 tcp:9333 localabstract:webview_devtools_remote_12345
 *
 *  A cold daemon prepends its `* daemon …` banner on the same stream, dropped EXPLICITLY here the
 *  way `parseAdbDevices` drops it — not left to the shape check below. Both known banner lines
 *  happen to fail that check anyway (their second field carries no colon), but "happens to" is not
 *  a property: a banner whose second token contained a `:` would be parsed as a rule, and a rule
 *  fabricated from a banner is a wrong answer to "who owns this port", which is the one question
 *  this parser exists to answer. Cheap to make structural, so it is. */
export function parseForwardList(out: string): ForwardRule[] {
  const rules: ForwardRule[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [serial, local, remote] = parts;
    if (!/^[a-z]+:.+/i.test(local)) continue;
    rules.push({ serial, local, remote });
  }
  return rules;
}

/** Which device owns the forward rule listening on host `port`, or undefined if none does.
 *
 *  Exists because `adb forward --remove` matches on the HOST PORT SPEC and ignores `-s` (#158): a
 *  serial-targeted removal will happily delete a rule belonging to a DIFFERENT phone. Callers use
 *  this to refuse that rather than reach across. `--list` is daemon-wide and takes no `-s`, which is
 *  exactly what makes the question answerable. */
export function forwardOwner(out: string, port: number): string | undefined {
  return parseForwardList(out).find((r) => r.local === `tcp:${port}`)?.serial;
}

/** True when adb will actually talk to this device. Everything else is listed (so a refusal can
 *  name it and say what is wrong with it) but never auto-picked. */
export function isUsable(d: AndroidDevice): boolean {
  return d.state === 'device';
}

/** Parse `adb devices -l`. PURE.
 *
 *  Format, which the parse depends on:
 *    List of devices attached
 *    FAKESERIAL0Y6001   device usb:2-1.4.3 model:MRD_LX3 device:HWMRD transport_id:3
 *    RFDEADBEEF2        unauthorized usb:2-1.1
 *    emulator-5554      device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64
 *
 *  A cold daemon prepends `* daemon not running; starting now at tcp:5037` and `* daemon started
 *  successfully` on the SAME stream — dropped here rather than being mistaken for a device whose
 *  serial is `*`. */
export function parseAdbDevices(out: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || /^List of devices/i.test(line)) continue;
    const parts = line.split(/\s+/);
    const [serial, state] = parts;
    if (!serial || !state) continue;
    const dev: AndroidDevice = { serial, state };
    for (const kv of parts.slice(2)) {
      const idx = kv.indexOf(':');
      if (idx <= 0) continue;
      const key = kv.slice(0, idx);
      const value = kv.slice(idx + 1);
      if (key === 'model') dev.model = value;
      else if (key === 'transport_id') dev.transportId = value;
    }
    devices.push(dev);
  }
  return devices;
}

/** The one shell-out, behind an overridable seam so tests inject a listing instead of mocking
 *  `child_process` (which fights vitest's per-file module cache in the full suite — the same reason
 *  `adbRunner` and `deviceCdpAdb` are shaped this way). */
export const androidDevicesExec = {
  list(): string {
    return execFileSync(adbBinary(), ['devices', '-l'], { timeout: 4000, encoding: 'utf8' });
  },
  /** The phone's own name for itself. See `friendlyName` for WHICH name and why these two. */
  deviceName(serial: string): string {
    return execFileSync(adbBinary(), adbArgs(serial, [
      'shell',
      // One shell, two answers, so a phone costs one round trip rather than two. `settings get`
      // prints the literal `null` when unset, which `pickName` treats as "no answer".
      'settings get global device_name; settings get secure bluetooth_name; getprop ro.config.marketing_name; getprop ro.product.marketname',
    ]), { timeout: 4000, encoding: 'utf8' });
  },
};

/** Names resolved this process, keyed by serial. A phone's name is a LABEL a human set once, not
 *  live state — and the AI panel polls the device list every 2.5s, so re-asking would spend an
 *  `adb shell` per phone per poll (three attached here ⇒ ~1.2 shells/second, forever) to re-learn a
 *  string that essentially never changes. Cached for the life of the process; unplugging and
 *  replugging the phone does not invalidate it, because the serial→name mapping is what is cached
 *  and that pairing IS stable. */
const nameCache = new Map<string, string>();

/** Every line that is a real answer, in the order asked. `settings get` prints `null` for an unset
 *  key and `getprop` prints nothing at all, so both non-answers have to be filtered — a device
 *  labelled "null" is worse than one labelled by its model code. */
function nameCandidates(shellOutput: string): string[] {
  return shellOutput.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'null' && !/^(cmd|settings|error)\b/i.test(l));
}

/** Are these the same string once punctuation and case stop mattering? Needed because the two
 *  sources spell the model differently: `adb devices -l` reports `MRD_LX3` where the phone itself
 *  says `MRD-LX3`. A raw `===` would call those different and hand back a "name" that is the model
 *  code wearing a hyphen. */
function sameAsModel(candidate: string, model?: string): boolean {
  if (!model) return false;
  const norm = (v: string) => v.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return norm(candidate) === norm(model);
}

/** A human-recognisable name for the phone — "Galaxy A23 5G", not "SC_56C".
 *
 *  `adb devices -l` reports only `model:`, which is the MODEL CODE (`SC_56C`, `SM_S901U1`,
 *  `MRD_LX3`). Nobody calls their phone that, and on a desk with three Androids it is exactly the
 *  string that fails to tell them apart.
 *
 *  Measured on this Mac's three handsets (2026-08-07), which is why the chain is in this order:
 *   - `settings get global device_name` — **the one that actually works on Samsung**: SC-56C answers
 *     `Galaxy A23 5G`, and a phone the owner renamed answers that name (`Masaki Android`), which is
 *     BETTER than the marketing name — it is what the human calls that phone.
 *   - `settings get secure bluetooth_name` — the Huawei leaves `device_name` as its model code but
 *     answers `HUAWEI Y6 2019` here.
 *   - `ro.config.marketing_name` / `ro.product.marketname` — vendor props. Real on Huawei/Xiaomi;
 *     **empty on both Samsungs**, which is why they cannot be the primary source, and why "just read
 *     the marketing-name prop" does not work.
 *   - the model code, unchanged, when a device answers none of them.
 *
 *  Note this is a LABEL, never an identity: `device_name` is user-editable and two phones can share
 *  one. The serial remains the only thing anything is addressed by. Failure (an unauthorized device,
 *  adb gone, a slow shell) returns undefined and the caller falls back to the model — a listing must
 *  never fail because a phone would not say its name. */
export function friendlyName(serial: string, model?: string): string | undefined {
  const hit = nameCache.get(serial);
  if (hit !== undefined) return hit || undefined;
  let name: string | undefined;
  try {
    // Take the first candidate that is not just the MODEL CODE again. Measured on the Huawei: its
    // `device_name` is `MRD-LX3` — a real answer, and a completely useless one, since the whole
    // point is to say something the model code does not. Skipping it reaches `bluetooth_name`,
    // which is `HUAWEI Y6 2019`. Without this the fallback chain stops at the first non-empty
    // string and the feature silently does nothing for that vendor.
    name = nameCandidates(androidDevicesExec.deviceName(serial)).find((c) => !sameAsModel(c, model));
  } catch { name = undefined; }
  nameCache.set(serial, name ?? ''); // negative-cache too: a device that won't answer must not be re-asked every poll
  return name;
}

/** Test seam — drop the memoized names so a test can change what a device reports. */
export function _clearFriendlyNameCache(): void { nameCache.clear(); }

/** The attached Android devices, or `[]` when adb cannot even be run (no SDK, no platform-tools).
 *
 *  Absence of adb is reported as an empty list rather than a throw because every caller's next move
 *  is the same either way — refuse and explain — and `adbBinary()`'s own error already says how to
 *  install it. A caller that needs to distinguish "no adb" from "no phones" should call
 *  `adbBinary()` itself. */
export function listAndroidDevices(): AndroidDevice[] {
  try {
    return parseAdbDevices(androidDevicesExec.list());
  } catch {
    return [];
  }
}

/** Add each device's own name for itself (cached — see `friendlyName`). Separate from
 *  `listAndroidDevices` on purpose: that is ONE `adb devices` call and must stay that way for the
 *  paths that only need to know which serials exist, whereas this spends a shell per NEW serial. */
export function withFriendlyNames(devices: AndroidDevice[]): AndroidDevice[] {
  return devices.map((d) => {
    // Only a usable device can be asked; adb cannot run a shell on an unauthorized/offline one.
    const name = isUsable(d) ? friendlyName(d.serial, d.model) : undefined;
    return name ? { ...d, name } : d;
  });
}

/** A one-line description of a device for a message: `RFDEADBEEF2 (Galaxy A23 5G)`. Prefers the
 *  phone's own name over the model code — on a desk with three Androids, `SC_56C` vs `SM_S901U1` is
 *  precisely the pair a human cannot tell apart. Falls back to the model when no name was learned. */
export function describeAndroidDevice(d: AndroidDevice): string {
  const bits = [d.name ?? d.model, isUsable(d) ? null : d.state].filter(Boolean).join(', ');
  return bits ? `${d.serial} (${bits})` : d.serial;
}

/** Which Android device this session means, in strict precedence order:
 *
 *   1. **`explicit`** — the serial the caller asked for (the AI panel's picker, `device_connect
 *      {serial}`, or the lease's remembered target). A value that matches nothing attached is an
 *      ERROR rather than silently ignored: a typo'd or unplugged serial must never fall through to
 *      "some other phone", which is the exact failure this whole module exists to prevent.
 *   2. **`MODOKI_ANDROID_SERIAL`, then adb's own `ANDROID_SERIAL`** — the env pin. `ANDROID_SERIAL`
 *      is honoured because adb itself does: a developer who set it has already told every adb on
 *      this machine which phone they mean, and ignoring it here would make Modoki the one tool that
 *      disagrees. Same strictness as (1) — a pin that matches nothing is an error.
 *   3. **The only usable device**, when exactly one is attached — the single-phone case, which must
 *      keep working with no configuration at all.
 *   4. Otherwise **REFUSE, naming every candidate** (`docs/mcp-tool-conventions.md` §5: a refusal
 *      that names the owner is actionable; "more than one device/emulator" is not).
 *
 *  Note what is deliberately NOT in this list: the project's `user.device.androidDeviceId`. That pin
 *  belongs to the BUILD path (`vite-asset-scanner.ts` interpolates it into `adb -s` for an install)
 *  and is per-project, whereas a lease is per-clone and outlives the open project. Wiring it in here
 *  would make "which phone does Modoki drive" depend on which game happens to be open, which is a
 *  worse answer than asking once and remembering it on the lease. The build resolver
 *  (`resolveBuildAndroidSerial`) starts FROM that pin and falls back to this rule, so the two agree
 *  whenever the pin is set and neither guesses when it is not. */
export function resolveAndroidSerial(
  devices: AndroidDevice[],
  opts: { explicit?: string; env?: NodeJS.ProcessEnv } = {},
): { serial: string } | { error: string } {
  const usable = devices.filter(isUsable);
  const env = opts.env ?? process.env;

  const pinned = opts.explicit?.trim() || env.MODOKI_ANDROID_SERIAL?.trim() || env.ANDROID_SERIAL?.trim();
  if (pinned) {
    const hit = devices.find((d) => d.serial === pinned);
    if (!hit) {
      const source = opts.explicit?.trim() ? 'serial' : 'the environment pin';
      return {
        error: `${source} ${pinned} matches none of the Android devices attached to this Mac`
          + `${devices.length ? ` (${devices.map(describeAndroidDevice).join(', ')})` : ' (none are attached)'}`
          + ' — check the cable, or list them with device_list.',
      };
    }
    if (!isUsable(hit)) return { error: unusableMessage(hit) };
    return { serial: hit.serial };
  }

  if (usable.length === 1) return { serial: usable[0].serial };

  if (usable.length === 0) {
    if (devices.length === 0) {
      return { error: 'no Android device is attached to this Mac (adb sees none) — check the cable and that USB debugging is on.' };
    }
    // Attached but not usable: the state IS the fix, so lead with it.
    return { error: devices.map(unusableMessage).join(' ') };
  }

  return {
    error: `${usable.length} Android devices are attached and none was chosen — `
      + `${usable.map(describeAndroidDevice).join(', ')}. `
      + 'Say which one: device_connect {useAdb:true, serial:"<serial>"}, the AI panel\'s device picker, '
      + 'or set MODOKI_ANDROID_SERIAL. Refusing rather than driving whichever phone adb happens to list first.',
  };
}

/** What to say about a device adb can see but cannot talk to. The state is the whole message —
 *  `unauthorized` has a fix the human performs ON THE PHONE, which no amount of Modoki config
 *  reaches. */
function unusableMessage(d: AndroidDevice): string {
  if (d.state === 'unauthorized') {
    return `${d.serial} is attached but UNAUTHORIZED — unlock the phone and accept the "Allow USB debugging" prompt (tick "always allow"), then retry.`;
  }
  if (d.state === 'offline') {
    return `${d.serial} is attached but OFFLINE — unplug and replug it, or run \`adb kill-server\`, then retry.`;
  }
  return `${d.serial} is attached but adb reports it as "${d.state}", which is not a usable state.`;
}

/** The serial a native Android BUILD should install to: the project's own pin first (it is explicit
 *  config the human typed in Project Settings), then the HELD LEASE's device, then the same rule as
 *  the lease itself (env pin → the only usable device → refuse with the candidates named).
 *
 *  Exists because the build path used to interpolate the pin when set and bare `adb` when not —
 *  which meant an unpinned project on a two-phone Mac failed the install with adb's own
 *  `more than one device/emulator` and no hint that a pin existed. Returning an ERROR here lets the
 *  caller refuse with the candidates named, which is the same contract every other device selection
 *  in this repo now follows.
 *
 *  ⚠️ `leaseSerial` is #235, and it is what makes the refusal HONEST. The shared message offers
 *  three remedies — `device_connect {useAdb:true, serial}`, the AI panel's picker, and
 *  `MODOKI_ANDROID_SERIAL` — but the first two both act by opening a LEASE, and the build path
 *  consulted only the project pin. So an agent that did exactly what the message said (connect to
 *  the phone, confirm it with `device_status`) got the identical refusal on the very next build,
 *  and paid a full build-and-refuse cycle to discover it. `docs/mcp-tool-conventions.md` §5 asks a
 *  refusal to be actionable; one that names an action with no effect is worse than a terse one.
 *  Fixed by honouring the lease HERE rather than by shortening the message, because an agent that
 *  has just connected to a phone is unambiguously saying which one it means.
 *
 *  It is passed IN rather than read here on purpose: this module owns "how to talk to adb" and must
 *  not import the lease manager — `deviceConnection.ts` already imports this one, and the header
 *  above records why that direction is the one that holds. The caller reads the lease. */
export function resolveBuildAndroidSerial(
  devices: AndroidDevice[],
  opts: { projectPin?: string; leaseSerial?: string; env?: NodeJS.ProcessEnv } = {},
): { serial: string } | { error: string } {
  // The project pin still wins: it is durable config a human typed for THIS project, whereas the
  // lease is session state. Both beat the environment, matching resolveAndroidSerial's own order.
  //
  // The lease is applied as a PREFERENCE, not a pin — it counts only while its phone is still
  // attached and usable. Same rule `deviceConnection.ts` states for its remembered target, and for
  // the same reason: a lease outlives the cable. Unplug the leased handset mid-session and a pin
  // would hard-fail the build with "serial RFC… matches none of the Android devices attached" —
  // naming a serial the human never typed and cannot place. Degrading to the ordinary rule instead
  // means one remaining phone just builds, and two still refuse with both candidates named.
  const leaseSerial = opts.leaseSerial?.trim();
  const leaseUsable = leaseSerial && devices.some((d) => d.serial === leaseSerial && isUsable(d))
    ? leaseSerial
    : undefined;
  const explicit = opts.projectPin?.trim() || leaseUsable;
  return resolveAndroidSerial(devices, { explicit, env: opts.env });
}

/** Prefix adb args with `-s <serial>` when one is known. The seam every adb call site goes through,
 *  so "did this call target the leased phone?" is answerable by reading ONE function rather than
 *  auditing six call sites — which is how they all came to be un-targeted in the first place. */
export function adbArgs(serial: string | undefined, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args;
}
