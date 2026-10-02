/** #1991 (3): a request already running when Open Project re-roots keeps the project it arrived in. The case from the
 *  issue: a recursive folder reimport awaits between files and resolves each one through the context. main's live
 *  context reads `state.backend` per call, so after the re-root its next file resolved against B's roots at the same
 *  URL. Bound at arrival, it stops instead. */

import { describe, it, expect } from 'vitest';
import { bindToArrival, ProjectSwitchedError, stoppedBySwitch } from '../../electron/requestContext';
import type { BackendContext } from '../../plugins/backend/editorBackendRouter';

/** main.ts's shape: a context whose members read the open project LIVE. */
function liveHost() {
  const state = { root: '/p/A', backend: { root: '/p/A' } };
  const live = {
    get projectRoot() { return state.root; },
    resolveAssetPath: (url: string) => `${state.backend.root}${url}`,
    getSchema: () => 'schema',
  } as unknown as BackendContext;
  const reRoot = () => { state.root = '/p/B'; state.backend = { root: '/p/B' }; };
  const contextFor = () => { const b = state.backend; return bindToArrival(live, () => state.backend === b); };
  return { state, live, reRoot, contextFor };
}

describe('bindToArrival (#1991)', () => {
  it('a reimport loop that spans a re-root stops at its next file; nothing resolves into B', async () => {
    const host = liveHost();
    const ctx = host.contextFor();
    const touched: string[] = [];
    let stoppedWith: unknown = null;
    try {
      for (const url of ['/assets/a.png', '/assets/b.png', '/assets/c.png']) {
        touched.push(ctx.resolveAssetPath(url)!);
        await Promise.resolve(); // the reimport's await between files
        if (url === '/assets/a.png') host.reRoot();
      }
    } catch (e) { stoppedWith = e; }
    expect(touched).toEqual(['/p/A/assets/a.png']);
    expect(stoppedWith).toBeInstanceOf(ProjectSwitchedError);
    expect((stoppedWith as ProjectSwitchedError).arrivedIn).toBe('/p/A');
    expect(ctx.projectRoot).toBe('/p/A'); // the plain value was read at arrival
  });

  it('ACCEPT: a request arriving after the re-root works on the new project; editor-level members keep working', () => {
    const host = liveHost();
    const before = host.contextFor();
    host.reRoot();
    const after = host.contextFor();
    expect(after.resolveAssetPath('/assets/a.png')).toBe('/p/B/assets/a.png');
    expect(after.projectRoot).toBe('/p/B');
    expect((before as unknown as { getSchema(): string }).getSchema()).toBe('schema');
  });


  it('the bookkeeping after a landed write does NOTHING after a re-root, rather than turning that write into a "retry" error', () => {
    const marked: string[] = [];
    let current = true;
    const ctx = bindToArrival({ projectRoot: '/p/A', markEditorWrite: (abs: string) => { marked.push(abs); } } as unknown as BackendContext, () => current);
    ctx.markEditorWrite('/p/A/assets/a.json', null);
    current = false; // the re-root lands between the write and its fingerprint
    expect(() => ctx.markEditorWrite('/p/A/assets/b.json', null)).not.toThrow();
    expect(marked).toEqual(['/p/A/assets/a.json']); // the old backend is gone: nothing to fingerprint for
    expect(stoppedBySwitch(ctx)).toBeNull();         // and the request is not reported as stopped
  });

  it('a stop is recorded on the context, so the server can answer it whatever the route caught', () => {
    const ctx = bindToArrival({ projectRoot: '/p/A', getManifest: () => ({}) } as unknown as BackendContext, () => false);
    expect(stoppedBySwitch(ctx)).toBeNull();
    try { ctx.getManifest(); } catch { /* a route's catch-all swallowing it */ }
    expect(stoppedBySwitch(ctx)).toBeInstanceOf(ProjectSwitchedError);
  });
});
