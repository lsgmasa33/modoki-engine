import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as clonePorts from '../../scripts/cloneBackendPorts.mjs';
import * as editorPorts from '../../scripts/editorPorts.mjs';
import { readScannedSource } from '@modoki/engine/testing';

/**
 * #1894 — `cloneBackendPorts.mjs` is the effect-free half of `editorPorts.mjs`, split out so the
 * MCP servers can import the table without importing a CLI that runs at top level. Inside the
 * esbuild bundle (`engine/tools/modoki-mcp/dist/index.js`) an inlined module's `import.meta.url`
 * IS `process.argv[1]`, so an entry-point check there fires — beside a stdio protocol that owns
 * stdout. Running the module AS the entry point is that condition exactly.
 */
const SCRIPTS = path.resolve(__dirname, '..', '..', 'scripts');
const MODULE = path.join(SCRIPTS, 'cloneBackendPorts.mjs');

/** Relative imports of a module, transitively. */
function relativeImportGraph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readScannedSource(file).code; // a commented-out import is not an edge
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm)) {
    relativeImportGraph(path.resolve(path.dirname(file), m[1] ?? m[2]), seen);
  }
  return seen;
}

describe('cloneBackendPorts.mjs is effect-free (#1894)', () => {
  it('run as the entry point — the bundle\'s condition — it prints nothing and exits 0', () => {
    const r = spawnSync(process.execPath, [MODULE, 'backend'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('imports nothing with a top-level CLI (no entryPoint.mjs / editorPorts.mjs anywhere in its graph)', () => {
    const graph = [...relativeImportGraph(MODULE)].map((f) => path.basename(f)).sort();
    expect(graph).toEqual(['cloneBackendPorts.mjs', 'pathIdentity.mjs']);
    for (const f of relativeImportGraph(MODULE)) {
      // Comments stripped: the header EXPLAINS the hazard and names `process.argv` doing so.
      expect(readScannedSource(f).code, path.basename(f)).not.toMatch(/\bisEntryPoint\(|process\.argv/);
    }
  });

  it('editorPorts re-exports the SAME objects — one table, not a copy', () => {
    expect(editorPorts.CLONE_BACKEND_PORTS).toBe(clonePorts.CLONE_BACKEND_PORTS);
    expect(editorPorts.backendPortForClone).toBe(clonePorts.backendPortForClone);
    expect(editorPorts.backendUrlForClone).toBe(clonePorts.backendUrlForClone);
  });
});
