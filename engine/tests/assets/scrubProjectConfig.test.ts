/**
 * Guards the ONE definition of what must not survive into a published `project.config.json`
 * (`scripts/lib/scrub-project-config.mjs`), and — the part that actually earns its keep — that
 * both publishers still USE it.
 *
 * The history is the reason for the second half. The scrub was an inline `node -e` block in
 * `publish-demo.sh` AND another in `publish-engine-oss.sh`, the latter commented "mirrors
 * publish-demo.sh". #141 added `build.debugBuild` to the demo publisher only, so the ENGINE
 * publisher kept shipping the eval-capable bridge flag into a repo that is world-readable,
 * permanent, and doubles as the free CI runner. Nothing failed; the fix simply did not reach the
 * second copy. A test over the shared module alone would have stayed green through all of that,
 * which is why the last test here reads the shell scripts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCRUBBED_BUILD_FIELDS,
  scrubProjectConfig,
  verifyProjectConfigScrubbed,
} from '../../../scripts/lib/scrub-project-config.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** A config carrying every private value a real internal demo carries. */
function writeDirtyConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-scrub-'));
  const file = path.join(dir, 'project.config.json');
  fs.writeFileSync(file, JSON.stringify({
    appId: 'com.modokiengine.example',
    build: {
      // Deliberately a FAKE id: `publish-engine-oss.sh` greps the staged snapshot for every real
      // Team ID it finds in games/*/ + demos/*/project.config.json and aborts the publish on a hit.
      // A real one here is a private value leaking into a public repo — the scrub's own subject.
      appleTeamId: 'ABCDE12345',
      webBucket: 'gs://modoki-www-site/example',
      webCdnUrlMap: 'static-lb',
      webCdnBackendBucket: 'static-backend',
      webDeployCommand: 'some-internal-command',
      webDeployMode: 'gcs',
      webBasePath: '/example/',
      debugBuild: true,
      modules: { render3d: 'auto' },
    },
  }, null, 2));
  return file;
}

describe('published project.config.json scrub', () => {
  it('removes every private value, and says which ones it changed', () => {
    const file = writeDirtyConfig();
    const changed = scrubProjectConfig(file);
    const b = JSON.parse(fs.readFileSync(file, 'utf8')).build;

    expect(b.appleTeamId).toBe('');
    expect(b.webBucket).toBe('');
    expect(b.webDeployMode).toBe('none');
    // The one #141 was about: a published artifact must not ask for the debug bridge, which
    // carries handleEval (arbitrary JS) and, post-#112, the native TCP server.
    expect(b.debugBuild).toBe(false);
    expect(changed).toEqual(expect.arrayContaining(['appleTeamId', 'webBucket', 'debugBuild']));
  });

  it('leaves unrelated build settings alone — this is a scrub, not a reset', () => {
    const file = writeDirtyConfig();
    scrubProjectConfig(file);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.build.modules).toEqual({ render3d: 'auto' });
    expect(j.appId).toBe('com.modokiengine.example');
  });

  it('verifies clean after its own scrub, and flags every field before it', () => {
    const file = writeDirtyConfig();
    expect(verifyProjectConfigScrubbed(file).length).toBe(Object.keys(SCRUBBED_BUILD_FIELDS).length);
    scrubProjectConfig(file);
    expect(verifyProjectConfigScrubbed(file)).toEqual([]);
  });

  it('treats a MISSING field as a violation, not a pass', () => {
    // The published default is not the publisher's to assume, and an absent key is exactly what a
    // config-shape change would produce — the case where a silent pass is most expensive.
    const file = writeDirtyConfig();
    scrubProjectConfig(file);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete j.build.debugBuild;
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    expect(verifyProjectConfigScrubbed(file).join()).toMatch(/debugBuild is absent/);
  });

  it('reports an unreadable config rather than passing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-scrub-'));
    const file = path.join(dir, 'project.config.json');
    fs.writeFileSync(file, '{ not json');
    expect(verifyProjectConfigScrubbed(file).join()).toMatch(/unreadable/);
  });

  it('BOTH publishers call the shared module instead of carrying their own copy', () => {
    // This is the test the #141 miss needed. Two inline copies drifted silently; a publisher that
    // re-inlines one can drift again, and the failure mode is a permanent public commit.
    for (const script of ['scripts/publish-demo.sh', 'scripts/publish-engine-oss.sh']) {
      const src = fs.readFileSync(path.join(REPO, script), 'utf8');
      expect(src, `${script} must invoke scripts/lib/scrub-project-config.mjs`)
        .toContain('scripts/lib/scrub-project-config.mjs');
      // An inline `b.appleTeamId = ""` is the shape of the copy that drifted — if one comes back,
      // this fails while the snapshot it produces still looks fine.
      expect(src, `${script} appears to inline a project.config scrub again — use the shared module`)
        .not.toMatch(/b\.appleTeamId\s*=/);
    }
  });
});
