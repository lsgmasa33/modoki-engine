/** Corpus guard for the `UIAnchor.zIndex` removal (SCENE_FORMAT_VERSION 12→13).
 *
 *  Two separate claims, because they fail for different reasons:
 *
 *  1. **No game or demo content still authors `UIAnchor.zIndex`.** The codemod
 *     (`engine/scripts/migrate-anchor-zindex.mjs`) moved all 88 keys onto `UIElement.zIndex`.
 *     Re-introducing one is not a validation error — the field no longer exists on the trait, so
 *     `serialize.ts` would silently DROP it on the next save (it writes the koota schema's keys,
 *     not the file's) and koota's generated setter ignores it at spawn. Silent both ways, which is
 *     exactly why it needs a guard rather than a warning.
 *
 *  2. **The scenes that DO still carry it are migratable.** `engine/tests/e2e/fixtures/**` is
 *     deliberately left at `version: 9` — those fixtures earn their keep by driving the whole
 *     migration ladder on every e2e run, and stamping them current would have quietly retired that
 *     coverage. So instead of asserting they are clean, this runs the real migration over the real
 *     file and asserts the authored stacking SURVIVES onto `UIElement.zIndex`.
 *
 *  Why this matters more than it looks: `npm run test:e2e` is not part of the local gate (the free
 *  public runner covers it), so a fixture whose z-order silently vanished would surface only after
 *  a push to main. This test puts that one question inside the local gate. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUIAnchorZIndexInTraits } from '../../packages/modoki/src/runtime/loaders/uiAnchorZIndexMigration';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Ent = { name?: string; traits?: Record<string, unknown> };

function sceneFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // Build output mirrors the source scenes; only the authored copy is the corpus.
    if (e.isDirectory()) {
      if (e.name === 'dist' || e.name === 'ios' || e.name === 'android' || e.name === 'node_modules') continue;
      out.push(...sceneFiles(p));
    } else if (e.name.endsWith('.scene.json') || e.name.endsWith('.prefab.json')) out.push(p);
  }
  return out;
}

function entitiesWithAnchorZIndex(file: string): { ent: Ent; anchor: Record<string, unknown> }[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { entities?: Ent[] };
  const hits: { ent: Ent; anchor: Record<string, unknown> }[] = [];
  for (const ent of data.entities ?? []) {
    const anchor = ent.traits?.['UIAnchor'];
    if (anchor && typeof anchor === 'object' && 'zIndex' in (anchor as object)) {
      hits.push({ ent, anchor: anchor as Record<string, unknown> });
    }
  }
  return hits;
}

describe('UIAnchor.zIndex is gone from authored content (#762 follow-up)', () => {
  it('no scene or prefab under games/ or demos/ still authors UIAnchor.zIndex', () => {
    const offenders: string[] = [];
    for (const root of ['games', 'demos']) {
      for (const file of sceneFiles(path.join(REPO, root))) {
        for (const { ent } of entitiesWithAnchorZIndex(file)) {
          offenders.push(`${path.relative(REPO, file)} → entity ${JSON.stringify(ent.name ?? '?')}`);
        }
      }
    }
    expect(offenders, 'UIAnchor.zIndex no longer exists on the trait, so this value is dropped on '
      + 'the next save and ignored at spawn — both silently. Author UIElement.zIndex instead:\n'
      + offenders.join('\n')).toEqual([]);
  });

  it('the deliberately-old e2e fixtures still migrate their stacking onto UIElement.zIndex', () => {
    const files = sceneFiles(path.join(REPO, 'engine/tests/e2e/fixtures'))
      .filter((f) => entitiesWithAnchorZIndex(f).length > 0);

    // If this ever hits zero the fixtures were migrated in place, which retires the migration-ladder
    // coverage they exist for — that is a change to make deliberately, not to discover here.
    expect(files.length, 'expected at least one old e2e fixture still exercising the v12→v13 step')
      .toBeGreaterThan(0);

    for (const file of files) {
      for (const { ent, anchor } of entitiesWithAnchorZIndex(file)) {
        const authored = anchor.zIndex;
        const traits = ent.traits!;
        migrateUIAnchorZIndexInTraits(traits);

        const element = traits['UIElement'] as Record<string, unknown> | undefined;
        const where = `${path.relative(REPO, file)} → entity ${JSON.stringify(ent.name ?? '?')}`;
        expect(anchor, `${where}: the anchor key must be gone after migrating`).not.toHaveProperty('zIndex');
        if (authored) {
          // A truthy anchor value is what rendered before the removal, so it must survive.
          expect(element?.zIndex, `${where}: authored stacking ${String(authored)} was lost`).toBe(authored);
        }
      }
    }
  });
});
