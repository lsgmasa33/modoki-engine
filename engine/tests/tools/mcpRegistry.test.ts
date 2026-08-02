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
