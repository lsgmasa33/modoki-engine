/**
 * Does `<dir>/node_modules` hold what `<dir>/package-lock.json` pins? (#2066 item 3)
 *
 * `build-electron.mjs` used to skip the modoki-mcp `npm install` whenever ONE file existed
 * (`@modelcontextprotocol/sdk/package.json`). A bump of the sdk or zod in the tool's package.json
 * then bundled the OLD deps into the shipped MCP server, with nothing reporting it.
 * `mcpBundle.test.ts` cannot see that, because it builds from the same stale tree.
 * `bootstrap-mcp-deps.mjs` dropped the identical existence skip for the same reason (#215's shape).
 *
 * The answer is derived from the INPUTS npm itself installs from, not from a marker anyone
 * maintains:
 *  - the lockfile's root entry must declare the same specs as package.json (a hand-edited
 *    package.json the lockfile has not caught up with), and
 *  - every package the lockfile pins must be installed at that version. An OPTIONAL entry
 *    that is absent is fine: those are the other platforms' binaries (esbuild's 25 siblings),
 *    which npm never installs here.
 *
 * Pure apart from reading files, and never throws: an unreadable lockfile is a reason to
 * install, not a crash. Returns the reasons (empty = current), capped at a few — enough to
 * say why, not a dump.
 */
import path from 'node:path';
import { readJsonFile } from './jsonFile.mjs'; // #1799: a BOM is read through

const MAX_REASONS = 5;

function readJson(p) {
  try { return readJsonFile(p); } catch { return null; }
}

/** @returns {string[]} why `dir`'s install is stale; empty when it matches the lockfile. */
export function staleAgainstLockfile(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const lock = readJson(path.join(dir, 'package-lock.json'));
  if (!pkg) return ['package.json unreadable'];
  if (!lock || typeof lock.packages !== 'object' || lock.packages === null) return ['no readable package-lock.json (v2+)'];

  const reasons = [];
  const root = lock.packages[''] ?? {};
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const want = pkg[field] ?? {};
    const have = root[field] ?? {};
    for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
      if (want[name] !== have[name]) reasons.push(`${field}.${name}: package.json ${want[name] ?? '(absent)'} vs lockfile ${have[name] ?? '(absent)'}`);
    }
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (reasons.length >= MAX_REASONS) break;
    if (!key.startsWith('node_modules/') || !entry || entry.link) continue;
    const installed = readJson(path.join(dir, key, 'package.json'));
    if (!installed) {
      if (!entry.optional) reasons.push(`${key.slice('node_modules/'.length)}: not installed (lockfile pins ${entry.version})`);
      continue;
    }
    if (installed.version !== entry.version) {
      reasons.push(`${key.slice('node_modules/'.length)}: installed ${installed.version}, lockfile pins ${entry.version}`);
    }
  }
  return reasons.slice(0, MAX_REASONS);
}

/** Bring `dir`'s install in line with its lockfile: run `install` when stale, then re-check and
 *  THROW if it is still stale. npm trusts its hidden lockfile (node_modules/.package-lock.json),
 *  so a tree that went stale behind it reports "up to date" and is never re-extracted (#685's
 *  state). Refusing there beats bundling the stale deps with only a log line to show for it.
 *  `label` names the dir in messages. Returns why it installed (empty = it was already current).
 *  @param {string} dir
 *  @param {string} label
 *  @param {{ install: () => void, log: (message: string) => void }} io
 *  @returns {string[]} */
export function ensureInstalledMatchesLockfile(dir, label, { install, log }) {
  const stale = staleAgainstLockfile(dir);
  if (!stale.length) return [];
  log(`${label} deps stale (${stale.join('; ')}) → npm install in ${label}`);
  install();
  const still = staleAgainstLockfile(dir);
  if (still.length) {
    throw new Error(`${label} deps still stale after npm install (${still.join('; ')}). ` +
      `npm trusts node_modules/.package-lock.json here and will not re-extract; remove ` +
      `${label}/node_modules and run npm install there.`);
  }
  return stale;
}
