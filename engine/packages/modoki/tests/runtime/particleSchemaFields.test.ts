/** particleSchemaFields — the 2D-particle Phase 0 additions to the particle asset
 *  schema surface: the editor-only `space` enum ('2d'|'3d'). */

import { describe, it, expect } from 'vitest';
import { getAssetSchema, validateAssetData } from '../../src/runtime/assets/assetSchemas';

describe('particle schema — space field (2D Phase 0)', () => {
  it('exposes a `space` enum field with ["2d","3d"]', () => {
    const s = getAssetSchema('particle')!;
    const space = s.fields.find((f) => f.key === 'space');
    expect(space).toBeTruthy();
    expect(space!.type).toBe('enum');
    expect(space!.enum).toEqual(['2d', '3d']);
  });

  it('accepts a valid space value without warning about space', () => {
    const r = validateAssetData('particle', { version: 1, space: '2d' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).not.toMatch(/space/);
  });

  it('warns when space is not one of 2d|3d', () => {
    const r = validateAssetData('particle', { version: 1, space: 'diagonal' });
    expect(r.errors).toEqual([]);
    const joined = r.warnings.join('\n');
    expect(joined).toMatch(/space/);
    expect(joined).toMatch(/not one of/);
  });

  it('the schema example still validates with zero errors', () => {
    const s = getAssetSchema('particle')!;
    expect(validateAssetData('particle', s.example).errors).toEqual([]);
  });
});
