/** #1961 — `/api/device/list`: adb present but `adb devices` failing used to read as "no Android attached".
 *
 *  The route drew two Android states (`note` when adb is missing, a list otherwise) and #1096 gave iOS its third
 *  (`iosNote`, a listing that broke). `listAndroidDevices` swallowed every error into `[]`, so a wedged adb server
 *  answered `android: [], adb.present: true` and nothing else — the device picker showed no phones and no reason. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { androidDevicesExec, explainUnlisted, listAndroidDevicesResult } from '../../plugins/backend/androidDevices';

// adb must be PRESENT for the third state to exist; the iOS half is not under test and shells out on a Mac.
vi.mock('../../plugins/backend/androidDevices', async (orig) => ({ ...(await orig<object>()), adbBinary: () => '/fake/adb' }));
vi.mock('../../plugins/backend/wdaLauncher', async (orig) => ({
  ...(await orig<object>()),
  listIosDevicesForSelectionResult: async () => ({ devices: [], unavailable: [] }),
}));

const realList = androidDevicesExec.list;
afterEach(() => { androidDevicesExec.list = realList; });

const list = async () => (await handleBackendRequest({} as BackendContext, {
  method: 'GET', urlPath: '/api/device/list', query: new URLSearchParams(), body: undefined,
})) as { status?: number; body: { android: unknown[]; adb: { present: boolean }; androidNote?: string; note?: string } };

describe('/api/device/list — adb that cannot list is not "no phone attached" (#1961)', () => {
  it('a failing `adb devices` carries androidNote, naming the failure', async () => {
    androidDevicesExec.list = () => { throw new Error('daemon not running; failed to start'); };
    const r = await list();
    expect(r.body.android).toEqual([]);
    expect(r.body.adb.present).toBe(true);
    expect(r.body.androidNote).toMatch(/does NOT mean no phone is attached .*`adb devices` failed \(daemon not running/);
    expect(r.body.note).toBeUndefined();
  });

  it('ACCEPT: a working adb with nothing attached adds no note — it was checked, and it is empty', async () => {
    androidDevicesExec.list = () => 'List of devices attached\n\n';
    const r = await list();
    expect(r.body.android).toEqual([]);
    expect(r.body.androidNote).toBeUndefined();
  });

  it('listAndroidDevicesResult keeps the devices it parsed and says nothing when it worked', () => {
    androidDevicesExec.list = () => 'List of devices attached\nSER1\tdevice product:x model:Pixel_7 device:y\n';
    const r = listAndroidDevicesResult();
    expect(r.devices.map((d) => d.serial)).toEqual(['SER1']);
    expect(r.unavailable).toBeUndefined();
  });
});

// The siblings (close-out review): every device PICK — device_connect's serial, the build's serial, the host-side
// log/crash platform — refused a wedged adb as "no Android device attached". They share `explainUnlisted`.
describe('explainUnlisted — a pick refused over an unlisted adb says so (#1961 siblings)', () => {
  const broken = { devices: [], unavailable: '`adb devices` failed (boom)' };
  it('appends the listing failure to a refusal', () => {
    expect(explainUnlisted({ error: 'no Android device attached' }, broken).error)
      .toBe('no Android device attached — but `adb devices` failed (boom), so this does NOT mean no Android phone is attached (try `adb kill-server`)');
  });
  it('leaves a success, and a refusal over a WORKING listing, untouched (accept side)', () => {
    expect(explainUnlisted({ serial: 'S' }, broken)).toEqual({ serial: 'S' });
    expect(explainUnlisted({ error: 'no Android device attached' }, { devices: [] })).toEqual({ error: 'no Android device attached' });
  });
});
