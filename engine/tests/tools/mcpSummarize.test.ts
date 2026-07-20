/** Unit: summary-first shaping for list_assets / list_traits (docs/mcp-response-budget.md Phase 5).
 *
 *  Both tools used to dump everything: 320 asset entries (~16.7k tokens) and 60 trait schemas
 *  (~10.7k) on every call. Neither is the question an agent is actually asking. The bare call now
 *  answers "what exists, and how much", and a filter buys the detail.
 *
 *  The trap these guard is the SILENT EMPTY: a filter that matches nothing must say so and say how
 *  to recover, otherwise `[]` reads as "the project has no scenes" rather than "your prefix was
 *  wrong". Same for an unknown trait name. */

import { describe, it, expect } from 'vitest';
import { summarizeAssets, summarizeTraits, type AssetEntry, type TraitSchema } from '../../tools/modoki-mcp/src/summarize';

const ASSETS: AssetEntry[] = [
  { guid: 'g1', path: '/assets/scenes/main.json', name: 'Main', type: 'scene' },
  { guid: 'g2', path: '/assets/scenes/level2.json', name: 'Level2', type: 'scene' },
  { guid: 'g3', path: '/assets/models/tree.mesh.json', name: 'Tree', type: 'mesh' },
  { guid: 'g4', path: '/assets/textures/bark.png', name: 'Bark', type: 'texture' },
];

const TRAITS: Record<string, TraitSchema> = {
  Transform: { category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' } } },
  Renderable3D: { category: 'component', fields: { mesh: { type: 'asset' } } },
  Time: { category: 'resource', fields: { delta: { type: 'number' } } },
  Untagged: { fields: {} }, // no category → 'other'
};

describe('summarizeAssets — bare returns counts', () => {
  it('per-type counts, no entries', () => {
    const d = summarizeAssets(ASSETS) as { total: number; byType: Record<string, number>; assets?: unknown };
    expect(d.total).toBe(4);
    expect(d.byType).toEqual({ scene: 2, mesh: 1, texture: 1 });
    expect(d.assets).toBeUndefined();
    expect((d as { hint: string }).hint).toContain('folder=');
  });

  it('all=true forces the full list', () => {
    const d = summarizeAssets(ASSETS, { all: true }) as { assets: AssetEntry[] };
    expect(d.assets).toHaveLength(4);
  });

  it('an explicit limit is NEVER silently ignored — it returns entries, not counts', () => {
    // Regression: `limit` alone used to fall through to the counts branch, so asking for
    // "the first 2 assets" returned a histogram. A parameter that does not change the answer
    // is worse than a missing one — the caller believes it narrowed.
    const d = summarizeAssets(ASSETS, { limit: 2 }) as { count: number; assets: AssetEntry[]; truncated: boolean; totalCount: number };
    expect(d.assets).toHaveLength(2);
    expect(d.count).toBe(2);
    expect(d.truncated).toBe(true);
    expect(d.totalCount).toBe(4);
  });
});

describe('summarizeAssets — filters buy entries', () => {
  const entries = (q: Parameters<typeof summarizeAssets>[1]) =>
    (summarizeAssets(ASSETS, q) as { assets: AssetEntry[] }).assets.map((a) => a.guid);

  it('type=', () => expect(entries({ type: 'scene' })).toEqual(['g1', 'g2']));
  it('folder= matches on path PREFIX, not substring', () => {
    expect(entries({ folder: '/assets/scenes' })).toEqual(['g1', 'g2']);
    expect(entries({ folder: 'scenes' })).toEqual([]); // not a prefix — must not match
  });
  it('name= matches name OR path, case-insensitively', () => {
    expect(entries({ name: 'tree' })).toEqual(['g3']);
    expect(entries({ name: 'TEXTURES' })).toEqual(['g4']); // via path
  });
  it('filters compose (AND, not OR)', () => {
    expect(entries({ type: 'scene', name: 'level' })).toEqual(['g2']);
    expect(entries({ type: 'mesh', name: 'level' })).toEqual([]);
  });

  it('limit caps and flags truncated + totalCount', () => {
    const d = summarizeAssets(ASSETS, { type: 'scene', limit: 1 }) as { count: number; truncated: boolean; totalCount: number };
    expect(d.count).toBe(1);
    expect(d.truncated).toBe(true);
    expect(d.totalCount).toBe(2);
  });

  it('omits truncated when under the limit', () => {
    const d = summarizeAssets(ASSETS, { type: 'scene', limit: 99 }) as { truncated?: boolean };
    expect(d.truncated).toBeUndefined();
  });

  it('a zero-match filter is never silent — it hints', () => {
    const d = summarizeAssets(ASSETS, { type: 'nope' }) as { count: number; hint: string };
    expect(d.count).toBe(0);
    expect(d.hint).toContain('No match');
  });
});

describe('summarizeTraits — bare returns names by category', () => {
  it('groups names, counts, and omits field schemas', () => {
    const d = summarizeTraits(TRAITS, true) as { traitCount: number; byCategory: Record<string, string[]>; hint: string };
    expect(d.traitCount).toBe(4);
    expect(d.byCategory.component).toEqual(['Transform', 'Renderable3D']);
    expect(d.byCategory.resource).toEqual(['Time']);
    expect(d.byCategory.other).toEqual(['Untagged']); // no category → 'other', not dropped
    expect(JSON.stringify(d)).not.toContain('"type":"number"'); // no field schemas leaked
    expect(d.hint).toContain('name=<Trait>');
  });

  it('propagates schemaAvailable (ref checks vs type checks depend on it)', () => {
    expect((summarizeTraits(TRAITS, false) as { schemaAvailable: boolean }).schemaAvailable).toBe(false);
  });
});

describe('summarizeTraits — name= returns exactly one schema', () => {
  it('returns the requested trait with its fields', () => {
    const d = summarizeTraits(TRAITS, true, { name: 'Transform' }) as { traits: Record<string, TraitSchema> };
    expect(Object.keys(d.traits)).toEqual(['Transform']);
    expect(d.traits.Transform.fields).toEqual({ x: { type: 'number' }, y: { type: 'number' } });
  });

  it('an unknown trait errors with a did-you-mean, not a silent empty', () => {
    const d = summarizeTraits(TRAITS, true, { name: 'transform' }) as { error: string };
    expect(d.error).toContain('unknown trait "transform"');
    expect(d.error).toContain('Transform'); // case-insensitive suggestion
  });

  it('an unknown trait with no near match still errors cleanly', () => {
    const d = summarizeTraits(TRAITS, true, { name: 'Zzz' }) as { error: string };
    expect(d.error).toContain('unknown trait "Zzz"');
    expect(d.error).not.toContain('did you mean');
  });

  it('all=true returns every schema', () => {
    const d = summarizeTraits(TRAITS, true, { all: true }) as { traits: Record<string, TraitSchema> };
    expect(Object.keys(d.traits)).toHaveLength(4);
    expect(d.traits.Transform.fields).toBeDefined();
  });
});
