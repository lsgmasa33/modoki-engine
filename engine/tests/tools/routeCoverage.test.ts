/** Every `/api/*` route is either reachable by a `modoki_*` tool or DECLARED as not-for-the-agent.
 *
 *  The gap this closes is one level up from `liveCoverage.ts`. That file keeps the tool→coverage
 *  split total, with a docblock about how a gap list nothing checks is a gap list that grows. The
 *  same reasoning applies to route→tool and there was no guard at all: 41 of the backend's 104
 *  routes had no tool, and nothing distinguished "editor chrome, correctly unreachable" from "we
 *  meant to expose this and never did".
 *
 *  Two of them turned out to be the second kind, and both are documented as existing FOR the agent:
 *  `/api/validate-prefab` ("exposes the same check so an agent editing prefab JSON can verify its
 *  own edit" — docs/scene-loading.md) and `/api/unused-assets` ("'What would the build drop?' has
 *  exactly ONE owner" — docs/build.md). Neither has a tool. They are listed in `AGENT_GAPS` below,
 *  which is the point: an open gap that is written down and counted is a decision waiting to be
 *  made, and an open gap that nothing lists is one nobody will ever make.
 *
 *  Source-scanned, like the registration guards in `mcpRegistry.test.ts`. Routes are matched as
 *  STRING LITERALS in the route files, which is what they are — the router dispatches on
 *  `urlPath === '/api/…'`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';

const REPO = path.join(__dirname, '../..');

/** Every file that dispatches on an `/api/*` path. Pinned rather than globbed: a NEW router file
 *  should fail this list loudly instead of having its routes silently escape the audit. */
const ROUTE_FILES = [
  'plugins/backend/editorBackendRouter.ts',
  'electron/inputRoutes.ts',
  'electron/devServer.ts',
  'electron/backendServer.ts',
  'electron/main.ts',
  'plugins/vite-asset-scanner.ts',
];

/** Sub-routes a multi-action tool reaches that its contract's single `route` cannot express.
 *  `contracts.ts` declares the route `minimalArgs` produces; `varies:'both'` says the others exist
 *  but not what they are. Named here so they count as covered without widening the match to a
 *  prefix — a prefix would also swallow a genuinely new, unexposed `/api/watch/*` route. */
const EXTRA_ROUTES: Record<string, string[]> = {
  modoki_watch: ['/api/watch/start', '/api/watch/read', '/api/watch/clear'],
  modoki_input_watch: ['/api/input-watch/start', '/api/input-watch/stop', '/api/input-watch/clear'],
};

/** Routes with no `modoki_*` tool ON PURPOSE, each with the reason. Not an exemption list — a
 *  claim, one per route, that the agent losing this route costs it nothing. */
const NO_TOOL_BY_DESIGN: Record<string, string> = {
  // ── consumed by the tool layer itself, so they need no tool of their own ──
  '/api/identity': "the once-per-process identity probe in context.ts; `modoki_identity` answers FROM it, which is why that contract declares route:null",
  '/api/dev-server-identity': 'the dev server\'s own identity, for the wrong-clone banner',
  '/api/game-tools': 'the DYNAMIC game-tool tail (#270) — the server polls this to materialize a game\'s own tools, which by construction have no contract entry',
  '/api/game-tool-call': 'the invoke half of the same dynamic tail',

  // ── the device MCP's surface, not the editor tool table ──
  '/api/device/status': 'device MCP control plane (device_status)',
  '/api/device/connect': 'device MCP control plane (device_connect)',
  '/api/device/disconnect': 'device MCP control plane (device_disconnect)',
  '/api/device/list': 'device MCP control plane (device_list)',
  '/api/device/request': 'the device lease data plane — every device_* tool proxies through it, asserted in deviceToolCoverage.test.ts',

  // ── native OS dialogs: a BLOCKING panel an agent must never open ──
  '/api/pick-path': 'opens a native file picker — modal, and only a human can dismiss one. #288 gap 5 routed the agent AROUND this (modoki_create_registered_asset takes an explicit path) precisely because a blocking osascript panel made the New-X surface agent-unreachable',
  '/api/save-dialog': 'native save panel — same blocking-modal reason',
  '/api/reveal-in-finder': 'opens Finder/Explorer on the human\'s desktop; nothing to read back',
  '/api/open-file': 'hands a file to the OS default application — a human affordance with no agent-observable result',

  // ── editor chrome: panel layout, pickers, per-session UI state ──
  '/api/layout': 'FlexLayout panel-layout persistence',
  '/api/layouts': 'the saved-layout list for the Window menu',
  '/api/layout-delete': 'deletes a saved panel layout',
  '/api/ai-settings': "the AI panel's own settings",
  '/api/project-games': 'the open project\'s game registry, for the project picker',
  '/api/scripts/tree': 'the script browser tree',
  '/api/boot-scene': 'the editor boot handshake — which scene the launcher asked for. modoki_get_editor_state reports what actually loaded, which is the agent-relevant fact',
  '/api/invalidate-project-config': "a cache bust the editor issues after its own config write; modoki_project_settings action:'set' does its own",

  // ── build/toolchain state the Build Support dialog reads ──
  '/api/toolchain': 'toolchain install status for the Build Support dialog',
  '/api/toolchain/settings': 'toolchain settings for the same dialog',
  '/api/toolchain/uninstall': 'removes a provisioned toolchain — a destructive machine-level op with no agent use case',
  '/api/toolchain/install': 'SSE toolchain provisioning, driven by the dialog',
  '/api/exit': 'stops the editor. `npm run editor:stop` is the sanctioned path (it stops Electron first so Vite comes down cleanly); a tool would invite the bare-pkill hazard CLAUDE.md forbids',
  '/api/build-modules': 'the resolved playable-DCE module list, shown in Project Settings; modoki_project_settings action:\'get\' returns the authored `build.modules` this derives from',
  '/api/signing-teams': 'the iOS signing dropdown\'s team discovery. Per-MACHINE, not a repo fact, and the value lives in the gitignored project.user.json',
  '/api/ota/keys': 'lists a published OTA key pair for the dialog; modoki_ota_status is the agent-facing read',

  // ── file ops the agent already has, natively and better ──
  '/api/read-file': 'Claude reads files directly; a tool would be a strictly worse duplicate bounded by the asset roots',
  '/api/write-file': 'same — Claude writes files directly. The asset-DEF writes that need editor round-tripping have their own tools',
  '/api/exists': 'an fs.existsSync behind HTTP; Claude can stat a path directly',
  '/api/source-image': "serves the BYTES of a project image outside the asset roots, so the Project Settings preview can show an <img>. Claude reads an image file directly (and can see it); an HTTP wrapper bounded by the project root is strictly less",
  '/api/adopt-file': "the Project Settings drop target — copy a dropped file into the project unless it is already there, and hand back the project-relative path. Every half of that is something Claude does natively (stat, copy, relativise), and the route exists only because the RENDERER cannot",

  // ── asset-panel plumbing ──
  '/api/reimport-types': 'the asset types the server can re-import, for the Assets-panel dropdown; modoki_reimport_asset just takes a path',
  '/api/rescan-assets': 'a manifest rebuild. The tools that invalidate the manifest rebuild it INLINE (modoki_delete_asset reports manifestRebuilt) rather than making the caller sequence a second call',
  '/api/font-axes': 'variable-font axis discovery for the Inspector\'s font widget',
};

/** Routes that SHOULD have a tool and do not. Open, tracked, and deliberately separate from the
 *  by-design list — collapsing them into it is how a gap becomes a permanent exemption.
 *
 *  EMPTY as of 2026-08-22: all six the audit found were exposed in one pass (owner decision) —
 *  `validate-prefab`, `unused-assets`, `write-meta`, `duplicate-asset`, `move-file`,
 *  `create-folder`. Keep the bucket. Its value is not the entries it happens to hold; it is that a
 *  route with no tool has somewhere honest to go that is NOT "by design", so the next one cannot
 *  quietly be filed as intentional. `docs/mcp-tool-conventions.md` §10. */
const AGENT_GAPS: Record<string, string> = {};

function declaredRoutes(): Set<string> {
  const out = new Set<string>();
  for (const [name, c] of Object.entries(CONTRACTS)) {
    if (c.route) out.add(c.route);
    for (const r of EXTRA_ROUTES[name] ?? []) out.add(r);
  }
  return out;
}

function definedRoutes(): Set<string> {
  const out = new Set<string>();
  for (const rel of ROUTE_FILES) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
    for (const m of src.matchAll(/'(\/api\/[a-zA-Z0-9/._-]+)'/g)) {
      // `/api/input/` is the PREFIX test the input router dispatches on, not a route.
      if (!m[1].endsWith('/')) out.add(m[1]);
    }
  }
  return out;
}

describe('backend route coverage', () => {
  it('every route file still exists — a moved router must fail loudly, not silently drop its routes', () => {
    for (const rel of ROUTE_FILES) {
      expect(fs.existsSync(path.join(REPO, rel)), `${rel} is gone — repoint ROUTE_FILES`).toBe(true);
    }
  });

  it('the scan finds a realistic number of routes (guards against a regex that matches nothing)', () => {
    // The failure mode this exists for: a source reshape makes the pattern match zero, every set
    // difference comes out empty, and the whole file passes while checking nothing.
    expect(definedRoutes().size).toBeGreaterThan(80);
  });

  it('every backend route has a tool, or a declared reason it does not', () => {
    const undeclared = [...definedRoutes()]
      .filter((r) => !declaredRoutes().has(r) && !(r in NO_TOOL_BY_DESIGN) && !(r in AGENT_GAPS))
      .sort();
    expect(
      undeclared,
      'these routes are reachable by no modoki_* tool and are in neither ledger. Add a tool, or '
      + 'add the route to NO_TOOL_BY_DESIGN with the reason the agent loses nothing — or to '
      + 'AGENT_GAPS if it is a capability we mean to expose and have not.',
    ).toEqual([]);
  });

  it('neither ledger names a route that no longer exists', () => {
    // Same rule as EXPECTED_REFUSALS and UNDOCUMENTED_PARAMS: a stale entry rots into a permanent
    // exemption for a route that has moved, and the next real gap lands on it unnoticed.
    const defined = definedRoutes();
    const stale = [...Object.keys(NO_TOOL_BY_DESIGN), ...Object.keys(AGENT_GAPS)]
      .filter((r) => !defined.has(r)).sort();
    expect(stale, 'delete these — the routes are gone').toEqual([]);
  });

  it('a route that GAINS a tool is removed from the ledgers', () => {
    // The AGENT_GAPS half is the point: closing a gap must also delete its entry, or the list stops
    // describing what is actually open and stops being worth reading.
    const declared = declaredRoutes();
    const covered = [...Object.keys(NO_TOOL_BY_DESIGN), ...Object.keys(AGENT_GAPS)]
      .filter((r) => declared.has(r)).sort();
    expect(covered, 'these now have a tool — delete them from the ledger').toEqual([]);
  });

  it('every declared contract route is a route the backend actually defines', () => {
    // The other direction, and it catches a different bug: a tool pointed at a route that was
    // renamed or removed is a DEAD TOOL, which is the exact failure (`modoki_prefab` 400ing on
    // every call for months) this whole test suite exists because of.
    const defined = definedRoutes();
    const orphans = [...declaredRoutes()].filter((r) => !defined.has(r)).sort();
    expect(orphans, 'tools point at these routes and no router defines them').toEqual([]);
  });
});
