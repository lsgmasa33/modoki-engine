/** modelPostprocessorRegistry unit tests — registration, lookup, none fallback. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function getRegistry() {
  return import('../../../src/runtime/loaders/modelPostprocessorRegistry');
}

beforeEach(() => {
  vi.resetModules();
});

describe('modelPostprocessorRegistry', () => {
  describe('none postprocessor', () => {
    it('getModelPostprocessor returns none for unknown ID', async () => {
      const { getModelPostprocessor } = await getRegistry();

      const pp = getModelPostprocessor('nonexistent');

      expect(pp.name).toBe('None');
      expect(pp.fixupMesh).toBeDefined();
      expect(pp.filterMesh).toBeUndefined();
    });

    it('none postprocessor fixupMesh is a no-op', async () => {
      const { getModelPostprocessor } = await getRegistry();

      const mockMesh: any = { name: 'test', material: {} };
      expect(() => getModelPostprocessor('nonexistent').fixupMesh(mockMesh)).not.toThrow();
    });
  });

  describe('registerModelPostprocessor', () => {
    it('registers and retrieves a custom postprocessor', async () => {
      const { registerModelPostprocessor, getModelPostprocessor } = await getRegistry();

      const customPostprocessor = {
        name: 'Custom',
        description: 'A custom postprocessor',
        fixupMesh: vi.fn(),
      };
      registerModelPostprocessor('custom', customPostprocessor);

      const retrieved = getModelPostprocessor('custom');
      expect(retrieved.name).toBe('Custom');
      expect(retrieved).toBe(customPostprocessor);
    });

    it('overrides existing postprocessor with same ID', async () => {
      const { registerModelPostprocessor, getModelPostprocessor } = await getRegistry();

      registerModelPostprocessor('override', { name: 'First', description: '', fixupMesh: () => {} });
      registerModelPostprocessor('override', { name: 'Second', description: '', fixupMesh: () => {} });

      expect(getModelPostprocessor('override').name).toBe('Second');
    });
  });

  describe('getAllModelPostprocessors', () => {
    it('includes none and registered postprocessors', async () => {
      const { registerModelPostprocessor, getAllModelPostprocessors } = await getRegistry();

      registerModelPostprocessor('test', { name: 'Test', description: '', fixupMesh: () => {} });

      const list = getAllModelPostprocessors();

      expect(list.length).toBeGreaterThanOrEqual(2);
      const ids = list.map((l) => l.id);
      expect(ids).toContain('none');
      expect(ids).toContain('test');
    });
  });

  describe('getModelPostprocessorIds', () => {
    it('returns array of registered IDs', async () => {
      const { registerModelPostprocessor, getModelPostprocessorIds } = await getRegistry();

      registerModelPostprocessor('myPostprocessor', { name: 'My', description: '', fixupMesh: () => {} });

      const ids = getModelPostprocessorIds();

      expect(ids).toContain('none');
      expect(ids).toContain('myPostprocessor');
    });
  });
});
