// @vitest-environment jsdom
/** EditorApp layout-persistence logic (#126), extracted to `utils/layoutStore.ts`
 *  because it was already pure and already at module scope — merely unexported
 *  and stuck inside EditorApp.tsx, which can't be imported in a test (it pulls
 *  CSS, every panel, SceneView/Three/Pixi). Covers the DECISIONS: the
 *  `loadInitialModel` precedence ladder, the `toModel`/`normalizeTabTitles`
 *  self-heal, auto-dock bookkeeping, and the round-trip/degrade behaviour of the
 *  read/write helpers. backendFetch is mocked so no dev server is needed. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Model } from 'flexlayout-react';
import type { IJsonModel } from 'flexlayout-react';

const backendFetch = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetch(...args),
}));

// This jsdom env doesn't provide localStorage (same gap newScene.test.ts works
// around) — back it with a tiny in-memory store.
function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}
installLocalStorage();

import { AUTOSAVE_NAME } from '../../src/editor/utils/layoutNames';
import { dockPanel } from '../../src/editor/panelDock';
import {
  defaultLayout, PANEL_LABELS, panelLabel,
  LAYOUT_KEY, LAYOUT_NAME_KEY, AUTODOCK_KEY,
  autoDockedPanels, markAutoDocked,
  saveLayout, loadLayout, currentLayoutName,
  writeLayoutJson, writeLayout, downloadLayoutJson, readLayout,
  toModel, normalizeTabTitles, loadInitialModel, clearStoredLayout, orderLayoutChoices,
  takeLayoutResetFlag, LAYOUT_RESET_KEY, _resetLayoutLoadMemoForTests,
} from '../../src/editor/utils/layoutStore';

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const notOk = () => ({ ok: false, json: async () => ({}) }) as unknown as Response;

// A minimal, valid IJsonModel with a single tab so Model.fromJson succeeds.
const minimalModel = (component = 'scene', name = 'Scene'): IJsonModel => ({
  global: {},
  borders: [],
  layout: { type: 'row', weight: 100, children: [{ type: 'tabset', weight: 100, children: [{ type: 'tab', name, component }] }] },
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  _resetLayoutLoadMemoForTests(); // each test is a fresh page load
  backendFetch.mockReset();
});

describe('panelLabel', () => {
  it('returns the built-in label for a known panel id', () => {
    expect(panelLabel('scene', [])).toBe(PANEL_LABELS.scene);
    expect(panelLabel('skin-editor', [])).toBe('2D Skin');
  });
  it('falls through to a custom panel name when not a built-in', () => {
    expect(panelLabel('my-game-panel', [{ id: 'my-game-panel', name: 'My Panel' }])).toBe('My Panel');
  });
  it('falls back to the raw id when neither matches', () => {
    expect(panelLabel('unknown-id', [{ id: 'other', name: 'Other' }])).toBe('unknown-id');
  });
});

describe('autoDockedPanels / markAutoDocked', () => {
  it('starts empty when localStorage has nothing', () => {
    expect(autoDockedPanels()).toEqual(new Set());
  });
  it('yields empty on corrupt stored JSON rather than throwing', () => {
    localStorage.setItem(AUTODOCK_KEY, '{not json');
    expect(() => autoDockedPanels()).not.toThrow();
    expect(autoDockedPanels()).toEqual(new Set());
  });
  it('accumulates ids across calls (set union)', () => {
    markAutoDocked(['ai']);
    markAutoDocked(['profiler', 'ai']);
    expect(autoDockedPanels()).toEqual(new Set(['ai', 'profiler']));
  });
});

describe('saveLayout / loadLayout / currentLayoutName', () => {
  it('round-trips a model through localStorage', () => {
    const m = Model.fromJson(minimalModel());
    saveLayout(m);
    const loaded = loadLayout();
    expect(loaded).not.toBeNull();
    expect(loaded?.layout).toBeDefined();
  });
  it('loadLayout returns null when nothing is stored', () => {
    expect(loadLayout()).toBeNull();
  });
  it('loadLayout returns null on corrupt stored JSON', () => {
    localStorage.setItem(LAYOUT_KEY, '{not json');
    expect(loadLayout()).toBeNull();
  });
  it('currentLayoutName reads LAYOUT_NAME_KEY directly', () => {
    expect(currentLayoutName()).toBeNull();
    localStorage.setItem(LAYOUT_NAME_KEY, 'my-layout');
    expect(currentLayoutName()).toBe('my-layout');
  });
});

describe('readLayout / writeLayoutJson', () => {
  it('readLayout returns parsed JSON on an ok response', async () => {
    backendFetch.mockResolvedValueOnce(okJson(minimalModel()));
    const result = await readLayout('foo');
    expect(result).toMatchObject({ layout: expect.any(Object) });
    expect(backendFetch).toHaveBeenCalledWith(expect.stringContaining('/api/layout?name=foo'));
  });
  it('readLayout degrades to null on a non-ok response', async () => {
    backendFetch.mockResolvedValueOnce(notOk());
    expect(await readLayout('missing')).toBeNull();
  });
  it('readLayout degrades to null when fetch throws', async () => {
    backendFetch.mockRejectedValueOnce(new Error('network down'));
    expect(await readLayout('foo')).toBeNull();
  });
  it('writeLayoutJson resolves true on an ok response', async () => {
    backendFetch.mockResolvedValueOnce(okJson({}));
    expect(await writeLayoutJson('foo', { a: 1 })).toBe(true);
  });
  it('writeLayoutJson degrades to false on a non-ok response', async () => {
    backendFetch.mockResolvedValueOnce(notOk());
    expect(await writeLayoutJson('foo', {})).toBe(false);
  });
  it('writeLayoutJson degrades to false when fetch throws', async () => {
    backendFetch.mockRejectedValueOnce(new Error('boom'));
    expect(await writeLayoutJson('foo', {})).toBe(false);
  });
  it('writeLayout serializes the model and calls writeLayoutJson', async () => {
    backendFetch.mockResolvedValueOnce(okJson({}));
    const m = Model.fromJson(minimalModel());
    expect(await writeLayout('foo', m)).toBe(true);
    const body = JSON.parse((backendFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.name).toBe('foo');
    expect(body.content).toMatchObject({ layout: expect.any(Object) });
  });
});

describe('toModel', () => {
  it('returns null for null/undefined', () => {
    expect(toModel(null)).toBeNull();
    expect(toModel(undefined)).toBeNull();
  });
  it('returns null for garbage that is not a valid model shape', () => {
    expect(toModel('not a model')).toBeNull();
    expect(toModel({ nonsense: true })).toBeNull();
    expect(toModel(42)).toBeNull();
  });
  it('builds a Model from valid JSON', () => {
    const m = toModel(minimalModel());
    expect(m).toBeInstanceOf(Model);
  });

  it('runs the title migration on the way in — a RESTORED layout self-heals', () => {
    // The link the two units either side of it don't prove: `toModel` calls
    // `normalizeTabTitles`, which is the only reason a layout persisted before a panel
    // was renamed comes back with the CURRENT name. Tested here because every restore
    // path (tracked / autosave / mirror) reaches it through `toModel` and nothing else.
    const m = toModel(minimalModel('skin-editor', 'Skin'))!;
    let name: string | undefined;
    m.visitNodes((n) => { if (n.getType() === 'tab') name = (n as unknown as { getName(): string }).getName(); });
    expect(name).toBe('2D Skin');
  });
});

describe('normalizeTabTitles', () => {
  it('retitles a stale built-in tab name to the current PANEL_LABELS value', () => {
    const m = Model.fromJson(minimalModel('skin-editor', 'Skin'));
    normalizeTabTitles(m);
    let name: string | undefined;
    m.visitNodes((n) => { if (n.getType() === 'tab') name = (n as unknown as { getName(): string }).getName(); });
    expect(name).toBe('2D Skin');
  });
  it('leaves a custom-panel tab (unknown component) alone', () => {
    const m = Model.fromJson(minimalModel('my-game-panel', 'My Panel'));
    normalizeTabTitles(m);
    let name: string | undefined;
    m.visitNodes((n) => { if (n.getType() === 'tab') name = (n as unknown as { getName(): string }).getName(); });
    expect(name).toBe('My Panel');
  });
});

/** `defaultLayout` is a hand-written literal that every new editor and every
 *  *Reset Layout* renders, and nothing type-checks its `component` strings against
 *  the panel registry — a typo ships "Unknown panel: <id>" to a first-time user, in
 *  the one layout nobody's saved state can mask. These pin the literal itself. */
describe('defaultLayout is a well-formed panel arrangement', () => {
  const tabs = (): { component: string; name: string }[] => {
    const out: { component: string; name: string }[] = [];
    Model.fromJson(defaultLayout).visitNodes((n) => {
      if (n.getType() !== 'tab') return;
      const t = n as unknown as { getComponent(): string; getName(): string };
      out.push({ component: t.getComponent(), name: t.getName() });
    });
    return out;
  };

  it('names only registered built-in panels, with their current labels', () => {
    // PANEL_LABELS is the built-in panel vocabulary (EditorApp's PANELS mirrors it).
    // A component outside it has no factory entry → the tab renders "Unknown panel".
    for (const { component, name } of tabs()) {
      expect(PANEL_LABELS, `unknown panel id "${component}" in defaultLayout`).toHaveProperty(component);
      // A stale title is self-healed by normalizeTabTitles at load, but the SOURCE
      // should not be the thing that needs healing.
      expect(name).toBe(PANEL_LABELS[component]);
    }
  });

  it('docks each panel exactly once', () => {
    // A duplicate tab makes isPanelVisible/dockPanel ambiguous: the Window menu
    // would tick the panel, closing one copy would leave the other open.
    const ids = tabs().map((t) => t.component);
    expect([...new Set(ids)].sort()).toEqual([...ids].sort());
  });

  it('keeps a Scene tabset for dockPanel to aim at', () => {
    // The seam: the Window menu and the openByDefault auto-dock both route through
    // dockPanel, which targets the tabset CONTAINING `scene` and only falls back to
    // the first tabset. Restructuring the default must not strand that target — the
    // first tabset is now Game's, so the fallback would dock panels in the wrong place.
    const model = Model.fromJson(defaultLayout);
    expect(dockPanel(model, 'profiler', 'Profiler')).toBe('added');
    let sceneTabsetHasProfiler = false;
    model.visitNodes((n) => {
      if (n.getType() !== 'tabset') return;
      const kids = (n as unknown as { getChildren(): { getComponent?: () => string }[] }).getChildren();
      const ids = kids.map((c) => c.getComponent?.());
      if (ids.includes('scene') && ids.includes('profiler')) sceneTabsetHasProfiler = true;
    });
    expect(sceneTabsetHasProfiler).toBe(true);
  });

  it('re-docking an already-present panel focuses it instead of duplicating it', () => {
    // Every asset editor is in the default now, so the Window menu's common case is
    // "already open" — which must take dockPanel's focus branch, not add a second tab.
    const model = Model.fromJson(defaultLayout);
    expect(dockPanel(model, 'particle-editor', 'Particle Editor')).toBe('focused');
    let count = 0;
    model.visitNodes((n) => {
      if (n.getType() === 'tab' && (n as unknown as { getComponent(): string }).getComponent() === 'particle-editor') count++;
    });
    expect(count).toBe(1);
  });
});

describe('loadInitialModel precedence ladder', () => {
  it('falls all the way to the default when nothing is stored/reachable', async () => {
    backendFetch.mockResolvedValue(notOk());
    const { model, fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(true);
    let sawScene = false;
    model.visitNodes((n) => { if (n.getType() === 'tab' && (n as unknown as { getComponent(): string }).getComponent() === 'scene') sawScene = true; });
    expect(sawScene).toBe(true);
    // Model.fromJson mints fresh node ids each call, so compare structure
    // (component/name/type — ids stripped) rather than the raw JSON.
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (k, val) => (k === 'id' ? undefined : val));
    expect(strip(model.toJson())).toEqual(strip(Model.fromJson(defaultLayout).toJson()));
  });

  it('uses the localStorage mirror when present and nothing else resolves', async () => {
    backendFetch.mockResolvedValue(notOk());
    saveLayout(Model.fromJson(minimalModel('assets', 'Assets')));
    const { model, fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(false);
    let component: string | undefined;
    model.visitNodes((n) => { if (n.getType() === 'tab') component = (n as unknown as { getComponent(): string }).getComponent(); });
    expect(component).toBe('assets');
  });

  it('prefers the autosave over the localStorage mirror', async () => {
    saveLayout(Model.fromJson(minimalModel('assets', 'Assets'))); // mirror present but should lose
    backendFetch.mockImplementation(async (url: string) => {
      if (url.includes(`name=${AUTOSAVE_NAME}`)) return okJson(minimalModel('console', 'Console'));
      return notOk();
    });
    const { model, fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(false);
    let component: string | undefined;
    model.visitNodes((n) => { if (n.getType() === 'tab') component = (n as unknown as { getComponent(): string }).getComponent(); });
    expect(component).toBe('console');
  });

  it('prefers the tracked layout over the autosave', async () => {
    localStorage.setItem(LAYOUT_NAME_KEY, 'my-named-layout');
    backendFetch.mockImplementation(async (url: string) => {
      if (url.includes('name=my-named-layout')) return okJson(minimalModel('inspector', 'Inspector'));
      if (url.includes(`name=${AUTOSAVE_NAME}`)) return okJson(minimalModel('console', 'Console'));
      return notOk();
    });
    const { model, fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(false);
    let component: string | undefined;
    model.visitNodes((n) => { if (n.getType() === 'tab') component = (n as unknown as { getComponent(): string }).getComponent(); });
    expect(component).toBe('inspector');
    // the tracked reference is still valid, so it must NOT be cleared
    expect(currentLayoutName()).toBe('my-named-layout');
  });

  it('drops a stale tracked-layout reference (removes LAYOUT_NAME_KEY) when it no longer resolves', async () => {
    localStorage.setItem(LAYOUT_NAME_KEY, 'deleted-layout');
    backendFetch.mockResolvedValue(notOk()); // nothing resolves — including the stale tracked name
    const { fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(true);
    expect(currentLayoutName()).toBeNull();
  });

  it('also drops it when the tracked layout EXISTS but is corrupt', async () => {
    // The tracked branch has two ways to fail and only the first was covered: the fetch missing,
    // and the fetch SUCCEEDING with a payload `toModel` then rejects. The second is the one that
    // matters in practice — a layout file truncated by a crash still serves 200 — and it must
    // clear the reference too, or the editor retries the same unusable layout on every boot.
    localStorage.setItem(LAYOUT_NAME_KEY, 'corrupt-layout');
    backendFetch.mockImplementation(async (url: string) =>
      (url.includes('name=corrupt-layout') ? okJson({ nonsense: true }) : notOk()));
    const { fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(true);          // fell all the way through
    expect(currentLayoutName()).toBeNull();  // and did not keep pointing at the bad layout
  });
});

describe('downloadLayoutJson', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:fake-url');
    revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    clickSpy.mockRestore();
    vi.useRealTimers();
  });

  it('names the download <sanitized-name>.layout.json and clicks the anchor', () => {
    let capturedHref = '';
    let capturedDownload = '';
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          get: () => capturedDownload,
          set: (v: string) => { capturedDownload = v; },
        });
        Object.defineProperty(el, 'href', {
          get: () => capturedHref,
          set: (v: string) => { capturedHref = v; },
        });
      }
      return el;
    });
    downloadLayoutJson('My Cool Layout!', { layout: {} });
    expect(capturedDownload).toBe('My-Cool-Layout.layout.json');
    expect(capturedHref).toBe('blob:fake-url');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });

  it('does NOT revoke the object URL synchronously — only on a later tick', () => {
    downloadLayoutJson('name', { layout: {} });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

describe('orderLayoutChoices', () => {
  it('pins the autosave to the top under a friendly label', () => {
    // It is the recovery point, not something the user named — so it must not sort in
    // among the named layouts as the literal string "autosave".
    const out = orderLayoutChoices(['zebra', AUTOSAVE_NAME, 'alpha']);
    expect(out[0]).toEqual({ name: AUTOSAVE_NAME, label: 'Last session (auto-saved)' });
  });
  it('sorts the named layouts by LOCALE, labelled by their own name', () => {
    // `localeCompare`, not a raw `<`: collation order is case-insensitive, so `Mid`
    // lands between `alpha` and `zebra` rather than ahead of both the way ASCII
    // ordering would put it. That is the behaviour a human expects from a name list,
    // and it is worth pinning — a "simplification" to `a < b` would silently move
    // every capitalised layout to the top.
    expect(orderLayoutChoices(['zebra', 'alpha', 'Mid'])).toEqual([
      { name: 'alpha', label: 'alpha' },
      { name: 'Mid', label: 'Mid' },
      { name: 'zebra', label: 'zebra' },
    ]);
  });
  it('handles an empty list and a list with no autosave', () => {
    expect(orderLayoutChoices([])).toEqual([]);
    expect(orderLayoutChoices(['only'])).toEqual([{ name: 'only', label: 'only' }]);
  });
});

describe('clearStoredLayout', () => {
  it('removes both LAYOUT_KEY and LAYOUT_NAME_KEY', () => {
    localStorage.setItem(LAYOUT_KEY, '{}');
    localStorage.setItem(LAYOUT_NAME_KEY, 'foo');
    clearStoredLayout();
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
    expect(localStorage.getItem(LAYOUT_NAME_KEY)).toBeNull();
  });

  /** QA-EDITOR-0004: dropping the two localStorage keys was never enough — the server-side
   *  autosave outranks both, so Reset Layout handed back the layout being reset. */
  it('arms the one-shot reset marker so the next load skips every restore tier', () => {
    clearStoredLayout();
    expect(sessionStorage.getItem(LAYOUT_RESET_KEY)).toBe('1');
  });

  it('takeLayoutResetFlag clears the marker on the first read, but keeps ANSWERING for this load', () => {
    clearStoredLayout();
    expect(takeLayoutResetFlag()).toBe(true);
    expect(sessionStorage.getItem(LAYOUT_RESET_KEY)).toBeNull(); // consumed…
    expect(takeLayoutResetFlag()).toBe(true);                    // …but still true THIS load
    _resetLayoutLoadMemoForTests();                              // a fresh page load
    expect(takeLayoutResetFlag()).toBe(false);
  });

  /** `main.tsx` wraps the app in <StrictMode>, so in dev React runs EditorApp's init effect,
   *  discards it, and runs it again — two `loadInitialModel()` calls in one page load, the
   *  SECOND of which is the live one. A read-and-clear marker was consumed by the discarded
   *  first call, so Reset Layout silently regressed to restoring the autosave every single
   *  time. Found by the close-out review of the fix itself. */
  it('survives StrictMode: the SECOND loadInitialModel of the same load is still the default', async () => {
    saveLayout(Model.fromJson(minimalModel('assets', 'Assets')));
    backendFetch.mockImplementation(async (url: string) =>
      (url.includes(`name=${AUTOSAVE_NAME}`) ? okJson(minimalModel('console', 'Console')) : notOk()));

    clearStoredLayout();
    const first = await loadInitialModel();   // React's discarded invocation
    const second = await loadInitialModel();  // the one that actually renders
    expect(first.fromDefault).toBe(true);
    expect(second.fromDefault).toBe(true);

    _resetLayoutLoadMemoForTests();           // the NEXT real page load
    expect((await loadInitialModel()).fromDefault).toBe(false);
  });

  it('after a reset, loadInitialModel returns the DEFAULT even though an autosave exists', async () => {
    saveLayout(Model.fromJson(minimalModel('assets', 'Assets')));
    localStorage.setItem(LAYOUT_NAME_KEY, 'my-named-layout');
    backendFetch.mockImplementation(async (url: string) => {
      if (url.includes('name=my-named-layout')) return okJson(minimalModel('inspector', 'Inspector'));
      if (url.includes(`name=${AUTOSAVE_NAME}`)) return okJson(minimalModel('console', 'Console'));
      return notOk();
    });

    clearStoredLayout();
    const { model, fromDefault } = await loadInitialModel();
    expect(fromDefault).toBe(true);
    let sawScene = false;
    model.visitNodes((n) => { if (n.getType() === 'tab' && (n as unknown as { getComponent(): string }).getComponent() === 'scene') sawScene = true; });
    expect(sawScene).toBe(true);

    // ONE-SHOT PER LOAD: the very next PAGE LOAD restores normally again (the autosave is
    // still a recovery point, it just no longer defeats the menu item).
    _resetLayoutLoadMemoForTests();
    const again = await loadInitialModel();
    expect(again.fromDefault).toBe(false);
  });
});
