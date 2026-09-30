/**
 * The `chrome-devtools` MCP server as the committed `.mcp.json` starts it (#1894):
 *
 *   npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:<MODOKI_CDP_PORT || 9222>
 *
 * The port used to sit in `.mcp.json` itself as `${MODOKI_CDP_PORT:-9222}`. Claude Code evaluates
 * such an expansion once BEFORE `.claude/settings.local.json`'s `env` applies and once after, and
 * when the answers differ it connects BOTH — so every worker session ran a second chrome-devtools
 * server attached to the hub's 9222. Reading the variable HERE, at spawn, leaves the config a
 * literal that reads the same both times. `||` rather than `??`: an empty value falls back, as
 * `:-` did.
 *
 * A transparent wrapper: stdio is inherited (the MCP protocol flows straight through), extra
 * arguments are passed on, the child's exit code is ours, a signal that kills us is forwarded to
 * it, and a child that dies BY a signal is re-raised on this process so the parent sees the same
 * death it would have seen without the wrapper.
 */
import { spawn } from 'node:child_process';
import { isEntryPoint } from './entryPoint.mjs';
import { toSpawn } from './winSpawn.mjs';

/** The CDP port the server attaches to. */
export function cdpPortFromEnv(env = process.env) {
  return env.MODOKI_CDP_PORT || '9222';
}

/** The `npx` argument list, extra arguments appended. */
export function chromeDevtoolsArgs(env = process.env, extra = []) {
  return ['-y', 'chrome-devtools-mcp@latest', `--browser-url=http://127.0.0.1:${cdpPortFromEnv(env)}`, ...extra];
}

/** Signals we pass on. SIGKILL cannot be caught, so a killed wrapper orphans the child exactly as
 *  a killed `npm exec` did before it — the stdio pipe closing is what ends it then. */
export const FORWARDED_SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Run a `toSpawn` result as a transparent child of this process: inherited stdio, forwarded
 * signals, and this process ends the way the child did. Exported so a test can drive it with a
 * stub child instead of a real `npx`.
 *
 * @param {{ command: string, args: readonly string[], options?: import('node:child_process').SpawnOptions }} s
 */
export function runTransparent(s) {
  const { command } = s;
  const child = spawn(command, s.args, { ...s.options, stdio: 'inherit' });
  /** @type {Record<string, () => void>} */
  const handlers = {};
  for (const sig of FORWARDED_SIGNALS) {
    handlers[sig] = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Windows can deliver SIGHUP (console close) but cannot SEND it — `kill('SIGHUP')` throws
      // ENOSYS there, which in a signal handler is an uncaught crash. Fall back to the default.
      try { child.kill(sig); } catch { child.kill(); }
    };
    process.on(sig, handlers[sig]);
  }
  child.on('error', (err) => {
    process.stderr.write(`[chrome-devtools-mcp wrapper] could not start ${command}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    for (const sig of FORWARDED_SIGNALS) process.off(sig, handlers[sig]);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  return child;
}

if (isEntryPoint(import.meta.url)) {
  // `toSpawn` resolves `npx` to `npx.cmd` on Windows and runs it without handing a shell a
  // command line (docs/windows.md § "Never hand a shell a command line").
  runTransparent(toSpawn('npx', chromeDevtoolsArgs(process.env, process.argv.slice(2))));
}
