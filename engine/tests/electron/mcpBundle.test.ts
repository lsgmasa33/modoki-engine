// @vitest-environment node
// esbuild relies on a native TextEncoder (its startup invariant); the default jsdom
// environment polyfills it and breaks esbuild, so this suite runs under node.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpOutfile, mcpOpts } from '../../scripts/mcpBuildOpts.mjs';

/**
 * C1 integration gate — the packaged "Connect Claude Code" MCP bundle.
 *
 * The packaged editor spawns the MCP with plain `node <REPO_ROOT>/…/dist/index.js` — no tsx, no
 * engine/tools/modoki-mcp/node_modules (that tool is NOT a root workspace, so its deps may not
 * ship). `connectClaude.ts` writes that exact command into the user's `.mcp.json` for packaged
 * on every platform, and for dev on Windows.
 *
 * TWO claims, deliberately split — they are not the same question (#945 B1):
 *
 *  1. **The SHIPPED artifact runs.** `dist/index.js` — the file `connectClaude.ts` names — is
 *     present, no older than its entry, and prints the start banner when spawned. This suite
 *     used to make no such claim: it re-ran esbuild with options its own comment said "mirror
 *     build-electron.mjs" and spawned that third copy, so a stale or broken `dist/index.js`
 *     could not fail it — and the inlined options had ALREADY drifted from `mcpOpts` in two
 *     fields while staying green. The options now come from `scripts/mcpBuildOpts.mjs`, which
 *     `build-electron.mjs` also imports, so there is one declaration and nothing to drift.
 *
 *  2. **The bundle is self-contained.** Built into an ISOLATED temp dir holding nothing else
 *     and run from there, so a green result PROVES zero runtime deps. The SHIPPED file cannot
 *     make this claim — it sits beside its own package.json and node_modules — which is why
 *     this case stays, rather than being replaced by claim 1.
 *
 * A regression that re-externalizes @modelcontextprotocol/sdk / zod, breaks the entry, or leaves
 * a stale `dist/` fails here instead of only in a real DMG smoke.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe('modoki-mcp packaged bundle', () => {
  it('bundles self-contained and prints the start banner when run standalone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mcp-bundle-'));
    // Output .mjs so the isolated dir needs no package.json `type:module` — this is a
    // STRICTER self-containment check than the shipped index.js (which relies on the
    // MCP package.json shipping alongside it).
    const outfile = path.join(dir, 'index.mjs');
    let child: import('child_process').ChildProcess | undefined;
    try {
      // The SHIPPED options, with exactly three overrides the isolation requires — spelled out
      // rather than restated, so a change to `mcpOpts` reaches this case instead of drifting
      // past it. `sourcemap: false` keeps the readdir assertion below exact.
      await esbuild.build({ ...mcpOpts, outfile, sourcemap: false, logLevel: 'silent' });

      // The isolated dir must hold ONLY the bundle (proving no sibling node_modules
      // is consulted). Sourcemaps aren't emitted (no `sourcemap`), so this is exact.
      expect(fs.readdirSync(dir).sort()).toEqual(['index.mjs']);

      const banner = await new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, [outfile], {
          cwd: dir, // run FROM the empty dir — no repo node_modules on the resolution path
          env: { ...process.env, MODOKI_BACKEND: 'http://127.0.0.1:5179' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child = p;
        let err = '';
        p.stderr.on('data', (d) => {
          err += d;
          if (/\[modoki-mcp\] started/.test(err)) {
            p.kill();
            resolve(err);
          }
        });
        p.on('error', reject);
        const timer = setTimeout(() => {
          p.kill();
          reject(new Error(`no start banner within timeout. stderr:\n${err}`));
        }, 8000);
        p.on('exit', () => clearTimeout(timer));
      });

      expect(banner).toMatch(/\[modoki-mcp\] started — backend http:\/\/127\.0\.0\.1:5179/);
    } finally {
      // The spawned MCP runs with cwd=dir, so on Windows the dir can't be removed while it
      // lives (EBUSY) — macOS/Linux allow it, which is why this only bit here. Kill it and
      // WAIT for exit (releasing the cwd handle) before rmSync; maxRetries covers any lag.
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((r) => {
          const t = setTimeout(r, 3000);
          child!.once('exit', () => { clearTimeout(t); r(); });
        });
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 20000);
});

/** Claim 1 — the artifact that SHIPS. Everything above builds its own copy; this drives the file
 *  `connectClaude.ts` actually names.
 *
 *  ⚠️ **Skipped when `dist/index.js` is absent** — the bundle is produced by
 *  `npm run build:electron`, which a plain `npm run verify` does not run, so requiring it would
 *  redden the gate on a fresh clone for a file nothing has built yet.
 *
 *  ⚠️ **Be precise about what that skip costs, because it is more than "a fresh clone".** `dist/`
 *  is gitignored, and no CI leg builds it: the private `ci.yml` is retired in practice (CLAUDE.md
 *  § Tests — do not describe it as a gate that exists), and the FREE public CI on the
 *  `modoki-engine` mirror is a subset gate over a transformed snapshot that does not run
 *  `build:electron` either. So **both cases here skip on every CI run** — they are live only on a
 *  machine that has packaged at some point. These are a developer-machine guard, not a CI gate,
 *  and the thing that actually stops a stale bundle shipping is that every packaging path re-runs
 *  `build-electron` before packing. Said plainly so the coverage is not overread.
 *
 *  ⚠️ **On a clone that HAS a `dist/`, this reddens `verify` after any change to the MCP source
 *  until `npm run build:electron` runs** — including one that arrives via a `git merge`, which is
 *  how it first fired: main brought #889's `contracts.ts` changes in and the local bundle was
 *  behind. That is the guard working (a Windows dev editor spawns this exact file), but it is a
 *  real cost on every clone, so it is called out here rather than discovered. */
describe('the SHIPPED modoki-mcp bundle (#945 B1)', () => {
  const shipped = fs.existsSync(mcpOutfile);

  it.skipIf(!shipped)('is byte-identical to what the current source produces', async () => {
    // ⚠️ **Content, not mtime — and this is the case that actually covers the class.** The first
    // version of this compared `dist/index.js`'s mtime against `src/index.ts`'s, which was wrong
    // twice over: the bundle inlines 22 source files PLUS node_modules, so `touch`ing
    // `registerAll.ts` left it green with a genuinely stale artifact (measured); and an mtime
    // comparison against a TRACKED file reddens after any `git merge`/`checkout` that rewrites
    // that file's mtime without changing what it produces — a false red on a step `verify` does
    // not even run. Rebuilding with the shared options and diffing the bytes has neither problem:
    // any change to any input changes the output, and nothing else does.
    //
    // This is NOT the "rebuild your own copy" defect #945 is about. The rebuild here is an
    // ORACLE for currency; the artifact under test is still the shipped file, which the next case
    // spawns. Restating the options would be the defect — they come from `mcpBuildOpts.mjs`.
    // ⚠️ **esbuild's bundle output is `process.cwd()`-dependent** — the same options run from `/`
    // produce a different byte count than from the repo root, because the module-path comments it
    // emits are relative to the cwd. This case is valid only because npm runs BOTH vitest and
    // `build:electron` from the repo root; invoked from elsewhere it would report a false STALE.
    // If this ever needs to survive an arbitrary cwd, pin `absWorkingDir` in `mcpOpts`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mcp-current-'));
    try {
      // Same basename, because `sourcemap: true` bakes `//# sourceMappingURL=<basename>.map`
      // into the output — a different name would diff on that line alone.
      const fresh = path.join(dir, path.basename(mcpOutfile));
      await esbuild.build({ ...mcpOpts, outfile: fresh, logLevel: 'silent' });
      // ⚠️ **The message below carries a FIX and a WHY, and both halves are load-bearing — do not
      // trim it to just the command.** Field-tested: this guard fired at the hub on its first
      // `verify` after integrating a batch, on a `dist/` that clone had packaged long before,
      // against MCP source that arrived in someone ELSE's branch. The hub reported that the
      // "packaged editor spawns it / connectClaude.ts writes it into .mcp.json" half is what
      // stopped them looking for a defect in the merged branch's diff. A red whose cause the
      // reader cannot place gets attributed to the wrong change, or the gate gets disabled.
      expect(
        fs.readFileSync(mcpOutfile, 'utf8'),
        `${path.relative(here, mcpOutfile)} is STALE — it is not what the current source builds. `
          + 'Run `npm run build:electron`. This file is what the packaged editor spawns, and what '
          + "`connectClaude.ts` writes into the user's .mcp.json for packaged on every platform "
          + 'AND for dev on Windows — so a stale copy here is what a real user runs.',
      ).toBe(fs.readFileSync(fresh, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it.skipIf(!shipped)('prints the start banner when spawned the way connectClaude.ts spawns it', async () => {
    let child: import('child_process').ChildProcess | undefined;
    try {
      const banner = await new Promise<string>((resolve, reject) => {
        // `node <abs>`, exactly the command written into the user's .mcp.json — no tsx, no
        // loader flags, and cwd deliberately somewhere unrelated so nothing is resolved
        // relative to the repo.
        const p = spawn(process.execPath, [mcpOutfile], {
          cwd: os.tmpdir(),
          env: { ...process.env, MODOKI_BACKEND: 'http://127.0.0.1:5179' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child = p;
        let err = '';
        p.stderr.on('data', (d) => {
          err += d;
          if (/\[modoki-mcp\] started/.test(err)) { p.kill(); resolve(err); }
        });
        p.on('error', reject);
        const timer = setTimeout(() => { p.kill(); reject(new Error(`no start banner within timeout. stderr:\n${err}`)); }, 8000);
        p.on('exit', () => clearTimeout(timer));
      });
      expect(banner).toMatch(/\[modoki-mcp\] started — backend http:\/\/127\.0\.0\.1:5179/);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((r) => {
          const t = setTimeout(r, 3000);
          child!.once('exit', () => { clearTimeout(t); r(); });
        });
      }
    }
  }, 20000);
});
