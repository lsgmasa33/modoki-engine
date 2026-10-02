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
import { draftForSave } from '../../packages/modoki/src/editor/panels/projectSettingsPaths';

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

// The Project Settings dialog's Apply, through the route: it posts the whole object it loaded on open, minus readonly
// fields (`draftForSave`). An agent's ota.publicKey write while the dialog was open survives the Apply. Mutation: post
// the draft unchanged — the stale key comes back.
describe('Project Settings Apply never writes back a readonly field (#2049 sibling)', () => {
  it("an agent's ota.publicKey written while the dialog was open survives an Apply of an unrelated field", async () => {
    const root = makeProject('pk-shipped');
    const get = await handleBackendRequest(makeCtx(root), {
      method: 'GET', urlPath: '/api/project-settings', query: new URLSearchParams(), body: undefined,
    }) as { body: Record<string, unknown> };
    const loaded = structuredClone(get.body); // what the dialog loads on open
    await postSettings(root, { ota: { publicKey: 'pk-agent' } }); // the agent, meanwhile
    (loaded.app as Record<string, unknown>).appName = 'Renamed';
    const schema = { tabs: [{ title: 'OTA', groups: [{ title: 'OTA', fields: [{ key: 'ota.publicKey', label: 'Public key', type: 'readonly-text' as const }] }] }] };
    const r = await postSettings(root, draftForSave(loaded, schema));
    expect(r.body.ok).toBe(true);
    expect(onDisk(root).ota.publicKey).toBe('pk-agent');
    expect(onDisk(root).app.appName).toBe('Renamed');
  });
});
