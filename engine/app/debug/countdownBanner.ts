/** The editor's top banner, and the one countdown built on it: "<thing> in Ns — [act now] [Cancel]". Shared by the
 *  game-code reload (`hmrStaleness.ts`, a reload over unsaved work) and `modoki_refresh` (#1879, a refresh while a human
 *  has the editor focused), so there is one countdown, not two that drift.
 *
 *  Deliberately plain DOM, not React: the banner must survive a render crash that has already taken the panel tree
 *  down (`hmrStaleness.ts`, case 2). */

const BANNER_ID = 'modoki-hmr-banner';

let persistent: { text: string; actions: BannerAction[]; tone: 'warn' | 'info' } | null = null;

/** `id` becomes the button's `data-ui-id`, `hmr.banner.<id>` — named, not found by its text, so an agent can press
 *  Cancel inside a countdown by aiming at it (#1470's sibling). */
export interface BannerAction { id: string; label: string; onClick: () => void }

/** Show (or replace) the banner. Returns a handle so a countdown can retarget the text without rebuilding the node
 *  (which would drop the user's click target). */
export function showBanner(text: string, actions: BannerAction[], tone: 'warn' | 'info' = 'warn', opts: { persistent?: boolean } = {}): {
  setText: (t: string) => void; remove: () => void;
} {
  // A PERSISTENT banner (the "Running STALE" warning) is what the page says until it reloads: a countdown shown over it
  // puts it back when it ends (review F2 — a refresh countdown used to erase it for good).
  if (opts.persistent) persistent = { text, actions, tone };
  document.getElementById(BANNER_ID)?.remove();
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'status');
  el.dataset.uiId = 'hmr.banner';
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
    btn.dataset.uiId = `hmr.banner.${a.id}`;
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

/** How long a countdown gives a human to read it and press Cancel: long enough to read the banner and act, short
 *  enough that the normal flow still feels immediate. */
export const COUNTDOWN_MS = 5000;

export interface CountdownOptions {
  /** The banner's text for the time left. */
  text: (msLeft: number) => string;
  /** The "do it now" button (`hmr.banner.<id>`). */
  now: { id: string; label: string };
  /** Runs once, when the time is up or "now" is pressed. */
  onElapse: () => void;
  /** Runs once, when Cancel (`hmr.banner.cancel`) is pressed. */
  onCancel: () => void;
  ms?: number;
}

/** Countdowns run ONE AT A TIME, in order (review F2). There is one banner, so a second countdown shown over a first
 *  hid it while its timer ran on: pressing the only visible Cancel cancelled the second, and the hidden first still fired
 *  — a game-code reload that discarded unsaved work behind a refresh banner. So a countdown started while another runs
 *  waits for it to end, and a page that reloads at that end never shows it. */
let running = false;
const waiting: (() => void)[] = [];
function nextCountdown(): void {
  running = false;
  const next = waiting.shift();
  if (next) { next(); return; }
  if (persistent && !document.getElementById(BANNER_ID)) showBanner(persistent.text, persistent.actions, persistent.tone);
}

/** Start a countdown banner, or queue it behind the one running. Exactly one of `onElapse` / `onCancel` runs, unless
 *  `stop()` ends it first (a newer countdown of the same producer taking over), when neither does. The banner is
 *  removed when it ends. */
export function startCountdown(o: CountdownOptions): { stop: () => void } {
  let stopped = false;
  let current: { stop: () => void } | null = null;
  const begin = (): void => {
    if (stopped) { nextCountdown(); return; }
    running = true;
    current = runCountdown(o, nextCountdown);
  };
  if (running) waiting.push(begin); else begin();
  return { stop: () => { stopped = true; current?.stop(); } };
}

function runCountdown(o: CountdownOptions, onEnd: () => void): { stop: () => void } {
  const ms = o.ms ?? COUNTDOWN_MS;
  const deadline = Date.now() + ms;
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const end = (): boolean => {
    if (done) return false;
    done = true;
    if (timer) clearInterval(timer);
    banner.remove();
    return true;
  };
  const finish = (cb?: () => void): void => { if (!end()) return; cb?.(); onEnd(); };
  const banner = showBanner(o.text(ms), [
    { id: o.now.id, label: o.now.label, onClick: () => finish(o.onElapse) },
    { id: 'cancel', label: 'Cancel', onClick: () => finish(o.onCancel) },
  ]);
  timer = setInterval(() => {
    const left = deadline - Date.now();
    if (left <= 0) finish(o.onElapse); else banner.setText(o.text(left));
  }, 250);
  return { stop: () => finish() };
}
