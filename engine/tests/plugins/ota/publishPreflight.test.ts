/** `otaPublishPreflight` — THE publish-request check both OTA entry points run (#827): the editor's
 *  `/api/ota/publish` route and `ota-publish.mjs`.
 *
 *  Behaviour first (every refusal reachable, in order, and the accept side), then the wiring that
 *  keeps it the ONE check: both entry points call it, neither re-composes a step of it beside it, and
 *  each side's refusal-wording map covers every refusal — so a refusal added here cannot ship with an
 *  entry point that answers it with `undefined`. The by-hand spawn cover (an unlisted sub-game name
 *  refused before any upload) is `otaPublishReleaseRace.test.ts` test q. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { otaPublishPreflight, readRawOtaBlock, OTA_PUBLISH_REFUSALS } from '../../../scripts/ota/publishPreflight.mjs';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let repoRoot: string;
const KEY = { publicKey: 'pub-A', privateKey: 'priv-A' };

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ota-preflight-'));
  fs.mkdirSync(path.join(repoRoot, 'build', 'ota-keys'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'), JSON.stringify(KEY));
});
afterEach(() => { fs.rmSync(repoRoot, { recursive: true, force: true }); });

const OTA = { enabled: true, bundleName: 'shell', subgames: ['mini'], publicKey: 'pub-A' };
const req = (over: Record<string, unknown> = {}) => ({
  ota: OTA, name: 'shell', version: 'v1', keyName: 'default', bucket: 'gs://b/p', repoRoot, ...over,
}) as Parameters<typeof otaPublishPreflight>[0];
const refusalOf = (over: Record<string, unknown> = {}) => {
  const r = otaPublishPreflight(req(over));
  return r.ok ? 'ok' : r.refusal;
};

describe('readRawOtaBlock — the one config read both entry points share', () => {
  it('returns the raw block WITHOUT coercion — a non-string subgames entry survives to be refused', () => {
    fs.writeFileSync(path.join(repoRoot, 'project.config.json'), JSON.stringify({ ota: { ...OTA, subgames: ['mini', 7] } }));
    const raw = readRawOtaBlock(repoRoot);
    expect(raw).toMatchObject({ ok: true, ota: { subgames: ['mini', 7] } });
    if (!raw.ok) throw new Error('unreachable');
    expect(refusalOf({ ota: raw.ota, name: 'mini' })).toBe('bad-project-subgames');
  });

  it('distinguishes a missing file from an unparseable one', () => {
    expect(readRawOtaBlock(repoRoot)).toMatchObject({ ok: false, reason: 'missing' });
    fs.writeFileSync(path.join(repoRoot, 'project.config.json'), '{ nope');
    expect(readRawOtaBlock(repoRoot)).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});

describe('otaPublishPreflight — accept side', () => {
  it('the shell\'s own name publishes the shell, echoing the CHECKED inputs and the keypair', () => {
    const r = otaPublishPreflight(req());
    expect(r).toMatchObject({ ok: true, target: { kind: 'shell' }, version: 'v1', bucket: 'gs://b/p', name: 'shell', keyName: 'default' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.keypair).toEqual(KEY);
  });

  it('a LISTED sub-game publishes that sub-game', () => {
    expect(otaPublishPreflight(req({ name: 'mini' }))).toMatchObject({ ok: true, target: { kind: 'subgame', id: 'mini' } });
  });

  it('an ABSENT bundleName is the default ("shell"), and absent subgames are none — what Project Settings writes', () => {
    const raw = { enabled: true, publicKey: 'pub-A' };
    expect(otaPublishPreflight(req({ ota: raw }))).toMatchObject({ ok: true, target: { kind: 'shell' }, bundleName: 'shell', subgames: [] });
  });
});

describe('otaPublishPreflight — every refusal, each reachable on its own', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no-ota-block', { ota: undefined }],
    ['not-enabled', { ota: { ...OTA, enabled: false } }],
    ['not-enabled', { ota: { ...OTA, enabled: 'false' } }],
    ['bad-version', { version: 'v 1' }],
    ['bad-name', { name: 'shell/v2' }],
    ['bad-key-name', { keyName: '../../etc/x' }],
    ['bad-bucket', { bucket: 'gs://b; rm -rf ~' }],
    ['bad-project-bundle-name', { ota: { ...OTA, bundleName: 42 } }],
    ['bad-project-subgames', { ota: { ...OTA, subgames: 'mini' } }],
    ['bad-project-retain-versions', { ota: { ...OTA, retainVersions: 0 } }],
    ['ambiguous-bundle', { ota: { ...OTA, subgames: ['shell'] } }],
    ['unknown-bundle', { name: 'not-listed' }],
    ['key-missing', { keyName: 'nope' }],
    ['no-key-public-half', {}],
    ['project-public-key-empty', { ota: { ...OTA, publicKey: '' } }],
    ['mismatch', { ota: { ...OTA, publicKey: 'pub-B' } }],
  ];

  for (const [refusal, over] of cases) {
    it(refusal, () => {
      if (refusal === 'no-key-public-half') {
        fs.writeFileSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'), JSON.stringify({ privateKey: 'x' }));
      }
      expect(refusalOf(over)).toBe(refusal);
    });
  }

  it('key-unparseable', () => {
    fs.writeFileSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'), '{ nope');
    expect(refusalOf()).toBe('key-unparseable');
  });

  it('the cases above cover the whole exported list — a new refusal needs a case here', () => {
    expect([...new Set([...cases.map(([r]) => r), 'key-unparseable'])].sort()).toEqual([...OTA_PUBLISH_REFUSALS].sort());
  });

  it('refuses an unknown NAME before it reads the key — a bad request never touches the key file', () => {
    fs.rmSync(path.join(repoRoot, 'build', 'ota-keys', 'default.json'));
    expect(refusalOf({ name: 'not-listed' })).toBe('unknown-bundle');
  });
});

/** Wiring. Source, comments stripped: the route is a closure inside a Vite plugin and the CLI a
 *  top-level script, so there is nothing to call. Proves each entry point reaches the ONE check and
 *  answers every refusal; it cannot prove the wording is apt. */
describe('both OTA entry points run the ONE preflight (#827)', () => {
  const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(engineRoot, rel), 'utf8');
    const code = stripComments(raw);
    assertScanIsSane(raw, code, rel, ['otaPublishPreflight']);
    return code;
  };
  const cli = read('scripts/ota-publish.mjs');
  const route = read('plugins/vite-asset-scanner.ts');

  it('ota-publish.mjs reads the same raw block, calls it, and no longer composes its steps itself', () => {
    expect(cli).toMatch(/const rawConfig = readRawOtaBlock\(projectDir\);/);
    expect(cli).toMatch(/otaPublishPreflight\(\{ ota, name, version, keyName: args\.key, bucket, repoRoot \}\)/);
    expect(cli).not.toMatch(/otaSigningKeyRefusal\(|otaPublishTarget\(|OTA_SAFE_TOKEN\.test\(|OTA_SAFE_BUCKET\.test\(/);
  });

  it('/api/ota/publish calls it on the RAW ota block, and no longer composes its steps itself', () => {
    // Raw, not `cfg.ota`: merging coerces, so the merged block let a malformed `ota.subgames` past the
    // route's early 400 into a build the script then refused (see readRawOtaBlock's docblock).
    expect(route).toMatch(/const rawConfig = readRawOtaBlock\(projectRoot\);/);
    expect(route).toMatch(/otaPublishPreflight\(\{ ota: rawConfig\.ok \? rawConfig\.ota : undefined, name: bundleName,/);
    expect(route).not.toMatch(/otaPublishPreflight\(\{ ota: cfg\.ota/);
    expect(route).not.toMatch(/otaSigningKeyRefusal\(|otaPublishTarget\(/);
  });

  it('#906: /api/ota/publish refuses an unclean tree BEFORE it takes the build slot, asking the build stamp\'s own question', () => {
    expectInOrder(route, [
      'const tree = readGitProvenance(subgameDir ?? projectRoot);',
      'if (tree.commit === null || tree.dirty !== false) {',
      "acquireBuildSlot('OTA publish', projectRoot)",
    ], '/api/ota/publish');
  });

  it('each side words EVERY refusal — none answers with undefined', () => {
    for (const refusal of OTA_PUBLISH_REFUSALS) {
      const key = new RegExp(`(?:'${refusal}'|\\b${refusal})\\s*:`);
      expect(cli, `ota-publish.mjs has no message for '${refusal}'`).toMatch(key);
      expect(route, `/api/ota/publish has no message for '${refusal}'`).toMatch(key);
    }
  });
});
