/** #2060 — in the packaged editor an engine built-in's import settings are refused by the backend (#1959), so the asset
 *  Inspectors must neither offer them nor tell the human to re-import it to fill in the stats.
 *
 *  The decision is `builtinImportLock.ts`; the packaged flag reaches the renderer through ONE seam, `editorHost.ts`,
 *  filled from `/api/identity` at boot. The hook and the fieldset are rendered with `renderToStaticMarkup` — a probe
 *  component and the fieldset itself, never a panel (docs/editor.md § Panels). */

import { describe, it, expect, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  builtinImportLock, batchImportLock, currentBuiltinImportLock, isEngineBuiltin, BUILTIN_IMPORT_LOCKED_REASON, ENGINE_BUILTIN_PREFIX,
} from '../../packages/modoki/src/editor/panels/assetViews/builtinImportLock';
import { missingStatsHint, MISSING_STATS_HINT } from '../../packages/modoki/src/editor/panels/assetViews/measuredStats';
import { ENGINE_ASSETS_URL_PREFIX } from '../../plugins/assetTypes';
import {
  applyEditorIdentity, isEditorPackaged, setEditorPackaged, subscribeEditorPackaged,
} from '../../packages/modoki/src/editor/editorHost';
import { getOpenProjectRoots, setOpenProjectRoots } from '../../packages/modoki/src/editor/scene/openProjectScenePath';
import { noteMissingLocalStats, resetMissingLocalStats } from '../../packages/modoki/src/editor/scene/missingLocalStats';
import { useMissingLocalStats } from '../../packages/modoki/src/editor/panels/useMissingLocalStats';
import { ImportLockFieldset } from '../../packages/modoki/src/editor/panels/assetViews/ImportLockFieldset';

const FONT = '/modoki/assets/fonts/Inter.ttf';
const PROJECT_FONT = '/assets/fonts/Inter.ttf';

afterEach(() => {
  setEditorPackaged(false);
  setOpenProjectRoots([]);
  resetMissingLocalStats();
});

describe('builtinImportLock', () => {
  it('locks an engine built-in in the packaged editor, with the reason', () => {
    expect(builtinImportLock(FONT, true)).toBe(BUILTIN_IMPORT_LOCKED_REASON);
    expect(builtinImportLock('/modoki/assets/white.hdr', true)).toBe(BUILTIN_IMPORT_LOCKED_REASON);
  });

  /** The dev half: #1959 keeps write-meta/reimport open in a clone, where editing a built-in IS editing the engine. */
  it('leaves a built-in open in a dev editor', () => {
    expect(builtinImportLock(FONT, false)).toBeNull();
  });

  it("never locks the project's own assets", () => {
    expect(builtinImportLock(PROJECT_FONT, true)).toBeNull();
    expect(builtinImportLock('/games/court/assets/fonts/a.ttf', true)).toBeNull();
    expect(builtinImportLock(undefined, true)).toBeNull();
  });

  /** The renderer cannot import the server's constant, so its own spelling is pinned to it: a renamed root would
   *  otherwise stop the lock silently while the backend kept refusing. */
  it("spells the engine root exactly as the backend's refusal does", () => {
    expect(ENGINE_BUILTIN_PREFIX).toBe(`${ENGINE_ASSETS_URL_PREFIX}/`);
  });

  it('matches the engine root by its whole segment, not a prefix of a name', () => {
    expect(isEngineBuiltin('/modoki/assetsX/a.ttf')).toBe(false);
    expect(isEngineBuiltin('/assets/modoki/assets/a.ttf')).toBe(false);
    expect(isEngineBuiltin(FONT)).toBe(true);
  });
});

describe('batchImportLock — a multi-selection with a built-in in it', () => {
  it('locks the whole batch when ANY path is a built-in, in the packaged editor', () => {
    expect(batchImportLock(['/assets/a.png', '/modoki/assets/favicon.png'], true)).toMatch(/Deselect it/);
  });

  it('leaves an all-project batch, and any batch in a dev editor, open', () => {
    expect(batchImportLock(['/assets/a.png', '/assets/b.png'], true)).toBeNull();
    expect(batchImportLock(['/assets/a.png', '/modoki/assets/favicon.png'], false)).toBeNull();
    expect(batchImportLock([], true)).toBeNull();
  });
});

describe('editorHost — the one packaged seam', () => {
  it('reads packaged and the project roots from one identity answer', () => {
    applyEditorIdentity({ packaged: true, projectRoot: '/tmp/p', projectRootReal: '/private/tmp/p' });
    expect(isEditorPackaged()).toBe(true);
    expect(getOpenProjectRoots()).toEqual(['/tmp/p', '/private/tmp/p']);
  });

  /** A failed read, an older host, or a malformed field must fall back to the dev answer — the backend refusal is the
   *  gate, so the UI may only offer LESS when it knows it is packaged. */
  it('treats anything but a literal packaged:true as not packaged', () => {
    for (const identity of [null, undefined, {}, { packaged: 'true' }, { packaged: 1 }, 'packaged']) {
      setEditorPackaged(true);
      applyEditorIdentity(identity);
      expect(isEditorPackaged(), JSON.stringify(identity)).toBe(false);
    }
  });

  it('is what the non-React reader (the agent ops) consults', () => {
    expect(currentBuiltinImportLock(FONT)).toBeNull();
    setEditorPackaged(true);
    expect(currentBuiltinImportLock(FONT)).toBe(BUILTIN_IMPORT_LOCKED_REASON);
  });

  it('notifies a subscriber when the answer changes, and only then', () => {
    let calls = 0;
    const off = subscribeEditorPackaged(() => { calls += 1; });
    setEditorPackaged(true);
    setEditorPackaged(true);
    expect(calls).toBe(1);
    setEditorPackaged(false);
    expect(calls).toBe(2);
    off();
    setEditorPackaged(true);
    expect(calls).toBe(2);
  });
});

function HintProbe({ path }: { path: string }) {
  return <>{String(useMissingLocalStats(path, 'fontCache'))}</>;
}

describe('the missing-stats row on a locked asset', () => {
  /** #1305's point survives the lock: the hook says the stats are missing whether or not a re-import could fix them —
   *  the close-out review caught a first version that answered false and left the rows blank with no word. */
  it('still reports the stats missing for a locked built-in', () => {
    noteMissingLocalStats(FONT, ['fontCache']);
    setEditorPackaged(true);
    expect(renderToStaticMarkup(<HintProbe path={FONT} />)).toBe('true');
  });

  it('names the re-import only where the re-import works', () => {
    expect(missingStatsHint(true)).toBe(MISSING_STATS_HINT);
    expect(missingStatsHint(false)).not.toMatch(/re-import/i);
    expect(missingStatsHint(false)).toMatch(/never computed/);
  });
});

describe('ImportLockFieldset', () => {
  it('disables everything inside it and states the reason when locked', () => {
    const html = renderToStaticMarkup(<ImportLockFieldset lock="the reason"><button>Apply</button></ImportLockFieldset>);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toContain('data-ui-id="assetView.importLocked"');
    expect(html).toContain('the reason');
  });

  it('is an inert wrapper when not locked', () => {
    const html = renderToStaticMarkup(<ImportLockFieldset lock={null}><button>Apply</button></ImportLockFieldset>);
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('assetView.importLocked');
  });
});
