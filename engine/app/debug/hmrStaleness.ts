/** HMR staleness, recovery, and the game-code reload.
 *
 *  WHERE THIS IS ACTIVE — do not "simplify" this to dev-only. The PACKAGED editor spawns
 *  a real Vite dev server and loads its origin (electron/devServer.ts: "the packaged app
 *  == the dev app (one Vite origin)"), so `import.meta.hot` is DEFINED there and every
 *  behaviour below runs for end users of the DMG — which is correct, since that is a real
 *  authoring environment where people edit game code. What genuinely has no HMR is a
 *  shipped GAME build (web/native/playable), where `__MODOKI_EDITOR__` is false so
 *  main.tsx never imports this module at all.
 *
 *  WHY THIS EXISTS: a stale editor doesn't just annoy, it makes MEASUREMENT LIE. Every
 *  Percept claim (`get_scene_state`, journal, `get_editor_state`) is only as trustworthy
 *  as the module graph behind it, and the failure mode is SILENT — neither a human nor an
 *  agent can tell a stale editor from a working one by looking. Two measured incidents:
 *  a correct sling fix was re-diagnosed and nearly reverted because the editor served the
 *  pre-fix build, and a focus-scope fix measured four times as "not working" while stale.
 *
 *  Three jobs, all gated on `import.meta.hot` (present in BOTH the dev and the packaged
 *  editor — see above — and absent only where there is no Vite server at all):
 *    1. GAME CODE  — the dev server (plugins/vite-asset-scanner.ts) sends
 *       `modoki:game-code-changed` because a game edit can ONLY be applied by a reload.
 *       We reload, unless that would destroy unsaved scene work — then we say so loudly.
 *    2. RECOVERY   — a hook-order edit throws inside React Fast Refresh and takes down
 *       mounted panels via their error boundaries. Inherent to Fast Refresh, so DETECT
 *       and reload rather than trying to prevent it.
 *    3. SIGNAL     — track an HMR epoch so `modoki_identity` can answer "has anything
 *       changed under me since boot?" instead of everyone guessing.
 *
 *  Deliberately plain DOM, not React: the banner must survive a render crash that has
 *  already taken the panel tree down, which is exactly case 2. */

interface HmrStatus {
  /** Hot updates applied since this page loaded. 0 means "nothing has changed under me". */
  updates: number;
  /** ms epoch of the most recent update, or null if none. */
  lastUpdateAt: number | null;
  /** The most recently updated module paths (capped — this is a signal, not a log). */
  recentPaths: string[];
  /** True when a game-code reload was CANCELLED, so this editor is knowingly running the
   *  OLD build. Reads here are suspect until it reloads. */
  staleGameCode: boolean;
  /** True when this page load DISCARDED unsaved scene edits to pick up new game code.
   *  Survives the reload (sessionStorage) precisely so the loss is never silent. */
  discardedUnsavedEdits: boolean;
}

const status: HmrStatus = {
  updates: 0, lastUpdateAt: null, recentPaths: [], staleGameCode: false, discardedUnsavedEdits: false,
};

/** Read the current HMR staleness. Safe to call in any build — in a non-dev build it
 *  reports a pristine, never-updated page, which is exactly true there. */
export function getHmrStatus(): HmrStatus {
  return { ...status, recentPaths: [...status.recentPaths] };
}

const RECENT_CAP = 10;
/** A Fast Refresh crash lands within a frame or two of the update; 2s is slack, not a race. */
const CRASH_WINDOW_MS = 2000;
/** One reload per crash, ever. Without this a crash that reproduces on boot would loop. */
const RELOAD_GUARD_KEY = 'modoki:hmr-recovered';
/** Grace window before discarding unsaved scene work. Long enough to read the banner and
 *  hit Cancel or Save; short enough that the normal flow still feels immediate. */
const DISCARD_GRACE_MS = 5000;
/** Set just before a reload that will drop unsaved edits, read back after it. The whole
 *  point: the loss outlives the page that caused it, so it can be reported. */
const DISCARDED_KEY = 'modoki:hmr-discarded';

/** React's Fast Refresh hook-order failures. These are UNRECOVERABLE in place: the fiber's
 *  hook list no longer matches the component's, so every subsequent render throws too. */
const HOOK_ORDER_SIGNATURES = [
  'Rendered more hooks than during the previous render',
  'Rendered fewer hooks than expected',
  'Should have a queue',
  'change in the order of Hooks',
];

function isHookOrderError(message: string): boolean {
  return HOOK_ORDER_SIGNATURES.some((sig) => message.includes(sig));
}

const BANNER_ID = 'modoki-hmr-banner';

interface BannerAction { label: string; onClick: () => void }

/** Show (or replace) the HMR banner. Returns a handle so a countdown can retarget the
 *  text without rebuilding the node (which would drop the user's click target). */
function showBanner(text: string, actions: BannerAction[], tone: 'warn' | 'info' = 'warn'): {
  setText: (t: string) => void; remove: () => void;
} {
  document.getElementById(BANNER_ID)?.remove();
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'status');
  const bg = tone === 'warn' ? '#7a3b00' : '#1f3a5f';
  const border = tone === 'warn' ? '#c26a10' : '#3d6ea8';
  el.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'top:8px', 'z-index:2147483647',
    'display:flex', 'gap:10px', 'align-items:center',
    'padding:8px 14px', 'border-radius:6px',
    `background:${bg}`, 'color:#fff', `border:1px solid ${border}`,
    'font:13px/1.4 system-ui,sans-serif', 'box-shadow:0 4px 14px rgba(0,0,0,.45)',
  ].join(';');
  const label = document.createElement('span');
  label.textContent = text;
  el.append(label);
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.style.cssText =
      `padding:3px 10px;border-radius:4px;border:0;background:#fff;color:${bg};font-weight:600;cursor:pointer`;
    btn.onclick = a.onClick;
    el.append(btn);
  }
  document.body.appendChild(el);
  return {
    setText: (t: string) => { label.textContent = t; },
    remove: () => el.remove(),
  };
}

/** Fire-and-forget editor-journal emit, so a discarded-work event is visible to
 *  `editor_journal` and not only to whoever was looking at the screen. */
function journal(type: string, payload: unknown): void {
  void import('@modoki/engine/editor')
    .then(({ editorEmit }) => editorEmit(type, payload))
    .catch(() => { /* no editor on this route */ });
}

/** The subset of Vite's hot context this module uses. Named so a test can supply a fake
 *  one — `import.meta.hot` is undefined under vitest, so without this seam every branch
 *  below (including the only code path that can destroy user work) would be untestable. */
export interface HotLike {
  // Loosely typed on purpose: Vite's ViteHotContext.on is overloaded over its known event
  // map, and a structural subtype of that is not assignable to a single narrow signature.
  on: (event: string, cb: (payload: never) => void) => void;
}


/** Reads the live unsaved-scene flag. Injectable for tests; defaults to the real editor. */
export type DirtyProbe = () => boolean | Promise<boolean>;

const defaultDirtyProbe: DirtyProbe = async () => {
  try {
    // Dynamic + guarded: the editor barrel must not be pulled into a game bundle.
    const { hasUnsavedChanges } = await import('@modoki/engine/editor');
    return hasUnsavedChanges();
  } catch {
    // No editor on this route (plain game page in dev) — nothing to lose.
    return false;
  }
};

/** Install the HMR staleness/recovery handlers. No-ops where there is no Vite hot context
 *  (a shipped game build). Call once — `main.tsx` is the only caller. */
export function initHmrStaleness(
  hot: HotLike | undefined = import.meta.hot as unknown as HotLike | undefined,
  isDirty: DirtyProbe = defaultDirtyProbe,
): void {
  if (!hot) return;

  hot.on('vite:afterUpdate', (payload: { updates?: { path: string }[] }) => {
    status.updates += 1;
    status.lastUpdateAt = Date.now();
    for (const u of payload?.updates ?? []) {
      status.recentPaths.unshift(u.path);
    }
    status.recentPaths.length = Math.min(status.recentPaths.length, RECENT_CAP);
  });

  // ── 0. Report a loss the PREVIOUS page took, before anything else ──
  // The discard happens on a page that is about to die, so the only way it can be
  // reported is to carry it across the reload.
  try {
    const raw = sessionStorage.getItem(DISCARDED_KEY);
    if (raw) {
      sessionStorage.removeItem(DISCARDED_KEY);
      const { file } = JSON.parse(raw) as { file?: string };
      status.discardedUnsavedEdits = true;
      console.warn(`[modoki] unsaved scene edits were DISCARDED to load changed game code (${file}).`);
      journal('!hmr.discarded-unsaved', { file });
      const b = showBanner(
        'Unsaved scene edits were discarded to load changed game code',
        [{ label: 'Dismiss', onClick: () => b.remove() }],
        'info',
      );
    }
  } catch { /* sessionStorage unavailable */ }

  // ── 1. Game code changed → reload; warn first if that costs unsaved work ──
  let countdown: ReturnType<typeof setInterval> | null = null;
  hot.on('modoki:game-code-changed', async (data: { file?: string }) => {
    const file = data?.file ?? 'game code';
    const dirty = await isDirty();
    if (!dirty) {
      console.info(`[modoki] game code changed (${file}) — reloading to apply.`);
      location.reload();
      return;
    }

    // Dirty: the reload WILL happen (that is the chosen policy — stale code is the worse
    // failure), but never as a surprise. A grace window makes the warning readable and
    // leaves an escape hatch; doing nothing takes the loss.
    if (countdown) clearInterval(countdown);
    const deadline = Date.now() + DISCARD_GRACE_MS;
    const discardNow = async (): Promise<void> => {
      if (countdown) clearInterval(countdown);
      // RE-CHECK, don't trust the flag captured 5s ago. Saving is an advertised response to
      // this banner, so the common case is that the scene is CLEAN by now — recording a
      // discard that never happened would poison the one signal
      // (`discardedUnsavedEdits` / `!hmr.discarded-unsaved`) that docs tell agents to trust.
      if (await isDirty()) {
        try { sessionStorage.setItem(DISCARDED_KEY, JSON.stringify({ file, at: Date.now() })); }
        catch { /* best effort — the reload still has to happen */ }
      }
      location.reload();
    };
    const text = (msLeft: number) =>
      `Game code changed — reloading in ${Math.ceil(msLeft / 1000)}s; unsaved scene changes will be LOST`;
    const banner = showBanner(text(DISCARD_GRACE_MS), [
      { label: 'Reload now', onClick: () => { void discardNow(); } },
      {
        label: 'Cancel',
        onClick: () => {
          if (countdown) clearInterval(countdown);
          // Cancelling is a deliberate choice to keep the edits AND the old build. That is
          // a stale editor, so say so loudly and keep saying it — this is the state where
          // measurements silently lie.
          status.staleGameCode = true;
          console.warn(
            `[modoki] reload cancelled — this editor is now running STALE game code (${file}). ` +
            `Save and reload before trusting anything you measure here.`,
          );
          journal('!hmr.stale-game-code', { file });
          showBanner('Running STALE game code — reload to apply', [
            { label: 'Reload', onClick: () => location.reload() },
          ]);
        },
      },
    ]);
    console.warn(
      `[modoki] game code changed (${file}) and the scene has UNSAVED CHANGES — ` +
      `reloading in ${DISCARD_GRACE_MS / 1000}s, which will discard them.`,
    );
    countdown = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) void discardNow();
      else banner.setText(text(left));
    }, 250);
  });

  // ── 2. Unrecoverable Fast Refresh (hook-order) → reload once ──
  const recentlyUpdated = () =>
    status.lastUpdateAt !== null && Date.now() - status.lastUpdateAt < CRASH_WINDOW_MS;

  const recover = (message: string): void => {
    if (!isHookOrderError(message) || !recentlyUpdated()) return;
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
      console.error(
        '[modoki] hook-order crash again after an HMR reload — NOT reloading a second time. ' +
        'This is a real defect in the edit, not an HMR artifact.',
      );
      return;
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    console.warn('[modoki] hot update changed hook order — reloading (Fast Refresh cannot apply this).');
    location.reload();
  };

  window.addEventListener('error', (e) => recover(e.message || String(e.error?.message ?? '')));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    recover(r?.message ?? String(r ?? ''));
  });
  // A clean update means the previous crash is behind us — re-arm the one-shot.
  hot.on('vite:afterUpdate', () => sessionStorage.removeItem(RELOAD_GUARD_KEY));
}
