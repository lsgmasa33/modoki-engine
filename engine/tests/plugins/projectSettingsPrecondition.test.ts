/** Router-level tests for `POST /api/project-settings`'s `expected` precondition (#2049): every leaf it names must still
 *  hold that value, or the POST is refused 409 and nothing is written. OTA Keys → Sync sends it, because its confirm can
 *  sit open while an agent writes `ota.publicKey`, and a plain deep-merge then replaced the agent's value unasked.
 *
 *  Mutation (measured): drop the `changed.length` refusal — the refuse-side tests go red (the file is rewritten to the
 *  synced key); make `staleExpectedPaths` report every leaf — the accept-side tests go red; put the value in the 409 —
 *  the never-the-value test goes red. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { planSettingsSave } from '../../packages/modoki/src/editor/panels/projectSettingsSave';
import { UNCLAMPED_OVERRIDES } from '../../packages/modoki/src/runtime/rendering/qualityTier';

const cleanup: string[] = [];
afterEach(() => { for (const r of cleanup.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function makeProject(publicKey: string): string {
  const root = makeScratchDir('modoki-settings-cas-');
  cleanup.push(root);
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app: { appId: 'com.x.y' }, ota: { publicKey } }));
  return root;
}

function makeCtx(projectRoot: string): BackendContext {
  return {
    projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: () => null,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const postSettings = (projectRoot: string, body: unknown) =>
  handleBackendRequest(makeCtx(projectRoot), {
    method: 'POST', urlPath: '/api/project-settings', query: new URLSearchParams(), body,
  }) as Promise<{ status?: number; body: Record<string, unknown> }>;

const onDisk = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf-8'));

describe('POST /api/project-settings `expected` (#2049)', () => {
  it('refuses 409 when the value changed since it was read, and writes nothing', async () => {
    // The user was asked "replace pk-shipped?"; an agent wrote pk-agent while the confirm was open.
    const root = makeProject('pk-agent');
    const before = fs.readFileSync(path.join(root, 'project.config.json'), 'utf-8');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: 'pk-shipped' } } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ conflict: true, changed: ['ota.publicKey'] });
    expect(fs.readFileSync(path.join(root, 'project.config.json'), 'utf-8')).toBe(before);
  });

  it('an expected EMPTY key is not met by a key set meanwhile (the first-time-setup sync)', async () => {
    const root = makeProject('pk-agent');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: '' } } });
    expect(r.status).toBe(409);
    expect(onDisk(root).ota.publicKey).toBe('pk-agent');
  });

  it('the 409 names the path, never the value there (a path may be a signing password)', async () => {
    const root = makeProject('pk-agent');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: 'pk-shipped' } } });
    expect(JSON.stringify(r.body)).not.toContain('pk-agent');
  });

  it('writes when the value is still the one expected', async () => {
    const root = makeProject('pk-shipped');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: 'pk-shipped' } } });
    expect(r.status ?? 200).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).ota.publicKey).toBe('pk-new');
  });

  it('writes into an empty key expected empty, and `expected` never lands in the file', async () => {
    const root = makeProject('');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: { ota: { publicKey: '' } } });
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).ota.publicKey).toBe('pk-new');
    expect(onDisk(root)).not.toHaveProperty('expected');
  });

  it('is not an unknown section, and a POST without it is unconditioned as before', async () => {
    const root = makeProject('pk-agent');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' } });
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).ota.publicKey).toBe('pk-new');
  });

  it('refuses a non-object `expected` with 400, writing nothing', async () => {
    const root = makeProject('pk-shipped');
    const r = await postSettings(root, { ota: { publicKey: 'pk-new' }, expected: 'pk-shipped' });
    expect(r.status).toBe(400);
    expect(onDisk(root).ota.publicKey).toBe('pk-shipped');
  });
});

// The Project Settings dialog's Apply, through the route (#2053): it posts only what it changed since it opened
// (`planSettingsSave`), with each changed value's open-time reading as `expected`. These drive the REAL GET for the
// open-time read, then an agent's write, then the Apply. Mutation: post the whole draft — the first two go red; drop
// `expected` — the third goes red (the user's value lands over the agent's).
describe('Project Settings Apply keeps what an agent wrote while the dialog was open (#2053, #2049)', () => {
  const ota = { title: 'OTA', groups: [{ title: 'OTA', fields: [{ key: 'ota.publicKey', label: 'Public key', type: 'readonly-text' as const }] }] };
  const schema = { tabs: [ota] };
  const openDialog = async (root: string) => structuredClone((await handleBackendRequest(makeCtx(root), {
    method: 'GET', urlPath: '/api/project-settings', query: new URLSearchParams(), body: undefined,
  }) as { body: Record<string, unknown> }).body);
  const apply = (root: string, base: Record<string, unknown>, draft: Record<string, unknown>) => {
    const plan = planSettingsSave(base, draft, schema);
    return postSettings(root, { ...plan.patch, expected: plan.expected });
  };

  it("an agent's appName written while the dialog was open survives an Apply of a different field", async () => {
    const root = makeProject('pk-shipped');
    const base = await openDialog(root);
    await postSettings(root, { app: { appName: 'Agent' } }); // the agent, meanwhile
    const draft = structuredClone(base);
    (draft.ota as Record<string, unknown>).retainVersions = 7;
    const r = await apply(root, base, draft);
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).app.appName).toBe('Agent');
    expect(onDisk(root).ota.retainVersions).toBe(7);
  });

  it("an agent's ota.publicKey written while the dialog was open survives an Apply of an unrelated field", async () => {
    const root = makeProject('pk-shipped');
    const base = await openDialog(root);
    await postSettings(root, { ota: { publicKey: 'pk-agent' } });
    const draft = structuredClone(base);
    (draft.app as Record<string, unknown>).appName = 'Renamed';
    const r = await apply(root, base, draft);
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).ota.publicKey).toBe('pk-agent');
    expect(onDisk(root).app.appName).toBe('Renamed');
  });

  it('a field both changed is refused 409 with its path, and nothing is written', async () => {
    const root = makeProject('pk-shipped');
    const base = await openDialog(root);
    await postSettings(root, { app: { appName: 'Agent' } });
    const before = fs.readFileSync(path.join(root, 'project.config.json'), 'utf-8');
    const draft = structuredClone(base);
    (draft.app as Record<string, unknown>).appName = 'Mine';
    (draft.ota as Record<string, unknown>).retainVersions = 7;
    const r = await apply(root, base, draft);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ conflict: true, changed: ['app.appName'] });
    expect(fs.readFileSync(path.join(root, 'project.config.json'), 'utf-8')).toBe(before);
  });
});

// Close-out review of #2053. Mutations (measured): drop the `posted` clause in staleExpectedPaths — the first goes red;
// walk REPLACE_WHOLESALE paths leaf by leaf again — the second goes red.
describe('`expected` against what the post itself writes, and against a wholesale block (#2053 close-out)', () => {
  /** A complete tier, from the engine's own identity object (see projectSettingsTiersRouter.test.ts for why finite). */
  const completeTier = (): Record<string, unknown> => {
    const walk = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
      typeof v === 'number' && !Number.isFinite(v) ? 2 : v !== null && typeof v === 'object' && !Array.isArray(v) ? walk(v as Record<string, unknown>) : v]));
    return walk(UNCLAMPED_OVERRIDES as unknown as Record<string, unknown>);
  };
  const userOnDisk = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'project.user.json'), 'utf-8'));

  it('a retry whose value already landed (a half-written Apply) is accepted, not blamed on another writer', async () => {
    const root = makeProject('pk');
    const opened = (await handleBackendRequest(makeCtx(root), {
      method: 'GET', urlPath: '/api/project-settings', query: new URLSearchParams(), body: undefined,
    }) as { body: { app: { appName: string }; user: { device: { iosDeviceId: string } } } }).body;
    await postSettings(root, { user: { device: { iosDeviceId: 'new-id' } } }); // the user file landed; the rest 500'd
    const r = await postSettings(root, {
      user: { device: { iosDeviceId: 'new-id' } }, app: { appName: 'Renamed' },
      expected: { user: { device: { iosDeviceId: opened.user.device.iosDeviceId } }, app: { appName: opened.app.appName } },
    });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true });
    expect(userOnDisk(root).device.iosDeviceId).toBe('new-id');
    expect(onDisk(root).app.appName).toBe('Renamed');
  });

  // The accept-side clause is about what the post WRITES; a key it does not post is still checked. Mutation (measured):
  // drop `posted === undefined ||` — this goes red.
  it('an expected value at a key the post does not write, absent on disk, still refuses', async () => {
    const root = makeProject('pk');
    const r = await postSettings(root, { ota: { retainVersions: 3 }, expected: { app: { notOnDisk: 'X' } } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ changed: ['app.notOnDisk'] });
  });

  // Close-out review 2: the accept compares what the route WRITES — `build.<private field>` overrides a posted
  // `user.build.<field>`, so the overridden value must not satisfy it. Mutation (measured): pass `bodyIn` again — red.
  it('a posted user.build value that build.<private field> overrides cannot satisfy a stale expected', async () => {
    const root = makeProject('pk');
    await postSettings(root, { user: { build: { appleTeamId: 'NEW1' } } }); // on disk, meanwhile
    const r = await postSettings(root, {
      build: { appleTeamId: 'NEW2' }, user: { build: { appleTeamId: 'NEW1' } },
      expected: { user: { build: { appleTeamId: 'STALE' } } },
    });
    expect(r.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'project.user.json'), 'utf-8')).build.appleTeamId).toBe('NEW1');
  });

  it('a tier added while the dialog was open refuses a tiers edit, rather than being deleted by it', async () => {
    const root = makeProject('pk');
    await postSettings(root, { rendering: { three: { tiers: { low: completeTier() } } } });
    const base = structuredClone((await handleBackendRequest(makeCtx(root), {
      method: 'GET', urlPath: '/api/project-settings', query: new URLSearchParams(), body: undefined,
    }) as { body: Record<string, unknown> }).body);
    await postSettings(root, { rendering: { three: { tiers: { low: completeTier(), mid: completeTier() } } } }); // the agent
    const draft = structuredClone(base) as { rendering: { three: { tiers: Record<string, Record<string, unknown>> } } };
    draft.rendering.three.tiers.low!.pixelRatioCap = 1.5;
    const plan = planSettingsSave(base, draft, { tabs: [] });
    const r = await postSettings(root, { ...plan.patch, expected: plan.expected });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ conflict: true, changed: ['rendering.three.tiers'] });
    expect(Object.keys(onDisk(root).rendering.three.tiers).sort()).toEqual(['low', 'mid']);
  });
});
