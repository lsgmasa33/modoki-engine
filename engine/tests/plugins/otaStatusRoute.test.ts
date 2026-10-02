/** `GET /api/ota/status` through the real router (#1985). `otaGcloud.test.ts` covers the `isGcsObjectMissing` predicate
 *  alone, so the route's own decisions stayed green when deleted: "could not look" vs "nothing is there", the corrupt
 *  release.json 502, the bucket refusal. Here the route runs end to end against a FAKE `gcloud` at the process boundary:
 *  the project's `sdk.gcloudPath` (project.user.json) names a scratch dir whose `gcloud` (`gcloud.cmd` on Windows) is a
 *  node script that records its argv and answers with the stdout, stderr and exit code the case plants. Its stderr is
 *  tagged `[FAKE gcloud …]`, because the route's gcloud call lets it reach the test log, where a planted "Reauthentication
 *  failed" otherwise reads as this machine's real gcloud failing. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const BUCKET = 'gs://t1985-ota-bucket/game';
let scratch: string;
let projectRoot: string;
let gcloudDir: string;

const FAKE = `const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));
const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'answer.json'), 'utf8'));
process.stdout.write(a.stdout); process.stderr.write(a.stderr ? '[FAKE gcloud, otaStatusRoute.test.ts] ' + a.stderr : ''); process.exit(a.code);
`;

/** What the fake gcloud answers on its next call. */
const answer = (a: { stdout?: string; stderr?: string; code?: number }) =>
  fs.writeFileSync(path.join(gcloudDir, 'answer.json'), JSON.stringify({ stdout: '', stderr: '', code: 0, ...a }));
const argv = (): string[] | null => {
  const p = path.join(gcloudDir, 'argv.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const status = async (bucket?: string) => {
  const ctx = { projectRoot } as unknown as BackendContext;
  const r = await handleBackendRequest(ctx, { method: 'GET', urlPath: '/api/ota/status', query: new URLSearchParams(bucket ? { bucket } : {}), body: undefined });
  if (!r || r.kind !== 'json') throw new Error('no json reply');
  return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
};

beforeEach(() => {
  scratch = makeScratchDir('modoki-ota-status-');
  projectRoot = path.join(scratch, 'project');
  gcloudDir = path.join(scratch, 'gcloud-bin');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(gcloudDir);
  fs.writeFileSync(path.join(gcloudDir, 'fake.cjs'), FAKE);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(gcloudDir, 'gcloud.cmd'), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(gcloudDir, 'gcloud'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(gcloudDir, 'fake.cjs')}" "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(projectRoot, 'project.config.json'), JSON.stringify({ ota: { baseUrl: `https://storage.googleapis.com/${BUCKET.slice('gs://'.length)}/` } }));
  fs.writeFileSync(path.join(projectRoot, 'project.user.json'), JSON.stringify({ sdk: { gcloudPath: gcloudDir } }));
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

describe('GET /api/ota/status (#1985)', () => {
  it('reads <bucket>/release.json, the bucket derived from ota.baseUrl, and returns the release', async () => {
    answer({ stdout: JSON.stringify({ version: '1.2.3', bundle: 'b.zip' }) });
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, bucket: BUCKET, release: { version: '1.2.3', bundle: 'b.zip' } });
    expect(argv()).toEqual(['storage', 'cat', `${BUCKET}/release.json`]);
  });

  it('an absent object is the one failure that IS an answer: ok, release null', async () => {
    answer({ stderr: `ERROR: (gcloud.storage.cat) The following URLs matched no objects or files:\n${BUCKET}/release.json\n`, code: 1 });
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, bucket: BUCKET, release: null });
  });

  it('COULD NOT LOOK is never NOTHING IS THERE: an auth failure is 502 ok:false, carrying what gcloud said', async () => {
    answer({ stderr: 'ERROR: (gcloud.storage.cat) There was a problem refreshing your current auth tokens: Reauthentication failed.\n', code: 1 });
    const r = await status();
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.release).toBeUndefined();
    expect(String(r.body.error)).toMatch(/Reauthentication failed/);
  });

  it('a corrupt release.json is a BROKEN release, not an absent one: 502 with the raw head', async () => {
    answer({ stdout: '{"version": "1.2.' });
    const r = await status();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, bucket: BUCKET, raw: '{"version": "1.2.' });
    expect(String(r.body.error)).toMatch(/not valid JSON/);
  });

  it('an explicit ?bucket= wins over the derived one', async () => {
    answer({ stdout: '{}' });
    const r = await status('gs://other-bucket');
    expect(r.body).toMatchObject({ ok: true, bucket: 'gs://other-bucket' });
    expect(argv()).toEqual(['storage', 'cat', 'gs://other-bucket/release.json']);
  });

  it('a bucket that is not a safe gs:// URI is 400, and gcloud is never run', async () => {
    answer({ stdout: '{}' });
    const r = await status('gs://x;rm -rf ~');
    expect(r.status).toBe(400);
    expect(argv()).toBeNull();
  });

  it('with no ?bucket= and an ota.baseUrl that names none, 400 says to pass one; gcloud is never run', async () => {
    fs.writeFileSync(path.join(projectRoot, 'project.config.json'), JSON.stringify({ ota: { baseUrl: 'https://cdn.example.com/ota/' } }));
    answer({ stdout: '{}' });
    const r = await status();
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Pass \?bucket=gs:\/\/\.\.\. explicitly/);
    expect(argv()).toBeNull();
  });
});
