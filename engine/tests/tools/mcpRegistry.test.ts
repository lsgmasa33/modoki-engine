/** The callable tool registry — unit tests for `registry.ts`, plus guards that keep every tool
 *  funnelling through it.
 *
 *  The guard is the load-bearing half. A bare `server.tool(...)` call site still registers the
 *  tool over MCP perfectly — it is only invisible to the REGISTRY, and therefore only invisible
 *  to `modoki_batch`, which resolves a step's `tool` string through `getTool()`. So the failure
 *  reads as "that tool doesn't exist" from inside a batch while the tool demonstrably works when
 *  called directly. Nothing about the running server looks wrong.
 *
 *  SINCE THE E1 SPLIT these are REAL assertions, not source scans. `index.ts` used to call
 *  `main()` at import, so vitest could not load the surface and reading it as text was the only
 *  option. Text guards fail OPEN: when the tool definitions moved out of `index.ts`, every scan
 *  in this file silently found nothing, and only the ones asserting a MINIMUM COUNT reported it.
 *  Anything phrased as "the bad pattern is absent" passed vacuously. That is why the count
 *  assertions below are kept, and why the rest now import the surface (`mcpSurface.ts`).
 *
 *  See `docs/debug-tools-mcp.md` (`modoki_batch`), which is why the registry exists. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Deliberately the MCP SERVER'S OWN zod, not a bare `from 'zod'`. The root package.json does
// not depend on zod at all — a bare specifier resolves to zod v4, hoisted in transitively by
// eslint-plugin-react-hooks → zod-validation-error, while modoki-mcp pins ^3.23.8 and installs
// its own v3 copy. So the bare import had this test building v4 schemas and handing them to a
// v3-typed registry: it passed only because the test validated its own v4 schema with the same
// v4 `z`, proving nothing about the v3 semantics `modoki_batch` actually runs against. Surfaced
// by issue #23 (TS2740 — two structurally different ZodType implementations).
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import {
  registerTool,
  getTool,
  toolNames,
  toolCount,
  clearRegistry,
} from '../../tools/modoki-mcp/src/registry';
import { loadSurface, type Surface } from './mcpSurface';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');
/** Every module that defines tools, plus the registration seam. */
const toolModules = () =>
  fs.readdirSync(path.join(SRC, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => `tools/${f}`);
/** Every hand-written module, discovered rather than listed — a new sibling of `context.ts` must
 *  not escape these guards just because nobody remembered to add it here. */
const allSrcFiles = () =>
  fs.readdirSync(SRC).filter((f) => f.endsWith('.ts')).concat(toolModules());

const okResult = { content: [{ type: 'text' as const, text: '{}' }] };

describe('registry', () => {
  beforeEach(() => clearRegistry());

  it('stores a tool and returns it by name', async () => {
    const handler = async () => okResult;
    registerTool({ name: 'modoki_fake', description: 'd', shape: { a: z.number() }, handler });
    const entry = getTool('modoki_fake');
    expect(entry?.name).toBe('modoki_fake');
    expect(await entry!.handler({ a: 1 })).toEqual(okResult);
  });

  it('returns undefined for an unknown name rather than throwing', () => {
    expect(getTool('modoki_nope')).toBeUndefined();
  });

  it('preserves the raw zod shape so a caller can re-validate args itself', () => {
    // This is the whole reason the registry stores `shape` and not just `handler`: the batch
    // executor validates each step against the tool's REAL schema instead of accepting
    // `z.record(z.any())` blindly.
    registerTool({
      name: 'modoki_fake',
      description: 'd',
      shape: { count: z.number().int(), label: z.string().optional() },
      handler: async () => okResult,
    });
    const schema = z.object(getTool('modoki_fake')!.shape);
    expect(schema.safeParse({ count: 3 }).success).toBe(true);
    expect(schema.safeParse({ count: 'three' }).success).toBe(false);
  });

  it('throws on a duplicate name', () => {
    // A duplicate silently shadows in the Map while BOTH appear over MCP — so a batch would
    // call a different tool than the one the model named. Loud beats subtle.
    const entry = { name: 'modoki_dup', description: 'd', shape: {}, handler: async () => okResult };
    registerTool(entry);
    expect(() => registerTool(entry)).toThrow(/duplicate tool name/);
  });

  it('reports names in insertion order and a live count', () => {
    registerTool({ name: 'b', description: '', shape: {}, handler: async () => okResult });
    registerTool({ name: 'a', description: '', shape: {}, handler: async () => okResult });
    expect(toolNames()).toEqual(['b', 'a']);
    expect(toolCount()).toBe(2);
  });

  it('stays free of the MCP SDK, so it remains unit-testable', () => {
    // Same rule result.ts follows. The moment this imports McpServer it inherits index.ts's
    // "can't be imported by a test" problem and these tests become another source scan.
    expect(fs.readFileSync(path.join(SRC, 'registry.ts'), 'utf-8')).not.toContain('@modelcontextprotocol');
  });
});

describe('the real registered surface', () => {
  let s: Surface;
  beforeEach(() => { s = loadSurface(); });
  afterEach(() => s.restore());

  it('registers a substantial, plausible number of tools', () => {
    // A floor, not an exact count — this file should not need editing for every new tool. It
    // catches a group module silently dropping out of `TOOL_GROUPS`, which would otherwise look
    // exactly like a working server minus some tools.
    expect(s.names.length).toBeGreaterThanOrEqual(70);
  });

  it('every registered tool is `modoki_`-prefixed, uniquely named, and documented', () => {
    expect(s.names).toEqual([...new Set(s.names)]);
    for (const name of s.names) {
      expect(name, 'tool names are the agent-facing vocabulary').toMatch(/^modoki_[a-z0-9_]+$/);
      const entry = getTool(name)!;
      // A floor that catches a stub/empty description. Length is a weak proxy for quality, so
      // the real bar is the per-parameter check below; this only catches "TODO".
      expect(entry.description.length, `${name} needs a real description`).toBeGreaterThan(60);
      expect(typeof entry.handler, `${name} must be callable`).toBe('function');
      expect(entry.shape, `${name} must expose its zod shape for batch validation`).toBeTypeOf('object');
    }
  });

  /** Parameters documented NOWHERE — neither `.describe()` on the zod field nor a mention in the
   *  tool description. This list was 25 entries across 21 tools when the guard was written on
   *  2026-07-30; Phase 4 of the MCP audit emptied it the same day, so it now exists to keep a NEW
   *  tool from quietly starting a new backlog. It may only ever SHRINK — an entry that no longer
   *  applies must be deleted, which is asserted below. */
  const UNDOCUMENTED_PARAMS = new Set<string>([]);

  it('every parameter is documented — in its own .describe() or the tool description', () => {
    // The agent sees ONLY the schema and the description. An undocumented param is a param it
    // will either ignore or guess at, and guessing is how `modoki_set_selection {name:…}` (a
    // param that did not exist) silently CLEARED the selection instead.
    const missing: string[] = [];
    for (const name of s.names) {
      const entry = getTool(name)!;
      for (const [param, field] of Object.entries(entry.shape)) {
        const own = (field as { description?: string }).description;
        const mentioned = new RegExp(`\\b${param}\\b`).test(entry.description);
        if (!own && !mentioned) missing.push(`${name}.${param}`);
      }
    }
    // New offenders only — the known backlog is allowed until Phase 4 clears it.
    expect(missing.filter((m) => !UNDOCUMENTED_PARAMS.has(m))).toEqual([]);
    // And the backlog must only ever SHRINK: an entry that no longer applies has to be deleted,
    // so this list cannot rot into a permanent exemption.
    expect([...UNDOCUMENTED_PARAMS].filter((m) => !missing.includes(m)),
      'these are documented now — delete them from UNDOCUMENTED_PARAMS').toEqual([]);
  });

  it("an unknown key is refused with a message NAMING the tool's real parameters", () => {
    // §1 is not just "reject the key" — it is "reject it and say what the parameters ARE", because
    // a refusal that lists the options is what turns a dead end into the caller's next move (§5).
    // `registerAll.ts` builds that message; nothing asserted it until now, because the harness used
    // to re-derive its own message-less `.strict()` and every test saw zod's default instead.
    //
    // Asserted on the schema the tool was REGISTERED with — the one the MCP transport validates
    // against — so this cannot pass on a schema only the test builds.
    for (const name of s.names) {
      const schema = s.schemaFor(name) as z.ZodType | undefined;
      expect(schema, `${name} was registered with no inputSchema`).toBeDefined();
      const r = (schema as z.ZodType).safeParse({ definitely__not__a__param: 1 });
      expect(r.success, `${name} accepted an unknown key`).toBe(false);
      const message = r.success ? '' : r.error.issues.map((i) => i.message).join(' ');
      expect(message, `${name}'s refusal must name the tool`).toContain(name);
      const params = Object.keys(getTool(name)!.shape);
      // A no-parameter tool says so explicitly rather than trailing an empty list.
      if (!params.length) {
        expect(message, `${name} takes no params and must say so`).toContain('(no parameters)');
      } else {
        for (const p of params) {
          expect(message, `${name}'s refusal must offer '${p}'`).toContain(p);
        }
      }
    }
  });

  it('…and THAT check can fail (mutation-tested against the message-less form)', () => {
    // The exact schema the harness used to build. A guard never seen to fail is not known to work.
    const bare = z.object({ guid: z.string().optional() }).strict();
    const r = bare.safeParse({ nope: 1 });
    const message = r.success ? '' : r.error.issues.map((i) => i.message).join(' ');
    expect(message).not.toContain('modoki_');
  });

  /** Params whose meaning is inherently PER TOOL, so one shared wording would be wrong rather than
   *  tidy. Each entry is a claim that the name is a category, not a contract.
   *
   *  The bar is real: `path` on `validate_scene` is a scene, on `reimport_asset` an asset or a
   *  folder, on `anim_add_key` a name-path inside an Animator — the same word for three different
   *  addressing schemes, which §2 tolerates only because the TYPE of thing is stated every time.
   *  A param that means one thing everywhere does NOT belong here; it belongs in `shapes.ts`. */
  //
  // `force` was on this list as a recorded residual and is now GONE from it — the destructive half
  // was renamed to `discardUnsaved` (2026-08-22, owner), so the word means exactly one thing
  // everywhere it appears and the containment check polices it instead of an exemption. That is the
  // outcome an entry here should always be aiming at: the list is a holding pen, not a home.
  const PER_TOOL_MEANING = new Set([
    'path', 'action', 'type', 'name', 'kind', 'id', 'ids', 'key', 'keys', 'limit', 'all',
    'from', 'to', 'value', 'target', 'mode', 'clear', 'since', 'guid', 'guids',
    'width', 'height', 'quality', 'selector', 'button', 'steps', 'entity', 'panel',
    'timeoutMs', 'parentId', 'parentGuid', 'source', 'level', 'platform', 'provider', 'fields',
  ]);

  it('a param used by 3+ tools means ONE thing, or is declared per-tool', () => {
    // §2 ("a field or parameter name means the same thing in every tool that uses it") had a
    // testable half for RESPONSE field names and none at all for parameter descriptions — and the
    // audit measured the result: `precision` said the same thing four ways across seven tools, and
    // `allowOccluded` had five wordings despite `shapes.ts` exporting it as ONE constant expressly
    // so that could not happen. Nothing was individually wrong; the cost is that an agent must
    // re-read a param per tool to check it still means what it meant.
    //
    // Scoped to 3+ tools deliberately. Two tools sharing a word is a coincidence; three is a
    // convention, and a convention that drifts is the thing worth catching.
    const byParam = new Map<string, Map<string, string[]>>();
    for (const name of s.names) {
      for (const [param, field] of Object.entries(getTool(name)!.shape)) {
        const desc = (field as { description?: string }).description ?? '';
        const forParam = byParam.get(param) ?? new Map<string, string[]>();
        forParam.set(desc, [...(forParam.get(desc) ?? []), name]);
        byParam.set(param, forParam);
      }
    }
    // The rule is CONTAINMENT, not identity: the shortest wording is the shared base, and every
    // longer variant must contain it verbatim. That permits the thing good descriptions actually
    // do — state the shared rule, then add the tool-specific nuance after it (`modifiers` on
    // `modoki_drag` really does need to say the key is held for the whole gesture) — while still
    // failing when two tools state the SAME rule two ways, which is the drift §2 is about.
    // Mechanically it also forces the base into `shapes.ts`, since that is the only way to repeat
    // a long string verbatim without copying it.
    const drifted: string[] = [];
    for (const [param, byDesc] of byParam) {
      if (PER_TOOL_MEANING.has(param)) continue;
      const users = [...byDesc.values()].flat();
      if (users.length < 3 || byDesc.size === 1) continue;
      const descs = [...byDesc.keys()];
      const base = descs.reduce((a, b) => (a.length <= b.length ? a : b));
      const strayed = descs.filter((d) => !d.includes(base.replace(/\.$/, '')));
      if (strayed.length) {
        drifted.push(`${param}: ${strayed.length} of ${descs.length} wordings do not extend the shared base across ${users.length} tools (${users.join(', ')})`);
      }
    }
    expect(
      drifted,
      'these params state the same rule different ways. Put the shared wording in shapes.ts, and '
      + 'have a tool that needs more CONCATENATE onto it rather than replace it — or, if the '
      + 'meanings really differ, add the name to PER_TOOL_MEANING with that judgement.',
    ).toEqual([]);
  });

  it('the two halves are now two NAMES, and each still points at the other', () => {
    // The §2 fix, landed rather than mitigated. `force` used to mean "proceed, nothing is lost" on
    // the build family and "DESTROY the unsaved world" on the world-swapping tools, with the tool's
    // own name giving no clue which — so an agent that learned the harmless one from a build could
    // lose the human's work with it. Two meanings, two names now.
    //
    // The cross-references stay asserted even after the rename: a caller arriving with the old
    // habit has to be able to find where it went, and §1's strict refusal tells them the param is
    // unknown without telling them what to use instead.
    const destructive = ['modoki_load_scene', 'modoki_new_scene', 'modoki_prefab'];
    const harmless = ['modoki_build', 'modoki_add_native_target', 'modoki_ota_publish'];
    for (const name of destructive) {
      const shape = getTool(name)!.shape as Record<string, { description?: string }>;
      expect(shape.force, `${name} must no longer take \`force\``).toBeUndefined();
      const d = shape.discardUnsaved?.description ?? '';
      expect(d, `${name}.discardUnsaved must say it DESTROYS`).toMatch(/DESTRUCTIVE and IRREVERSIBLE/);
      expect(d, `${name} must name the old spelling, so the habit has somewhere to land`).toMatch(/used to be called `force`/);
    }
    for (const name of harmless) {
      const shape = getTool(name)!.shape as Record<string, { description?: string }>;
      expect(shape.discardUnsaved, `${name} destroys nothing and must NOT take discardUnsaved`).toBeUndefined();
      const d = shape.force?.description ?? '';
      expect(d, `${name}.force must say it is NOT destructive`).toMatch(/NON-DESTRUCTIVE/);
      expect(d, `${name}.force must name the other param`).toMatch(/discardUnsaved/);
    }
  });

  it('…and `force` now means ONE thing, so it needs no exemption', () => {
    // The durable win. While `force` sat in PER_TOOL_MEANING the guard was blind to it — which is
    // how the render_sequence violation survived to be found by hand. Assert the exemption is gone,
    // so re-adding it is a deliberate act rather than a quiet one.
    const descs = new Set(['modoki_build', 'modoki_add_native_target', 'modoki_ota_publish']
      .map((n) => (getTool(n)!.shape as Record<string, { description?: string }>).force?.description));
    expect(descs.size, '`force` must read identically wherever it survives').toBe(1);
  });

  it('PER_TOOL_MEANING names no param that has left the surface', () => {
    // Same rule as every other ledger here: a stale entry rots into a blanket exemption, and the
    // next genuine drift on that name lands on it unnoticed.
    const live = new Set(s.names.flatMap((n) => Object.keys(getTool(n)!.shape)));
    expect([...PER_TOOL_MEANING].filter((p) => !live.has(p)).sort(),
      'delete these — no tool takes them any more').toEqual([]);
  });

  it("a description never tells the caller to pass a param the tool does not have", () => {
    // Born from a real miss. Renaming `force` -> `discardUnsaved` left `modoki_load_scene` and
    // `modoki_new_scene` still saying "pass force:true" in their own descriptions — an instruction
    // that, post-§1, is now a REFUSAL. The tool tells the agent to do the one thing it will reject.
    //
    // That is worse than a stale doc: the description is what the model reads immediately before
    // choosing arguments, so it is the most load-bearing prose on the surface, and the refusal it
    // provokes reads as the agent's mistake. §11 already requires a documented DEFAULT to match the
    // code; this is the same rule for a documented PARAM.
    //
    // Deliberately narrow — the literal "pass X:true" instruction, not every mention of a word.
    // A description legitimately names other tools' params ("call modoki_save_all first"), so a
    // broad scan would drown in false positives and get relaxed into uselessness. One precise
    // pattern that cannot be argued with beats a fuzzy one nobody trusts.
    const offenders: string[] = [];
    for (const name of s.names) {
      const entry = getTool(name)!;
      const params = new Set(Object.keys(entry.shape));
      for (const m of entry.description.matchAll(/pass\s+`?(\w+)`?\s*:\s*true/gi)) {
        if (!params.has(m[1])) {
          offenders.push(`${name}: says "pass ${m[1]}:true" but accepts [${[...params].join(', ')}]`);
        }
      }
    }
    expect(offenders, 'a description instructs the caller to pass a param that would be REFUSED').toEqual([]);
  });

  it('every NON-ENUM param carries its own .describe()', () => {
    // The stricter half of §11. The check above accepts a param as documented when its NAME appears
    // anywhere in the tool description, and that word-boundary heuristic produces real false passes:
    // `modoki_reparent_entity.sortOrder` was "documented" by the phrase "optionally setting
    // sortOrder" and said nothing about basis, unit, or what omitting it does.
    //
    // Enums are exempt because they genuinely self-document — the allowed values reach the client
    // in the advertised JSON Schema, so `mode: z.enum(['3d','ui'])` tells an agent everything the
    // type can. Nothing else does.
    const missing: string[] = [];
    for (const name of s.names) {
      for (const [param, field] of Object.entries(getTool(name)!.shape)) {
        if ((field as { description?: string }).description) continue;
        let def = (field as { _def?: Record<string, unknown> })._def;
        while (def && (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable' || def.typeName === 'ZodDefault')) {
          def = (def.innerType as { _def?: Record<string, unknown> } | undefined)?._def;
        }
        if (def?.typeName === 'ZodEnum' || def?.typeName === 'ZodNativeEnum') continue;
        missing.push(`${name}.${param}`);
      }
    }
    expect(missing, 'these need their own .describe() — only an enum self-documents').toEqual([]);
  });

  /** The tools that accept BOTH entity-addressing shapes (owner decision, 2026-08-22).
   *
   *  Scoped to the SINGULAR-AIM tools — the ones whose operation is "address one entity". The
   *  array/filter tools (`get_scene_state`, `get_layout_bounds`, `watch`, `delete_entities`,
   *  `set_selection`) take SETS, not an aim, so a singular `entity:{…}` would not fit and adding it
   *  would invent a third shape rather than remove the second. */
  const DUAL_ADDRESSED = ['modoki_duplicate_entity', 'modoki_focus_entity', 'modoki_play_clip'];

  it('a singular-aim tool accepts the nested `entity` ref as well as the flat one', async () => {
    // `qa/knowledge.md` records the flat-vs-nested mix-up as a recurring trap: five tools nest and
    // ten are flat, with a latent rule that holds only loosely. Post-§1 the wrong shape is a loud
    // refusal rather than a wrong answer, but it costs a round-trip EVERY time — so §0's "an
    // inconsistency costs a guess" says remove the guess, not document it.
    for (const name of DUAL_ADDRESSED) {
      const shape = getTool(name)!.shape as Record<string, unknown>;
      expect(shape.entity, `${name} must accept a nested entity ref`).toBeDefined();
      expect(Object.keys(shape), `${name} must keep its flat form too`).toContain('guid');
    }
  });

  it('…and REFUSES both at once rather than picking one', async () => {
    // A caller who sent two addresses does not know which the tool uses, and choosing for them is
    // the silent-wrong-target class §0 ranks first.
    const s2 = loadSurface();
    try {
      const r = await s2.call('modoki_focus_entity', { guid: 'g-1', entity: { guid: 'g-2' } });
      expect(r.isError, 'two addresses must be refused').toBe(true);
      expect(s2.text(r)).toMatch(/both `entity` and the flat/);
      expect(s2.text(r)).toMatch(/AMBIGUOUS/);
      // …and nothing was dispatched.
      expect(s2.requests.some((q) => q.path.startsWith('/api/editor-action')), 'must refuse BEFORE acting').toBe(false);
    } finally { s2.restore(); }
  });

  it('the nested `entity` alias is STRICT and carries no `name`', async () => {
    // Close-out finding, confirmed against the ops. `duplicate-entity`/`focus-entity` resolve
    // through `requireLiveId({id?, guid?})` and have no name resolver, so advertising `name` here
    // would be a capability that does not exist — and because a nested `z.object` is NOT strict
    // just because its parent is, zod would STRIP the key: `entity:{name:'Crate'}` arrives as `{}`,
    // folds to the empty flat ref, and comes back as "entity ref matched no live entity — it may be
    // stale". A §0 rank-4 unclear failure pointing at the wrong cause, which is the §1 silent-strip
    // bug one level down.
    for (const name of DUAL_ADDRESSED) {
      const s2 = loadSurface();
      try {
        await expect(s2.call(name, { entity: { name: 'Crate' } })).rejects.toThrow(/accepts only: guid, id/);
        // …and nothing was dispatched on the way to that refusal.
        expect(s2.requests.some((q) => q.path.startsWith('/api/editor-action'))).toBe(false);
      } finally { s2.restore(); }
    }
  });

  it('the alias folds `id: 0` — the ROOT entity — rather than reading it as "no address"', async () => {
    // `foldEntityRef` filters the flat side on `!== undefined`, not truthiness. Under a truthiness
    // test `{id: 0}` reads as absent, so a caller passing BOTH `id:0` and an `entity` would get the
    // entity silently instead of the conflict refusal — picking a target for them, which is the
    // class §0 ranks first.
    const s2 = loadSurface();
    try {
      const r = await s2.call('modoki_focus_entity', { id: 0, entity: { guid: 'g-1' } });
      expect(r.isError, 'id:0 is a real address and must still conflict').toBe(true);
      expect(s2.text(r)).toMatch(/both `entity` and the flat id/);
    } finally { s2.restore(); }
  });

  /** The definition surface's own size, PINNED (owner decision: pin, do not cap).
   *
   *  §6 budgets RESPONSES and nothing budgets the definitions, which are what an agent pays for
   *  before it makes a single call. Measured at the time of writing: ~123 KB of `modoki_*`
   *  descriptions + param descriptions, ~31k tokens, resident every session.
   *
   *  This is deliberately NOT a cap. A description that earns its length should never be blocked —
   *  §11 is right that it is read far more often than the conventions doc, and the long ones here
   *  have demonstrably prevented wrong answers. What it does is make growth a DELIBERATE, reviewable
   *  act: exceed the headroom and the build fails until someone raises the number knowingly, the
   *  same shape as every other ledger in this suite. */
  //
  // MEASURED, not estimated. The first version of this pin was 134_000 against an actual 124_262 —
  // 18% of slack, which would have let ~8 new tools land without ever firing, i.e. exactly the
  // growth it claims to catch. A pin set above the real number is not a pin. Re-measure when you
  // raise it: `bytes` below is the number to use.
  // Re-measured 2026-08-27 (#367, +modoki_game_view_device/_devices and get_editor_state's
  // `gameView` line). The two new tools account for ~2.3 KB of the ~4.9 KB jump — the rest was
  // growth that had accumulated INSIDE the old headroom without ever re-pinning, which is the
  // drift this ledger exists to surface. Re-measure on every raise, do not add to the old value.
  // Re-measured 2026-08-27 again (#369, +modoki_animation_view_mode, get_editor_state's
  // `animationViewMode` line, and the mounted-view note on modoki_handles' `editor` param):
  // 129_199 -> 131_156, all of it that change. Then 131_156 -> 132_278 in the same issue's
  // close-out: the review found the shipped descriptions named the VIEW as the whole precondition
  // for tangent handles when an active track is a second gate, so three descriptions had to say
  // so. Spent deliberately — a description that sends an agent to a confident wrong conclusion
  // costs more than its bytes.
  const DEFINITION_BYTES = 132_278;
  const DEFINITION_HEADROOM = 4_000;

  it(`the tool definitions stay near their recorded size (~${Math.round(DEFINITION_BYTES / 1000)} KB)`, () => {
    let bytes = 0;
    for (const name of s.names) {
      const entry = getTool(name)!;
      bytes += entry.description.length;
      for (const [param, field] of Object.entries(entry.shape)) {
        bytes += param.length + ((field as { description?: string }).description?.length ?? 0);
      }
    }
    const ceiling = DEFINITION_BYTES + DEFINITION_HEADROOM;
    expect(
      bytes,
      `the tool surface is now ${bytes} bytes (~${Math.round(bytes / 4000)}k tokens), past the recorded `
      + `${DEFINITION_BYTES} + ${DEFINITION_HEADROOM} headroom. This is not a cap — if the growth is `
      + 'earned, raise DEFINITION_BYTES and say so. It exists so the surface cannot grow a few '
      + 'hundred bytes per change without anyone deciding to spend it.',
    ).toBeLessThanOrEqual(ceiling);
    // A floor too: a refactor that accidentally strips descriptions would otherwise pass silently,
    // and losing them is the more damaging direction.
    expect(bytes, 'the surface SHRANK sharply — descriptions lost?').toBeGreaterThan(DEFINITION_BYTES - 8_000);
  });

  it('every tool validates its args against its own real schema', () => {
    // This is what `modoki_batch` relies on: a step is re-parsed against `z.object(shape)`
    // server-side. A shape that is not zod-parseable would make that validation silently
    // permissive for that one tool.
    for (const name of s.names) {
      expect(() => z.object(getTool(name)!.shape), name).not.toThrow();
    }
  });
});

describe('source guards that cannot be expressed as assertions', () => {
  it('registration happens in exactly ONE place, and never via the legacy overload', () => {
    // Two invariants in one:
    //
    // (1) A registration outside the definer is invisible to the registry, so `modoki_batch`
    //     reports the tool as nonexistent while a direct call works. `toolDef.ts` makes that
    //     structurally unreachable from a group module (they receive a `ToolDef`, never the
    //     server); this pins the one legitimate site.
    // (2) It must be `server.registerTool(name, {inputSchema}, cb)`, NOT `server.tool(...)`. The
    //     legacy overload shape-sniffs its arguments and REJECTS a ZodObject outright, so it
    //     cannot carry the strict schema that conventions §1 requires — reverting to it would
    //     silently restore the "typo becomes a different operation" bug.
    const codeOf = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const registerSites = allSrcFiles().filter((f) => /server\.registerTool\(/.test(codeOf(f)));
    expect(registerSites).toEqual(['registerAll.ts']);
    const legacy = allSrcFiles().filter((f) => /\bserver\.tool\(/.test(codeOf(f)));
    expect(legacy, 'server.tool() cannot carry a strict schema — see conventions §1').toEqual([]);
  });

  it('every tool reaches validation as a STRICT schema', () => {
    // The behavioural half of §1, asserted on what was actually handed to the server rather than
    // on the source text. `set_selection {name:'Capsule'}` — a param that does not exist — used to
    // parse to `{}`, which that tool documents as "no refs = clear", so it CLEARED the human's
    // selection and reported success. Verified end-to-end over real MCP; pinned here.
    const s2 = loadSurface();
    try {
      for (const name of s2.names) {
        const schema = s2.schemaFor(name) as { _def?: { unknownKeys?: string } } | undefined;
        expect(schema, `${name} was registered without an inputSchema`).toBeDefined();
        expect(schema!._def?.unknownKeys, `${name} must reject unknown keys`).toBe('strict');
      }
    } finally { s2.restore(); }
  });

  it('no tool module reads process.env or starts a transport', () => {
    // The whole point of the split: `index.ts` is the ONLY module with side effects. A group that
    // reads the environment cannot be pointed at a stub backend, and the surface becomes
    // untestable again by degrees.
    for (const f of toolModules().concat('context.ts', 'shapes.ts', 'registerAll.ts')) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${f} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${f} must not connect a transport`).not.toMatch(/StdioServerTransport|\.connect\(/);
    }
  });

  it('the active-scene default reads scenePathRef, NOT scenePath, in ONE place', () => {
    // `scenePath` is Vite's /@fs/<abs> URL, which /api/scene-mutate 403s. Using it made
    // set_transform's documented `path` default fail on every call — and no test caught it
    // because every test passed an explicit `path`. It lives in `activeScenePath` so a second
    // scene-editing tool cannot re-derive it wrong.
    const src = read('tools/scene.ts');
    const helper = src.slice(src.indexOf('/** Resolve the scene an edit should apply to'), src.indexOf('// ── mutate_scene'));
    expect(helper).toContain('scenePathRef');
    expect(helper).not.toMatch(/\}\s*\)\.scenePath\b/); // no falling back to the raw /@fs field
    expect(src.replace(helper, '')).not.toContain('scenePathRef');
  });

  it("editorAction cannot have its routing `action` clobbered by a params key", () => {
    // `{ action, ...params }` let a tool's own `action` argument replace the OP NAME. Not
    // hypothetical: `modoki_prefab` spread its args (which include `action:'instantiate'`) over
    // this, so every prefab call sent 'instantiate' as the op name and got a 400 listing the
    // valid ops — all three prefab actions were dead through the MCP. Spread FIRST, routing key
    // last. (Also asserted behaviourally in `mcpToolContracts.test.ts`.)
    const fn = read('context.ts');
    expect(fn).toContain('{ ...params, action }');
    expect(fn).not.toContain('{ action, ...params }');
  });

  it('no tool spreads an `action`-bearing arg object into editorAction', () => {
    // The other half: /api/editor-action STRIPS `action` before relaying, so a param by that name
    // is structurally unreachable through it — a tool that needs one must rename it on the wire
    // (prefab uses `prefabAction`). Catch a new tool repeating the mistake.
    const src = read('tools/editor.ts');
    const prefab = src.slice(src.indexOf("'modoki_prefab'"), src.indexOf('// ── gizmo / focus'));
    expect(prefab).toContain('prefabAction: action');
    expect(prefab).not.toMatch(/editorAction\('prefab', p\)/);
  });

  it('every scene-EDITING tool defaults its path to the active scene', () => {
    // The ergonomic form is the one that gets used, so a required `path` is a usability bug, not
    // a style choice: `mutate_scene` is the batchable authoring route (a batch cannot read a
    // response to discover a path), and it required one until 2026-07-30. `validate_scene` /
    // `load_scene` are excluded on purpose — naming a specific file IS the call.
    const src = read('tools/scene.ts');
    for (const name of ['modoki_mutate_scene', 'modoki_set_transform']) {
      const start = src.indexOf(`'${name}'`);
      const fn = src.slice(start, src.indexOf('\n  );', start));
      expect(fn, `${name} must accept an omitted path`).toMatch(/path: z\.string\(\)\.optional\(\)/);
      expect(fn, `${name} must resolve it via activeScenePath`).toContain('activeScenePath(path');
    }
  });
});

describe('zod resolution (issue #23)', () => {
  /** This file must build its schemas with the SAME zod the MCP server runs, which is why its
   *  import reaches into `tools/modoki-mcp/node_modules/zod` instead of writing `from 'zod'`.
   *
   *  The bare specifier is a trap here: the root package.json does not depend on zod at all, so
   *  it resolves to whatever the hoist happens to put at the root — today v4, pulled in
   *  transitively by eslint-plugin-react-hooks -> zod-validation-error — while modoki-mcp pins
   *  ^3.23.8 and installs its own v3. Under the bare import this suite built v4 schemas and then
   *  validated them with the same v4 `z`: internally consistent, green, and proving nothing
   *  about the v3 semantics `modoki_batch` actually validates steps against. Nothing about the
   *  failure is visible at runtime — it only surfaced once the tests became typechecked and the
   *  two structurally different ZodTypes stopped satisfying each other.
   *
   *  A version bump that aligned the two would make the bare import harmless again, but it would
   *  also make it silently re-breakable on the next drift, so the guard stays either way. */
  it('uses the MCP server\'s own zod, not whatever is hoisted to the repo root', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpRegistry.test.ts'),
      'utf8',
    );
    expect(src, 'import zod from tools/modoki-mcp/node_modules, not a bare specifier')
      .not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'zod';$/m);

    const mcpZod = JSON.parse(
      fs.readFileSync(path.resolve(SRC, '../node_modules/zod/package.json'), 'utf8'),
    ) as { version: string };
    const isV3 = mcpZod.version.startsWith('3.');
    expect(isV3, `modoki-mcp resolved zod ${mcpZod.version}; update this guard if it moved to v4`).toBe(true);
    // `z` is the module object this file ACTUALLY imported — the check that would fail if the
    // import above regressed to a bare specifier. Discriminate on exports unique to each major:
    // v4 added `core`/`globalRegistry`, v3 has the `ParseStatus`/`addIssueToContext` internals it
    // dropped. (Not `ZodFirstPartyTypeKind` — that exists in BOTH, so asserting on it would pass
    // vacuously and guard nothing.)
    expect('ParseStatus' in z, 'imported zod is not the v3 copy modoki-mcp runs').toBe(true);
    expect('core' in z, 'imported zod looks like v4 — the bare-specifier hoist is back').toBe(false);
  });
});
