/** engine/scripts/ota/pruneBundle.mjs — OTA CDN retention (#836). The planner is pure; the prune's
 *  read-failure, concurrency and ordering decisions run against an injected in-memory `gcloud`. The
 *  end-to-end path through ota-publish.mjs / ota-prune.mjs and a fake `gcloud` binary is in
 *  otaPublishReleaseRace.test.ts. */
import { describe, it, expect } from 'vitest';
import { PRUNE_GRACE_MS, parseManifestListing, parseVersionPrefixes, planPrune, pruneBundleVersions } from '../../../scripts/ota/pruneBundle.mjs';
import { OTA_DEFAULT_RETAIN_VERSIONS, otaRetainVersions } from '../../../scripts/ota/publishGuards.mjs';
import { DEFAULT_PROJECT_CONFIG } from '../../../project-config';
import { repoFiles } from '../../../scripts/repoCorpus.mjs';

const P = 'gs://b/pre/bundles/shell';
/** Far after every fixture timestamp, so nothing falls inside the grace window unless a test says so. */
const LATER = 10 * 365 * 24 * 3600 * 1000;

describe('planPrune', () => {
  const created = (entries: Record<string, number | null>) => new Map(Object.entries(entries));

  it('keeps the newest N by manifest creation time — not by version name', () => {
    const plan = planPrune({ versions: ['v9', 'v10', 'v2'], created: created({ v9: 3, v10: 1, v2: 2 }), pointer: 'v9', keep: 2, now: LATER });
    expect(plan.keep).toEqual(['v2', 'v9']);
    expect(plan.remove).toEqual(['v10']);
  });

  it('always keeps the version release.json points at, even when it is the oldest', () => {
    const plan = planPrune({ versions: ['a', 'b', 'c'], created: created({ a: 1, b: 2, c: 3 }), pointer: 'a', keep: 1, now: LATER });
    expect(plan.keep).toEqual(['a', 'c']);
    expect(plan.remove).toEqual(['b']);
  });

  it('never deletes a folder with no manifest, nor one whose age is unreadable', () => {
    const plan = planPrune({ versions: ['old', 'uploading', 'undated', 'new'], created: created({ old: 1, undated: null, new: 2 }), pointer: 'new', keep: 1, now: LATER });
    expect(plan.remove).toEqual(['old']);
    expect(plan.incomplete).toEqual(['uploading']);
    expect(plan.unknownAge).toEqual(['undated']);
    expect(plan.keep).toEqual(['new', 'undated', 'uploading']);
  });

  it('never deletes a version whose manifest is inside the grace window, however many are kept (#836 close-out)', () => {
    // A publish uploads its manifest BEFORE its release write lands; the prune must not delete what that
    // write is about to point at. Here `fresh` is outside the newest 1 and not the pointer — yet kept.
    const now = 5 * 3600 * 1000;
    const plan = planPrune({ versions: ['old', 'fresh', 'newest'], created: created({ old: 1, fresh: now - 60_000, newest: now - 1_000 }), pointer: 'newest', keep: 1, now, graceMs: 3600_000 });
    expect(plan.remove).toEqual(['old']);
    expect(plan.recent).toEqual(['fresh', 'newest']);
    // One millisecond past the window, it is ordinary history again.
    const later = planPrune({ versions: ['old', 'fresh', 'newest'], created: created({ old: 1, fresh: now - 3600_001, newest: now - 1_000 }), pointer: 'newest', keep: 1, now, graceMs: 3600_000 });
    expect(later.remove).toEqual(['old', 'fresh']);
  });

  it('PRUNE_GRACE_MS is the default window', () => {
    const now = 10 * PRUNE_GRACE_MS;
    const plan = planPrune({ versions: ['a', 'b'], created: created({ a: now - PRUNE_GRACE_MS + 1, b: now }), pointer: 'b', keep: 1, now });
    expect(plan.remove).toEqual([]);
  });

  it('lists deletions oldest first', () => {
    const plan = planPrune({ versions: ['a', 'b', 'c', 'd'], created: created({ a: 4, b: 1, c: 3, d: 2 }), pointer: 'a', keep: 1, now: LATER });
    expect(plan.remove).toEqual(['b', 'd', 'c']);
  });

  it('deletes nothing when there are no more versions than N', () => {
    expect(planPrune({ versions: ['a', 'b'], created: created({ a: 1, b: 2 }), pointer: 'b', keep: 5, now: LATER }).remove).toEqual([]);
  });

  it('refuses a non-positive keep rather than deleting everything', () => {
    for (const keep of [0, -1, 1.5, Number.NaN]) {
      expect(() => planPrune({ versions: ['a'], created: created({ a: 1 }), pointer: undefined, keep, now: LATER })).toThrow(/positive integer/);
    }
  });
});

describe('listing parsers', () => {
  it('parseVersionPrefixes takes only direct child folders with a version-shaped name', () => {
    const stdout = [`${P}/v1/`, `${P}/v2/`, `${P}/stray.txt`, `${P}/*/`, `${P}/../`, 'gs://b/pre/bundles/sling/v1/', ''].join('\n');
    expect(parseVersionPrefixes(stdout, P)).toEqual(['v1', 'v2']);
  });

  it('parseManifestListing reads timeCreated per version, and an unreadable one as null', () => {
    const json = JSON.stringify([
      { url: `${P}/v1/manifest.json#1784867545749355`, metadata: { timeCreated: '2026-07-24T04:32:25.754000+00:00' } },
      { url: `${P}/v2/manifest.json#2`, metadata: { timeCreated: 'not a date' } },
      { url: `${P}/v3/other.json#3`, metadata: { timeCreated: '2026-07-24T04:32:25Z' } },
    ]);
    const map = parseManifestListing(json, P);
    expect(map.get('v1')).toBe(Date.parse('2026-07-24T04:32:25.754Z'));
    expect(map.get('v2')).toBeNull();
    expect(map.has('v3')).toBe(false);
  });
});

/** An in-memory bucket behind the `gcloud` seam: enough of ls/cat/describe/rm to drive the prune. */
function fakeBucket(opts: { versions: Record<string, number | null | 'no-manifest'>; pointer?: string; generations?: string[] }) {
  const calls: string[][] = [];
  const deleted: string[] = [];
  const generations = [...(opts.generations ?? [])];
  let lastGeneration = '7';
  const gcloud = (args: string[]) => {
    calls.push(args);
    const [, verb] = args;
    if (verb === 'objects') {
      lastGeneration = generations.length ? generations.shift()! : lastGeneration;
      return { ok: true, stdout: `${lastGeneration}\n`, stderr: '' };
    }
    if (verb === 'cat') return { ok: true, stdout: JSON.stringify({ bundles: opts.pointer ? { shell: opts.pointer } : {} }), stderr: '' };
    if (verb === 'ls' && args.includes('--json')) {
      const rows = Object.entries(opts.versions).filter(([, t]) => t !== 'no-manifest')
        .map(([v, t]) => ({ url: `${P}/${v}/manifest.json#1`, metadata: { timeCreated: t === null ? 'bad' : new Date(t as number).toISOString() } }));
      return { ok: true, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (verb === 'ls') return { ok: true, stdout: Object.keys(opts.versions).map((v) => `${P}/${v}/`).join('\n'), stderr: '' };
    if (verb === 'rm') { deleted.push(args[2]); return { ok: true, stdout: '', stderr: '' }; }
    return { ok: false, stdout: '', stderr: `unhandled ${args.join(' ')}` };
  };
  return { gcloud, calls, deleted };
}

describe('pruneBundleVersions', () => {
  const base = { bucket: 'gs://b/pre', name: 'shell', keep: 1 };

  it('deletes each version files first and its manifest last', () => {
    const { gcloud, deleted } = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2' });
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(['v1']);
    expect(deleted).toEqual([`${P}/v1/files/**`, `${P}/v1/bundle.zip`, `${P}/v1/**`]);
  });

  it('dryRun plans and deletes nothing', () => {
    const { gcloud, deleted } = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2' });
    const r = pruneBundleVersions({ ...base, gcloud, dryRun: true });
    expect(r.ok && r.plan.remove).toEqual(['v1']);
    expect(deleted).toEqual([]);
  });

  it('re-plans when release.json changes before a version is deleted, and deletes nothing on the stale plan', () => {
    // attempt 1 plans at generation 7, then the pre-delete check sees 8: nothing deleted, re-plan.
    const { gcloud, calls, deleted } = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2', generations: ['7', '8'] });
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok).toBe(true);
    const cats = calls.map((a, i) => (a[1] === 'cat' ? i : -1)).filter((i) => i >= 0);
    const firstRm = calls.findIndex((a) => a[1] === 'rm');
    expect(cats.filter((i) => i < firstRm)).toHaveLength(2); // planned twice before any delete
    expect(deleted).toEqual([`${P}/v1/files/**`, `${P}/v1/bundle.zip`, `${P}/v1/**`]);
  });

  it('a release that re-points at an OLD planned-for-deletion version between versions is honoured', () => {
    // keep 1: plan removes v1, v2 (oldest first). After v1 goes, an operator rollback points at v2.
    let pointer = 'v3';
    let generation = 1;
    const deleted: string[] = [];
    const versions = { v1: 1000, v2: 2000, v3: 3000 } as Record<string, number>;
    const gcloud = (args: string[]) => {
      if (args[1] === 'objects') return { ok: true, stdout: `${generation}\n`, stderr: '' };
      if (args[1] === 'cat') return { ok: true, stdout: JSON.stringify({ bundles: { shell: pointer } }), stderr: '' };
      if (args[1] === 'ls' && args.includes('--json')) {
        return { ok: true, stdout: JSON.stringify(Object.entries(versions).map(([v, t]) => ({ url: `${P}/${v}/manifest.json#1`, metadata: { timeCreated: new Date(t).toISOString() } }))), stderr: '' };
      }
      if (args[1] === 'ls') return { ok: true, stdout: Object.keys(versions).map((v) => `${P}/${v}/`).join('\n'), stderr: '' };
      if (args[1] === 'rm') {
        deleted.push(args[2]);
        if (args[2] === `${P}/v1/**`) { delete versions.v1; pointer = 'v2'; generation = 2; }
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: false, stdout: '', stderr: 'unhandled' };
    };
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok, r.error).toBe(true);
    // The re-plan keeps the newest (v3) AND the rolled-back live version (v2): only v1 went.
    expect(r.removed).toEqual(['v1']);
    expect(deleted.some((u) => u.includes('/v2/'))).toBe(false);
  });

  it('if the live version was deleted anyway, the prune FAILS loudly rather than reporting success', () => {
    // The release moves onto the version being deleted DURING its deletes — past every earlier check.
    let pointer = 'v2';
    const versions = { v1: 1000, v2: 2000 } as Record<string, number>;
    const gcloud = (args: string[]) => {
      if (args[1] === 'objects' && args[3].endsWith('/manifest.json')) return { ok: false, stdout: '', stderr: 'ERROR: not found: 404.' };
      if (args[1] === 'objects') return { ok: true, stdout: '5\n', stderr: '' };
      if (args[1] === 'cat') return { ok: true, stdout: JSON.stringify({ bundles: { shell: pointer } }), stderr: '' };
      if (args[1] === 'ls' && args.includes('--json')) {
        return { ok: true, stdout: JSON.stringify(Object.entries(versions).map(([v, t]) => ({ url: `${P}/${v}/manifest.json#1`, metadata: { timeCreated: new Date(t).toISOString() } }))), stderr: '' };
      }
      if (args[1] === 'ls') return { ok: true, stdout: Object.keys(versions).map((v) => `${P}/${v}/`).join('\n'), stderr: '' };
      if (args[1] === 'rm') { pointer = 'v1'; return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unhandled' };
    };
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/now points shell at v1, whose files this prune DELETED/);
  });

  it('a version whose manifest was just (re)uploaded is not deleted even when it is outside N and not live', () => {
    // keep 1: v3 is the newest (and live); v2 is OLDER than v3 — outside N, not live — but uploaded 5 s ago.
    const now = Date.parse('2026-09-13T12:00:00Z');
    const { gcloud, deleted } = fakeBucket({ versions: { v1: now - 86_400_000, v2: now - 5_000, v3: now - 1_000 }, pointer: 'v3' });
    const r = pruneBundleVersions({ ...base, gcloud, now });
    expect(r.ok && r.plan.recent).toEqual(['v2', 'v3']);
    expect(r.removed).toEqual(['v1']);
    expect(deleted.some((u) => u.includes('/v2/'))).toBe(false);
  });

  it('a live version deleted by name but re-created by a concurrent publish is not reported as lost', () => {
    let pointer = 'v2';
    const gcloud = (args: string[]) => {
      if (args[1] === 'objects' && args[3].endsWith('/manifest.json')) {
        // Only the RE-CREATED live version's manifest exists; probing any other path is the bug.
        return args[3] === `${P}/v1/manifest.json` ? { ok: true, stdout: '9\n', stderr: '' } : { ok: false, stdout: '', stderr: 'ERROR: not found: 404.' };
      }
      if (args[1] === 'objects') return { ok: true, stdout: '5\n', stderr: '' };
      if (args[1] === 'cat') return { ok: true, stdout: JSON.stringify({ bundles: { shell: pointer } }), stderr: '' };
      if (args[1] === 'ls' && args.includes('--json')) {
        return { ok: true, stdout: JSON.stringify([['v1', 1000], ['v2', 2000]].map(([v, t]) => ({ url: `${P}/${v}/manifest.json#1`, metadata: { timeCreated: new Date(t as number).toISOString() } }))), stderr: '' };
      }
      if (args[1] === 'ls') return { ok: true, stdout: `${P}/v1/\n${P}/v2/`, stderr: '' };
      if (args[1] === 'rm') { pointer = 'v1'; return { ok: true, stdout: '', stderr: '' }; }
      return { ok: false, stdout: '', stderr: 'unhandled' };
    };
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.removed).toEqual(['v1']); // the probe is reached only after a real delete
    expect(r.ok).toBe(true);
  });

  it('a prune that deleted nothing does not re-read release.json — a transient read failure there is not a failure', () => {
    let cats = 0;
    const inner = fakeBucket({ versions: { v1: 1000 }, pointer: 'v1' });
    const gcloud = (args: string[]) => (args[1] === 'cat' && ++cats > 1 ? { ok: false, stdout: '', stderr: 'ERROR: 503' } : inner.gcloud(args));
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok).toBe(true);
    expect(cats).toBe(1);
  });

  it('gives up without deleting when release.json never holds still', () => {
    const { gcloud, deleted } = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2', generations: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] });
    const r = pruneBundleVersions({ ...base, gcloud, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kept changing/);
    expect(deleted).toEqual([]);
  });

  it('every read failure deletes nothing — could not tell is never empty', () => {
    for (const failing of ['objects', 'cat', 'ls', 'ls --json']) {
      const inner = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2' });
      const gcloud = (args: string[]) => {
        const key = args.includes('--json') ? 'ls --json' : args[1];
        return key === failing ? { ok: false, stdout: '', stderr: 'ERROR: HTTPError 403: Forbidden.' } : inner.gcloud(args);
      };
      const r = pruneBundleVersions({ ...base, gcloud });
      expect(r.ok, failing).toBe(false);
      expect(inner.deleted, failing).toEqual([]);
    }
  });

  it('a release.json with no object "bundles" deletes nothing', () => {
    const inner = fakeBucket({ versions: { v1: 1000, v2: 2000 } });
    const gcloud = (args: string[]) => (args[1] === 'cat' ? { ok: true, stdout: '{"bundles":[]}', stderr: '' } : inner.gcloud(args));
    expect(pruneBundleVersions({ ...base, gcloud }).ok).toBe(false);
    expect(inner.deleted).toEqual([]);
  });

  it('an empty bundle prefix ("matched no objects") is nothing to prune, not a failure', () => {
    const gcloud = (args: string[]) => {
      if (args[1] === 'objects') return { ok: true, stdout: '3\n', stderr: '' };
      if (args[1] === 'cat') return { ok: true, stdout: '{"bundles":{}}', stderr: '' };
      return { ok: false, stdout: '', stderr: 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.' };
    };
    const r = pruneBundleVersions({ ...base, gcloud });
    expect(r.ok && r.removed).toEqual([]);
  });

  it('an object already gone mid-delete is fine; any other delete failure stops the prune', () => {
    const gone = fakeBucket({ versions: { v1: 1000, v2: 2000 }, pointer: 'v2' });
    const tolerant = (args: string[]) => (args[2]?.endsWith('bundle.zip') ? { ok: false, stdout: '', stderr: 'ERROR: (gcloud.storage.rm) One or more URLs matched no objects.' } : gone.gcloud(args));
    expect(pruneBundleVersions({ ...base, gcloud: tolerant }).removed).toEqual(['v1']);

    const denied = fakeBucket({ versions: { v1: 1000, v2: 2000, v3: 3000 }, pointer: 'v3' });
    const failing = (args: string[]) => (args[1] === 'rm' ? { ok: false, stdout: '', stderr: 'ERROR: HTTPError 403' } : denied.gcloud(args));
    const r = pruneBundleVersions({ ...base, gcloud: failing });
    expect(r.ok).toBe(false);
    expect(r.removed).toEqual([]);
    expect(r.error).toMatch(/failed deleting shell@v1/);
  });
});

describe('otaRetainVersions / OTA_DEFAULT_RETAIN_VERSIONS', () => {
  it('matches DEFAULT_PROJECT_CONFIG.ota.retainVersions', () => {
    expect(OTA_DEFAULT_RETAIN_VERSIONS).toBe(DEFAULT_PROJECT_CONFIG.ota.retainVersions);
  });

  it('absent → the default; a positive integer → itself; anything else → null (refuse)', () => {
    expect(otaRetainVersions({})).toBe(OTA_DEFAULT_RETAIN_VERSIONS);
    expect(otaRetainVersions({ retainVersions: 3 })).toBe(3);
    for (const bad of [0, -2, 2.5, '3', null, true]) expect(otaRetainVersions({ retainVersions: bad }), String(bad)).toBeNull();
  });
});

describe('the native-folder exclusion premise (#906 close-out)', () => {
  // readGitProvenance does not count edits under any ios/ or android/ folder as dirt, on the premise that
  // nothing a Vite build bundles lives there. This holds that premise against the tree, so a web source
  // moved under such a folder fails here instead of silently escaping the dirty check.
  it('no web source sits under an ios/ or android/ folder', () => {
    // Every file under a native folder (thousands today — the floor proves the enumeration ran), then
    // the ones a Vite build could import.
    const native = repoFiles({ match: /(^|\/)(ios|android)\//, exclude: ['node_modules'], floor: 100 });
    const offenders = native.map((f) => f.rel).filter((rel) => /\.(ts|tsx|js|jsx|mjs|cjs|css|html|vue)$/.test(rel));
    expect(offenders).toEqual([]);
  });
});
