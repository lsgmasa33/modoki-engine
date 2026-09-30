/** #1903 close-out review F1: the `crashReports` route's Android branch hands the reader's `omittedForSize` on to
 *  `device_crash_reports`, whose note says "N more within limit left out". The reader (`deviceAndroidDiagBudget.test.ts`)
 *  and the tool (`tools/logAnswer.test.ts`) were each pinned alone, and nothing drove this route at all, so a dropped
 *  spread here silently lost the reason a listing came back short. The device listing and the reader are played;
 *  the route is the real one. Mutation, measured: the route's `omittedForSize` spread removed → the first case goes red,
 *  nothing else. */

import { describe, it, expect, vi } from 'vitest';

const diag = { records: [{ kind: 'crash', when: '09-30 10:00:00.000', process: 'com.x', pid: 1, exception: 'boom', frames: [] }], totalSeen: 9, matched: 5, omittedForSize: 0 };
vi.mock('../../plugins/backend/deviceAndroidDiag', async (orig) => ({
  ...(await orig<typeof import('../../plugins/backend/deviceAndroidDiag')>()),
  readAndroidDiagnostics: async () => diag,
}));
vi.mock('../../plugins/backend/androidDevices', async (orig) => ({
  ...(await orig<typeof import('../../plugins/backend/androidDevices')>()),
  listAndroidDevices: () => [{ serial: 'S1', state: 'device' }],
  pickHostSideAndroidSerial: () => ({ serial: 'S1' }),
}));
vi.mock('../../plugins/backend/goIosDevice', async (orig) => ({
  ...(await orig<typeof import('../../plugins/backend/goIosDevice')>()),
  listGoIosUdids: async () => [],
}));

const { handleBackendRequest } = await import('../../plugins/backend/editorBackendRouter');
type BackendContext = Parameters<typeof handleBackendRequest>[0];
const ctx = { projectRoot: '/nonexistent', resolveAssetPath: (p: string) => p, absToAssetUrl: () => null, firstRootDir: () => null } as unknown as BackendContext;

async function crashReports(): Promise<Record<string, unknown>> {
  const res = await handleBackendRequest(ctx, {
    method: 'POST', urlPath: '/api/device/request', query: new URLSearchParams(),
    body: { method: 'crashReports', params: { platform: 'android', app: 'com.x' } },
  } as never);
  const r = res as { status?: number; body?: unknown; json?: unknown };
  const body = r.body ?? r.json;
  return (typeof body === 'string' ? JSON.parse(body) : body) as Record<string, unknown>;
}

describe('crashReports, Android: the route carries the fit\'s count (#1903)', () => {
  it('omittedForSize reaches the reply beside shown/matched', async () => {
    diag.omittedForSize = 4;
    const body = await crashReports();
    expect(body).toMatchObject({ shown: 1, matched: 5, totalOnDevice: 9, omittedForSize: 4, filteredTo: 'com.x' });
  });

  it('nothing omitted: the field is absent', async () => {
    diag.omittedForSize = 0;
    const body = await crashReports();
    expect(body).toMatchObject({ shown: 1, matched: 5 });
    expect('omittedForSize' in body).toBe(false);
  });
});
