import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BACKEND_PORT,
  RESERVED_BACKEND_PORTS,
  parseBackendPort,
  portCandidates,
  readLastPort,
  writeLastPort,
} from '../../electron/backendPort';

/**
 * C5 unit gate — the STICKY backend-port ladder (docs/connect-claude-code.md, C5).
 *
 * The backend port is the MCP target baked into the user's .mcp.json, and Claude Code can
 * only pick up a change by RESTARTING. The old logic fell back to a RANDOM ephemeral port
 * the moment 5179 was taken, so every launch drew a new port and silently staled the
 * config (observed live: the 0.2.12 DMG bound 62681). The load-bearing property here:
 * the LAST-BOUND port is tried FIRST, so a relaunch reuses it whenever it's free.
 */
describe('portCandidates', () => {
  it('prefers the last-bound port first (the sticky property)', () => {
    const c = portCandidates({ lastPort: 62681 });
    expect(c[0]).toBe(62681);
    expect(c[1]).toBe(DEFAULT_BACKEND_PORT); // then the conventional default
  });

  it('falls back to a deterministic scan from the default when there is no memory', () => {
    const c = portCandidates({ lastPort: null });
    expect(c[0]).toBe(5179); // the conventional port — a lone consumer editor lands here
    expect(c.slice(0, 3)).toEqual([5179, 5182, 5183]); // deterministic, not random; 5180/5181 skipped
  });

  it('NEVER offers a reserved pinned-contract port (5180/5181/5188)', () => {
    // 5180/5181 are the two-clone dev editors, 5188 the packaged-smoke gate. An unpinned
    // editor squatting one — and then persisting it — permanently breaks `npm run
    // editor:ai` / `verify:packaged` (they pin it and exit(1) rather than drift).
    const c = portCandidates({ lastPort: null, span: 20 });
    for (const reserved of RESERVED_BACKEND_PORTS) expect(c).not.toContain(reserved);
  });

  it('drops a RESERVED last-bound port (a squat persisted by an older build must not resurrect)', () => {
    const c = portCandidates({ lastPort: 5180 });
    expect(c).not.toContain(5180);
    expect(c[0]).toBe(5179);
  });

  it('a pinned reserved port IS honored (pinning 5180 is how a dev clone claims it)', () => {
    expect(portCandidates({ pinned: 5180 })).toEqual([5180]);
  });

  it('a pinned port is the ONLY candidate (never drift off an explicit MCP target)', () => {
    expect(portCandidates({ pinned: 5181, lastPort: 62681 })).toEqual([5181]);
  });

  it('dedupes when the last-bound port IS the default', () => {
    const c = portCandidates({ lastPort: 5179 });
    expect(c.filter((p) => p === 5179)).toHaveLength(1);
    expect(c[0]).toBe(5179);
  });

  it('ignores an invalid/out-of-range last port and still offers the scan', () => {
    for (const bad of [0, -1, 70000, 1.5, NaN]) {
      const c = portCandidates({ lastPort: bad });
      expect(c[0], `lastPort=${bad}`).toBe(5179);
      expect(c).not.toContain(bad);
    }
  });

  it('ignores an invalid pinned port rather than returning an unbindable candidate', () => {
    expect(portCandidates({ pinned: NaN, lastPort: null })[0]).toBe(5179);
  });

  it('honors a custom base/span', () => {
    expect(portCandidates({ base: 6000, span: 3, reserved: [] })).toEqual([6000, 6001, 6002]);
  });

  it('never contains duplicates', () => {
    const c = portCandidates({ lastPort: 5182 });
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('parseBackendPort', () => {
  // The SINGLE source of truth for "is MODOKI_BACKEND_PORT usable". main.ts keys its
  // fail-loud guard off this, so a value that parses here but not there (or vice-versa)
  // is exactly the drift bug: a typo'd pin silently binding another clone's port.
  it('parses a valid port', () => {
    expect(parseBackendPort('5181')).toBe(5181);
  });
  it('null for absent / empty / whitespace', () => {
    expect(parseBackendPort(undefined)).toBeNull();
    expect(parseBackendPort(null)).toBeNull();
    expect(parseBackendPort('')).toBeNull();
    expect(parseBackendPort('   ')).toBeNull();
  });
  it('null for garbage / out-of-range (caller must FAIL LOUD, not drift)', () => {
    for (const bad of ['5181x', 'abc', '0', '-1', '70000', '1.5', 'NaN']) {
      expect(parseBackendPort(bad), `MODOKI_BACKEND_PORT=${bad}`).toBeNull();
    }
  });
});

describe('last-port persistence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-port-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('null when nothing remembered', () => {
    expect(readLastPort(dir)).toBeNull();
  });

  it('round-trips a bound port', () => {
    writeLastPort(dir, 5179);
    expect(readLastPort(dir)).toBe(5179);
    writeLastPort(dir, 62681);
    expect(readLastPort(dir)).toBe(62681);
  });

  it('creates the userData dir if missing', () => {
    const nested = path.join(dir, 'sub', 'user-data');
    writeLastPort(nested, 5185);
    expect(readLastPort(nested)).toBe(5185);
  });

  it('null on a corrupt / nonsense pref (falls back to the ladder)', () => {
    fs.writeFileSync(path.join(dir, 'backend-port.json'), '{ not json');
    expect(readLastPort(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'backend-port.json'), JSON.stringify({ port: 'nope' }));
    expect(readLastPort(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'backend-port.json'), JSON.stringify({ port: 70000 }));
    expect(readLastPort(dir)).toBeNull();
  });

  it('a write failure never throws (remembering a port is best-effort)', () => {
    // A path that cannot be created (a file where the dir should be).
    const file = path.join(dir, 'blocker');
    fs.writeFileSync(file, 'x');
    expect(() => writeLastPort(path.join(file, 'nested'), 5179)).not.toThrow();
  });

  it('sticky round-trip: a remembered port leads the next launch\'s candidates', () => {
    writeLastPort(dir, 62681);
    expect(portCandidates({ lastPort: readLastPort(dir) })[0]).toBe(62681);
  });
});
