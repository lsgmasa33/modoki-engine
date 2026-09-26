/** A game build's favicon is its own app icon; the editor's is the engine's Modoki icon (2026-09-26). */

import path from 'node:path';
import sharp from 'sharp';
import { describe, it, expect } from 'vitest';
import { faviconPlugin, faviconSourceFor, FAVICON_SIZE, versionedFaviconRef, linkVersionedFavicon } from '../../plugins/favicon';
import { loadProjectConfig } from '../../plugins/load-project-config';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(__dirname, '../../..');
const engineIcon = path.join(repoRoot, 'engine/packages/modoki/src/runtime/assets/favicon.png');
const court = path.join(repoRoot, 'games/court');
const courtIcon = loadProjectConfig(court).app.iconSource;
const template = readScannedSource(path.join(repoRoot, 'engine/index.html'), {
  comments: 'include', reason: 'the transform is handed the template verbatim, comments and all',
}).raw;

describe('faviconSourceFor', () => {
  it('a game build uses the project\'s app.iconSource', () => {
    expect(faviconSourceFor({ engineIcon, projectRoot: court, iconSource: courtIcon, isEditorBuild: false }))
      .toEqual({ path: path.join(court, courtIcon), isGameIcon: true });
  });

  it('the editor keeps the engine icon, whatever project is open', () => {
    expect(faviconSourceFor({ engineIcon, projectRoot: court, iconSource: courtIcon, isEditorBuild: true }))
      .toEqual({ path: engineIcon, isGameIcon: false });
  });

  it('falls back to the engine icon when the project authors none', () => {
    expect(faviconSourceFor({ engineIcon, projectRoot: court, iconSource: '', isEditorBuild: false }))
      .toEqual({ path: engineIcon, isGameIcon: false });
  });

  it('a set-but-missing iconSource falls back AND is reported, not silent', () => {
    expect(faviconSourceFor({ engineIcon, projectRoot: court, iconSource: 'art/nope.png', isEditorBuild: false }))
      .toEqual({ path: engineIcon, isGameIcon: false, missing: path.join(court, 'art/nope.png') });
  });
});

describe('faviconPlugin', () => {
  const run = async (o: Partial<Parameters<typeof faviconPlugin>[0]>) => {
    const plugin = faviconPlugin({ engineIcon, projectRoot: court, iconSource: courtIcon, isEditorBuild: false, ...o });
    const emitted: { fileName: string; source: Buffer }[] = [];
    const warnings: string[] = [];
    const ctx = { warn: (m: string) => { warnings.push(m); }, emitFile: (f: { fileName: string; source: Buffer }) => { emitted.push(f); return ''; } };
    (plugin.configResolved as (c: { command: string }) => void)({ command: 'build' });
    await (plugin.buildStart as (this: unknown) => Promise<void>).call(ctx);
    (plugin.generateBundle as (this: unknown) => void).call(ctx);
    const html = (plugin.transformIndexHtml as (h: string) => string)(template);
    return { emitted, warnings, html };
  };

  it('emits the game icon downscaled to FAVICON_SIZE, linked with a content-hash query', async () => {
    const { emitted, warnings, html } = await run({});
    expect(warnings).toEqual([]);
    expect(emitted.map((e) => e.fileName)).toEqual(['favicon.png']);
    const hashed = versionedFaviconRef(emitted[0].source);
    expect(hashed).toMatch(/^favicon\.png\?v=[0-9a-f]{16}$/);
    const meta = await sharp(emitted[0].source).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', FAVICON_SIZE, FAVICON_SIZE]);
    // A fixed name went stale behind the CDN for a day (2026-09-26); the link must carry the hash.
    expect(html).toContain(`href="%BASE_URL%${hashed}"`);
    expect(html).not.toContain('favicon.png"');
  });

  it('rewrites only the icon link\'s favicon.png, and leaves a page without one alone', () => {
    // The decoy is another <link> with the same href — an <img src> could never catch an over-broad match.
    const page = '<link rel="icon" href="/x/favicon.png" /><link rel="apple-touch-icon" href="/x/favicon.png" />';
    expect(linkVersionedFavicon(page, 'favicon.png?v=abc'))
      .toBe('<link rel="icon" href="/x/favicon.png?v=abc" /><link rel="apple-touch-icon" href="/x/favicon.png" />');
    expect(linkVersionedFavicon('<head></head>', 'favicon.png?v=abc')).toBe('<head></head>');
  });

  it('a different icon is a different URL', () => {
    expect(versionedFaviconRef(Buffer.from('a'))).not.toBe(versionedFaviconRef(Buffer.from('b')));
  });

  it('the dev server (the editor) emits and rewrites nothing', async () => {
    const plugin = faviconPlugin({ engineIcon, projectRoot: court, iconSource: courtIcon, isEditorBuild: true });
    (plugin.configResolved as (c: { command: string }) => void)({ command: 'serve' });
    await (plugin.buildStart as (this: unknown) => Promise<void>).call({ warn: () => {} });
    expect((plugin.transformIndexHtml as (h: string) => string)(template)).toBe(template);
  });

  it('warns when the authored icon is missing, and still emits the engine icon', async () => {
    const { emitted, warnings } = await run({ iconSource: 'art/nope.png' });
    expect(warnings.join('\n')).toMatch(/art\/nope\.png does not exist/);
    expect(emitted.map((e) => e.fileName)).toEqual(['favicon.png']);
  });

  it('a playable emits no favicon — it would be inlined under the byte cap and never shown', async () => {
    const { emitted, html } = await run({ isPlayable: true });
    expect(emitted).toEqual([]);
    expect(html).toBe(template);
  });
});

// The functions above are only half of it: deleting the plugin CALL from vite.config.ts would leave
// every test here green and every game back on "Modoki" + the engine bear.
describe('vite.config wires the game-identity plugins', () => {
  const cfg = readScannedSource(path.join(repoRoot, 'engine/vite.config.ts')).code;
  it.each(['documentTitlePlugin(', 'faviconPlugin('])('calls %s', (call) => {
    expect(cfg).toContain(call);
  });
});
