/** Router-level tests for the per-project AI-panel settings endpoint
 *  (GET/POST /api/ai-settings → <project>/.modoki/ai-settings.json). Covers the
 *  empty default, persistence, and the shallow-merge contract used by the
 *  "Capture @contact on Play" toggle. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

let tmp: string;
function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    resolveAssetPath: (p: string) => path.join(tmp, p.replace(/^\//, '')),
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const get = () =>
  handleBackendRequest(makeCtx(), { method: 'GET', urlPath: '/api/ai-settings', query: new URLSearchParams(), body: undefined });
const post = (patch: unknown) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/ai-settings', query: new URLSearchParams(), body: patch });

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-aiset-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('/api/ai-settings', () => {
  it('GET returns {} when nothing is stored yet', async () => {
    const r = (await get()) as { body: unknown };
    expect(r.body).toEqual({});
  });

  it('POST persists a flag and GET reads it back', async () => {
    const w = (await post({ captureContactOnLaunch: true })) as { body: Record<string, unknown> };
    expect(w.body.captureContactOnLaunch).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.modoki', 'ai-settings.json'))).toBe(true);
    const r = (await get()) as { body: Record<string, unknown> };
    expect(r.body.captureContactOnLaunch).toBe(true);
  });

  it('POST shallow-merges — an unrelated key survives a later patch', async () => {
    await post({ captureContactOnLaunch: true, other: 'keep' });
    const w = (await post({ captureContactOnLaunch: false })) as { body: Record<string, unknown> };
    expect(w.body).toEqual({ captureContactOnLaunch: false, other: 'keep' });
  });
});
