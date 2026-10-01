/** #1970 (B3 round 2, #1656 § Review–fix rounds item 7) — the router's seeded random-sequence test: create, write,
 *  folder, move, duplicate, delete and rewrite over a scratch asset tree, through `handleBackendRequest` itself, mixed
 *  with two things done OUTSIDE the editor: a Finder/git delete (the file goes, its sidecar stays) and a Sprite Editor
 *  save of slices into a png's sidecar.
 *
 *  REAL, not stood in for: the router, `resolveAssetPath`/`absToAssetUrl` over a flat project's `runtime/assets` root,
 *  and the manifest (`buildManifest(scanAllAssets(...), heal)`, the scan the Electron host runs), which mints missing
 *  GUIDs and heals collisions exactly as the editor's does. Stubbed: the OS trash (a rename into a scratch folder
 *  OUTSIDE the project) and the renderer (it holds nothing and answers every probe).
 *
 *  After every op, a small model of the tree predicts the reply's class and the checks below hold:
 *  - I1 the files and folders on disk are exactly the model's, spelled as the model spells them;
 *  - I2 every asset has a GUID and no two manifest entries share one, slices included (#1974), and no rebuild had to
 *    heal a collision;
 *  - I3 a GUID never changes: it follows a move, a rewrite keeps it, a copy gets a new one; and no GUID of a deleted
 *    asset or slice is ever defined again (#1956, #1975);
 *  - I4 no `.meta.json` outlives its file except where an outside delete left it, and that orphan stays until a create
 *    or a delete at its path removes it; every binary has a sidecar;
 *  - I5 nothing outside the asset root changed, except the trash on a delete;
 *  - I6 a refused op changed nothing;
 *  - I7 the reply's class (2xx / which 4xx) is the one the model predicts (an op into a folder that does not exist is
 *    not predicted, only checked by the others);
 *  - I8 every file a successful op added, changed or removed was marked as the editor's own write (`markEditorWrite`),
 *    sidecars excepted (#1702: an unmarked change reads as an outside edit and drops parked work).
 *
 *  Modes: `npm run verify` runs VERIFY_SEEDS. `MODOKI_ROUTER_FUZZ=<n>` (optional `MODOKI_ROUTER_FUZZ_SEED=<first>`,
 *  `MODOKI_ROUTER_FUZZ_LEN=<ops>`) hunts n seeds, and `MODOKI_ROUTER_FUZZ_REPLAY='<json op list>'` runs one list. A
 *  failure is shrunk by dropping ops and printed with a paste-ready replay.
 *
 *  HARNESS-BLIND (a clean run is not evidence about these):
 *  - One request at a time, each awaited: two overlapping requests on one path are never generated.
 *  - The renderer holds nothing, so every unsaved-work gate answers "clear"; the refusal branches are not reached.
 *  - No watcher: the rebuild after each op stands in for it, so a debounce or a mark's TTL is not modelled.
 *  - The trash never refuses, and nothing fails part way (#1958's partial failures are not reached).
 *  - One root (no engine root, no second project), and only three kinds: material, particle, png. A move never
 *    changes the suffix (#1960 is open), and nothing references anything, so a copy's re-minted refs are not checked.
 *  - The outside delete removes a png only (a JSON asset carries its id inline, so its orphan cannot hand one on), and
 *    only `.meta.json` is left behind, not the local or quarantined halves (sidecarIdentity.test.ts covers those).
 *
 *  REACH, measured by putting the fixes back out: #1974's slice re-mint removed → I2 inside the verify seeds; #1975's
 *  orphan removal removed from write-file → I3 inside the verify seeds (from duplicate or move it stays green: the copy's
 *  own sidecar overwrites a `.meta.json` orphan, and sidecarIdentity.test.ts holds those two); #1956's sidecar-with-its-file removed → I4; create-asset's
 *  self-write mark removed → I8; move-file's never-clobber checks removed → I7.
 *  - Case: a case-only rename is generated, and the model folds case when the scratch filesystem does, so a run means
 *    something different on a case-sensitive CI disk than on APFS/NTFS. Unicode normalisation is not generated. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const trash = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  // The OS trash, as a rename into a folder outside the project: what went is still inspectable, and I5 sees it.
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      fs.renameSync(p, path.join(trash.dir, `${fs.readdirSync(trash.dir).length}-${path.basename(p)}`));
    }
    return { failed: [] as string[] };
  },
}));

import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { resolveAssetPath, absToAssetUrl, buildManifest, scanAllAssets, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

// ── Ops ────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Kind = 'material' | 'particle' | 'png';
const EXT: Record<Kind, string> = { material: '.mat.json', particle: '.particle.json', png: '.png' };
export type Op =
  | { op: 'create'; path: string; kind: Exclude<Kind, 'png'> }
  | { op: 'writePng'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'move'; from: string; to: string }
  | { op: 'dup'; from: string; to: string }
  | { op: 'del'; path: string }
  | { op: 'rewrite'; path: string; kind: Exclude<Kind, 'png'>; keepId: boolean }
  // Outside the editor, not through the router: a Finder/git delete (the file goes, its sidecar stays) and a Sprite
  // Editor save of slices into a png's sidecar. They make the orphans and the sub-asset GUIDs #1975 and #1974 are about.
  | { op: 'rmOutside'; path: string }
  | { op: 'slice'; path: string; guids: string[] };

const FOLDERS = ['', 'f1/', 'f2/', 'f1/g/'];
const NAMES = ['a', 'b', 'c'];
const KINDS: Kind[] = ['material', 'particle', 'png'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paths come from small pools, so ops collide with each other often enough to reach the refusals. The list is fixed
 *  up front (not drawn against the model), so dropping an op while shrinking leaves the others unchanged. */
export function generate(seed: number, length: number): Op[] {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const file = (kind: Kind = pick(KINDS)) => `/assets/${pick(FOLDERS)}${pick(NAMES)}${EXT[kind]}`;
  const folder = () => `/assets/${pick(FOLDERS.filter(Boolean))}`.replace(/\/$/, '');
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const guid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    const u = r();
    if (u < 0.2) { const kind = pick(['material', 'particle'] as const); ops.push({ op: 'create', path: file(kind), kind }); }
    else if (u < 0.3) ops.push({ op: 'writePng', path: file('png') });
    else if (u < 0.38) ops.push({ op: 'mkdir', path: folder() });
    else if (u < 0.6) {
      // A file to a same-suffix path, a folder to another folder (possibly inside itself), or a case-only rename.
      const v = r();
      if (v < 0.6) { const kind = pick(KINDS); ops.push({ op: 'move', from: file(kind), to: file(kind) }); }
      else if (v < 0.85) ops.push({ op: 'move', from: folder(), to: `${folder()}/${pick(['h', 'g'])}` });
      else { const from = r() < 0.5 ? file() : folder(); const base = from.slice(from.lastIndexOf('/') + 1); ops.push({ op: 'move', from, to: from.slice(0, from.lastIndexOf('/') + 1) + base[0].toUpperCase() + base.slice(1) }); }
    } else if (u < 0.72) { const kind = pick(KINDS); ops.push({ op: 'dup', from: file(kind), to: file(kind) }); }
    else if (u < 0.8) ops.push({ op: 'del', path: r() < 0.75 ? file() : folder() });
    else if (u < 0.86) { const kind = pick(['material', 'particle'] as const); ops.push({ op: 'rewrite', path: file(kind), kind, keepId: r() < 0.5 }); }
    else if (u < 0.92) ops.push({ op: 'rmOutside', path: file('png') });
    else ops.push({ op: 'slice', path: file('png'), guids: Array.from({ length: 1 + Math.floor(r() * 2) }, guid) });
  }
  return ops;
}

// ── One run ────────────────────────────────────────────────────────────────────────────────────────────────────────
class Violation extends Error {
  readonly check: string;
  readonly step: number;
  constructor(check: string, step: number, detail: string) {
    super(`${check} at op ${step}: ${detail}`);
    this.check = check;
    this.step = step;
  }
}

/** Every file under `dir`, relative, `/`-separated, sorted. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();
}
function dirs(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((rel) => fs.statSync(path.join(dir, rel)).isDirectory())
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();
}
function snapshot(dir: string): Map<string, string> {
  return new Map(walk(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, rel)).toString('base64')]));
}

interface ModelFile { url: string; kind: Kind; guid: string | null; slices?: string[] }

export async function runOps(ops: readonly Op[]): Promise<{ statuses: number[]; outsideHits: number }> {
  const scratch = makeScratchDir('modoki-router-fuzz-');
  const project = path.join(scratch, 'project');
  const assets = path.join(project, 'runtime', 'assets');
  trash.dir = path.join(scratch, 'trash');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(trash.dir);
  fs.writeFileSync(path.join(project, 'project.config.json'), '{}\n');
  // Does this disk fold case? The model must, if it does (APFS, NTFS), and must not on a case-sensitive CI disk.
  fs.writeFileSync(path.join(scratch, 'CaseProbe'), '');
  const foldsCase = fs.existsSync(path.join(scratch, 'caseprobe'));
  const key = (url: string) => (foldsCase ? url.toLowerCase() : url);

  const roots: AssetRoot[] = [{ urlPrefix: '/assets', absDir: assets }];
  const marked = new Set<string>();
  const warnings: string[] = [];
  let manifest: Manifest = { version: 2, assets: [], folders: [] };
  const rebuild = (): Manifest => { manifest = buildManifest(scanAllAssets(roots), true) as Manifest; return manifest; };
  const ctx = {
    projectRoot: project,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (abs: string, opts?: { onDisk?: boolean }) => absToAssetUrl(abs, roots, opts),
    firstRootDir: () => assets,
    getManifest: () => manifest,
    rebuildManifest: rebuild,
    requestBrowser: async (op: string, params: unknown) => {
      if (op === 'resolve-unsaved') {
        return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] };
      }
      return { ok: true };
    },
    getSchema: () => undefined,
    markEditorWrite: (abs: string) => { marked.add(path.relative(assets, abs).split(path.sep).join('/')); },
    ssrLoadModule: async () => { throw new Error('router fuzz: no SSR'); },
    invalidateProjectConfig: () => {},
    computeUnused: () => { throw new Error('router fuzz: no tree-shaker'); },
    computeRefEdges: () => { throw new Error('router fuzz: no tree-shaker'); },
  } as unknown as BackendContext;
  const post = async (urlPath: string, body: unknown) => {
    const r = await handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });
    if (!r || r.kind !== 'json') throw new Error(`router fuzz: ${urlPath} gave no json reply`);
    return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
  };

  // The model: files and folders by `key`, each spelled as the disk should spell it.
  const files = new Map<string, ModelFile>();
  const folders = new Map<string, string>();
  /** Sidecars a `rmOutside` left behind, by key → the url they sit at (a path with no file). */
  const orphans = new Map<string, string>();
  /** Every GUID (asset or slice) whose asset is gone: none may come back on another file (#1956, #1975). */
  const dead = new Set<string>();
  const bury = (f: ModelFile) => { if (f.guid) dead.add(f.guid); for (const g of f.slices ?? []) dead.add(g); };
  const parentOf = (url: string) => url.slice(0, url.lastIndexOf('/'));
  const parentExists = (url: string) => parentOf(url) === '/assets' || folders.has(key(parentOf(url)));
  const under = (k: string, folderKey: string) => k.startsWith(`${folderKey}/`);
  const addParents = (url: string) => {
    for (let p = parentOf(url); p !== '/assets'; p = parentOf(p)) if (!folders.has(key(p))) folders.set(key(p), p);
  };
  const urlOf = (rel: string) => `/assets/${rel}`;
  /** `url` spelled as the disk will spell it: a folder that already exists keeps its own spelling (a case-folding disk
   *  puts `/assets/f1/x` inside an existing `F1`); only the new segments take the request's. */
  const spell = (url: string): string => {
    const parent = parentOf(url);
    if (parent === '/assets') return url;
    const p: string = folders.get(key(parent)) ?? spell(parent);
    return `${p}${url.slice(parent.length)}`;
  };
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); });
  const statuses: number[] = [];
  /** Outside ops that found a file to act on (one that misses does nothing, and proves nothing). */
  let outsideHits = 0;
  try {
    for (const [i, op] of ops.entries()) {
      const before = snapshot(scratch);
      marked.clear();
      warnings.length = 0;
      // What the model expects: a status class, or null when it does not predict (a parent folder that does not exist).
      let expect: number | null = 200;
      let apply = () => {};
      let reply: { status: number; body: Record<string, unknown> };
      switch (op.op) {
        case 'create':
        case 'writePng': {
          const k = key(op.path);
          const existing = files.get(k);
          if (op.op === 'create' && (existing || folders.has(k))) expect = 409;
          else if (op.op === 'writePng' && folders.has(k)) expect = null; // writing onto a folder: not predicted
          else if (!parentExists(op.path)) expect = null;
          reply = op.op === 'create'
            ? await post('/api/create-asset', { type: op.kind, path: op.path })
            : await post('/api/write-file', { path: op.path, content: PNG, encoding: 'base64' });
          const id = typeof reply.body.id === 'string' ? reply.body.id : null;
          apply = () => {
            // An overwrite keeps the file's sidecar, so its GUID; a new png gets one from the rebuild (adopted below).
            files.set(k, existing ?? { url: spell(op.path), kind: op.op === 'create' ? op.kind : 'png', guid: id });
            orphans.delete(k); // a create removes an orphan at its path (#1975)
            addParents(spell(op.path));
          };
          break;
        }
        case 'mkdir': {
          const k = key(op.path);
          if (folders.has(k) || files.has(k)) expect = 409;
          reply = await post('/api/create-folder', { path: op.path });
          apply = () => { const u = spell(op.path); addParents(u); folders.set(k, u); };
          break;
        }
        case 'move': {
          const fk = key(op.from); const tk = key(op.to);
          const isFolder = folders.has(fk);
          const caseOnly = fk === tk && op.from !== op.to;
          if (!files.has(fk) && !isFolder) expect = 404;
          else if (op.from === op.to) expect = null; // onto itself: not predicted
          else if (!caseOnly && (files.has(tk) || folders.has(tk))) expect = 409;
          else if (isFolder && under(tk, fk)) expect = 400;
          else if (!parentExists(op.to)) expect = null;
          reply = await post('/api/move-file', { from: op.from, to: op.to });
          apply = () => {
            // Onto its own spelling: the route renames nothing, whatever the disk spells it (a stale spelling after a
            // case-only rename replies ok and keeps the disk's; the round-2 close lists it as not filed).
            if (op.from === op.to) return;
            // The moved segment takes the request's spelling (a case-only rename included); its parents keep the disk's.
            const to = spell(op.to);
            const fromSpelled = (isFolder ? folders.get(fk) : files.get(fk)?.url) ?? op.from;
            const rename = (url: string) => to + url.slice(fromSpelled.length);
            if (!isFolder) {
              const f = files.get(fk)!; files.delete(fk); files.set(tk, { ...f, url: to });
              orphans.delete(tk); // #1975: the moved file never adopts the orphan at its destination
            } else {
              for (const [k, f] of [...files]) if (under(k, fk)) { files.delete(k); const u = rename(f.url); files.set(key(u), { ...f, url: u }); }
              for (const [k, u] of [...folders]) if (k === fk || under(k, fk)) { folders.delete(k); const n = rename(u); folders.set(key(n), n); }
              for (const [k, u] of [...orphans]) if (under(k, fk)) { orphans.delete(k); const n = rename(u); orphans.set(key(n), n); }
            }
            addParents(to);
          };
          break;
        }
        case 'dup': {
          const fk = key(op.from); const tk = key(op.to);
          if (!files.has(fk)) expect = folders.has(fk) ? null : 404;
          else if (files.has(tk) || folders.has(tk)) expect = 409;
          else if (!parentExists(op.to)) expect = null;
          reply = await post('/api/duplicate-asset', { from: op.from, to: op.to });
          const guid = typeof reply.body.guid === 'string' ? reply.body.guid : null;
          apply = () => { const u = spell(op.to); files.set(tk, { url: u, kind: files.get(fk)!.kind, guid }); orphans.delete(tk); addParents(u); };
          break;
        }
        case 'del': {
          const k = key(op.path);
          // A gone file's orphaned sidecar is still taken (#1956), so that delete succeeds.
          if (!files.has(k) && !folders.has(k) && !orphans.has(k)) expect = 404;
          reply = await post('/api/delete-asset', { path: op.path });
          apply = () => {
            const f = files.get(k); if (f) bury(f);
            files.delete(k); folders.delete(k); orphans.delete(k);
            for (const [fk, g] of [...files]) if (under(fk, k)) { bury(g); files.delete(fk); }
            for (const dk of [...folders.keys()]) if (under(dk, k)) folders.delete(dk);
            for (const ok of [...orphans.keys()]) if (under(ok, k)) orphans.delete(ok);
          };
          break;
        }
        case 'rewrite': {
          const k = key(op.path);
          const f = files.get(k);
          if (!f) expect = folders.has(k) ? null : 404;
          let data: Record<string, unknown> = {};
          if (f) {
            data = JSON.parse(fs.readFileSync(path.join(assets, f.url.slice('/assets/'.length)), 'utf8')) as Record<string, unknown>;
            if (!op.keepId) delete data.id;
          }
          reply = await post('/api/asset-write', { path: op.path, type: op.kind, data });
          break;
        }
        case 'rmOutside':
        case 'slice': {
          const f = files.get(key(op.path));
          if (f) {
            outsideHits++;
            const absFile = path.join(assets, f.url.slice('/assets/'.length));
            if (op.op === 'rmOutside') {
              fs.rmSync(absFile);
              files.delete(key(op.path)); bury(f);
              if (fs.existsSync(`${absFile}.meta.json`)) orphans.set(key(op.path), f.url);
            } else {
              const meta = JSON.parse(fs.readFileSync(`${absFile}.meta.json`, 'utf8')) as Record<string, unknown>;
              meta.sprites = op.guids.map((g, n) => ({ guid: g, name: `s${n}`, rect: { x: 0, y: 0, w: 1, h: 1 }, pivot: { x: 0.5, y: 0.5 } }));
              fs.writeFileSync(`${absFile}.meta.json`, JSON.stringify(meta));
              // A seed can draw a slice GUID twice; give that file the later list and keep the check about copies.
              f.slices = [...op.guids];
            }
          }
          reply = { status: 200, body: { outside: true } };
          expect = null;
          break;
        }
      }
      const outsideOp = op.op === 'rmOutside' || op.op === 'slice';
      // Route replies only: an outside op's 200 is synthetic, and would pad the coverage floor below.
      if (!outsideOp) statuses.push(reply.status);
      const ok = reply.status >= 200 && reply.status < 300;
      const changed = diff(before, snapshot(scratch));

      // I7: the reply's class.
      if (expect !== null && (ok ? 200 : reply.status) !== expect && !(expect === 404 && reply.status === 409)) {
        throw new Violation('I7', i, `${JSON.stringify(op)} → ${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}, model expected ${expect}`);
      }
      // I6: a refusal changed nothing.
      if (!ok && changed.length) throw new Violation('I6', i, `${JSON.stringify(op)} → ${reply.status} but changed ${changed.join(', ')}`);
      if (ok && outsideOp) apply();
      else if (ok) {
        // I8: every file the op touched, sidecars excepted, was marked as the editor's own.
        const inRoot = changed.filter((rel) => rel.startsWith('project/runtime/assets/')).map((rel) => rel.slice('project/runtime/assets/'.length));
        // Compared as the host's guard keys them (`editorWriteGuard.ts`): case folded on a disk that folds it.
        const marks = [...marked].map(key);
        const unmarked = inRoot.filter((rel) => !rel.endsWith('.meta.json') && !marks.some((m) => key(rel) === m || key(rel).startsWith(`${m}/`)));
        if (unmarked.length) throw new Violation('I8', i, `${JSON.stringify(op)} changed ${unmarked.join(', ')} without marking it`);
        // I5: outside the root, only the trash may change, and only on a delete.
        const outside = changed.filter((rel) => !rel.startsWith('project/runtime/assets/') && !(op.op === 'del' && rel.startsWith('trash/')));
        if (outside.length) throw new Violation('I5', i, `${JSON.stringify(op)} changed ${outside.join(', ')} outside the asset root`);
        apply();
      }

      // The watcher's rebuild, then the tree checks.
      rebuild();
      const healed = warnings.filter((w) => w.includes('collision'));
      if (healed.length) throw new Violation('I2', i, `${JSON.stringify(op)}: a rebuild healed a GUID collision: ${healed.join(' | ')}`);
      const disk = walk(assets);
      const diskAssets = disk.filter((rel) => !rel.endsWith('.meta.json')).map(urlOf);
      const want = [...files.values()].map((f) => f.url).sort();
      if (JSON.stringify(diskAssets) !== JSON.stringify(want)) {
        throw new Violation('I1', i, `${JSON.stringify(op)}: disk has ${JSON.stringify(diskAssets)}, model ${JSON.stringify(want)}`);
      }
      const diskFolders = dirs(assets).map(urlOf);
      const wantFolders = [...folders.values()].sort();
      if (JSON.stringify(diskFolders) !== JSON.stringify(wantFolders)) {
        throw new Violation('I1', i, `${JSON.stringify(op)}: disk folders ${JSON.stringify(diskFolders)}, model ${JSON.stringify(wantFolders)}`);
      }
      for (const rel of disk.filter((r) => r.endsWith('.meta.json'))) {
        const owner = rel.slice(0, -'.meta.json'.length);
        if (!disk.includes(owner) && !orphans.has(key(urlOf(owner)))) throw new Violation('I4', i, `${JSON.stringify(op)}: orphaned sidecar ${rel}`);
      }
      for (const [k, u] of orphans) {
        if (!disk.some((rel) => key(urlOf(rel)) === `${k}.meta.json`)) throw new Violation('I4', i, `${JSON.stringify(op)}: the orphan at ${u} vanished without a create or delete there`);
      }
      // I2 across the WHOLE manifest, slices included: a sub-asset has no file of its own, so the scan's heal cannot
      // separate two that share a GUID (#1974). I3: no dead GUID is defined again (#1956, #1975).
      const byGuid = new Map<string, string>();
      for (const a of manifest.assets) {
        if (!a.guid) continue;
        if (dead.has(a.guid)) throw new Violation('I3', i, `${JSON.stringify(op)}: ${a.path} carries ${a.guid}, the GUID of a deleted asset`);
        const other = byGuid.get(a.guid);
        if (other !== undefined && other !== a.path) throw new Violation('I2', i, `${JSON.stringify(op)}: ${a.path} and ${other} share GUID ${a.guid}`);
        byGuid.set(a.guid, a.path);
      }
      const guidOf = new Map(manifest.assets.map((a) => [key(a.path), a.guid]));
      const seen = new Map<string, string>();
      for (const f of files.values()) {
        const g = guidOf.get(key(f.url));
        if (!g) throw new Violation('I2', i, `${JSON.stringify(op)}: ${f.url} has no GUID in the manifest`);
        if (seen.has(g)) throw new Violation('I2', i, `${JSON.stringify(op)}: ${f.url} and ${seen.get(g)} share GUID ${g}`);
        seen.set(g, f.url);
        if (f.kind === 'png' && !disk.includes(`${f.url.slice('/assets/'.length)}.meta.json`)) throw new Violation('I4', i, `${f.url} has no sidecar`);
        if (f.guid === null) f.guid = g; // a new binary's GUID comes from the rebuild: adopted the first time it is seen
        else if (f.guid !== g) throw new Violation('I3', i, `${JSON.stringify(op)}: ${f.url}'s GUID changed from ${f.guid} to ${g}`);
      }
    }
    return { statuses, outsideHits };
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push(k);
  for (const k of a.keys()) if (!b.has(k)) out.push(k);
  return out.sort();
}

/** Drop ops one at a time, last first, keeping any drop after which the run still fails the same check. */
async function shrink(ops: Op[], check: string): Promise<Op[]> {
  let cur = ops;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const cand = cur.filter((_, j) => j !== i);
      try { await runOps(cand); } catch (e) {
        if (e instanceof Violation && e.check === check) { cur = cand; changed = true; }
      }
    }
  }
  return cur;
}

async function runSeed(seed: number, length: number): Promise<string | null> {
  const ops = generate(seed, length);
  try { await runOps(ops); return null; } catch (e) {
    if (!(e instanceof Violation)) throw e;
    const small = await shrink(ops.slice(0, e.step + 1), e.check);
    let last = e.message;
    try { await runOps(small); } catch (e2) { last = (e2 as Error).message; }
    return `seed ${seed}: ${last}\n  replay (${small.length} ops): MODOKI_ROUTER_FUZZ_REPLAY='${JSON.stringify(small)}'`;
  }
}

// ── The suite ──────────────────────────────────────────────────────────────────────────────────────────────────────
const VERIFY_SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const VERIFY_LEN = 40;
const HUNT = Number(process.env.MODOKI_ROUTER_FUZZ ?? 0);
const REPLAY = process.env.MODOKI_ROUTER_FUZZ_REPLAY;

afterEach(() => { vi.restoreAllMocks(); });

describe('router seeded sequence (#1970)', () => {
  if (REPLAY) {
    it('replays MODOKI_ROUTER_FUZZ_REPLAY', async () => { await runOps(JSON.parse(REPLAY) as Op[]); });
    return;
  }
  if (HUNT > 0) {
    it(`hunts ${HUNT} seeds`, async () => {
      const first = Number(process.env.MODOKI_ROUTER_FUZZ_SEED ?? 1000);
      const len = Number(process.env.MODOKI_ROUTER_FUZZ_LEN ?? 80);
      const failures: string[] = [];
      for (let s = first; s < first + HUNT; s++) { const f = await runSeed(s, len); if (f) failures.push(f); }
      expect(failures, failures.join('\n\n')).toEqual([]);
    }, 3_600_000);
    return;
  }
  for (const seed of VERIFY_SEEDS) {
    it(`seed ${seed}`, async () => { expect(await runSeed(seed, VERIFY_LEN)).toBeNull(); });
  }

  it('reaches every route and both outcomes (a generator that stops colliding would pass vacuously)', async () => {
    const statuses: number[] = [];
    let outsideHits = 0;
    for (const seed of VERIFY_SEEDS) {
      const run = await runOps(generate(seed, VERIFY_LEN));
      statuses.push(...run.statuses);
      outsideHits += run.outsideHits;
    }
    // The outside delete and the slice save must actually act, or the I2/I3/I4 reach they buy is vacuous. (5 with
    // these seeds; the floor leaves room for a generator tweak, not for zero.)
    expect(outsideHits).toBeGreaterThan(2);
    const ok = statuses.filter((s) => s < 300).length;
    expect(ok).toBeGreaterThan(statuses.length * 0.25);
    expect(statuses.filter((s) => s === 409).length).toBeGreaterThan(10);
    expect(statuses.filter((s) => s === 404).length).toBeGreaterThan(10);
  });
});
