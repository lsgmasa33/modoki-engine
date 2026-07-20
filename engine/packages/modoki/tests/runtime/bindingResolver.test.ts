/** bindingResolver unit tests — text template resolution. */

import { describe, it, expect } from 'vitest';

async function getBindingResolver() {
  return import('../../../src/runtime/ui/bindingResolver');
}

describe('bindingResolver', () => {
  describe('resolveTemplate', () => {
    it('replaces {field} placeholders with state values', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const state = { score: 1500, level: 5, name: 'Player' };

      expect(resolveTemplate('Score: {score}', state)).toBe('Score: 1500');
      expect(resolveTemplate('Level {level}', state)).toBe('Level 5');
      expect(resolveTemplate('Hi {name}!', state)).toBe('Hi Player!');
    });

    it('leaves unknown fields as-is with braces', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const state = { score: 100 };

      expect(resolveTemplate('{score}/{max}', state)).toBe('100/{max}');
    });

    it('replaces multiple occurrences of same field', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const state = { n: 3 };

      expect(resolveTemplate('{n} of {n}', state)).toBe('3 of 3');
    });

    it('returns plain text when no braces', async () => {
      const { resolveTemplate } = await getBindingResolver();
      expect(resolveTemplate('Hello World', {})).toBe('Hello World');
    });

    it('converts numbers to strings', async () => {
      const { resolveTemplate } = await getBindingResolver();
      expect(resolveTemplate('{val}', { val: 42 })).toBe('42');
      expect(resolveTemplate('{val}', { val: 0 })).toBe('0');
    });

    it('handles empty state', async () => {
      const { resolveTemplate } = await getBindingResolver();
      expect(resolveTemplate('{missing}', {})).toBe('{missing}');
    });

    it('handles boolean state values', async () => {
      const { resolveTemplate } = await getBindingResolver();
      expect(resolveTemplate('{active}', { active: true })).toBe('true');
      expect(resolveTemplate('{active}', { active: false })).toBe('false');
    });

    it('treats a null store value as absent (not the literal "null")', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const { registerReadSource, __resetReadSourcesForTesting } =
        await import('../../../src/runtime/ui/readSourceRegistry');
      __resetReadSourcesForTesting();

      // No read source → null falls through to the literal placeholder, not "null".
      expect(resolveTemplate('{x}', { x: null })).toBe('{x}');

      // With a read source, a null store value defers to it.
      registerReadSource('x', () => 'from-source');
      expect(resolveTemplate('{x}', { x: null })).toBe('from-source');
      __resetReadSourcesForTesting();
    });

    it('falsy-but-present store values (0/false/"") do NOT fall through to a read source', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const { registerReadSource, __resetReadSourcesForTesting } =
        await import('../../../src/runtime/ui/readSourceRegistry');
      __resetReadSourcesForTesting();
      registerReadSource('n', () => 999);

      expect(resolveTemplate('{n}', { n: 0 })).toBe('0');      // store 0 wins
      expect(resolveTemplate('{n}', { n: '' })).toBe('');      // store '' wins
      __resetReadSourcesForTesting();
    });

    it('resolves an undefined store field via the read source', async () => {
      const { resolveTemplate } = await getBindingResolver();
      const { registerReadSource, __resetReadSourcesForTesting } =
        await import('../../../src/runtime/ui/readSourceRegistry');
      __resetReadSourcesForTesting();
      registerReadSource('timeSinceGameStart', () => 12);

      expect(resolveTemplate('t={timeSinceGameStart}', {})).toBe('t=12');
      __resetReadSourcesForTesting();
    });
  });

  describe('evalVisibility', () => {
    it('empty field ⇒ no override (visible)', async () => {
      const { evalVisibility } = await getBindingResolver();
      expect(evalVisibility({ gameOver: false }, '', '', '')).toBe(true);
    });

    it('no op ⇒ truthy test on the store field', async () => {
      const { evalVisibility } = await getBindingResolver();
      expect(evalVisibility({ gameOver: true }, 'gameOver', '', '')).toBe(true);
      expect(evalVisibility({ gameOver: false }, 'gameOver', '', '')).toBe(false);
      expect(evalVisibility({ n: 0 }, 'n', '', '')).toBe(false);         // 0 is falsy
      expect(evalVisibility({ n: 3 }, 'n', '', '')).toBe(true);
      expect(evalVisibility({ s: 'false' }, 's', '', '')).toBe(false);   // string 'false' counts as false
      expect(evalVisibility({}, 'missing', '', '')).toBe(false);         // absent ⇒ hidden
    });

    it('numeric comparison (hearts >= i+1 gates each heart)', async () => {
      const { evalVisibility } = await getBindingResolver();
      // hearts = 2 → hearts >= 1 and >= 2 show; >= 3 hidden.
      expect(evalVisibility({ hearts: 2 }, 'hearts', '>=', '1')).toBe(true);
      expect(evalVisibility({ hearts: 2 }, 'hearts', '>=', '2')).toBe(true);
      expect(evalVisibility({ hearts: 2 }, 'hearts', '>=', '3')).toBe(false);
      expect(evalVisibility({ hearts: 0 }, 'hearts', '>=', '1')).toBe(false);
      expect(evalVisibility({ n: 5 }, 'n', '==', '5')).toBe(true);
      expect(evalVisibility({ n: 5 }, 'n', '!=', '5')).toBe(false);
      expect(evalVisibility({ n: 1 }, 'n', '<', '3')).toBe(true);
    });

    it('string comparison when the values are not numeric', async () => {
      const { evalVisibility } = await getBindingResolver();
      expect(evalVisibility({ phase: 'win' }, 'phase', '==', 'win')).toBe(true);
      expect(evalVisibility({ phase: 'lose' }, 'phase', '==', 'win')).toBe(false);
      expect(evalVisibility({ phase: 'lose' }, 'phase', '!=', 'win')).toBe(true);
    });

    it('falls back to the read source, and never hides on an unknown op', async () => {
      const { evalVisibility } = await getBindingResolver();
      const { registerReadSource, __resetReadSourcesForTesting } =
        await import('../../../src/runtime/ui/readSourceRegistry');
      __resetReadSourcesForTesting();
      registerReadSource('live', () => 7);
      expect(evalVisibility({}, 'live', '>=', '5')).toBe(true);   // resolved via read source
      expect(evalVisibility({ x: 1 }, 'x', 'BOGUS', '1')).toBe(true); // unknown op ⇒ don't hide
      __resetReadSourcesForTesting();
    });
  });
});
