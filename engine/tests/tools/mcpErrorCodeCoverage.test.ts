/** Every DOCUMENTED failure code must actually be emitted, and an aim refusal must arrive under
 *  the specific one.
 *
 *  `docs/mcp-tool-conventions.md` §5 defines a CLOSED code set, and its worked example is
 *  `{"code":"AMBIGUOUS","tool":"modoki_set_transform"}`. Measured against a live editor, that call
 *  answered `REFUSED_BY_OP`: AMBIGUOUS, AMBIGUOUS_SURFACE and OCCLUDED appeared nowhere in the
 *  source at all, so every refusal — ambiguous aim, occluded aim, bad enum, wrong play state —
 *  arrived under one code and an agent could only tell them apart by string-matching the prose.
 *  That is precisely what a closed code set exists to avoid.
 *
 *  Two guards, because either alone is weak: the sweep proves the codes EXIST in the surface, and
 *  the round-trip proves one actually SURVIVES the backend → envelope hop. */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSurface, STUB_BACKEND, type Surface } from './mcpSurface';
import { ERROR_CODES } from '../../tools/modoki-mcp/src/result';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

const ROOT = join(__dirname, '../..');
/** Where a code may legitimately be produced: the tool server, and the two layers that classify a
 *  refusal BEFORE it gets there (the renderer's aim resolver, and the Electron input routes that
 *  carry its verdict out as HTTP). */
const EMIT_ROOTS = [
  'tools/modoki-mcp/src',
  'tools/shared',
  'app/debug',
  'electron',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('every documented error code is emitted somewhere', () => {
  const sources = EMIT_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => readFileSync(f, 'utf-8'))
    .join('\n');

  it.each(ERROR_CODES)('%s appears as a produced code, not just in the enum', (code) => {
    // Quoted, so AMBIGUOUS does not get its coverage from AMBIGUOUS_SURFACE, and the enum
    // declaration itself (a bare list) is not what satisfies the check.
    const occurrences = sources.split(`'${code}'`).length - 1;
    expect(
      occurrences,
      `${code} is documented in ERROR_CODES but never produced. Emit it where that condition is ` +
      'detected, or remove it from the set — a documented code nothing emits is a promise the ' +
      'surface does not keep.',
    ).toBeGreaterThan(1); // >1: the enum entry itself is one of them
  });
});

describe('a backend-classified refusal keeps its specific code', () => {
  it.each([
    ['AMBIGUOUS', '3 entities are named "DUP_probe" (a, b, c) — address by guid'],
    ['AMBIGUOUS_SURFACE', 'entity X is a 3d entity, so you must say WHICH on-screen surface to aim in'],
    ['OCCLUDED', "entity X is not clickable in 'game-3d': a click at its aim point selects Wall"],
  ] as const)('%s survives the 400 → envelope hop instead of flattening to REFUSED_BY_OP', async (code, why) => {
    surface = loadSurface((req) =>
      req.path === '/api/input/tap' ? { status: 400, body: { error: why, errorCode: code } } : undefined);
    const r = await surface.call('modoki_tap', { entity: { name: 'DUP_probe', surface: 'game-3d' } });
    expect(r.isError).toBe(true);
    const err = JSON.parse(surface.text(r as never)).error;
    expect(err.code).toBe(code);
    // The prose is still the explanation — the code is the machine-readable half, not a swap.
    expect(err.why).toContain(why.slice(0, 20));
  });

  it('an UNKNOWN errorCode string is ignored — a code is only a code if it is in the closed set', async () => {
    surface = loadSurface((req) =>
      req.path === '/api/input/tap' ? { status: 400, body: { error: 'nope', errorCode: 'SOMETHING_NEW' } } : undefined);
    const r = await surface.call('modoki_tap', { entity: { name: 'X', surface: 'game-3d' } });
    const err = JSON.parse(surface.text(r as never)).error;
    expect(err.code).toBe('REFUSED_BY_OP');
  });

  it('a refusal with no errorCode still classifies the old way', async () => {
    surface = loadSurface((req) =>
      req.path === '/api/input/tap' ? { status: 400, body: { error: 'plain refusal' } } : undefined);
    const r = await surface.call('modoki_tap', { entity: { name: 'X', surface: 'game-3d' } });
    const err = JSON.parse(surface.text(r as never)).error;
    expect(err.code).toBe('REFUSED_BY_OP');
  });
});

void STUB_BACKEND;
