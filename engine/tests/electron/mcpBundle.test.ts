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

/**
 * C1 integration gate — the packaged "Connect Claude Code" MCP bundle.
 *
 * The packaged editor spawns the MCP with plain `node <REPO_ROOT>/…/dist/index.js` —
 * no tsx, no engine/tools/modoki-mcp/node_modules (that tool is NOT a root workspace,
 * so its deps may not ship). This mirrors the esbuild options in
 * engine/scripts/build-electron.mjs, bundles into an ISOLATED temp dir with nothing
 * else in it, and runs it there — so a green test PROVES zero runtime deps. A
 * regression that re-externalizes @modelcontextprotocol/sdk / zod (or breaks the
 * entry) fails here instead of only in a real DMG smoke.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const mcpEntry = path.resolve(here, '../../tools/modoki-mcp/src/index.ts');

describe('modoki-mcp packaged bundle', () => {
  it('bundles self-contained and prints the start banner when run standalone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mcp-bundle-'));
    // Output .mjs so the isolated dir needs no package.json `type:module` — this is a
    // STRICTER self-containment check than the shipped index.js (which relies on the
    // MCP package.json shipping alongside it). Options mirror build-electron.mjs.
    const outfile = path.join(dir, 'index.mjs');
    let child: import('child_process').ChildProcess | undefined;
    try {
      await esbuild.build({
        entryPoints: [mcpEntry],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        outfile,
        packages: 'bundle',
        logLevel: 'silent',
      });

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
