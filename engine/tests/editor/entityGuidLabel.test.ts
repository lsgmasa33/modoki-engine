/** The Inspector header's guid label (#1210): durable, runtime, or none — the three things "has a
 *  guid" can mean now that code-spawned entities get a runtime address. */

import { describe, it, expect } from 'vitest';
import { describeEntityGuid } from '../../packages/modoki/src/editor/panels/entityGuidLabel';
import { formatRuntimeGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';

describe('describeEntityGuid', () => {
  it('a durable guid shows as itself, with no badge', () => {
    const g = 'd1111111-1111-4111-8111-111111111111';
    expect(describeEntityGuid(g)).toMatchObject({ kind: 'durable', text: g, badge: '' });
  });

  it('a runtime guid shows as itself, badged, and says it expires on reload', () => {
    const g = formatRuntimeGuid(3, 12);
    const label = describeEntityGuid(g);
    expect(label).toMatchObject({ kind: 'runtime', text: g, badge: 'runtime' });
    expect(label.title).toMatch(/until the scene reloads/);
  });

  it('a TRANSIENT entity\'s runtime guid does not promise a save will replace it — the serializer skips it', () => {
    const g = formatRuntimeGuid(3, 13);
    expect(describeEntityGuid(g, true).title).toMatch(/never saved/);
    expect(describeEntityGuid(g, true).title).not.toMatch(/saving the scene replaces/);
    expect(describeEntityGuid(g, false).title).toMatch(/saving the scene replaces/);
  });

  it('no guid shows a placeholder, never an empty value to copy', () => {
    for (const g of ['', null, undefined]) {
      expect(describeEntityGuid(g)).toMatchObject({ kind: 'none', badge: 'unsaved' });
      expect(describeEntityGuid(g).text).not.toBe('');
    }
  });
});
