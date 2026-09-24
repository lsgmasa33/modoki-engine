/** Which of a take's assets changed between recording it and rendering it (#1509).
 *
 *  A render loads the scene, its prefabs, materials and textures from the project's files as they
 *  are NOW, not as they were when the take was played. That is deliberate — re-rendering a take after
 *  an art change is what the recorder is for, and much of a game's art (colour, size, position) is
 *  authored in the scene itself, so freezing the scene into the take would freeze the art too. The
 *  cost is that an edit made after the take can change the video silently: a moved button makes a
 *  recorded tap miss (the replay check catches that — the game emits something else), but a purely
 *  visual change emits nothing different and passes it.
 *
 *  So the take records a FINGERPRINT of the project's assets when Play is pressed, and the render
 *  compares it with the files it just used and names what changed. It reports; it never refuses.
 *
 *  "The files it used" is the GUID closure of the scenes the replay loaded: each JSON asset's GUID
 *  references followed transitively (scene → prefab → material → texture), plus each asset's
 *  `.meta.json` sidecar, whose import settings change what a texture looks like. A file outside the
 *  closure is not reported. The closure follows EVERY GUID, so it errs toward reporting too much: a
 *  level that names the next one by GUID pulls the next level in, whether or not the take got there.
 *
 *  Not covered, and said so in docs/gameplay-recorder.md: game CODE, the engine's own assets
 *  (`/modoki/assets`), and an asset reached only through a GUID written in code — which the build
 *  cannot see either (CLAUDE.md § Single source of truth, #53). */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TakeAssets } from '../packages/modoki/src/editor/recorder/take';

/** The project folder a fingerprint covers, relative to the project root — where every game keeps
 *  its assets (`findAssetRoots`' flat one-game root). */
export const TAKE_ASSETS_DIR = 'runtime/assets';

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const META_SUFFIX = '.meta.json';

/** Every file under the project's assets folder → a content hash. Paths are relative to that
 *  folder, with forward slashes. Async, one file at a time, so the backend keeps serving the editor
 *  while it runs (Court: ~1,400 files, 50 MB, 0.1–0.3 s).
 *
 *  ⚠️ **A missing folder THROWS rather than answering `{}`.** An empty fingerprint is not "no
 *  assets", it is "every asset is new": the render would list each file the take uses as `(new)`.
 *  An editor whose project root is the repo root (a bare `npm run dev`) has no `runtime/assets`
 *  of its own, so its takes carry no fingerprint and their renders read `unchecked` (#1509 review).
 *
 *  A file that cannot be read between the listing and its read (the atomic writers rename
 *  `<file>.tmp` into place inside this folder; on Windows a scanner can hold a file) is not fatal.
 *  It is recorded as `UNREADABLE` rather than left out, because a file missing from the recorded
 *  fingerprint reads as "created since the take" — a false `(new)` (#1509 review 2). The compare
 *  skips it on either side. A folder that cannot be LISTED throws, for the same reason `{}` does. */
export async function fingerprintAssets(projectRoot: string): Promise<TakeAssets> {
  const dir = path.join(projectRoot, TAKE_ASSETS_DIR);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no ${TAKE_ASSETS_DIR} folder in ${projectRoot} — nothing to fingerprint`);
  }
  const files: Record<string, string> = {};
  for (const rel of listFiles(dir)) {
    try { files[rel] = hashBytes(await fs.promises.readFile(path.join(dir, rel))); } catch { files[rel] = UNREADABLE; }
  }
  return { dir: TAKE_ASSETS_DIR, files };
}

/** The hash of a file that was listed but could not be read. Never compared, on either side. */
export const UNREADABLE = 'unreadable';

/** 64 bits of SHA-256 — a change detector, not a signature. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    // The root must list (an unlistable root would fingerprint as `{}`); a subfolder that vanished
    // mid-walk is skipped.
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { if (!rel) throw e; return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** GUID → the asset file that owns it: a JSON asset's top-level `id`, and a sidecar's `id` plus
 *  every sub-asset `guid` in it (a sliced sprite's frames), all mapped to the asset beside it. */
export function guidIndex(rels: readonly string[], read: (rel: string) => string | null): Map<string, string> {
  const index = new Map<string, string>();
  for (const rel of rels) {
    if (!rel.endsWith('.json')) continue;
    const text = read(rel);
    if (text === null) continue;
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { continue; }
    if (!doc || typeof doc !== 'object') continue;
    const id = (doc as { id?: unknown }).id;
    if (rel.endsWith(META_SUFFIX)) {
      const asset = rel.slice(0, -META_SUFFIX.length);
      if (typeof id === 'string') index.set(id.toLowerCase(), asset);
      for (const g of subAssetGuids(doc)) if (!index.has(g)) index.set(g, asset);
    } else if (typeof id === 'string') {
      index.set(id.toLowerCase(), rel);
    }
  }
  return index;
}

function subAssetGuids(doc: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      if (k === 'guid' && typeof child === 'string') out.push(child.toLowerCase());
      else visit(child);
    }
  };
  visit(doc);
  return out;
}

/** The files a render of `roots` reads: each root, every asset its JSON references by GUID,
 *  transitively, and each one's sidecar where it has one. `exists` answers for sidecars. */
export function assetClosure(
  roots: readonly string[],
  index: ReadonlyMap<string, string>,
  read: (rel: string) => string | null,
  exists: (rel: string) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith(META_SUFFIX) && exists(rel + META_SUFFIX)) queue.push(rel + META_SUFFIX);
    if (!rel.endsWith('.json')) continue;
    const text = read(rel);
    if (text === null) continue;
    for (const m of text.matchAll(GUID_RE)) {
      const target = index.get(m[0].toLowerCase());
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** A scene URL the page loaded (`/assets/scenes/main.scene.json`, or under `/games/<id>/assets/`
 *  on a multi-project server) → its path in the fingerprint. Matched by suffix, so it holds for
 *  either URL layout; null for a scene outside the project's assets (the engine's own). */
export function sceneUrlToAsset(url: string, rels: Iterable<string>): string | null {
  const raw = url.split(/[?#]/)[0];
  let clean = raw;
  try { clean = decodeURIComponent(raw); } catch { /* a bare `%`: match it as written */ }
  let best: string | null = null;
  for (const rel of rels) {
    if (clean === rel || clean.endsWith(`/${rel}`)) {
      if (!best || rel.length > best.length) best = rel;
    }
  }
  return best;
}

/** The scenes a render loaded, from its boot scene and the journal: a first load emits
 *  `@scene-loaded {path}`, and every later one `@scene-swapped {from, to}` (`SceneManager`). The
 *  boot scene is passed separately because it is read BEFORE the frame loop — the page's current
 *  scene after the last frame is wherever the take ended, which a level change makes a different
 *  scene (#1509 review: a sling take that won level 1 was checked against level 2 only). */
export function takeSceneUrls(bootScene: string | null, events: readonly { type: string; payload?: unknown }[]): string[] {
  const urls = new Set<string>();
  if (bootScene) urls.add(bootScene);
  for (const e of events) {
    const p = (e.payload ?? {}) as { path?: unknown; to?: unknown };
    if (e.type === '@scene-loaded' && typeof p.path === 'string' && p.path) urls.add(p.path);
    if (e.type === '@scene-swapped' && typeof p.to === 'string' && p.to) urls.add(p.to);
  }
  return [...urls];
}

export type TakeAssetsCheck =
  /** The take predates fingerprints, or the record-time fingerprint failed. */
  | { status: 'unchecked'; reason: string }
  | { status: 'unchanged'; checked: number }
  /** `changed`: in both, different bytes. `added`: used by this render, absent when the take was
   *  recorded — a file created since, which a scene edit now references. */
  | { status: 'changed'; checked: number; changed: string[]; added: string[] };

/** Compare the take's fingerprint with the project as the render found it, over the closure of
 *  the scenes the render loaded. */
export function compareTakeAssets(recorded: TakeAssets | undefined, now: TakeAssets, closure: ReadonlySet<string>): TakeAssetsCheck {
  if (!recorded) return { status: 'unchecked', reason: 'this take was recorded before takes stored an asset fingerprint' };
  const changed: string[] = [];
  const added: string[] = [];
  const comparable = [...closure].sort().filter((rel) =>
    // Referenced but missing now: a broken ref, not a change to report here. Unreadable on either
    // side: unknown, so neither `changed` nor `added`.
    now.files[rel] !== undefined && now.files[rel] !== UNREADABLE && recorded.files[rel] !== UNREADABLE);
  for (const rel of comparable) {
    const after = now.files[rel];
    const before = recorded.files[rel];
    if (before === undefined) added.push(rel);
    else if (before !== after) changed.push(rel);
  }
  const checked = comparable.length;
  return changed.length || added.length ? { status: 'changed', checked, changed, added } : { status: 'unchanged', checked };
}

/** The render's whole check: fingerprint the project now, find what the loaded scenes use, and
 *  compare. `sceneUrls` comes from `takeSceneUrls`.
 *
 *  ⚠️ **It never throws.** It runs after every frame is captured and before the encode, so an
 *  exception here would fail a finished render — for a check whose whole contract is "report,
 *  never refuse". Anything that goes wrong reads `unchecked`, with the reason. */
export async function checkTakeAssets(projectRoot: string, recorded: TakeAssets | undefined, sceneUrls: readonly string[]): Promise<TakeAssetsCheck> {
  if (!recorded) return compareTakeAssets(undefined, { dir: TAKE_ASSETS_DIR, files: {} }, new Set());
  try {
    return await checkAgainst(projectRoot, recorded, sceneUrls);
  } catch (e) {
    return { status: 'unchecked', reason: `the check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function checkAgainst(projectRoot: string, recorded: TakeAssets, sceneUrls: readonly string[]): Promise<TakeAssetsCheck> {
  const now = await fingerprintAssets(projectRoot);
  const dir = path.join(projectRoot, TAKE_ASSETS_DIR);
  const cache = new Map<string, string | null>();
  const read = (rel: string): string | null => {
    if (!cache.has(rel)) {
      let text: string | null = null;
      try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { /* gone */ }
      cache.set(rel, text);
    }
    return cache.get(rel)!;
  };
  const rels = Object.keys(now.files);
  const roots = sceneUrls.map((u) => sceneUrlToAsset(u, rels)).filter((r): r is string => r !== null);
  if (!roots.length) return { status: 'unchecked', reason: `none of the loaded scenes (${sceneUrls.join(', ')}) is under ${TAKE_ASSETS_DIR}` };
  const closure = assetClosure(roots, guidIndex(rels, read), read, (rel) => now.files[rel] !== undefined);
  return compareTakeAssets(recorded, now, closure);
}
