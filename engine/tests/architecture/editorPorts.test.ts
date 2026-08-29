/** The clone → editor-backend-port table has ONE authored home, and the docs match it (#349).
 *
 *  `engine/scripts/editorPorts.mjs` is that home. Before it, the same five-row table was
 *  copy-pasted into `launch-editor.sh` (as a bare `5179` default), `relaunch-editor.sh` (as a
 *  branch `case`), `package.json` (two hardcoded pins) and `.mcp.json`. Two of those four had
 *  ALREADY drifted by the time anyone looked:
 *
 *    - `relaunch-editor.sh` mapped `work-ai` and `work-ai2` and stopped there, so `work-ai3`
 *      and `work-qa` fell through to the `*)` arm — 5179, the HUB's port. Its own comment said
 *      "Must list EVERY worker branch: an unlisted one falls through to 5179, which is the MAIN
 *      clone's backend port". The comment was right, was read, and did not stop the drift.
 *    - `clonePortHardcoding.test.ts`'s own CLONE_PORTS list stopped at three clones while five
 *      existed, so it could not have caught either.
 *
 *  That is why this is a TEST and not a sixth comment. It asserts two things a comment cannot:
 *  that the docs still say what the code says, and that nobody has re-introduced a literal
 *  hub-port default in a file every clone reads.
 *
 *  Why it matters more than a normal config drift: the backend port is the MCP target. A worker
 *  clone that resolves 5179 while the hub's editor is up does not fail — every `modoki_*` call
 *  SUCCEEDS against the hub's checkout. Measured in `~/.modoki/editor-launches.log`: three
 *  worker-clone launches landed on 5179, one (modoki-qa, 2026-08-25) with a live hub editor. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { hasPrivateTooling } from '../helpers/repoLayout';
import {
  CLONE_BACKEND_PORTS,
  HUB_BACKEND_PORT,
  backendPortForClone,
  vitePortForBackend,
  cdpPortForBackend,
  backendUrlForClone,
} from '../../scripts/editorPorts.mjs';

const REPO = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
// engine/scripts/** and the committed agent-CLI configs are private-repo-only; the public
// engine snapshot ships neither, so there is nothing to assert there.
const skip = !hasPrivateTooling();

/** Every `| ~/Projects/<dir> … | <port> |` row of a markdown table, as dir → first port cell.
 *  Both CLAUDE.md § Clones and docs/clones-and-ports.md § RULE 2 use this shape; the port is
 *  the first cell after the directory that is a bare 4-digit number (CLAUDE.md puts the branch
 *  in between, and the doc writes main's as `5179 (default)`). */
function portsFromMarkdownTable(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of src.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const dir = /~\/Projects\/([A-Za-z0-9._-]+)/.exec(line)?.[1];
    if (!dir) continue;
    const cells = line.split('|').map((c) => c.trim());
    const dirCell = cells.findIndex((c) => c.includes(`~/Projects/${dir}`));
    for (const cell of cells.slice(dirCell + 1)) {
      const m = /^(\d{4})\b/.exec(cell.replace(/`/g, ''));
      if (m) {
        out[dir] = Number(m[1]);
        break;
      }
    }
  }
  return out;
}

describe.skipIf(skip)('editorPorts.mjs is the one home for the clone → backend port table (#349)', () => {
  it('resolves each known clone directory to its pinned port', () => {
    expect(backendPortForClone('/Users/someone/Projects/modoki')).toBe(5179);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai')).toBe(5180);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai2')).toBe(5181);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai3')).toBe(5182);
    expect(backendPortForClone('/Users/someone/Projects/modoki-qa')).toBe(5183);
  });

  it('resolves an UNKNOWN clone to null (auto ports), never to a pinned lane', () => {
    // The whole bug in one assertion. Any non-null fallback here is correct on exactly one
    // clone and silently wrong on the rest — and `bugfix-qa` in the launch log proves scratch
    // clones are a real thing people make, so refusing outright would be wrong too.
    expect(backendPortForClone('/Users/someone/Projects/bugfix-qa')).toBeNull();
    expect(backendPortForClone('/tmp/throwaway')).toBeNull();
    expect(backendUrlForClone('/tmp/throwaway')).toBeNull();
  });

  it('does not resolve on a PREFIX or SUFFIX of a known clone name', () => {
    // `basename` equality, not `startsWith` — `modoki-ai-scratch` is somebody's scratch clone,
    // not work-ai's lane, and a sloppy match would hand it a live sibling's MCP target.
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai-scratch')).toBeNull();
    expect(backendPortForClone('/Users/someone/Projects/my-modoki')).toBeNull();
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai4')).toBeNull();
  });

  it('ignores a trailing separator, so a caller passing `${REPO}/` is not silently unknown', () => {
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai/')).toBe(5180);
  });

  it('derives Vite and CDP from the backend port the way the launcher does', () => {
    // Mirrors launch-editor.sh's DERIVED_VITE / DERIVED arithmetic. Duplicated there in bash
    // (it cannot import this), so pin the formula on both sides of the seam.
    expect(vitePortForBackend(HUB_BACKEND_PORT)).toBe(5173);
    expect(cdpPortForBackend(HUB_BACKEND_PORT)).toBe(9222);
    expect(vitePortForBackend(5183)).toBe(5177);
    expect(cdpPortForBackend(5183)).toBe(9226);
  });

  it('assigns every clone a DISTINCT port — the entire point of the table', () => {
    const ports = Object.values(CLONE_BACKEND_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe.skipIf(skip)('the docs still say what the table says', () => {
  // The drift this catches is not cosmetic: a human reads the doc table to decide what to pass
  // to MODOKI_BACKEND_PORT, so a doc that disagrees with the code hands them a sibling's lane.
  for (const [doc, section] of [
    ['CLAUDE.md', '§ Clones'],
    ['docs/clones-and-ports.md', '§ RULE 2'],
  ] as const) {
    it(`${doc} ${section} lists the same clone → backend port pairs`, () => {
      const documented = portsFromMarkdownTable(read(doc));
      expect(
        Object.keys(documented).length,
        `${doc} — parsed no \`~/Projects/<clone>\` table rows at all. Either the table moved or its `
        + 'shape changed; fix the parser here rather than deleting the assertion, or this guard '
        + 'starts passing vacuously (which is how the old comment-only convention failed).',
      ).toBeGreaterThanOrEqual(5);
      expect(documented).toEqual(
        // Only the clones the doc actually lists — the Windows clone has a row but no
        // `~/Projects/` path and no assigned port, so it is absent from both sides.
        Object.fromEntries(Object.entries(CLONE_BACKEND_PORTS).filter(([dir]) => dir in documented)),
      );
      // …and nothing documented is missing from the code table.
      for (const dir of Object.keys(documented)) {
        expect(
          CLONE_BACKEND_PORTS[dir],
          `${doc} documents clone '${dir}' but editorPorts.mjs does not know it — add it to `
          + 'CLONE_BACKEND_PORTS, or that clone gets AUTO ports and no stable MCP target.',
        ).toBeDefined();
      }
    });
  }

  it('docs/clones-and-ports.md § RULE 2 also agrees on the derived Vite and CDP columns', () => {
    const src = read('docs/clones-and-ports.md');
    let checked = 0;
    for (const line of src.split('\n')) {
      const dir = /~\/Projects\/([A-Za-z0-9._-]+)/.exec(line)?.[1];
      if (!dir || !(dir in CLONE_BACKEND_PORTS)) continue;
      const nums = [...line.matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
      // backend, vite, cdp — in column order. Later cells hold the example launch command,
      // which repeats the backend port; the first three are the columns.
      const [backend, vite, cdp] = nums;
      if (backend !== CLONE_BACKEND_PORTS[dir]) continue; // a non-RULE-2 table; the test above owns it
      expect({ dir, vite, cdp }).toEqual({
        dir,
        vite: vitePortForBackend(backend),
        cdp: cdpPortForBackend(backend),
      });
      checked++;
    }
    // Without this the test is one `continue` away from vacuous: drop the `~/Projects/` prefix
    // from the table and it checks nothing and passes. It survives today only because the test
    // above would catch that same edit — a guard that depends on a sibling guard to not be
    // hollow is the shape of guard this whole file exists to replace.
    expect(checked, 'parsed no RULE 2 rows to check — fix the parser, do not delete the test')
      .toBe(Object.keys(CLONE_BACKEND_PORTS).length);
  });
});

describe.skipIf(skip)('no shared script re-introduces a hardcoded hub-port default', () => {
  /** Files every clone runs, which USED to bake in a port. Listed explicitly (not globbed) so
   *  that deleting one from this list is a visible act rather than a silent loss of coverage. */
  const SHARED = [
    'engine/scripts/launch-editor.sh',
    'engine/scripts/relaunch-editor.sh',
    // test-packaged.sh is the one that bites twice: it never had its own default (the pin
    // arrived as a literal prefix on two npm scripts), and main.ts's sticky-then-scan starts
    // at 5179 — so an unpinned packaged launch lands on the hub's port. It also sits in
    // NEITHER of the older guard's lists, so nothing but this line covers it.
    'engine/scripts/test-packaged.sh',
    'engine/scripts/resave-scenes.sh',
    'engine/scripts/resave-prefabs.sh',
    'engine/scripts/migrate-legacy-scenes.mjs',
    'package.json',
  ];

  /** A port used as a DEFAULT or a PIN — `${VAR:-5179}`, `PORT=5179`, `:-http://…:5179`.
   *  Deliberately not "any occurrence of 5179": these files legitimately explain the hazard in
   *  prose, and the arithmetic `5173 + (backend − 5179)` in launch-editor.sh is the derivation
   *  itself, not a default. Comment lines are stripped before matching for the same reason. */
  //  The `["']?` is not decoration: this repo's dominant bash style QUOTES the value, and the
  //  change that introduced this guard writes `PORT="${MODOKI_BACKEND_PORT:-$(…)}"`. Without it
  //  the guard matched `PORT=5179` but sailed straight past `PORT="5179"` — i.e. it would have
  //  missed the regression written in the same style as the fix.
  const DEFAULTED_PORT = /(?::-|=|:)\s*["']?(?:http:\/\/(?:127\.0\.0\.1|localhost):)?(517[3-9]|518[0-3]|922[2-6])\b/;

  function stripComments(src: string, rel: string): string {
    const lines = src.split('\n');
    const isComment = rel.endsWith('.mjs')
      ? (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)
      : (l: string) => /^\s*#/.test(l);
    return lines.filter((l) => !isComment(l)).join('\n');
  }

  for (const rel of SHARED) {
    it(`${rel} derives its backend port instead of defaulting to one`, () => {
      if (!existsSync(path.join(REPO, rel))) return;
      const code = stripComments(read(rel), rel);
      const hit = DEFAULTED_PORT.exec(code);
      expect(
        hit?.[0] ?? null,
        `${rel} defaults or pins a per-clone port (${hit?.[1]}). That value is correct on exactly `
        + 'one clone and SILENTLY wrong on the other four — an MCP session then drives a sibling '
        + "checkout and every call succeeds. Derive it from editorPorts.mjs instead "
        + '(`$(node "$REPO/engine/scripts/editorPorts.mjs" backend)` from bash, or import '
        + '`backendPortForClone` / `backendUrlForClone` from Node).',
      ).toBeNull();
    });
  }

  it('the shared-script list still names files that exist', () => {
    // A renamed script would otherwise drop out of the guard silently — the failure mode this
    // whole file exists to prevent, applied to the guard itself.
    expect(SHARED.filter((rel) => !existsSync(path.join(REPO, rel)))).toEqual([]);
  });
});
