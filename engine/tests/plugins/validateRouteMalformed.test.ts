/** A file that does not parse is a FINDING of the validate routes, not a 500 (#1212 A-4).
 *
 *  `JSON.parse` sat inside the catch-all, so a malformed prefab or scene answered 500 — which the
 *  MCP reads as NOT_AVAILABLE_HERE, "could not look, relaunch the editor" — about the one defect
 *  a validator most needs to report. It is a warning in the answer now, and says nothing else ran.
 *  A failed READ is not a finding and stays a 500 (the accept side of that split is below). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { relay } from './backendRelay';

let root = '';
beforeEach(() => { root = makeScratchDir('modoki-validate-malformed-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function makeCtx(): BackendContext {
  const manifest: Manifest = { version: 2, assets: [] };
  return {
    projectRoot: root,
    resolveAssetPath: (p: string) => path.join(root, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    markEditorWrite: () => {},
    requestBrowser: relay(),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const get = (route: string, p: string) =>
  handleBackendRequest(makeCtx(), { method: 'GET', urlPath: route, query: new URLSearchParams({ path: p }), body: undefined }) as
    Promise<{ status?: number; body: { ok?: boolean; warnings?: string[]; error?: string; schemaApplied?: boolean } }>;

describe.each([
  ['/api/validate-prefab', '/crate.prefab.json'],
  ['/api/validate-scene', '/level.scene.json'],
])('%s', (route, file) => {
  it('a malformed file is ANSWERED with a warning, not a 500', async () => {
    fs.writeFileSync(path.join(root, file.slice(1)), '{ "entities": [ ');
    const r = await get(route, file);
    expect(r.status ?? 200).toBe(200);
    expect(r.body.warnings).toHaveLength(1);
    expect(r.body.warnings![0]).toMatch(new RegExp(`^${file.replace(/\./g, '\\.')} is not valid JSON .*nothing else was checked`));
  });

  it('a well-formed file still validates — the accept side', async () => {
    fs.writeFileSync(path.join(root, file.slice(1)), JSON.stringify({ entities: [] }));
    const r = await get(route, file);
    expect(r.status ?? 200).toBe(200);
    expect((r.body.warnings ?? []).some((w) => /not valid JSON/.test(w))).toBe(false);
    expect(r.body.ok).toBe(true);
  });

  // #1214 A-3: both tool descriptions promise `ok:false` as the answer; neither route ever sent `ok`.
  it('a file with findings answers ok:false beside its warnings', async () => {
    fs.writeFileSync(path.join(root, file.slice(1)), '{ "entities": [ ');
    const r = await get(route, file);
    expect(r.status ?? 200).toBe(200);
    expect(r.body.ok).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable file is still a 500 — a failed read is not a finding', async () => {
    const abs = path.join(root, file.slice(1));
    fs.writeFileSync(abs, '{}');
    fs.chmodSync(abs, 0o000);
    try {
      const r = await get(route, file);
      expect(r.status).toBe(500);
    } finally {
      fs.chmodSync(abs, 0o644);
    }
  });
});
