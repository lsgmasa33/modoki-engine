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
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
// Deliberately the MCP SERVER'S OWN zod, not a bare `from 'zod'`. The root package.json does
// not depend on zod at all — a bare specifier resolves to zod v4, hoisted in transitively by
// eslint-plugin-react-hooks → zod-validation-error, while modoki-mcp pins ^3.23.8 and installs
// its own v3 copy. So the bare import had this test building v4 schemas and handing them to a
// v3-typed registry: it passed only because the test validated its own v4 schema with the same
// v4 `z`, proving nothing about the v3 semantics `modoki_batch` actually runs against. Surfaced
// by issue #23 (TS2740 — two structurally different ZodType implementations).
import { z } from '../../tools/modoki-mcp/node_modules/zod';
// Same reasoning as the zod import above: the MCP package's OWN copy, not whatever the repo root
// hoists (or lacks). Used only by the definition-surface ledger (#456) to walk NESTED schemas.
import { zodToJsonSchema } from '../../tools/modoki-mcp/node_modules/zod-to-json-schema';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, calledNames, callsTo, declarationOf, enclosingNamedFunction, findNodes, flatText, functionsNamed, importsIn, parseSource,
  printedText, propertyValue, stringValueOf, ts, unwrapValue,
} from '@modoki/engine/testing/sourceAst';
import {
  registerTool,
  getTool,
  toolNames,
  toolCount,
  clearRegistry,
} from '../../tools/modoki-mcp/src/registry';
import { PER_TOOL_MEANING } from './perToolMeaning';
import { loadSurface, sumSchemaBytes, type Surface } from './mcpSurface';
import { perToolBytes, surfaceBytes, toolBytes } from '../../tools/modoki-mcp/surfaceBytes';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp/src');
/** One read (#812). Every assertion in this file is about CODE, so nothing here wants `.raw`. */
const scan = (rel: string) => readScannedSource(path.join(SRC, rel));
/** Every module that defines tools, plus the registration seam. */
const toolModules = () =>
  fs.readdirSync(path.join(SRC, 'tools')).filter((f) => f.endsWith('.ts')).map((f) => `tools/${f}`);
/** Every hand-written module, discovered rather than listed — a new sibling of `context.ts` must
 *  not escape these guards just because nobody remembered to add it here. */
const allSrcFiles = () =>
  fs.readdirSync(SRC).filter((f) => f.endsWith('.ts')).concat(toolModules());

const okResult = { content: [{ type: 'text' as const, text: '{}' }] };

/** A module's source, comments stripped via the shared scanner (@modoki/engine/testing, #419) —
 *  the lazy-regex stripper this replaced could delete real code hiding behind a `/*`-shaped line
 *  comment. */
const codeOf = (f: string): string => scan(f).code;

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
    expect(codeOf('registry.ts')).not.toContain('@modelcontextprotocol');
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

  // Claude Code advertises this whole surface DEFERRED — names only, schemas fetched on demand —
  // so the tool NAME is the entire interface at pick time and the only thing that can say "this
  // writes". #483 renamed three view-mode tools to `set_*` for that reason; a later sweep found
  // two more sitting on `set-*` ops without the prefix (the gizmo-mode and collider-edit-mode
  // setters), which is why this is a guard now instead of prose: the discriminator is the
  // backend OP, so a new `set-*` op cannot ship under a non-`set_` name.
  // Deliberate exemptions, so a reader does not "fix" them: the `asset`-kind family
  // (`modoki_particle_set`, `modoki_timeline_set`, `modoki_anim_set_clip`) is subject-first by
  // design so siblings sort together, and its names match their ops exactly;
  // `modoki_select_sprite_slice` is a genuine `select-` verb, not a setter.
  /** #1137 — `modoki_history` told the agent "selection changes are not [undoable]". They are.
   *
   *  `pushSelectionChange` puts its own `Select …` entry on the stack for every UI-GESTURE
   *  selection (a Hierarchy or Assets click, so `modoki_tap` too). Observed live: after undoing a
   *  create, `undoLabel` read "Select entity". An agent that believed the description, selected,
   *  edited and then undid ONCE popped the selection and left its edit applied — while `did:true`
   *  reported success.
   *
   *  ⚠️ This guards the RESTATEMENT, not the mechanism. The mechanism is pinned in
   *  `packages/modoki/tests/editor/undoManager.test.ts` § getEditVersion, which asserts the exact
   *  divergence: a selection push bumps `getUndoVersion` (the stack moved) and leaves
   *  `getEditVersion` alone (no world edit). That divergence is also the whole of #1142 — the same
   *  two counters, read by the dnd commit probe — so if it ever collapses, BOTH those suites go
   *  red and this one stops being the interesting failure. What this catches is the agent-facing
   *  COPY of the fact drifting back to the false version, which no behavioural test can see. */
  it('modoki_history does not tell the agent selection is off the undo stack (#1137)', () => {
    const desc = s.descriptionOf('modoki_history');
    expect(desc, 'the false claim is back').not.toMatch(/selection changes are not/i);
    expect(desc, 'it must still SAY something about selection — silence just moves the trap').toMatch(/selection/i);
    expect(desc, 'and name the field to steer by, since counting undos is what breaks').toMatch(/undoLabel/);
    // The sibling that already had it right, and the reason this is one correction rather than
    // two: `modoki_set_selection` writes selection RAW (`setSelectionRaw`) and genuinely pushes
    // nothing. The two descriptions must not disagree about the same stack.
    expect(s.descriptionOf('modoki_set_selection'), 'the accurate sibling drifted instead')
      .toMatch(/does NOT push an undo entry/i);
  });

  it('a tool whose backend op is `set-*` is NAMED `modoki_set_*`', () => {
    const offenders = Object.entries(CONTRACTS)
      .filter(([name, c]) => typeof c.op === 'string' && c.op.startsWith('set-') && !name.startsWith('modoki_set_'))
      .map(([name, c]) => `${name} (op ${c.op})`);
    expect(offenders).toEqual([]);
  });

  /* ⚠️ **No `UNDOCUMENTED_PARAMS` backlog (#1140).** It held 25 entries across 21 tools when this guard
   *  was written (2026-07-30), Phase 4 of the MCP audit emptied it the same day, and the empty list
   *  is deleted: a new undocumented param is fixed, not ledgered. */

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
    expect(missing).toEqual([]);
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
  // ⚠️ 36 → 23 in #1140: putting this list on the ledger as `sanctioned` found thirteen names whose
  // descriptions no longer drift (or that fewer than three tools take) — fields, height, keys, level,
  // mode, panel, platform, provider, source, target, timeoutMs, value, width. Each was a pardon for a
  // convention that had already converged, i.e. a blind spot waiting for its next drift. (`action`
  // and `type` were first counted among them too, but only because an undescribed param's `''` was
  // taken as the shared base — see the comparison below. Both are per-tool enums, 10 and 8 wordings.)
  // ⚠️ #1266 took ONE meaning off `name` and it still belongs here — the entry is narrower, not gone.
  // The five `open_*_editor` tools spelled an asset DISPLAY LABEL `name`, which was never the
  // category this entry pardons: every other `name` is *the name of the thing the tool addresses*
  // (an entity to filter, a trait to describe, an action to dispatch, an asset to match), with the
  // type stated each time — `path`'s pattern exactly. A label you ASSIGN is a different job, so it
  // became `displayName` rather than being excused here. Four addressing meanings remain, so the
  // containment check still cannot police this word; do not read the rename as clearing it.
  // The list itself lives in `perToolMeaning.ts` since #1559: the device surface runs the same check
  // (`deviceToolSurface.test.ts`), and one pardon list is what keeps the two from judging a word differently.

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
    const drifted: Array<{ item: string; site: string }> = [];
    for (const [param, byDesc] of byParam) {
      // ⚠️ An EMPTY `.describe()` is not a wording (#1140 close-out): such a param is documented in
      // its tool's description instead (the check above allows that), and as the shortest string it
      // became the "shared base" every other wording trivially contains — `action` read as converged
      // across 11 tools with 11 different wordings. Compare only the wordings that exist.
      const described = [...byDesc].filter(([d]) => d !== '');
      const users = described.flatMap(([, tools]) => tools);
      if (users.length < 3 || described.length === 1) continue;
      const descs = described.map(([d]) => d);
      const base = descs.reduce((a, b) => (a.length <= b.length ? a : b));
      const strayed = descs.filter((d) => !d.includes(base.replace(/\.$/, '')));
      if (strayed.length) {
        drifted.push({ item: param, site: `${param}: ${strayed.length} of ${descs.length} wordings do not extend the shared base across ${users.length} tools (${users.join(', ')})` });
      }
    }
    // ⚠️ Spent through the shared ledger since #1140: PER_TOOL_MEANING is `sanctioned` (a per-NAME
    // judgement that the word means different things per tool), so a name whose descriptions have
    // since CONVERGED — the `force` outcome above, the one this list should always aim at — reddens
    // instead of keeping a pardon that would hide its next drift. The old staleness check asked only
    // that some tool still took the param.
    assertExemptionLedger({
      label: 'PER_TOOL_MEANING in mcpRegistry',
      population: drifted,
      sanctioned: PER_TOOL_MEANING,
      floor: 1,
      fix: 'these params state the same rule different ways. Put the shared wording in shapes.ts, and '
        + 'have a tool that needs more CONCATENATE onto it rather than replace it — or, if the '
        + 'meanings really differ, add the name to PER_TOOL_MEANING with that judgement.',
    });
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
    // Both lists grew with #872/#882's park gate, and the split is the whole point of the rule:
    // `write_asset_meta` REPLACES the sidecar, so a parked Inspector edit is destroyed — the
    // destructive name. `reimport_asset`/`duplicate_asset` only READ the file, so the human's edit
    // survives and merely goes unused — the harmless one. Putting either on the wrong list is the
    // exact habit-transfer this pair of names exists to prevent.
    const destructive = ['modoki_load_scene', 'modoki_new_scene', 'modoki_prefab', 'modoki_write_asset_meta'];
    const harmless = ['modoki_build', 'modoki_add_native_target', 'modoki_ota_publish',
      'modoki_reimport_asset', 'modoki_duplicate_asset'];
    for (const name of destructive) {
      const shape = getTool(name)!.shape as Record<string, { description?: string }>;
      expect(shape.force, `${name} must no longer take \`force\``).toBeUndefined();
      const d = shape.discardUnsaved?.description ?? '';
      expect(d, `${name}.discardUnsaved must say it DESTROYS`).toMatch(/DESTRUCTIVE and IRREVERSIBLE/);
      // Present tense since #1555 — a pointer at the other name, not the history of the rename.
      expect(d, `${name} must name \`force\`, so the habit has somewhere to land`).toMatch(/Not `force`: that is the NON-destructive flag/);
    }
    for (const name of harmless) {
      const shape = getTool(name)!.shape as Record<string, { description?: string }>;
      expect(shape.discardUnsaved, `${name} destroys nothing and must NOT take discardUnsaved`).toBeUndefined();
      const d = shape.force?.description ?? '';
      expect(d, `${name}.force must say it is NOT destructive`).toMatch(/NON-DESTRUCTIVE/);
      expect(d, `${name}.force must name the other param`).toMatch(/discardUnsaved/);
    }
  });

  it('discardUnsaved never claims to destroy work the operation does not touch (#872 review)', () => {
    // The reword for `modoki_write_asset_meta` widened the base from "unsaved LIVE-WORLD changes"
    // to "unsaved work the editor holds" — and `hasUnsavedChanges()` counts a parked .meta.json
    // edit, which `modoki_load_scene {discardUnsaved:true}` does NOT clear (nothing outside
    // pendingMeta.ts calls clearPendingMeta). So the param claimed a destruction that does not
    // happen, on the one surface whose rule is "never told a wrong thing" — and an agent could
    // read it as a way to clear a pendingImportSettings refusal, which it is not.
    const d = (getTool('modoki_load_scene')!.shape as Record<string, { description?: string }>).discardUnsaved?.description ?? '';
    expect(d, 'must scope the destruction to what this operation replaces').toMatch(/only what THIS operation/i);
    expect(d, 'must say a world swap leaves a parked import-settings edit alone').toMatch(/import-settings edit untouched/i);
  });

  it('…and `force` now means ONE thing, so it needs no exemption', () => {
    // The durable win. While `force` sat in PER_TOOL_MEANING the guard was blind to it — which is
    // how the render_sequence violation survived to be found by hand. Assert the exemption is gone,
    // so re-adding it is a deliberate act rather than a quiet one.
    const descs = new Set(['modoki_build', 'modoki_add_native_target', 'modoki_ota_publish',
      'modoki_reimport_asset', 'modoki_duplicate_asset']
      .map((n) => (getTool(n)!.shape as Record<string, { description?: string }>).force?.description));
    expect(descs.size, '`force` must read identically wherever it survives').toBe(1);
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
        // `guid, id` on duplicate/focus, `guid` alone on play_clip (its op has no id resolver, #1545).
        await expect(s2.call(name, { entity: { name: 'Crate' } })).rejects.toThrow(/unrecognized key 'name' — an entity ref here accepts only: guid(, id)?(?![\w,])/);
        // …and nothing was dispatched on the way to that refusal.
        expect(s2.requests.some((q) => q.path.startsWith('/api/editor-action'))).toBe(false);
      } finally { s2.restore(); }
    }
  });

  // #1223: an empty flat `guid` is ABSENT, as in the live resolver, so it does not conflict with a nested
  // ref. Mutation: in foldEntityRef, filter the flat side on `!== undefined` alone.
  it('an EMPTY flat guid beside a nested entity is one address, not a conflict', async () => {
    const s2 = loadSurface();
    try {
      const r = await s2.call('modoki_focus_entity', { guid: '', entity: { guid: 'g-1' } });
      expect(s2.text(r)).not.toMatch(/both `entity` and the flat/);
      const sent = s2.requests.find((q) => q.path.startsWith('/api/editor-action'));
      expect(sent?.body).toMatchObject({ guid: 'g-1' });
    } finally { s2.restore(); }
  });

  // #1223: the other two nested entity refs were NOT strict, so a typo'd key was stripped and the call
  // went out with an empty or partial ref. Mutation: drop `.strict(…)` from makeEntitySpec / set_transform's entity.
  it('the aimed-input `entity` and set_transform `entity` are STRICT too', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['modoki_tap', { entity: { guid: 'g-1', surfce: 'game-3d' } }, /accepts only: guid, name, id, surface, allowOccluded/],
      ['modoki_set_transform', { entity: { gid: 'g-1' }, space: 'local', position: [1, 2, 3] }, /accepts only: guid, name, id/],
    ];
    for (const [name, args, why] of cases) {
      const s2 = loadSurface();
      try {
        await expect(s2.call(name, args), name).rejects.toThrow(why);
        expect(s2.requests.filter((q) => !q.path.startsWith('/api/identity') && !q.path.startsWith('/api/editor-state')), `${name} must refuse BEFORE acting`).toEqual([]);
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
  // Re-measured 2026-08-30 (#438, round 4 fixes): 132_278 -> 136_731. CORRECTED (round 5): this
  // change's own contribution, measured directly (pre-change surface 136_238, post-change
  // 136_731), was 493 bytes — the round-4 comment's original "~200-250 bytes" estimate was never
  // actually measured against the pre-change number and undercounted it. The remaining ~4.0 KB
  // (136_238 - 132_278 = 3_960, not the "~4.2 KB" the round-4 comment claimed) is pre-existing
  // drift that had accumulated inside the old 4_000-byte headroom across unrelated work since the
  // last re-pin, never re-measured until now — not attributable to #438.
  // Re-measured again 2026-08-30 (#438, round 5 — this round's OWN defect-2/3 fixes): 136_731 ->
  // 136_741, all 10 bytes of it this round's rewording of the mid-swap-refusal justification on
  // `modoki_write_player_prefs`'s description (runtime.ts) — flush is no longer exempt, so the
  // text describing the refusal changed shape but stayed roughly the same length. No new
  // un-repinned drift since the round-4 re-pin above.
  //
  // 2026-08-31 (#456): the count above only ever summed TOP-LEVEL param descriptions — it never
  // descended into a nested object param (`entity`, `from`, `to`), so every byte of prose living
  // INSIDE those sub-shapes was invisible to this ledger. Same shape as the recorded lesson in
  // 2005ab324 ("a diff gate is blind in whichever direction its loop does not iterate"): a pin
  // that cannot see where the growth concentrates cannot catch it. Measured 15,527 bytes of
  // pin-blind nested prose, concentrated almost entirely in the aim tools' `entity` param — which
  // is exactly where issue #456's duplication lived. The fix serializes each tool's shape with
  // `zodToJsonSchema` and recursively sums EVERY `description` string plus every property name in
  // the result, so a `.describe()` nested at any depth is counted.
  //
  // That change alone made the measured number JUMP even though the surface got smaller: nested
  // prose (and nested property names) that was always there, inside `entity`/`from`/`to` sub-
  // objects, is now counted for the first time — on top of the same trim from #456 (removing
  // ~7 KB of duplicated aim-tool prose, moved to docs/debug-tools-mcp.md § Aiming). Old
  // (top-level-only) count: 132_278. New (recursive) count after the #456 trim: 143_859. Do not
  // read the jump as growth — measure with `DEFINITION_HEADROOM` set deeply negative to read the
  // real number off the failure message before ever re-pinning.
  // Merged into main 2026-08-31: combines #438 round 5's 10-byte wording change with #456's
  // recursive-sum switch and trim. Re-ran the pin test post-merge — 143_859 + the 4_000 headroom
  // still covers the combined surface, so the number did not need bumping again.
  // Re-pinned on main 2026-09-07 (143_859 → 147_889, +4_030) after merging work-ai/work-ai2/
  // work-ai3/work-qa. THE UNION is what broke it: every branch was green alone and the merged
  // surface landed 30 bytes past the ceiling, so no single close-out could have seen this — the
  // hub is the only place this is measurable. The growth is EARNED and is nearly all hazard
  // documentation the agent has to read to avoid destroying a human's work: `modoki_write_asset_meta`
  // now spells out the #845/#872 park-clobber (a write lands on disk, the park survives it, and the
  // next save_all flushes the older document over it — both directions lose work), `get_asset_meta`
  // documents its `source: parked|disk` answer, and `new_scene`/`load_scene` document #853's
  // prefab-edit refusal and that discardUnsaved does NOT bypass it. Spent deliberately: ~1k tokens
  // on every agent session's tool surface, to close two silent data-loss paths.
  // Re-pinned on work-ai 2026-09-07 (147_889 → 152_065). ⚠️ Read the SPLIT before treating this as
  // one change's cost: ~3.7k of the gap was already on HEAD, inside the headroom and therefore
  // invisible — the guard was 325 bytes from red before #884 touched anything. Only ~500 bytes are
  // this change's, and they are spent on the one thing an agent cannot recover from: what
  // `modoki_delete_asset`'s verdicts MEAN (ok:false = nothing went; ok:true + `failed` = the rest
  // went; `failed` is win32-only, so an empty one proves nothing), and that `repairFailed` on
  // delete/move leaves an attached editor holding a dead path — the #186 resurrection, which the
  // panel repairs for a human and nobody repairs for an agent.
  // ⚠️ The union hazard from the 2026-09-07 note below has NOT gone away: this number was measured
  // on one branch, and the hub may still land past it after merging the others.
  // 2026-09-13 (#1152/#1153, work-qa): RE-PINNED to 157,944 — measured, not estimated. The merge
  // base already priced 155,174 (3,109 over the old pin, inside the headroom), and this change adds
  // 2,770: the `label`/`within` aim on six input tools (seven schema sites, drag's from/to included),
  // `prefix`/`label` on modoki_handles, and one sentence each telling modoki_tap and modoki_handles
  // readers that chrome is now aimable by label and readable without modoki_eval — the ~1,900 evals
  // #1152/#1153 measured are the spend this buys back. The param wording was trimmed once before
  // pinning (158,364 → 157,776); the close-out then named label/entity in the x/y descriptions (+168).
  // 2026-09-14 (#1208 phase 4, work-qa): RE-PINNED to 162,505 — measured. The merge base already
  // priced 161,610 (3,666 over the old pin, inside the headroom, arriving through the 2026-09-14
  // merges), and this change adds 895: 836 across 17 tools, then +59 on create_asset and
  // create_registered_asset after review, for a pointer that says how to CHOOSE between them (`gen:ledger`, `ledger/work-qa.csv`): each
  // look-alike naming its sibling in its first schema read (24 directions, #1208 §2a), first
  // sentences rewritten to say what the tool does, and set_gizmo/focus_entity naming their
  // read-back. The first-sentence rewrites REMOVED bytes (two issue numbers, a changelog clause);
  // the sibling pointers are the spend.
  // 2026-09-15 (#1223 P1–P5 close-out, work-ai3): RE-PINNED to 166,674 — measured on the merge of
  // origin/main into work-ai3 (1346cc513). Neither side crossed alone: main arrived at ~165,057
  // (work-qa #1215, work-ai2 #1254, inside the headroom), and #1223 adds the rest, booked in
  // `ledger/work-ai3.csv`. P1–P4: +1,370 across the guid-address and addedTraits/alsoDeleted/handles
  // descriptions. P5: +222 naming the renamed counts (`returnedCount`/`totalCount`,
  // `worldEntityTotal`, `entityTotal`) in five tools. And +206 on modoki_mutate_scene and
  // modoki_prefab, where both sides extended one description. The spend is the breaking renames being
  // stated where an agent reads them.
  // 2026-09-16 (#1266 + #1218, work-ai3): RE-PINNED to 171,084 — measured on `b272dba16`, booked in
  // `ledger/work-ai3.csv`. +4,156 across 18 tools, and this one is worth reading as a WARNING about
  // where a surface budget actually goes, because almost none of it is the renames.
  //   The §2 renames (#1266) are ~net zero: `displayName` is longer than `name` on four tools and
  //   `maxPresses` than `max` on two, but open_particle_editor REFUNDED 65 B by losing a param
  //   nothing read. The count vocabulary is reply-side and costs the schema nothing.
  //   The spend is #1218 — 13 descriptions that pointed nowhere, pointed at history, or stated what
  //   the code does not do. Four tools are 2/3 of it: unused_assets (+585, a disk-vs-live warning it
  //   had NONE of, on the answer that feeds a delete), find_references (+550, `unreferenced`/
  //   `reachable` and the staleInputs trio its enumerated shape omitted), open_skin_editor (+505)
  //   and create_registered_asset (+474, an undocumented panel-opening side effect and a swallowed
  //   hook error).
  //   ⚠️ Much of that is a MOVE, not new prose: `contracts.ts` notes already described the
  //   staleInputs fields in detail, and `notes` is not part of the surface an agent reads. Moving a
  //   fact from a place nobody reads to the place everybody does SPENDS this budget by definition —
  //   so a "no new information" change can still cost 4 KB, and that is the spend being approved
  //   here, not an oversight.
  // 2026-09-18 (#1414, work-ai3): RE-PINNED to 175,280 — measured on this branch after merging
  // origin/main. The surface measured 175,052 before #1414 (the pre-#1414 editor.ts swapped back in),
  // inside the headroom with 32 B of it left: the rest was spent by the branches merged since the
  // 171,084 pin (booked in their ledgers). #1414 adds 228 B to modoki_save_all's `path`, which the
  // owner's ruling required to say that a
  // path naming another file is a Save As with a FRESH id that OVERWRITES what is there.
  // 2026-09-25 (#1554 + #1555, work-ai2): RE-PINNED DOWN to 165,715 — the first deliberate cut.
  // −9,867 B from the 175,582 last booked (ledger/work-ai2.csv), nearly all #1555: the aim prose every input tool carried
  // a copy of (entity/surface/allowOccluded, now ONE wording in `tools/shared/aimVocabulary.ts`,
  // with nested copies pointing at the statement in the same tool), drag's `to` pointing at `from`,
  // a shorter `precision`/`force`, and history narrative out of descriptions. #1554's rename is +2 B
  // per mention. The device server, which this pin does not price, lost ~2.4 KB the same way; the
  // repeated-prose ceiling in `mcpDescriptionProse.test.ts` covers both servers.
  // 2026-09-25 (#1553 + #1560, work-ai2): RE-PINNED to 166,332 — +617 B net over 27 tools (ledger/work-ai2.csv).
  // #1553 made the 17 action descriptions name their reply fields instead of "Returns editor state"
  // (roughly a wash per tool, and it saves ~1.5 KB of RESULT on every call, which this pin cannot see).
  // #1560 added real params agents kept guessing (`create_entity.name`, `modoki_scroll.dx/dy`,
  // `delete_asset.path`), stated the max on bounded numbers, and shared one `t` wording.
  const DEFINITION_BYTES = 166_332;
  const DEFINITION_HEADROOM = 4_000;

  // `sumSchemaBytes` itself now lives in `mcpSurface.ts` (imported above), not here — this ledger
  // only ever drives it against the REAL 105-tool surface, which cannot exercise every branch (a
  // scan found zero live tuples/oneOf/not/patternProperties/$defs). See the "sumSchemaBytes walk"
  // describe block below for coverage the real surface can't provide, and `mcpSurface.ts` for the
  // walk itself and the full reasoning behind which containers it descends into.

  it(`the tool definitions stay near their recorded size (~${Math.round(DEFINITION_BYTES / 1000)} KB)`, () => {
    // Priced through the SHARED walk (`surfaceBytes.ts`), not an inline loop, so the #894 ledger
    // and this gate cannot answer differently about the same surface — the sibling test below
    // pins that they don't.
    const perTool = new Map(s.names.map((name) => [name, toolBytes(name)] as const));
    const bytes = surfaceBytes(perTool);
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

  it('the ledger prices the surface identically to the gate, tool for tool (#894)', () => {
    // ⚠️ THIS COMMENT HAS BEEN WRONG IN BOTH DIRECTIONS. Read the measured boundary, not a summary.
    //
    // It DOES catch (each measured, each reddening this test and only this test, 1 of 41):
    //   · the ledger enumerating a different set of tools than the gate prices;
    //   · the ledger pricing through a DIFFERENT function — +1 B/tool with identical key sets is
    //     red here while `DEFINITION_BYTES` stays green. That is the real guard against the
    //     `dump-surface.mjs` trap (its `sumDescriptionBytes` omits property names), so **do not
    //     delete the per-tool loop or the `surfaceBytes` equality below as redundant** — they are
    //     the only thing standing between this repo and a ledger rebuilt on a second walker.
    //
    // It CANNOT catch a walk that is wrong the SAME way on both sides, because both call one
    // `toolBytes` in one process off one module: inflating `toolBytes` by 100 B/tool reddens the
    // `DEFINITION_BYTES` pin above and leaves this test GREEN (1 failed / 40 passed). Correctness
    // of the walk itself is the `sumSchemaBytes walk` block's job — dropping `key.length` from its
    // `properties` branch reddens 6 of those cases and none of these (the `patternProperties`
    // branch is a separate occurrence and reddens only 1 — say which branch when quoting this).
    //
    // The first version of this comment claimed it policed the arithmetic (false); the second
    // over-corrected to "enumeration only" (also false, and worse — it invites deleting a live
    // guard). The line above is where it actually sits.
    const standalone = perToolBytes();
    const viaHarness = new Map(s.names.map((name) => [name, toolBytes(name)] as const));
    expect([...standalone.keys()].sort()).toEqual([...viaHarness.keys()].sort());
    for (const [name, bytes] of viaHarness) {
      expect(standalone.get(name), `${name} priced differently by the ledger and the gate`)
        .toBe(bytes);
    }
    expect(surfaceBytes(standalone)).toBe(surfaceBytes(viaHarness));
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

describe('sumSchemaBytes walk (#456 close-out)', () => {
  // The definitions ledger above drives `sumSchemaBytes` against the REAL 105-tool surface, and a
  // scan of every served schema found `tuples:0, oneOf:0, not:0, patternProperties:0, $defs:0` —
  // none of those branches has ever executed against real traffic. `DEFINITION_BYTES` staying pinned
  // (143_859 when this was written; 152_065 today) proves the walk is STABLE on today's surface; it proves nothing about whether the
  // array-aware / oneOf / not / patternProperties branches are actually CORRECT, since nothing here
  // has ever forced them to run. These tests drive `zodToJsonSchema` output built to exercise each
  // branch on purpose, and assert the SUMMED byte count — not merely "greater than zero", which
  // would pass on a half-working walker just as easily as a correct one.

  it('sums description bytes inside a z.tuple() — the array-valued `items` case', () => {
    // This is the regression that matters most: `#456`'s bug was exactly this shape, one level
    // deeper. The OLD walker's `if (n.items) bytes += sumSchemaBytes(n.items)` recursed into
    // `n.items` fine for an object-valued `items` (a `z.array()`), but `zodToJsonSchema` emits a
    // z.tuple()'s `items` as an ARRAY of per-position sub-schemas — `sumSchemaBytes` on an array it
    // does not recognize as an array falls through every `typeof !== 'object'`-adjacent branch and
    // returns 0, so a tuple's element descriptions were invisible before the array-aware `if
    // (Array.isArray(node))` branch was added.
    const tuple = z.tuple([
      z.number().describe('x coordinate, in design pixels'),
      z.number().describe('y coordinate, in design pixels'),
    ]);
    const schema = zodToJsonSchema(z.object({ point: tuple }));
    const expected = 'point'.length
      + 'x coordinate, in design pixels'.length
      + 'y coordinate, in design pixels'.length;
    expect(sumSchemaBytes(schema)).toBe(expected);
  });

  it('sums description bytes across a z.union() (`anyOf`)', () => {
    // A union of bare primitives collapses to a `type: [...]` array rather than `anyOf` (nothing
    // to recurse into) — object-shaped members force `zodToJsonSchema` to actually emit `anyOf`.
    const union = z.union([
      z.object({ path: z.string().describe('a literal path') }),
      z.object({ id: z.number().describe('a numeric id') }),
    ]).describe('either a path or an id');
    const schema = zodToJsonSchema(z.object({ target: union }));
    const expected = 'target'.length
      + 'either a path or an id'.length
      + 'path'.length + 'a literal path'.length
      + 'id'.length + 'a numeric id'.length;
    expect(sumSchemaBytes(schema)).toBe(expected);
  });

  it('sums description bytes inside a z.record() (`additionalProperties`)', () => {
    const record = z.record(z.string().describe('one override value')).describe('name -> override map');
    const schema = zodToJsonSchema(z.object({ overrides: record }));
    const expected = 'overrides'.length + 'name -> override map'.length + 'one override value'.length;
    expect(sumSchemaBytes(schema)).toBe(expected);
  });

  it('sums description bytes through a z.object nested 2+ levels deep', () => {
    // `.describe()` sets metadata on the node it is called on; calling it twice on the SAME
    // instance overwrites rather than accumulates (`inner.describe('middle inner wrapper')`
    // replaces whatever description `inner` already carried) — so this deliberately gives `inner`
    // its description only once, at the depth it is actually read from.
    const inner = z.object({ deep: z.string().describe('deeply nested prose') });
    const middle = z.object({ inner: inner.describe('middle inner wrapper') }).describe('middle');
    const schema = zodToJsonSchema(z.object({ outer: middle }));
    const expected = 'outer'.length + 'inner'.length + 'deep'.length
      + 'middle'.length + 'middle inner wrapper'.length + 'deeply nested prose'.length;
    expect(sumSchemaBytes(schema)).toBe(expected);
  });

  it('does not double-count a schema referenced under two different keys', () => {
    // Two INDEPENDENTLY-BUILT instances of the same shape (the `makeEntitySpec()` factory pattern
    // `shapes.ts` actually uses) — not the same object reused twice, which `zodToJsonSchema`
    // instead collapses to a `$ref` and is a different (and separately real) gap: this walker does
    // not resolve `$ref`/`$defs`, so a `$ref`'d property's prose would be invisible rather than
    // doubled. That gap is out of scope here; this test pins the factory case the real surface
    // actually uses.
    const makeShared = () => z.object({ value: z.string().describe('shared leaf prose') });
    const schema = zodToJsonSchema(z.object({ a: makeShared(), b: makeShared() }));
    const oneOccurrence = 'value'.length + 'shared leaf prose'.length;
    expect(sumSchemaBytes(schema)).toBe('a'.length + 'b'.length + oneOccurrence * 2);
  });

  it('sums description bytes under hand-built `oneOf`/`not`/`patternProperties`/`propertyNames` nodes', () => {
    // The installed zod-to-json-schema (v3.25, checked in `node_modules`) never actually EMITS
    // `oneOf`, `not`, `patternProperties`, or `propertyNames` from any zod construct — grepping its
    // source for `oneOf` turns up only an unrelated internal check, and the real 105-tool surface
    // scan (#456) found zero live instances of any of them. So there is no zod shape that can drive
    // these branches through `zodToJsonSchema`; the fixture is a JSON-Schema-shaped object built by
    // hand instead. `sumSchemaBytes` takes `unknown`, not a zod-shaped type, specifically because it
    // is meant to walk whatever a compliant JSON Schema hands it — including containers this
    // library's CURRENT version cannot itself produce, since a future bump could start emitting
    // them (draft 2020-12 uses `prefixItems`+`patternProperties` far more than draft-07 does).
    const schema = {
      type: 'object',
      properties: {
        variant: {
          oneOf: [
            { type: 'string', description: 'variant as a string' },
            { type: 'number', description: 'variant as a number' },
          ],
          not: { type: 'null', description: 'explicitly never null' },
        },
        bag: {
          patternProperties: {
            '^opt_': { type: 'string', description: 'one option value' },
          },
          propertyNames: { description: 'must start with opt_' },
        },
      },
    };
    const expected = 'variant'.length + 'bag'.length // top-level property NAMES
      + 'variant as a string'.length + 'variant as a number'.length // oneOf entries
      + 'explicitly never null'.length // not
      + '^opt_'.length + 'one option value'.length // patternProperties: pattern KEY + value description
      + 'must start with opt_'.length; // propertyNames
    expect(sumSchemaBytes(schema)).toBe(expected);
  });

  it('terminates on a schema built from independently-defined but structurally identical branches', () => {
    // Not a literal cyclic reference (zod/zodToJsonSchema does not hand this walker one), but a
    // sanity check that recursion through every whitelisted container bottoms out rather than
    // looping — a walk that recurses into a container it does not also consume would spin forever
    // on a deep-enough schema instead of failing fast.
    let node: z.ZodTypeAny = z.string().describe('leaf');
    for (let i = 0; i < 25; i++) node = z.object({ child: node }).describe(`level ${i}`);
    const schema = zodToJsonSchema(z.object({ root: node }));
    expect(() => sumSchemaBytes(schema)).not.toThrow();
    expect(sumSchemaBytes(schema)).toBeGreaterThan(0);
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
      const code = codeOf(f);
      expect(code, `${f} must not read process.env`).not.toMatch(/process\.env/);
      expect(code, `${f} must not connect a transport`).not.toMatch(/StdioServerTransport|\.connect\(/);
    }
  });

  it('the active-scene default reads scenePathRef, NOT scenePath, in ONE place', () => {
    // `scenePath` is Vite's /@fs/<abs> URL, which /api/scene-mutate 403s. Using it made
    // set_transform's documented `path` default fail on every call — and no test caught it
    // because every test passed an explicit `path`. It lives in `activeScenePath` so a second
    // scene-editing tool cannot re-derive it wrong.
    // ⚠️ **Read by the function it sits in (#816, #1195).** The helper was a slice — first between two
    // comments, then from `async function activeScenePath(` to the next tool's registered name — and
    // "outside it" was `src.replace(helper, '')`. Now every mention is placed by its enclosing function.
    expect(scenePathSites(parseSource(codeOf('tools/scene.ts'), 'scene.ts'))).toEqual({
      // The type member and the read, both inside the helper.
      scenePathRefIn: ['activeScenePath', 'activeScenePath'],
      scenePathReadsInHelper: [],
    });
  });

  it("editorAction cannot have its routing `action` clobbered by a params key", () => {
    // `{ action, ...params }` let a tool's own `action` argument replace the OP NAME. Not
    // hypothetical: `modoki_prefab` spread its args (which include `action:'instantiate'`) over
    // this, so every prefab call sent 'instantiate' as the op name and got a 400 listing the
    // valid ops — all three prefab actions were dead through the MCP. Spread FIRST, routing key
    // last. (Also asserted behaviourally in `mcpToolContracts.test.ts`.)
    // ⚠️ `codeOf`, not `read`: this matches CODE. Against raw text a rationale comment reading
    // `// spread FIRST: { ...params, action }` satisfies it, so the spread could be deleted from
    // context.ts and every modoki_prefab call go dead with this guard still green (#816 review).
    const fn = codeOf('context.ts');
    expect(fn).toContain('{ ...params, action }');
    expect(fn).not.toContain('{ action, ...params }');
  });

  it('no tool spreads an `action`-bearing arg object into editorAction', () => {
    // The other half: /api/editor-action STRIPS `action` before relaying, so a param by that name
    // is structurally unreachable through it — a tool that needs one must rename it on the wire
    // (prefab uses `prefabAction`). Catch a new tool repeating the mistake.
    // ⚠️ **Read as each registration's own handler (#1195).** This used to check `modoki_prefab` alone, as the
    // text between two anchors — first a section-header COMMENT (#816: strip it and the window silently
    // widened), then the next tool's name, which a tool registered between them or a reordered file moved.
    // Now it covers what its title says: every tool that DECLARES an `action` param, in every tool module.
    const wires = toolModules().flatMap((f) => {
      const sf = parseSource(codeOf(f), f);
      return callsTo(sf, 'tool').filter((c) => ts.isIdentifier(c.expression) && !!propertyValue(c.arguments.length > 3 ? c.arguments[2] : undefined, 'action'))
        .map((c) => stringValueOf(c.arguments[0])!)
        .map((name) => ({ name, wires: editorActionWires(toolRegistration(sf, name)) }));
    });
    // Measured 2026-09-15: 11 tools declare `action`; 3 of them call editorAction.
    expect(wires.length).toBeGreaterThanOrEqual(11);
    expect(wires.filter((w) => w.wires.some((x) => x.leaksAction)).map((w) => w.name)).toEqual([]);
    expect(wires.find((w) => w.name === 'modoki_prefab')?.wires).toEqual([{ op: 'prefab', routesAction: true, leaksAction: false }]);
  });

  it('every scene-EDITING tool defaults its path to the active scene', () => {
    // The ergonomic form is the one that gets used, so a required `path` is a usability bug, not
    // a style choice: `mutate_scene` is the batchable authoring route (a batch cannot read a
    // response to discover a path), and it required one until 2026-07-30. `validate_scene` /
    // `load_scene` are excluded on purpose — naming a specific file IS the call.
    // ⚠️ `codeOf` for the same reason, and it also stops the slice below from starting at a
    // COMMENT occurrence of the tool name rather than its registration.
    // ⚠️ Each tool is its `tool('<name>', …)` registration, from the parser (#1195) — it used to run from the
    // first `'<name>'` to the next `'\n  );'`, a fixed two-space closer.
    const sf = parseSource(codeOf('tools/scene.ts'), 'scene.ts');
    for (const name of ['modoki_mutate_scene', 'modoki_set_transform']) {
      expect(pathDefault(toolRegistration(sf, name)), `${name} must accept an omitted path, and resolve it via activeScenePath`)
        .toEqual({ optional: true, resolvedVia: [`activeScenePath(path, '${name}')`] });
    }
  });

  it('reads a registration, its handler and the helper by node, not by the text between anchors (#1195)', () => {
    const sf = parseSource([
      'async function activeScenePath(path, tool) { const ref = (body as { scenePathRef?: string }).scenePathRef; return ref; }',
      "tool('modoki_a', 'd', { path: z.string()\n    .optional(), ops: z.any() },\n  async ({ path, ops }) => {\n    const t = `\n  );`;\n    const r = await activeScenePath(path, 'modoki_a'); return r;\n  },\n);",
      "tool('modoki_b', 'd', { path: z.string() }, async (p) => { const r = await activeScenePath(p.path, 'modoki_b'); return editorAction('b', p); });",
      "tool('modoki_c', 'd', {}, async ({ action, ...rest }) => editorAction('c', { ...rest, prefabAction: action }));",
      "tool('modoki_d', 'd', {}, async (args) => editorAction('d', { ...args, prefabAction: args.action }));",
      "function elsewhere(s) { return s.scenePath ?? 'scenePathRef'; }",
      "tool('modoki_e', 'd', { path: z.string().optional() }, async ({ path }) => (async (path) => activeScenePath(path, 'modoki_e'))());",
      "registry.tool('modoki_c', 'd', {}, async () => 1);",
      "tool('modoki_f', 'd', {}, async ({ action, x }) => editorAction('f', { x, action }));",
      "tool('modoki_g', 'd', {}, async ({ id, ...rest }) => editorAction('g', rest));",
      "tool('modoki_h', 'd', {}, async (args) => editorAction('h', { 'action': args.action }));",
      "tool('modoki_i', 'd', {}, async (args) => { const p = args; return editorAction('i', p); });",
      "tool('modoki_j', 'd', {}, async ({ action, ...rest }) => editorAction('j', { ...rest, prefabAction: action }));",
      "tool('modoki_k', 'd', {}, async (args) => { const { id, ...rest } = args; return editorAction('k', rest); });",
      "tool('modoki_l', 'd', {}, async (args) => { const p = { ...args }; return editorAction('l', p); });",
      "tool('modoki_m', 'd', {}, async (args) => { const { action, ...rest } = args; return editorAction('m', { ...rest, prefabAction: action }); });",
      "tool('modoki_n', 'd', {}, async ({ action, ...rest }) => { const p = { ...rest, action }; return editorAction('n', p); });",
      "tool('modoki_o', 'd', {}, async (args) => { const p = { id: args.id, action: args.action }; return editorAction('o', p); });",
      "tool('modoki_p', 'd', {}, async (args) => { const p = Object.assign({}, args); return editorAction('p', p); });",
      "tool('modoki_q', 'd', {}, async (args) => [args].map(({ id, ...rest }) => editorAction('q', rest)));",
      "tool('modoki_r', 'd', {}, async ({ action, ...rest }) => { const p = Object.assign({}, rest, { prefabAction: action }); return editorAction('r', p); });",
      "tool('modoki_s', 'd', {}, async (args) => [args].map(({ action, ...rest }) => editorAction('s', rest)));",
      "tool('modoki_t', 'd', {}, async (args) => { const a = { ...args }; const b = { ...a }; const c = { ...b }; return editorAction('t', c); });",
      "tool('modoki_u', 'd', {}, async (args) => [args].map((a) => editorAction('u', { ...a })));",
      "tool('modoki_v', 'd', {}, async ({ id }) => { const send = ({ n, ...rest }) => editorAction('v', rest); return send({ n: id }); });",
      "tool('modoki_w', 'd', {}, async (args) => { const p = {}; Object.assign(p, args); return editorAction('w', p); });",
      "tool('modoki_x', 'd', {}, async (args) => { const p = { id: args.id }; p.action = args.action; return editorAction('x', p); });",
      "tool('modoki_x2', 'd', {}, async (args) => { const p = {}; p['action'] = args.action; return editorAction('x2', p); });",
      "tool('modoki_y', 'd', {}, async (args) => { let p = {}; p = args; return editorAction('y', p); });",
      "tool('modoki_z', 'd', {}, async () => { const p = { action: 'play' }; return editorAction('z', p); });",
      "tool('modoki_ok', 'd', {}, async ({ action, id }) => { let p = { id }; p = { ...p, prefabAction: action }; p.id = 2; Object.assign(p, { id }); return editorAction('ok', p); });",
      "tool('modoki_dup', 'd', {}, async () => 1);\ntool('modoki_dup', 'd', {}, async () => 2);",
    ].join('\n'), 'probe.ts');
    expect(pathDefault(toolRegistration(sf, 'modoki_a'))).toEqual({ optional: true, resolvedVia: ["activeScenePath(path, 'modoki_a')"] });
    // Not optional, and a path read off the args object rather than the destructured binding.
    expect(pathDefault(toolRegistration(sf, 'modoki_b'))).toEqual({ optional: false, resolvedVia: [] });
    expect(editorActionWires(toolRegistration(sf, 'modoki_b'))).toEqual([{ op: 'b', routesAction: false, leaksAction: true }]);
    expect(editorActionWires(toolRegistration(sf, 'modoki_c'))).toEqual([{ op: 'c', routesAction: true, leaksAction: false }]);
    expect(editorActionWires(toolRegistration(sf, 'modoki_d'))).toEqual([{ op: 'd', routesAction: false, leaksAction: true }]);
    expect(editorActionWires(toolRegistration(sf, 'modoki_f'))).toEqual([{ op: 'f', routesAction: false, leaksAction: true }]);
    // A rest that still holds `action`, a quoted key, and an alias of the args leak; a rest with `action` bound out does not.
    expect(['modoki_g', 'modoki_h', 'modoki_i', 'modoki_j', 'modoki_k', 'modoki_l', 'modoki_m'].map((n) => editorActionWires(toolRegistration(sf, n))[0]!.leaksAction))
      .toEqual([true, true, true, false, true, true, false]);
    // A copy is read like the literal inline: an `action` key in it, Object.assign of the args, a rest in a nested
    // function's parameter (its source unseen) leak; the same shapes with `action` bound out do not.
    expect(['modoki_n', 'modoki_o', 'modoki_p', 'modoki_q', 'modoki_r', 'modoki_s'].map((n) => editorActionWires(toolRegistration(sf, n))[0]!.leaksAction))
      .toEqual([true, true, true, true, false, false]);
    // Spread copies three deep; a nested function's whole parameter; later writes (Object.assign into it, an `action`
    // property, reassignment); a copy in a handler with no parameter — all leak. A local helper's rest leaks too, by
    // design: its argument is a call this does not follow, so it is red rather than read as clean (third §2d round).
    expect(['modoki_t', 'modoki_u', 'modoki_v', 'modoki_w', 'modoki_x', 'modoki_x2', 'modoki_y', 'modoki_z', 'modoki_ok']
      .map((n) => editorActionWires(toolRegistration(sf, n))[0]!.leaksAction)).toEqual([true, true, true, true, true, true, true, true, false]);
    // Out of names to follow fails loudly.
    const deep = parseSource(`tool('modoki_deep', 'd', {}, async (args) => { const p0 = args; ${Array.from({ length: 9 }, (_, i) => `const p${i + 1} = p${i};`).join(' ')} return editorAction('deep', p9); });`, 'deep.ts');
    expect(() => editorActionWires(toolRegistration(deep, 'modoki_deep'))).toThrow(/names deep/);
    // A string naming it is still a mention outside the helper; a `.scenePath` read elsewhere is not the helper's.
    expect(scenePathSites(sf)).toEqual({ scenePathRefIn: ['activeScenePath', 'activeScenePath', 'elsewhere'], scenePathReadsInHelper: [] });
    expect(() => toolRegistration(sf, 'modoki_missing')).toThrow(/one tool\('modoki_missing'/);
    expect(() => toolRegistration(sf, 'modoki_dup')).toThrow(/one tool\('modoki_dup'/);
    // A `path` shadowed by an inner parameter is not the tool's own `path`.
    expect(pathDefault(toolRegistration(sf, 'modoki_e'))).toEqual({ optional: true, resolvedVia: [] });
  });
});

/** The ONE `tool('<name>', description, shape, handler)` registration in `sf`. */
function toolRegistration(sf: ts.SourceFile, name: string): { shape: ts.Expression | undefined; handler: ts.ArrowFunction | ts.FunctionExpression } {
  const calls = callsTo(sf, 'tool').filter((c) => ts.isIdentifier(c.expression) && stringValueOf(c.arguments[0]) === name);
  expect(calls.length, `expected one tool('${name}', …) registration in ${sf.fileName}`).toBe(1);
  const args = calls[0]!.arguments;
  const handler = unwrapValue(args[args.length - 1]!);
  expect(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler), `${name}: the last argument is not an inline handler`).toBe(true);
  return { shape: args.length > 3 ? args[2] : undefined, handler: handler as ts.ArrowFunction | ts.FunctionExpression };
}

/** Whether a tool's `path` schema is `.optional()`, and each `activeScenePath(…)` its handler resolves the
 *  DESTRUCTURED `path` parameter through, printed. */
function pathDefault(reg: ReturnType<typeof toolRegistration>): { optional: boolean; resolvedVia: string[] } {
  const schema = propertyValue(reg.shape, 'path');
  const param = reg.handler.parameters[0]?.name;
  const pathBinding = param && ts.isObjectBindingPattern(param)
    ? param.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === 'path' && !e.propertyName) : undefined;
  return {
    optional: !!schema && calledNames(schema).includes('optional'),
    resolvedVia: callsTo(reg.handler.body, 'activeScenePath')
      .filter((c) => { const a = c.arguments[0]; return !!a && ts.isIdentifier(a) && !!pathBinding && declarationOf(a) === pathBinding; })
      .map(printedText),
  };
}

/** Each `editorAction('<op>', <params>)` in a tool's handler: whether it routes the tool's `action` on the wire
 *  as `prefabAction: action` (the destructured binding), and whether the params could still carry a key named
 *  `action` — the whole args object passed or spread, or an `action:` key. */
function editorActionWires(reg: ReturnType<typeof toolRegistration>): Array<{ op: string | undefined; routesAction: boolean; leaksAction: boolean }> {
  const isActionKey = (n: ts.PropertyName | undefined) => !!n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === 'action';
  const bindsAction = (pattern: ts.ObjectBindingPattern) => pattern.elements.some((el) => !el.dotDotDotToken && isActionKey(el.propertyName ?? (el.name as ts.Identifier)));
  /** Whether a value can still carry a key named `action` onto the wire — the args object itself; any parameter of a
   *  nested function, whole or a `...rest` not binding `action` out, since its source is a call this cannot see; a
   *  `...rest` of the handler's parameter or of a body destructure of a leaking value; a variable whose initializer
   *  leaks, or that is later written to with one (`Object.assign(p, args)`, `p.action = …`, `p = args`); an object
   *  literal with an `action` key or a leaking spread; an `Object.assign` with a leaking argument. One recursion, so a
   *  copy is read the same as the literal passed inline (#1195 close-out review, then the second and third §2d rounds).
   *  Only a name followed costs a hop, and running out of hops fails loudly instead of reading "no leak". */
  const handlerIds = findNodes(reg.handler, ts.isIdentifier);
  const leaks = (value: ts.Expression, hops = 0, following: ReadonlySet<ts.Node> = new Set()): boolean => {
    const e = unwrapValue(value);
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.some((p) => ts.isSpreadAssignment(p) ? leaks(p.expression, hops, following) : isActionKey(p.name));
    }
    if (ts.isCallExpression(e) && accessPath(e.expression) === 'Object.assign') return e.arguments.some((x) => leaks(x, hops, following));
    if (!ts.isIdentifier(e)) return false;
    expect(hops, `${printedText(e)}: more than 8 names deep — extend editorActionWires rather than read "no leak"`).toBeLessThan(8);
    const d = declarationOf(e);
    // A name already being followed adds nothing new (`p = { ...p, … }`): whatever it holds is read where it was entered.
    if (!d || following.has(d)) return false;
    const next = new Set(following).add(d);
    if (ts.isParameter(d)) return true;
    if (ts.isBindingElement(d)) {
      if (!d.dotDotDotToken || !ts.isObjectBindingPattern(d.parent) || bindsAction(d.parent)) return false;
      const holder = d.parent.parent;
      if (ts.isParameter(holder)) return true;
      return ts.isVariableDeclaration(holder) && !!holder.initializer && leaks(holder.initializer, hops + 1, next);
    }
    if (!ts.isVariableDeclaration(d)) return false;
    if (d.initializer && leaks(d.initializer, hops + 1, next)) return true;
    // Written to after its declaration.
    return handlerIds.some((r) => {
      if (r === d.name || declarationOf(r) !== d) return false;
      const up = r.parent;
      if (ts.isCallExpression(up) && accessPath(up.expression) === 'Object.assign' && up.arguments[0] === r) {
        return up.arguments.slice(1).some((x) => leaks(x, hops + 1, next));
      }
      const assigned = (target: ts.Node) => ts.isBinaryExpression(target.parent) && target.parent.left === target
        && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if ((ts.isPropertyAccessExpression(up) && up.expression === r && up.name.text === 'action')
        || (ts.isElementAccessExpression(up) && up.expression === r && stringValueOf(up.argumentExpression) === 'action')) return assigned(up);
      return assigned(r) && leaks((r.parent as ts.BinaryExpression).right, hops + 1, next);
    });
  };
  return callsTo(reg.handler.body, 'editorAction').map((c) => {
    const params = c.arguments[1] && unwrapValue(c.arguments[1]);
    const routed = params && propertyValue(params, 'prefabAction');
    const leaksAction = !!params && leaks(params);
    return { op: stringValueOf(c.arguments[0]), routesAction: !!routed && ts.isIdentifier(routed) && routed.text === 'action', leaksAction };
  });
}

/** Where `scenePathRef` is named (identifiers and strings, by enclosing function), and the `.scenePath` property
 *  reads inside `activeScenePath` itself. */
function scenePathSites(sf: ts.SourceFile): { scenePathRefIn: Array<string | undefined>; scenePathReadsInHelper: string[] } {
  const helpers = functionsNamed(sf, 'activeScenePath');
  expect(helpers.length, `expected one activeScenePath in ${sf.fileName}`).toBe(1);
  const mentions = findNodes(sf, (n): n is ts.Identifier | ts.StringLiteralLike =>
    (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'scenePathRef');
  return {
    scenePathRefIn: mentions.map((m) => enclosingNamedFunction(m)?.name),
    scenePathReadsInHelper: findNodes(helpers[0]!.body, ts.isPropertyAccessExpression).filter((p) => p.name.text === 'scenePath').map(flatText),
  };
}

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
    const src = readScannedSource(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpRegistry.test.ts'),
    ).code;
    // Every edge from the parse (#1193): `^import\s+\{[^}]*\}\s+from\s+'zod';$` missed a wrapped
    // import, double quotes, no semicolon, a default/namespace import and `export … from 'zod'`.
    const bare = importsIn(parseSource(src, 'mcpRegistry.test.ts')).filter((e) => e.spec === 'zod' || e.spec.startsWith('zod/'));
    expect(bare.map((e) => e.spec), 'import zod from tools/modoki-mcp/node_modules, not a bare specifier').toEqual([]);

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
