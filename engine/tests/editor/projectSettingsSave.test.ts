/** Project Settings Apply posts only what the dialog changed, conditioned on what it read (#2053) — the decisions in
 *  `projectSettingsSave.ts`, tested as plain functions (CLAUDE.md § Editor: no jsdom panel mount). The route half (the
 *  agent's write survives an Apply; a field both changed is refused) is in `projectSettingsPrecondition.test.ts`. */
import { describe, it, expect } from 'vitest';
import { planSettingsSave, rebaseSettingsDraft, WHOLESALE_PATHS } from '../../packages/modoki/src/editor/panels/projectSettingsSave';
import { REPLACE_WHOLESALE } from '../../project-config';

const schema = {
  tabs: [{ title: 'OTA', groups: [{ title: 'OTA', fields: [
    { key: 'ota.enabled', label: 'Enabled', type: 'checkbox' as const },
    { key: 'ota.publicKey', label: 'Public key', type: 'readonly-text' as const },
  ] }] }],
};

const base = () => ({
  app: { appId: 'com.x.y', appName: 'A' },
  ota: { enabled: false, publicKey: 'pk-read-on-open', subgames: ['a'] },
  physics: { layers: ['Default', 'Player'], collisionMatrix: [3, 3] },
  rendering: { three: { exposure: 1, tiers: { low: { maxDpr: 1 }, high: { maxDpr: 2 } } } },
});

describe('planSettingsSave (#2053)', () => {
  it('posts only the changed leaf, with its open-time value as the precondition', () => {
    const draft = base();
    draft.app.appName = 'B';
    expect(planSettingsSave(base(), draft, schema)).toEqual({
      patch: { app: { appName: 'B' } },
      expected: { app: { appName: 'A' } },
      changed: ['app.appName'],
    });
  });

  it('an untouched draft posts nothing, so Apply has nothing to send', () => {
    expect(planSettingsSave(base(), base(), schema)).toEqual({ patch: {}, expected: {}, changed: [] });
  });

  it('never posts a readonly field, even when the draft holds a different value (#2049)', () => {
    const draft = base();
    draft.ota.publicKey = 'pk-something-else';
    draft.ota.enabled = true;
    const plan = planSettingsSave(base(), draft, schema);
    expect(plan.patch).toEqual({ ota: { enabled: true } });
    expect(plan.changed).toEqual(['ota.enabled']);
  });

  it('an array is one leaf: a changed list posts whole', () => {
    const draft = base();
    draft.ota.subgames = ['a', 'b'];
    expect(planSettingsSave(base(), draft, schema).patch).toEqual({ ota: { subgames: ['a', 'b'] } });
  });

  it('a change inside a wholesale subtree posts the whole subtree, so the route does not lose the other tiers', () => {
    const draft = base();
    draft.rendering.three.tiers.low.maxDpr = 1.5;
    const plan = planSettingsSave(base(), draft, schema);
    expect(plan.patch).toEqual({ rendering: { three: { tiers: { low: { maxDpr: 1.5 }, high: { maxDpr: 2 } } } } });
    expect(plan.changed).toEqual(['rendering.three.tiers']);
  });

  it('a removed tier is a change, posted as the tiers block without it', () => {
    const draft = base();
    delete (draft.rendering.three.tiers as Record<string, unknown>).low;
    expect(planSettingsSave(base(), draft, schema).patch).toEqual({ rendering: { three: { tiers: { high: { maxDpr: 2 } } } } });
  });

  it('a leaf the open-time read lacked is posted with no precondition (JSON cannot say "absent")', () => {
    const draft = { ...base(), user: { device: { iosDeviceId: 'X' } } };
    const plan = planSettingsSave(base(), draft, schema);
    expect(plan.patch).toEqual({ user: { device: { iosDeviceId: 'X' } } });
    expect(plan.expected).toEqual({});
  });

  it('does not mutate the draft it was handed', () => {
    const draft = base();
    draft.ota.subgames = ['z'];
    const plan = planSettingsSave(base(), draft, schema);
    (plan.patch.ota as { subgames: string[] }).subgames.push('mutated');
    expect(draft.ota.subgames).toEqual(['z']);
  });

  it("its wholesale list is the route's", () => {
    expect([...WHOLESALE_PATHS].sort()).toEqual([...REPLACE_WHOLESALE].sort());
  });
});

describe('rebaseSettingsDraft (#2053)', () => {
  it('keeps every edit the route did not name and drops the one it did, showing the value now on disk', () => {
    const draft = base();
    draft.app.appName = 'mine';
    draft.rendering.three.exposure = 2;
    const fresh = base();
    fresh.app.appName = 'agent';
    fresh.app.appId = 'com.agent.changed'; // written underneath too, but not edited here
    const { draft: next, dropped } = rebaseSettingsDraft(fresh, base(), draft, schema, ['app.appName']);
    expect(dropped).toEqual(['app.appName']);
    expect(next.app).toEqual({ appId: 'com.agent.changed', appName: 'agent' });
    expect((next.rendering as typeof draft.rendering).three.exposure).toBe(2);
  });

  it('a leaf the route names inside a wholesale subtree drops the whole subtree edit', () => {
    const draft = base();
    draft.rendering.three.tiers.high.maxDpr = 3;
    const fresh = base();
    fresh.rendering.three.tiers.low.maxDpr = 0.75;
    const { draft: next, dropped } = rebaseSettingsDraft(fresh, base(), draft, schema, ['rendering.three.tiers.low.maxDpr']);
    expect(dropped).toEqual(['rendering.three.tiers']);
    expect((next.rendering as typeof draft.rendering).three.tiers).toEqual({ low: { maxDpr: 0.75 }, high: { maxDpr: 2 } });
  });

  // Close-out review: a write landing AFTER the 409 and before Re-read was not named by the 409, so the edit was kept and
  // re-posted with expected = that write — the route accepted it and replaced the write unasked. Mutation (measured):
  // drop the `moved` check — this goes red.
  it('drops an edit whose value moved on disk after the 409, even though the 409 did not name it', () => {
    const draft = base();
    draft.app.appName = 'mine';
    draft.app.appId = 'com.mine';
    const fresh = base();
    fresh.app.appName = 'agent';
    fresh.app.appId = 'com.agent.later'; // written after the 409 that named only app.appName
    const { draft: next, dropped } = rebaseSettingsDraft(fresh, base(), draft, schema, ['app.appName']);
    expect(dropped.sort()).toEqual(['app.appId', 'app.appName']);
    expect(next.app).toEqual({ appId: 'com.agent.later', appName: 'agent' });
  });

  it('keeps an edit the disk already agrees with — there is nothing to decide', () => {
    const draft = base();
    draft.app.appName = 'same';
    const fresh = base();
    fresh.app.appName = 'same';
    expect(rebaseSettingsDraft(fresh, base(), draft, schema, []).dropped).toEqual([]);
  });

  it('after a rebase, the next plan posts the kept edit against the FRESH value', () => {
    const draft = base();
    draft.rendering.three.exposure = 2;
    const fresh = base();
    fresh.app.appName = 'agent';
    const { draft: next } = rebaseSettingsDraft(fresh, base(), draft, schema, ['app.appName']);
    expect(planSettingsSave(fresh, next, schema)).toEqual({
      patch: { rendering: { three: { exposure: 2 } } },
      expected: { rendering: { three: { exposure: 1 } } },
      changed: ['rendering.three.exposure'],
    });
  });
});
