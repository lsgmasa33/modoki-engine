/** The §1 strict-schema refusal NAMES the unknown key, and says where it goes when a nested param
 *  declares it (`tools/shared/unknownParam.ts`) — on the editor server (zod 3), the device server
 *  (zod 4) and a `modoki_batch` step alike.
 *
 *  Why: the SDK delivers only each zod issue's `message`, so a refusal that merely listed the
 *  accepted params left the caller to diff its own call against the list. Measured (2026-09-25
 *  audit, U-1): `surface` sent top-level on `modoki_tap` — it belongs INSIDE `entity` — 7 times,
 *  and 5 of the 8 retries failed again. */

import { describe, it, expect, afterEach } from 'vitest';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';
import { runBatch, type BatchOutcome, type BatchRejection } from '../../tools/modoki-mcp/src/batch';
import { nestedHomesOf } from '../../tools/shared/unknownParam';
import { z as z3 } from '../../tools/modoki-mcp/node_modules/zod';
import { z as z4 } from '../../tools/game-debug-mcp/node_modules/zod';

/** Both zod dialects, typed as ONE so a loop over them typechecks — a union of the two namespaces
 *  makes every method uncallable to tsc. The walk under test only reads runtime accessors, and
 *  each test runs the real zod 4 objects; the cast is for the compiler alone. */
const DIALECTS = [['zod 3', z3], ['zod 4', z4 as unknown as typeof z3]] as const;

let surface: Surface | undefined;
let device: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; device?.restore(); device = undefined; });

const MISPLACED = { entity: { name: 'Btn' }, surface: 'game-ui' };

describe('the refusal names the unknown key and where it belongs', () => {
  it('editor: modoki_tap with a top-level `surface` says `entity` has that field', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_tap', MISPLACED)).rejects.toThrow(
      /unrecognized parameter: 'surface'\. 'surface' is not a top-level parameter; `entity` has a field of that name \(entity: [^)]+\)\. It accepts: .*\bentity\b/s,
    );
  });

  it('editor: a key two levels down names every nested home (drag `from.entity` / `to.entity`)', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_drag', { from: { entity: { name: 'A' } }, to: { x: 1, y: 1 }, surface: 'game-2d' }))
      .rejects.toThrow(/`from\.entity` and `to\.entity` have a field of that name\./);
  });

  it('device: device_tap gives the same refusal (zod 4 path)', async () => {
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_tap', MISPLACED);
    expect(v.ok).toBe(false);
    // …WITH the aim's description: zod 4's `.optional()` drops it from the outer schema, so it is
    // read along the unwrap chain (#1545 re-review — the device quoted nothing before).
    expect(v.error).toMatch(/unrecognized parameter: 'surface'\. 'surface' is not a top-level parameter; `entity` has a field of that name \(entity: [^)]+\)/);
    expect(v.error).toMatch(/It accepts: .*\bentity\b/);
  });

  it('batch: a step with a top-level `surface` is refused with the same text, nothing runs', async () => {
    surface = loadSurface();
    const r = await runBatch({ steps: [{ tool: 'modoki_tap', args: MISPLACED }] }, { sleep: async () => {} });
    expect('rejected' in r).toBe(true);
    expect((r as BatchRejection).rejected).toMatch(/step 0.*'surface' is not a top-level parameter; `entity` has a field of that name/s);
    expect(surface.requests.length).toBe(0);
  });
});

describe('accept side — the hint only appears when it is TRUE', () => {
  it('an unknown key no nested param declares is named, with no nested-field sentence', async () => {
    const s = (surface = loadSurface());
    const err = await s.call('modoki_set_selection', { bogusKey: 1 }).then(() => '', (e: Error) => e.message);
    expect(err).toMatch(/unrecognized parameter: 'bogusKey'\. It accepts: /);
    expect(err).not.toMatch(/a field of that name/);
  });

  it('several unknown keys are all named', async () => {
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_watch', { action: 'clear', ids: 'w3', bogus: 1 });
    expect(v.error).toMatch(/device_watch received unrecognized parameters: 'ids', 'bogus'\./);
  });

  it('a NAME match is stated as a fact with the home\'s description, never as "goes inside" (#1545 review)', async () => {
    // The call §1 was made strict for: the caller meant an ENTITY named Capsule. The only nested
    // `name` on set_selection is `asset.name` — an asset selection — so an instruction would send
    // the caller the wrong way. The fact plus asset's own description lets it see that.
    const s = (surface = loadSurface());
    const err = await s.call('modoki_set_selection', { name: 'Capsule' }).then(() => '', (e: Error) => e.message);
    expect(err).toMatch(/'name' is not a top-level parameter; `asset` has a field of that name \(asset: [^)]+\)\./);
    expect(err).not.toMatch(/goes inside/);
  });

  it('an "e.g." does not end the quoted sentence, and a home is quoted ONCE for several keys', async () => {
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_create_entity', { kind: 'primitive', mesh: 'cube' });
    expect(v.error).toMatch(/\(spec: What to create, e\.g\. \{/);
    expect(v.error!.match(/\(spec: /g)).toHaveLength(1);
  });

  it('the REAL mutate_scene `ops` ("Ops. setTrait: {…}") is not quoted — no JSON fragment cut mid-brace', async () => {
    const s = (surface = loadSurface());
    const err = await s.call('modoki_mutate_scene', { ops: [], trait: 'UIElement' }).then(() => '', (e: Error) => e.message);
    expect(err).toMatch(/'trait' is not a top-level parameter; `ops\[\]` has a field of that name\. It accepts: path, ops\./);
  });

  it('a long first sentence is cut at a WORD boundary, and newlines collapse', () => {
    for (const [, z] of DIALECTS) {
      const words = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');
      const long = nestedHomesOf({ p: z.object({ k: z.string() }).describe(words) }, 'k')[0].description!;
      expect(long.endsWith('…')).toBe(true);
      expect(long.length).toBeLessThanOrEqual(90);
      expect(long.slice(0, -1)).toMatch(/(^| )word\d\d$/);        // ends on a whole word
      const multi = nestedHomesOf({ q: z.object({ k: z.string() }).describe('Line one\n  line two.') }, 'k')[0].description;
      expect(multi).toBe('Line one line two.');
    }
  });

  it('a description that only restates the param name is not quoted ("(ops[]: Ops.)")', () => {
    for (const [, z] of DIALECTS) {
      const shape = { ops: z.array(z.object({ trait: z.string() })).describe('Ops.'), at: z.object({ x: z.number() }).describe('Where to aim. More.') };
      expect(nestedHomesOf(shape, 'trait')).toEqual([{ path: 'ops[]', description: undefined }]);
      expect(nestedHomesOf(shape, 'x')).toEqual([{ path: 'at', description: 'Where to aim.' }]);
    }
  });

  it('play_clip: `id` is not pointed at `entity`, and an {id} inside it is refused by name', async () => {
    // It shared the guid/id alias, whose description promises a flat `id` this tool does not have —
    // quoted into the refusal, it sent `{id}` to `entity:{id}`, which the op refuses too. Its own
    // guid-only alias has no `id`, so there is no nested field to state.
    const s = (surface = loadSurface());
    const flat = await s.call('modoki_play_clip', { id: 3, clip: 'Run' }).then(() => '', (e: Error) => e.message);
    expect(flat).toMatch(/unrecognized parameter: 'id'\. It accepts: guid, entity, clip\./);
    expect(flat).not.toMatch(/a field of that name/);
    await expect(s.call('modoki_play_clip', { entity: { id: 3 }, clip: 'Run' }))
      .rejects.toThrow(/unrecognized key 'id' — an entity ref here accepts only: guid/);
  });

  it('the correctly nested call is not refused', async () => {
    const s = (surface = loadSurface());
    const r = await s.call('modoki_tap', { entity: { name: 'Btn', surface: 'game-ui' } });
    expect(r.isError).not.toBe(true);
    const d = (device = await loadDeviceSurface());
    expect(d.validate('device_tap', { entity: { name: 'Btn', surface: 'game-ui' } }).ok).toBe(true);
  });

  it('a batch with valid steps still runs (the refusal path is not taken)', async () => {
    surface = loadSurface();
    const r = await runBatch({ steps: [{ tool: 'modoki_tap', args: { entity: { name: 'Btn', surface: 'game-ui' } } }] }, { sleep: async () => {} });
    expect('rejected' in r).toBe(false);
    expect((r as BatchOutcome).steps.length).toBe(1);
  });
});

/** The close-out sweep's siblings: a NESTED strict object carried a fixed "X accepts only: …"
 *  sentence, and the SDK appends only the path — so `ops[].values` (measured in transcripts) came
 *  back as "setTrait accepts: op, entity, trait, fields, space at ops.0", naming no key. */
describe('a nested unknown key is named too', () => {
  it('editor: a mutate_scene op names the bad key beside the op\'s accepted keys', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_mutate_scene', { ops: [{ op: 'setTrait', entity: { name: 'A' }, trait: 'Transform', fields: {}, values: { x: 1 } }] }))
      .rejects.toThrow(/unrecognized key 'values' — setTrait accepts: op, entity, trait, fields, space/);
  });

  it('editor: a batch step names the bad key (`arg` for `args`)', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_batch', { steps: [{ tool: 'modoki_save_all', arg: {} }] }))
      .rejects.toThrow(/unrecognized key 'arg' — a batch step accepts only: tool, args, result/);
  });

  it('device: a typo inside a create_entity spec names the typo (the sibling the first sweep missed)', async () => {
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_create_entity', { spec: { kind: 'primitive', mseh: 'cube' } });
    expect(v.error).toMatch(/unrecognized key 'mseh' — a "primitive" spec accepts only: kind, mesh/);
  });

  it('device: a typo inside the entity aim names the typo', async () => {
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_tap', { entity: { name: 'Btn', surfce: 'game-ui' } });
    expect(v.error).toMatch(/unrecognized key 'surfce' — an entity aim accepts only: guid, name, id, surface, allowOccluded/);
  });

  it('device accept side: a STRING that is not an encoded object, where the aim object belongs, is a type error, not "accepts only"', async () => {
    // A JSON-encoded object here is now DECODED (#1560, coerceStringEncoded.test.ts). What is left to
    // refuse is a string that is no object at all — and the fixed sentence used to answer that too,
    // telling the caller its keys were wrong when its TYPE was.
    const d = (device = await loadDeviceSurface());
    const v = d.validate('device_tap', { entity: 'Btn' });
    expect(v.ok).toBe(false);
    expect(v.error).not.toMatch(/accepts only/);
    expect(v.error).toMatch(/object/i);
  });
});

/** The walk reaches the same wrappers in both zod dialects (#1545 review: zod 4's ZodArray has
 *  `unwrap()` and zod 3's does not, so the device server walked arrays and the editor did not). */
describe('nestedHomesOf — the same walk in zod 3 and zod 4', () => {
  it('editor (zod 3): a top-level `tool` on modoki_batch points at `steps[]`', async () => {
    const s = (surface = loadSurface());
    await expect(s.call('modoki_batch', { tool: 'modoki_save_all' }))
      .rejects.toThrow(/'tool' is not a top-level parameter; `steps\[\]` has a field of that name/);
  });

  it.each(DIALECTS)('%s: arrays, defaults and refinements are walked; a RECORD is not', (_label, z) => {
    {
      const shape = {
        list: z.array(z.object({ a: z.string() })),
        dflt: z.object({ b: z.string() }).default({ b: 'x' }),
        refined: z.object({ c: z.string() }).refine(() => true),
        rec: z.record(z.string(), z.object({ d: z.string() })),
      };
      expect(nestedHomesOf(shape, 'a').map((h) => h.path)).toEqual(['list[]']);
      expect(nestedHomesOf(shape, 'b').map((h) => h.path)).toEqual(['dflt']);
      expect(nestedHomesOf(shape, 'c').map((h) => h.path)).toEqual(['refined']);
      expect(nestedHomesOf(shape, 'd')).toEqual([]);   // a record's values are not named fields
    }
  });
});
