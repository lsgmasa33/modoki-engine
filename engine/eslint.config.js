import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// ─────────────────────────────────────────────────────────────────────────────
// Engine runtime LAYER CONTRACT — the machine-readable half of
// docs/architecture-layers.md — the layer table, the why, the registration-inversion pattern,
// the declared L2->L2 exceptions, and D1-D5 (the settled design decisions) all live there.
//
// L0 core (`core/`, incl. `core/ecs/`)  may import: nothing
// L1 traits (`traits/`)                 may import: L0
// L2 subsystems                         may import: L0, L1 (+ declared L2→L2 exceptions)
// L3 composition                        may import: everything (unrestricted)
// `runtime/index.ts` is the barrel — deliberately unlayered, and exempt.
//
// WHY it is a lint rule and not a convention: ESM circular imports do not error, they
// hand you `undefined` at module-evaluation time depending on import order. A reverse
// dependency (core → a feature subsystem) is therefore a silent, order-sensitive
// correctness bug, not untidiness.
//
// P3-P7 burned down the original 59-file/133-specifier violation set to zero. P8 deleted
// the burn-down allowlist entirely — `PERMANENT_ALLOWLIST` below is the small, permanent,
// named exception set that remains (each with its own rationale), and everything else is
// now an absolute error.
// ─────────────────────────────────────────────────────────────────────────────
const RT = 'engine/packages/modoki/src/runtime';

const L1_FOLDERS = ['traits'];
/** L2 subsystems. `physics` + `zones` are new — P6 dissolved the transitional `systems/`
 *  bucket into these (and the other feature folders below); `systems/` no longer exists. */
const L2_FOLDERS = [
  'animation', 'audio', 'input', 'particles', 'physics', 'rendering',
  'skinning', 'storage', 'timeline', 'ui', 'zones',
];
const L3_FOLDERS = ['actions', 'assets', 'debug', 'harness', 'loaders', 'managers', 'ota', 'scene', 'store'];

/** D4 (docs/architecture-layers.md "## Settled decisions"): these three files
 *  physically sit in `rendering/` (L2) but are reclassified L3 by the owner — they compose scene
 *  data + loaders + subsystems into a rendered frame, not a reusable L2 subsystem. Reclassified
 *  in place (NOT moved) to keep `engine/app/App.tsx`'s deep import of `rendering/Scene3D`
 *  untouched; verified nothing in any OTHER runtime L2 folder imports these three, so this
 *  creates zero new violations elsewhere. */
const L3_RECLASSIFIED_FILES = ['rendering/Scene2D.tsx', 'rendering/Scene3D.tsx', 'rendering/scene3DSync.ts'];

/** Declared, one-directional L2→L2 exceptions (rationale in docs/architecture-layers.md).
 *  Within L2 there is an implicit tier order — producers (animation/skinning/particles/audio/…)
 *  → conductor (timeline) → presentation (rendering) — and only downward edges are legal. */
const L2_ALLOWED = {
  // The renderer is the presentation consumer of authored animation/particle/skin data:
  // it samples clips to pose the mixer, instantiates particle backends, and uploads the
  // skinned vertex buffers. None of those subsystems imports `rendering/` back.
  rendering: ['animation', 'particles', 'skinning'],
  // A Director's entire job is sequencing other subsystems; timeline is the conductor tier.
  // Nothing in animation/ or audio/ imports timeline/.
  timeline: ['animation', 'audio'],
  // The 2D skin pass composes on top of the deform pass's output — deform runs first.
  skinning: ['animation'],
};

/** Every relative-specifier shape that reaches `runtime/<folder>` from a runtime file 0–3
 *  directories deep. ESLint matches `patterns` with gitignore semantics, so a bare folder
 *  pattern already covers everything beneath it (`../ui` matches `../ui/actionRegistry`).
 *  Negation (`!../ui/actionRegistry`) is NOT supported by the rule — verified — which is why
 *  the allowlist below exempts at folder granularity and names the exact specifier in a
 *  comment instead.
 *
 *  Deliberately NO `./<folder>` shape: it is only reachable from the five loose files at
 *  `runtime/` root (which have no cross-folder imports today, and which P3c moves into
 *  `core/` where the `../` shapes apply), and ESLint's glob matching is case-insensitive —
 *  `./input` would falsely flag `traits/index.ts`'s `./Input`. */
const reach = (folders) => folders.flatMap((f) => [`../${f}`, `../../${f}`, `../../../${f}`]);
/** Escapes out of `runtime/` into the Three.js integration folder (`src/three/`). After P5
 *  moved `transformPropagationSystem`/`worldTransforms`/`deactivatedEntities` into
 *  `core/ecs/`, what is left in `src/three/` is only the three Three.js-specific TRAITS
 *  (`Light`, `Environment`, `Fog`) — so the two remaining exemptions below are PERMANENT
 *  (`rendering/` is the Three renderer; it is meant to consume Three traits), not burn-down. */
const THREE_ESCAPE = ['../three', '../../three', '../../../three'];

const L0_FORBIDDEN = [...reach(L1_FOLDERS), ...reach(L2_FOLDERS), ...reach(L3_FOLDERS), ...THREE_ESCAPE];
const L1_FORBIDDEN = [...reach(L2_FOLDERS), ...reach(L3_FOLDERS), ...THREE_ESCAPE];
const l2Forbidden = (f) => [
  ...reach(L3_FOLDERS),
  ...reach(L2_FOLDERS.filter((o) => o !== f && !(L2_ALLOWED[f] ?? []).includes(o))),
  ...THREE_ESCAPE,
];

// Empty `patterns` means "nothing forbidden" — `no-restricted-imports`'s schema rejects an empty
// `group` array, so that case explicitly turns the rule OFF instead. (Must be explicit, not just
// omitted: flat config only overrides a rule for a later matching config if that config sets the
// rule key at all — an empty `{}` would leave an earlier matching zone's rule in effect.)
const layerRule = (patterns, message) => (
  patterns.length === 0
    ? { 'no-restricted-imports': 'off' }
    : { 'no-restricted-imports': ['error', { patterns: [{ group: patterns, message }] }] }
);

/** The forbidden set a given runtime-relative file is subject to (used to build the
 *  allowlist entries as "its zone, minus the folders it is still permitted"). */
function forbiddenFor(rel) {
  const parts = rel.split('/');
  const folder = parts[0];
  if (parts.length === 1) return L0_FORBIDDEN; // loose root file (config, version, …)
  if (folder === 'core' || folder === 'ecs') return L0_FORBIDDEN;
  if (folder === 'traits') return L1_FORBIDDEN;
  if (L2_FOLDERS.includes(folder)) return l2Forbidden(folder);
  return []; // L3 — unrestricted
}

/** The PERMANENT exception set (P8 deleted the burn-down list — every one of these is a
 *  deliberate, documented, one-directional exception, not a TODO):
 *
 *  `core/ecs/{entityIndex,entityUtils,world,worldTransform,transformPropagationSystem}.ts`
 *  → `../traits`: resolves to `core/traits/EntityAttributes.ts` — an intra-L0 edge
 *  (`core/traits/` is part of L0 core per architecture-layers.md), not a reach into the real
 *  L1 `runtime/traits/` folder. The zone matcher can't tell the two apart (it matches the
 *  literal specifier text, not a resolved path — same limitation `L2_ALLOWED` has).
 *
 *  `rendering/sceneLightUniforms.ts` → `../../three`: a Three trait (`Light`), consumed by
 *  the Three renderer. `rendering/` is exactly what's meant to import Three traits. */
const PERMANENT_ALLOWLIST = [
  { file: 'core/ecs/entityIndex.ts', allow: ['../traits'] },
  { file: 'core/ecs/entityUtils.ts', allow: ['../traits'] },
  { file: 'core/ecs/world.ts', allow: ['../traits'] },
  { file: 'core/ecs/worldTransform.ts', allow: ['../traits'] },
  { file: 'core/ecs/transformPropagationSystem.ts', allow: ['../traits'] },
  { file: 'rendering/sceneLightUniforms.ts', allow: ['../../three'] },
];

const RUNTIME_LAYER_ZONES = [
  // L2 subsystems — may import L0 + L1 (+ their declared L2 exceptions), nothing else.
  ...L2_FOLDERS.map((f) => ({
    files: [`${RT}/${f}/**/*.{ts,tsx}`],
    rules: layerRule(
      l2Forbidden(f),
      `Layer violation: runtime/${f}/ is an L2 subsystem — it may import L0 core and L1 traits only, `
        + `not L3 composition (loaders/scene/managers/…) and not another L2 subsystem. Invert the `
        + `dependency by registration (see docs/architecture-layers.md).`,
    ),
  })),
  // L1 traits — pure data schemas. May import L0 only.
  {
    files: [`${RT}/traits/**/*.{ts,tsx}`],
    rules: layerRule(
      L1_FORBIDDEN,
      'Layer violation: runtime/traits/ is L1 — a trait schema may import L0 core only. If a '
        + 'subsystem type belongs to the trait, move the type DOWN into traits/ (or core/) and let '
        + 'the subsystem import it from there. See docs/architecture-layers.md.',
    ),
  },
  // L0 core — imports nothing.
  {
    files: [
      `${RT}/core/**/*.{ts,tsx}`,
      `${RT}/{config,gameDefinition,appServices,instanceGuard,version}.ts`,
    ],
    rules: layerRule(
      L0_FORBIDDEN,
      'Layer violation: this is L0 core — it must import NOTHING from the engine above it '
        + '(no traits, no subsystem, no composition layer). A core primitive that needs a feature '
        + 'is not a core primitive. See docs/architecture-layers.md.',
    ),
  },
  // Permanent named exceptions (P8) — each file keeps its zone rule MINUS the folders it's
  // declared to reach. See PERMANENT_ALLOWLIST's own doc comment for the rationale per entry.
  ...PERMANENT_ALLOWLIST.map(({ file, allow }) => ({
    files: [`${RT}/${file}`],
    rules: layerRule(
      forbiddenFor(file).filter((p) => !allow.includes(p)),
      'Layer violation (docs/architecture-layers.md). This import is not covered by this '
        + "file's PERMANENT_ALLOWLIST entry in engine/eslint.config.js.",
    ),
  })),
  // D4 reclassification — placed AFTER the L2 block above so it wins for these exact files
  // (later config wins for the same rule key on a matching file, same mechanism the burn-down
  // allowlist above already relies on). Fully unrestricted, like any other L3 file.
  ...L3_RECLASSIFIED_FILES.map((file) => ({
    files: [`${RT}/${file}`],
    rules: layerRule([], ''),
  })),
];

// Flat config (ESLint v9). The repo ships the v9 plugins but never had a config
// committed, so `npm run lint` was dead — this restores it. Rules are calibrated
// to the codebase: tsc already enforces unused-locals/params and full type
// checking, so ESLint focuses on correctness lint (rules-of-hooks, etc.) and
// keeps stylistic/`any` findings as warnings rather than hard errors.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // Project scaffold template — copied to new projects with placeholder tokens
      // substituted; not part of the engine build graph (also out of tsconfig).
      'engine/templates/**',
      // Native Capacitor projects (generated) — repo root AND per-game
      // (games/<id>/ios|android, #29). Not our source.
      '**/android/**',
      '**/ios/**',
      'coverage/**',
      // electron-builder packaged-app output (release/) — copies of our source
      // bundled into the .app/.dmg; not the source tree. Present only after a
      // local `npm run dist*`; a fresh CI checkout never has it, so this only
      // matters for local lint runs (e.g. the test-clean skill).
      'release/**',
      '**/*.tsbuildinfo',
      '**/.cache/**',
      // VitePress generated dependency cache (docs site) — minified vendor
      // bundles, gitignored, present only after the docs site runs locally.
      // A fresh CI checkout never has it, so this only matters for local lint.
      '**/.vitepress/cache/**',
      // Native build outputs + vendored framework bundles — not our source.
      '**/build/**',
      '**/.build/**',
      '**/*.xcframework/**',
      '**/Pods/**',
      '**/DerivedData/**',
    ],
  },
  // Base JS + TS recommended for every source file.
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // tsc (noUnusedLocals/noUnusedParameters) already fails the build on these;
      // keep ESLint from double-reporting and honor intentional `_`-prefixed args.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The engine leans on `any` for koota trait generics + Three.js interop.
      // Surface it as a warning, not a hard error.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow figure-space (U+2007) etc. inside doc comments that document
      // fixed-width number formatting. Code/strings still flag (strings are
      // skipped by default, comments are not).
      'no-irregular-whitespace': ['error', { skipComments: true }],
    },
  },
  // Browser-side code: app, games, and the engine/editor source.
  {
    files: ['engine/app/**/*.{ts,tsx}', 'games/**/*.{ts,tsx}', 'engine/packages/*/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      // Classic, high-signal hook rules (the Vite react-ts baseline). We do NOT
      // pull in react-hooks v7's `recommended-latest`, which enables the new
      // React-Compiler-era rules (set-state-in-effect, refs-during-render,
      // immutability) as errors — those flag the imperative useEffect + ref
      // patterns this engine deliberately uses (see CLAUDE.md "PixiJS game logic
      // is imperative inside useEffect").
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // ELECTRON_PLAN Phase 1 gate: every editor → backend call must go through
      // the single transport seam in editor/backend/editorBackend.ts (backendFetch /
      // backendEventSource), so the transport is swappable in one place for the
      // packaged Electron host. Raw `fetch('/api/...')` / `new EventSource('/api/...')`
      // would bypass it. The client module itself is exempt — it builds URLs via
      // backendUrl(), not a `/api/...` string literal, so it never matches.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch'] > Literal[value=/^\\/api\\//]",
          message: "Use backendFetch() from editor/backend/editorBackend instead of fetch('/api/...') — see ELECTRON_PLAN Phase 1.",
        },
        {
          selector: "CallExpression[callee.name='fetch'] TemplateElement[value.raw=/^\\/api\\//]",
          message: "Use backendFetch() from editor/backend/editorBackend instead of fetch(`/api/...`) — see ELECTRON_PLAN Phase 1.",
        },
        {
          selector: "NewExpression[callee.name='EventSource'] > Literal[value=/^\\/api\\//]",
          message: "Use backendEventSource() from editor/backend/editorBackend instead of new EventSource('/api/...').",
        },
        {
          selector: "NewExpression[callee.name='EventSource'] TemplateElement[value.raw=/^\\/api\\//]",
          message: "Use backendEventSource() from editor/backend/editorBackend instead of new EventSource(`/api/...`).",
        },
      ],
    },
  },
  // Node-side build tooling, configs, and scripts.
  {
    files: ['engine/plugins/**/*.{ts,js,mjs}', 'engine/tools/**/*.{ts,js,mjs}', 'engine/scripts/**/*.{js,mjs}', 'engine/electron/**/*.ts', 'engine/toolchain/**/*.ts', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
    rules: {
      // Toolchain parity gate (docs/plans/editor-toolchain-layer-plan.md): resolve external CLI
      // tools through engine/toolchain (which honours env overrides like MODOKI_TOKTX / the
      // packaged bundled binary), NEVER a bare tool name — a bare `toktx` is absent in a dmg.
      // Currently enforced for toktx (the migrated tool); extends to npm/npx/gltfpack/adb/… as
      // their spawn sites migrate. The engine/toolchain registry references the bare name as a
      // plain string, not inside a spawn call, so it never matches this selector.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name=/^(execFileSync|execSync|spawnSync|spawn|exec)$/] > Literal[value='toktx']",
          message: "Resolve toktx via engine/toolchain (detect/resolve/withToolOnPath) instead of spawning a bare 'toktx' — the packaged editor's toktx is at MODOKI_TOKTX, not on PATH.",
        },
        {
          selector: "CallExpression[callee.name=/^(execFileSync|execSync|spawnSync|spawn|exec)$/] > Literal[value='adb']",
          message: "Resolve adb via engine/toolchain detectAdb() (derives <sdk>/platform-tools/adb from the provisioned Android SDK) instead of spawning a bare 'adb' — the packaged editor's adb is NOT on PATH, so a bare spawn ENOENTs. (The game-debug MCP, a separate process, resolves it via GET /api/toolchain.)",
        },
      ],
    },
  },
  // The PACKAGED-app runtime paths (Electron main + the build-pipeline Vite plugins) additionally
  // must not spawn a bare `npm`: the packaged editor resolves npm through engine/toolchain
  // (npmSpawnSpec) so it can run on a downloaded Node, never a user-installed npm. Scoped to these
  // dirs — engine/scripts (bootstrap-game-deps etc.) is dev-setup only and stays on system npm.
  // This block REPLACES no-restricted-syntax for these files, so it re-lists the toktx selector.
  {
    files: ['engine/electron/**/*.ts', 'engine/plugins/**/*.{ts,js,mjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name=/^(execFileSync|execSync|spawnSync|spawn|exec)$/] > Literal[value='toktx']",
          message: "Resolve toktx via engine/toolchain (detect/resolve/withToolOnPath) instead of spawning a bare 'toktx' — the packaged editor's toktx is at MODOKI_TOKTX, not on PATH.",
        },
        {
          selector: "CallExpression[callee.name=/^(execFileSync|execSync|spawnSync|spawn|exec)$/] > Literal[value='npm']",
          message: "Resolve npm via engine/toolchain (npmSpawnSpec) instead of spawning a bare 'npm' — the packaged editor runs npm on a resolved/downloaded Node, not the user's PATH npm.",
        },
        {
          selector: "CallExpression[callee.name=/^(execFileSync|execSync|spawnSync|spawn|exec)$/] > Literal[value='adb']",
          message: "Resolve adb via engine/toolchain detectAdb() instead of spawning a bare 'adb' — the packaged editor's adb is the provisioned SDK's platform-tools/adb, NOT on PATH.",
        },
      ],
    },
  },
  // Engine runtime layer contract — see the RUNTIME_LAYER_ZONES block at the top of this file
  // and docs/architecture-layers.md. Spliced in here (after the browser-side block, before the
  // test block) because within a layer the later object must win: L2 zones, then L1, then L0,
  // then the per-file burn-down allowlist.
  ...RUNTIME_LAYER_ZONES,
  // Tests run under Vitest (globals imported explicitly) in a node+jsdom env.
  {
    files: ['engine/tests/**/*.{ts,tsx}', 'engine/packages/*/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
