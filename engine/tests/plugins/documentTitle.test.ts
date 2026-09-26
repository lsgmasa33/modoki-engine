/** A game build's tab title is its `app.appName` (#1583) — the published Court and Weaveling pages
 *  both read "Modoki" because nothing rewrote the shared template's `<title>`. */

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { applyDocumentTitle } from '../../plugins/documentTitle';
import { loadProjectConfig } from '../../plugins/load-project-config';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(__dirname, '../../..');
const template = readScannedSource(path.join(repoRoot, 'engine/index.html'), {
  comments: 'include',
  reason: 'the transform is handed the template verbatim, comments and all',
}).raw;
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];

describe('applyDocumentTitle', () => {
  it('sets the REAL template\'s title to the game name', () => {
    expect(titleOf(template)).toBe('Modoki');
    expect(titleOf(applyDocumentTitle(template, 'Court'))).toBe('Court');
  });

  it.each(['court', 'wordweave'])('%s: the title is the appName its project.config.json authors', (id) => {
    const appName = loadProjectConfig(path.join(repoRoot, 'games', id)).app.appName;
    expect(appName).toBeTruthy();
    expect(titleOf(applyDocumentTitle(template, appName))).toBe(appName);
  });

  it('escapes the name — it is authored text, not markup', () => {
    expect(titleOf(applyDocumentTitle(template, 'A <b> & C'))).toBe('A &lt;b&gt; &amp; C');
  });

  it('leaves the HTML untouched when the project authors no appName', () => {
    expect(applyDocumentTitle(template, undefined)).toBe(template);
    expect(applyDocumentTitle(template, '   ')).toBe(template);
  });

  it('throws rather than silently doing nothing when the template has no <title>', () => {
    expect(() => applyDocumentTitle('<html><head></head></html>', 'Court')).toThrow(/no <title>/);
  });
});
