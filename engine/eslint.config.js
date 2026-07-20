import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

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
  // Tests run under Vitest (globals imported explicitly) in a node+jsdom env.
  {
    files: ['engine/tests/**/*.{ts,tsx}', 'engine/packages/*/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
